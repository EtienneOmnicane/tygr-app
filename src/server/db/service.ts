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
import { sql } from "drizzle-orm";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";

import type { AnyPgDatabase, WorkspaceTx } from "@/server/db/tenancy";

import * as schema from "./schema";

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
