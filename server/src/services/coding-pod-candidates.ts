import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { codingPodCandidates, codingPodIssueBindings, executionWorkspaces, issues, type Db } from "@paperclipai/db";
import type { CodingPodCandidate } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface CodingPodGitSnapshot {
  workspaceId: string;
  baseSha: string;
  headSha: string;
}

export function assertCodingPodReviewSourceUnchanged(
  original: { projectId: unknown; executionPolicy: unknown; executionState: unknown; statusVersion: unknown },
  locked: { projectId: unknown; executionPolicy: unknown; executionState: unknown; statusVersion: unknown },
): void {
  if (original.projectId !== locked.projectId ||
      Number(original.statusVersion) !== Number(locked.statusVersion) ||
      !isDeepStrictEqual(original.executionPolicy, locked.executionPolicy) ||
      !isDeepStrictEqual(original.executionState, locked.executionState)) {
    throw conflict("Coding pod task policy or project changed while capturing its candidate");
  }
}

export async function resolveCodingPodReviewerWorkspacePlan(
  db: Db,
  input: { companyId: string; issueId: string; reviewerAgentId: string },
): Promise<{ candidateId: string; ownerWorkspaceId: string; reviewWorkspaceId: string | null; baseRef: string } | null> {
  const [issue] = await db.select({
    assigneeAgentId: issues.assigneeAgentId,
    executionState: issues.executionState,
  }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).limit(1);
  const [binding] = issue
    ? await db.select().from(codingPodIssueBindings).where(and(
        eq(codingPodIssueBindings.companyId, input.companyId),
        eq(codingPodIssueBindings.issueId, input.issueId),
        eq(codingPodIssueBindings.reviewerAgentId, input.reviewerAgentId),
      )).limit(1)
    : [];
  const state = issue?.executionState as Record<string, unknown> | null;
  const participant = state?.currentParticipant as Record<string, unknown> | null;
  if (!issue || !binding || issue.assigneeAgentId !== input.reviewerAgentId ||
      state?.status !== "pending" || state.currentStageId !== binding.reviewStageId ||
      participant?.type !== "agent" || participant.agentId !== input.reviewerAgentId) return null;
  const [candidate] = await db.select().from(codingPodCandidates).where(and(
    eq(codingPodCandidates.companyId, input.companyId),
    eq(codingPodCandidates.issueId, input.issueId),
    eq(codingPodCandidates.reviewStageId, binding.reviewStageId),
  )).orderBy(desc(codingPodCandidates.entryStatusVersion)).limit(1);
  if (!candidate) throw conflict("Coding pod reviewer cannot run without a fixed candidate");
  return {
    candidateId: candidate.id,
    ownerWorkspaceId: candidate.workspaceId,
    reviewWorkspaceId: candidate.reviewWorkspaceId,
    baseRef: candidate.headSha,
  };
}

export async function assertCodingPodCandidateFreshForDecision(
  db: Db,
  input: { companyId: string; issueId: string; stageId: string },
): Promise<void> {
  const [binding] = await db.select().from(codingPodIssueBindings).where(and(
    eq(codingPodIssueBindings.companyId, input.companyId),
    eq(codingPodIssueBindings.issueId, input.issueId),
  )).limit(1);
  if (!binding || (input.stageId !== binding.reviewStageId && input.stageId !== binding.approvalStageId)) return;
  const [candidate] = await db.select().from(codingPodCandidates).where(and(
    eq(codingPodCandidates.companyId, input.companyId),
    eq(codingPodCandidates.issueId, input.issueId),
    eq(codingPodCandidates.reviewStageId, binding.reviewStageId),
  )).orderBy(desc(codingPodCandidates.entryStatusVersion)).limit(1);
  if (!candidate) throw conflict("Coding pod approval requires a reviewed Git candidate");
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${candidate.workspaceId}`}, 0))`);
  let fresh: CodingPodGitSnapshot;
  try {
    fresh = await readCodingPodCandidateSnapshot(db, {
      companyId: input.companyId, issueId: input.issueId, workspaceId: candidate.workspaceId,
    });
  } catch {
    throw conflict("Coding pod candidate changed; return it to the owner for a new review");
  }
  if (fresh.baseSha !== candidate.baseSha || fresh.headSha !== candidate.headSha) {
    throw conflict("Coding pod candidate changed; return it to the owner for a new review");
  }
}

export function selectCodingPodReviewerWorkspace(
  plan: { candidateId: string; ownerWorkspaceId: string; reviewWorkspaceId: string | null; baseRef: string } | null,
  input: {
    persistedNativeWorkspaceId: string | null;
    issueWorkspaceId: string | null;
    issuePreference: string | null;
    config: Record<string, unknown>;
  },
) {
  if (plan) {
    if (input.persistedNativeWorkspaceId === plan.ownerWorkspaceId ||
        (plan.reviewWorkspaceId && input.persistedNativeWorkspaceId && input.persistedNativeWorkspaceId !== plan.reviewWorkspaceId)) {
      throw conflict("Coding pod reviewer cannot resume in the owner's workspace");
    }
    const reuseWorkspaceId = input.persistedNativeWorkspaceId ?? plan.reviewWorkspaceId;
    return {
      requestedWorkspaceId: reuseWorkspaceId ?? null,
      issuePreference: reuseWorkspaceId ? "reuse_existing" : null,
      config: {
        ...input.config,
        workspaceStrategy: {
          ...(input.config.workspaceStrategy && typeof input.config.workspaceStrategy === "object"
            ? input.config.workspaceStrategy : {}),
          type: "git_worktree",
          baseRef: plan.baseRef,
          branchTemplate: `coding-pod-review/{{issue.identifier}}-${plan.candidateId.slice(0, 8)}`,
        },
      },
    };
  }
  return {
    requestedWorkspaceId: input.persistedNativeWorkspaceId ?? input.issueWorkspaceId,
    issuePreference: input.issuePreference,
    config: input.config,
  };
}

