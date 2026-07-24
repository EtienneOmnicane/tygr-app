/**
 * Client Inngest de TYGR — socle du chantier ingestion (lot W1,
 * PLAN-ingestion-webhook-omnifi.md §6/§9, décisions D1=C actées 2026-07-17).
 *
 * Dépendance `inngest@4.13.0` (règle 9) : Layer 1 éprouvé — SDK officiel
 * Inngest, prévu par le stack CLAUDE.md et le cahier des charges (§1, §3.ter),
 * standard des jobs durables Next.js. PIN EXACT (pas de caret) :
 * l'orchestration durable est un parcours critique, chaque bump se re-valide.
 * Audit npm à l'ajout : aucune vulnérabilité introduite par son arbre (les 8
 * remontées préexistent via esbuild/postcss, devDependencies).
 *
 * Configuration par variables d'environnement, lues NATIVEMENT par le SDK :
 *   - INNGEST_EVENT_KEY   : autorise `inngest.send()` (émission d'événements).
 *   - INNGEST_SIGNING_KEY : authentifie les appels du serveur Inngest vers
 *     /api/inngest (signature vérifiée par `serve`) — c'est L'AUTH de la
 *     route, qui est volontairement hors session (cf. src/proxy.ts).
 *   - Dev local : les deux absentes + `npx inngest-cli@latest dev` (dashboard
 *     http://localhost:8288). Sans dev server, l'émission échoue proprement —
 *     les émetteurs sont fail-soft (cf. emission.ts).
 * Jamais de clé en dur ni en fixture (règle 8).
 *
 * Les événements sont définis par `eventType(name, { schema })` (SDK v4,
 * Standard Schema) : le schéma zod est LA source unique du typage (triggers,
 * `event.data` des handlers) ET de la validation à l'émission
 * (`create().validate()`). Les handlers RE-valident à la réception (défense en
 * profondeur : un événement peut être forgé depuis le dashboard Inngest).
 */
import { eventType, Inngest } from "inngest";
import { z } from "zod";

/**
 * Déclencheurs d'une demande d'ingestion — la CONVERGENCE D1=C : cron (W2),
 * clic manuel (relais W1) et webhook (W4) émettent le MÊME événement vers le
 * MÊME worker. Pas de logique dupliquée ; la panne d'un canal n'affame pas
 * le produit.
 */
export const declencheursSync = ["MANUAL", "CRON", "WEBHOOK"] as const;
export type DeclencheurSync = (typeof declencheursSync)[number];

/**
 * Données de `omnifi/sync.ingest.requested` (plan §6.2).
 *
 * `omnifiConnectionId` = identifiant AMONT de la connexion (et non l'id interne
 * TYGR) : c'est le dénominateur commun des trois émetteurs — le relais manuel
 * le tient de `GET /connections`, le webhook (W4) de son payload, le cron (W2)
 * de `bank_connections`. La résolution vers l'id interne se fait DANS le job,
 * sous la RLS du `workspaceId` porté par l'événement (fail-closed : une
 * connexion hors de ce workspace résout à zéro ligne, jamais routée).
 *
 * `workspaceId` vient TOUJOURS d'une résolution serveur (session de l'action
 * émettrice, itération de cron, résolution tygr_service du webhook) — jamais
 * d'un client.
 *
 * `omnifiJobId` : job de scraping amont DÉJÀ déclenché, à attendre (relais
 * manuel W1 — le job qui courait encore au plafond des 120 s de la Server
 * Action). Absent → le worker déclenche lui-même (chemin cron W2), gardé par
 * le cooldown amont.
 *
 * `omnifiEventId` : EventId du webhook amont (W4) — porté dès W1 dans le
 * contrat pour que le webhook n'ait RIEN à changer au worker. Observabilité ;
 * la dédup PERMANENTE (par tenant) vit dans `audit_events` (§6.2, étage 2).
 *
 * `cleIdempotence` (lot W4, D2) : clé d'idempotence Inngest — TOUJOURS présente
 * (un champ requis, jamais partagé à vide qui dédupliquerait à tort). Elle rend
 * « rejeu ×5 → 1 seul RUN » STRUCTUREL (§6.2, étage 3) via
 * `idempotency: "event.data.cleIdempotence"` sur le worker (fenêtre SDK 24 h —
 * vérifiée doc Inngest ; d'où une fenêtre de fraîcheur webhook ≤ 12 h, §3.4/§6.1).
 * Convention par émetteur, pour que deux événements DISTINCTS ne collisionnent
 * jamais :
 *   - webhook → `wh:${EventId}`                 (l'EventId amont est unique)
 *   - cron    → `cron:${workspaceId}:${omnifiConnectionId}:${dateDuRun}` (W2 —
 *               SCOPÉE TENANT : omnifi_connection_id n'est pas garanti unique
 *               entre workspaces, hypothèse abandonnée à l'EXPAND 0018)
 *   - manuel  → `man:${crypto.randomUUID()}`     (jamais dédupliqué — chaque clic
 *                                                 est une intention distincte)
 */
export const donneesSyncIngestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    omnifiConnectionId: z.string().trim().min(1).max(64),
    declencheur: z.enum(declencheursSync),
    omnifiJobId: z.string().trim().min(1).max(64).optional(),
    omnifiEventId: z.string().trim().min(1).max(64).optional(),
    cleIdempotence: z.string().trim().min(1).max(120),
  })
  .strict();

export type DonneesSyncIngest = z.infer<typeof donneesSyncIngestSchema>;

/** Healthcheck du socle (plan §9 W1) : prouve émission → exécution, sans I/O. */
export const evenementHealthcheck = eventType("tygr/healthcheck.requested", {
  schema: z
    .object({ motif: z.string().trim().min(1).max(120).optional() })
    .strict(),
});

/** LE déclencheur convergent du worker de synchronisation (plan §6.2). */
export const evenementSyncIngest = eventType("omnifi/sync.ingest.requested", {
  schema: donneesSyncIngestSchema,
});

/**
 * Client unique de l'app (id "tygr") — consommé par la route /api/inngest
 * (exécution) et les émetteurs (send).
 */
export const inngest = new Inngest({ id: "tygr" });
