/**
 * Client DB de SERVICE — rôle `tygr_service` (lot W3, DATABASE_URL_SERVICE).
 * Spec : docs/specs/PLAN-webhook-ingestion.md §5.2 / §7.4.
 *
 * L'UNIQUE exception documentée à « tout accès données passe par withWorkspace »
 * (CLAUDE.md règle 2) : la résolution `omnifi_connection_id → workspace_id` d'un
 * webhook amont, qui est CROSS-TENANT par nature (on cherche À QUI est l'événement,
 * avant de connaître le tenant). On la confine par le PRIVILÈGE, pas par la RLS :
 *   - rôle `tygr_service` au périmètre GELÉ : GRANT SELECT sur 3 colonnes non métier
 *     de `bank_connections` (id, omnifi_connection_id, workspace_id) + policy
 *     `webhook_resolution` FOR SELECT (provisioning) — rien d'autre, jamais ;
 *   - JAMAIS `BYPASSRLS` ; jamais d'accès à `workspaces`/`transactions_cache`/… ;
 *   - garde runtime `exigerRoleService` miroir de C6 (fail-closed).
 *
 * ⚠️ FRONTIÈRE (eslint FRONTIERE_SERVICE) : importable UNIQUEMENT par
 * `src/server/webhooks/omnifi/**`. Toute autre surface qui l'importe échoue au lint.
 *
 * La DÉCISION sur le nombre de lignes (0 / 1 / ≥2) est une fonction PURE et testée
 * ailleurs (`src/server/webhooks/omnifi/resolution.ts`) — ce module ne fait que la
 * requête bornée.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";

import type { AnyPgDatabase, WorkspaceTx } from "@/server/db/tenancy";

import * as schema from "./schema";
import type { WebhookMotif } from "./schema";

// Câblage neonConfig — RÉPLIQUÉ de src/server/db/index.ts (config GLOBALE et
// idempotente du driver). service.ts doit fonctionner même si index.ts n'a pas été
// chargé le premier. E16 : WebSocket + vraies transactions (SET LOCAL exige du
// multi-statements sur une même connexion), JAMAIS le mode HTTP.
if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}
// DEV LOCAL uniquement (jamais en prod) — même wsproxy que l'app.
if (process.env.NEON_WSPROXY_LOCAL) {
  const proxy = process.env.NEON_WSPROXY_LOCAL;
  neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

/**
 * Rôle de service inattendu — miroir de C6 (`UnsafeDatabaseRoleError`). Fail-closed :
 * si `DATABASE_URL_SERVICE` ne pointe PAS `tygr_service` (owner, tygr_app, autre), on
 * REFUSE de servir plutôt que d'exécuter la résolution cross-tenant sous un rôle trop
 * puissant (l'owner contournerait la policy column-level ; tygr_app ne verrait rien).
 * Erreur de CONFIGURATION serveur, jamais déclenchable par un client → mappée 500.
 */
export class RoleServiceInattenduError extends Error {
  readonly code = "ROLE_SERVICE_INATTENDU";
  constructor(role: string) {
    super(
      `Connexion de service sous un rôle inattendu (${role} ≠ tygr_service) : la ` +
        `résolution webhook exige le rôle au périmètre gelé (3 colonnes). Vérifier ` +
        `DATABASE_URL_SERVICE (voir drizzle/provisioning/tygr_app.sql). Requête ` +
        `refusée (fail-closed).`,
    );
    this.name = "RoleServiceInattenduError";
  }
}

/** `DATABASE_URL_SERVICE` absente — configuration serveur (500), jamais un client. */
export class ServiceUrlManquanteError extends Error {
  readonly code = "SERVICE_URL_MANQUANTE";
  constructor() {
    super(
      "DATABASE_URL_SERVICE manquante — voir .env.example (chaîne poolée Neon, rôle tygr_service).",
    );
    this.name = "ServiceUrlManquanteError";
  }
}

type DbService = NeonDatabase<typeof schema>;

function paresseux<T>(creer: () => T): () => T {
  let instance: T | undefined;
  return () => (instance ??= creer());
}

/** Singleton de connexion de service — créé au premier usage (jamais à l'import). */
const obtenirServiceDb = paresseux<DbService>(() => {
  const url = process.env.DATABASE_URL_SERVICE;
  if (!url) throw new ServiceUrlManquanteError();
  const pool = new Pool({ connectionString: url });
  return drizzle(pool, { schema });
});

