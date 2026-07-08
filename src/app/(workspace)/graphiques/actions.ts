"use server";

/**
 * Server Actions des GRAPHIQUES — analyse par catégorie (camembert). Surface d'appel
 * UI par-dessus le repository scopé `@/server/repositories/insights` (importé via le
 * barrel @/server/db — frontière P0-a). Elles câblent session + withWorkspace ; elles
 * ne touchent JAMAIS la DB directement.
 *
 * DEUX surfaces distinctes (choix identique à la convention des états d'affichage) :
 * - `chargerAnalyseCategories` : lecture du PREMIER paint (RSC). Laisse remonter une
 *   erreur de session/infra à l'error boundary du segment (fail-closed).
 * - `analyserCategoriesAction` : re-fetch CLIENT au changement de sélecteur (sens /
 *   période). Retour normalisé `ResultatAction` — jamais d'exception propagée au
 *   navigateur ; erreurs mappées en { ok:false, code, message } non-énumérant.
 *
 * Le CLIENT n'envoie qu'un PRESET de période (jamais des dates brutes) : les bornes
 * [from, to] sont dérivées À MAURICE côté serveur (`bornesPeriodeMaurice`, E20) — pas
 * de fuseau client interpolé dans une borne comptable.
 *
 * Exit-criteria (CLAUDE.md règle 3) :
 * - Authz : exigerSessionWorkspace + withWorkspace (membership re-validée ; deux étages
 *   RLS posés par withWorkspace ; scope entité hérité par la jointure du repository).
 * - Validation Zod stricte (énums fermées sens/période) ; défauts métier appliqués.
 * - workspace_id / dates JAMAIS des paramètres client (dérivés de ctx + preset).
 * - Logs corrélés (workspace_id + code machine), SANS PII.
 */
import {
  listerComptes,
  repartitionParCategorie,
  withWorkspace,
  InsightsParamsInvalidesError,
  type RepartitionCategories,
} from "@/server/db";
import {
  exigerSessionWorkspace,
  ServiceIndisponibleError,
} from "@/server/auth/session";
import {
  analyseCategoriesParamsSchema,
  type PeriodePresetParam,
  type SensFluxParam,
} from "@/lib/insights-schema";
import {
  bornesPeriodeMaurice,
  bornesPeriodePrecedente,
} from "@/lib/periode-analyse";

/** Résultat normalisé (miroir du contrat UI des autres surfaces d'action). */
export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/**
 * Vue du PREMIER paint : la répartition (période/sens par défaut) + le drapeau
 * `aucuneBanque` (décide le CTA de l'état vide : « Connecter une banque » vs
 * « aucune donnée sur la période »). Une seule transaction pour les deux lectures.
 */
export interface AnalyseVue {
  repartition: RepartitionCategories;
  aucuneBanque: boolean;
}

/** Entrée des deux surfaces : un sens + un preset de période (tous deux optionnels). */
export interface AnalyseCategoriesInput {
  sens?: SensFluxParam;
  periode?: PeriodePresetParam;
}

const MSG_PARAMS = "Paramètres invalides.";

/**
 * Mappe une erreur en ResultatAction non-énumérant + log corrélé sûr (sans PII).
 * Codes machine stables pour le mapping UI.
 */
function echec(
  erreur: unknown,
  workspaceId: string,
  action: string,
): { ok: false; code: string; message: string } {
  let code = "ERREUR";
  let message = "L’opération a échoué. Réessayez.";
  if (erreur instanceof InsightsParamsInvalidesError) {
    code = "INVALID_PARAMS";
    message = MSG_PARAMS;
  } else if (erreur instanceof ServiceIndisponibleError) {
    code = "SERVICE_UNAVAILABLE";
    message = "Service momentanément indisponible.";
  }
  console.warn(
    JSON.stringify({ evt: "graphiques_echec", action, workspaceId, code }),
  );
  return { ok: false, code, message };
}

/**
 * Lecture du premier paint : répartition par catégorie (sens + preset, défauts métier
 * = SORTIES du mois courant) et existence d'au moins un compte. Les deux lectures
 * tournent dans UNE transaction withWorkspace, en séquence (une connexion
 * transactionnelle ne pipeline pas — pas de Promise.all). Les bornes sont dérivées à
 * Maurice depuis le preset (jamais des dates client). Erreur session/infra → remonte
 * à l'error boundary (fail-closed).
 */
export async function chargerAnalyseCategories(
  input?: AnalyseCategoriesInput,
): Promise<AnalyseVue> {
  const session = await exigerSessionWorkspace();
  // `.parse` (pas safeParse) : un premier paint interne ne reçoit que des valeurs sûres
  // (défauts du schéma) ; toute dérive est un bug serveur, pas une entrée client.
  const params = analyseCategoriesParamsSchema.parse(input ?? {});
  const bornes = bornesPeriodeMaurice(params.periode);
  const prec = bornesPeriodePrecedente(bornes);
  return withWorkspace(session, async (tx) => {
    const comptes = await listerComptes(tx);
    const repartition = await repartitionParCategorie(tx, {
      sens: params.sens,
      from: bornes.from,
      to: bornes.to,
      fromPrecedent: prec.from,
      toPrecedent: prec.to,
    });
    return { repartition, aucuneBanque: comptes.length === 0 };
  });
}

/**
 * Re-fetch client au changement de sélecteur (sens / période). Retour normalisé :
 * jamais d'exception au navigateur. Le preset est re-validé (énum fermée) et les
 * bornes re-dérivées à Maurice côté serveur (le client n'envoie jamais de dates).
 */
export async function analyserCategoriesAction(
  input: AnalyseCategoriesInput,
): Promise<ResultatAction<RepartitionCategories>> {
  const session = await exigerSessionWorkspace();
  const parsed = analyseCategoriesParamsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  const bornes = bornesPeriodeMaurice(parsed.data.periode);
  const prec = bornesPeriodePrecedente(bornes);
  try {
    const repartition = await withWorkspace(session, (tx) =>
      repartitionParCategorie(tx, {
        sens: parsed.data.sens,
        from: bornes.from,
        to: bornes.to,
        fromPrecedent: prec.from,
        toPrecedent: prec.to,
      }),
    );
    return { ok: true, data: repartition };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "analyser-categories");
  }
}
