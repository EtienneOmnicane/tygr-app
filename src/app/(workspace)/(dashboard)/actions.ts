"use server";

/**
 * Server Actions du dashboard. Surface d'appel CLIENT par-dessus les services de
 * lecture scopés (`@/server/repositories/dashboard` via le barrel @/server/db).
 * Le RSC `page.tsx` lit ses données directement dans withWorkspace ; CETTE action
 * sert aux rafraîchissements CLIENT dynamiques (ex. un graphique qui change sa
 * fenêtre de mois sans recharger la page).
 *
 * Exit-criteria (CLAUDE.md règle 3) :
 * - Authz : exigerSessionWorkspace + withWorkspace (membership re-validée à chaque
 *   requête ; RLS tenant + scope entité par jointure). Lecture seule, ouverte aux
 *   membres (comme le reste du dashboard). workspace_id JAMAIS un paramètre client.
 * - Validation Zod stricte (nbMois borné).
 * - Retour normalisé ResultatAction (jamais d'exception propagée au client).
 * - Pas de PII (agrégats de montants uniquement, jamais de libellé).
 */
import { redirect } from "next/navigation";
import { z } from "zod";

import { unstable_update } from "@/server/auth/config";
import { moisCourantMaurice } from "@/lib/format-date";
import {
  exigerSessionWorkspace,
  ServiceIndisponibleError,
} from "@/server/auth/session";
import { perimetreSchema } from "@/server/auth/view-filter";
import {
  type SyntheseMensuelle,
  syntheseParMois,
  withWorkspace,
} from "@/server/db";

export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/** État du formulaire du sélecteur de périmètre (useActionState côté client). */
export interface EtatPerimetre {
  erreur: string | null;
}

const MESSAGE_PERIMETRE_INVALIDE = "Périmètre invalide.";

/**
 * Définit le périmètre d'affichage (sélecteur de périmètre L8b-1). Calque de
 * `basculerWorkspace` ((workspace)/actions.ts) : auth → validation → unstable_update
 * → redirect. « Groupe » = liste vide → le callback jwt retire le champ du token →
 * GUC non posé → on voit tout le DROIT.
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

/** Borne du nombre de mois demandés (1..36 ; 3 ans suffisent pour un graphique). */
const syntheseParMoisSchema = z
  .object({ nbMois: z.number().int().min(1).max(36).default(12) })
  .strict();

/**
 * Série mensuelle Entrées/Sorties (Cash In/Out) des `nbMois` derniers mois (défaut
 * 12), par devise — pour un graphique Front. `moisFin` = mois COURANT Maurice
 * (calculé serveur, conversion explicite Indian/Mauritius) ; jamais un paramètre
 * client. Multi-devises : une ligne par (mois, devise), jamais d'addition cross-devise.
 */
export async function syntheseParMoisAction(input?: {
  nbMois?: number;
}): Promise<ResultatAction<SyntheseMensuelle[]>> {
  const session = await exigerSessionWorkspace();
  const parsed = syntheseParMoisSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: "Paramètres invalides." };
  }
  try {
    const moisFin = moisCourantMaurice();
    const data = await withWorkspace(session, (tx) =>
      syntheseParMois(tx, { moisFin, nbMois: parsed.data.nbMois }),
    );
    return { ok: true, data };
  } catch (erreur) {
    const code =
      erreur instanceof ServiceIndisponibleError
        ? "SERVICE_UNAVAILABLE"
        : "ERREUR";
    console.warn(
      JSON.stringify({
        evt: "dashboard_echec",
        action: "synthese-par-mois",
        workspaceId: session.activeWorkspaceId,
        code,
      }),
    );
    return {
      ok: false,
      code,
      message:
        code === "SERVICE_UNAVAILABLE"
          ? "Service momentanément indisponible."
          : "L’opération a échoué. Réessayez.",
    };
  }
}
