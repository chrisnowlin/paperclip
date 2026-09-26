import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { agents, codingPods, projectWorkspaces, projects, type Db } from "@paperclipai/db";
import type { CodingPod, UpsertCodingPod } from "@paperclipai/shared";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { notFound, unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);
const LOCAL_CODING_ADAPTERS = new Set([
  "claude_local", "codex_local", "cursor", "gemini_local",
  "grok_local", "hermes_local", "kimi_local", "opencode_local",
  "paperclip_runner", "pi_local",
]);

function toCodingPod(row: typeof codingPods.$inferSelect): CodingPod {
  return { ...row };
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
