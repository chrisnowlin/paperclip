import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agents, codingPodIssueBindings, codingPods, environments, heartbeatRuns, issues, projectWorkspaces, projects, type Db } from "@paperclipai/db";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import { getLatestCodingPodCandidate, readCodingPodCandidateSnapshot } from "./coding-pod-candidates.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { aiConnectionBindingSchema, type CodingPod, type CodingPodIssueBinding, type CodingPodIssueView, type CodingPodIssuePhase, type UpsertCodingPod } from "@paperclipai/shared";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { conflict, notFound, unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);
const LOCAL_CODING_ADAPTERS = new Set([
  "claude_local", "codex_local", "cursor", "gemini_local",
  "grok_local", "hermes_local", "kimi_local", "opencode_local",
  "paperclip_runner", "pi_local",
]);

function toCodingPod(row: typeof codingPods.$inferSelect): CodingPod {
  return { ...row };
}

function toIssueBinding(row: typeof codingPodIssueBindings.$inferSelect): CodingPodIssueBinding {
  return { ...row };
}

function describePodAgentRoute(agent: Pick<typeof agents.$inferSelect, "adapterType" | "adapterConfig" | "runtimeConfig">) {
  if (agent.adapterType === "opencode_local" && agent.adapterConfig?.localSplash === true) {
    return { kind: "local_splash", model: agent.adapterConfig.model };
  }
  const binding = aiConnectionBindingSchema.safeParse(agent.runtimeConfig?.aiConnection);
  if (binding.success) {
    const { provider, method, mode } = binding.data;
    return mode === "responsible_user"
      ? { kind: "managed", provider, mode }
      : { kind: "managed", provider, method, mode, connectionId: binding.data.connectionId, grantId: binding.data.grantId };
  }
  return { kind: "unmanaged", adapterType: agent.adapterType };
}

function issuePhase(issue: typeof issues.$inferSelect, binding: CodingPodIssueBinding | null): CodingPodIssuePhase {
  if (!binding) return "not_configured";
  if (issue.status === "done") return "accepted";
  const state = issue.executionState as Record<string, unknown> | null;
  if (state?.status === "changes_requested") return "changes_requested";
  if (state?.status === "pending" && state.currentStageId === binding.approvalStageId) return "awaiting_board";
  if (state?.status === "pending" && state.currentStageId === binding.reviewStageId) return "review_pending";
  return "owner_working";
}

export async function attachCodingPodToIssue(
  db: Db,
  input: { companyId: string; issueId: string; actorUserId: string },
): Promise<CodingPodIssueBinding> {
  const publications: ActivityPublication[] = [];
  const binding = await db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
    )).for("update").limit(1);
    if (!issue) throw notFound("Issue not found");
    const [existing] = await tx.select().from(codingPodIssueBindings).where(and(
      eq(codingPodIssueBindings.companyId, input.companyId),
      eq(codingPodIssueBindings.issueId, issue.id),
    )).limit(1);
    if (existing) return toIssueBinding(existing);
    if (issue.status !== "backlog" || issue.checkoutRunId || issue.executionRunId || issue.conversationAgentId) {
      throw conflict("Coding pod attachment requires a parked task with no active run");
    }
    if (issue.executionPolicy) throw conflict("Task already has an execution policy");
    if (!issue.projectId) throw conflict("Coding pod task must belong to a project");
    const [pod] = await tx.select().from(codingPods).where(and(
      eq(codingPods.companyId, input.companyId), eq(codingPods.projectId, issue.projectId),
    )).limit(1);
    if (!pod?.enabled) throw conflict("This project has no enabled coding pod");
    const selectedAgents = await tx.select({
      id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
    }).from(agents).where(and(eq(agents.companyId, input.companyId),
      inArray(agents.id, [pod.ownerAgentId, pod.reviewerAgentId])));
    const owner = selectedAgents.find((agent) => agent.id === pod.ownerAgentId);
    const reviewer = selectedAgents.find((agent) => agent.id === pod.reviewerAgentId);
    if (!owner || !reviewer) throw conflict("Coding pod agents are no longer available");

    const policy = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: pod.reviewerAgentId }] },
        { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId: input.actorUserId }] },
      ],
    });
    if (!policy || policy.stages.length !== 2) throw new Error("Coding pod execution policy could not be normalized");
    const updated = await issueService(tx as unknown as Db).update(issue.id, {
      companyGuard: input.companyId,
      assigneeAgentId: pod.ownerAgentId,
      assigneeUserId: null,
      responsibleUserId: input.actorUserId,
      executionPolicy: { ...policy },
      actorUserId: input.actorUserId,
    }, tx, publications);
    if (!updated) throw conflict("Task changed during coding pod attachment");
    const [row] = await tx.insert(codingPodIssueBindings).values({
      companyId: input.companyId,
      projectId: issue.projectId,
      issueId: issue.id,
      podId: pod.id,
      ownerAgentId: pod.ownerAgentId,
      reviewerAgentId: pod.reviewerAgentId,
      boardUserId: input.actorUserId,
      reviewStageId: policy.stages[0]!.id,
      approvalStageId: policy.stages[1]!.id,
    }).returning();
    if (!row) throw new Error("Coding pod issue binding was not persisted");
    await logActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "coding_pod.attached",
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: { podId: pod.id, ownerAgentId: pod.ownerAgentId, reviewerAgentId: pod.reviewerAgentId,
        ownerRoute: describePodAgentRoute(owner), reviewerRoute: describePodAgentRoute(reviewer) },
    }, publications);
    return toIssueBinding(row);
  });
  for (const publication of publications) publishActivity(publication);
  return binding;
}

