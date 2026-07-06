/**
 * Seed du RÉFÉRENTIEL DE CATÉGORIES de trésorerie (Pilier 1, ventilation manuelle)
 * — script de RATTRAPAGE multi-workspace.
 *
 * Pourquoi : la table `categories` naît vierge → l'UI de ventilation des transactions
 * affiche « Aucune catégorie ». Ce script injecte le référentiel standard pour CHAQUE
 * workspace qui n'en a encore aucune. Depuis QA-ONBOARD-CATEG1, les workspaces créés
 * en CLI naissent DÉJÀ pourvus (seed-admin.mjs / seed-omnifi-demo.ts appellent la même
 * lib) — ce script reste utile pour les bases antérieures et comme filet.
 *
 * Usage : npm run seed:categories   (DATABASE_URL_ADMIN requis)
 *
 * Garanties (portées par scripts/seed-categories-lib.mjs, source unique de la
 * logique d'insertion — voir son en-tête) :
 * - Rôle OWNER (DATABASE_URL_ADMIN) : opération d'administration, même statut que les
 *   migrations (exception documentée CLAUDE.md règle 2). JAMAIS le rôle applicatif.
 * - FORCE RLS respectée : GUC tenant posé DANS la transaction, par workspace.
 * - IDEMPOTENT par workspace : déjà pourvu ⇒ ignoré (log), jamais de doublon.
 * - Une transaction PAR workspace : échec ⇒ rollback de CE workspace uniquement,
 *   aucune catégorie partielle.
 * - Multi-workspace : parcourt tous les workspaces (décision 2026-06-22). La portée
 *   est INTRA-TENANT (catégories scopées workspace_id) — aucune fuite cross-tenant.
 * - Pas de DELETE : `categories` s'archive (is_active=false), jamais ne se supprime.
 *
 * Taxonomie : src/lib/categories-referentiel.mjs (alignée sur le vocabulaire
 * d'affichage src/lib/categories-fr.ts). Toute extension = éditer le référentiel,
 * le script reste idempotent.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";

import { seederCategoriesWorkspace } from "./seed-categories-lib.mjs";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

// DEV LOCAL UNIQUEMENT — même câblage wsproxy que src/db/index.ts et seed-admin.mjs.
if (process.env.NEON_WSPROXY_LOCAL) {
  const proxy = process.env.NEON_WSPROXY_LOCAL;
  neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

function exigerEnv(nom) {
  const valeur = process.env[nom];
  if (!valeur) {
    console.error(`${nom} manquante — voir .env.example.`);
    process.exit(1);
  }
  return valeur;
}

const databaseUrl = exigerEnv("DATABASE_URL_ADMIN");
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

/** Compte total de catégories injectées (tous workspaces confondus). */
let totalInsere = 0;
let workspacesSeedes = 0;

try {
  // Liste des workspaces (le seed est intra-tenant : on boucle puis la lib pose
  // le GUC par workspace, dans une transaction dédiée).
  const wsRes = await client.query("select id, name from workspaces order by name");
  if (wsRes.rows.length === 0) {
    console.log("Aucun workspace — rien à seeder. (Lancer seed:admin d'abord ?)");
  }

  for (const ws of wsRes.rows) {
    let insereWs;
    try {
      insereWs = await seederCategoriesWorkspace(client, ws.id);
    } catch (erreurWs) {
      console.error(
        `Workspace « ${ws.name} » : échec — transaction annulée (aucune catégorie partielle).`,
      );
      throw erreurWs;
    }

    if (insereWs === 0) {
      console.log(`Workspace « ${ws.name} » : déjà pourvu — ignoré.`);
      continue;
    }
    totalInsere += insereWs;
    workspacesSeedes += 1;
    console.log(`Workspace « ${ws.name} » : ${insereWs} catégories injectées.`);
  }

  console.log(
    `Seed terminé : ${totalInsere} catégories sur ${workspacesSeedes} workspace(s).`,
  );
} finally {
  client.release();
  await pool.end();
}
