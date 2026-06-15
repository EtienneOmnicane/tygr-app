/**
 * Provisioning d'utilisateurs par un ADMIN (Epic 2 L3). Opère DANS le contexte
 * workspace (withWorkspace) — la transaction porte déjà app.current_workspace_id,
 * donc l'INSERT du membership est soumis à la policy WITH CHECK : impossible de
 * rattacher à un autre tenant que le courant (arbitrage S3).
 *
 * Garde de rôle (S3) : le rôle vient du CONTEXTE withWorkspace (re-résolu à
 * chaque requête), jamais du client. Un non-ADMIN qui appelle → rejet.
 */
import { sql } from "drizzle-orm";

import { users, workspaceMembers } from "@/server/db/schema";
import type { WorkspaceRole } from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** L'acteur n'est pas ADMIN du workspace courant (S3). Non-énumérant. */
export class ProvisioningNonAutoriseError extends Error {
  readonly code = "PROVISIONING_NOT_AUTHORIZED";
  constructor() {
    super("Action non autorisée");
    this.name = "ProvisioningNonAutoriseError";
  }
}

/** Le rôle visé pour le nouvel utilisateur sort de la convention. */
export class RoleInvalideError extends Error {
  readonly code = "ROLE_INVALIDE";
  constructor() {
    super("Rôle invalide");
    this.name = "RoleInvalideError";
  }
}

export interface NouvelUtilisateur {
  email: string; // déjà normalisé en minuscules par la couche action
  fullName: string;
  passwordHash: string; // argon2, calculé par l'action (jamais ici)
  role: WorkspaceRole;
}

const ROLES_ASSIGNABLES: readonly WorkspaceRole[] = [
  "ADMIN",
  "MANAGER",
  "VIEWER",
];

/**
 * Crée (ou réutilise) un utilisateur par email et le rattache au workspace
 * COURANT avec le rôle donné. À exécuter DANS withWorkspace(session, fn) :
 * `tx` et `ctx` viennent du contexte scopé.
 *
 * - Garde S3 : ctx.role doit être ADMIN, sinon rejet (le rôle vient du
 *   contexte, pas d'un paramètre client).
 * - Le workspace cible n'est JAMAIS un paramètre : c'est ctx.workspaceId. Un
 *   ADMIN ne peut donc provisionner que dans SON workspace (pas de cross-tenant).
 * - L'INSERT membership passe par la policy WITH CHECK (workspace_id = contexte).
 */
export async function creerUtilisateurEtRattacher<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  nouvel: NouvelUtilisateur,
): Promise<{ userId: string }> {
  if (ctx.role !== "ADMIN") {
    throw new ProvisioningNonAutoriseError();
  }
  if (!ROLES_ASSIGNABLES.includes(nouvel.role)) {
    throw new RoleInvalideError();
  }

  // users est hors RLS : lookup/insert direct. Email normalisé en amont.
  const existant = await tx
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${nouvel.email})`)
    .limit(1);

  let userId: string;
  if (existant.length > 0) {
    userId = existant[0].id;
  } else {
    const inseres = await tx
      .insert(users)
      .values({
        email: nouvel.email,
        fullName: nouvel.fullName,
        passwordHash: nouvel.passwordHash,
      })
      .returning({ id: users.id });
    userId = inseres[0].id;
  }

  // Rattachement au workspace COURANT (ctx.workspaceId) — WITH CHECK garantit
  // qu'on ne vise pas un autre tenant. Idempotent (ON CONFLICT do nothing).
  await tx
    .insert(workspaceMembers)
    .values({
      userId,
      workspaceId: ctx.workspaceId,
      role: nouvel.role,
    })
    .onConflictDoNothing();

  return { userId };
}
