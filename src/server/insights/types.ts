/**
 * DTO internes des Insights financiers DÉRIVÉS (TECH-API-INSIGHTS, Voie A).
 *
 * Contexte (audit de faisabilité Staging, 2026-06-24) : le module amont Omni-FI
 * `/insights/*` renvoie `501 NOT_IMPLEMENTED` sur TOUS ses endpoints (cashflow,
 * vendors, alerts, dashboard/insights), même sans authentification — le module
 * n'est pas livré. On NE consomme donc PAS l'API : on DÉRIVE cashflow et vendors
 * de `transactions_cache` (déjà ingérée, colonnes suffisantes). Cf. dette
 * INSIGHTS-AMONT1 (TODOS.md) — à revérifier au passage 501→200.
 *
 * Ces types sont NÔTRES (domaine TYGR), pas un miroir du schéma Omni-FI (inconnu :
 * un 501 ne révèle aucun payload de succès). Le jour où l'API livre le module, un
 * mapping amont SÉPARÉ produira ces MÊMES types (frontière `mapDepuisOmniFi`), de
 * sorte que l'UI ne voie jamais la bascule (provisionné, NON implémenté ici).
 *
 * Règle 8 (montants) : tout montant est une CHAÎNE décimale (agrégat calculé EN SQL,
 * jamais d'addition de floats côté JS) ; l'UI formate via format-montant.ts sans
 * recalcul. `part` (fraction d'un total) est aussi une chaîne décimale — pas un
 * float — pour ne pas perdre de précision avant l'affichage.
 *
 * Multi-devises (CLAUDE.md) : une ligne/point PAR devise, JAMAIS d'addition
 * cross-devise, aucune conversion FX (chantier DASH-FX1). Tombstones (is_removed)
 * exclus. Fuseau Maurice : les buckets s'appuient sur `transaction_date` (déjà date
 * comptable Maurice à l'ingestion, E20) — pas de re-conversion de fuseau.
 */

/** Granularité temporelle d'un bucket de cashflow (valeurs FR, enum fermée). */
export type GranulariteCashflow = "jour" | "semaine" | "mois";

/** Sens d'analyse de la concentration des contreparties (vendors). */
export type DirectionVendors = "inflow" | "outflow" | "both";

/**
 * Un point de la série cashflow, pour UN bucket temporel ET UNE devise. `net` =
 * `entrees` − `sorties` (soustraction EN SQL, numeric → chaîne). `bucket` est une
 * étiquette stable : "YYYY-MM-DD" (jour), "YYYY-MM-DD" du lundi (semaine, tronqué
 * `date_trunc('week')`), "YYYY-MM" (mois).
 */
export interface PointCashflow {
  bucket: string;
  currency: string;
  entrees: string; // somme des montants Credit (chaîne décimale)
  sorties: string; // somme des montants Debit (chaîne décimale)
  net: string; // entrees − sorties (chaîne décimale)
  nbTransactions: number;
}

/** Série cashflow complète sur une fenêtre, multi-devise (points triés). */
export interface SerieCashflow {
  granularite: GranulariteCashflow;
  /** Points triés (bucket croissant, puis devise) — JAMAIS d'addition cross-devise. */
  points: PointCashflow[];
}

/**
 * Une contrepartie agrégée (vendor), pour UNE devise. `montant` est le total signé
 * selon `direction` (somme des Debit pour outflow, des Credit pour inflow). `part` =
 * fraction du total de la devise (0..1) en CHAÎNE décimale. `contrepartie` est le
 * libellé NETTOYÉ (clean_label) ; jamais `bank_label_raw` (PII, règle 8). Si le
 * libellé nettoyé est absent, repli sur `primary_category`, sinon "(Sans libellé)".
 */
export interface LigneVendor {
  contrepartie: string;
  currency: string;
  montant: string; // total décimal (sens selon direction)
  part: string; // fraction 0..1 du total de la devise (chaîne décimale)
  nbTransactions: number;
}

/** Concentration des contreparties, multi-devise (lignes triées montant décroissant). */
export interface ConcentrationVendors {
  direction: DirectionVendors;
  /** Lignes triées par montant décroissant (top N borné), groupées par devise. */
  lignes: LigneVendor[];
}

/**
 * Sens d'analyse d'un camembert de répartition par catégorie. VOLONTAIREMENT sans
 * `both` (≠ vendors) : un donut mélangeant crédits et débits (signes opposés) n'a
 * pas de sens — on répartit soit les ENTRÉES (Credit) soit les SORTIES (Debit).
 */
export type SensFlux = "inflow" | "outflow";

