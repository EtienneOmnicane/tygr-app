"use server";

/**
 * Server Actions des ÉCHÉANCES prévisionnelles (Epic 8 · FEAT-8.2). Surface d'appel
 * UI par-dessus le repository scopé `@/server/repositories/echeances` (importé via le
 * barrel @/server/db — frontière P0-a). Elles câblent session + withWorkspace ; elles
 * ne touchent JAMAIS la DB directement.
 *
 * Retour normalisé `ResultatAction` (jamais d'exception propagée au client) : les
 * erreurs nommées du repository sont mappées en { ok:false, code, message } non-
 * énumérant. La lecture (`listerEcheancesAction`) renvoie directement la vue (liste +
 * synthèse) et laisse remonter une éventuelle erreur de session à l'error boundary RSC.
 *
 * Exit-criteria (CLAUDE.md règle 3) :
 * - Authz : exigerSessionWorkspace + withWorkspace (membership re-validée à chaque
 *   requête ; deux étages RLS posés par withWorkspace). Écriture réservée aux membres
 *   (garde `peutModifier` DANS le repository → EcheanceNonAutoriseeError, testable sous
 *   RLS). Ressource d'un autre tenant / hors périmètre → 404 (EcheanceIntrouvableError),
 *   jamais 403 (pas d'oracle d'existence).
 * - Validation Zod stricte (énum, uuid, décimal, date, bornes).
 * - workspace_id JAMAIS un paramètre client (vient de ctx).
 * - Logs corrélés (workspace_id + code machine), SANS PII (jamais libellé/contrepartie).
 */
import {
  exigerSessionWorkspace,
  ServiceIndisponibleError,
} from "@/server/auth/session";
import {
  EcheanceHorsPerimetreError,
  EcheanceIntrouvableError,
  EcheanceNonAutoriseeError,
  MontantRegleInvalideError,
  ReferenceEcheanceInvalideError,
  changerStatutEcheance,
  creerEcheance,
  listerEcheances,
  modifierEcheance,
  supprimerEcheance,
  synthetiserHorizon,
  withWorkspace,
  type EcheanceLue,
  type SyntheseEcheances,
} from "@/server/db";
import {
  changerStatutEcheanceSchema,
  creerEcheanceSchema,
  modifierEcheanceSchema,
  supprimerEcheanceSchema,
} from "@/lib/echeances-schema";

/** Résultat normalisé (miroir du contrat UI des autres surfaces d'action). */
export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/** Vue combinée de la page Échéances : liste triée + synthèse par horizon. */
export interface EcheancesVue {
  echeances: EcheanceLue[];
  synthese: SyntheseEcheances;
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
  if (erreur instanceof EcheanceIntrouvableError) {
    code = erreur.code; // ECHEANCE_NOT_FOUND
    message = "Échéance introuvable.";
  } else if (erreur instanceof EcheanceNonAutoriseeError) {
    code = erreur.code; // FORBIDDEN_ROLE
    message = "Action réservée aux gestionnaires.";
  } else if (erreur instanceof ReferenceEcheanceInvalideError) {
    code = erreur.code; // REFERENCE_NOT_FOUND
    message = "Entité ou catégorie introuvable dans cet espace.";
  } else if (erreur instanceof EcheanceHorsPerimetreError) {
    code = erreur.code; // ENTITY_OUT_OF_SCOPE
    message = "Échéance hors de votre périmètre d’entités.";
  } else if (erreur instanceof MontantRegleInvalideError) {
    code = erreur.code; // SETTLED_AMOUNT_INVALID
    message = "Le montant réglé doit être compris entre 0 et le montant.";
  } else if (erreur instanceof ServiceIndisponibleError) {
    code = "SERVICE_UNAVAILABLE";
    message = "Service momentanément indisponible.";
  }
  console.warn(
    JSON.stringify({ evt: "echeances_echec", action, workspaceId, code }),
  );
  return { ok: false, code, message };
}

