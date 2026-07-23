-- ═══════════════════════════════════════════════════════════════════
-- Webhook Omni-FI (lot W4) — table de QUARANTAINE `webhook_events_pending`
-- Plan : docs/specs/PLAN-webhook-ingestion.md §7.1 / §7.2
--
-- ⚠️ NUMÉRO 0026 (et NON 0025 comme l'écrivait le plan §7.1/§12). 0024 est la
-- dernière migration existante ; 0025 est RÉSERVÉE au chantier treso-eod (branche
-- concurrente). Écart au plan assumé et tracé dans TODOS.md (WEBHOOK-W4).
--
-- Table SYSTÈME, NON financière, NON append-only : le DELETE de purge (TTL 30 j,
-- lot W5) est légitime. PAS de `workspace_id` (le tenant est INCONNU par
-- définition — un webhook peut arriver avant `link-exchange`) ⇒ PAS de policy
-- TENANT. L'isolation repose sur DEUX gardes complémentaires posées dans le
-- PROVISIONING (drizzle/provisioning/tygr_app.sql), car une migration ne peut PAS
-- référencer le rôle `tygr_service` (créé par le provisioning, qui tourne APRÈS
-- `migrate`) : (1) REVOKE ALL … FROM tygr_app ; (2) policy FOR ALL TO tygr_service.
-- Ici : ENABLE + FORCE RLS = deny-all par défaut (aucune policy ⇒ 0 ligne, owner
-- compris), fail-closed tant que le provisioning n'a pas posé la policy service.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE "webhook_events_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"omnifi_event_id" varchar(64) NOT NULL,
	"omnifi_connection_id" varchar(64) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"omnifi_job_id" varchar(64),
	"omnifi_environment" varchar(10) NOT NULL,
	"motif" varchar(30) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_at" timestamp with time zone,
	"replay_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "webhook_events_pending_omnifi_event_id_unique" UNIQUE("omnifi_event_id"),
	CONSTRAINT "webhook_events_pending_env_check" CHECK ("webhook_events_pending"."omnifi_environment" IN ('sandbox','production')),
	CONSTRAINT "webhook_events_pending_motif_check" CHECK ("webhook_events_pending"."motif" IN ('CONNEXION_INCONNUE','AMBIGUE','ENV_MISMATCH'))
);--> statement-breakpoint
CREATE INDEX "webhook_events_pending_connection_idx" ON "webhook_events_pending" USING btree ("omnifi_connection_id");--> statement-breakpoint
-- Balayage du rejeu (W5) : les événements EN ATTENTE (replayed_at IS NULL).
CREATE INDEX "webhook_events_pending_replay_idx" ON "webhook_events_pending" USING btree ("replayed_at");--> statement-breakpoint

-- ───────────────────────────────────────────────────────────────────
-- AJOUTS CUSTOM (drizzle-kit ne les émet pas) — RLS.
-- ENABLE + FORCE : deny-all tant qu'aucune policy ne s'applique. La policy
-- `webhook_pending_service` (FOR ALL TO tygr_service) ET le `REVOKE ALL … FROM
-- tygr_app` vivent dans le provisioning (le rôle tygr_service n'existe pas encore
-- au `migrate`). FORCE (même rationale que 0001/0003/0021) : la RLS s'applique
-- AUSSI à l'owner — une réparation de données exige un `SET ROLE tygr_service`
-- explicite. C'est voulu et cohérent avec les tables append-only.
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE "webhook_events_pending" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_events_pending" FORCE ROW LEVEL SECURITY;
