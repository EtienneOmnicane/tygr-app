/**
 * SOURCE UNIQUE du prédicat « la catégorie OBIE est-elle exploitable ? » — partagée
 * par les DEUX chemins qui doivent en dépendre à l'identique (CLAUDE.md règle 9) :
 *   - l'INGESTION (TS)  : src/server/ingestion/orchestrateur.ts (versLignePersistee) ;
 *   - le BACKFILL (SQL) : scripts/backfill-auto-categorized-lib.mjs.
 * Même pattern que src/lib/categories-referentiel.mjs : module `.mjs` neutre,
 * consommable par le TS (`allowJs`, import `@/lib/…mjs`), par un script Node et par
 * les tests — une seule définition, jamais deux.
 *
 * POURQUOI CE MODULE EXISTE (la leçon, pas la théorie) : le prédicat vivait en DEUX
 * exemplaires — un `Set` en TS et une chaîne SQL recopiée à la main dans le script de
 * backfill, dont l'en-tête se disait pourtant « réplique exacte de categorieAutoValide ».
 * Quand #243 a ajouté la graphie "unclassified" au TS, la copie SQL est restée sur
 * "uncategorized" seul : le backfill aurait re-classé ~93 % des lignes comme
 * « catégorisées par l'amont » — soit exactement le défaut qu'il devait corriger, en
 * silence et sous le rôle owner. Deux copies d'une liste fermée finissent TOUJOURS par
 * diverger : il n'y en a plus qu'une.
 *
 * Le prédicat SQL est DÉRIVÉ de la constante et passé en PARAMÈTRE LIÉ (`$n::text[]`) :
 * aucune interpolation de valeur dans le SQL (règle 3 — audit injection), et il devient
 * structurellement impossible d'oublier une graphie d'un côté.
 */

/**
 * Étiquettes OBIE traitées comme « pas de catégorie » : l'amont en pose une par DÉFAUT
 * quand la banque n'a rien classé (cf. OmniFiEnrichment). On les traite comme une
 * absence — JAMAIS comme une vraie catégorie. Liste fermée, comparaison insensible à
 * la casse/aux espaces (d'où les clés en minuscules ici).
 *
 * DEUX graphies, parce que l'amont a changé la sienne sans le dire :
 *  - "uncategorized" — la valeur documentée, sur laquelle ce filtre a été bâti ;
 *  - "unclassified"  — la valeur RÉELLEMENT émise aujourd'hui, en SCREAMING_SNAKE
 *    ("UNCLASSIFIED"), constatée par inventaire en base le 2026-07-21.
 *
 * Ce que coûtait l'omission : "UNCLASSIFIED" passait le filtre comme une vraie
 * catégorie → `is_auto_categorized = true` + `category_source = "OMNIFI"` sur ~93 %
 * des transactions, alors que ~6,7 % seulement portent une classification réelle. La
 * base affirmait donc « catégorisé par l'amont » à propos de transactions que l'amont
 * déclarait justement NE PAS savoir classer.
 *
 * ⚠️ Liste fermée = elle ne se devine pas, elle s'INVENTORIE. Avant d'y toucher :
 * `select distinct primary_category from transactions_cache` — la graphie du catalogue
 * (`categories-fr.ts`) n'est PAS une source fiable sur ce que l'amont émet vraiment,
 * leçon déjà payée sur les clés composées (`FOOD_AND_DRINK` vs `food & drink`).
 * Inventaire au 2026-07-21 : UNCLASSIFIED, UTILITIES, BANKING_AND_FINANCE,
 * INTER_ACCOUNT_TRANSFER — les trois dernières sont de VRAIES catégories, à conserver.
 *
 * @type {readonly string[]}
 */
export const CATEGORIES_OBIE_VIDES = Object.freeze(["uncategorized", "unclassified"]);

