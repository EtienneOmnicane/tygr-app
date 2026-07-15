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
 *  - `categorie {id,name}` : le Backend renvoie la catégorie DOMINANTE de la
 *    ventilation (`categorieDominanteId/Nom`, part au plus gros montant) → badge
 *    NOMMÉ (mono : le nom ; multi : « Nom +N ») ; repli comptage générique si
 *    absente (FB0709-TX-CATEGORIE-VISIBLE1) ;
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
  SommeNetteDevise as SommeNetteDeviseBackend,
  TransactionLigne,
} from "@/server/repositories/transactions";
import type {
  ListerTransactionsInput,
  SommeNetteInput,
  StatutVentilation,
} from "@/lib/transactions-schema";

import type {
  FiltresTransactions,
  NiveauFiabilite,
  PageTransactions,
  SommeNetteDevise,
  SourceClassification,
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
 * Bornes de la FENÊTRE de dates GLOBALE (barre de vue), déjà résolues et validées par
 * `resoudrePeriode` (`src/lib/periode.ts` — source unique : fuseau Maurice, plage
 * `?du`/`?au` primant sur preset, garde `from ≤ to`). Dates comptables Maurice
 * `YYYY-MM-DD`, INCLUSIVES.
 */
export interface PeriodeBornes {
  from: string;
  to: string;
}

/**
 * Convertit les filtres UI + curseur + la fenêtre de dates GLOBALE en entrée du schéma
 * Backend. Le `sens` UI n'est PAS transmis (non supporté serveur). `curseur` null/absent
 * = première page.
 *
 * ⚠️ La fenêtre de dates n'est PLUS un filtre in-page (TX-TOOLBAR-DEDUP1) : elle arrive
 * de la barre globale via `periode` (injectée par le RSC `page.tsx`), jamais de `filtres`.
 * On la traduit en `dateDebut`/`dateFin` (WHERE gte/lte serveur sur `transaction_date`,
 * qui EST déjà la date Maurice — E20, aucune conversion ici). `periode` absente (surface
 * sans période : stub de démo/tests) ⇒ aucune borne (comportement « tout »).
 */
export function versInputBackend(
  filtres: FiltresTransactions | undefined,
  curseur: string | null | undefined,
  periode?: PeriodeBornes,
): Partial<ListerTransactionsInput> {
  const input: Partial<ListerTransactionsInput> = {};
  // Recherche : passe-plat direct sur cleanLabel (ILIKE serveur, méta-caractères
  // LIKE échappés côté repository). La toolbar ne remonte jamais une chaîne vide
  // (→ undefined), donc pas de garde ici ; Zod re-valide trim/min1/max120.
  if (filtres?.recherche) input.recherche = filtres.recherche;
  if (filtres?.statutCategorisation) {
    input.statut = STATUT_BACKEND[filtres.statutCategorisation];
  }
  // Fenêtre GLOBALE → bornes de date (même format YYYY-MM-DD des deux côtés). Zod
  // re-valide forme + validité calendaire + intervalle ; `resoudrePeriode` garantit
  // déjà `from ≤ to`, donc jamais de rejet ici.
  if (periode) {
    input.dateDebut = periode.from;
    input.dateFin = periode.to;
  }
  if (curseur) input.curseur = curseur;
  return input;
}

/**
 * Filtres de l'AGRÉGAT de somme nette (TX-RECHERCHE-SOMME-NETTE1) : EXACTEMENT la même
 * projection de filtres que la liste, mais SANS curseur ni limite.
 *
 * On DÉRIVE de `versInputBackend` au lieu de recopier les champs : le total affiché doit
 * porter les mêmes lignes que la liste affichée, donc un futur filtre ajouté à la liste
 * DOIT atterrir mécaniquement dans la somme. Le recopier ouvrirait une divergence
 * silencieuse (un filtre appliqué à la liste mais pas au total = faux chiffre).
 *
 * Le retrait de `curseur`/`limite` est EXPLICITE : une somme porte sur TOUT le jeu
 * filtré, jamais sur une page (piège TX-FILTRE1), et `sommeNetteSchema` est `.strict()`
 * — un curseur égaré ferait échouer l'agrégat en INVALID_PARAMS. `versInputBackend(f,
 * null, periode)` n'en pose aucun aujourd'hui ; ces deux lignes FIGENT l'invariant au
 * lieu de dépendre de sa relecture.
 *
 * La fenêtre GLOBALE (`periode`) descend par le MÊME `versInputBackend` : la somme est
 * donc bornée à la période EXACTEMENT comme la liste (un total qui ne totaliserait pas
 * la même fenêtre que les lignes affichées serait un faux chiffre).
 */
export function versFiltresSommeNette(
  filtres: FiltresTransactions | undefined,
  periode?: PeriodeBornes,
): Partial<SommeNetteInput> {
  const input = versInputBackend(filtres, null, periode);
  delete input.curseur;
  delete input.limite;
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
    // Catégorie DOMINANTE de la ventilation (FB0709-TX-CATEGORIE-VISIBLE1) : badge
    // NOMMÉ dès qu'elle est connue (mono → LE nom ; multi → « Nom +N » côté badge).
    // Repli null (comptage générique) si le Backend ne l'a pas résolue.
    categorie:
      ligne.categorieDominanteId && ligne.categorieDominanteNom
        ? { id: ligne.categorieDominanteId, name: ligne.categorieDominanteNom }
        : null,
    nbCategories: ligne.nbSplits,
    // Métadonnées de fiabilité amont (TECH-API-TRACE) NORMALISÉES vers des unions :
    // toute valeur brute inattendue (la colonne est sans CHECK côté DB) retombe sur
    // `null` → l'UI ne voit jamais de chaîne libre et reste insensible aux nouveautés API.
    niveauFiabilite: normaliserNiveauFiabilite(ligne.confidenceLevel),
    sourceClassification: normaliserSourceClassification(ligne.classificationSource),
  };
}

