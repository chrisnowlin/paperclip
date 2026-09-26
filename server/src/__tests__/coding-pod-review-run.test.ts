import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, codingPodCandidates, codingPodIssueBindings, codingPods, companies,
  createDb, executionWorkspaces, heartbeatRuns, issues, projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { resolveAndRetainRunTrustPreset } from "../services/run-trust-preset.js";
import { resolveCodingPodReviewerWorkspacePlan, selectCodingPodReviewerWorkspace } from "../services/coding-pod-candidates.js";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("coding pod reviewer run boundary", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pod-review-run-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  it("retains low trust only for the active reviewer and keeps the owner standard", async () => {
    const [company] = await db.insert(companies).values({ name: "Review Co", issuePrefix: "RVW" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Code" }).returning();
    const [owner, reviewer] = await db.insert(agents).values([
      { companyId: company.id, name: "Owner", adapterType: "codex_local" },
      { companyId: company.id, name: "Reviewer", adapterType: "opencode_local" },
    ]).returning();
    const policy = normalizeIssueExecutionPolicy({ stages: [
      { type: "review", participants: [{ type: "agent", agentId: reviewer.id }] },
      { type: "approval", participants: [{ type: "user", userId: "local-board" }] },
    ] })!;
    const [issue] = await db.insert(issues).values({
      companyId: company.id, projectId: project.id, title: "Review me", status: "in_review",
      assigneeAgentId: reviewer.id, executionPolicy: { ...policy },
      executionState: { status: "pending", currentStageId: policy.stages[0]!.id, currentStageIndex: 0,
        currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer.id },
        returnAssignee: { type: "agent", agentId: owner.id }, reviewRequest: null,
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null },
    }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: company.id, projectId: project.id, sourceIssueId: issue.id,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "owner", cwd: "/tmp/pod-owner",
      baseRef: "a".repeat(40),
    }).returning();
    const [pod] = await db.insert(codingPods).values({ companyId: company.id, projectId: project.id, ownerAgentId: owner.id, reviewerAgentId: reviewer.id }).returning();
    await db.insert(codingPodIssueBindings).values({
      companyId: company.id, projectId: project.id, issueId: issue.id, podId: pod.id,
      ownerAgentId: owner.id, reviewerAgentId: reviewer.id, boardUserId: "local-board",
      reviewStageId: policy.stages[0]!.id, approvalStageId: policy.stages[1]!.id,
    });
    const [candidate] = await db.insert(codingPodCandidates).values({
      companyId: company.id, projectId: project.id, issueId: issue.id,
      ownerAgentId: owner.id, reviewerAgentId: reviewer.id, workspaceId: workspace.id,
      baseSha: "a".repeat(40), headSha: "b".repeat(40), reviewStageId: policy.stages[0]!.id,
      entryStatusVersion: 1,
    }).returning();
    const reviewerRunId = randomUUID();
    const ownerRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: reviewerRunId, companyId: company.id, agentId: reviewer.id, status: "running", contextSnapshot: { issueId: issue.id } },
      { id: ownerRunId, companyId: company.id, agentId: owner.id, status: "running", contextSnapshot: { issueId: issue.id } },
    ]);
    const scope = { companyId: company.id, issueId: issue.id, project: null,
      issue: { companyId: company.id, executionPolicy: issue.executionPolicy } };
    const reviewerResult = await resolveAndRetainRunTrustPreset(db, {
      ...scope, agentId: reviewer.id, runId: reviewerRunId,
      agent: { companyId: company.id, permissions: {} },
    });
    expect(reviewerResult.trustPreset).toMatchObject({
      kind: "low_trust_review",
      boundary: { companyId: company.id, projectIds: [project.id], issueIds: [issue.id], allowedAgentIds: [reviewer.id] },
    });
    const [storedReviewer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, reviewerRunId));
    expect(storedReviewer.contextSnapshot?.executionPolicy).toMatchObject({ trustPreset: "low_trust_review" });
    const plan = await resolveCodingPodReviewerWorkspacePlan(db, { companyId: company.id, issueId: issue.id, reviewerAgentId: reviewer.id });
    expect(plan).toEqual({ candidateId: candidate.id, ownerWorkspaceId: workspace.id, reviewWorkspaceId: null, baseRef: "b".repeat(40) });
    expect(selectCodingPodReviewerWorkspace(plan, {
      persistedNativeWorkspaceId: null,
      issueWorkspaceId: workspace.id,
      issuePreference: "reuse_existing",
      config: { workspaceStrategy: { type: "git_worktree", baseRef: "main" } },
    })).toEqual({
      requestedWorkspaceId: null,
      issuePreference: null,
      config: { workspaceStrategy: { type: "git_worktree", baseRef: "b".repeat(40), branchTemplate: `coding-pod-review/{{issue.identifier}}-${candidate.id.slice(0, 8)}` } },
    });

    const ownerResult = await resolveAndRetainRunTrustPreset(db, {
      ...scope, agentId: owner.id, runId: ownerRunId,
      agent: { companyId: company.id, permissions: {} },
    });
    expect(ownerResult.trustPreset.kind).toBe("standard");
    const [storedOwner] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, ownerRunId), eq(heartbeatRuns.companyId, company.id)));
    expect(storedOwner.contextSnapshot?.executionPolicy).toBeUndefined();
  });

  it("realizes a candidate-pinned review worktree separate from the owner checkout", async () => {
    const repo = mkdtempSync(join(tmpdir(), "paperclip-review-worktree-"));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    let reviewCwd: string | null = null;
    try {
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
      const selected = selectCodingPodReviewerWorkspace({
        candidateId: randomUUID(), ownerWorkspaceId: "owner-workspace", reviewWorkspaceId: null, baseRef: headSha,
      }, {
        persistedNativeWorkspaceId: null, issueWorkspaceId: "owner-workspace", issuePreference: "reuse_existing", config: {},
      });
      const realized = await realizeExecutionWorkspace({
        base: { baseCwd: repo, source: "project_primary", projectId: randomUUID(), workspaceId: null, repoUrl: null, repoRef: baseSha },
        config: selected.config,
        issue: { id: randomUUID(), identifier: "REVIEW-1", title: "Review candidate" },
        agent: { id: randomUUID(), name: "Reviewer", companyId: randomUUID() },
      });
      reviewCwd = realized.cwd;
      expect(realized.strategy).toBe("git_worktree");
      expect(realized.cwd).not.toBe(repo);
      expect(realized.repoRef).toBe(headSha);
      expect(git(realized.cwd, "rev-parse", "HEAD")).toBe(headSha);
      expect(git(repo, "rev-parse", "HEAD")).toBe(headSha);
    } finally {
      if (reviewCwd) git(repo, "worktree", "remove", "--force", reviewCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
