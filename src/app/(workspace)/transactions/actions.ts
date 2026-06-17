"use server";

/**
 * Server Actions de la catégorisation manuelle (Pilier 1). Surface d'appel UI
 * par-dessus le repository scopé `@/server/repositories/categorisation`. Elles
 * câblent session + withWorkspace ; elles ne touchent jamais la DB directement.
 *
 * Contrat : `src/components/ui/category/types.ts` (ActionsCategorisation +
 * ActionsReferentielCategories). Retour normalisé `ResultatAction` (jamais
 * d'exception propagée au client) — on mappe les erreurs nommées en
 * { ok:false, code, message } non-énumérant (registre S2).
 *
 * Exit-criteria (CLAUDE.md règle 3) :
 * - Authz : exigerSessionWorkspace + withWorkspace (membership re-validée à
 *   chaque requête). Gating : la catégorisation ET le CRUD du référentiel sont
 *   OUVERTS à tous les membres du workspace, VIEWER inclus (décision PO
 *   2026-06-17, cohérente entre splits et référentiel) — la RLS WITH CHECK sur
 *   workspace_id suffit, aucun filtre de rôle.
 * - Validation Zod stricte des entrées (montants décimaux, uuid, bornes).
 * - workspace_id JAMAIS un paramètre client (vient de ctx).
 * - Logs corrélés (workspace_id + code machine, sans PII/montant brut).
 */
import {
  exigerSessionWorkspace,
  ServiceIndisponibleError,
} from "@/server/auth/session";
import {
  CategorieIntrouvableError,
  TransactionIntrouvableError,
  VentilationDepasseError,
  archiverCategorie,
  creerCategorie,
  listerCategories,
  remplacerSplits,
  renommerCategorie,
  withWorkspace,
} from "@/server/db";
import {
  archiverCategorieSchema,
  creerCategorieSchema,
  remplacerSplitsSchema,
  renommerCategorieSchema,
} from "@/lib/categorisation-schema";

/** Résultat normalisé (miroir de `ResultatAction` du contrat UI). */
export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

export interface CategorieDTO {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
}

const MSG_PARAMS = "Paramètres invalides.";

/**
 * Mappe une erreur en ResultatAction non-énumérant + log corrélé sûr (sans PII
 * ni montant brut). Codes machine stables pour le mapping UI (registre S2).
 */
function echec(
  erreur: unknown,
  workspaceId: string,
  action: string,
): { ok: false; code: string; message: string } {
  let code = "ERREUR";
  let message = "L’opération a échoué. Réessayez.";
  if (erreur instanceof VentilationDepasseError) {
    code = erreur.code; // VENTILATION_EXCEEDS_AMOUNT
    message = "La somme des catégorisations dépasse le montant de la transaction.";
  } else if (erreur instanceof TransactionIntrouvableError) {
    code = erreur.code; // TRANSACTION_NOT_FOUND
    message = "Transaction introuvable.";
  } else if (erreur instanceof CategorieIntrouvableError) {
    code = erreur.code; // CATEGORY_NOT_FOUND
    message = "Catégorie introuvable.";
  } else if (erreur instanceof ServiceIndisponibleError) {
    code = "SERVICE_UNAVAILABLE";
    message = "Service momentanément indisponible.";
  }
  console.warn(
    JSON.stringify({ evt: "categorisation_echec", action, workspaceId, code }),
  );
  return { ok: false, code, message };
}

/** Lecture des catégories actives du workspace (pour les pickers). */
export async function listerCategoriesAction(): Promise<CategorieDTO[]> {
  const session = await exigerSessionWorkspace();
  return withWorkspace(session, (tx, ctx) => listerCategories(tx, ctx));
}

/**
 * Remplace ATOMIQUEMENT l'ensemble des splits d'une transaction par l'état cible
 * (tout-ou-rien dans la transaction withWorkspace). Re-valide la somme côté
 * serveur. Le client envoie `{ categoryId, amount }[]` (toujours MANUEL).
 */
export async function remplacerSplitsAction(
  ref: { transactionId: string; transactionDate: string },
  splits: Array<{ categoryId: string; amount: string }>,
): Promise<ResultatAction> {
  const session = await exigerSessionWorkspace();
  const parsed = remplacerSplitsSchema.safeParse({ ...ref, splits });
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    await withWorkspace(session, (tx, ctx) =>
      remplacerSplits(
        tx,
        ctx,
        {
          transactionId: parsed.data.transactionId,
          transactionDate: parsed.data.transactionDate,
        },
        parsed.data.splits,
      ),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "remplacer-splits");
  }
}

/** Crée une catégorie (Nature si parentId nul, sinon Sous-nature). */
export async function creerCategorieAction(input: {
  name: string;
  parentId: string | null;
}): Promise<ResultatAction<{ categoryId: string }>> {
  const session = await exigerSessionWorkspace();
  const parsed = creerCategorieSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    const r = await withWorkspace(session, (tx, ctx) =>
      creerCategorie(tx, ctx, parsed.data),
    );
    return { ok: true, data: r };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "creer-categorie");
  }
}

/** Renomme une catégorie du workspace courant. */
export async function renommerCategorieAction(input: {
  categoryId: string;
  name: string;
}): Promise<ResultatAction> {
  const session = await exigerSessionWorkspace();
  const parsed = renommerCategorieSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    await withWorkspace(session, (tx, ctx) =>
      renommerCategorie(tx, ctx, parsed.data),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "renommer-categorie");
  }
}

/** Archive une catégorie (is_active=false) — jamais de suppression physique. */
export async function archiverCategorieAction(
  categoryId: string,
): Promise<ResultatAction> {
  const session = await exigerSessionWorkspace();
  const parsed = archiverCategorieSchema.safeParse({ categoryId });
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    await withWorkspace(session, (tx, ctx) =>
      archiverCategorie(tx, ctx, parsed.data.categoryId),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "archiver-categorie");
  }
}
