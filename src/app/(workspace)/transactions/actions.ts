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
  CurseurInvalideError,
  type PageTransactions,
  type RefTransaction,
  type SplitLu,
  TransactionIntrouvableError,
  VentilationDepasseError,
  archiverCategorie,
  creerCategorie,
  listerCategories,
  listerSplits,
  listerTransactions,
  remplacerSplits,
  renommerCategorie,
  withWorkspace,
} from "@/server/db";
import {
  archiverCategorieSchema,
  creerCategorieSchema,
  refTransactionSchema,
  remplacerSplitsSchema,
  renommerCategorieSchema,
} from "@/lib/categorisation-schema";
import {
  type ListerTransactionsInput,
  listerTransactionsSchema,
} from "@/lib/transactions-schema";

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
  } else if (erreur instanceof CurseurInvalideError) {
    code = erreur.code; // INVALID_CURSOR
    message = "Page demandée invalide.";
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

/** Split renvoyé au client (miroir de `SplitUI` du contrat UI). */
export interface SplitDTO {
  id: string;
  categoryId: string;
  amount: string;
  source: SplitLu["source"];
  ruleId: string | null;
}

/**
 * Lecture des splits existants d'UNE transaction (TX-B3bis), pour PRÉ-REMPLIR la
 * modale de ventilation à son ouverture. Contrat UI : `listerSplits(ref) →
 * Promise<SplitUI[]>` (tableau DIRECT, pas d'enveloppe ResultatAction — cohérent
 * avec listerCategoriesAction).
 *
 * SÉCURITÉ DONNÉES (raison d'être de ce ticket) : si la lecture échoue (ref
 * invalide ou panne), on LÈVE une exception au lieu de renvoyer `[]`. Un `[]`
 * silencieux ferait croire à la modale « 0 split » sur une transaction pourtant
 * ventilée → un clic « Valider » la dé-catégoriserait (remplacerSplits([])). Le
 * Front DOIT distinguer « pas de split » de « chargement impossible » : la 1re est
 * un tableau vide légitime, la 2de une exception (modale non ouverte en mode vide).
 *
 * Authz : exigerSessionWorkspace + withWorkspace ; la RLS scope `listerSplits` au
 * workspace courant → une ref d'un autre tenant renvoie simplement 0 ligne (jamais
 * de fuite). `workspace_id` n'est JAMAIS un paramètre client.
 */
export async function listerSplitsAction(
  ref: RefTransaction,
): Promise<SplitDTO[]> {
  const session = await exigerSessionWorkspace();
  const parsed = refTransactionSchema.safeParse(ref);
  if (!parsed.success) {
    // Ref malformée = bug d'intégration (la ref vient de notre propre liste), pas
    // un cas utilisateur. On échoue BRUYAMMENT plutôt que de masquer en `[]`.
    console.warn(
      JSON.stringify({
        evt: "categorisation_echec",
        action: "lister-splits",
        workspaceId: session.activeWorkspaceId,
        code: "INVALID_PARAMS",
      }),
    );
    throw new Error("Référence de transaction invalide.");
  }
  return withWorkspace(session, (tx, ctx) => listerSplits(tx, ctx, parsed.data));
}

/**
 * Lecture paginée (par CURSEUR) des transactions du workspace, avec résumé de
 * ventilation par ligne (anti-N+1, cf. repository). Surface d'appel de la page
 * /transactions. Retour normalisé `ResultatAction` : un curseur falsifié devient
 * une entrée invalide (jamais d'exception propagée au client).
 *
 * `filtres` est l'objet brut côté UI (recherche, compte, statut, dates, curseur,
 * limite) — validé/normalisé par Zod ici. Le workspace n'est JAMAIS un paramètre.
 */
export async function listerTransactionsAction(
  filtres: Partial<ListerTransactionsInput> = {},
): Promise<ResultatAction<PageTransactions>> {
  const session = await exigerSessionWorkspace();
  const parsed = listerTransactionsSchema.safeParse(filtres);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    const page = await withWorkspace(session, (tx, ctx) =>
      listerTransactions(tx, ctx, parsed.data),
    );
    return { ok: true, data: page };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "lister-transactions");
  }
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
