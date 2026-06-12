/**
 * Pont Auth.js → withWorkspace — l'UNIQUE chemin d'obtention d'une
 * WorkspaceSession côté serveur (Server Components, Server Actions, routes).
 *
 * Re-validation E6 à CHAQUE requête : users.is_active est relu en base — un
 * compte désactivé perd l'accès immédiatement, même avec un JWT encore valide.
 * (La membership, elle, est re-validée par withWorkspace — E14.)
 *
 * Mapping erreurs (règle 3, registre S2) :
 * - NonAuthentifieError  → redirection /login (jamais de détail : un compte
 *   désactivé est indistinguable d'un non-connecté).
 * - AucunWorkspaceActifError → écran « aucun workspace » (PR 2 : sélecteur).
 */
import { auth } from "@/server/auth/config";
import { identite } from "@/server/db";
import { workspaceSessionSchema, type WorkspaceSession } from "@/server/db/tenancy";

export class NonAuthentifieError extends Error {
  readonly code = "NOT_AUTHENTICATED";
  constructor() {
    super("Authentification requise");
    this.name = "NonAuthentifieError";
  }
}

export class AucunWorkspaceActifError extends Error {
  readonly code = "NO_ACTIVE_WORKSPACE";
  constructor() {
    super("Aucun workspace actif");
    this.name = "AucunWorkspaceActifError";
  }
}

export async function exigerSessionWorkspace(): Promise<WorkspaceSession> {
  const session = await auth();
  if (!session?.userId) {
    throw new NonAuthentifieError();
  }

  // E6 — re-validation is_active à chaque requête.
  if (!(await identite.estActif(session.userId))) {
    throw new NonAuthentifieError();
  }

  if (!session.activeWorkspaceId) {
    throw new AucunWorkspaceActifError();
  }

  const parsed = workspaceSessionSchema.safeParse({
    userId: session.userId,
    activeWorkspaceId: session.activeWorkspaceId,
  });
  if (!parsed.success) {
    // JWT au contenu inattendu : on le traite comme une absence de session.
    throw new NonAuthentifieError();
  }
  return parsed.data;
}
