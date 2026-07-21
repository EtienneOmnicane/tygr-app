/**
 * Traduction FR des catégories OBIE **EN SQL** — Lot 0 de
 * `PLAN-graphiques-categ-utilisateur.md` (décision D-d, §5.1).
 *
 * POURQUOI EN SQL et pas au rendu : `CORRESPONDANCE_FR` (`src/lib/categories-fr.ts`) est
 * MANY-TO-ONE — `income` et `revenue` retombent tous deux sur « Revenus », `banking &
 * finance` et `bank charges` sur « Frais bancaires ». Un agrégat groupé sur la clé OBIE
 * puis traduit à l'affichage produirait donc DEUX secteurs « Revenus », de couleurs
 * différentes (rangs distincts, `palette-categories.ts`), avec deux montants et deux
 * pourcentages. Les refusionner côté client exigerait d'additionner deux chaînes
 * décimales — INTERDIT (CLAUDE.md règle 8 : aucun agrégat de montant côté JS).
 * En groupant sur le libellé FR, la fusion se fait EN SQL, dans le `sum()`.
 *
 * SOURCE UNIQUE : le `CASE` est GÉNÉRÉ depuis `CORRESPONDANCE_FR`, jamais recopié.
 * Ajouter une entrée au dictionnaire met à jour `/transactions`, le dashboard ET le donut
 * d'un seul geste (règle 9 — pas de seconde table de correspondance à maintenir).
 *
 * SÉCURITÉ : les clés et les libellés sont passés en PARAMÈTRES LIÉS (`${…}` Drizzle),
 * jamais interpolés — pas de `sql.raw` (piège `42803` déjà rencontré sur ce repository).
 * Les valeurs viennent d'une constante du code, mais la forme paramétrée est la règle
 * quoi qu'il en soit.
 *
 * TYPAGE : chaque paramètre porte un `::text` explicite. Sans lui, un `CASE` dont TOUTES
 * les branches sont des paramètres non typés fait échouer l'inférence Postgres
 * (« could not determine data type of parameter »).
 */

import { sql, type SQL, type AnyColumn } from "drizzle-orm";

import { CATEGORIE_FR_PAR_DEFAUT, CORRESPONDANCE_FR } from "@/lib/categories-fr";

/**
 * Expression SQL traduisant une colonne de catégorie OBIE en libellé FR d'affichage.
 *
 * Contrat, strictement aligné sur `categorieFr` (même module, même repli) :
 *   - clé cartographiée (insensible casse/espaces) → libellé FR ;
 *   - NULL, chaîne vide, sentinelles Omni-FI (`UNCLASSIFIED`/`Uncategorized`) ou toute
 *     clé NON cartographiée → `CATEGORIE_FR_PAR_DEFAUT` (« Non catégorisé »).
 *
 * NB — les sentinelles et le vide n'ont PAS besoin d'un prédicat dédié : ils ne figurent
 * pas dans le dictionnaire, donc ils tombent naturellement dans la branche `else`.
 * `lower(btrim(NULL))` vaut NULL, et `CASE NULL WHEN 'x'` ne matche rien (NULL = 'x' est
 * NULL, pas TRUE) → `else`. Ceci REMPLACE l'ancien prédicat `estNonCat` du donut, à
 * comportement identique. Corollaire à connaître : n'ajoutez jamais `unclassified` au
 * dictionnaire — il cesserait d'être un non-catégorisé.
 *
 * L'expression est déterministe : `Object.entries` itère les clés d'un objet littéral
 * dans l'ordre d'insertion, donc le SQL généré est stable d'un appel à l'autre (deux
 * requêtes du même donut produisent des clés de merge qui coïncident).
 *
 * @param colonne colonne (ou expression) portant la catégorie OBIE brute.
 */
export function caseCategorieFr(colonne: AnyColumn | SQL): SQL<string> {
  const branches = Object.entries(CORRESPONDANCE_FR).map(
    ([cleObie, libelleFr]) => sql`when ${cleObie}::text then ${libelleFr}::text`,
  );

  return sql<string>`case lower(btrim(${colonne})) ${sql.join(
    branches,
    sql` `,
  )} else ${CATEGORIE_FR_PAR_DEFAUT}::text end`;
}

/**
 * Prédicat « ce libellé est le poste non-catégorisé ». Défini ICI pour que le drapeau
 * exposé à l'UI et le tri (« Non catégorisé » toujours en fin) dérivent de la MÊME
 * constante que la branche `else` ci-dessus — un repli renommé d'un côté sans l'autre
 * ferait silencieusement disparaître le drapeau et le tri.
 *
 * Accepte aussi bien l'expression brute que la COLONNE d'une sous-requête qui la
 * matérialise (`sousRequete.labelFr`) — c'est cette seconde forme qu'utilise le donut,
 * pour ne pas réémettre le `CASE` paramétré à plusieurs endroits (piège 42803, cf.
 * `repartitionParCategorie`).
 *
 * @param labelFr expression produite par {@link caseCategorieFr}, ou la colonne de
 *   sous-requête qui la porte.
 */
export function estLibelleNonCategorise(
  labelFr: SQL<string> | SQL.Aliased<string> | AnyColumn,
): SQL<boolean> {
  return sql<boolean>`(${labelFr} = ${CATEGORIE_FR_PAR_DEFAUT}::text)`;
}
