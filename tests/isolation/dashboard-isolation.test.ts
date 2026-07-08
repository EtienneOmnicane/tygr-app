/**
 * Suite anti-IDOR — services de lecture du dashboard (Epic 3, CLAUDE.md règle 2).
 *
 * Prouve sur Postgres réel (PGlite) que chaque service de lecture ne renvoie QUE
 * les données du workspace courant (RLS), et vérifie la justesse des agrégats
 * (somme consolidée, synthèse mois, courbe) sur données factices injectées.
 * Rôle tygr_app non-propriétaire (sinon la RLS est ignorée).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  courbeTresorerie,
  listerComptes,
  listerConnexionsBancaires,
  soldeConsolideCourant,
  syntheseMois,
  syntheseMoisParDevise,
  transactionsRecentes,
} from "@/server/repositories/dashboard";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ACC_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** 2e compte de WS_A, en USD — is_selected=false pour ne pas changer listerComptes
 *  (qui filtre is_selected), tout en alimentant syntheseMoisParDevise (multi-devise). */
const ACC_A_USD = "aaaa3333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_B = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONN_A = "aaaacccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "bbbbcccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

beforeAll(async () => {
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // Seed owner (bypass RLS). Workspace A riche, B minimal (témoin d'isolation).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','A','INTERNAL_BU','eu-a'), ('${WS_B}','B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ALICE}','a@g.mu','A'), ('${BOB}','b@g.mu','B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}','${WS_A}','MANAGER'), ('${BOB}','${WS_B}','MANAGER');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ALICE}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected) values
      ('${ACC_A}','${WS_A}','${CONN_A}','oa-a','Compte A','MUR','5000.00',true),
      ('${ACC_A_USD}','${WS_A}','${CONN_A}','oa-a-usd','Compte A USD','USD','800.00',false),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true);
    -- Soldes EOD A (2 jours), B (1 jour, valeur distincte pour détecter une fuite)
    insert into balance_history (workspace_id, bank_account_id, balance_date, balance, currency) values
      ('${WS_A}','${ACC_A}','2026-06-09','4000.00','MUR'),
      ('${WS_A}','${ACC_A}','2026-06-10','5000.00','MUR'),
      ('${WS_B}','${ACC_B}','2026-06-10','9999.00','MUR');
    -- Transactions A (juin) : 1 crédit 1000, 1 débit 300 ; B : 1 débit 7777 (témoin)
    insert into transactions_cache (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, clean_label, is_removed) values
      ('${WS_A}','${ACC_A}','txa1','2026-06-05','2026-06-05T05:30:00Z','1000.00','MUR','Credit','VIR RECU','Client A',false),
      ('${WS_A}','${ACC_A}','txa2','2026-06-08','2026-06-08T05:30:00Z','300.00','MUR','Debit','LOYER','Bailleur',false),
      ('${WS_A}','${ACC_A}','txa3','2026-06-08','2026-06-08T05:30:00Z','99.00','MUR','Debit','SUPPRIMÉ','X',true),
      -- USD sur WS_A (compte USD) : 1 crédit 500, 1 débit 200 → entrées 500 / sorties 200 / var 300 en USD
      ('${WS_A}','${ACC_A_USD}','txa-usd1','2026-06-06','2026-06-06T05:30:00Z','500.00','USD','Credit','WIRE IN','Client US',false),
      ('${WS_A}','${ACC_A_USD}','txa-usd2','2026-06-09','2026-06-09T05:30:00Z','200.00','USD','Debit','FEES','Bank',false),
      ('${WS_B}','${ACC_B}','txb1','2026-06-05','2026-06-05T05:30:00Z','7777.00','MUR','Debit','SECRET B','B',false);
  `);

  const provisioning = readFileSync(
    path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
    "utf8",
  );
  await client.exec(provisioning);
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

describe("isolation : chaque service ne voit que le workspace courant", () => {
  it("listerComptes — A voit 1 compte, B voit le sien (jamais l'autre)", async () => {
    const a = await withWorkspace(sessionA, (tx) => listerComptes(tx));
    const b = await withWorkspace(sessionB, (tx) => listerComptes(tx));
    expect(a.map((c) => c.accountName)).toEqual(["Compte A"]);
    expect(b.map((c) => c.accountName)).toEqual(["Compte B"]);
  });

  it("listerConnexionsBancaires — A voit sa connexion (2 comptes), B la sienne (1), jamais l'autre", async () => {
    const a = await withWorkspace(sessionA, (tx) =>
      listerConnexionsBancaires(tx),
    );
    const b = await withWorkspace(sessionB, (tx) =>
      listerConnexionsBancaires(tx),
    );
    // A ne voit QUE CONN_A (compte le total des comptes rattachés, sélectionnés ou non).
    expect(a.map((c) => c.connectionId)).toEqual([CONN_A]);
    expect(a[0]?.nbComptes).toBe(2);
    // B ne voit QUE CONN_B (jamais la connexion de A — isolation tenant).
    expect(b.map((c) => c.connectionId)).toEqual([CONN_B]);
    expect(b[0]?.nbComptes).toBe(1);
  });

  it("soldeConsolideCourant — A=5000 (dernier EOD), jamais le 9999 de B", async () => {
    const a = await withWorkspace(sessionA, (tx) => soldeConsolideCourant(tx));
    expect(a).toBe("5000.00");
    const b = await withWorkspace(sessionB, (tx) => soldeConsolideCourant(tx));
    expect(b).toBe("9999.00");
  });

  it("courbeTresorerie — A a 2 points, aucune ligne de B ne fuit", async () => {
    const a = await withWorkspace(sessionA, (tx) =>
      courbeTresorerie(tx, { from: "2026-06-01", to: "2026-06-30" }),
    );
    expect(a.map((p) => p.date)).toEqual(["2026-06-09", "2026-06-10"]);
    expect(a.map((p) => p.soldeConsolide)).toEqual(["4000.00", "5000.00"]);
  });

  it("syntheseMois (@deprecated) — A : SOMME cross-devise MUR+USD (le bug que corrige syntheseMoisParDevise)", async () => {
    // WS_A a 1000 MUR + 500 USD en crédit, 300 MUR + 200 USD en débit. syntheseMois
    // additionne TOUT sans distinguer la devise → entrées 1500, sorties 500. C'est
    // EXACTEMENT le comportement faux (mélange roupies/dollars) qui motive
    // syntheseMoisParDevise. On fige ici la sémantique dépréciée (tombstone 99 exclu).
    const a = await withWorkspace(sessionA, (tx) => syntheseMois(tx, "2026-06"));
    expect(a.entrees).toBe("1500.00"); // 1000 MUR + 500 USD additionnés à tort
    expect(a.sorties).toBe("500.00"); // 300 MUR + 200 USD ; le débit 99 is_removed exclu
    expect(a.variation).toBe("1000.00");
  });

  it("syntheseMois — B ne voit jamais le débit 7777 de... B uniquement", async () => {
    const b = await withWorkspace(sessionB, (tx) => syntheseMois(tx, "2026-06"));
    expect(b.sorties).toBe("7777.00");
    const a = await withWorkspace(sessionA, (tx) => syntheseMois(tx, "2026-06"));
    // Le 7777 de B n'apparaît JAMAIS dans la synthèse de A (sorties A = 300 MUR + 200 USD).
    expect(a.sorties).toBe("500.00");
  });

  it("transactionsRecentes — A exclut le tombstone et ne voit aucune ligne de B", async () => {
    const a = await withWorkspace(sessionA, (tx) => transactionsRecentes(tx, 10));
    const ids = a.map((t) => t.omnifiTxnId);
    expect(ids).toContain("txa1");
    expect(ids).toContain("txa2");
    expect(ids).not.toContain("txa3"); // tombstone
    expect(ids).not.toContain("txb1"); // workspace B
  });
});

describe("syntheseMoisParDevise — entrées/sorties VENTILÉES par devise (multi-devise correct)", () => {
  it("A : une ligne MUR (entrées 1000 / sorties 300) ET une ligne USD (entrées 500 / sorties 200), jamais d'addition cross-devise", async () => {
    const lignes = await withWorkspace(sessionA, (tx) =>
      syntheseMoisParDevise(tx, "2026-06"),
    );
    // Ordonné par devise : MUR puis USD.
    const parDevise = new Map(lignes.map((l) => [l.currency, l]));

    const mur = parDevise.get("MUR");
    expect(mur?.entrees).toBe("1000.00");
    expect(mur?.sorties).toBe("300.00"); // tombstone 99 exclu
    expect(mur?.variation).toBe("700.00");

    const usd = parDevise.get("USD");
    expect(usd?.entrees).toBe("500.00");
    expect(usd?.sorties).toBe("200.00");
    expect(usd?.variation).toBe("300.00");

    // Exactement 2 devises, aucune somme MUR+USD (anti-régression du bug syntheseMois).
    expect(lignes.map((l) => l.currency)).toEqual(["MUR", "USD"]);
  });

  it("tenant-scopé : B ne voit QUE sa ligne MUR (sorties 7777), jamais l'USD de A", async () => {
    const lignes = await withWorkspace(sessionB, (tx) =>
      syntheseMoisParDevise(tx, "2026-06"),
    );
    expect(lignes.map((l) => l.currency)).toEqual(["MUR"]);
    expect(lignes[0].sorties).toBe("7777.00");
    expect(lignes.find((l) => l.currency === "USD")).toBeUndefined();
  });

  it("mois sans transaction → tableau vide (l'UI affichera 0 dans la devise de base)", async () => {
    const lignes = await withWorkspace(sessionA, (tx) =>
      syntheseMoisParDevise(tx, "2020-01"),
    );
    expect(lignes).toEqual([]);
  });
});

// ── Garde-fou L7a : la suite tourne-t-elle vraiment sous tygr_app ? ───────────
// Sans cette précondition, un `set role tygr_app` régressé ferait tourner la suite
// sous l'owner (RLS ignorée) en passant au vert silencieusement (faux-vert).
describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app, pas sous l'owner (sinon la RLS est ignorée)", async () => {
    await client.exec(`set role tygr_app;`);
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

// Contre-preuve R1 : prouve POURQUOI le rôle non-owner est vital. Sous l'owner la
// frontière tenant ne filtre pas ; sous tygr_app elle filtre. Si l'app pointait sur
// l'owner (RLS contournée), R1a casserait — l'angle mort devient bloquant.
describe("contre-preuve R1 : la RLS NE protège PAS sous le propriétaire", () => {
  afterAll(async () => {
    // Restaure l'invariant pour toute exécution ultérieure : rôle applicatif.
    await client.exec(`set role tygr_app;`);
  });

  it("R1a. sous l'owner, un SELECT sans contexte voit l'AUTRE tenant (RLS ignorée)", async () => {
    await client.exec(`reset role;`);
    const res = await client.query<{ workspace_id: string }>(
      "select workspace_id from workspace_members",
    );
    expect(res.rows.some((r) => r.workspace_id === WS_B)).toBe(true);
  });

  it("R1b. sous tygr_app, le contexte A ne voit JAMAIS le tenant B (la RLS filtre)", async () => {
    await client.exec(`set role tygr_app;`);
    const vus = await withWorkspace(sessionA, (tx) =>
      tx.select().from(schema.workspaceMembers),
    );
    expect(vus.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(vus.some((r) => r.workspaceId === WS_B)).toBe(false);
  });
});