/**
 * Caractères retirés aux deux bords avant comparaison. Explicite parce que les deux
 * moteurs ne s'accordent PAS par défaut : `String.prototype.trim()` (TS) retire tous
 * les blancs ASCII (espace, \t, \n, \r, \v, \f), là où `btrim(x)` en SQL ne retire que
 * l'ESPACE. Cette liste, passée explicitement à `btrim`, rétablit la parité SUR CES
 * SEULS blancs ASCII : sans elle, une valeur `"\tUNCLASSIFIED"` serait jugée VIDE côté
 * TS et EXPLOITABLE côté SQL.
 *
 * ⚠️ PARITÉ PARTIELLE — bornée aux blancs ASCII ci-dessus, PAS totale. `trim()` retire
 * EN PLUS les blancs Unicode de catégorie Zs (NBSP U+00A0, narrow NBSP U+202F, thin
 * space U+2009, idéographique U+3000, …) que `btrim(col, BLANCS)` NE retire PAS. Un
 * préfixe NBSP `" UNCLASSIFIED"` reste donc jugé VIDE côté TS et EXPLOITABLE
 * côté SQL : la divergence n'est pas fermée, seulement repoussée hors ASCII. Impact
 * prod faible (les codes OBIE émis par l'amont sont ASCII), donc consigné en dette
 * plutôt que corrigé ici — cf. TODOS.md `FIABILITE-PARITE-UNICODE`.
 */
const BLANCS = " \t\n\r\v\f";

/**
 * Une catégorie OBIE est-elle EXPLOITABLE (≠ vide, ≠ sentinelle amont) ? Fonction pure.
 * Sert à la fois à décider du marqueur de provenance et à nullifier `primary_category`
 * quand la catégorie n'apporte rien — pour ne pas polluer la base (décision PO : base
 * rigoureuse).
 *
 * @param {string | undefined | null} primaryCategory
 * @returns {boolean}
 */
export function categorieAutoValide(primaryCategory) {
  const clef = primaryCategory?.trim().toLowerCase();
  if (!clef) return false;
  return !CATEGORIES_OBIE_VIDES.includes(clef);
}

/**
 * Rend le MÊME prédicat en SQL, dérivé de la constante ci-dessus — jamais recopié.
 * La liste part en paramètre lié (`$n::text[]`, cf. `parametresPredicatSql`), donc
 * aucune valeur n'est interpolée dans le texte SQL.
 *
 * Équivalences terme à terme avec `categorieAutoValide` :
 *   `?.trim()`      ⇢ `btrim(col, BLANCS)`  (liste de blancs explicite, cf. plus haut)
 *   `.toLowerCase()`⇢ `lower(...)`          (clés ASCII : pas d'écart de locale)
 *   `if (!clef)`    ⇢ `IS NOT NULL AND <> ''`
 *   `!Set.has(clef)`⇢ `<> ALL($n::text[])`
 *
 * @param {string} colonne  Nom de colonne SQL (littéral du code appelant, jamais une
 *                          entrée externe — ce paramètre n'existe que pour la lisibilité
 *                          des tests ; il n'est pas une surface d'injection).
 * @param {number} indiceParametre  Numéro du paramètre lié portant la liste (1 = `$1`).
 * @returns {string} Expression SQL booléenne « la catégorie est exploitable ».
 */
export function predicatSqlCategorieExploitable(
  colonne = "primary_category",
  indiceParametre = 1,
) {
  const normalisee = `lower(btrim(${colonne}, ${litteralBlancsSql()}))`;
  return `(
    ${colonne} IS NOT NULL
    AND ${normalisee} <> ''
    AND ${normalisee} <> ALL($${indiceParametre}::text[])
  )`;
}

/**
 * LA VALEUR à lier au paramètre `$n` de `predicatSqlCategorieExploitable` — c'est-à-dire
 * un `text[]` entier, pas une valeur par sentinelle.
 *
 * ⚠️ Côté appelant : `client.query(sql, [sentinellesPourParametreSql()])`. Passer
 * directement le tableau comme liste de paramètres lie une sentinelle PAR paramètre
 * (`$1`, `$2`, …) et Postgres refuse la requête (« bind message supplies 2 parameters,
 * but prepared statement requires 1 »). Cette fonction renvoie la VALEUR ; l'appelant
 * construit son tableau de paramètres — ce qui permet aussi de composer le prédicat
 * avec d'autres paramètres (d'où `indiceParametre`).
 *
 * Retourne une COPIE : muter le résultat ne contamine pas la liste fermée.
 *
 * @returns {string[]}
 */
export function sentinellesPourParametreSql() {
  return [...CATEGORIES_OBIE_VIDES];
}

/**
 * Littéral SQL de la liste de blancs (échappement E'…' pour les séquences \t\n\r\v\f).
 * Constante du module — aucune donnée externe n'y entre.
 * @returns {string}
 */
function litteralBlancsSql() {
  const echappe = BLANCS.replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\v/g, "\\v")
    .replace(/\f/g, "\\f")
    .replace(/'/g, "''");
  return `E'${echappe}'`;
}
