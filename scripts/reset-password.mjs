/**
 * Réinitialise le mot de passe d'UN utilisateur existant (base LOCALE de dev).
 *
 * RAISON D'ÊTRE : `seed-admin.mjs` n'écrase JAMAIS un mot de passe existant
 * (volontaire — provisioning initial seulement). Ce script comble le cas « j'ai
 * oublié le mot de passe de mon compte local ». Il met à jour UNIQUEMENT la colonne
 * `password_hash` de l'utilisateur ciblé, avec un hash argon2 (l'algo que l'app
 * vérifie au login). Ne touche à RIEN d'autre.
 *
 * Usage :
 *   RESET_EMAIL='enardou@omni-fi.co' RESET_PASSWORD='<nouveau mdp>' \
 *     node --env-file=.env scripts/reset-password.mjs
 *   (ou sourcer .env.prod avant, pour cibler la même base que le serveur de test)
 *
 * Le mot de passe vient de l'ENV (jamais en argument, jamais loggé). Min 12 car.
 * Rôle OWNER (DATABASE_URL_ADMIN) : opération d'administration, comme seed-admin.
 *
 * AUTH-MDP-TEMPO1 (D7) : un reset est un POSAGE de mot de passe →
 * `password_changed_at = now()` systématique — toute session ouverte du compte
 * meurt à sa prochaine requête gardée (invalidation D4, voulu). Et
 * `RESET_MUST_CHANGE=1` (défaut 0) pose en plus le flag de forçage : à utiliser
 * quand on resette un TIERS (il devra choisir son propre secret) ; l'usage dev
 * courant — se resetter soi-même — ne se re-gate pas.
 *
 * ⚠️ DEV LOCAL UNIQUEMENT. Ne jamais pointer une base de production avec ce script.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";
import argon2 from "argon2";

if (typeof WebSocket !== "undefined") neonConfig.webSocketConstructor = WebSocket;
if (process.env.NEON_WSPROXY_LOCAL) {
  const proxy = process.env.NEON_WSPROXY_LOCAL;
  neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

function exigerEnv(nom, { longueurMin } = {}) {
  const v = process.env[nom];
  if (!v || v.trim() === "") {
    console.error(`${nom} manquante.`);
    process.exit(1);
  }
  if (longueurMin && v.length < longueurMin) {
    console.error(`${nom} trop court (min ${longueurMin} caractères).`);
    process.exit(1);
  }
  return v;
}

const email = exigerEnv("RESET_EMAIL").trim().toLowerCase();
const motDePasse = exigerEnv("RESET_PASSWORD", { longueurMin: 12 });

// Garde-fou anti-prod : refuse une base Neon distante (host *.neon.tech) — ce script
// est strictement dev-local. La base locale passe par le wsproxy (host interne).
const dbUrl = process.env.DATABASE_URL_ADMIN ?? "";
if (/neon\.tech/.test(dbUrl)) {
  console.error(
    "Refus : DATABASE_URL_ADMIN pointe un hôte neon.tech (distant/prod). " +
      "Ce script est réservé à la base LOCALE de dev.",
  );
  process.exit(1);
}

const doitChanger = process.env.RESET_MUST_CHANGE === "1";

const pool = new Pool({ connectionString: dbUrl });
try {
  const hash = await argon2.hash(motDePasse);
  const res = await pool.query(
    `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL,
       password_changed_at = now(), must_change_password = $3
     WHERE lower(email) = lower($1) RETURNING email`,
    [email, hash, doitChanger],
  );
  if (res.rowCount === 0) {
    console.error(`Aucun utilisateur '${email}' dans cette base — rien modifié.`);
    process.exitCode = 1;
  } else {
    // On réinitialise aussi le compteur d'échecs / verrou (au cas où le compte
    // aurait été verrouillé par des tentatives). Le mot de passe n'est jamais affiché.
    console.log(`✅ Mot de passe réinitialisé pour ${res.rows[0].email} (verrou levé).`);
  }
} catch (e) {
  console.error("Échec :", e?.message ?? String(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
