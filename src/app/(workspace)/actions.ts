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
import { perimetreSchema, perimetreEntiteSchema } from "@/server/auth/view-filter";
import { comptesParEntite, identite, withWorkspace } from "@/server/db";
import { exigerSessionWorkspace } from "@/server/auth/session";

export interface EtatBascule {
  erreur: string | null;
}

const MESSAGE_BASCULE_REFUSEE = "Workspace indisponible.";

/** État du formulaire du sélecteur de périmètre (useActionState côté client). */
export interface EtatPerimetre {
  erreur: string | null;
}

const MESSAGE_PERIMETRE_INVALIDE = "Périmètre invalide.";

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

/**
 * Définit le périmètre d'affichage (sélecteur de périmètre L8b-1). Co-localisée
 * avec `basculerWorkspace` (même niveau workspace) car le `PerimetreSwitcher` est
 * monté dans le header GLOBAL du groupe — il s'affiche sur toutes les pages, pas
 * seulement le dashboard. Calque : auth → validation → unstable_update → redirect.
 * « Groupe » = liste vide → le callback jwt retire le champ du token → GUC non
 * posé → on voit tout le DROIT.
 *
 * Sécurité (exit-criteria règle 3) : authz via exigerSessionWorkspace ; validation
 * Zod stricte ; aucun accès direct au client DB (la re-validation des comptes vit
 * dans le callback jwt, sous withWorkspace) ; erreur nommée, message générique.
 */
export async function definirViewFilter(
  _etat: EtatPerimetre,
  formData: FormData,
): Promise<EtatPerimetre> {
  await exigerSessionWorkspace();
  // getAll → string[] (0..N champs `bankAccountId`). « Groupe » = aucun champ ⇒ [].
  const parsed = perimetreSchema.safeParse({
    bankAccountIds: formData.getAll("bankAccountId"),
  });
  if (!parsed.success) {
    return { erreur: MESSAGE_PERIMETRE_INVALIDE };
  }

  // Écrit le JWT : le callback jwt RE-VALIDE/intersecte la demande (barrière n°2,
  // hygiène) avant de poser le champ. La sécurité réelle reste la RLS.
  await unstable_update({ viewFilter: parsed.data.bankAccountIds });
  redirect("/");
}

/**
 * Définit le périmètre d'affichage PAR ENTITÉ (sélecteur L8b-2, onglet « Par entité »).
 * Action SŒUR de `definirViewFilter` : au lieu de recevoir des bankAccountId bruts, elle
 * reçoit un `entityId` et le TRADUIT côté serveur en liste de comptes (sous le droit du
 * membre) AVANT de réutiliser exactement le même canal view_filter.
 *
 * Pourquoi la traduction est SERVEUR (pas client) : le client ne doit pas pouvoir forger
 * une liste arbitraire de comptes sous couvert d'« une entité ». Même si le rempart
 * serveur (intersection DROIT ∩ filtre, tenancy.ts) interdit toute fuite, traduire ici
 * garantit que le token reflète RÉELLEMENT les comptes de l'entité tels que le membre les
 * voit — ce qui rend aussi le libellé re-dérivé (C5) fiable.
 *
 * Sécurité (exit-criteria règle 3) : authz via exigerSessionWorkspace ; Zod strict ;
 * lecture DB UNIQUEMENT via withWorkspace + repo comptesParEntite (règle 2) ; un entityId
 * hors du droit → comptesParEntite renvoie [] → viewFilter vide → callback jwt → undefined
 * → « Groupe » (fail-soft cohérent, jamais de fuite). Erreur nommée, message générique.
 */
export async function definirPerimetreEntite(
  _etat: EtatPerimetre,
  formData: FormData,
): Promise<EtatPerimetre> {
  const session = await exigerSessionWorkspace();
  const parsed = perimetreEntiteSchema.safeParse({
    entityId: formData.get("entityId"),
  });
  if (!parsed.success) {
    return { erreur: MESSAGE_PERIMETRE_INVALIDE };
  }

  // Traduction entité→comptes SOUS LE DROIT, session SANS viewFilter (userId +
  // activeWorkspaceId seulement, calque config.ts) : sinon la clause AND view_filter de
  // account_scope amputerait la traduction (mécanique du bug #143) → l'entité ne pourrait
  // jamais ré-élargir un filtre déjà actif.
  const bankAccountIds = await withWorkspace(
    { userId: session.userId, activeWorkspaceId: session.activeWorkspaceId },
    (tx) => comptesParEntite(tx, parsed.data.entityId),
  );

  // Réutilise le canal view_filter : le callback jwt re-valide/intersecte (hygiène), la
  // RLS reste la sécurité. Liste vide (entité hors droit / sans compte visible) ⇒ token
  // sans filtre ⇒ « Groupe ».
  await unstable_update({ viewFilter: bankAccountIds });
  redirect("/");
}
