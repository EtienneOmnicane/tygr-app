CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" varchar(120) NOT NULL,
	"password_hash" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" varchar(20) NOT NULL,
	CONSTRAINT "workspace_members_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" IN ('ADMIN','MANAGER','VIEWER'))
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" varchar(20) DEFAULT 'INTERNAL_BU' NOT NULL,
	"base_currency" char(3) DEFAULT 'MUR' NOT NULL,
	"omnifi_client_user_id" varchar(64) NOT NULL,
	"omnifi_environment" varchar(10) DEFAULT 'sandbox' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_omnifi_client_user_id_unique" UNIQUE("omnifi_client_user_id"),
	CONSTRAINT "workspaces_kind_check" CHECK ("workspaces"."kind" IN ('INTERNAL_BU','EXTERNAL_CLIENT','DEMO','CONSOLIDATION')),
	CONSTRAINT "workspaces_environment_check" CHECK ("workspaces"."omnifi_environment" IN ('sandbox','production'))
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workspace_members" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "own_memberships_select" ON "workspace_members" AS PERMISSIVE FOR SELECT TO public USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);