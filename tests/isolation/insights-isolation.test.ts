/**
 * Suite anti-IDOR + justesse — Insights dérivés (TECH-API-INSIGHTS, Voie A).
 *
 * Prouve sur Postgres réel (PGlite) que `cashflowParDevise` et
 * `vendorsParConcentration` :
 *  1. ne renvoient QUE les données du workspace courant (RLS tenant_isolation) — un
 *     workspace ne voit jamais le cashflow/les vendors d'un autre (anti-IDOR, règle 2) ;
 *  2. agrègent correctement, PAR DEVISE, sans addition cross-devise (règle 8) ;
 *  3. excluent les tombstones (is_removed) ;
 *  4. replient le libellé vendor (clean_label → primary_category → "(Sans libellé)")
 *     et calculent `part` relative à la devise (jamais cross-devise).
 *
 * Rôle tygr_app NON-propriétaire (sinon la RLS est ignorée). Même squelette de seed
 * que dashboard-isolation.test.ts (migrations → seed owner → provisioning → set role).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  cashflowParDevise,
  vendorsParConcentration,
} from "@/server/repositories/insights";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ACC_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_A_USD = "aaaa3333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_A_EUR = "aaaa4444-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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

  // WS_A : comptes MUR + USD (multi-devise). WS_B : MUR (témoin d'isolation).
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
      ('${ACC_A_USD}','${WS_A}','${CONN_A}','oa-a-usd','Compte A USD','USD','800.00',true),
      ('${ACC_A_EUR}','${WS_A}','${CONN_A}','oa-a-eur','Compte A EUR','EUR','300.00',true),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true);
    -- WS_A MUR (juin) : crédit 1000 (Client A) le 05, débit 300 (Bailleur) le 08,
    --   débit 200 (Bailleur, MÊME libellé → agrège) le 20, tombstone 99 (exclu).
    -- WS_A USD : crédit 500 (Client US) le 06, débit 200 (Bank fees) le 09.
    -- WS_B MUR : débit 7777 (SECRET B) — ne doit JAMAIS fuiter chez A.
    -- Une transaction sans clean_label NI primary_category → repli "(Sans libellé)".
    insert into transactions_cache (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, clean_label, primary_category, is_removed) values
      ('${WS_A}','${ACC_A}','txa1','2026-06-05','2026-06-05T05:30:00Z','1000.00','MUR','Credit','VIR RECU','Client A',null,false),
      ('${WS_A}','${ACC_A}','txa2','2026-06-08','2026-06-08T05:30:00Z','300.00','MUR','Debit','LOYER JUIN','Bailleur',null,false),
      ('${WS_A}','${ACC_A}','txa3','2026-06-20','2026-06-20T05:30:00Z','200.00','MUR','Debit','LOYER COMPL','Bailleur',null,false),
      ('${WS_A}','${ACC_A}','txa-tomb','2026-06-08','2026-06-08T05:30:00Z','99.00','MUR','Debit','SUPPRIMÉ','X',null,true),
      ('${WS_A}','${ACC_A}','txa-nolabel','2026-06-12','2026-06-12T05:30:00Z','50.00','MUR','Debit',null,null,null,false),
      ('${WS_A}','${ACC_A_USD}','txa-usd1','2026-06-06','2026-06-06T05:30:00Z','500.00','USD','Credit','WIRE IN','Client US',null,false),
      ('${WS_A}','${ACC_A_USD}','txa-usd2','2026-06-09','2026-06-09T05:30:00Z','200.00','USD','Debit','FEES','Bank fees',null,false),
      ('${WS_B}','${ACC_B}','txb1','2026-06-05','2026-06-05T05:30:00Z','7777.00','MUR','Debit','SECRET B','Secret B',null,false);
    -- WS_A EUR (JUILLET, HORS des fenêtres de juin des tests précédents ; montants
    -- < 1000 pour ne déplacer aucun classement existant) : 6 vendors DISTINCTS pour
    -- prouver le top 5 PAR DÉFAUT (FB0709-TOPVENDORS5) et le fenêtrage [from, to].
    insert into transactions_cache (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, clean_label, primary_category, is_removed) values
      ('${WS_A}','${ACC_A_EUR}','txa-eur1','2026-07-01','2026-07-01T05:30:00Z','60.00','EUR','Debit','EUR V1','Vendor EUR 1',null,false),
      ('${WS_A}','${ACC_A_EUR}','txa-eur2','2026-07-02','2026-07-02T05:30:00Z','50.00','EUR','Debit','EUR V2','Vendor EUR 2',null,false),
      ('${WS_A}','${ACC_A_EUR}','txa-eur3','2026-07-03','2026-07-03T05:30:00Z','40.00','EUR','Debit','EUR V3','Vendor EUR 3',null,false),
      ('${WS_A}','${ACC_A_EUR}','txa-eur4','2026-07-04','2026-07-04T05:30:00Z','30.00','EUR','Debit','EUR V4','Vendor EUR 4',null,false),
      ('${WS_A}','${ACC_A_EUR}','txa-eur5','2026-07-05','2026-07-05T05:30:00Z','20.00','EUR','Debit','EUR V5','Vendor EUR 5',null,false),
      ('${WS_A}','${ACC_A_EUR}','txa-eur6','2026-07-06','2026-07-06T05:30:00Z','10.00','EUR','Debit','EUR V6','Vendor EUR 6',null,false);
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

describe("cashflowParDevise — agrégat par devise + isolation tenant", () => {
  it("WS_A (mensuel) : ligne MUR (entrées 1000 / sorties 550 / net 450) ET ligne USD (entrées 500 / sorties 200 / net 300)", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      cashflowParDevise(tx, {
        granularite: "mois",
        from: "2026-06-01",
        to: "2026-06-30",
      }),
    );
    expect(serie.granularite).toBe("mois");
    const parDevise = new Map(serie.points.map((p) => [p.currency, p]));

    const mur = parDevise.get("MUR");
    expect(mur?.bucket).toBe("2026-06");
    expect(mur?.entrees).toBe("1000.00");
    // sorties MUR = 300 + 200 + 50 = 550 ; tombstone 99 EXCLU.
    expect(mur?.sorties).toBe("550.00");
    expect(mur?.net).toBe("450.00");
    expect(mur?.nbTransactions).toBe(4); // crédit 1000, débit 300, débit 200, débit 50

    const usd = parDevise.get("USD");
    expect(usd?.entrees).toBe("500.00");
    expect(usd?.sorties).toBe("200.00");
    expect(usd?.net).toBe("300.00");

    // Exactement 2 devises, AUCUNE addition MUR+USD.
    expect(serie.points.map((p) => p.currency).sort()).toEqual(["MUR", "USD"]);
  });

  it("granularité jour : buckets quotidiens distincts (pas de fusion)", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      cashflowParDevise(tx, {
        granularite: "jour",
        from: "2026-06-01",
        to: "2026-06-30",
      }),
    );
    const joursMur = serie.points
      .filter((p) => p.currency === "MUR")
      .map((p) => p.bucket);
    // Jours MUR avec mouvement non-tombstone : 05, 08, 12, 20.
    expect(joursMur).toEqual([
      "2026-06-05",
      "2026-06-08",
      "2026-06-12",
      "2026-06-20",
    ]);
  });

  it("ISOLATION : WS_B ne voit que son MUR (sorties 7777), jamais l'USD ni les flux de A", async () => {
    const serie = await withWorkspace(sessionB, (tx) =>
      cashflowParDevise(tx, {
        granularite: "mois",
        from: "2026-06-01",
        to: "2026-06-30",
      }),
    );
    expect(serie.points.map((p) => p.currency)).toEqual(["MUR"]);
    expect(serie.points[0].sorties).toBe("7777.00");
    expect(serie.points[0].entrees).toBe("0.00");
    expect(serie.points.find((p) => p.currency === "USD")).toBeUndefined();
  });

  it("fenêtre sans transaction → série vide (jamais null, pas de 0 fabriqué)", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      cashflowParDevise(tx, {
        granularite: "mois",
        from: "2020-01-01",
        to: "2020-01-31",
      }),
    );
    expect(serie.points).toEqual([]);
  });

  it("borne haute INCLUSIVE : une transaction le jour `to` est comptée", async () => {
    // to = 2026-06-05 → doit inclure le crédit 1000 MUR (Client A) de ce jour.
    const serie = await withWorkspace(sessionA, (tx) =>
      cashflowParDevise(tx, {
        granularite: "jour",
        from: "2026-06-05",
        to: "2026-06-05",
      }),
    );
    const mur = serie.points.find((p) => p.currency === "MUR");
    expect(mur?.bucket).toBe("2026-06-05");
    expect(mur?.entrees).toBe("1000.00");
  });
});

describe("vendorsParConcentration — concentration par contrepartie + isolation", () => {
  it("WS_A outflow : Bailleur agrégé (300+200=500), part relative à MUR, tombstone exclu", async () => {
    const conc = await withWorkspace(sessionA, (tx) =>
      vendorsParConcentration(tx, { direction: "outflow", topN: 10 }),
    );
    expect(conc.direction).toBe("outflow");
    const mur = conc.lignes.filter((l) => l.currency === "MUR");
    const bailleur = mur.find((l) => l.contrepartie === "Bailleur");
    // 300 + 200 = 500 (les deux débits "Bailleur" agrégés ; tombstone 99 exclu).
    expect(bailleur?.montant).toBe("500.00");
    expect(bailleur?.nbTransactions).toBe(2);
    // Total débits MUR = 500 (Bailleur) + 50 (Sans libellé) = 550 → part Bailleur = 500/550.
    expect(Number(bailleur?.part)).toBeCloseTo(500 / 550, 6);

    // Le débit sans libellé est replié sur "(Sans libellé)".
    expect(mur.find((l) => l.contrepartie === "(Sans libellé)")?.montant).toBe(
      "50.00",
    );
  });

  it("WS_A inflow : Client A (MUR) et Client US (USD), parts par devise (chacune = 1)", async () => {
    const conc = await withWorkspace(sessionA, (tx) =>
      vendorsParConcentration(tx, { direction: "inflow", topN: 10 }),
    );
    const clientA = conc.lignes.find((l) => l.contrepartie === "Client A");
    expect(clientA?.currency).toBe("MUR");
    expect(clientA?.montant).toBe("1000.00");
    expect(Number(clientA?.part)).toBeCloseTo(1, 6); // seul crédit MUR

    const clientUs = conc.lignes.find((l) => l.contrepartie === "Client US");
    expect(clientUs?.currency).toBe("USD");
    expect(Number(clientUs?.part)).toBeCloseTo(1, 6); // seul crédit USD
  });

  it("topN borné : limite le nombre de lignes au plus gros poste", async () => {
    const conc = await withWorkspace(sessionA, (tx) =>
      vendorsParConcentration(tx, { direction: "both", topN: 1 }),
    );
    expect(conc.lignes).toHaveLength(1);
    // Plus gros poste tous sens/devises : Client A (crédit 1000 MUR).
    expect(conc.lignes[0].contrepartie).toBe("Client A");
  });

  it("ISOLATION : WS_B ne voit que 'Secret B', jamais les contreparties de A", async () => {
    const conc = await withWorkspace(sessionB, (tx) =>
      vendorsParConcentration(tx, { direction: "outflow", topN: 50 }),
    );
    expect(conc.lignes.map((l) => l.contrepartie)).toEqual(["Secret B"]);
    expect(conc.lignes[0].montant).toBe("7777.00");
    expect(conc.lignes.find((l) => l.contrepartie === "Bailleur")).toBeUndefined();
  });

  it("rejette les paramètres hors bornes (défense en profondeur repository)", async () => {
    await expect(
      withWorkspace(sessionA, (tx) =>
        vendorsParConcentration(tx, { direction: "outflow", topN: 9999 }),
      ),
    ).rejects.toThrow(/topN hors bornes/);
  });

  // ── FB0709-TOPVENDORS5 : fenêtre [from, to] + top 5 par défaut ────────────────

  it("fenêtre [from, to] : n'agrège QUE les transactions de la période (dedans/dehors)", async () => {
    // Fenêtre 06→15 juin : inclut débit Bailleur 300 (08/06) + Sans libellé 50 (12/06) ;
    // EXCLUT Bailleur 200 (20/06, hors fenêtre) et le tombstone (exclu de toute façon).
    const conc = await withWorkspace(sessionA, (tx) =>
      vendorsParConcentration(tx, {
        direction: "outflow",
        topN: 10,
        from: "2026-06-06",
        to: "2026-06-15",
      }),
    );
    const bailleur = conc.lignes.find(
      (l) => l.contrepartie === "Bailleur" && l.currency === "MUR",
    );
    expect(bailleur?.montant).toBe("300.00"); // PAS 500 : le 200 du 20/06 est hors fenêtre
    expect(bailleur?.nbTransactions).toBe(1);
    // La `part` est relative au total de la FENÊTRE (300 / 350), pas de l'historique.
    expect(Number(bailleur?.part)).toBeCloseTo(300 / 350, 6);
    // Aucune ligne EUR (juillet, hors fenêtre).
    expect(conc.lignes.some((l) => l.currency === "EUR")).toBe(false);
  });

  it("fenêtre : borne haute `to` INCLUSIVE (transaction le jour `to` comptée)", async () => {
    const conc = await withWorkspace(sessionA, (tx) =>
      vendorsParConcentration(tx, {
        direction: "outflow",
        topN: 10,
        from: "2026-06-20",
        to: "2026-06-20",
      }),
    );
    expect(conc.lignes).toHaveLength(1);
    expect(conc.lignes[0].contrepartie).toBe("Bailleur");
    expect(conc.lignes[0].montant).toBe("200.00");
  });

  it("topN par DÉFAUT = 5 : 9 postes outflow agrégés → 5 lignes (les plus grosses)", async () => {
    // Sans fenêtre ni topN : MUR (Bailleur 500, Sans libellé 50) + USD (Bank fees 200)
    // + EUR (6 vendors 60→10) = 9 postes → le défaut VENDORS_TOP_N_DEFAUT tronque à 5.
    const conc = await withWorkspace(sessionA, (tx) =>
      vendorsParConcentration(tx, { direction: "outflow" }),
    );
    expect(conc.lignes).toHaveLength(5);
    // Tri par montant décroissant toutes devises : 500, 200, 60, 50, 50 — les plus
    // petits postes EUR (40, 30, 20, 10) sont hors du top 5.
    expect(conc.lignes[0].contrepartie).toBe("Bailleur");
    expect(
      conc.lignes.some((l) => l.contrepartie === "Vendor EUR 6"),
    ).toBe(false);
  });

  it("rejette une fenêtre incomplète (from sans to) et des bornes invalides", async () => {
    await expect(
      withWorkspace(sessionA, (tx) =>
        vendorsParConcentration(tx, { direction: "outflow", from: "2026-06-01" }),
      ),
    ).rejects.toThrow(/fournis ensemble/);
    await expect(
      withWorkspace(sessionA, (tx) =>
        vendorsParConcentration(tx, {
          direction: "outflow",
          from: "2026-02-30", // date calendaire inexistante (piège F1/F2)
          to: "2026-03-15",
        }),
      ),
    ).rejects.toThrow(/bornes de dates invalides/);
    await expect(
      withWorkspace(sessionA, (tx) =>
        vendorsParConcentration(tx, {
          direction: "outflow",
          from: "2026-06-15",
          to: "2026-06-01",
        }),
      ),
    ).rejects.toThrow(/from doit être/);
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