export async function getCodingPodIssueView(db: Db, companyId: string, issueId: string): Promise<CodingPodIssueView> {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
  if (!issue) throw notFound("Issue not found");
  const [row] = await db.select().from(codingPodIssueBindings).where(and(
    eq(codingPodIssueBindings.companyId, companyId), eq(codingPodIssueBindings.issueId, issueId),
  )).limit(1);
  const binding = row ? toIssueBinding(row) : null;
  const candidate = binding ? await getLatestCodingPodCandidate(db, companyId, issueId) : null;
  let phase = issuePhase(issue, binding);
  if (binding && candidate && (phase === "review_pending" || phase === "awaiting_board")) {
    try {
      const current = await readCodingPodCandidateSnapshot(db, { companyId, issueId, workspaceId: candidate.workspaceId });
      if (current.baseSha !== candidate.baseSha || current.headSha !== candidate.headSha) phase = "candidate_stale";
    } catch {
      phase = "candidate_stale";
    }
  }
  if (binding && phase === "review_pending") {
    const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, binding.reviewerAgentId),
      eq(heartbeatRuns.status, "running"),
      or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    )).limit(1);
    if (run) phase = "review_running";
  }
  return { binding, candidate, phase };
}

export function codingPodService(db: Db) {
  return {
    async get(companyId: string, projectId: string): Promise<CodingPod | null> {
      const [row] = await db.select().from(codingPods).where(and(
        eq(codingPods.companyId, companyId),
        eq(codingPods.projectId, projectId),
      )).limit(1);
      return row ? toCodingPod(row) : null;
    },

    async upsert(companyId: string, projectId: string, input: UpsertCodingPod): Promise<CodingPod> {
      const [project] = await db.select({ id: projects.id }).from(projects).where(and(
        eq(projects.id, projectId), eq(projects.companyId, companyId),
      )).limit(1);
      if (!project) throw notFound("Project not found");
      if (input.ownerAgentId === input.reviewerAgentId) {
        throw unprocessable("Coding pod owner and reviewer must be different agents");
      }

      const [workspace] = await db.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces).where(and(
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.projectId, projectId),
        eq(projectWorkspaces.isPrimary, true),
      )).limit(1);
      if (!workspace?.cwd) throw unprocessable("Coding pod requires a local Git-backed primary workspace");
      try {
        const { stdout } = await execFileAsync("git", ["-C", workspace.cwd, "rev-parse", "--show-toplevel"], {
          timeout: 3_000, maxBuffer: 16 * 1024,
        });
        if (!stdout.trim()) throw new Error("No Git root");
      } catch {
        throw unprocessable("Coding pod requires a local Git-backed primary workspace");
      }

      const selected = await db.select({
        id: agents.id, companyId: agents.companyId, status: agents.status, adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig, defaultEnvironmentId: agents.defaultEnvironmentId,
      }).from(agents).where(and(
        eq(agents.companyId, companyId),
        inArray(agents.id, [input.ownerAgentId, input.reviewerAgentId]),
      ));
      for (const [role, id] of [["owner", input.ownerAgentId], ["reviewer", input.reviewerAgentId]] as const) {
        const agent = selected.find((item) => item.id === id);
        if (!agent) throw unprocessable(`Coding pod ${role} must be an agent in this company`);
        if (!["idle", "active", "running"].includes(agent.status)) {
          throw unprocessable(`Coding pod ${role} must be active`);
        }
        if (!LOCAL_CODING_ADAPTERS.has(agent.adapterType) || !findActiveServerAdapter(agent.adapterType)) {
          throw unprocessable(`Coding pod ${role} needs an available local coding adapter`);
        }
        if (role === "reviewer" && input.enabled) {
          if (agent.adapterType === "opencode_local" && agent.adapterConfig?.localSplash === true) {
            throw unprocessable("Coding pod local Splash reviewer cannot run in the required sandbox");
          }
          const [reviewEnvironment] = agent.defaultEnvironmentId
            ? await db.select({ driver: environments.driver, status: environments.status }).from(environments)
                .where(eq(environments.id, agent.defaultEnvironmentId)).limit(1)
            : [];
          if (reviewEnvironment?.driver !== "sandbox" || reviewEnvironment.status !== "active") {
            throw unprocessable("Coding pod reviewer must select an active sandbox environment as its default before review can run");
          }
        }
      }

      const now = new Date();
      const [row] = await db.insert(codingPods).values({
        companyId, projectId, ...input,
      }).onConflictDoUpdate({
        target: codingPods.projectId,
        set: { ...input, updatedAt: now },
      }).returning();
      if (!row) throw new Error("Coding pod upsert did not return a row");
      return toCodingPod(row);
    },
  };
}