/**
 * Lecture de la page : liste des échéances du workspace (triée par exigibilité, avec
 * le statut « en retard » dérivé) + synthèse par horizon (30/60/90 j × devise). Les
 * deux lectures tournent dans UNE SEULE transaction withWorkspace, en séquence (une
 * connexion transactionnelle ne pipeline pas deux requêtes concurrentes — pas de
 * Promise.all). L'« aujourd'hui » de dérivation est la date courante à Maurice
 * (défaut du repository).
 */
export async function listerEcheancesAction(): Promise<EcheancesVue> {
  const session = await exigerSessionWorkspace();
  return withWorkspace(session, async (tx, ctx) => {
    const liste = await listerEcheances(tx, ctx);
    const synthese = await synthetiserHorizon(tx, ctx);
    return { echeances: liste, synthese };
  });
}

/** Crée une échéance (direction + libellé + montant + devise + date exigibles). */
export async function creerEcheanceAction(input: {
  entityId?: string | null;
  direction: "encaissement" | "decaissement";
  libelle: string;
  contrepartie?: string | null;
  montant: string;
  devise: "MUR" | "USD" | "EUR";
  dateEcheance: string;
  categorieId?: string | null;
  recurrence?: "mensuelle" | "trimestrielle" | null;
}): Promise<ResultatAction<{ echeanceId: string }>> {
  const session = await exigerSessionWorkspace();
  const parsed = creerEcheanceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    // Garde de rôle (VIEWER refusé) + périmètre entité portés par le repository
    // `creerEcheance` (EcheanceNonAutoriseeError / EcheanceHorsPerimetreError) —
    // testables sous RLS réelle.
    const r = await withWorkspace(session, (tx, ctx) =>
      creerEcheance(tx, ctx, parsed.data),
    );
    return { ok: true, data: r };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "creer-echeance");
  }
}

/** Modifie les champs descriptifs d'une échéance (champs partiels). */
export async function modifierEcheanceAction(input: {
  echeanceId: string;
  entityId?: string | null;
  direction?: "encaissement" | "decaissement";
  libelle?: string;
  contrepartie?: string | null;
  montant?: string;
  devise?: "MUR" | "USD" | "EUR";
  dateEcheance?: string;
  categorieId?: string | null;
  recurrence?: "mensuelle" | "trimestrielle" | null;
}): Promise<ResultatAction> {
  const session = await exigerSessionWorkspace();
  const parsed = modifierEcheanceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    await withWorkspace(session, (tx, ctx) =>
      modifierEcheance(tx, ctx, parsed.data),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "modifier-echeance");
  }
}

/**
 * Transition de cycle de vie (+ part réglée pour « partiel »). Le schéma zod exige un
 * `montantRegle` fourni quand `statut === "partiel"` ; le repository remet le montant
 * réglé à NULL pour tout autre statut.
 */
export async function changerStatutEcheanceAction(input: {
  echeanceId: string;
  statut: "en_cours" | "partiel" | "paiement_en_cours" | "payee" | "annulee";
  montantRegle?: string | null;
}): Promise<ResultatAction> {
  const session = await exigerSessionWorkspace();
  const parsed = changerStatutEcheanceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    await withWorkspace(session, (tx, ctx) =>
      changerStatutEcheance(tx, ctx, parsed.data),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "changer-statut-echeance");
  }
}

/** Supprime une échéance (donnée de projection, non append-only — ECH-D3). */
export async function supprimerEcheanceAction(
  echeanceId: string,
): Promise<ResultatAction> {
  const session = await exigerSessionWorkspace();
  const parsed = supprimerEcheanceSchema.safeParse({ echeanceId });
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    await withWorkspace(session, (tx, ctx) =>
      supprimerEcheance(tx, ctx, parsed.data.echeanceId),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "supprimer-echeance");
  }
}
