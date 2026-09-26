import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { codingPodCandidates, executionWorkspaces, type Db } from "@paperclipai/db";
import type { CodingPodCandidate } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface CodingPodGitSnapshot {
  workspaceId: string;
  baseSha: string;
  headSha: string;
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
