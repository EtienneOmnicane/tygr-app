-- ════════════════════════════════════════════════════════════════════════════
-- L2 — Périmètre party/compte par membre (user_scopes).
-- Plan PLAN-architecture-multi-tenant-omnicane.md §1.1 / §5 (lot L2).
--
-- Table NEUVE et VIDE. PÉRIMÈTRE STRICT : table de DROITS + isolation TENANT
-- (étage 1, RLS workspace) + intégrité référentielle scopée (FK composites) +
-- exclusivité party XOR compte (CHECK) + idempotence (UNIQUE partiels). AUCUNE
-- policy account_scope, AUCUN chemin de lecture, AUCUN seed : le RÉSOLVEUR de
-- périmètre et la policy `account_scope` (étage 2) sont le lot L4. Cohabite avec
-- member_entity_scopes (axe BU), sans le remplacer.
--
-- Diff drizzle-kit PROPRE (le snapshot 0014 a resynchronisé transactions_cache à
-- 19 colonnes — le re-diff parasite de la dette DB-MIGRATE3 ne se manifeste plus).
-- Seul ajout MANUEL : FORCE ROW LEVEL SECURITY (drizzle-kit ne l'émet pas), en bas.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE "user_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"party_id" uuid,
	"bank_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_scopes_target_exclusive_check" CHECK (num_nonnulls("user_scopes"."party_id", "user_scopes"."bank_account_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "user_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_member_fk" FOREIGN KEY ("user_id","workspace_id") REFERENCES "public"."workspace_members"("user_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_party_fk" FOREIGN KEY ("party_id","workspace_id") REFERENCES "public"."parties"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_account_fk" FOREIGN KEY ("bank_account_id","workspace_id") REFERENCES "public"."bank_accounts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_scopes_user_party_unique" ON "user_scopes" USING btree ("workspace_id","user_id","party_id") WHERE "user_scopes"."party_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_scopes_user_account_unique" ON "user_scopes" USING btree ("workspace_id","user_id","bank_account_id") WHERE "user_scopes"."bank_account_id" is not null;--> statement-breakpoint
CREATE INDEX "user_scopes_workspace_user_idx" ON "user_scopes" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_scopes" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- COMPLÉMENT MANUEL (drizzle-kit n'émet PAS FORCE RLS — cf. 0001/0003/0008/0013).
-- FORCE ROW LEVEL SECURITY : la RLS tenant s'applique AUSSI au propriétaire des
-- tables (ceinture en plus du garde-fou C6 de withWorkspace). Sans FORCE, un accès
-- sous l'owner ignorerait tenant_isolation.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "user_scopes" FORCE ROW LEVEL SECURITY;