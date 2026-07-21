/**
 * Table de correspondance des catégories de transactions OBIE → FRANÇAIS
 * (DR-F1, décision actée 2026-06-22, chantier `PLAN-audit-ergonomie-soldes.md` Lot 3).
 *
 * POURQUOI côté AFFICHAGE et pas côté service : Omni-FI renvoie `PrimaryCategory`
 * en anglais (catégorisation OBIE de la banque : « Income », « Utilities »…). Dans
 * une interface 100 % française, ces libellés bruts détonnent (finding /design-review
 * le plus visible). La localisation côté service (table de mapping en base, i18n
 * amont) est REPORTÉE (dette tracée) ; ici on traduit au RENDU, sans toucher la donnée
 * stockée — `primary_category` reste la valeur OBIE brute (export, réconciliation,
 * filtres futurs raisonnent dessus en anglais, langue pivot stable).
 *
 * NB de périmètre : ceci concerne la catégorie OBIE *automatique* (`primaryCategory`).
 * La catégorie de VENTILATION MANUELLE (saisie par l'utilisateur, déjà en français,
 * cf. `CategoryManager`) ne passe PAS par cette table — elle est localisée à la source.
 *
 * Correspondance fondée sur les catégories OBIE RÉELLEMENT émises par l'API (sonde
 * runtime 2026-06-23 sur compte réel : `business expenses`, `professional fees`,
 * `revenue`, `administrative costs`, `personnel`, `food & drink`, `travel &
 * transport`, `housing`, `healthcare`, `other`, `income`). Une clé INCONNUE
 * (catégorie OBIE non encore cartographiée, ou `null`) retombe sur « Non
 * catégorisé » — JAMAIS d'anglais résiduel à l'écran, et pas de crash.
 *
 * ⚠️ Catalogue FIGÉ = fragile : l'amont émet librement, ce mapping est une liste
 * fermée maintenue à la main. Toute catégorie OBIE hors liste s'affiche « Non
 * catégorisé » silencieusement (avant la sonde, 96 % des transactions étaient dans
 * ce cas). Dette OBIE-CATALOG1 (TODOS.md) : à reconsidérer si l'amont ajoute des
 * catégories ou si une localisation côté service est livrée.
 */

/** Libellé affiché quand la catégorie est absente ou non cartographiée. */
export const CATEGORIE_FR_PAR_DEFAUT = "Non catégorisé";

/**
 * OBIE `PrimaryCategory` (anglais, langue pivot) → libellé d'affichage français.
 *
 * Clés normalisées en minuscules à la lecture (`categorieFr` applique `toLowerCase`),
 * donc la casse renvoyée par l'API n'a pas d'importance. On inclut quelques
 * SOUS-catégories fréquentes (« Bank Charges ») par robustesse, au cas où un appelant
 * passerait une sous-catégorie : la résolution reste correcte sans élargir le contrat.
 *
 * ⚠️ **MANY-TO-ONE, et c'est structurant** : plusieurs clés OBIE retombent volontairement
 * sur le MÊME libellé FR (`income`/`revenue` → « Revenus » ; `banking & finance`/`bank
 * charges` → « Frais bancaires »). Tout AGRÉGAT par catégorie doit donc grouper sur le
 * libellé FR, jamais sur la clé OBIE : grouper sur la clé puis traduire à l'affichage
 * produirait deux postes homonymes, refusionnables seulement par une addition côté JS
 * (interdite, CLAUDE.md règle 8). Voir `caseCategorieFr`
 * (`src/server/insights/categorie-fr-sql.ts`), qui GÉNÈRE le `CASE` SQL depuis cette
 * table — d'où l'export : ce module reste la source unique, ajouter une entrée ici met à
 * jour `/transactions`, le dashboard ET le donut `/graphiques` d'un seul geste.
 */
export const CORRESPONDANCE_FR: Record<string, string> = {
  // Catégories OBIE observées en runtime (sonde 2026-06-23). `income` et `revenue`
  // fusionnés sous « Revenus » (deux clés OBIE → même libellé FR, arbitrage validé).
  income: "Revenus",
  revenue: "Revenus",
  "business expenses": "Charges d'exploitation",
  "professional fees": "Honoraires",
  "administrative costs": "Frais administratifs",
  personnel: "Personnel",
  "food & drink": "Restauration",
  "travel & transport": "Déplacements",
  housing: "Logement",
  healthcare: "Santé",
  other: "Autres",
  // Catégories historiques (seed de démo / doc API) — conservées : sans coût et
  // robustes si l'amont les ré-émet.
  rent: "Loyer",
  utilities: "Charges",
  insurance: "Assurances",
  taxes: "Taxes",
  payroll: "Salaires",
  "banking & finance": "Frais bancaires",
  "bank charges": "Frais bancaires",
  // Virement entre deux comptes du groupe. Nommé (≠ neutralisé) : son TRAITEMENT dans
  // les totaux relève de la décision D3 du plan graphiques (« annoter en v1 »), pas de
  // l'affichage. Observé en base le 2026-07-21 (`INTER_ACCOUNT_TRANSFER`).
  "inter account transfer": "Virements internes",
};

/**
 * Normalise une clé OBIE avant recherche dans {@link CORRESPONDANCE_FR}.
 *
 * POURQUOI (constat de QA sur donnée RÉELLE, 2026-07-21) : l'amont émet ses catégories
 * en `SCREAMING_SNAKE_CASE` (`BANKING_AND_FINANCE`, `INTER_ACCOUNT_TRANSFER`,
 * `UTILITIES`), alors que ce dictionnaire a été bâti sur la sonde du 2026-06-23, qui
 * observait des libellés en minuscules à espaces (`banking & finance`). Les clés d'un
 * seul mot matchaient encore (`UTILITIES` → `utilities`), mais TOUTES les clés composées
 * échouaient silencieusement et retombaient sur « Non catégorisé ».
 *
 * Plutôt que de dupliquer chaque entrée dans les deux graphies (deux vérités à maintenir),
 * on normalise à la LECTURE : `_and_` → ` & `, puis `_` → ` `. Cette seule règle fait
 * matcher toutes les entrées composées du dictionnaire — `FOOD_AND_DRINK` → `food & drink`,
 * `BUSINESS_EXPENSES` → `business expenses` — et laisse les clés simples inchangées.
 *
 * ⚠️ Doit rester STRICTEMENT équivalente à la normalisation SQL de `caseCategorieFr`
 * (`src/server/insights/categorie-fr-sql.ts`) : si les deux divergent, le donut et
 * `/transactions` afficheront des catégories différentes pour la même transaction.
 */
export function normaliserCleObie(primaryCategory: string): string {
  return primaryCategory
    .trim()
    .toLowerCase()
    .replaceAll("_and_", " & ")
    .replaceAll("_", " ");
}

/**
 * Traduit une catégorie OBIE en français pour l'affichage. `null`/`undefined`/vide
 * ou clé inconnue → « Non catégorisé ». Aucune mutation de la donnée d'origine.
 */
export function categorieFr(primaryCategory: string | null | undefined): string {
  if (!primaryCategory?.trim()) return CATEGORIE_FR_PAR_DEFAUT;
  const clef = normaliserCleObie(primaryCategory);
  return CORRESPONDANCE_FR[clef] ?? CATEGORIE_FR_PAR_DEFAUT;
}