/**
 * Garde runtime miroir de C6 (fail-closed) : la connexion de service DOIT tourner
 * sous `tygr_service`. `current_user` ≠ tygr_service → refus bruyant. On lève AVANT
 * toute lecture : jamais de résolution cross-tenant sous un rôle non prévu.
 */
async function exigerRoleService<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
): Promise<void> {
  const res = await tx.execute(sql`select current_user as who`);
  const who = (res as unknown as { rows: { who: string }[] }).rows[0]?.who;
  if (who !== "tygr_service") {
    throw new RoleServiceInattenduError(who ?? "inconnu");
  }
}

/** Une ligne de résolution — les 3 colonnes GELÉES du périmètre (§5.2). */
export interface LigneConnexionResolue {
  id: string;
  omnifiConnectionId: string;
  workspaceId: string;
}

/**
 * Factory (patron `createWithWorkspace`) : injecte la base pour les tests. La requête
 * est PARAMÉTRÉE (`${omnifiConnectionId}` lié, zéro interpolation — règle 2) et bornée
 * à **`LIMIT 2`, jamais 1** : détecter la MULTIPLICITÉ est le but (une connexion
 * dupliquée cross-tenant après le CONTRACT ⇒ AMBIGUE, jamais un choix arbitraire).
 * Le garde runtime tourne DANS la même transaction que la requête (même connexion).
 */
export function createResoudreConnexion<TDb extends AnyPgDatabase>(db: TDb) {
  return async function resoudreConnexionParId(
    omnifiConnectionId: string,
  ): Promise<LigneConnexionResolue[]> {
    return db.transaction(async (tx) => {
      await exigerRoleService<TDb>(tx as WorkspaceTx<TDb>);
      const res = await tx.execute(sql`
        select id,
               omnifi_connection_id as "omnifiConnectionId",
               workspace_id as "workspaceId"
        from bank_connections
        where omnifi_connection_id = ${omnifiConnectionId}
        limit 2
      `);
      return (res as unknown as { rows: LigneConnexionResolue[] }).rows;
    });
  };
}

/** Instance applicative — connexion `tygr_service` réelle (Neon), résolue paresseusement. */
export function resoudreConnexionParId(
  omnifiConnectionId: string,
): Promise<LigneConnexionResolue[]> {
  return createResoudreConnexion(obtenirServiceDb())(omnifiConnectionId);
}

/** Événement à mettre en QUARANTAINE (webhook_events_pending) — écrit sous tygr_service
 *  (tygr_app n'a AUCUN accès à cette table : REVOKE + RLS). */
export interface EvenementQuarantaine {
  omnifiEventId: string;
  omnifiConnectionId: string;
  eventType: string;
  omnifiJobId?: string | null;
  omnifiEnvironment: "sandbox" | "production";
  motif: WebhookMotif;
  /** Body validé zod (identifiants techniques amont) — jamais loggé, jamais dans audit_events. */
  payload: Record<string, unknown>;
}

/**
 * INSÈRE un événement non résolu en quarantaine, sous `tygr_service`, avec dédup
 * `ON CONFLICT (omnifi_event_id) DO NOTHING` (un rejeu du même EventId ne crée pas de
 * doublon). Rend `{ insere }`. Garde runtime `exigerRoleService` DANS la transaction.
 * Table système NON append-only : le rejeu (W5) et la purge TTL sont des UPDATE/DELETE
 * légitimes, réservés à tygr_service.
 */
export function createInsererQuarantaine<TDb extends AnyPgDatabase>(db: TDb) {
  return async function insererQuarantaine(
    evt: EvenementQuarantaine,
  ): Promise<{ insere: boolean }> {
    return db.transaction(async (tx) => {
      await exigerRoleService<TDb>(tx as WorkspaceTx<TDb>);
      const lignes = await (tx as WorkspaceTx<TDb>)
        .insert(schema.webhookEventsPending)
        .values({
          omnifiEventId: evt.omnifiEventId,
          omnifiConnectionId: evt.omnifiConnectionId,
          eventType: evt.eventType,
          omnifiJobId: evt.omnifiJobId ?? null,
          omnifiEnvironment: evt.omnifiEnvironment,
          motif: evt.motif,
          payload: evt.payload,
        })
        .onConflictDoNothing({ target: schema.webhookEventsPending.omnifiEventId })
        .returning({ id: schema.webhookEventsPending.id });
      return { insere: lignes.length > 0 };
    });
  };
}

