/**
 * Seed de DÉMONSTRATION du dashboard — données 100 % FICTIVES en base, SANS
 * widget ni API Omni-FI. Filet de sécurité démo : permet de visualiser le
 * dashboard peuplé (courbe 90 j, KPIs, transactions) même si le widget/API ne
 * sont pas joignables.
 *
 *   node --env-file=.env node_modules/.bin/tsx scripts/seed-dashboard-demo.ts [omnifi_client_user_id]
 *
 * Par défaut, cible le workspace dont omnifi_client_user_id correspond à
 * SEED_DASHBOARD_WORKSPACE_CUID (ou le 1er argument). Écrit via withWorkspace
 * (rôle tygr_app, RLS) en réutilisant les repositories d'ingestion — aucune
 * écriture DB ad-hoc. Idempotent (upserts sur omnifi_*_id).
 *
 * Règle 8 : montants en chaînes décimales, jamais de float. Dates comptables en
 * jours calendaires Maurice (les soldes EOD sont des dates nues, cf. doc Fern).
 * Données fictives uniquement (sociétés mauriciennes plausibles) — pas de PII réelle.
 *
 * RESET : chaque run purge d'abord les données de démo du workspace (rôle owner,
 * DELETE physique) pour un état déterministe — légitime ici car données 100 %
 * fictives. Ne JAMAIS pointer ce script sur un workspace contenant de la vraie donnée.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

import * as schema from "@/server/db/schema";
import { createWithWorkspace, type ExecuterWorkspace } from "@/server/db/tenancy";
import {
  upsertCompte,
  upsertConnexion,
  upsertSoldes,
  upsertTransactions,
  type SoldeAUpserter,
  type TransactionAUpserter,
} from "@/server/repositories/ingestion";

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
    console.error(`✗ ${nom} manquante — voir .env.`);
    process.exit(1);
  }
  return v.trim();
}

/* ------------------------------------------------------------------ */
/* Génération déterministe de 90 jours de flux (PME mauricienne)       */
/* ------------------------------------------------------------------ */

const ANCRE = "2026-06-12";
const DEBUT = "2026-03-14";
const SOLDE_OUVERTURE = 2_750_000; // Rs, en unités (converti en chaîne plus bas)

/** Charges récurrentes (jour du mois → débit). Montants en roupies entières. */
const RECURRENCES: Array<[jour: number, label: string, cat: string, sous: string, montant: number]> = [
  [1, "Loyer Ebène Cybercity", "Rent", "Office Rent", 95_000],
  [5, "CEB Électricité", "Utilities", "Electricity", 38_425],
  [10, "Emtel Fibre Business", "Utilities", "Telecom", 12_900],
  [15, "SWAN Assurance Flotte", "Insurance", "Vehicle Insurance", 14_500],
  [20, "MRA Paiement TVA", "Taxes", "VAT", 210_000],
  [25, "Virement Salaires", "Payroll", "Salaries", 845_000],
  [28, "MCB Frais de tenue", "Banking & Finance", "Bank Charges", 2_450],
];

/**
 * Encaissements clients (date → montant crédit). Calibrés pour une trésorerie
 * SAINE : ~1 600 k/mois d'entrées contre ~1 218 k/mois de charges → courbe qui
 * monte régulièrement sur la fenêtre 90 j. Sociétés mauriciennes plausibles.
 */
const ENCAISSEMENTS: Array<[date: string, client: string, montant: number]> = [
  ["2026-03-18", "IBL Ltd", 420_000],
  ["2026-03-26", "Beachcomber Resorts", 385_000],
  ["2026-04-02", "Rogers Capital", 540_000],
  ["2026-04-11", "ENL Property", 410_000],
  ["2026-04-22", "Currimjee Jeewanjee", 475_000],
  ["2026-05-05", "IBL Ltd", 520_000],
  ["2026-05-16", "Ciel Textile", 398_000],
  ["2026-05-27", "Rogers Capital", 610_000],
  ["2026-06-03", "Beachcomber Resorts", 432_000],
  ["2026-06-10", "ENL Property", 505_000],
];

