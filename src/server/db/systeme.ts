/**
 * executerPourWorkspaceSysteme(workspaceId) — primitive SYSTÈME d'accès aux
 * données (lot W1, PLAN-ingestion-webhook-omnifi.md §6.1, décision D1=C).
 *
 * Variante de `withWorkspace` pour les chemins SANS session utilisateur : les
 * fonctions Inngest (job de sync durable) aujourd'hui, le cron (W2) et la route
 * webhook (W4) demain. Contrat, comparé à `withWorkspace` :
 *   - transaction sous `tygr_app` + garde owner C6 CONSERVÉE (fail-closed) ;
 *   - `set_config('app.current_workspace_id', …, true)` posé → la RLS tenant
 *     borne TOUT ce que fait `fn` à CE workspace ;
 *   - PAS de `app.current_user_id`, PAS de re-validation de membership : il n'y
 *     a pas d'utilisateur ;
 *   - AUCUN GUC d'étage 2 (entity_scope / account_scope / view_filter) : Vision
 *     Globale — exactement le mode dans lequel l'ingestion tourne déjà
 *     (ENTITY-WRITE-SCOPE1 ; l'invariant `entity_id NULL jamais écrasé` est
 *     porté par les upserts, inchangé).
 *
 * ⚠️ SURFACE SENSIBLE (le point le plus sensible du chantier avec le HMAC) :
 * cette primitive CONTOURNE la membership. Le `workspaceId` accepté doit venir
 * d'une résolution SERVEUR (session d'une Server Action émettrice, itération de
 * cron, résolution `tygr_service` du webhook) — JAMAIS d'un client. Gardes :
 *   1. Frontière ESLint (eslint.config.mjs, FRONTIERE_SYSTEME) : ce module est
 *      importable UNIQUEMENT par `src/server/inngest/**`. Une Server Action ou
 *      un composant qui l'importe échoue au lint (règle 5, bloquant).
 *   2. `workspaceId` validé `z.string().uuid()` et journalisé à CHAQUE
 *      transaction (`systeme_workspace_execution`).
 *   3. Le contexte fourni à `fn` porte un utilisateur SENTINELLE (UUID nul,
 *      cf. ci-dessous) : toute écriture accidentelle de `ctx.userId` vers une
 *      FK `users` échoue bruyamment (fail-closed) au lieu d'imputer l'action à
 *      un humain. Aucun repository du chemin d'ingestion ne persiste
 *      `ctx.userId` (seul `upsertConnexion` le fait — jamais appelé par un job
 *      système : la connexion existe déjà, créée par le widget sous session).
 *
 * La cross-review des lots W2/W3 (plan §8.7) a mandat explicite de chercher une
 * fuite de cette primitive vers une surface utilisateur.
 */
import { z } from "zod";

import { obtenirDb } from "@/server/db";
import {
  exigerRoleNonProprietaire,
  type AnyPgDatabase,
  type ExecuterWorkspace,
  type WorkspaceContext,
  type WorkspaceTx,
} from "@/server/db/tenancy";
import { sql } from "drizzle-orm";

/** `workspaceId` non-UUID : erreur de programmation de l'émetteur (500, jamais client). */
export class WorkspaceSystemeInvalideError extends Error {
  readonly code = "WORKSPACE_SYSTEME_INVALIDE";
  constructor() {
    super("workspaceId système invalide (UUID attendu)");
    this.name = "WorkspaceSystemeInvalideError";
  }
}

/**
 * Utilisateur SENTINELLE des contextes système — l'UUID nul, comme
 * SENTINELLE_PERIMETRE_VIDE (tenancy) : ne matche JAMAIS un `users.id` réel
 * (gen_random_uuid() ne le produit pas). Un chemin qui tenterait de le
 * persister en FK vers `users` échoue à la contrainte — c'est voulu : un acte
 * système ne s'impute pas à un utilisateur.
 */
export const SENTINELLE_UTILISATEUR_SYSTEME =
  "00000000-0000-0000-0000-000000000000";

/**
 * Rôle du contexte système : MANAGER (moindre privilège qui passe
 * `peutModifier`, ce que le chemin d'ingestion exige). PAS "ADMIN" : aucun
 * chemin système n'administre (membres, scopes) ; si un futur job en avait
 * besoin, l'élévation serait une décision explicite, pas un défaut.
 */
const ROLE_SYSTEME = "MANAGER" as const;

const workspaceIdSchema = z.string().uuid();

