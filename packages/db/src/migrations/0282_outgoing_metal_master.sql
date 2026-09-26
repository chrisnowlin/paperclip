CREATE TABLE "coding_pod_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"reviewer_agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"review_workspace_id" uuid,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"review_stage_id" uuid NOT NULL,
	"entry_status_version" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coding_pod_candidates" ADD CONSTRAINT "coding_pod_candidates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_candidates" ADD CONSTRAINT "coding_pod_candidates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_candidates" ADD CONSTRAINT "coding_pod_candidates_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_candidates" ADD CONSTRAINT "coding_pod_candidates_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_candidates" ADD CONSTRAINT "coding_pod_candidates_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_candidates" ADD CONSTRAINT "coding_pod_candidates_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_candidates" ADD CONSTRAINT "coding_pod_candidates_review_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("review_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coding_pod_candidates_issue_version_uniq" ON "coding_pod_candidates" USING btree ("company_id","issue_id","entry_status_version");--> statement-breakpoint
CREATE INDEX "coding_pod_candidates_company_issue_idx" ON "coding_pod_candidates" USING btree ("company_id","issue_id");