import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("execution blocker terminal projection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-blocker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("hides a settled no-replay hold on a done task and restores it if reopened", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery Co",
      issuePrefix: "REC", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Local Coder",
      role: "engineer", status: "idle", adapterType: "lmstudio_splash_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Verified artifact",
      status: "blocked", priority: "medium", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      status: "failed", invocationSource: "assignment", contextSnapshot: { issueId } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", fingerprint: runId,
      evidence: { runId, automaticRecovery: { replay: "blocked" } },
      nextAction: "Preserve without replay." });

    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ runId });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
    const [active] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `${runId}:new`,
      evidence: { runId }, nextAction: "Inspect a newer unresolved action.",
      updatedAt: new Date(Date.now() + 1_000),
    }).returning();
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({
      recoveryActionId: active!.id,
    });
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, active!.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ runId });
  });
});
