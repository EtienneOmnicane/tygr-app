-- ════════════════════════════════════════════════════════════════════════════
-- Épic 8 · Échéances prévisionnelles (registre MANUEL) — table NEUVE `echeances`.
-- Cadrage de référence : PLAN-cadrage-echeances.md (v1 = registre manuel, lettrage
-- factures / matrice éditable / What-If différés P2). Lot L1 (data + RLS).
--
-- Table ÉDITABLE / SUPPRIMABLE (donnée utilisateur de projection, ECH-D3) — PAS
-- append-only, JAMAIS mêlée à transactions_cache/balance_history. Reçoit DELETE
-- via la liste blanche de tygr_app.sql (bloc à part de cette migration).
--
-- DEUX étages d'isolation, calqués CARACTÈRE POUR CARACTÈRE sur bank_accounts :
--   • Étage 1 — TENANT (dur) : policy `tenant_isolation` PERMISSIVE FOR ALL
--     (workspace_id). Émise par drizzle-kit (déclarée en schema.ts).
--   • Étage 2 — ENTITÉ (scopé) : policy `entity_scope` AS RESTRICTIVE FOR ALL
--     (USING + WITH CHECK sur app.current_entity_scope). AJOUT MANUEL ci-dessous
--     (drizzle ne l'émet pas — même patron que 0014 sur bank_accounts).
--   • FORCE ROW LEVEL SECURITY : AJOUT MANUEL (drizzle ne l'émet pas — cf.
--     0001/0015). La RLS s'applique AUSSI à l'owner (ceinture + garde-fou C6).
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE "echeances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid,
	"direction" varchar(12) NOT NULL,
	"libelle" varchar(255) NOT NULL,
	"contrepartie" varchar(255),
	"montant" numeric(15, 2) NOT NULL,
	"devise" char(3) NOT NULL,
	"date_echeance" date NOT NULL,
	"statut" varchar(20) DEFAULT 'en_cours' NOT NULL,
	"categorie_id" uuid,
	"recurrence" varchar(12),
	"montant_regle" numeric(15, 2),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "echeances_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "echeances_direction_check" CHECK ("echeances"."direction" IN ('encaissement','decaissement')),
	CONSTRAINT "echeances_statut_check" CHECK ("echeances"."statut" IN ('en_cours','partiel','paiement_en_cours','payee','annulee')),
	CONSTRAINT "echeances_recurrence_check" CHECK ("echeances"."recurrence" IS NULL OR "echeances"."recurrence" IN ('mensuelle','trimestrielle')),
	CONSTRAINT "echeances_montant_positif_check" CHECK ("echeances"."montant" > 0),
	CONSTRAINT "echeances_montant_regle_check" CHECK ("echeances"."montant_regle" IS NULL OR ("echeances"."montant_regle" >= 0 AND "echeances"."montant_regle" <= "echeances"."montant"))
);
--> statement-breakpoint
ALTER TABLE "echeances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "echeances" ADD CONSTRAINT "echeances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "echeances" ADD CONSTRAINT "echeances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "echeances" ADD CONSTRAINT "echeances_entity_workspace_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "public"."entities"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "echeances" ADD CONSTRAINT "echeances_categorie_workspace_fk" FOREIGN KEY ("categorie_id","workspace_id") REFERENCES "public"."categories"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "echeances_workspace_id_idx" ON "echeances" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "echeances_workspace_entity_idx" ON "echeances" USING btree ("workspace_id","entity_id");--> statement-breakpoint
CREATE INDEX "echeances_workspace_date_idx" ON "echeances" USING btree ("workspace_id","date_echeance");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "echeances" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- COMPLÉMENT MANUEL #1 — Étage 2 (entité). Policy `entity_scope` AS RESTRICTIVE
-- FOR ALL, expression copiée CARACTÈRE POUR CARACTÈRE depuis 0014 (bank_accounts).
-- RESTRICTIVE ⇒ se combine en AND avec tenant_isolation (PERMISSIVE). Vision
-- Globale (GUC app.current_entity_scope vide/non posé) ⇒ TRUE ⇒ tout passe
-- (backward-compatible, ingestion entity_id NULL OK). Vision Entité ⇒ borne
-- lecture (USING) ET écriture/déplacement (WITH CHECK) au périmètre CSV d'entités ;
-- une échéance entity_id NULL est INVISIBLE en Vision Entité (fail-closed).
-- ────────────────────────────────────────────────────────────────────────────
CREATE POLICY "entity_scope" ON "echeances" AS RESTRICTIVE FOR ALL TO public
  USING (
    nullif(current_setting('app.current_entity_scope', true), '') IS NULL
    OR (
      entity_id IS NOT NULL
      AND entity_id = ANY (
        string_to_array(current_setting('app.current_entity_scope', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    nullif(current_setting('app.current_entity_scope', true), '') IS NULL
    OR (
      entity_id IS NOT NULL
      AND entity_id = ANY (
        string_to_array(current_setting('app.current_entity_scope', true), ',')::uuid[]
      )
    )
  );--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- COMPLÉMENT MANUEL #2 — FORCE RLS (drizzle-kit ne l'émet pas, cf. 0001/0015).
-- La RLS (tenant + entité) s'applique AUSSI au propriétaire des tables : sans
-- FORCE, un accès sous l'owner court-circuiterait les deux étages.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "echeances" FORCE ROW LEVEL SECURITY;
