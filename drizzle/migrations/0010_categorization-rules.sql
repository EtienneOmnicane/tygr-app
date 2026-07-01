CREATE TABLE "categorization_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pattern" varchar(255) NOT NULL,
	"match_type" varchar(16) NOT NULL,
	"category_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categorization_rules_workspace_unique" UNIQUE("workspace_id","pattern","match_type","category_id"),
	CONSTRAINT "categorization_rules_match_type_check" CHECK ("categorization_rules"."match_type" IN ('contains','starts_with')),
	CONSTRAINT "categorization_rules_pattern_not_blank" CHECK (length(trim("categorization_rules"."pattern")) > 0)
);
--> statement-breakpoint
ALTER TABLE "categorization_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_category_workspace_fk" FOREIGN KEY ("category_id","workspace_id") REFERENCES "public"."categories"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categorization_rules_workspace_active_priority_idx" ON "categorization_rules" USING btree ("workspace_id","is_active","priority");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "categorization_rules" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
-- ════════════════════════════════════════════════════════════════════════════
-- COMPLÉMENT MANUEL (drizzle-kit n'émet pas FORCE RLS). Même rationale que
-- 0001/0003/0008 : la RLS s'applique AUSSI au propriétaire des tables — ceinture
-- en plus du garde-fou C6 de withWorkspace. Sans FORCE, un accès sous l'owner
-- ignorerait tenant_isolation.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE "categorization_rules" FORCE ROW LEVEL SECURITY;