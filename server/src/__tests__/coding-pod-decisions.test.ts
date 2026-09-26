import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, codingPodCandidates, codingPodIssueBindings, codingPods, companies,
  createDb, executionWorkspaces, heartbeatRuns, issueComments, issues, projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertCodingPodCandidateFreshForDecision, readCodingPodCandidateDiff } from "../services/coding-pod-candidates.js";
import { getCodingPodIssueView } from "../services/coding-pods.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("coding pod candidate decisions", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const repos: string[] = [];
  let serial = 0;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pod-decisions-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    // Terminal issue cleanup runs after the HTTP response. Keep the disposable
    // database alive until that existing cleanup path settles.
    await new Promise((resolve) => setTimeout(resolve, 750));
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
    await database?.cleanup();
  });

  function git(repo: string, ...args: string[]) {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  }

  async function fixture(withCandidate = true) {
    serial += 1;
    const repo = mkdtempSync(join(tmpdir(), "paperclip-pod-decision-git-"));
    repos.push(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "file.txt"), "reviewed\n");
    git(repo, "commit", "-qam", "reviewed");
    const headSha = git(repo, "rev-parse", "HEAD");
    const [company] = await db.insert(companies).values({ name: `Decision Co ${serial}`, issuePrefix: `DC${serial}` }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Code" }).returning();
    const [owner, reviewer] = await db.insert(agents).values([
      { companyId: company.id, name: "Owner", adapterType: "codex_local" },
      { companyId: company.id, name: "Reviewer", adapterType: "opencode_local" },
    ]).returning();
    const reviewStageId = "11111111-1111-4111-8111-111111111111";
    const approvalStageId = "22222222-2222-4222-8222-222222222222";
    const policy = normalizeIssueExecutionPolicy({ stages: [
      { id: reviewStageId, type: "review", participants: [{ type: "agent", agentId: reviewer.id }] },
      { id: approvalStageId, type: "approval", participants: [{ type: "user", userId: "local-board" }] },
    ] })!;
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Review", status: "in_review",
      assigneeUserId: "local-board", responsibleUserId: "local-board", createdByUserId: "local-board",
      executionPolicy: { ...policy }, executionState: { status: "pending", currentStageId: approvalStageId,
        currentStageIndex: 1, currentStageType: "approval", currentParticipant: { type: "user", userId: "local-board" },
        returnAssignee: { type: "agent", agentId: owner.id }, reviewRequest: null, completedStageIds: [reviewStageId],
        lastDecisionId: null, lastDecisionOutcome: "approved", monitor: null } }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: company.id, projectId: project.id, sourceIssueId: issue.id,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "owner", status: "active", cwd: repo, baseRef: baseSha,
    }).returning();
    const [pod] = await db.insert(codingPods).values({ companyId: company.id, projectId: project.id, ownerAgentId: owner.id, reviewerAgentId: reviewer.id }).returning();
    await db.insert(codingPodIssueBindings).values({ companyId: company.id, projectId: project.id, issueId: issue.id, podId: pod.id,
      ownerAgentId: owner.id, reviewerAgentId: reviewer.id, boardUserId: "local-board", reviewStageId, approvalStageId });
    if (withCandidate) await db.insert(codingPodCandidates).values({ companyId: company.id, projectId: project.id, issueId: issue.id,
      ownerAgentId: owner.id, reviewerAgentId: reviewer.id, workspaceId: workspace.id,
      baseSha, headSha, reviewStageId, entryStatusVersion: 1 });
    return { company, issue, repo, reviewStageId, approvalStageId, baseSha, headSha };
  }

  it("allows the exact clean candidate and rejects dirty or moved Git state", async () => {
    const f = await fixture();
    const input = { companyId: f.company.id, issueId: f.issue.id, stageId: f.reviewStageId };
    await expect(assertCodingPodCandidateFreshForDecision(db, input)).resolves.toBeUndefined();
    writeFileSync(join(f.repo, "untracked.txt"), "dirty\n");
    await expect(assertCodingPodCandidateFreshForDecision(db, input)).rejects.toMatchObject({ status: 409 });
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-qm", "moved");
    await expect(assertCodingPodCandidateFreshForDecision(db, { ...input, stageId: f.approvalStageId })).rejects.toMatchObject({ status: 409 });
  });

  it("reports a running reviewer and a stale candidate in the issue read model", async () => {
    const f = await fixture();
    expect((await getCodingPodIssueView(db, f.company.id, f.issue.id)).phase).toBe("awaiting_board");
    const [binding] = await db.select().from(codingPodIssueBindings).where(eq(codingPodIssueBindings.issueId, f.issue.id));
    await db.update(issues).set({
      assigneeAgentId: binding.reviewerAgentId,
      executionState: { ...(f.issue.executionState as Record<string, unknown>), currentStageId: f.reviewStageId,
        currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: binding.reviewerAgentId } } as typeof f.issue.executionState,
    }).where(eq(issues.id, f.issue.id));
    expect((await getCodingPodIssueView(db, f.company.id, f.issue.id)).phase).toBe("review_pending");
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: binding.reviewerAgentId, status: "running",
      contextSnapshot: { issueId: f.issue.id } });
    expect((await getCodingPodIssueView(db, f.company.id, f.issue.id)).phase).toBe("review_running");
    writeFileSync(join(f.repo, "late.txt"), "changed after review\n");
    expect((await getCodingPodIssueView(db, f.company.id, f.issue.id)).phase).toBe("candidate_stale");
  });

  it("serves the pinned candidate comparison from local Git", async () => {
    const f = await fixture();
    const [candidate] = await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, f.issue.id));
    const diff = await readCodingPodCandidateDiff(db, { companyId: f.company.id, issueId: f.issue.id, candidateId: candidate.id });
    expect(diff).toContain("-base");
    expect(diff).toContain("+reviewed");
    expect(diff).not.toContain("late change");
    await expect(readCodingPodCandidateDiff(db, { companyId: f.company.id, issueId: f.issue.id, candidateId: "00000000-0000-4000-8000-000000000000" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("refuses an approval stage without any candidate", async () => {
    const f = await fixture(false);
    await expect(assertCodingPodCandidateFreshForDecision(db, { companyId: f.company.id, issueId: f.issue.id, stageId: f.approvalStageId }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("keeps a stale board approval in review through the ordinary issue route", async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "late.txt"), "changed after review\n");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    const response = await request(app).patch(`/api/issues/${f.issue.id}`).send({ status: "done", comment: "Approved candidate" });
    expect(response.status).toBe(409);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(issue.status).toBe("in_review");
  });

  it("does not persist an auto-approval comment for a stale candidate", async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "late.txt"), "changed after review\n");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    const response = await request(app).post(`/api/issues/${f.issue.id}/comments`).send({ body: "## Review: APPROVED\nLooks good." });
    expect(response.status).toBe(409);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(0);
  });

  it("allows the board participant to approve the unchanged reviewed candidate", async () => {
    const f = await fixture();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    const response = await request(app).patch(`/api/issues/${f.issue.id}`).send({ status: "done", comment: "Approved candidate" });
    expect(response.status).toBe(200);
    const [stored] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(stored.status).toBe("done");
  });
});
