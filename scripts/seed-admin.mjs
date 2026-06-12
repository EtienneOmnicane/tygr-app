/**
 * Provisioning initial (Open Question 4, tranchée le 2026-06-12) :
 * crée le workspace « Omni-FI HQ » et l'ADMIN global enardou@omni-fi.co.
 *
 * Usage : SEED_ADMIN_PASSWORD='…' npm run seed:admin
 *
 * - Rôle OWNER (DATABASE_URL_ADMIN) : opération d'administration, même statut
 *   que les migrations (exception documentée CLAUDE.md règle 2).
 * - workspace_members est sous FORCE RLS : l'owner lui-même doit satisfaire la
 *   policy → on pose app.current_workspace_id dans la transaction (aucun
 *   BYPASSRLS, le modèle d'isolation reste entier).
 * - Idempotent : relançable sans effet de bord ; ne RÉÉCRIT JAMAIS un mot de
 *   passe existant (pas d'écrasement silencieux d'un compte vivant).
 * - Secrets : mot de passe via env uniquement (jamais en dur ni en log) ;
 *   omnifi_client_user_id = placeholder, remplacé à l'enrôlement Omni-FI réel
 *   (POST /clients/end-users, pipeline semaines 3-5).
 */
import argon2 from "argon2";
import { neonConfig, Pool } from "@neondatabase/serverless";

const EMAIL_ADMIN = "enardou@omni-fi.co";
const NOM_ADMIN = "Administrateur TYGR";
const WORKSPACE_NOM = "Omni-FI HQ";
const WORKSPACE_CLIENT_USER_ID = "seed-omnifi-hq";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

function exigerEnv(nom, options = {}) {
  const valeur = process.env[nom];
  if (!valeur) {
    console.error(`${nom} manquante — voir .env.example.`);
    process.exit(1);
  }
  if (options.longueurMin && valeur.length < options.longueurMin) {
    console.error(`${nom} : ${options.longueurMin} caractères minimum.`);
    process.exit(1);
  }
  return valeur;
}

const databaseUrl = exigerEnv("DATABASE_URL_ADMIN");
const motDePasse = exigerEnv("SEED_ADMIN_PASSWORD", { longueurMin: 12 });

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await client.query("BEGIN");

  // 1. Workspace (clé d'idempotence : omnifi_client_user_id unique).
  let res = await client.query(
    "select id from workspaces where omnifi_client_user_id = $1",
    [WORKSPACE_CLIENT_USER_ID],
  );
  let workspaceId = res.rows[0]?.id;
  if (!workspaceId) {
    res = await client.query(
      `insert into workspaces (name, kind, base_currency, omnifi_client_user_id, omnifi_environment)
       values ($1, 'INTERNAL_BU', 'MUR', $2, 'sandbox') returning id`,
      [WORKSPACE_NOM, WORKSPACE_CLIENT_USER_ID],
    );
    workspaceId = res.rows[0].id;
    console.log(`Workspace « ${WORKSPACE_NOM} » créé.`);
  } else {
    console.log(`Workspace « ${WORKSPACE_NOM} » déjà présent.`);
  }

  // 2. Utilisateur ADMIN — jamais d'écrasement de mot de passe existant.
  res = await client.query(
    "select id from users where lower(email) = lower($1)",
    [EMAIL_ADMIN],
  );
  let userId = res.rows[0]?.id;
  if (!userId) {
    const hash = await argon2.hash(motDePasse);
    res = await client.query(
      `insert into users (email, full_name, password_hash)
       values ($1, $2, $3) returning id`,
      [EMAIL_ADMIN.toLowerCase(), NOM_ADMIN, hash],
    );
    userId = res.rows[0].id;
    console.log(`Utilisateur ${EMAIL_ADMIN} créé.`);
  } else {
    console.log(
      `Utilisateur ${EMAIL_ADMIN} déjà présent — mot de passe inchangé.`,
    );
  }

  // 3. Membership ADMIN — FORCE RLS : le contexte tenant doit être posé,
  //    même pour l'owner (set_config transactionnel, jamais session-level).
  await client.query("select set_config('app.current_workspace_id', $1, true)", [
    workspaceId,
  ]);
  await client.query(
    `insert into workspace_members (user_id, workspace_id, role)
     values ($1, $2, 'ADMIN')
     on conflict (user_id, workspace_id) do nothing`,
    [userId, workspaceId],
  );

  await client.query("COMMIT");
  console.log("Seed terminé : ADMIN rattaché à « Omni-FI HQ ».");
} catch (erreur) {
  await client.query("ROLLBACK");
  console.error("Seed échoué — transaction annulée.");
  throw erreur;
} finally {
  client.release();
  await pool.end();
}
