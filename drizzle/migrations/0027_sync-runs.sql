-- ════════════════════════════════════════════════════════════════════════════
-- Lot W2 (filet pull) — table NEUVE `sync_runs` (observabilité, cahier §4.1,
-- PLAN-ingestion-webhook-omnifi.md §4.3, version MINIMALE).
--
-- Leçon sync-fail-soft : sans trace en base, un cron qui échoue en silence est
-- invisible en prod. Table NORMALE (UPDATE de progression RUNNING → terminal),
-- PAS financière, PAS append-only ; AUCUN DELETE applicatif (hors liste blanche
-- tygr_app.sql) — la seule suppression est la CASCADE de la déconnexion d'une
-- banque. RLS TENANT uniquement (pattern echeances/0019), PAS d'étage 2 : la
-- granularité est la CONNEXION, non scopée entité — même visibilité que
-- bank_connections. FORCE RLS en complément manuel (drizzle ne l'émet pas).
--
-- Pré-requis : UNIQUE (id, workspace_id) sur bank_connections — cible de la FK
-- COMPOSITE scopée workspace (pattern categories/entities). Trivialement
-- satisfaite (id est PK) : ajout non bloquant, aucune réécriture de lignes.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_id_workspace_unique" UNIQUE("id","workspace_id");--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger_source" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'RUNNING' NOT NULL,
	"comptes_traites" integer DEFAULT 0 NOT NULL,
	"transactions_upsertees" integer DEFAULT 0 NOT NULL,
	"erreur_code" varchar(60),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "sync_runs_trigger_check" CHECK ("sync_runs"."trigger_source" IN ('CRON','WEBHOOK','MANUAL')),
	CONSTRAINT "sync_runs_status_check" CHECK ("sync_runs"."status" IN ('RUNNING','COMPLETED','PARTIAL','FAILED','MFA_REQUIRED')),
	CONSTRAINT "sync_runs_finished_coherence_check" CHECK (("sync_runs"."status" = 'RUNNING') = ("sync_runs"."finished_at" IS NULL))
);--> statement-breakpoint
ALTER TABLE "sync_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_workspace_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."bank_connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_workspace_id_idx" ON "sync_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sync_runs_workspace_connection_started_idx" ON "sync_runs" USING btree ("workspace_id","connection_id","started_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sync_runs" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- COMPLÉMENT MANUEL — FORCE RLS (drizzle-kit ne l'émet pas, cf. 0001/0019).
-- La RLS tenant s'applique AUSSI au propriétaire : sans FORCE, un accès sous
-- l'owner court-circuiterait l'isolation (garde-fou C6 inopérant).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "sync_runs" FORCE ROW LEVEL SECURITY;
