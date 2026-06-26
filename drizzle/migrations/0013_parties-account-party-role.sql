-- ════════════════════════════════════════════════════════════════════════════
-- L0 + L1 — Couche Parties (entité légale Omni-FI) + détention compte↔party.
-- Plan PLAN-architecture-multi-tenant-omnicane.md §1.1 / §5 (lots L0, L1).
--
-- ⚠️ NETTOYAGE MANUEL DU DIFF GÉNÉRÉ (dette DB-MIGRATE3) : `drizzle-kit generate`
-- a produit, EN PLUS des objets de ce lot, des `ALTER TABLE transactions_cache
-- ADD COLUMN confidence_level/classification_source/rule_id_match/
-- is_auto_categorized/category_source` (+ leurs CHECK). Ces colonnes sont DÉJÀ
-- appliquées par les migrations 0011 et 0012 : le re-diff vient d'un snapshot meta
-- DÉSYNCHRONISÉ (0009 est hors _journal.json — piège connu ; il manque aussi les
-- snapshots 0009/0011/0012). Les rejouer ferait ÉCHOUER cette migration (« column
-- already exists »). Ils sont donc RETIRÉS ici à la main. Le 0013_snapshot.json
-- généré, lui, reflète l'état cible COMPLET (16 tables, transactions_cache à 19
-- colonnes) — on le CONSERVE, il resynchronise les générations futures.
-- Ne contient donc QUE : bank_accounts UNIQUE(id, ws) [L0] ; tables parties &
-- account_party_role [L1] ; leurs RLS/FORCE/policies/FK/index. AUCUNE policy
-- account_scope ici (c'est L4, sous cross-review sécu).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid,
	"omnifi_party_id" varchar(64) NOT NULL,
	"name" varchar(255),
	"ownership_type" varchar(24),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parties_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "parties_workspace_omnifi_party_unique" UNIQUE("workspace_id","omnifi_party_id")
);
--> statement-breakpoint
ALTER TABLE "parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account_party_role" (
	"workspace_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"ownership_type" varchar(24) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_party_role_workspace_id_bank_account_id_party_id_pk" PRIMARY KEY("workspace_id","bank_account_id","party_id")
);
--> statement-breakpoint
ALTER TABLE "account_party_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- L0 : cible des FK composites scopées vers un compte (additive — PK reste id seul).
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_id_workspace_unique" UNIQUE("id","workspace_id");--> statement-breakpoint

-- FK tenant (workspace_id) des nouvelles tables.
ALTER TABLE "parties" ADD CONSTRAINT "parties_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_party_role" ADD CONSTRAINT "account_party_role_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- FK COMPOSITES scopées workspace (anti cross-tenant en base).
-- parties.entity_id → entities (BU optionnelle) ON DELETE RESTRICT.
ALTER TABLE "parties" ADD CONSTRAINT "parties_entity_workspace_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "public"."entities"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- account_party_role.bank_account_id → bank_accounts ON DELETE CASCADE (liaison,
-- NON append-only : si le compte tombe via cascade connexion, son rôle tombe).
ALTER TABLE "account_party_role" ADD CONSTRAINT "account_party_role_account_fk" FOREIGN KEY ("bank_account_id","workspace_id") REFERENCES "public"."bank_accounts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- account_party_role.party_id → parties ON DELETE RESTRICT (on archive une party).
ALTER TABLE "account_party_role" ADD CONSTRAINT "account_party_role_party_fk" FOREIGN KEY ("party_id","workspace_id") REFERENCES "public"."parties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Index.
CREATE INDEX "parties_workspace_id_idx" ON "parties" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "parties_workspace_entity_idx" ON "parties" USING btree ("workspace_id","entity_id");--> statement-breakpoint
CREATE INDEX "account_party_role_workspace_party_idx" ON "account_party_role" USING btree ("workspace_id","party_id");--> statement-breakpoint
CREATE INDEX "account_party_role_workspace_account_idx" ON "account_party_role" USING btree ("workspace_id","bank_account_id");--> statement-breakpoint

-- Policies tenant_isolation (PERMISSIVE FOR ALL) — étage 1 (RLS workspace), verbatim
-- le nullif fail-closed des migrations existantes.
CREATE POLICY "tenant_isolation" ON "parties" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "account_party_role" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- COMPLÉMENT MANUEL (drizzle-kit n'émet PAS FORCE RLS — cf. 0001/0003/0008).
-- FORCE ROW LEVEL SECURITY : la RLS tenant s'applique AUSSI au propriétaire des
-- tables (ceinture en plus du garde-fou C6 de withWorkspace). Sans FORCE, un accès
-- sous l'owner ignorerait tenant_isolation.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "parties" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_party_role" FORCE ROW LEVEL SECURITY;
