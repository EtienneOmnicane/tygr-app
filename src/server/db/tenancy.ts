/**
 * withWorkspace(session, fn) — contrat E14 du plan v2.1 (CLAUDE.md règle 2) :
 *   BEGIN
 *     → set_config('app.current_workspace_id', …, true)   — true = local à la txn
 *     → set_config('app.current_user_id', …, true)
 *     → re-validation de la membership (à CHAQUE appel : un membre retiré
 *       perd l'accès à la requête suivante, pas au prochain login)
 *     → fn(tx, { role }) — tout accès données vit DANS cette transaction
 *   COMMIT / ROLLBACK
 *
 * set_config(..., true) est scoping-transaction (équivalent SET LOCAL) et
 * paramétrable — jamais d'interpolation de chaîne dans un SET.
 *
 * La factory permet d'injecter la base (prod : Neon Pool ; tests : PGlite)
 * sans dupliquer le contrat. L'instance applicative est exportée par
 * src/db/index.ts sous la signature du plan : withWorkspace(session, fn).
 */
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import { workspaceMembers, type WorkspaceRole } from "@/server/db/schema";

export const workspaceSessionSchema = z
  .object({
    userId: z.string().uuid(),
    activeWorkspaceId: z.string().uuid(),
  })
  .strict();

export type WorkspaceSession = z.infer<typeof workspaceSessionSchema>;

/** Session invalide/forgée — la couche route répond 400, code nommé (règle 3). */
export class InvalidSessionError extends Error {
  readonly code = "INVALID_SESSION";
  constructor() {
    super("Session invalide");
    this.name = "InvalidSessionError";
  }
}

/**
 * Accès refusé au workspace — la couche route répond 404, JAMAIS 403
 * (pas d'oracle d'existence, CLAUDE.md règle 3).
 */
export class WorkspaceAccessDeniedError extends Error {
  readonly code = "WORKSPACE_ACCESS_DENIED";
  constructor() {
    super("Ressource introuvable");
    this.name = "WorkspaceAccessDeniedError";
  }
}

/**
 * Garde-fou runtime (dette P0-b / C6, risque R1 de la revue Eng) : la connexion
 * applicative DOIT tourner sous un rôle non-propriétaire des tables. Un rôle
 * propriétaire (ou superuser/BYPASSRLS) contourne la RLS — toute l'isolation
 * inter-tenant tomberait en silence. On échoue FERMÉ (aucune requête servie)
 * plutôt que d'exposer des données cross-tenant. C'est une erreur de
 * configuration serveur, jamais déclenchable par un client : code distinct,
 * volontairement bruyant, mappé en 500 par la couche route (pas un 404).
 */
export class UnsafeDatabaseRoleError extends Error {
  readonly code = "UNSAFE_DB_ROLE";
  constructor(role: string) {
    super(
      `Connexion DB sous un rôle propriétaire (${role}) : la RLS serait ` +
        `contournée. L'app doit se connecter sous tygr_app (voir ` +
        `drizzle/provisioning/tygr_app.sql). Requête refusée (fail-closed).`,
    );
    this.name = "UnsafeDatabaseRoleError";
  }
}

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Le type de transaction Drizzle, dérivé du type de base injecté. */
export type WorkspaceTx<TDb extends AnyPgDatabase> = Parameters<
  Parameters<TDb["transaction"]>[0]
>[0];

export interface WorkspaceContext {
  role: WorkspaceRole;
  workspaceId: string;
  userId: string;
}

/**
 * `withWorkspace(session, fn)` déjà lié à une session — passé aux orchestrateurs
 * d'ingestion pour qu'ils restent purs de la DB concrète. Le `tx` est typé sur
 * AnyPgDatabase (compatible avec les repositories génériques `<TDb>`), sans le
 * piège d'inférence d'un `never` (qui fait diverger tsc).
 */
export type ExecuterWorkspace = <T>(
  fn: (tx: WorkspaceTx<AnyPgDatabase>, ctx: WorkspaceContext) => Promise<T>,
) => Promise<T>;

export function createWithWorkspace<TDb extends AnyPgDatabase>(db: TDb) {
  return async function withWorkspace<T>(
    session: WorkspaceSession,
    fn: (tx: WorkspaceTx<TDb>, ctx: WorkspaceContext) => Promise<T>,
  ): Promise<T> {
    const parsed = workspaceSessionSchema.safeParse(session);
    if (!parsed.success) {
      throw new InvalidSessionError();
    }
    const { userId, activeWorkspaceId } = parsed.data;

    return db.transaction(async (tx) => {
      // Garde-fou R1/C6 : refuser de servir si la connexion tourne sous le
      // propriétaire des tables (RLS contournable). Comparé au propriétaire
      // réel de workspace_members — pas à une liste de noms en dur, pour rester
      // correct quel que soit le nom d'owner (tygr_owner en local, autre sur
      // Neon). `tableowner = current_user` ⇒ rôle propriétaire ⇒ fail-closed.
      const roleCheck = await tx.execute(
        sql`select current_user as who,
                   current_user = tableowner as is_owner
            from pg_tables where tablename = 'workspace_members'`,
      );
      const ligneRole = (
        roleCheck as unknown as {
          rows: { who: string; is_owner: boolean }[];
        }
      ).rows[0];
      if (ligneRole?.is_owner === true) {
        throw new UnsafeDatabaseRoleError(ligneRole.who ?? "owner");
      }

      await tx.execute(
        sql`select set_config('app.current_workspace_id', ${activeWorkspaceId}, true)`,
      );
      await tx.execute(
        sql`select set_config('app.current_user_id', ${userId}, true)`,
      );

      const membership = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, activeWorkspaceId),
          ),
        )
        .limit(1);

      if (membership.length === 0) {
        // Rollback implicite : on sort de la transaction par une exception.
        throw new WorkspaceAccessDeniedError();
      }

      return fn(tx as WorkspaceTx<TDb>, {
        role: membership[0].role as WorkspaceRole,
        workspaceId: activeWorkspaceId,
        userId,
      });
    });
  };
}
