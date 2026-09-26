import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, environments, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { codingPodRoutes } from "../routes/coding-pods.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("coding pod project routes", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let repo: string;
  let serial = 0;
  let actor: Record<string, unknown>;
  let app: express.Express;
  let sandboxEnvironmentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-coding-pods-");
    db = createDb(database.connectionString);
    sandboxEnvironmentId = (await db.insert(environments).values({ name: "Review sandbox", driver: "sandbox", status: "active", config: { provider: "test" } }).returning())[0]!.id;
    repo = mkdtempSync(join(tmpdir(), "paperclip-coding-pod-repo-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "base"]);
    actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = actor; next(); });
    app.use("/api", codingPodRoutes(db));
    app.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    await database?.cleanup();
  });

  async function fixture(options: { git?: boolean; ownerStatus?: string; reviewerStatus?: string; reviewerCompany?: string; ownerAdapter?: string; reviewerAdapter?: string; reviewerSandbox?: boolean } = {}) {
    serial += 1;
    const [company] = await db.insert(companies).values({ name: `Pod Co ${serial}`, issuePrefix: `PD${serial}` }).returning();
    const otherCompany = options.reviewerCompany === "other"
      ? (await db.insert(companies).values({ name: `Other Co ${serial}`, issuePrefix: `PO${serial}` }).returning())[0]!
      : company;
    const [project] = await db.insert(projects).values({ companyId: company.id, name: `Pod Project ${serial}` }).returning();
    if (options.git !== false) {
      await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id, name: "primary", sourceType: "git_repo", cwd: repo, isPrimary: true });
    }
    const [owner] = await db.insert(agents).values({ companyId: company.id, name: "Owner", status: options.ownerStatus ?? "idle", adapterType: options.ownerAdapter ?? "codex_local" }).returning();
    const [reviewer] = await db.insert(agents).values({ companyId: otherCompany.id, name: "Reviewer", status: options.reviewerStatus ?? "idle", adapterType: options.reviewerAdapter ?? "opencode_local",
      defaultEnvironmentId: options.reviewerSandbox === false ? null : sandboxEnvironmentId }).returning();
    return { company, project, owner, reviewer };
  }

  function url(companyId: string, projectId: string) {
    return `/api/companies/${companyId}/projects/${projectId}/coding-pod`;
  }

  it("persists one project pod and never queues agent work on configuration", async () => {
    const { company, project, owner, reviewer } = await fixture();
    const path = url(company.id, project.id);
    const payload = { ownerAgentId: owner.id, reviewerAgentId: reviewer.id, enabled: true };
    const first = await request(app).put(path).send(payload);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ companyId: company.id, projectId: project.id, ...payload });
    const second = await request(app).put(path).send({ ...payload, enabled: false });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect((await request(app).get(path)).body.enabled).toBe(false);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("requires an explicitly selected sandbox environment for the reviewer", async () => {
    const { company, project, owner, reviewer } = await fixture({ reviewerSandbox: false });
    const response = await request(app).put(url(company.id, project.id)).send({
      ownerAgentId: owner.id, reviewerAgentId: reviewer.id, enabled: true,
    });
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("sandbox environment");
  });

  it("accepts direct LM Studio Splash as local owner and rejects it as reviewer", async () => {
    const valid = await fixture({ ownerAdapter: "lmstudio_splash_local" });
    const ownerResponse = await request(app).put(url(valid.company.id, valid.project.id)).send({
      ownerAgentId: valid.owner.id, reviewerAgentId: valid.reviewer.id, enabled: true,
    });
    expect(ownerResponse.status).toBe(200);
    const invalid = await fixture({ reviewerAdapter: "lmstudio_splash_local" });
    const reviewerResponse = await request(app).put(url(invalid.company.id, invalid.project.id)).send({
      ownerAgentId: invalid.owner.id, reviewerAgentId: invalid.reviewer.id, enabled: true,
    });
    expect(reviewerResponse.status).toBe(422);
    expect(reviewerResponse.body.error).toContain("local-only");
  });

  it("can disable an existing pod after its reviewer sandbox is removed", async () => {
    const { company, project, owner, reviewer } = await fixture();
    const path = url(company.id, project.id);
    const payload = { ownerAgentId: owner.id, reviewerAgentId: reviewer.id, enabled: true };
    expect((await request(app).put(path).send(payload)).status).toBe(200);
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, reviewer.id));
    const response = await request(app).put(path).send({ ...payload, enabled: false });
    expect(response.status).toBe(200);
    expect(response.body.enabled).toBe(false);
  });

  it("rejects foreign, identical, paused, and unavailable-adapter agents", async () => {
    const foreign = await fixture({ reviewerCompany: "other" });
    expect((await request(app).put(url(foreign.company.id, foreign.project.id)).send({ ownerAgentId: foreign.owner.id, reviewerAgentId: foreign.reviewer.id, enabled: true })).status).toBe(422);
    const same = await fixture();
    expect((await request(app).put(url(same.company.id, same.project.id)).send({ ownerAgentId: same.owner.id, reviewerAgentId: same.owner.id, enabled: true })).status).toBe(422);
    const paused = await fixture({ reviewerStatus: "paused" });
    expect((await request(app).put(url(paused.company.id, paused.project.id)).send({ ownerAgentId: paused.owner.id, reviewerAgentId: paused.reviewer.id, enabled: true })).status).toBe(422);
    const unavailable = await fixture({ reviewerAdapter: "process" });
    expect((await request(app).put(url(unavailable.company.id, unavailable.project.id)).send({ ownerAgentId: unavailable.owner.id, reviewerAgentId: unavailable.reviewer.id, enabled: true })).status).toBe(422);
  });

  it("rejects a project without a Git workspace and agent writes", async () => {
    const { company, project, owner, reviewer } = await fixture({ git: false });
    const path = url(company.id, project.id);
    const payload = { ownerAgentId: owner.id, reviewerAgentId: reviewer.id, enabled: true };
    expect((await request(app).put(path).send(payload)).status).toBe(422);
    actor = { type: "agent", agentId: owner.id, companyId: company.id, source: "agent_key" };
    expect((await request(app).put(path).send(payload)).status).toBe(403);
    actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  });
});
