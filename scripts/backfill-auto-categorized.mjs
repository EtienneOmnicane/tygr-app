/**
 * Backfill de la provenance auto des catégories Omni-FI sur les transactions DÉJÀ
 * en base — `node --env-file=.env scripts/backfill-auto-categorized.mjs`.
 *
 * CONTEXTE : la migration 0011 ajoute `is_auto_categorized` / `category_source` à
 * transactions_cache (défaut false / NULL). Les transactions ingérées AVANT le
 * déploiement n'ont donc pas de marqueur. Ce script le recalcule depuis la donnée
 * déjà présente (`primary_category`), avec EXACTEMENT la même règle que l'ingestion
 * (orchestrateur.versLignePersistee / categorieAutoValide) :
 *   - catégorie EXPLOITABLE  (≠ NULL, ≠ '', ≠ 'Uncategorized' insensible à la casse)
 *       → is_auto_categorized = true,  category_source = 'OMNIFI'
 *   - sinon (NULL / vide / 'Uncategorized')
 *       → is_auto_categorized = false, category_source = NULL,
 *         ET on NULLifie primary_category (décision PO : nettoyer la donnée polluée
 *         — "Uncategorized"/chaînes vides ne doivent pas survivre dans les rapports).
 * PÉRIMÈTRE : primary_category UNIQUEMENT — sub_category n'est PAS touchée (ni ici, ni
 * à l'ingestion : les deux chemins doivent rester strictement alignés).
 *
 * IDEMPOTENT : un seul UPDATE déterministe, fonction pure des colonnes actuelles.
 * Rejouable autant de fois que voulu → converge vers le même état (une 2e passe ne
 * change plus rien : les 'Uncategorized' ont déjà été mis à NULL, les marqueurs
 * sont déjà cohérents). Aucun curseur, aucune dépendance à l'ordre d'exécution.
 *
 * RÔLE OWNER (DATABASE_URL_ADMIN), comme migrate.mjs / provision.mjs : c'est une
 * MIGRATION DE DONNÉES ponctuelle (one-shot), pas un chemin applicatif — exception
 * explicite à CLAUDE.md règle 2, au même titre que les migrations. Sous l'owner, la
 * RLS ne filtre pas : l'UPDATE couvre TOUS les workspaces en une passe (voulu pour
 * un backfill). Ne JAMAIS recâbler ce script sur le rôle applicatif tygr_app ni
 * l'exposer dans une route. NB : c'est un UPDATE (tombstone-compatible), JAMAIS un
 * DELETE — transactions_cache reste append-only.
 *
 * PII (règle 8) : ne lit/écrit que des étiquettes de catégorie OBIE (anglais, non
 * nominatives) ; ne touche jamais bank_label_raw/clean_label ; ne logge aucun
 * libellé, seulement des COMPTEURS agrégés.
 *
 * SÉCURITÉ injection : zéro entrée externe, zéro interpolation — l'UPDATE est une
 * constante SQL. Rien à paramétrer.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}
// Dev local : même câblage wsproxy que src/server/db/index.ts et migrate.mjs
// (WebSocket + vraies transactions conservés, E16 ; seul le TLS est relâché).
if (process.env.NEON_WSPROXY_LOCAL) {
  const proxy = process.env.NEON_WSPROXY_LOCAL;
  neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

const databaseUrl = process.env.DATABASE_URL_ADMIN;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL_ADMIN manquante (rôle owner) — voir .env.example. " +
      "Le backfill est une migration de données (UPDATE en masse), il exige le rôle propriétaire.",
  );
  process.exit(1);
}

// Prédicat « catégorie exploitable » EN SQL — réplique exacte de categorieAutoValide :
// non NULL, non vide après trim, et ≠ 'uncategorized' (insensible à la casse).
const CATEGORIE_EXPLOITABLE = `
  primary_category IS NOT NULL
  AND btrim(primary_category) <> ''
  AND lower(btrim(primary_category)) <> 'uncategorized'
`;

const pool = new Pool({ connectionString: databaseUrl });
// Un SEUL client pour tenir une vraie transaction (BEGIN/COMMIT) : l'UPDATE et le
// comptage de contrôle voient le MÊME instant, et l'écriture est atomique (rollback
// propre si le count échoue). `pool.query` ouvre une connexion par appel → ne
// garantirait pas l'atomicité que cet en-tête promet.
const client = await pool.connect();

try {
  await client.query("BEGIN");

  // UPDATE atomique et déterministe. PÉRIMÈTRE = primary_category UNIQUEMENT (décision
  // PO), STRICTEMENT le miroir de l'ingestion (versLignePersistee) :
  // - branche "exploitable"     : marqueur OMNIFI posé (cohérent avec le CHECK).
  // - branche "non exploitable" : marqueur effacé ET primary_category nullifiée.
  // sub_category n'est PAS touchée — ni ici, ni à l'ingestion (alignement des deux
  // chemins ; ne pas réintroduire un nettoyage sub_category d'un seul côté → divergence
  // de données + re-pollution au re-sync, constat QA 2026-06-23).
  const res = await client.query(`
    UPDATE transactions_cache
    SET
      is_auto_categorized = CASE WHEN ${CATEGORIE_EXPLOITABLE} THEN true ELSE false END,
      category_source     = CASE WHEN ${CATEGORIE_EXPLOITABLE} THEN 'OMNIFI' ELSE NULL END,
      primary_category    = CASE WHEN ${CATEGORIE_EXPLOITABLE} THEN primary_category ELSE NULL END
    WHERE
      -- N'écrit QUE les lignes dont l'état diverge de la cible → idempotence stricte
      -- (une 2e passe ne matche plus rien : 0 ligne mise à jour). Évite la réécriture
      -- inutile de toute la table à chaque exécution.
      is_auto_categorized <> (CASE WHEN ${CATEGORIE_EXPLOITABLE} THEN true ELSE false END)
      OR category_source IS DISTINCT FROM (CASE WHEN ${CATEGORIE_EXPLOITABLE} THEN 'OMNIFI' ELSE NULL END)
      OR (NOT (${CATEGORIE_EXPLOITABLE}) AND primary_category IS NOT NULL)
  `);

  // Comptage agrégé de l'état APRÈS backfill (aucune PII, juste des totaux), DANS la
  // même transaction → cohérent avec l'UPDATE qui précède.
  const stats = await client.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE is_auto_categorized)::int AS auto,
      count(*) FILTER (WHERE NOT is_auto_categorized)::int AS non_auto
    FROM transactions_cache
  `);

  await client.query("COMMIT");

  const { total, auto, non_auto } = stats.rows[0];
  console.log(
    JSON.stringify({
      evt: "backfill_auto_categorized_ok",
      lignes_mises_a_jour: res.rowCount,
      total_transactions: total,
      auto_categorisees: auto,
      non_auto: non_auto,
    }),
  );
} catch (err) {
  // Rollback best-effort puis on remonte. Pas de PII dans le message ; on logge le
  // message d'erreur Postgres tel quel (codes/contraintes, jamais une ligne).
  try {
    await client.query("ROLLBACK");
  } catch {
    // connexion déjà tombée : rien à annuler.
  }
  console.error(
    JSON.stringify({
      evt: "backfill_auto_categorized_echec",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
