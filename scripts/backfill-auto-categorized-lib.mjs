/**
 * Logique du backfill de provenance auto des catégories Omni-FI — PARTAGÉE par :
 *   - scripts/backfill-auto-categorized.mjs (pilote CLI, rôle owner) ;
 *   - tests/isolation/backfill-auto-categorized-isolation.test.ts (preuve sous
 *     Postgres réel + migrations réelles).
 * Même pattern que scripts/seed-categories-lib.mjs : la fonction EXÉCUTÉE en prod est
 * exactement celle que le test exerce — pas de SQL recopié dans le test (règle 9).
 *
 * CE QUE FAIT LE BACKFILL (miroir strict de l'ingestion, `versLignePersistee`) :
 *   - catégorie EXPLOITABLE     → is_auto_categorized = true,  category_source = 'OMNIFI'
 *   - sinon (NULL/vide/sentinelle) → is_auto_categorized = false, category_source = NULL,
 *     ET primary_category nullifiée (décision PO : les sentinelles ne survivent pas
 *     dans les rapports).
 *
 * PÉRIMÈTRE — ce qui n'est JAMAIS touché :
 *   - `confidence_level`, `classification_source`, `rule_id_match` : la TRACE amont
 *     (TECH-API-TRACE) est fidèle par construction, y compris sur une ligne non classée
 *     (un `Low` par défaut est CONSERVÉ — le neutraliser est une décision de couche UI).
 *     Les écraser détruirait la matière première de la future file de revue.
 *   - `sub_category` : non touchée ici NI à l'ingestion — les deux chemins restent
 *     alignés (nettoyer d'un seul côté = divergence + re-pollution au re-sync).
 *   - la ventilation manuelle (`transaction_categorizations`) : autre table, autre
 *     concept (concept A vs catégorie OBIE) — hors de portée de cet UPDATE.
 *
 * APPEND-ONLY : UPDATE uniquement, JAMAIS de DELETE (transactions_cache est append-only
 * au DELETE — privilège retiré + trigger 0004). Aucune ligne n'est supprimée ni créée.
 *
 * IDEMPOTENT : le `WHERE` ne matche que les lignes dont l'état DIVERGE de la cible →
 * 2e passage = 0 ligne. Fonction pure des colonnes actuelles, sans curseur ni
 * dépendance à l'ordre d'exécution.
 *
 * PARTITIONS : l'UPDATE cible la table mère `transactions_cache` → propagé à toutes les
 * partitions (2024→2027 + DEFAULT), présentes et futures.
 *
 * SÉCURITÉ injection : le texte SQL ne contient aucune valeur externe ; la liste des
 * sentinelles est passée en PARAMÈTRE LIÉ (`$1::text[]`) depuis la source unique
 * `src/lib/categorie-obie-vide.mjs`.
 */
import {
  predicatSqlCategorieExploitable,
  sentinellesPourParametreSql,
} from "../src/lib/categorie-obie-vide.mjs";

/** Prédicat SQL dérivé de la source unique (jamais recopié à la main). */
const EXPLOITABLE = predicatSqlCategorieExploitable("primary_category", 1);

/**
 * Nombre de lignes affectées, quel que soit le driver — les deux ne nomment PAS le
 * même champ : `pg`/Neon (prod) expose `rowCount`, PGlite (suite isolation) expose
 * `affectedRows` et laisse `rowCount` à `undefined`. Lire un seul des deux rendrait le
 * compteur silencieusement nul d'un côté : en prod le log du script annoncerait
 * « 0 ligne mise à jour » après avoir corrigé toute la base.
 *
 * @param {{ rowCount?: number | null, affectedRows?: number | null }} res
 * @returns {number}
 */
function lignesAffectees(res) {
  return res.rowCount ?? res.affectedRows ?? 0;
}

/**
 * Applique le backfill DANS la transaction de l'appelant — aucun BEGIN/COMMIT ici
 * (le pilote CLI et le test gèrent la leur ; un ROLLBACK appelant doit tout annuler).
 *
 * @param {{ query(texte: string, params?: unknown[]): Promise<{ rows: any[], rowCount?: number | null }> }} client
 *   Client SQL « pg-compatible » (pg PoolClient, PGlite).
 * @returns {Promise<number>} nombre de lignes réellement corrigées (0 = déjà conforme).
 */
export async function backfillProvenanceAutoDansTransaction(client) {
  const res = await client.query(
    `
    UPDATE transactions_cache
    SET
      is_auto_categorized = CASE WHEN ${EXPLOITABLE} THEN true ELSE false END,
      category_source     = CASE WHEN ${EXPLOITABLE} THEN 'OMNIFI' ELSE NULL END,
      primary_category    = CASE WHEN ${EXPLOITABLE} THEN primary_category ELSE NULL END
    WHERE
      -- N'écrit QUE les lignes dont l'état diverge de la cible → idempotence stricte
      -- (une 2e passe ne matche plus rien : 0 ligne mise à jour). Évite la réécriture
      -- inutile de toute la table à chaque exécution.
      is_auto_categorized <> (CASE WHEN ${EXPLOITABLE} THEN true ELSE false END)
      OR category_source IS DISTINCT FROM (CASE WHEN ${EXPLOITABLE} THEN 'OMNIFI' ELSE NULL END)
      OR (NOT ${EXPLOITABLE} AND primary_category IS NOT NULL)
    `,
    // UN seul paramètre : le text[] complet (cf. sentinellesPourParametreSql).
    [sentinellesPourParametreSql()],
  );
  return lignesAffectees(res);
}

/**
 * Comptage agrégé de l'état courant — aucune PII, uniquement des totaux (règle 8).
 * À appeler dans la MÊME transaction que le backfill pour un instantané cohérent.
 *
 * @param {{ query(texte: string, params?: unknown[]): Promise<{ rows: any[] }> }} client
 * @returns {Promise<{ total: number, auto: number, non_auto: number }>}
 */
export async function compterProvenanceAuto(client) {
  const { rows } = await client.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE is_auto_categorized)::int AS auto,
      count(*) FILTER (WHERE NOT is_auto_categorized)::int AS non_auto
    FROM transactions_cache
  `);
  return rows[0];
}
