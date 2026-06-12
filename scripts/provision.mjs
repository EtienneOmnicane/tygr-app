/**
 * Applique le provisioning du rôle `tygr_app` (dette P0-b) — `npm run db:provision`.
 *
 * Rôle OWNER (DATABASE_URL_ADMIN) : gérer les rôles/privilèges est une opération
 * d'administration, même statut que les migrations (exception CLAUDE.md règle 2).
 * Ordre de pipeline NON négociable : db:provision -> migrate -> deploy.
 *
 * Idempotent (le script SQL l'est) : relançable sans effet de bord. Secret (C4) :
 * le script ne pose AUCUN mot de passe ; le LOGIN + mot de passe de tygr_app est
 * une étape d'exploitation séparée (Neon UI / ALTER ROLE depuis un secret d'env).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { neonConfig, Pool } from "@neondatabase/serverless";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}
// Dev local : même câblage wsproxy que src/server/db/index.ts.
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
      "Le provisioning gère des rôles, il exige le rôle propriétaire.",
  );
  process.exit(1);
}

const sql = readFileSync(
  path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
  "utf8",
);

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query(sql);
  console.log("Provisioning tygr_app appliqué (idempotent).");
  console.log(
    "Rappel C4 : poser le mot de passe hors script — " +
      "ALTER ROLE tygr_app LOGIN PASSWORD '<secret env>' (jamais commité).",
  );
} catch (erreur) {
  console.error("Provisioning échoué :", erreur.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