/**
 * Convertit les TOTAUX Backend en totaux UI. Seule réconciliation : `currency` → `devise`
 * (le contrat UI de cette page est en français — `devise`, `montantAbs`, `sens`).
 *
 * AUCUN recalcul, aucune addition : les montants sont des chaînes décimales DÉJÀ sommées
 * en SQL (règle 8 — un `parseFloat` ici perdrait des centimes, et re-sommer côté client
 * ne verrait de toute façon qu'une page).
 */
export function versSommeNetteUI(
  totaux: SommeNetteDeviseBackend[],
): SommeNetteDevise[] {
  return totaux.map((t) => ({
    devise: t.currency,
    entrees: t.entrees,
    sorties: t.sorties,
    net: t.net,
    nbTransactions: t.nbTransactions,
  }));
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

/**
 * Normalise le `confidence_level` BRUT amont (chaîne libre, colonne sans CHECK) vers
 * l'union `NiveauFiabilite`, ou `null` si absent/non reconnu. Robuste à la casse et aux
 * espaces (la trace amont est fidèle mais on ne suppose pas une casse fixe). Toute valeur
 * hors des trois niveaux connus → `null` : l'UI ne décide rien sur une valeur qu'elle ne
 * comprend pas (pas de badge erroné), et reste insensible à une nouveauté d'API.
 */
function normaliserNiveauFiabilite(brut: string | null): NiveauFiabilite | null {
  switch (brut?.trim().toLowerCase()) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return null;
  }
}

/**
 * Normalise la `classification_source` BRUTE amont vers l'union `SourceClassification`,
 * ou `null` si absente/non reconnue. Même principe défensif que ci-dessus. NB :
 * `USER_RULE` = règle Omni-FI (concept C), à ne pas confondre avec la ventilation
 * manuelle TYGR (concept A) — la distinction est portée par les libellés d'infobulle UI.
 */
function normaliserSourceClassification(
  brut: string | null,
): SourceClassification | null {
  switch (brut?.trim().toUpperCase()) {
    case "USER_RULE":
      return "USER_RULE";
    case "SYSTEM_RULE":
      return "SYSTEM_RULE";
    case "ML_FALLBACK":
      return "ML_FALLBACK";
    default:
      return null;
  }
}
