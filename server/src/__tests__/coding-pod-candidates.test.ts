import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, codingPodCandidates, codingPodIssueBindings, codingPods, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { insertCodingPodCandidate, readCodingPodCandidateSnapshot } from "../services/coding-pod-candidates.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

// Keep real routes, database, and Git reads. Replace only the asynchronous
// provider wake at the edge so this fixture cannot launch a coding agent.
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async () => null,
    }),
  };
});

describeDb("coding pod Git candidates", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const repos: string[] = [];
  let serial = 0;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pod-candidates-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    // Issue routes schedule the normal reviewer wake after responding; let that
    // async database write finish before the disposable Postgres server stops.
    await new Promise((resolve) => setTimeout(resolve, 750));
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
    await database?.cleanup();
  });

  function git(repo: string, ...args: string[]) {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  }

  async function fixture(baseRef?: string) {
    serial += 1;
    const repo = mkdtempSync(join(tmpdir(), "paperclip-candidate-repo-"));
    repos.push(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "file.txt"), "candidate\n");
    git(repo, "commit", "-qam", "candidate");
    const headSha = git(repo, "rev-parse", "HEAD");

    const [company] = await db.insert(companies).values({ name: `Candidate Co ${serial}`, issuePrefix: `CA${serial}` }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: `Candidate Project ${serial}` }).returning();
    const [owner, reviewer] = await db.insert(agents).values([
      { companyId: company.id, name: "Owner", adapterType: "codex_local" },
      { companyId: company.id, name: "Reviewer", adapterType: "opencode_local" },
    ]).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Candidate task", status: "in_progress" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: company.id,
      projectId: project.id,
      sourceIssueId: issue.id,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: `candidate-${serial}`,
      cwd: repo,
      baseRef: baseRef ?? baseSha,
    }).returning();
    return { company, project, issue, workspace, owner, reviewer, repo, baseSha, headSha };
  }

  async function boundIssueApp(input: Awaited<ReturnType<typeof fixture>>) {
    const { company, project, issue, workspace, owner, reviewer } = input;
    const [pod] = await db.insert(codingPods).values({ companyId: company.id, projectId: project.id, ownerAgentId: owner.id, reviewerAgentId: reviewer.id }).returning();
    const policy = normalizeIssueExecutionPolicy({ stages: [
      { type: "review", participants: [{ type: "agent", agentId: reviewer.id }] },
      { type: "approval", participants: [{ type: "user", userId: "local-board" }] },
    ] })!;
    await db.update(issues).set({ assigneeAgentId: owner.id, responsibleUserId: "local-board", createdByUserId: "local-board", executionPolicy: { ...policy }, executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
    await db.insert(codingPodIssueBindings).values({
      companyId: company.id, projectId: project.id, issueId: issue.id, podId: pod.id,
      ownerAgentId: owner.id, reviewerAgentId: reviewer.id, boardUserId: "local-board",
      reviewStageId: policy.stages[0]!.id, approvalStageId: policy.stages[1]!.id,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return { app, reviewStageId: policy.stages[0]!.id };
  }

  it("captures the exact clean base and head commit from an issue workspace", async () => {
    const { company, issue, workspace, baseSha, headSha } = await fixture();
    expect(await readCodingPodCandidateSnapshot(db, { companyId: company.id, issueId: issue.id, workspaceId: workspace.id }))
      .toEqual({ workspaceId: workspace.id, baseSha, headSha });
  });

  it("rejects untracked work before review", async () => {
    const { company, issue, workspace, repo } = await fixture();
    writeFileSync(join(repo, "untracked.txt"), "uncommitted\n");
    await expect(readCodingPodCandidateSnapshot(db, { companyId: company.id, issueId: issue.id, workspaceId: workspace.id }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("rejects an unresolved base ref and a foreign company workspace", async () => {
    const { company, issue, workspace } = await fixture("missing-ref");
    await expect(readCodingPodCandidateSnapshot(db, { companyId: company.id, issueId: issue.id, workspaceId: workspace.id }))
      .rejects.toMatchObject({ status: 422 });
    const [other] = await db.insert(companies).values({ name: `Foreign Co ${serial}`, issuePrefix: `CX${serial}` }).returning();
    await expect(readCodingPodCandidateSnapshot(db, { companyId: other.id, issueId: issue.id, workspaceId: workspace.id }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("reuses an identical candidate for one status version and rejects a conflicting replay", async () => {
    const { company, project, issue, workspace, owner, reviewer, baseSha, headSha } = await fixture();
    const binding = { companyId: company.id, projectId: project.id, issueId: issue.id, ownerAgentId: owner.id, reviewerAgentId: reviewer.id };
    const snapshot = { workspaceId: workspace.id, baseSha, headSha };
    const reviewStageId = "11111111-1111-4111-8111-111111111111";
    const first = await insertCodingPodCandidate(db, { binding, snapshot, reviewStageId, entryStatusVersion: 1 });
    expect(first?.id).toBeTruthy();
    const repeated = await insertCodingPodCandidate(db, { binding, snapshot, reviewStageId, entryStatusVersion: 1 });
    expect(repeated?.id).toBe(first?.id);
    await expect(insertCodingPodCandidate(db, { binding, snapshot: { ...snapshot, headSha: baseSha }, reviewStageId, entryStatusVersion: 1 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("stores the exact candidate in the same ordinary issue update that starts review", async () => {
    const input = await fixture();
    const { company, issue, baseSha, headSha } = input;
    const { app, reviewStageId } = await boundIssueApp(input);
    const response = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "in_review" });
    expect(response.status).toBe(200);
    const [updated] = await db.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, company.id)));
    expect(updated.status).toBe("in_review");
    const rows = await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, issue.id));
    expect(rows).toMatchObject([{ baseSha, headSha, reviewStageId }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toHaveLength(0);
  });

  it("keeps the owner and creates no candidate when the worktree is dirty", async () => {
    const input = await fixture();
    const { app } = await boundIssueApp(input);
    writeFileSync(join(input.repo, "untracked.txt"), "not reviewed\n");
    const response = await request(app).patch(`/api/issues/${input.issue.id}`).send({ status: "in_review" });
    expect(response.status).toBe(409);
    const [stored] = await db.select().from(issues).where(eq(issues.id, input.issue.id));
    expect(stored.status).toBe("in_progress");
    expect(stored.assigneeAgentId).toBe(input.owner.id);
    expect(await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, input.issue.id))).toHaveLength(0);
  });
});
