/**
 * Seed de démonstration — peuple un workspace DEMO avec de VRAIES données Omni-FI
 * sandbox. À lancer manuellement (jamais en CI) :
 *
 *   node --env-file=.env node_modules/.bin/tsx scripts/seed-omnifi-demo.ts
 *
 * ⚠️ Ce script fait de VRAIS appels réseau à l'API Omni-FI sandbox avec la clé
 * de .env (OMNIFI_*). Il écrit en base via withWorkspace (rôle tygr_app, RLS).
 *
 * Données attendues en env (en plus des OMNIFI_* du client) :
 *   OMNIFI_DEMO_CLIENT_USER_ID = EndUser sandbox sous lequel les comptes sont
 *                                pré-connectés.
 *   OMNIFI_DEMO_ACCOUNT_IDS    = liste d'omnifi_account_id sandbox séparés par
 *                                des virgules (découverte de comptes hors surface
 *                                lecture PR 1 — voir dette TODOS).
 *
 * Le script trace chaque appel API (endpoint, statut) et imprime un rapport
 * final (connexions / comptes / transactions / soldes insérés). Aucune PII en
 * sortie (pas de libellé bancaire brut, pas de montant nominatif).
 */
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { eq } from "drizzle-orm";

import * as schema from "@/server/db/schema";
import { createWithWorkspace, type ExecuterWorkspace } from "@/server/db/tenancy";
import { creerClientOmniFi } from "@/server/omnifi";
import {
  ingererConnexions,
  synchroniserCompteComplet,
} from "@/server/ingestion";
import { upsertCompte } from "@/server/repositories/ingestion";

/* ---- Câblage Neon (identique aux autres scripts dev) ---- */
if (typeof WebSocket !== "undefined") neonConfig.webSocketConstructor = WebSocket;
if (process.env.NEON_WSPROXY_LOCAL) {
  const p = process.env.NEON_WSPROXY_LOCAL;
  neonConfig.wsProxy = (h, port) => `${p}/v1?address=${h}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

function exiger(nom: string): string {
  const v = process.env[nom];
  if (!v || v.trim() === "") {
    console.error(`✗ ${nom} manquante — voir .env.example.`);
    process.exit(1);
  }
  return v.trim();
}

/* ---- fetch instrumenté : trace endpoint + statut (jamais le secret/headers) ---- */
function fetchTrace(): typeof fetch {
  const base = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const chemin = new URL(url).pathname; // pas de query (peut porter des ids)
    const methode = init?.method ?? "GET";
    const t0 = Date.now();
    const r = await base(input, init);
    console.log(
      `  → ${methode} ${chemin} … ${r.status} ${r.statusText} (${Date.now() - t0}ms)`,
    );
    return r;
  };
}

async function main() {
  const databaseUrl = exiger("DATABASE_URL"); // rôle tygr_app (RLS), pas owner
  const clientUserId = exiger("OMNIFI_DEMO_CLIENT_USER_ID");
  const accountIds = exiger("OMNIFI_DEMO_ACCOUNT_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (accountIds.length === 0) {
    console.error("✗ OMNIFI_DEMO_ACCOUNT_IDS vide.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  const withWorkspace = createWithWorkspace(db);
  const client = creerClientOmniFi({ fetch: fetchTrace() });

  // 1. Workspace DEMO — créé/réutilisé via le rôle owner serait l'idéal, mais on
  //    reste sous tygr_app : le workspace doit donc préexister (seed-admin) OU
  //    être créé hors RLS. On le crée ici sous une connexion owner dédiée.
  const adminPool = new Pool({ connectionString: exiger("DATABASE_URL_ADMIN") });
  const ac = await adminPool.connect();
  let workspaceId: string;
  let adminUserId: string;
  try {
    const ws = await ac.query(
      `insert into workspaces (name, kind, base_currency, omnifi_client_user_id, omnifi_environment)
       values ('Démo TYGR (sandbox)', 'DEMO', 'MUR', $1, 'sandbox')
       on conflict (omnifi_client_user_id) do update set name = excluded.name
       returning id`,
      [clientUserId],
    );
    workspaceId = ws.rows[0].id;
    // Un user ADMIN rattaché (pour created_by + membership → withWorkspace).
    const u = await ac.query(
      `insert into users (email, full_name)
       values ('demo-seed@omni-fi.co', 'Démo Seed')
       on conflict (email) do update set full_name = excluded.full_name
       returning id`,
    );
    adminUserId = u.rows[0].id;
    await ac.query(
      `insert into workspace_members (user_id, workspace_id, role)
       values ($1, $2, 'ADMIN') on conflict do nothing`,
      [adminUserId, workspaceId],
    );
  } finally {
    ac.release();
    await adminPool.end();
  }

  const session = { userId: adminUserId, activeWorkspaceId: workspaceId };
  const executer: ExecuterWorkspace = (fn) => withWorkspace(session, fn);

  console.log(`\n=== SEED workspace DEMO ${workspaceId} (clientUserId=${clientUserId}) ===\n`);

  // 2. Connexions (appels réels).
  console.log("API — GET /connections :");
  const { connexions } = await ingererConnexions(client, executer, clientUserId);

  // 3. Rattacher chaque compte fourni puis le synchroniser.
  let totalTx = 0;
  let totalSoldes = 0;
  for (const omnifiAccountId of accountIds) {
    console.log(`\nCompte ${omnifiAccountId} :`);
    // Rattacher le compte à une connexion existante (la 1re du workspace).
    const { bankAccountId } = await executer(async (tx, ctx) => {
      const conn = await tx
        .select({ id: schema.bankConnections.id })
        .from(schema.bankConnections)
        .where(eq(schema.bankConnections.workspaceId, ctx.workspaceId))
        .limit(1);
      if (conn.length === 0) {
        throw new Error(
          "Aucune connexion en base — /connections n'a rien renvoyé pour ce clientUserId.",
        );
      }
      const { bankAccountId } = await upsertCompte(tx, ctx, conn[0].id, {
        omnifiAccountId,
        accountName: `Compte ${omnifiAccountId.slice(0, 8)}`,
        currency: "MUR",
        currentBalance: null,
        isSelected: true,
      });
      return { bankAccountId };
    });

    console.log("  API — sync transactions + balances/history :");
    const r = await synchroniserCompteComplet(client, executer, {
      omnifiAccountId,
      bankAccountId,
      clientUserId,
    });
    totalTx += r.sync.transactionsTraitees;
    totalSoldes += r.soldes;
    console.log(
      `  ✓ ${r.sync.transactionsTraitees} transactions (${r.sync.pages} pages), ${r.soldes} soldes`,
    );
  }

  // 4. Rapport + vérification en base.
  const verif = await executer(async (tx) => {
    const comptes = await tx.select().from(schema.bankAccounts);
    const txs = await tx.select().from(schema.transactionsCache);
    return { comptes: comptes.length, txs: txs.length };
  });

  console.log("\n=== RAPPORT FINAL ===");
  console.log(`  Connexions ingérées : ${connexions}`);
  console.log(`  Comptes rattachés   : ${accountIds.length}`);
  console.log(`  Transactions sync   : ${totalTx}`);
  console.log(`  Soldes EOD sync     : ${totalSoldes}`);
  console.log("\n=== VÉRIFICATION EN BASE (sous RLS, workspace démo) ===");
  console.log(`  bank_accounts        : ${verif.comptes} lignes`);
  console.log(`  transactions_cache   : ${verif.txs} lignes`);

  await pool.end();
}

main().catch((e) => {
  console.error("\n✗ SEED ÉCHOUÉ :", e instanceof Error ? e.message : e);
  process.exit(1);
});
