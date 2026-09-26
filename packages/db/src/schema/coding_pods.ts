import { boolean, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const codingPods = pgTable("coding_pods", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id),
  reviewerAgentId: uuid("reviewer_agent_id").notNull().references(() => agents.id),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  projectUniqueIdx: uniqueIndex("coding_pods_project_uniq").on(table.projectId),
  companyIdx: index("coding_pods_company_idx").on(table.companyId),
}));
