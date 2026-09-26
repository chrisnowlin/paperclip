import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { codingPods } from "./coding_pods.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const codingPodIssueBindings = pgTable("coding_pod_issue_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  podId: uuid("pod_id").notNull().references(() => codingPods.id),
  ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id),
  reviewerAgentId: uuid("reviewer_agent_id").notNull().references(() => agents.id),
  boardUserId: text("board_user_id").notNull(),
  reviewStageId: uuid("review_stage_id").notNull(),
  approvalStageId: uuid("approval_stage_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  issueUniqueIdx: uniqueIndex("coding_pod_issue_bindings_issue_uniq").on(table.issueId),
  companyProjectIdx: index("coding_pod_issue_bindings_company_project_idx").on(table.companyId, table.projectId),
}));
