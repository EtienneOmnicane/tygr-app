/**
 * Bascule de workspace (Epic 2 L2) — logique serveur pure vis-à-vis du transport
 * (la Server Action n'est qu'un adaptateur). Cœur de la sécurité anti-IDOR S1.
 *
 * DOUBLE BARRIÈRE :
 *  1. Ici (écriture) : on rejette AVANT toute mise à jour de session si l'user
 *     n'est pas membre du workspace cible — `WorkspaceSwitchDeniedError`.
 *  2. config.ts (jwt callback, trigger update) : re-valide la membership une
 *     seconde fois avant de figer le token.
 *  3. withWorkspace (lecture) : re-valide à CHAQUE requête (E14) → 404 sinon.
 * Trois étages : un workspace non autorisé ne peut atteindre ni le token ni les
 * données.
 */
import { z } from "zod";

import type { MembershipResume } from "@/server/repositories/identite";

/** Tentative de bascule vers un workspace dont l'utilisateur n'est pas membre. */
export class WorkspaceSwitchDeniedError extends Error {
  readonly code = "WORKSPACE_SWITCH_DENIED";
  constructor() {
    super("Workspace introuvable"); // non-énumérant (règle 3)
    this.name = "WorkspaceSwitchDeniedError";
  }
}

export const workspaceCibleSchema = z.string().uuid();

/**
 * Valide qu'une bascule est autorisée. Lève WorkspaceSwitchDeniedError si le
 * workspace cible n'est pas dans les memberships fournis (lus sous RLS).
 * Pure : memberships injectés, pas d'I/O — testable directement.
 */
export function validerBascule(
  workspaceCible: unknown,
  memberships: readonly MembershipResume[],
): string {
  const parsed = workspaceCibleSchema.safeParse(workspaceCible);
  if (!parsed.success) {
    throw new WorkspaceSwitchDeniedError();
  }
  if (!memberships.some((m) => m.workspaceId === parsed.data)) {
    throw new WorkspaceSwitchDeniedError();
  }
  return parsed.data;
}
