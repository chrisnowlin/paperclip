import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, environments, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { codingPodRoutes } from "../routes/coding-pods.js";
import { codingPodService } from "../services/coding-pods.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("coding pod issue attachment", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let repo: string;
  let app: express.Express;
  let actor: Record<string, unknown>;
  let serial = 0;
  let sandboxEnvironmentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pod-attachment-");
    db = createDb(database.connectionString);
    sandboxEnvironmentId = (await db.insert(environments).values({ name: "Review sandbox", driver: "sandbox", status: "active", config: { provider: "test" } }).returning())[0]!.id;
    repo = mkdtempSync(join(tmpdir(), "paperclip-pod-attachment-repo-"));
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

  async function fixture(issuePatch: Record<string, unknown> = {}) {
    serial += 1;
    const [company] = await db.insert(companies).values({ name: `Attach Co ${serial}`, issuePrefix: `PA${serial}` }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: `Attach Project ${serial}` }).returning();
    await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id, name: "primary", sourceType: "git_repo", cwd: repo, isPrimary: true });
    const [owner] = await db.insert(agents).values({ companyId: company.id, name: "Owner", status: "idle", adapterType: "codex_local" }).returning();
    const [reviewer] = await db.insert(agents).values({ companyId: company.id, name: "Reviewer", status: "idle", adapterType: "opencode_local", defaultEnvironmentId: sandboxEnvironmentId }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Implement feature", status: "backlog", ...issuePatch }).returning();
    await codingPodService(db).upsert(company.id, project.id, { ownerAgentId: owner.id, reviewerAgentId: reviewer.id, enabled: true });
    return { company, project, owner, reviewer, issue };
  }

  function path(companyId: string, issueId: string) {
    return `/api/companies/${companyId}/issues/${issueId}/coding-pod`;
  }

  it("pins owner, reviewer, and board approval stages without waking an agent", async () => {
    const { company, owner, reviewer, issue } = await fixture();
    const response = await request(app).post(path(company.id, issue.id)).send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ issueId: issue.id, ownerAgentId: owner.id, reviewerAgentId: reviewer.id, boardUserId: "local-board" });
    const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stored.status).toBe("backlog");
    expect(stored.assigneeAgentId).toBe(owner.id);
    expect(stored.assigneeUserId).toBeNull();
    expect(stored.executionPolicy).toMatchObject({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: reviewer.id }] },
        { type: "approval", participants: [{ type: "user", userId: "local-board" }] },
      ],
    });
    expect(stored.executionPolicy).not.toHaveProperty("reviewPreset");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id))).toHaveLength(0);
  });

  it("reuses the issue binding and keeps its pinned participants after project config changes", async () => {
    const { company, project, owner, reviewer, issue } = await fixture();
    const url = path(company.id, issue.id);
    const first = await request(app).post(url).send({});
    expect(first.status).toBe(200);
    const [otherReviewer] = await db.insert(agents).values({ companyId: company.id, name: "Other Reviewer", status: "idle", adapterType: "codex_local", defaultEnvironmentId: sandboxEnvironmentId }).returning();
    await codingPodService(db).upsert(company.id, project.id, { ownerAgentId: owner.id, reviewerAgentId: otherReviewer.id, enabled: true });
    const repeated = await request(app).post(url).send({});
    expect(repeated.status).toBe(200);
    expect(repeated.body.id).toBe(first.body.id);
    expect(repeated.body.reviewerAgentId).toBe(reviewer.id);
    const view = await request(app).get(url);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ binding: { id: first.body.id, reviewerAgentId: reviewer.id }, candidate: null, phase: "owner_working" });
  });

  it("rejects a non-backlog issue and an existing execution policy", async () => {
    const active = await fixture({ status: "in_progress" });
    expect((await request(app).post(path(active.company.id, active.issue.id)).send({})).status).toBe(409);
    const governed = await fixture({ executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: "11111111-1111-4111-8111-111111111111", type: "approval", approvalsNeeded: 1, participants: [{ id: "22222222-2222-4222-8222-222222222222", type: "user", userId: "local-board" }] }] } });
    expect((await request(app).post(path(governed.company.id, governed.issue.id)).send({})).status).toBe(409);
  });

  it("rejects an issue from another project and an agent caller", async () => {
    const { company, owner, issue } = await fixture();
    const [otherProject] = await db.insert(projects).values({ companyId: company.id, name: "Other" }).returning();
    await db.update(issues).set({ projectId: otherProject.id }).where(and(eq(issues.id, issue.id), eq(issues.companyId, company.id)));
    expect((await request(app).post(path(company.id, issue.id)).send({})).status).toBe(409);
    actor = { type: "agent", agentId: owner.id, companyId: company.id, source: "agent_key" };
    expect((await request(app).post(path(company.id, issue.id)).send({})).status).toBe(403);
    actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  });
});
