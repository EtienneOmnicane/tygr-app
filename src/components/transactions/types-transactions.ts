/**
 * CONTRAT PARTAGÉ UI ↔ Backend pour la LISTE des transactions (page /transactions).
 *
 * Frontière (mémoire `gouvernance-frontiere-ui`) : l'Agent UI code la page contre
 * cette interface (deps injectables, pattern éprouvé sur la modale de ventilation) ;
 * le Backend implémente le repository paginé + la Server Action. Ce fichier est la
 * LISTE DE COURSES B1-B3 transmise au Backend (cf. PLAN-transactions-page.md §1).
 *
 * Types alignés sur `server/repositories/dashboard.ts` (`TransactionRecente`,
 * `transactionsRecentes`) et le schéma `transactions_cache`. Montants = chaînes
 * décimales (règle 8, jamais de float) ; le signe vit sur `sens`, `montantAbs` est
 * toujours la valeur ABSOLUE > 0 (la couleur sémantique est appliquée à l'affichage).
 *
 * Réutilise `ResultatAction` du contrat catégorisation (DRY) — même forme normalisée.
 */
import type { ResultatAction, SplitUI } from "@/components/ui/category";

/**
 * Statut de ventilation (catégorisation MANUELLE) d'une transaction, résumé pour la
 * LISTE (B2, option éco — cf. plan §1). Le DÉTAIL des splits est chargé à l'ouverture
 * de la modale via `listerSplits` (existant), pas dans la liste.
 *
 * - `non_categorise` : aucun split manuel (0 catégorie).
 * - `partiel` : somme des splits < |montant| (reste à ventiler).
 * - `complet` : somme des splits = |montant| (entièrement ventilée).
 *
 * NB : indépendant de `primaryCategory`/`subCategory` (catégories OBIE AUTO de la
 * banque) — ici c'est la ventilation de L'UTILISATEUR.
 */
export type StatutCategorisation = "non_categorise" | "partiel" | "complet";

/**
 * Une ligne de la liste des transactions (DTO d'affichage). Miroir enrichi de
 * `TransactionRecente` (dashboard) + le résumé de ventilation (B2).
 */
export interface TransactionListItem {
  /** = `transactions_cache.id` (clé composite avec `transactionDate`). */
  transactionId: string;
  /** Date comptable Maurice YYYY-MM-DD (E20). */
  transactionDate: string;
  /**
   * Libellé d'affichage résolu (`cleanLabel`, sinon `bankLabelRaw`, sinon repli
   * générique). Sert notamment à l'`aria-label` de la ligne, qui ne doit jamais
   * être vide. JAMAIS en log/télémétrie. Le RENDU visuel passe par `cleanLabel` +
   * `bankLabelRaw` (pour distinguer marchand / brut / repli) — `label` reste plat.
   */
  label: string;
  /**
   * Marchand normalisé Omni-FI BRUT (`null` si l'enrichissement ne l'a pas résolu).
   * Pilote le rendu : non-null ⇒ marchand en `text-text` ; null ⇒ on tente le repli
   * `bankLabelRaw` avant le générique. JAMAIS loggé.
   */
  cleanLabel: string | null;
  /**
   * Libellé brut bancaire (OBIE TransactionInformation), `null` si absent. REPLI
   * d'affichage quand `cleanLabel` est null (décision produit 2026-06-23 : montrer
   * le narratif brut plutôt qu'un « Opération bancaire » générique). Rendu atténué
   * pour le distinguer d'un marchand propre. JAMAIS loggé.
   */
  bankLabelRaw: string | null;
  /**
   * Catégorie OBIE de la banque (`primaryCategory`), DÉJÀ traduite en français par
   * l'adaptateur (`categorieFr`). Affichée en sous-texte du libellé. `null` si la
   * catégorie est absente ou non cartographiée (l'adaptateur n'affiche alors rien —
   * il ne fabrique pas un « Non catégorisé » qui se confondrait avec le statut de
   * ventilation). NB : distinct de `statutCategorisation` (ventilation MANUELLE).
   */
  categorieBanque: string | null;
  /** Nom du compte porteur (sous-texte de la ligne). */
  compteNom: string;
  /** Montant ABSOLU, chaîne décimale > 0 (le signe est porté par `sens`). */
  montantAbs: string;
  /** Devise ISO (MUR/USD/EUR). */
  devise: string;
  /** Sens bancaire — pilote la couleur sémantique du montant (Credit=inflow, Debit=outflow). */
  sens: "Credit" | "Debit";
  /** Compte porteur (pour le filtre et le rechargement ciblé). */
  bankAccountId: string;
  /** Résumé de ventilation manuelle (B2). */
  statutCategorisation: StatutCategorisation;
  /**
   * Si EXACTEMENT une catégorie ventilée : de quoi afficher 1 badge sans requête
   * supplémentaire. Null si 0 ou >1 catégorie (→ « Non catégorisé » ou « N catégories »).
   */
  categorie: { id: string; name: string } | null;
  /** Nombre de catégories distinctes ventilées (0, 1, ou N). Décide le rendu du badge. */
  nbCategories: number;
}