/** Instance applicative — quarantaine sous `tygr_service` réel. */
export function insererQuarantaine(
  evt: EvenementQuarantaine,
): Promise<{ insere: boolean }> {
  return createInsererQuarantaine(obtenirServiceDb())(evt);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Rejeu de la quarantaine (lot W5) — primitives DB sous tygr_service.
 * Table système NON append-only : UPDATE (marquage/compteur) et DELETE (purge
 * TTL) sont LÉGITIMES ici, et réservés à tygr_service (REVOKE + RLS pour
 * tygr_app). La LOGIQUE de rejeu (pipeline complet, plafond, logs) vit dans
 * `src/server/webhooks/omnifi/rejeu.ts` — ce module ne fait que les requêtes.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Un événement EN ATTENTE de rejeu — projection stable (sérialisable par un
 *  step Inngest : pas de Date, uniquement des scalaires). */
export interface LigneQuarantaineEnAttente {
  id: string;
  omnifiEventId: string;
  omnifiConnectionId: string;
  eventType: string;
  omnifiJobId: string | null;
  /** Motif de la MISE en quarantaine (état à la réception — le rejeu peut en
   *  constater un autre, journalisé sans réécrire celui-ci). */
  motif: WebhookMotif;
  /** Nombre de rejeux INFRUCTUEUX déjà tentés (cf. enregistrerEchecRejeu). */
  replayCount: number;
}

/**
 * Liste les événements en attente de rejeu : `replayed_at IS NULL` ET sous le
 * plafond anti-boucle. Optionnellement bornée à une connexion (chemin
 * link-exchange) ; toujours bornée en taille (`limite`) — l'appelant journalise
 * la troncature (no silent caps). Ordre FIFO (`received_at`) : les plus anciens
 * d'abord, pour qu'aucun événement ne soit affamé par les arrivées récentes.
 */
export function createListerQuarantaineEnAttente<TDb extends AnyPgDatabase>(
  db: TDb,
) {
  return async function listerQuarantaineEnAttente(filtre: {
    omnifiConnectionId?: string;
    plafondRejeux: number;
    limite: number;
  }): Promise<LigneQuarantaineEnAttente[]> {
    return db.transaction(async (tx) => {
      await exigerRoleService<TDb>(tx as WorkspaceTx<TDb>);
      const conditions = [
        isNull(schema.webhookEventsPending.replayedAt),
        lt(schema.webhookEventsPending.replayCount, filtre.plafondRejeux),
      ];
      if (filtre.omnifiConnectionId) {
        conditions.push(
          eq(
            schema.webhookEventsPending.omnifiConnectionId,
            filtre.omnifiConnectionId,
          ),
        );
      }
      const lignes = await (tx as WorkspaceTx<TDb>)
        .select({
          id: schema.webhookEventsPending.id,
          omnifiEventId: schema.webhookEventsPending.omnifiEventId,
          omnifiConnectionId: schema.webhookEventsPending.omnifiConnectionId,
          eventType: schema.webhookEventsPending.eventType,
          omnifiJobId: schema.webhookEventsPending.omnifiJobId,
          motif: schema.webhookEventsPending.motif,
          replayCount: schema.webhookEventsPending.replayCount,
        })
        .from(schema.webhookEventsPending)
        .where(and(...conditions))
        .orderBy(asc(schema.webhookEventsPending.receivedAt))
        .limit(filtre.limite);
      return lignes.map((l) => ({ ...l, motif: l.motif as WebhookMotif }));
    });
  };
}

/** Instance applicative — listing sous `tygr_service` réel. */
export function listerQuarantaineEnAttente(filtre: {
  omnifiConnectionId?: string;
  plafondRejeux: number;
  limite: number;
}): Promise<LigneQuarantaineEnAttente[]> {
  return createListerQuarantaineEnAttente(obtenirServiceDb())(filtre);
}

/**
 * Marque un événement REJOUÉ (livré au pipeline : audité, enqueue fait si dû).
 * `replayed_at` non-NULL le sort définitivement du balayage. Idempotent (un
 * second marquage réécrit l'horodatage, sans effet sur la sortie du balayage).
 */
export function createMarquerQuarantaineRejouee<TDb extends AnyPgDatabase>(
  db: TDb,
) {
  return async function marquerQuarantaineRejouee(id: string): Promise<void> {
    return db.transaction(async (tx) => {
      await exigerRoleService<TDb>(tx as WorkspaceTx<TDb>);
      await (tx as WorkspaceTx<TDb>)
        .update(schema.webhookEventsPending)
        .set({ replayedAt: sql`now()` })
        .where(eq(schema.webhookEventsPending.id, id));
    });
  };
}

/** Instance applicative — marquage sous `tygr_service` réel. */
export function marquerQuarantaineRejouee(id: string): Promise<void> {
  return createMarquerQuarantaineRejouee(obtenirServiceDb())(id);
}

/**
 * Enregistre un rejeu INFRUCTUEUX (l'événement reste non résolu : connexion
 * toujours inconnue, ambiguïté, env mismatch) : incrémente `replay_count` et
 * rend le total — l'appelant compare au plafond et journalise. Un échec
 * d'INFRASTRUCTURE (enqueue/audit qui lève) ne passe PAS par ici : il fait
 * échouer le step Inngest, qui retente — le plafond ne compte que les
 * constats « toujours pas résolvable ».
 */
export function createEnregistrerEchecRejeu<TDb extends AnyPgDatabase>(db: TDb) {
  return async function enregistrerEchecRejeu(
    id: string,
  ): Promise<{ tentatives: number }> {
    return db.transaction(async (tx) => {
      await exigerRoleService<TDb>(tx as WorkspaceTx<TDb>);
      const lignes = await (tx as WorkspaceTx<TDb>)
        .update(schema.webhookEventsPending)
        .set({
          replayCount: sql`${schema.webhookEventsPending.replayCount} + 1`,
        })
        .where(eq(schema.webhookEventsPending.id, id))
        .returning({ tentatives: schema.webhookEventsPending.replayCount });
      return { tentatives: lignes[0]?.tentatives ?? 0 };
    });
  };
}

/** Instance applicative — compteur d'échec sous `tygr_service` réel. */
export function enregistrerEchecRejeu(
  id: string,
): Promise<{ tentatives: number }> {
  return createEnregistrerEchecRejeu(obtenirServiceDb())(id);
}

/** Une ligne purgée (TTL) — rendue à l'appelant pour le LOG D'ABANDON explicite
 *  (identifiants techniques amont uniquement, zéro PII). */
export interface LigneQuarantainePurgee {
  omnifiEventId: string;
  omnifiConnectionId: string;
  eventType: string;
  motif: WebhookMotif;
  replayCount: number;
  /** true = jamais rejouée avec succès : c'est un ABANDON, à journaliser. */
  abandonnee: boolean;
}

/**
 * Purge TTL : DELETE des lignes plus vieilles que `seuil` (rejouées OU non).
 * Rend TOUTES les lignes supprimées — l'appelant journalise chaque abandon
 * (`abandonnee: true`), jamais de suppression silencieuse. Le DELETE physique
 * est légitime ICI et seulement ici (table système, non financière, non
 * append-only — cf. migration 0026).
 */
export function createPurgerQuarantaineExpiree<TDb extends AnyPgDatabase>(
  db: TDb,
) {
  return async function purgerQuarantaineExpiree(
    seuil: Date,
  ): Promise<LigneQuarantainePurgee[]> {
    return db.transaction(async (tx) => {
      await exigerRoleService<TDb>(tx as WorkspaceTx<TDb>);
      const lignes = await (tx as WorkspaceTx<TDb>)
        .delete(schema.webhookEventsPending)
        .where(lt(schema.webhookEventsPending.receivedAt, seuil))
        .returning({
          omnifiEventId: schema.webhookEventsPending.omnifiEventId,
          omnifiConnectionId: schema.webhookEventsPending.omnifiConnectionId,
          eventType: schema.webhookEventsPending.eventType,
          motif: schema.webhookEventsPending.motif,
          replayCount: schema.webhookEventsPending.replayCount,
          replayedAt: schema.webhookEventsPending.replayedAt,
        });
      return lignes.map((l) => ({
        omnifiEventId: l.omnifiEventId,
        omnifiConnectionId: l.omnifiConnectionId,
        eventType: l.eventType,
        motif: l.motif as WebhookMotif,
        replayCount: l.replayCount,
        abandonnee: l.replayedAt === null,
      }));
    });
  };
}

/** Instance applicative — purge sous `tygr_service` réel. */
export function purgerQuarantaineExpiree(
  seuil: Date,
): Promise<LigneQuarantainePurgee[]> {
  return createPurgerQuarantaineExpiree(obtenirServiceDb())(seuil);
}
