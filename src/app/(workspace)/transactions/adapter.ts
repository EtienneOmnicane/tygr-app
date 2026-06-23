/**
 * Adaptateur Backend → UI pour la page /transactions. Réconcilie le contrat du
 * repository (`@/server/repositories/transactions`, `@/lib/transactions-schema`)
 * avec le contrat présentationnel UI (`@/components/transactions`).
 *
 * Pourquoi un adaptateur (et pas un branchement « 1 ligne ») : Backend et UI ont
 * été conçus en parallèle (contrat-first) et divergent sur quelques points qu'on
 * réconcilie ICI, en un seul endroit testable, plutôt que de tordre l'UI :
 *  - statut : Backend `NON_CATEGORISE|PARTIEL|COMPLET` → UI `non_categorise|…` ;
 *  - `compteNom` : absent de la ligne Backend (que `bankAccountId`) → résolu via la
 *    map des comptes déjà chargés en page (pas de requête en plus) ;
 *  - `categorie {id,name}` : Backend ne renvoie pas LA catégorie unique, juste
 *    `nbSplits` → on n'affiche un badge nommé que si on le sait ; sinon le badge de
 *    comptage générique (« 1 catégorie » / « N catégories ») via `nbCategories` ;
 *  - libellé : cascade marchand → catégorie FR → brut bancaire → repli générique
 *    (`resoudreLibelle`, source unique). Le brut (`bankLabelRaw`) n'est plus masqué
 *    (arbitrage produit 2026-06-23 : utilisabilité > interdiction PII stricte) ; il
 *    sert d'ultime filet visuel ET d'infobulle `title` (cf. `transaction-row.tsx`) ;
 *  - filtre `sens` : NON supporté par le schéma Backend (.strict, pas de champ) →
 *    non transmis (cf. toolbar v1 sans Sens, tracé TODOS TX-FILTRE1).
 *
 * Ce module est du code SERVEUR (importé par le RSC page.tsx). Il ne crée aucune
 * Server Action ni schéma (frontière Backend respectée) — il ne fait que CONVERTIR.
 */
import type {
  PageTransactions as PageBackend,
  TransactionLigne,
} from "@/server/repositories/transactions";
import type {
  ListerTransactionsInput,
  StatutVentilation,
} from "@/lib/transactions-schema";

import type {
  FiltresTransactions,
  PageTransactions,
  StatutCategorisation,
  TransactionListItem,
} from "@/components/transactions/types-transactions";

import { categorieFr, CATEGORIE_FR_PAR_DEFAUT } from "@/lib/categories-fr";
import { resoudreLibelle } from "@/components/transactions/libelle-transaction";

/** Map statut serveur (MAJ) → statut UI (minuscules). */
const STATUT_UI: Record<StatutVentilation, StatutCategorisation> = {
  NON_CATEGORISE: "non_categorise",
  PARTIEL: "partiel",
  COMPLET: "complet",
};

/** Map statut UI → statut serveur (pour le filtre). */
const STATUT_BACKEND: Record<StatutCategorisation, StatutVentilation> = {
  non_categorise: "NON_CATEGORISE",
  partiel: "PARTIEL",
  complet: "COMPLET",
};

/**
 * Convertit les filtres UI + curseur en entrée du schéma Backend. Le `sens` UI
 * n'est PAS transmis (non supporté serveur). `curseur` null/absent = première page.
 */
export function versInputBackend(
  filtres: FiltresTransactions | undefined,
  curseur: string | null | undefined,
): Partial<ListerTransactionsInput> {
  const input: Partial<ListerTransactionsInput> = {};
  if (filtres?.bankAccountId) input.bankAccountId = filtres.bankAccountId;
  if (filtres?.statutCategorisation) {
    input.statut = STATUT_BACKEND[filtres.statutCategorisation];
  }
  if (curseur) input.curseur = curseur;
  return input;
}

/**
 * Convertit une ligne Backend en ligne d'affichage UI, en résolvant le nom du
 * compte via la map fournie (id → nom).
 */
export function versLigneUI(
  ligne: TransactionLigne,
  nomParCompte: Map<string, string>,
): TransactionListItem {
  const statut = STATUT_UI[ligne.statut];
  const categorieBanque = traduireCategorieBanque(ligne.primaryCategory);
  return {
    transactionId: ligne.id,
    transactionDate: ligne.transactionDate,
    // `label` (plat, pour l'aria) = MÊME cascade que le rendu visuel (marchand →
    // catégorie FR → brut bancaire → repli générique), via `resoudreLibelle` : l'aria
    // annonce EXACTEMENT le texte vu à l'écran (pas le brut quand un marchand/catégorie
    // l'a remplacé). Le rendu typographié (plein vs atténué) est, lui, dans le composant.
    label: resoudreLibelle({
      cleanLabel: ligne.cleanLabel,
      categorieFr: categorieBanque,
      bankLabelRaw: ligne.bankLabelRaw,
    }).texte,
    cleanLabel: ligne.cleanLabel,
    bankLabelRaw: ligne.bankLabelRaw,
    // Catégorie OBIE traduite en FR (résolue plus haut, réutilisée pour le `label`).
    // `null` (= pas de sous-texte, et niveau 2 de cascade inactif) quand la catégorie
    // est absente OU non cartographiée : `categorieFr` retombe sur « Non catégorisé »
    // dans ces deux cas, mais l'afficher ici se confondrait avec le statut de
    // VENTILATION manuelle (concept distinct) — et le remonter en libellé principal
    // serait un faux « marchand ».
    categorieBanque,
    compteNom: nomParCompte.get(ligne.bankAccountId) ?? "Compte",
    montantAbs: depouillerSigne(ligne.amount),
    devise: ligne.currency,
    sens: ligne.creditDebit,
    bankAccountId: ligne.bankAccountId,
    statutCategorisation: statut,
    // Backend ne renvoie pas la catégorie unique → badge de comptage générique.
    categorie: null,
    nbCategories: ligne.nbSplits,
  };
}

/** Convertit une page Backend complète en page UI. */
export function versPageUI(
  page: PageBackend,
  nomParCompte: Map<string, string>,
): PageTransactions {
  return {
    lignes: page.lignes.map((l) => versLigneUI(l, nomParCompte)),
    // hasMore décide de la présence d'une page suivante ; curseur null si dernière.
    curseurSuivant: page.hasMore ? page.curseurSuivant : null,
  };
}

/** Retire un éventuel signe « - » de tête (le montant UI est ABSOLU, signe via sens). */
function depouillerSigne(montant: string): string {
  const t = montant.trim();
  return t.startsWith("-") ? t.slice(1) : t;
}

/**
 * Traduit la catégorie OBIE pour l'affichage, ou `null` si rien d'utile à montrer.
 * `categorieFr` renvoie toujours une chaîne (« Non catégorisé » par défaut) ; ici on
 * REJETTE ce défaut vers `null` pour ne pas afficher un sous-texte trompeur quand la
 * catégorie est absente ou non cartographiée (cf. `versLigneUI`).
 */
function traduireCategorieBanque(primaryCategory: string | null): string | null {
  if (!primaryCategory?.trim()) return null;
  const fr = categorieFr(primaryCategory);
  return fr === CATEGORIE_FR_PAR_DEFAUT ? null : fr;
}