/**
 * ESPACE DE NOMS d'une part du camembert — d'où vient la catégorie affichée (D2=c,
 * `DECISION-categorysummary-amont-vs-interne.md`) :
 *
 *  - `TYGR`  : ventilation de l'utilisateur (split `transaction_categorizations`,
 *              source MANUAL ou RULE) → « votre catégorie ». `categorieId` renseigné.
 *  - `AMONT` : reliquat NON ventilé imputé à la catégorie bancaire Omni-FI
 *              (`primary_category` traduite) → « catégorie bancaire ».
 *  - `AUCUNE`: reliquat non ventilé d'une transaction que la banque n'étiquette pas
 *              (NULL/''/sentinelle/hors catalogue) → poste « Non catégorisé ».
 *
 * CE N'EST PAS COSMÉTIQUE : « Loyer » créé par l'utilisateur et un « Loyer » venu de
 * la banque sont DEUX clés distinctes. L'origine entre donc dans la clé de groupe ET
 * dans la clé de merge L4 — sans elle, deux espaces de noms fusionneraient
 * silencieusement dans un même secteur.
 */
export type OrigineCategorie = "TYGR" | "AMONT" | "AUCUNE";

/**
 * Une part de camembert = une catégorie, DANS UNE devise. `montant` = somme des
 * montants (magnitude positive, le sens est fixé par le filtre) en CHAÎNE décimale
 * (agrégat SQL, règle 8). `part` = fraction du total de SA devise (0..1, chaîne).
 *
 * `categorie` est la catégorie EFFECTIVE (cascade `splits > primary_category`, cf.
 * `axeCategorieEffective`) : le nom de la catégorie TYGR pour la fraction ventilée, le
 * libellé bancaire FR pour le reliquat. `estNonCategorise=true` (⟺ `origine="AUCUNE"`)
 * marque le poste « Non catégorisé » — rendu neutre, trié en dernier.
 */
export interface PartCategorie {
  categorie: string;
  estNonCategorise: boolean;
  montant: string; // sum(amount) — chaîne décimale
  part: string; // fraction 0..1 du total de la devise — chaîne décimale
  /**
   * Nombre de transactions DISTINCTES contribuant à cette part (D-f) — PAS le nombre
   * de lignes agrégées : une transaction ventilée sur 3 catégories compte 1 dans
   * chacune, jamais 3. Les cardinalités des parts d'une devise ne s'additionnent donc
   * pas au `nbTransactions` de la devise (une transaction PARTIELLE contribue à la
   * fois à sa part TYGR et au reliquat bancaire).
   */
  nbTransactions: number;
  /** Espace de noms de la clé — cf. {@link OrigineCategorie}. */
  origine: OrigineCategorie;
  /** `categories.id` si `origine="TYGR"`, sinon NULL (la banque n'a pas d'id TYGR). */
  categorieId: string | null;
  /**
   * Somme de la MÊME catégorie sur la fenêtre PRÉCÉDENTE (L4), CHAÎNE décimale (agrégat
   * SQL). « 0.00 » si la catégorie n'existait pas avant, ou si aucune fenêtre précédente
   * n'a été demandée. Sert au badge de variation (ratio d'affichage, jamais réinjecté).
   */
  montantPrecedent: string;
}

/**
 * Répartition par catégorie POUR UNE devise. `total` est le total mono-devise
 * (centre du donut) — JAMAIS une somme cross-devise. Les parts sont triées par
 * montant décroissant ; « Non catégorisé » est toujours repoussé en fin.
 */
export interface RepartitionDevise {
  currency: string;
  total: string; // total mono-devise (chaîne décimale)
  /**
   * Transactions DISTINCTES de la devise (D-f) — jamais la somme des `nbTransactions`
   * des parts : une transaction PARTIELLE apparaît dans deux parts (sa ventilation et
   * son reliquat) et ne doit être comptée qu'une fois ici.
   */
  nbTransactions: number;
  /** Montant moyen par opération de la devise (total/nb, EN SQL, L2) — chaîne décimale. */
  montantMoyen: string;
  parts: PartCategorie[];
}

/**
 * Répartition par catégorie complète, MULTI-DEVISE : une entrée par devise, JAMAIS
 * d'addition cross-devise (CLAUDE.md Localisation / règle 8). Fenêtre [from, to]
 * (bornes comptables Maurice « YYYY-MM-DD », E20). `sens` fige le côté agrégé.
 * `fromPrecedent`/`toPrecedent` = fenêtre précédente contiguë (L4) — chaînes vides si
 * la variation n'a pas été demandée (info d'affichage, ex. libellé « vs 30 j préc. »).
 */
export interface RepartitionCategories {
  sens: SensFlux;
  from: string;
  to: string;
  /** Borne basse de la fenêtre précédente (L4) — « » si non calculée. */
  fromPrecedent: string;
  /** Borne haute de la fenêtre précédente (L4) — « » si non calculée. */
  toPrecedent: string;
  /** Une entrée par devise (devises triées) — jamais d'addition cross-devise. */
  devises: RepartitionDevise[];
}