/** Montant entier (roupies) → chaîne numeric "x.00" (règle 8, pas de float). */
function r(montant: number): string {
  return `${montant}.00`;
}

function joursFenetre(): string[] {
  const out: string[] = [];
  const cur = new Date(`${DEBUT}T00:00:00Z`);
  const fin = new Date(`${ANCRE}T00:00:00Z`);
  while (cur.getTime() <= fin.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Construit les transactions + soldes EOD cohérents pour un compte. */
function genererFlux(): {
  transactions: TransactionAUpserter[];
  soldes: SoldeAUpserter[];
} {
  type Brut = { date: string; label: string; cat: string; sous: string; montant: number; sens: "Credit" | "Debit" };
  const flux: Brut[] = [];

  for (const mois of [3, 4, 5, 6]) {
    for (const [jour, label, cat, sous, montant] of RECURRENCES) {
      const date = `2026-${String(mois).padStart(2, "0")}-${String(jour).padStart(2, "0")}`;
      if (date < DEBUT || date > ANCRE) continue;
      flux.push({ date, label, cat, sous, montant, sens: "Debit" });
    }
  }
  for (const [date, client, montant] of ENCAISSEMENTS) {
    flux.push({ date, label: `Virement reçu ${client}`, cat: "Income", sous: "Client Payments", montant, sens: "Credit" });
  }
  flux.sort((a, b) => a.date.localeCompare(b.date));

  const transactions: TransactionAUpserter[] = flux.map((f, i) => ({
    omnifiTxnId: `demo-tx-${String(i + 1).padStart(4, "0")}`,
    transactionDate: f.date,
    bookingDateTime: new Date(`${f.date}T05:30:00Z`), // 09:30 MUT, date comptable sans ambiguïté
    amount: r(f.montant),
    currency: "MUR",
    creditDebit: f.sens,
    bankLabelRaw: f.label.toUpperCase(),
    cleanLabel: f.label,
    primaryCategory: f.cat,
    subCategory: f.sous,
    // Démo : ces catégories sont toutes des pré-catégorisations OBIE valides →
    // marqueur de provenance cohérent (paire alignée sur le CHECK de cohérence).
    isAutoCategorized: true,
    categorySource: "OMNIFI",
    isRemoved: false,
  }));

  // Soldes EOD : cumul jour par jour (cohérent avec les transactions → KPI=courbe).
  const deltaParJour = new Map<string, number>();
  for (const f of flux) {
    deltaParJour.set(f.date, (deltaParJour.get(f.date) ?? 0) + (f.sens === "Credit" ? f.montant : -f.montant));
  }
  let solde = SOLDE_OUVERTURE;
  const soldes: SoldeAUpserter[] = joursFenetre().map((date) => {
    solde += deltaParJour.get(date) ?? 0;
    return { balanceDate: date, balance: r(solde), currency: "MUR" };
  });

  return { transactions, soldes };
}

/* ------------------------------------------------------------------ */
/* Exécution                                                          */
/* ------------------------------------------------------------------ */

async function main() {
  const databaseUrl = exiger("DATABASE_URL"); // rôle tygr_app (RLS)
  const cuid =
    process.argv[2] ?? process.env.SEED_DASHBOARD_WORKSPACE_CUID ?? "";
  if (!cuid) {
    console.error(
      "✗ Fournir l'omnifi_client_user_id du workspace cible (argument ou SEED_DASHBOARD_WORKSPACE_CUID).",
    );
    process.exit(1);
  }

  const adminPool = new Pool({ connectionString: exiger("DATABASE_URL_ADMIN") });
  const ac = await adminPool.connect();
  let workspaceId: string;
  let userId: string;
  try {
    const ws = await ac.query(
      "select id from workspaces where omnifi_client_user_id = $1",
      [cuid],
    );
    if (ws.rowCount === 0) {
      console.error(`✗ Aucun workspace avec omnifi_client_user_id = ${cuid}`);
      process.exit(1);
    }
    workspaceId = ws.rows[0].id;
    // Un membre habilité (ADMIN/MANAGER) pour created_by + session synthétique.
    const m = await ac.query(
      `select user_id from workspace_members
       where workspace_id = $1 and role in ('ADMIN','MANAGER') limit 1`,
      [workspaceId],
    );
    if (m.rowCount === 0) {
      console.error("✗ Aucun membre ADMIN/MANAGER sur ce workspace.");
      process.exit(1);
    }
    userId = m.rows[0].user_id;

    // RESET déterministe (rôle owner, hors RLS — script d'admin de démo) : purge
    // les données de démo du workspace avant ré-insertion, pour éviter des
    // transactions orphelines/tombstones accumulées entre deux runs (le nombre/
    // l'ordre des tx peut changer quand on ajuste le jeu). DELETE physique
    // assumé ICI car données 100 % fictives de démo (jamais de la vraie donnée).
    await ac.query(
      "delete from transactions_cache where workspace_id = $1",
      [workspaceId],
    );
    await ac.query(
      "delete from balance_history where workspace_id = $1",
      [workspaceId],
    );
    await ac.query(
      "delete from bank_accounts where workspace_id = $1",
      [workspaceId],
    );
    await ac.query(
      "delete from bank_connections where workspace_id = $1",
      [workspaceId],
    );
    console.log("Reset des données de démo du workspace effectué.");
  } finally {
    ac.release();
    await adminPool.end();
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  const withWorkspace = createWithWorkspace(db);
  const session = { userId, activeWorkspaceId: workspaceId };
  const executer: ExecuterWorkspace = (fn) => withWorkspace(session, fn);

  console.log(`\n=== SEED dashboard démo → workspace ${workspaceId} ===\n`);

  const { transactions, soldes } = genererFlux();

  const bankAccountId = await executer(async (tx, ctx) => {
    const { connectionId } = await upsertConnexion(tx, ctx, {
      omnifiConnectionId: "demo-conn-mcb",
      institutionId: "mcb",
      institutionName: "The Mauritius Commercial Bank",
      status: "active",
      nextSyncAvailableAt: null,
    });
    const { bankAccountId } = await upsertCompte(tx, ctx, connectionId, {
      omnifiAccountId: "demo-acc-mcb-4521",
      accountName: "MCB — Compte courant business",
      currency: "MUR",
      currentBalance: soldes[soldes.length - 1].balance,
      isSelected: true,
    });
    return bankAccountId;
  });

  await executer((tx, ctx) => upsertTransactions(tx, ctx, bankAccountId, transactions));
  await executer((tx, ctx) => upsertSoldes(tx, ctx, bankAccountId, soldes));

  // Vérification (sous RLS).
  const verif = await executer(async (tx) => ({
    comptes: (await tx.select().from(schema.bankAccounts)).length,
    txs: (await tx.select().from(schema.transactionsCache)).length,
    soldes: (await tx.select().from(schema.balanceHistory)).length,
  }));

  console.log("=== RAPPORT ===");
  console.log(`  Connexion + compte    : MCB •••• 4521`);
  console.log(`  Transactions insérées : ${transactions.length}`);
  console.log(`  Soldes EOD insérés    : ${soldes.length}`);
  console.log(`  Solde courant         : ${soldes[soldes.length - 1].balance} MUR`);
  console.log("\n=== VÉRIFICATION EN BASE (sous RLS) ===");
  console.log(`  bank_accounts      : ${verif.comptes}`);
  console.log(`  transactions_cache : ${verif.txs}`);
  console.log(`  balance_history    : ${verif.soldes}`);

  await pool.end();
}

main().catch((e) => {
  console.error("\n✗ SEED ÉCHOUÉ :", e instanceof Error ? e.message : e);
  process.exit(1);
});
