CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"code" varchar(40),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "entities_workspace_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member_entity_scopes" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "member_entity_scopes_workspace_id_user_id_entity_id_pk" PRIMARY KEY("workspace_id","user_id","entity_id")
);
--> statement-breakpoint
ALTER TABLE "member_entity_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_entity_scopes" ADD CONSTRAINT "member_entity_scopes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_entity_scopes" ADD CONSTRAINT "member_entity_scopes_member_fk" FOREIGN KEY ("user_id","workspace_id") REFERENCES "public"."workspace_members"("user_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_entity_scopes" ADD CONSTRAINT "member_entity_scopes_entity_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "public"."entities"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entities_workspace_id_idx" ON "entities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "member_entity_scopes_workspace_user_idx" ON "member_entity_scopes" USING btree ("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_entity_workspace_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "public"."entities"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_accounts_workspace_entity_idx" ON "bank_accounts" USING btree ("workspace_id","entity_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "entities" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "member_entity_scopes" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
-- ════════════════════════════════════════════════════════════════════════════
-- COMPLÉMENTS MANUELS (drizzle-kit ne sait émettre ni FORCE RLS ni une policy
-- custom au GUC). Plan PLAN-entites-multi-tenant.md §1.6, étapes 6-7.
-- ════════════════════════════════════════════════════════════════════════════

-- FORCE ROW LEVEL SECURITY (même rationale que 0001/0003) : la RLS s'applique
-- AUSSI au propriétaire des tables — ceinture en plus du garde-fou C6 de
-- withWorkspace. Sans FORCE, un accès sous l'owner ignorerait tenant_isolation.
ALTER TABLE "entities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_entity_scopes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- ÉTAGE 2 — policy entity_scope sur bank_accounts (le périmètre intra-groupe).
-- Plan §2.2. Pilotée par le 3ᵉ GUC app.current_entity_scope, posé par
-- withWorkspace DEPUIS member_entity_scopes (jamais un paramètre client).
--
-- ⚠️ AS RESTRICTIVE (et NON « PERMISSIVE additionnelle » comme l'esquissait le
-- plan §2.2 — imprécision corrigée en implémentation, arbitrée 2026-06-22). Le
-- piège PostgreSQL : deux policies PERMISSIVE sur la même commande se combinent
-- en OR. tenant_isolation est FOR ALL (couvre donc SELECT) et accorde déjà
-- l'accès à toute ligne du tenant ; une entity_scope PERMISSIVE s'OR'erait avec
-- elle → la restriction d'entité ne filtrerait RIEN (un membre scopé Sucrière
-- verrait Énergie). En RESTRICTIVE, la policy se combine en AND :
--   accès ⟺ tenant_isolation (PERMISSIVE) ET entity_scope (RESTRICTIVE).
-- C'est la seule sémantique qui rend l'étage 2 effectif et fail-closed.
--
-- FOR SELECT uniquement : l'étage 2 borne la LECTURE. Les ÉCRITURES sur
-- bank_accounts (assignation compte→entité) restent gouvernées par
-- tenant_isolation (WITH CHECK workspace) + la garde ADMIN applicative —
-- l'assignation est ADMIN-only (Vision Globale par construction), pas de
-- conflit. Le durcissement de l'écriture par entité est hors socle (dette P1
-- ENTITY-WRITE-SCOPE1).
--
-- Sémantique du USING :
--   • Vision Globale (GUC vide/non posé) : nullif(...) IS NULL → TRUE → la
--     RESTRICTIVE laisse tout passer → seul tenant_isolation filtre (= tout le
--     tenant, comportement actuel inchangé).
--   • Vision Entité (GUC = CSV d'UUID) : la ligne ne passe que si entity_id est
--     NON NULL ET ∈ liste autorisée. Un compte entity_id IS NULL ou hors scope
--     est masqué (fail-closed) — invisible dans tout périmètre d'entité.
-- Transactions/soldes héritent du scope par JOINTURE sur bank_accounts (pas de
-- policy séparée sur l'append-only/partitionné). ⚠️ Les repos de lecture qui
-- lisent transactions_cache/balance_history SANS jointure n'héritent pas encore
-- du scope — dette P1 ENTITY-READ-JOIN1 (bloquante avant prod Vision Entité).
CREATE POLICY "entity_scope" ON "bank_accounts" AS RESTRICTIVE FOR SELECT TO public USING (
  nullif(current_setting('app.current_entity_scope', true), '') IS NULL
  OR (
    entity_id IS NOT NULL
    AND entity_id = ANY (
      string_to_array(current_setting('app.current_entity_scope', true), ',')::uuid[]
    )
  )
);