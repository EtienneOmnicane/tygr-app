CREATE TABLE "balance_history" (
	"workspace_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"balance_date" date NOT NULL,
	"balance" numeric(15, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "balance_history_bank_account_id_balance_date_pk" PRIMARY KEY("bank_account_id","balance_date")
);
--> statement-breakpoint
ALTER TABLE "balance_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"omnifi_account_id" varchar(64) NOT NULL,
	"account_name" varchar(255) NOT NULL,
	"currency" char(3) NOT NULL,
	"current_balance" numeric(15, 2),
	"is_selected" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_cursor" text,
	CONSTRAINT "bank_accounts_omnifi_account_id_unique" UNIQUE("omnifi_account_id")
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"omnifi_connection_id" varchar(64) NOT NULL,
	"institution_id" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"next_sync_available_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_connections_omnifi_connection_id_unique" UNIQUE("omnifi_connection_id")
);
--> statement-breakpoint
ALTER TABLE "bank_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transactions_cache" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"omnifi_txn_id" varchar(255) NOT NULL,
	"transaction_date" date NOT NULL,
	"booking_date_time" timestamp with time zone NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"credit_debit" varchar(6) NOT NULL,
	"bank_label_raw" text NOT NULL,
	"clean_label" varchar(255),
	"primary_category" varchar(120),
	"sub_category" varchar(120),
	"is_removed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "transactions_cache_id_transaction_date_pk" PRIMARY KEY("id","transaction_date"),
	CONSTRAINT "transactions_cache_omnifi_txn_unique" UNIQUE("omnifi_txn_id","transaction_date"),
	CONSTRAINT "transactions_cache_credit_debit_check" CHECK ("transactions_cache"."credit_debit" IN ('Credit','Debit'))
)
PARTITION BY RANGE ("transaction_date");
--> statement-breakpoint
-- Partitionnement (plan v2.1) : clause posée à la main — drizzle-kit ne sait
-- pas l'émettre, le snapshot reste fidèle (mêmes colonnes/contraintes).
-- Partitions annuelles 2024-2027 (l'historique complet Omni-FI peut remonter
-- loin) + DEFAULT en filet ; l'automatisation du roulement (alerte J-30 du
-- plan) arrive avec la pipeline de sync — entrée TODOS.md.
CREATE TABLE "transactions_cache_2024" PARTITION OF "transactions_cache"
	FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');--> statement-breakpoint
CREATE TABLE "transactions_cache_2025" PARTITION OF "transactions_cache"
	FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');--> statement-breakpoint
CREATE TABLE "transactions_cache_2026" PARTITION OF "transactions_cache"
	FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');--> statement-breakpoint
CREATE TABLE "transactions_cache_2027" PARTITION OF "transactions_cache"
	FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');--> statement-breakpoint
CREATE TABLE "transactions_cache_default" PARTITION OF "transactions_cache" DEFAULT;--> statement-breakpoint
ALTER TABLE "transactions_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "balance_history" ADD CONSTRAINT "balance_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_history" ADD CONSTRAINT "balance_history_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_connection_id_bank_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions_cache" ADD CONSTRAINT "transactions_cache_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions_cache" ADD CONSTRAINT "transactions_cache_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_history_workspace_date_idx" ON "balance_history" USING btree ("workspace_id","balance_date");--> statement-breakpoint
CREATE INDEX "bank_accounts_workspace_id_idx" ON "bank_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_connection_id_idx" ON "bank_accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "bank_connections_workspace_id_idx" ON "bank_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "transactions_cache_workspace_date_idx" ON "transactions_cache" USING btree ("workspace_id","transaction_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_cache_bank_account_id_idx" ON "transactions_cache" USING btree ("bank_account_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "balance_history" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_accounts" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_connections" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions_cache" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
-- FORCE ROW LEVEL SECURITY (même rationale que 0001_rls-force) : la RLS
-- s'applique aussi au propriétaire — ceinture en plus du garde-fou C6.
ALTER TABLE "bank_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions_cache" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "balance_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- ⚠️ ISOLATION TENANT SUR TABLE PARTITIONNÉE (constat cross-review BLOQUANT,
-- 2026-06-15). PostgreSQL n'hérite PAS la RLS/les policies de la table mère aux
-- partitions : une partition interrogée EN DIRECT (SELECT FROM
-- transactions_cache_2026) n'applique que SON propre état RLS. Comme tygr_app
-- reçoit GRANT … ON ALL TABLES (partitions incluses), sans RLS par partition la
-- lecture directe d'une partition fuit TOUS les workspaces (montants +
-- bank_label_raw, PII). On pose donc ENABLE+FORCE+policy tenant_isolation sur
-- CHAQUE partition. ⚠️ Le roulement annuel des partitions (dette TODOS) DOIT
-- répéter ces trois instructions à la création de toute partition future, sinon
-- la prochaine partition rouvre le trou.
ALTER TABLE "transactions_cache_2024" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions_cache_2024" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions_cache_2024" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "transactions_cache_2025" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions_cache_2025" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions_cache_2025" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "transactions_cache_2026" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions_cache_2026" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions_cache_2026" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "transactions_cache_2027" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions_cache_2027" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions_cache_2027" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "transactions_cache_default" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions_cache_default" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions_cache_default" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
-- #3 — Tombstone strict : transactions_cache et balance_history ne se
-- suppriment jamais physiquement (is_removed porte l'effacement logique). On
-- retire le privilège DELETE à tygr_app sur ces deux tables (le GRANT global de
-- provisioning l'accorde sinon). Défense en base, pas seulement par convention.
REVOKE DELETE ON "transactions_cache" FROM "tygr_app";--> statement-breakpoint
REVOKE DELETE ON "transactions_cache_2024" FROM "tygr_app";--> statement-breakpoint
REVOKE DELETE ON "transactions_cache_2025" FROM "tygr_app";--> statement-breakpoint
REVOKE DELETE ON "transactions_cache_2026" FROM "tygr_app";--> statement-breakpoint
REVOKE DELETE ON "transactions_cache_2027" FROM "tygr_app";--> statement-breakpoint
REVOKE DELETE ON "transactions_cache_default" FROM "tygr_app";--> statement-breakpoint
REVOKE DELETE ON "balance_history" FROM "tygr_app";