export async function insertCodingPodCandidate(
  db: Db,
  input: {
    binding: { companyId: string; projectId: string; issueId: string; ownerAgentId: string; reviewerAgentId: string };
    snapshot: CodingPodGitSnapshot;
    reviewStageId: string;
    entryStatusVersion: number;
  },
): Promise<CodingPodCandidate> {
  const { binding, snapshot, reviewStageId, entryStatusVersion } = input;
  const key = and(
    eq(codingPodCandidates.companyId, binding.companyId),
    eq(codingPodCandidates.issueId, binding.issueId),
    eq(codingPodCandidates.entryStatusVersion, entryStatusVersion),
  );
  const values = {
    companyId: binding.companyId,
    projectId: binding.projectId,
    issueId: binding.issueId,
    ownerAgentId: binding.ownerAgentId,
    reviewerAgentId: binding.reviewerAgentId,
    workspaceId: snapshot.workspaceId,
    baseSha: snapshot.baseSha,
    headSha: snapshot.headSha,
    reviewStageId,
    entryStatusVersion,
  };
  await db.insert(codingPodCandidates).values(values).onConflictDoNothing({
    target: [codingPodCandidates.companyId, codingPodCandidates.issueId, codingPodCandidates.entryStatusVersion],
  });
  const [row] = await db.select().from(codingPodCandidates).where(key).limit(1);
  if (!row) throw new Error("Coding pod candidate was not persisted");
  if (row.projectId !== values.projectId || row.ownerAgentId !== values.ownerAgentId ||
      row.reviewerAgentId !== values.reviewerAgentId || row.workspaceId !== values.workspaceId ||
      row.baseSha !== values.baseSha || row.headSha !== values.headSha || row.reviewStageId !== values.reviewStageId) {
    throw conflict("Coding pod candidate version already refers to a different Git state");
  }
  return row;
}

export async function getLatestCodingPodCandidate(db: Db, companyId: string, issueId: string): Promise<CodingPodCandidate | null> {
  const [row] = await db.select().from(codingPodCandidates).where(and(
    eq(codingPodCandidates.companyId, companyId), eq(codingPodCandidates.issueId, issueId),
  )).orderBy(desc(codingPodCandidates.entryStatusVersion)).limit(1);
  return row ?? null;
}

export async function readCodingPodCandidateDiff(
  db: Db,
  input: { companyId: string; issueId: string; candidateId: string },
): Promise<string> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.candidateId)) {
    throw notFound("Coding pod candidate not found");
  }
  const [candidate] = await db.select().from(codingPodCandidates).where(and(
    eq(codingPodCandidates.id, input.candidateId),
    eq(codingPodCandidates.companyId, input.companyId),
    eq(codingPodCandidates.issueId, input.issueId),
  )).limit(1);
  if (!candidate) throw notFound("Coding pod candidate not found");
  const [workspace] = await db.select({ cwd: executionWorkspaces.cwd }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, candidate.workspaceId),
    eq(executionWorkspaces.companyId, input.companyId),
    eq(executionWorkspaces.sourceIssueId, input.issueId),
  )).limit(1);
  if (!workspace?.cwd) throw notFound("Coding pod source workspace not found");
  if (!/^[0-9a-f]{40}$/.test(candidate.baseSha) || !/^[0-9a-f]{40}$/.test(candidate.headSha)) {
    throw unprocessable("Coding pod candidate Git commits are invalid");
  }
  try {
    const { stdout } = await execFileAsync("git", ["--no-optional-locks", "-C", workspace.cwd,
      "diff", "--no-ext-diff", "--no-textconv", candidate.baseSha, candidate.headSha, "--"], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw unprocessable("Candidate diff is unavailable or exceeds 2 MB; inspect the source workspace directly");
  }
}

export async function readCodingPodCandidateSnapshot(
  db: Db,
  input: { companyId: string; issueId: string; workspaceId: string },
): Promise<CodingPodGitSnapshot> {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, input.workspaceId),
    eq(executionWorkspaces.companyId, input.companyId),
    eq(executionWorkspaces.sourceIssueId, input.issueId),
  )).limit(1);
  if (!workspace) throw notFound("Execution workspace not found");
  if (workspace.status !== "active" || workspace.strategyType !== "git_worktree" || !workspace.cwd || !workspace.baseRef) {
    throw unprocessable("Coding pod review requires an active Git worktree with a base ref");
  }

  const git = async (...args: string[]) => {
    const { stdout } = await execFileAsync("git", ["--no-optional-locks", "-C", workspace.cwd!, ...args], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    });
    return stdout.trim();
  };
  let status: string;
  try {
    status = await git("status", "--porcelain=v1", "--untracked-files=all");
  } catch {
    throw unprocessable("Coding pod review workspace could not be inspected as Git");
  }
  if (status) throw conflict("Commit or discard workspace changes before requesting coding pod review");

  let baseSha: string;
  let headSha: string;
  try {
    [baseSha, headSha] = await Promise.all([
      git("rev-parse", "--verify", `${workspace.baseRef}^{commit}`),
      git("rev-parse", "--verify", "HEAD^{commit}"),
    ]);
  } catch {
    throw unprocessable("Coding pod review base or candidate commit is unresolved");
  }
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw unprocessable("Coding pod review requires full Git commit SHAs");
  }
  try {
    await git("merge-base", "--is-ancestor", baseSha, headSha);
  } catch {
    throw conflict("Coding pod candidate does not descend from its workspace base commit");
  }
  return { workspaceId: workspace.id, baseSha, headSha };
}
