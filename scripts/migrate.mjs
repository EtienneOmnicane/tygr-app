/**
 * Applique les migrations Drizzle en attente — `npm run db:migrate`.
 *
 * RAISON D'ÊTRE : avant ce script, l'étape « migrate » de la pipeline
 * `db:provision -> migrate -> deploy` (cf. provision.mjs, CLAUDE.md règle 9)
 * n'avait AUCUNE commande câblée. Les fichiers `drizzle/migrations/*.sql`
 * étaient générés (db:generate) mais jamais APPLIQUÉS à la base → drift
 * silencieux. Symptôme observé (2026-06-19) : /transactions plantait sur
 * « relation "categories" does not exist » parce que 0005 n'avait jamais été
 * appliquée localement. Ce runner ferme cette porte.
 *
 * Rôle OWNER (DATABASE_URL_ADMIN) : une migration est une opération
 * d'administration (DDL, RLS, GRANT) — exception explicite à CLAUDE.md règle 2,
 * jamais le rôle applicatif tygr_app. Même statut que provision.mjs.
 *
 * ORDRE DE PIPELINE NON NÉGOCIABLE : db:provision -> db:migrate -> deploy. En
 * production : migrate PUIS deploy (jamais l'inverse), migrations
 * backward-compatible avec le code N-1 (expand-contract). NB : sur une base
 * NEUVE, rejouer provision APRÈS migrate pose les GRANT DELETE des tables de la
 * liste blanche créées entre-temps (catégories incluses) — cf. provision.mjs.
 *
 * IDEMPOTENT : le migrator Drizzle tient une table de suivi `__drizzle_migrations`
 * et n'applique que les migrations absentes de ce registre. Relançable sans effet
 * de bord. ⚠️ Sur une base PRÉ-EXISTANTE jamais gérée par Drizzle (table de suivi
 * absente), baseliner d'abord : `npm run db:baseline` (marque l'existant comme
 * appliqué sans le rejouer), sinon le migrator tenterait de recréer des tables
 * déjà là et échouerait.
 */
import path from "node:path";

import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}
// Dev local : même câblage wsproxy que src/server/db/index.ts et provision.mjs
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
      "Les migrations gèrent du DDL/RLS/GRANT, elles exigent le rôle propriétaire.",
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool);
try {
  await migrate(db, {
    migrationsFolder: path.join(process.cwd(), "drizzle", "migrations"),
  });
  console.log("Migrations Drizzle appliquées (à jour).");
} catch (erreur) {
  console.error("Migration échouée :", erreur.message);
  if (/already exists/i.test(erreur.message ?? "")) {
    console.error(
      "Indice : base pré-existante non baselinée. Lance d'abord " +
        "`npm run db:baseline` pour adopter l'existant, puis re-`db:migrate`.",
    );
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
