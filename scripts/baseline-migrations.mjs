/**
 * BASELINE Drizzle — `npm run db:baseline`. À lancer UNE SEULE FOIS pour adopter
 * une base PRÉ-EXISTANTE dont le schéma a été posé hors Drizzle (migrations
 * appliquées à la main), avant de basculer sur `db:migrate`.
 *
 * CONTEXTE (2026-06-19) : la base locale/Neon a reçu 0000→0006 manuellement ; la
 * table de suivi `drizzle.__drizzle_migrations` n'existait pas. Sans baseline, le
 * migrator Drizzle (table de suivi vide) tenterait de REJOUER 0000→0006 et
 * planterait sur « relation … already exists ». Ce script marque les migrations
 * DÉJÀ appliquées comme telles — il n'exécute AUCUN DDL, il ne fait que peupler le
 * registre de suivi, pour que `db:migrate` ne traite ensuite QUE les futures.
 *
 * Reproduit À L'IDENTIQUE le format du migrator (vérifié dans
 * node_modules/drizzle-orm/migrator.cjs + pg-core/dialect.cjs) :
 *  - schéma `drizzle`, table `__drizzle_migrations (id serial, hash text, created_at bigint)` ;
 *  - hash = sha256(contenu BRUT du .sql, breakpoints inclus) en hex ;
 *  - created_at = `when` du journal (la détection d'application est `created_at desc`).
 *
 * SÉLECTION PAR DÉFAUT : on baseline jusqu'à `--upto` (défaut 0006), c.-à-d. ce
 * qui est réputé déjà en base. IDEMPOTENT : ne ré-insère pas un hash déjà présent.
 * Rôle OWNER (DATABASE_URL_ADMIN), comme migrate/provision.
 *
 * ⚠️ Ne lancer ce script QUE si le schéma correspondant est réellement en base.
 * Baseliner une migration non appliquée la sauterait définitivement (drift inverse).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { neonConfig, Pool } from "@neondatabase/serverless";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}
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
      "Le baseline écrit dans le schéma drizzle, il exige le rôle propriétaire.",
  );
  process.exit(1);
}

// --upto=<tag-prefix> : ne baseline que jusqu'à cette migration incluse (défaut 0006).
const arg = process.argv.find((a) => a.startsWith("--upto="));
const upto = arg ? arg.slice("--upto=".length) : "0006";

const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
const journal = JSON.parse(
  readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
);

// Reproduit readMigrationFiles : hash = sha256 du contenu brut du .sql.
const aBaseliner = [];
for (const e of journal.entries) {
  const sql = readFileSync(path.join(migrationsDir, `${e.tag}.sql`), "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  aBaseliner.push({ tag: e.tag, hash, when: e.when });
  if (e.tag.startsWith(upto)) break; // inclus, puis stop
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  // Crée le registre de suivi exactement comme le dialect pg (idempotent).
  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  let inseres = 0;
  for (const m of aBaseliner) {
    // Idempotence : ne pas ré-insérer un hash déjà enregistré.
    const { rows } = await client.query(
      'SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = $1 LIMIT 1',
      [m.hash],
    );
    if (rows.length > 0) {
      console.log(`= déjà baseliné : ${m.tag}`);
      continue;
    }
    await client.query(
      'INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)',
      [m.hash, m.when],
    );
    inseres += 1;
    console.log(`+ baseliné : ${m.tag}`);
  }
  console.log(
    `Baseline terminé (${inseres} insérée(s), jusqu'à ${upto} inclus). ` +
      "db:migrate ne traitera désormais que les migrations plus récentes.",
  );
} catch (erreur) {
  console.error("Baseline échoué :", erreur.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
