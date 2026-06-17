CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"parent_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "categories_workspace_name_parent_unique" UNIQUE("workspace_id","name","parent_id")
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categorization_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"transaction_date" date NOT NULL,
	"action" varchar(16) NOT NULL,
	"category_name" varchar(120),
	"amount" numeric(15, 2),
	"source" varchar(10),
	"actor_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categorization_audit_action_check" CHECK ("categorization_audit"."action" IN ('CREATE','UPDATE','DELETE'))
);
--> statement-breakpoint
ALTER TABLE "categorization_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_categorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"transaction_date" date NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"source" varchar(10) NOT NULL,
	"rule_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "txn_categorizations_amount_positive" CHECK ("transaction_categorizations"."amount" > 0),
	CONSTRAINT "txn_categorizations_source_check" CHECK ("transaction_categorizations"."source" IN ('MANUAL','RULE')),
	CONSTRAINT "txn_categorizations_source_rule_coherence" CHECK (("transaction_categorizations"."source" = 'MANUAL' AND "transaction_categorizations"."rule_id" IS NULL) OR ("transaction_categorizations"."source" = 'RULE' AND "transaction_categorizations"."rule_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "transaction_categorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_workspace_fk" FOREIGN KEY ("parent_id","workspace_id") REFERENCES "public"."categories"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_audit" ADD CONSTRAINT "categorization_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorization_audit" ADD CONSTRAINT "categorization_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_categorizations" ADD CONSTRAINT "transaction_categorizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_categorizations" ADD CONSTRAINT "transaction_categorizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_categorizations" ADD CONSTRAINT "txn_categorizations_transaction_fk" FOREIGN KEY ("transaction_id","transaction_date") REFERENCES "public"."transactions_cache"("id","transaction_date") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_categorizations" ADD CONSTRAINT "txn_categorizations_category_workspace_fk" FOREIGN KEY ("category_id","workspace_id") REFERENCES "public"."categories"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_workspace_id_idx" ON "categories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "categorization_audit_workspace_txn_idx" ON "categorization_audit" USING btree ("workspace_id","transaction_id","transaction_date");--> statement-breakpoint
CREATE INDEX "txn_categorizations_workspace_txn_idx" ON "transaction_categorizations" USING btree ("workspace_id","transaction_id","transaction_date");--> statement-breakpoint
CREATE INDEX "txn_categorizations_workspace_category_idx" ON "transaction_categorizations" USING btree ("workspace_id","category_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "categories" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "categorization_audit" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transaction_categorizations" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
-- ───────────────────────────────────────────────────────────────────
-- AJOUTS CUSTOM (drizzle-kit ne les émet pas) — Pilier 1
-- ───────────────────────────────────────────────────────────────────
-- FORCE RLS (même rationale que 0001/0003 : la RLS s'applique aussi au
-- propriétaire — ceinture en plus du garde-fou C6).
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_categorizations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "categorization_audit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- APPEND-ONLY de categorization_audit (FEAT-8.1, immuable). Trigger BEFORE
-- UPDATE OR DELETE qui lève — défense réelle indépendante du privilège ET du
-- chemin (cf. 0004 pour transactions_cache ; ici on couvre AUSSI l'UPDATE). La
-- liste blanche provisioning n'accorde que INSERT/SELECT à tygr_app sur cette
-- table. Message sans PII (nom de table seulement, règle 8).
CREATE OR REPLACE FUNCTION tygr_refuser_mutation_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'append_only_no_mutation: la table % est append-only — INSERT seulement (ni UPDATE ni DELETE)',
    TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "categorization_audit_no_mutation" ON "categorization_audit";--> statement-breakpoint
CREATE TRIGGER "categorization_audit_no_mutation" BEFORE UPDATE OR DELETE ON "categorization_audit"
  FOR EACH ROW EXECUTE FUNCTION tygr_refuser_mutation_append_only();