-- ═══════════════════════════════════════════════════════════════════
-- Epic 1 — L3.1 : consent_records + audit_events (append-only STRICTS)
-- Plan : PLAN-epic1-auth-consent.md §5.1 (décisions Q1/Q2/Q4)
--
-- Migration ADDITIVE (backward-compatible N-1) : deux CREATE TABLE, la RLS,
-- deux triggers. Le code N-1 ignore ces tables. Aucune fenêtre expand/contract.
--
-- APPEND-ONLY STRICT (CLAUDE.md règle 8) : ni UPDATE ni DELETE, même en
-- migration de réparation — on écrit un événement CORRECTIF. À distinguer de
-- transactions_cache / balance_history (append-only au DELETE seul : l'UPDATE
-- tombstone y reste permis).
--
-- TROIS gardes, aucune ne suffit seule :
--   (1) hors liste blanche DELETE de drizzle/provisioning/tygr_app.sql (étape 5)
--   (2) REVOKE UPDATE, DELETE explicite (même script, étape 6) — le GRANT global
--       de l'étape 3 accorde UPDATE ON ALL TABLES, il faut le RETIRER
--   (3) trigger BEFORE UPDATE OR DELETE ci-dessous : seule défense indépendante
--       du privilège ET du chemin (cascade FK, DELETE direct, même sous l'owner)
--
-- AUCUNE FK vers bank_connections ni users (décision Q2, plan §2.4) : ces deux
-- tables sont ÉDITABLES (liste blanche DELETE). Une FK RESTRICT bloquerait la
-- révocation (L3.3) ; une FK CASCADE tenterait d'effacer l'audit. Les colonnes
-- de snapshot rendent chaque ligne auto-suffisante.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"institution_name" varchar(140),
	"granted_by_user_id" uuid NOT NULL,
	"granted_by_email" varchar(254) NOT NULL,
	"granted_by_name" varchar(120),
	"action" varchar(30) NOT NULL,
	"scope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_records_action_check" CHECK ("consent_records"."action" IN ('GRANTED','ACCOUNTS_SELECTED','REVOKED'))
);--> statement-breakpoint
ALTER TABLE "consent_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"omnifi_event_id" varchar(64),
	"connection_id" uuid,
	"actor_user_id" uuid,
	"hmac_signature_truncated" varchar(8),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_workspace_omnifi_event_unique" UNIQUE("workspace_id","omnifi_event_id")
);--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Seule FK conservée : le tenant ne disparaît jamais sans que TOUT disparaisse.
-- audit_events.workspace_id reste SANS FK (intentionnel, plan §6/P3) : un webhook
-- peut arriver avant résolution du workspace, l'audit doit consigner l'anomalie.
-- La RLS protège de toute façon (elle compare au GUC, pas à une FK).
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Dérivation de l'état courant : dernier événement par connexion.
CREATE INDEX "consent_records_ws_connection_idx" ON "consent_records"
	USING btree ("workspace_id","connection_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- Pagination keyset du panneau d'audit (jamais d'OFFSET).
CREATE INDEX "audit_events_ws_created_idx" ON "audit_events"
	USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- ───────────────────────────────────────────────────────────────────
-- AJOUTS CUSTOM (drizzle-kit ne les émet pas)
-- ───────────────────────────────────────────────────────────────────

-- Étage 1 — TENANT (fail-closed). `current_setting(…, true)` à deux arguments :
-- retourne NULL hors contexte → 0 ligne, jamais d'erreur exploitable.
CREATE POLICY "tenant_isolation" ON "consent_records" AS PERMISSIVE FOR ALL TO public
	USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)
	WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_events" AS PERMISSIVE FOR ALL TO public
	USING (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)
	WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid);--> statement-breakpoint

-- FORCE RLS (même rationale que 0001/0003/0005) : la RLS s'applique AUSSI au
-- propriétaire des tables — ceinture en plus du garde-fou runtime C6.
ALTER TABLE "consent_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- GARDE (3) — APPEND-ONLY STRICT par TRIGGER.
-- La fonction tygr_refuser_mutation_append_only() est créée par la migration
-- 0005 (categorization_audit) : on ne la recrée pas, on l'appelle. Elle lève
-- ERRCODE check_violation avec un message SANS PII (nom de table seulement).
-- C'est la seule défense indépendante du privilège ET du chemin : elle mord sur
-- UPDATE et DELETE, y compris sous l'owner et via une cascade FK.
--
-- ⚠️ PORTÉE EXACTE (ne pas sur-promettre) : un trigger `BEFORE UPDATE OR DELETE`
-- FOR EACH ROW n'est PAS déclenché par `TRUNCATE` (PostgreSQL exige un trigger
-- `BEFORE TRUNCATE ... FOR EACH STATEMENT`, distinct). L'exposition reste nulle
-- au runtime : `tygr_app` n'a NI TRUNCATE, NI DELETE, NI UPDATE sur ces tables
-- (étapes 5 et 6 du provisioning). Seul l'owner peut TRUNCATE — et il peut de
-- toute façon DROP la table : c'est hors modèle de menace, exactement comme pour
-- le trigger 0004 de transactions_cache. Constat de cross-review 2026-07-10.
DROP TRIGGER IF EXISTS "consent_records_no_mutation" ON "consent_records";--> statement-breakpoint
CREATE TRIGGER "consent_records_no_mutation" BEFORE UPDATE OR DELETE ON "consent_records"
	FOR EACH ROW EXECUTE FUNCTION tygr_refuser_mutation_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_events_no_mutation" ON "audit_events";--> statement-breakpoint
CREATE TRIGGER "audit_events_no_mutation" BEFORE UPDATE OR DELETE ON "audit_events"
	FOR EACH ROW EXECUTE FUNCTION tygr_refuser_mutation_append_only();