/**
 * Curseur de pagination (B1) — pagination par CURSEUR, pas OFFSET. OPAQUE côté UI :
 * le Backend l'encode en chaîne base64url (détail interne : `transaction_date|id`) ;
 * l'UI ne le décode jamais, elle le renvoie tel quel pour la page suivante. Aligné
 * sur le contrat serveur livré (`PageTransactions.curseurSuivant: string | null`).
 */
export type CurseurTransactions = string;

/**
 * Filtres optionnels de la liste (B1). Tous nullables = « pas de filtre ».
 * NB : pas de filtre `sens` (Entrées/Sorties) — non supporté par le schéma de
 * lecture Backend v1 ; le filtrer côté client casserait la pagination (TX-FILTRE1).
 */
export interface FiltresTransactions {
  /** Restreindre à un compte connecté. */
  bankAccountId?: string;
  /** Restreindre par statut de ventilation. */
  statutCategorisation?: StatutCategorisation;
}

/** Une page de résultats (B1). `curseurSuivant` null = dernière page. */
export interface PageTransactions {
  lignes: TransactionListItem[];
  curseurSuivant: CurseurTransactions | null;
}

/**
 * Surface d'action injectée à la page (B3). Le Backend fournit l'implémentation
 * (Server Action `listerTransactionsAction`) ; la démo/tests fournissent un stub.
 * Scopée au workspace courant côté serveur (withWorkspace) — l'UI ne passe JAMAIS
 * de workspace_id.
 */
export interface ActionsTransactions {
  /**
   * Lit une page de transactions. `curseur` absent/null = première page.
   * À LIVRER côté serveur (le repository n'a que `transactionsRecentes`, plafonné à
   * 8, sans pagination ni filtre).
   */
  listerTransactions(args: {
    curseur?: CurseurTransactions | null;
    filtres?: FiltresTransactions;
  }): Promise<ResultatAction<PageTransactions>>;
  /**
   * Détail des splits d'une transaction, chargé À L'OUVERTURE de la modale de
   * ventilation (la liste ne porte qu'un RÉSUMÉ — B2 option éco). Pont vers
   * `listerSplitsAction` (B3bis, livrée).
   *
   * ⚠️ PEUT LEVER : en cas d'échec, l'action serveur LÈVE une exception plutôt que
   * de renvoyer `[]` — sinon la modale s'ouvrirait sur un état faussement vide et un
   * « Valider » écraserait les splits existants. L'appelant DOIT try/catch et NE PAS
   * ouvrir la modale en cas d'erreur (cf. `ouvrirVentilation` du conteneur).
   */
  chargerSplits(ref: {
    transactionId: string;
    transactionDate: string;
  }): Promise<SplitUI[]>;
}
