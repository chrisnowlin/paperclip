CREATE TABLE "coding_pod_issue_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"pod_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"reviewer_agent_id" uuid NOT NULL,
	"board_user_id" text NOT NULL,
	"review_stage_id" uuid NOT NULL,
	"approval_stage_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coding_pod_issue_bindings" ADD CONSTRAINT "coding_pod_issue_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_issue_bindings" ADD CONSTRAINT "coding_pod_issue_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_issue_bindings" ADD CONSTRAINT "coding_pod_issue_bindings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_issue_bindings" ADD CONSTRAINT "coding_pod_issue_bindings_pod_id_coding_pods_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."coding_pods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_issue_bindings" ADD CONSTRAINT "coding_pod_issue_bindings_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_pod_issue_bindings" ADD CONSTRAINT "coding_pod_issue_bindings_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coding_pod_issue_bindings_issue_uniq" ON "coding_pod_issue_bindings" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "coding_pod_issue_bindings_company_project_idx" ON "coding_pod_issue_bindings" USING btree ("company_id","project_id");