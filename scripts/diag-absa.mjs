/**
 * Diagnostic LECTURE SEULE (que des SELECT) — « pourquoi je ne vois pas les
 * comptes / transactions Absa ? ». Aucune écriture, aucun DELETE. Tourne sous le
 * rôle OWNER (DATABASE_URL_ADMIN) UNIQUEMENT pour VOIR la vérité au-delà de la RLS
 * (un compte entity_id=NULL est invisible en Vision Entité — c'est justement ce
 * qu'on veut diagnostiquer). Ne fait AUCUNE mutation → n'altère pas l'isolation.
 *
 * Usage :  node --env-file=.env scripts/diag-absa.mjs
 * (jetable — à supprimer après diagnostic.)
 */
import { neonConfig, Pool } from "@neondatabase/serverless";

if (typeof WebSocket !== "undefined") neonConfig.webSocketConstructor = WebSocket;
// DEV LOCAL — même câblage wsproxy que src/db/index.ts / seed-admin.mjs.
if (process.env.NEON_WSPROXY_LOCAL) {
  const proxy = process.env.NEON_WSPROXY_LOCAL;
  neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

const url = process.env.DATABASE_URL_ADMIN;
if (!url) {
  console.error("DATABASE_URL_ADMIN manquante — lance avec: node --env-file=.env scripts/diag-absa.mjs");
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const client = await pool.connect();

try {
  // 1. Connexions Absa (toutes workspaces — dev local mono-tenant en principe).
  const conns = await client.query(
    `select c.id, c.workspace_id, w.name as ws_name, c.institution_name,
            c.institution_id, c.status, c.next_sync_available_at, c.created_at
       from bank_connections c
       join workspaces w on w.id = c.workspace_id
      where c.institution_name ilike '%absa%'
         or c.institution_id ilike '%absa%'
      order by c.created_at desc`,
  );

  if (conns.rowCount === 0) {
    console.log("❌ AUCUNE connexion Absa en base.");
    console.log("   → soit la connexion a échoué (cf. LOGIN_FAILED précédent),");
    console.log("     soit elle a été créée sous un autre workspace.");
    // Liste toutes les connexions pour lever le doute.
    const all = await client.query(
      `select institution_name, status, created_at from bank_connections order by created_at desc limit 20`,
    );
    console.log("\n   Connexions présentes (20 dernières) :");
    for (const r of all.rows) {
      console.log(`   · ${r.institution_name ?? "(sans nom)"} — ${r.status} — ${r.created_at.toISOString()}`);
    }
    process.exit(0);
  }

  for (const c of conns.rows) {
    console.log("\n================================================================");
    console.log(`CONNEXION  ${c.institution_name ?? "(sans nom d'institution)"}`);
    console.log(`  id            ${c.id}`);
    console.log(`  workspace     ${c.ws_name} (${c.workspace_id})`);
    console.log(`  statut        ${c.status}`);
    console.log(`  créée le      ${c.created_at.toISOString()}`);
    console.log(`  next_sync_at  ${c.next_sync_available_at ? c.next_sync_available_at.toISOString() : "— (jamais synchronisée)"}`);

    // 2. Comptes rattachés à cette connexion (+ entité + fraîcheur + nb transactions).
    const accts = await client.query(
      `select a.id, a.account_name, a.currency, a.current_balance, a.is_selected,
              a.last_synced_at, a.entity_id, e.name as entity_name,
              (select count(*) from transactions_cache t
                 where t.bank_account_id = a.id and t.is_removed = false) as nb_tx
         from bank_accounts a
         left join entities e on e.id = a.entity_id
        where a.connection_id = $1
        order by a.account_name`,
      [c.id],
    );

    console.log(`\n  COMPTES RATTACHÉS : ${accts.rowCount}`);
    if (accts.rowCount === 0) {
      console.log("    (aucun compte rattaché — la découverte de comptes n'a rien remonté)");
    }
    for (const a of accts.rows) {
      const entite = a.entity_id
        ? `entité=${a.entity_name ?? a.entity_id}`
        : "entité=NULL ⚠️ (INVISIBLE en Vision Entité — visible ADMIN/Vision Globale seulement)";
      const synced = a.last_synced_at ? a.last_synced_at.toISOString() : "jamais";
      console.log(`    • ${a.account_name} [${a.currency}] solde=${a.current_balance ?? "—"} selected=${a.is_selected}`);
      console.log(`        ${entite}`);
      console.log(`        last_synced=${synced}  transactions=${a.nb_tx}`);
    }
  }

  console.log("\n================================================================");
  console.log("Lecture des indices :");
  console.log("  · comptes rattachés > 0 mais entity_id=NULL  → connexion OK, comptes");
  console.log("    dans le SAS d'assignation (invisibles en Vision Entité). À assigner.");
  console.log("  · transactions=0 sur tous les comptes        → le SYNC n'a pas (encore)");
  console.log("    tourné : la connexion ne rapatrie QUE les comptes, pas les mouvements.");
  console.log("  · 0 connexion / 0 compte                     → la connexion a échoué.");
} finally {
  client.release();
  await pool.end();
}
