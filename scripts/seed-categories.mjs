/**
 * Seed du RÉFÉRENTIEL DE CATÉGORIES de trésorerie (Pilier 1, ventilation manuelle).
 *
 * Pourquoi : la table `categories` naît vierge → l'UI de ventilation des transactions
 * affiche « Aucune catégorie ». Ce script injecte un référentiel de base (Natures +
 * Sous-natures) pour CHAQUE workspace qui n'en a encore aucune.
 *
 * Usage : npm run seed:categories   (DATABASE_URL_ADMIN requis)
 *
 * Garanties (calque sur scripts/seed-admin.mjs) :
 * - Rôle OWNER (DATABASE_URL_ADMIN) : opération d'administration, même statut que les
 *   migrations (exception documentée CLAUDE.md règle 2). JAMAIS le rôle applicatif.
 * - `categories` est sous FORCE RLS (tenant_isolation) : l'owner lui-même doit
 *   satisfaire la policy → on pose app.current_workspace_id DANS la transaction, par
 *   workspace (set_config transactionnel, jamais session-level ; aucun BYPASSRLS — le
 *   modèle d'isolation reste entier). Le WITH CHECK valide alors chaque INSERT.
 * - IDEMPOTENT par workspace : on NE seede QUE les workspaces à 0 catégorie. Re-lançable
 *   sans créer de doublon (un workspace déjà pourvu est ignoré, log « déjà pourvu »).
 *   On ne touche JAMAIS un référentiel existant (pas d'écrasement d'un workspace vivant).
 * - Multi-workspace : parcourt tous les workspaces (décision 2026-06-22). La portée
 *   est INTRA-TENANT (catégories scopées workspace_id) — aucune fuite cross-tenant.
 * - Pas de DELETE : `categories` s'archive (is_active=false), jamais ne se supprime.
 *
 * Taxonomie : alignée sur le vocabulaire d'affichage `src/lib/categories-fr.ts`
 * (Revenus, Charges, Salaires, Taxes, Assurances, Frais bancaires…) pour que la
 * catégorie MANUELLE et la catégorie OBIE traduite parlent la même langue métier.
 * Volontairement COMPACTE : un socle raisonnable, l'ADMIN affine ensuite via l'UI
 * (creerCategorie). Toute extension = éditer ce tableau, le script reste idempotent.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";

import { REFERENTIEL_CATEGORIES } from "./categories-referentiel.mjs";

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
  // Liste des workspaces (le seed est intra-tenant : on boucle puis on pose le GUC).
  const wsRes = await client.query("select id, name from workspaces order by name");
  if (wsRes.rows.length === 0) {
    console.log("Aucun workspace — rien à seeder. (Lancer seed:admin d'abord ?)");
  }

  for (const ws of wsRes.rows) {
    await client.query("BEGIN");
    try {
      // FORCE RLS : poser le contexte tenant AVANT toute lecture/écriture de
      // `categories` (sinon tenant_isolation masque tout / rejette les INSERT).
      await client.query(
        "select set_config('app.current_workspace_id', $1, true)",
        [ws.id],
      );

      // Idempotence : un workspace qui a DÉJÀ ≥1 catégorie n'est pas re-seedé.
      // Filtre EXPLICITE sur workspace_id (et pas seulement la RLS) : robuste quel
      // que soit le rôle exécutant. Le rôle owner peut être BYPASSRLS sur certaines
      // plateformes (ex. superuser) → s'appuyer sur la seule RLS pour scoper ce
      // garde donnerait un faux « déjà pourvu » (il verrait les autres tenants).
      // Défense en profondeur cohérente avec le reste du code (RLS + WHERE workspace_id).
      const dejaRes = await client.query(
        "select 1 from categories where workspace_id = $1 limit 1",
        [ws.id],
      );
      if (dejaRes.rows.length > 0) {
        await client.query("COMMIT");
        console.log(`Workspace « ${ws.name} » : déjà pourvu — ignoré.`);
        continue;
      }

      let insereWs = 0;
      for (const groupe of REFERENTIEL_CATEGORIES) {
        // 1. Nature (parent_id NULL). RETURNING id pour rattacher les enfants.
        const natRes = await client.query(
          `insert into categories (workspace_id, name, parent_id)
           values ($1, $2, null) returning id`,
          [ws.id, groupe.nature],
        );
        const parentId = natRes.rows[0].id;
        insereWs += 1;

        // 2. Sous-natures (parent_id = la Nature, dans le MÊME workspace : la FK
        //    composite (parent_id, workspace_id) → (id, workspace_id) l'exige).
        for (const sous of groupe.sousNatures) {
          await client.query(
            `insert into categories (workspace_id, name, parent_id)
             values ($1, $2, $3)`,
            [ws.id, sous, parentId],
          );
          insereWs += 1;
        }
      }

      await client.query("COMMIT");
      totalInsere += insereWs;
      workspacesSeedes += 1;
      console.log(
        `Workspace « ${ws.name} » : ${insereWs} catégories injectées.`,
      );
    } catch (erreurWs) {
      await client.query("ROLLBACK");
      console.error(
        `Workspace « ${ws.name} » : échec — transaction annulée (aucune catégorie partielle).`,
      );
      throw erreurWs;
    }
  }

  console.log(
    `Seed terminé : ${totalInsere} catégories sur ${workspacesSeedes} workspace(s).`,
  );
} finally {
  client.release();
  await pool.end();
}