/**
 * Factory (pattern `createWithWorkspace`) : injecte la base pour les tests
 * (PGlite) sans dupliquer le contrat. L'instance applicative est
 * `executerPourWorkspaceSysteme` ci-dessous.
 */
export function createExecuterSysteme<TDb extends AnyPgDatabase>(db: TDb) {
  return function executerPourWorkspaceSysteme(
    workspaceId: string,
  ): ExecuterWorkspace {
    const parsed = workspaceIdSchema.safeParse(workspaceId);
    if (!parsed.success) {
      throw new WorkspaceSystemeInvalideError();
    }
    const wsId = parsed.data;

    const ctx: WorkspaceContext = {
      role: ROLE_SYSTEME,
      workspaceId: wsId,
      userId: SENTINELLE_UTILISATEUR_SYSTEME,
      entityScope: { mode: "GLOBALE" },
      accountScope: { mode: "GLOBALE" },
    };

    return async function executer<T>(
      fn: (
        tx: WorkspaceTx<AnyPgDatabase>,
        ctxFn: WorkspaceContext,
      ) => Promise<T>,
    ): Promise<T> {
      // Journal par TRANSACTION (pas par fabrication du wrapper) : c'est
      // l'exécution qui est l'acte sensible. Identifiant opaque seul, pas de PII.
      console.info(
        JSON.stringify({
          evt: "systeme_workspace_execution",
          workspaceId: wsId,
        }),
      );
      return db.transaction(async (tx) => {
        await exigerRoleNonProprietaire<TDb>(tx);
        await tx.execute(
          sql`select set_config('app.current_workspace_id', ${wsId}, true)`,
        );
        // Ni app.current_user_id, ni GUC d'étage 2 : cf. contrat en tête.
        return fn(tx as WorkspaceTx<AnyPgDatabase>, ctx);
      });
    };
  };
}

/** Instance applicative — base réelle (Neon), résolue paresseusement. */
export function executerPourWorkspaceSysteme(
  workspaceId: string,
): ExecuterWorkspace {
  return createExecuterSysteme(obtenirDb())(workspaceId);
}

/* ------------------------------------------------------------------ */
/* Énumération SYSTÈME des workspaces (lot W2 — cron filet pull).      */
/* ------------------------------------------------------------------ */

/**
 * Liste les `id` des workspaces d'un environnement Omni-FI — l'ITÉRATEUR du
 * cron quotidien (W2) : chaque id alimente ensuite
 * `executerPourWorkspaceSysteme(id)` pour lister SES connexions sous RLS.
 *
 * Pourquoi cette lecture est légitime ICI (et seulement ici) :
 *  - `workspaces` n'a PAS de RLS (fait §1.4 du plan W3-W5) : la lecture sous
 *    `tygr_app` fonctionne sans GUC — aucun privilège nouveau, aucun rôle
 *    élargi (PAS `tygr_service`, dont l'usage reste GELÉ à la résolution
 *    webhook — CLAUDE.md règle 2, liste fermée).
 *  - Périmètre MINIMAL : `id` seul, filtré par `omnifi_environment` — un
 *    déploiement sandbox n'itère JAMAIS les workspaces production (même
 *    cloison que le cross-check env du webhook).
 *  - Ce module est borné par FRONTIERE_SYSTEME (eslint) : importable
 *    uniquement par les fonctions Inngest et la route webhook — une Server
 *    Action ne peut pas s'en servir pour énumérer les tenants.
 */
export function createListerWorkspacesSysteme<TDb extends AnyPgDatabase>(
  db: TDb,
) {
  return async function listerWorkspacesParEnvironnement(
    environnement: "sandbox" | "production",
  ): Promise<{ id: string }[]> {
    return db.transaction(async (tx) => {
      await exigerRoleNonProprietaire<TDb>(tx);
      const res = await tx.execute(
        sql`select id from workspaces where omnifi_environment = ${environnement} order by created_at`,
      );
      const lignes = (res as unknown as { rows: { id: string }[] }).rows;
      console.info(
        JSON.stringify({
          evt: "systeme_workspaces_enumeration",
          environnement,
          total: lignes.length,
        }),
      );
      return lignes;
    });
  };
}

/** Instance applicative — base réelle (Neon), résolue paresseusement. */
export function listerWorkspacesParEnvironnement(
  environnement: "sandbox" | "production",
): Promise<{ id: string }[]> {
  return createListerWorkspacesSysteme(obtenirDb())(environnement);
}
