/**
 * Backfill de la provenance auto des catégories Omni-FI sur les transactions DÉJÀ
 * en base — `node --env-file=.env scripts/backfill-auto-categorized.mjs`.
 *
 * CONTEXTE (deux vagues, le script sert les deux) :
 *  1. migration 0011 — `is_auto_categorized` / `category_source` ajoutées (défaut
 *     false / NULL) : les transactions ingérées AVANT n'avaient pas de marqueur ;
 *  2. correctif #243 — la sentinelle réellement émise par l'amont est "UNCLASSIFIED"
 *     (pas "Uncategorized"). Avant #243 elle passait pour une VRAIE catégorie :
 *     `is_auto_categorized = true` sur 9 056 / 9 056 lignes (100 %) alors que 606
 *     seulement (6,7 %) portent une classification réelle. #243 corrige les ingestions
 *     FUTURES ; les lignes déjà en base gardent leur mauvaise valeur.
 *     Une re-sync ne les rattraperait PAS : l'historique amont est borné à ~92 j (les
 *     lignes plus anciennes ne reviennent jamais dans un payload) et les connexions
 *     sont désynchronisées (SYNC-DESYNC1). D'où ce backfill explicite.
 *
 * La RÈGLE appliquée est celle de l'ingestion, importée — plus recopiée. La logique
 * SQL vit dans `backfill-auto-categorized-lib.mjs` (partagée avec la suite isolation),
 * et son prédicat dérive de `src/lib/categorie-obie-vide.mjs`. Détail du périmètre
 * (ce qui n'est jamais touché : trace de classification, sub_category, ventilation
 * manuelle) : voir l'en-tête de la lib.
 *
 * IDEMPOTENT : rejouable autant de fois que voulu, converge vers le même état (2e
 * passe = 0 ligne modifiée).
 *
 * RÔLE OWNER (DATABASE_URL_ADMIN), comme migrate.mjs / provision.mjs : c'est une
 * MIGRATION DE DONNÉES ponctuelle (one-shot), pas un chemin applicatif — exception
 * explicite à CLAUDE.md règle 2, au même titre que les migrations. Sous l'owner, la
 * RLS ne filtre pas : l'UPDATE couvre TOUS les workspaces en une passe (voulu pour
 * un backfill — décision D-3 du plan, tranchée « toute la base »). Ne JAMAIS recâbler
 * ce script sur le rôle applicatif tygr_app ni l'exposer dans une route. NB : c'est un
 * UPDATE, JAMAIS un DELETE — transactions_cache reste append-only.
 *
 * PII (règle 8) : ne lit/écrit que des étiquettes de catégorie OBIE (anglais, non
 * nominatives) ; ne touche jamais bank_label_raw/clean_label ; ne logge aucun
 * libellé, seulement des COMPTEURS agrégés.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";

import {
  backfillProvenanceAutoDansTransaction,
  compterProvenanceAuto,
} from "./backfill-auto-categorized-lib.mjs";

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

const pool = new Pool({ connectionString: databaseUrl });
// Un SEUL client pour tenir une vraie transaction (BEGIN/COMMIT) : l'UPDATE et le
// comptage de contrôle voient le MÊME instant, et l'écriture est atomique (rollback
// propre si le count échoue). `pool.query` ouvre une connexion par appel → ne
// garantirait pas l'atomicité que cet en-tête promet.
const client = await pool.connect();

try {
  await client.query("BEGIN");

  const lignesMisesAJour = await backfillProvenanceAutoDansTransaction(client);
  // Comptage agrégé de l'état APRÈS backfill, DANS la même transaction → cohérent
  // avec l'UPDATE qui précède.
  const { total, auto, non_auto } = await compterProvenanceAuto(client);

  await client.query("COMMIT");

  console.log(
    JSON.stringify({
      evt: "backfill_auto_categorized_ok",
      lignes_mises_a_jour: lignesMisesAJour,
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
