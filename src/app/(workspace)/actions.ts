"use server";

/**
 * Server Actions du périmètre workspace (Epic 2). Adaptateurs fins : la
 * validation et la sécurité vivent dans server/auth/workspace-switch.ts.
 */
import { redirect } from "next/navigation";

import { unstable_update } from "@/server/auth/config";
import {
  validerBascule,
  WorkspaceSwitchDeniedError,
} from "@/server/auth/workspace-switch";
import { identite } from "@/server/db";
import { exigerSessionWorkspace } from "@/server/auth/session";

export interface EtatBascule {
  erreur: string | null;
}

const MESSAGE_BASCULE_REFUSEE = "Workspace indisponible.";

/**
 * Bascule vers `workspaceCible`. Re-valide la membership (S1, barrière n°1)
 * AVANT de mettre à jour le JWT. Le callback jwt (trigger update) re-valide une
 * 2e fois (barrière n°2). Échec → message générique non-énumérant.
 */
export async function basculerWorkspace(
  _etat: EtatBascule,
  formData: FormData,
): Promise<EtatBascule> {
  const session = await exigerSessionWorkspace();
  const cible = formData.get("workspaceId");

  let workspaceValide: string;
  try {
    const memberships = await identite.membershipsDe(session.userId);
    workspaceValide = validerBascule(cible, memberships);
  } catch (erreur) {
    if (erreur instanceof WorkspaceSwitchDeniedError) {
      return { erreur: MESSAGE_BASCULE_REFUSEE };
    }
    throw erreur;
  }

  // Met à jour le JWT (le callback jwt re-valide la membership — barrière n°2).
  // `viewFilter: null` PURGE le filtre de périmètre au changement de workspace
  // (L8b-1, §8.5) : un filtre sur les comptes de l'ancien workspace donnerait,
  // une fois posé sur le nouveau, un dashboard VIDE (intersection avec un autre
  // DROIT = ∅). On repart donc sur « Groupe ». `null` (pas `undefined`) pour que
  // la clé soit présente dans le payload et déclenche le reset côté callback jwt.
  await unstable_update({ activeWorkspaceId: workspaceValide, viewFilter: null });
  redirect("/");
}
