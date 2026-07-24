/**
 * Repository du journal `sync_runs` (lot W2, PLAN-ingestion-webhook-omnifi.md
 * §4.3 — version minimale). SEUL ÉCRIVAIN de la table.
 *
 * Contrat : `workspace_id` vient TOUJOURS de `ctx` (withWorkspace ou primitive
 * système), jamais d'un paramètre — invariant commun à tous les repositories.
 * La FK COMPOSITE (connection_id, workspace_id) → bank_connections(id,
 * workspace_id) rend un run pointant la connexion d'un AUTRE tenant impossible
 * en base, en plus de la RLS.
 *
 * Cycle de vie : `ouvrirSyncRun` (RUNNING) → `cloreSyncRun` (statut terminal +
 * compteurs + finished_at). Le CHECK `sync_runs_finished_coherence_check`
 * garantit RUNNING ⇔ finished_at NULL — un UPDATE incohérent échoue bruyamment.
 * Un RUNNING ancien jamais clos = run mort en vol (crash après épuisement des
 * retries Inngest) : signal d'exploitation voulu, pas un état à masquer.
 * `erreur_code` : code machine SEUL (ex. `Error.Type` amont) — jamais un
 * message OBIE (règle 8, zéro PII).
 */
import { and, eq, sql } from "drizzle-orm";

import { syncRuns, type SyncRunStatut, type SyncRunTrigger } from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface SyncRunAOuvrir {
  /** `bank_connections.id` INTERNE, résolu sous RLS par l'appelant. */
  connectionId: string;
  declencheur: SyncRunTrigger;
}

/** Ouvre un run (statut RUNNING). Rend son id, à clore par `cloreSyncRun`. */
export async function ouvrirSyncRun<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  run: SyncRunAOuvrir,
): Promise<{ syncRunId: string }> {
  const lignes = await tx
    .insert(syncRuns)
    .values({
      workspaceId: ctx.workspaceId,
      connectionId: run.connectionId,
      triggerSource: run.declencheur,
    })
    .returning({ id: syncRuns.id });
  return { syncRunId: lignes[0].id };
}

export interface SyncRunACLore {
  syncRunId: string;
  /** Terminal uniquement — RUNNING est interdit ici (CHECK de cohérence). */
  statut: Exclude<SyncRunStatut, "RUNNING">;
  comptesTraites: number;
  transactionsUpsertees: number;
  erreurCode?: string | null;
}

/**
 * Clôt un run : statut terminal + compteurs + `finished_at = now()`. Idempotent
 * (un re-clos réécrit les mêmes valeurs — le retry d'un step Inngest est sûr).
 * Le WHERE porte workspace_id (défense en profondeur, la RLS borne déjà).
 */
export async function cloreSyncRun<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  cloture: SyncRunACLore,
): Promise<void> {
  await tx
    .update(syncRuns)
    .set({
      status: cloture.statut,
      comptesTraites: cloture.comptesTraites,
      transactionsUpsertees: cloture.transactionsUpsertees,
      // Troncature DÉFENSIVE à la borne de la colonne (varchar 60) : le code
      // vient de l'amont (`Error.Type`), dont l'enum DÉRIVE (leçon PR #202) —
      // un code trop long ne doit pas faire échouer la clôture du run (m4).
      erreurCode: cloture.erreurCode ? cloture.erreurCode.slice(0, 60) : null,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(syncRuns.id, cloture.syncRunId),
        eq(syncRuns.workspaceId, ctx.workspaceId),
      ),
    );
}
