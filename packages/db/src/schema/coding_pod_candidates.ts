import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const codingPodCandidates = pgTable("coding_pod_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id),
  reviewerAgentId: uuid("reviewer_agent_id").notNull().references(() => agents.id),
  workspaceId: uuid("workspace_id").notNull().references(() => executionWorkspaces.id),
  reviewWorkspaceId: uuid("review_workspace_id").references(() => executionWorkspaces.id, { onDelete: "set null" }),
  baseSha: text("base_sha").notNull(),
  headSha: text("head_sha").notNull(),
  reviewStageId: uuid("review_stage_id").notNull(),
  entryStatusVersion: bigint("entry_status_version", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  issueVersionUniqueIdx: uniqueIndex("coding_pod_candidates_issue_version_uniq").on(table.companyId, table.issueId, table.entryStatusVersion),
  companyIssueIdx: index("coding_pod_candidates_company_issue_idx").on(table.companyId, table.issueId),
}));
