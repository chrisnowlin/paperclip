import { and, desc, eq, sql } from "drizzle-orm";
import { codingPodCandidates, codingPodIssueBindings, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import {
  resolveCoreTrustPreset,
  type ResolveCoreTrustPresetInput,
} from "./trust-preset-resolver.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Retain dispatch's effective boundary before exposing any execution capability. */
export async function resolveAndRetainRunTrustPreset(
  db: Db,
  input: Omit<ResolveCoreTrustPresetInput, "run"> & {
    agentId: string;
    runId: string;
    issueId?: string | null;
  },
) {
  return db.transaction(async (tx) => {
    const scope = and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.status, "running"),
    );
    const [run] = await tx
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(scope)
      .for("update");
    if (!run) throw conflict("Cannot retain policy for an inactive execution");

    // Use the durable run policy, not a caller's possibly stale launch snapshot.
    // Resuming or editing a live policy may tighten this boundary, never erase it.
    const existingPolicy = run.contextSnapshot?.executionPolicy;
    let effectivePolicy = existingPolicy;
    if (input.issueId) {
      const [issue] = await tx.select({
        id: issues.id,
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
        executionState: issues.executionState,
      }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).limit(1);
      const [binding] = issue
        ? await tx.select().from(codingPodIssueBindings).where(and(
            eq(codingPodIssueBindings.companyId, input.companyId),
            eq(codingPodIssueBindings.issueId, issue.id),
            eq(codingPodIssueBindings.reviewerAgentId, input.agentId),
          )).limit(1)
        : [];
      const state = asRecord(issue?.executionState);
      const participant = asRecord(state.currentParticipant);
      if (issue && binding && issue.assigneeAgentId === input.agentId && issue.projectId === binding.projectId &&
          state.status === "pending" && state.currentStageId === binding.reviewStageId &&
          participant.type === "agent" && participant.agentId === input.agentId) {
        const [candidate] = await tx.select({ id: codingPodCandidates.id }).from(codingPodCandidates).where(and(
          eq(codingPodCandidates.companyId, input.companyId),
          eq(codingPodCandidates.issueId, issue.id),
          eq(codingPodCandidates.reviewStageId, binding.reviewStageId),
        )).orderBy(desc(codingPodCandidates.entryStatusVersion)).limit(1);
        if (!candidate) throw conflict("Coding pod reviewer cannot run without a fixed candidate");
        effectivePolicy = {
          ...asRecord(existingPolicy),
          reviewPreset: { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine" },
          authorizationPolicy: {
            ...asRecord(asRecord(existingPolicy).authorizationPolicy),
            trustPreset: "low_trust_review",
            trustBoundary: {
              mode: "low_trust_review",
              companyId: input.companyId,
              projectIds: [binding.projectId],
              issueIds: [issue.id],
              allowedAgentIds: [input.agentId],
              allowedSecretBindingIds: [],
              allowedToolClasses: ["git.read", "github.pr.read", "tests.local"],
            },
          },
        };
      }
    }
    const trustPreset = resolveCoreTrustPreset({
      ...input,
      run: { companyId: input.companyId, executionPolicy: effectivePolicy },
    });
    if (trustPreset.kind !== "low_trust_review") {
      return { trustPreset, executionPolicy: effectivePolicy };
    }

    const executionPolicy = {
      ...asRecord(effectivePolicy),
      trustPreset: trustPreset.preset,
      authorizationPolicy: {
        ...asRecord(asRecord(effectivePolicy).authorizationPolicy),
        trustPreset: trustPreset.preset,
        trustBoundary: trustPreset.boundary,
      },
    };
    await tx
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{executionPolicy}', ${JSON.stringify(executionPolicy)}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(scope);
    return { trustPreset, executionPolicy };
  });
}
