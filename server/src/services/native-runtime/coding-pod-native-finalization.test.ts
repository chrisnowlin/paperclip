import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, codingPodCandidates, codingPodIssueBindings, codingPods,
  companies, completionContracts, createDb, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, projects, workAssessments,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";
import { commitNativeStatusDecision, NativeStatusRaceError } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";
import { prepareCodingPodNativeReviewGate } from "./native-run-finalizer.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("coding pod native status commit", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let serial = 0;
  const repos: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pod-native-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
    await database?.cleanup();
  });

  async function fixture() {
    serial += 1;
    const [company] = await db.insert(companies).values({ name: `Native Pod ${serial}`, issuePrefix: `NP${serial}` }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
    const [owner, reviewer] = await db.insert(agents).values([
      { companyId: company.id, name: "Owner", status: "running", adapterType: "codex_local" },
      { companyId: company.id, name: "Reviewer", status: "paused", adapterType: "opencode_local" },
    ]).returning();
    const policy = normalizeIssueExecutionPolicy({ stages: [
      { type: "review", participants: [{ type: "agent", agentId: reviewer.id }] },
      { type: "approval", participants: [{ type: "user", userId: "local-board" }] },
    ] })!;
    const [issue] = await db.insert(issues).values({
      companyId: company.id, projectId: project.id, title: "Code change", status: "in_progress",
      assigneeAgentId: owner.id, responsibleUserId: "local-board", executionPolicy: { ...policy },
    }).returning();
    const repo = mkdtempSync(join(tmpdir(), "paperclip-native-pod-git-"));
    repos.push(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "file.txt"), "candidate\n");
    git("commit", "-qam", "candidate");
    const headSha = git("rev-parse", "HEAD");
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: company.id, projectId: project.id, sourceIssueId: issue.id,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "owner", status: "active",
      cwd: repo, baseRef: baseSha,
    }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
    const [pod] = await db.insert(codingPods).values({ companyId: company.id, projectId: project.id, ownerAgentId: owner.id, reviewerAgentId: reviewer.id }).returning();
    await db.insert(codingPodIssueBindings).values({
      companyId: company.id, projectId: project.id, issueId: issue.id, podId: pod.id,
      ownerAgentId: owner.id, reviewerAgentId: reviewer.id, boardUserId: "local-board",
      reviewStageId: policy.stages[0]!.id, approvalStageId: policy.stages[1]!.id,
    });

    const contractId = randomUUID();
    const runId = randomUUID();
    await db.insert(completionContracts).values({
      id: contractId, companyId: company.id, issueId: issue.id, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "pod-test-v1",
      risk: "low", completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "standalone-v1", objective: "Complete", criteria: [{ id: "objective", requirement: "Complete" }] },
      canonicalSha256: `contract-${contractId}`, createdByActorType: "system", createdByActorId: "test",
    });
    const sessionId = randomUUID();
    const runnerInstanceId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: company.id, agentId: owner.id, status: "running", runtimeMode: "native",
      nativeIssueId: issue.id, nativeSessionId: sessionId, runnerInstanceId,
      completionContractId: contractId, completionContractSha256: `contract-${contractId}`,
      contextSnapshot: { issueId: issue.id },
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issue.id));
    const resultId = randomUUID();
    await db.insert(nativeRunResults).values({
      id: resultId, companyId: company.id, issueId: issue.id, runId,
      completionContractId: contractId, serverFingerprint: `fp-${resultId}`,
      schemaStatus: "accepted", resultJson: {}, canonicalSha256: `result-${resultId}`,
    });
    const assessmentId = randomUUID();
    await db.insert(workAssessments).values({
      id: assessmentId, companyId: company.id, issueId: issue.id, runId,
      contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: company.id,
      priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "pod-test-v1",
      assessmentJson: {}, inputDigest: `assessment-${assessmentId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId, companyId: company.id, issueId: issue.id, phase: "arbitrating", attempt: 0, resultId,
    });
    const snapshot = { workspaceId: workspace.id, baseSha, headSha };
    const decision: NativeStatusDecision = {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review", toStatus: "in_review", reasonCode: "coding_pod_review_ready",
      unblockDescriptor: null,
      effects: [
        { kind: "activate_coding_pod_review", reviewStageId: policy.stages[0]!.id, candidateSnapshot: snapshot },
        { kind: "enqueue_pod_reviewer", agentId: reviewer.id },
      ],
    };
    return { company, issue, owner, reviewer, runId, assessmentId, decision, snapshot, repo,
      contractId, contractSha256: `contract-${contractId}`, sessionId, runnerInstanceId };
  }

  it("commits one candidate, reviewer stage, and wake; replay does not duplicate them", async () => {
    const f = await fixture();
    const input = { db, companyId: f.company.id, issueId: f.issue.id, runId: f.runId, assessmentId: f.assessmentId,
      priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null, decision: f.decision };
    await commitNativeStatusDecision(input);
    const [updated] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(updated).toMatchObject({ status: "in_review", assigneeAgentId: f.reviewer.id });
    expect(updated.checkoutRunId).toBeNull();
    expect(updated.executionRunId).toBeNull();
    expect(updated.executionState).toMatchObject({ status: "pending", currentStageId: f.decision.effects[0].kind === "activate_coding_pod_review" ? f.decision.effects[0].reviewStageId : "" });
    expect(await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, f.issue.id)))
      .toMatchObject([{ baseSha: f.snapshot.baseSha, headSha: f.snapshot.headSha }]);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.agentId, f.reviewer.id))))
      .toHaveLength(1);
    await commitNativeStatusDecision(input);
    expect(await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, f.issue.id))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id))).toHaveLength(1);
  });

  it("leaves no candidate or wake when a newer issue version wins", async () => {
    const f = await fixture();
    await db.update(issues).set({ statusVersion: 1 }).where(eq(issues.id, f.issue.id));
    await expect(commitNativeStatusDecision({ db, companyId: f.company.id, issueId: f.issue.id, runId: f.runId,
      assessmentId: f.assessmentId, priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null, decision: f.decision }))
      .rejects.toBeInstanceOf(NativeStatusRaceError);
    expect(await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, f.issue.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id))).toHaveLength(0);
  });

  it("rejects a workspace changed after finalizer preparation without committing a wake", async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "late-change.txt"), "unreviewed\n");
    await expect(commitNativeStatusDecision({ db, companyId: f.company.id, issueId: f.issue.id, runId: f.runId,
      assessmentId: f.assessmentId, priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null, decision: f.decision }))
      .rejects.toBeInstanceOf(NativeStatusRaceError);
    expect(await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, f.issue.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id))).toHaveLength(0);
  });

  it("prepares a fixed Git candidate only for the successful owner turn", async () => {
    const f = await fixture();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    const args = {
      db,
      issue,
      agentId: f.owner.id,
      reportedDisposition: "done",
      terminalState: "succeeded",
      workspaceFinalizeStatus: "succeeded",
      governanceGate: null,
    };
    expect(await prepareCodingPodNativeReviewGate(args)).toMatchObject({
      podReviewGate: {
        reviewStageId: f.decision.effects[0].kind === "activate_coding_pod_review" ? f.decision.effects[0].reviewStageId : "",
        reviewerAgentId: f.reviewer.id,
        candidateSnapshot: f.snapshot,
      },
      podReviewFailure: null,
    });
    writeFileSync(join(f.repo, "untracked.txt"), "dirty\n");
    expect(await prepareCodingPodNativeReviewGate(args)).toMatchObject({ podReviewGate: null, podReviewFailure: "candidate_dirty" });
    expect(await prepareCodingPodNativeReviewGate({ ...args, agentId: f.reviewer.id })).toMatchObject({ podReviewGate: null, podReviewFailure: null });
    expect(await prepareCodingPodNativeReviewGate({ ...args, issue: { ...issue, status: "todo" } })).toMatchObject({ podReviewGate: null, podReviewFailure: null });
  });

  it("takes a mock native owner result through the production finalizer into pod review", async () => {
    const f = await fixture();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.delete(workAssessments).where(eq(workAssessments.runId, f.runId));
    await db.delete(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    const port = new PaperclipControlPlanePort(db, {
      companyId: f.company.id, issueId: f.issue.id, runId: f.runId, agentId: f.owner.id,
      sessionId: f.sessionId, completionContractId: f.contractId,
      completionContractSha256: f.contractSha256, sourceInstanceId: f.runnerInstanceId,
      controlPlaneSourceInstanceId: "coding-pod-test",
    });
    await port.openRun({
      identity: { runId: f.runId, sessionId: f.sessionId, companyId: f.company.id, issueId: f.issue.id, agentId: f.owner.id },
      backendKind: "mock", sourceInstanceId: f.runnerInstanceId,
    });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: `${f.runId}:result` });
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [updated] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(updated).toMatchObject({ status: "in_review", assigneeAgentId: f.reviewer.id });
    expect(await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, f.issue.id))).toHaveLength(1);
  });

  it("keeps a dirty native candidate with the owner and records recovery", async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "dirty.txt"), "not committed\n");
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.delete(workAssessments).where(eq(workAssessments.runId, f.runId));
    await db.delete(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    const port = new PaperclipControlPlanePort(db, {
      companyId: f.company.id, issueId: f.issue.id, runId: f.runId, agentId: f.owner.id,
      sessionId: f.sessionId, completionContractId: f.contractId,
      completionContractSha256: f.contractSha256, sourceInstanceId: f.runnerInstanceId,
      controlPlaneSourceInstanceId: "coding-pod-dirty-test",
    });
    await port.openRun({
      identity: { runId: f.runId, sessionId: f.sessionId, companyId: f.company.id, issueId: f.issue.id, agentId: f.owner.id },
      backendKind: "mock", sourceInstanceId: f.runnerInstanceId,
    });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: `${f.runId}:result` });
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [updated] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(updated).toMatchObject({ status: "in_progress", assigneeAgentId: f.owner.id });
    expect(await db.select().from(codingPodCandidates).where(eq(codingPodCandidates.issueId, f.issue.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.company.id), eq(agentWakeupRequests.agentId, f.reviewer.id)))).toHaveLength(0);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issue.id))).toHaveLength(1);
  });
});
