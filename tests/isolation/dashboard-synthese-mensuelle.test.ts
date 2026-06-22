/**
 * Suite isolation — série mensuelle Cash In/Out (`syntheseParMois`, point 3 du
 * Maxi-Sprint Data). Prouve sur Postgres réel (PGlite, rôle tygr_app) :
 * - groupement PAR MOIS (date_trunc) sur une fenêtre de N mois ;
 * - groupement PAR DEVISE (jamais d'addition cross-devise) ;
 * - exclusion des tombstones (is_removed) ;
 * - fenêtre `nbMois` respectée (mois hors fenêtre exclu) ;
 * - FUSEAU Maurice : une transaction 31/05 22:00 UTC tombe en JUIN (UTC+4) ;
 * - isolation tenant (les flux de B n'apparaissent jamais pour A).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { syntheseParMois } from "@/server/repositories/dashboard";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ACC_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, is_selected) values
      ('${ACC_A}','${WS_A}','${CONN_A}','oa-a','Compte A','MUR',true),
      ('${ACC_A_USD}','${WS_A}','${CONN_A}','oa-a-usd','Compte A USD','USD',true),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR',true);

    -- Transactions A réparties sur AVRIL / MAI / JUIN 2026, MUR et USD.
    -- transaction_date est la date comptable Maurice (dérivée à l'ingestion) ;
    -- on la pose ici directement, en cohérence avec booking_date_time.
    insert into transactions_cache (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, clean_label, is_removed) values
      -- AVRIL (hors fenêtre quand on demande 2 mois finissant en juin)
      ('${WS_A}','${ACC_A}','a-avr1','2026-04-10','2026-04-10T06:00:00Z','100.00','MUR','Credit','avr in',false),
      -- MAI : crédit 2000 + débit 500 (MUR)
      ('${WS_A}','${ACC_A}','a-mai1','2026-05-12','2026-05-12T06:00:00Z','2000.00','MUR','Credit','mai in',false),
      ('${WS_A}','${ACC_A}','a-mai2','2026-05-20','2026-05-20T06:00:00Z','500.00','MUR','Debit','mai out',false),
      -- FUSEAU : 31/05 22:00 UTC → 01/06 02:00 Maurice (UTC+4) ⇒ compte en JUIN.
      ('${WS_A}','${ACC_A}','a-tz','2026-06-01','2026-05-31T22:00:00Z','40.00','MUR','Credit','tz juin',false),
      -- JUIN : crédit 1000 + débit 300 (MUR) + un tombstone ignoré
      ('${WS_A}','${ACC_A}','a-juin1','2026-06-05','2026-06-05T06:00:00Z','1000.00','MUR','Credit','juin in',false),
      ('${WS_A}','${ACC_A}','a-juin2','2026-06-08','2026-06-08T06:00:00Z','300.00','MUR','Debit','juin out',false),
      ('${WS_A}','${ACC_A}','a-juin3','2026-06-09','2026-06-09T06:00:00Z','99.00','MUR','Debit','SUPPR',true),
      -- JUIN en USD : crédit 700 (devise séparée, jamais additionnée au MUR)
      ('${WS_A}','${ACC_A_USD}','a-juin-usd','2026-06-06','2026-06-06T06:00:00Z','700.00','USD','Credit','usd in',false),
      -- B (témoin d'isolation) : un gros débit en juin qui ne doit jamais fuiter vers A
      ('${WS_B}','${ACC_B}','b-juin','2026-06-05','2026-06-05T06:00:00Z','7777.00','MUR','Debit','SECRET B',false);
  `);

  await client.exec(
    readFileSync(path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"), "utf8"),
  );
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

describe("syntheseParMois — série temporelle mensuelle (Cash In/Out)", () => {
  it("groupe par mois ET par devise sur la fenêtre (3 mois finissant en juin)", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      syntheseParMois(tx, { moisFin: "2026-06", nbMois: 3 }),
    );
    // Mois attendus : 2026-04 (MUR), 2026-05 (MUR), 2026-06 (MUR + USD) = 4 lignes.
    // Ordre : chronologique puis devise.
    expect(serie.map((l) => `${l.mois}/${l.currency}`)).toEqual([
      "2026-04/MUR",
      "2026-05/MUR",
      "2026-06/MUR",
      "2026-06/USD",
    ]);
  });

  it("calcule entrées/sorties/variation par mois (MUR)", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      syntheseParMois(tx, { moisFin: "2026-06", nbMois: 3 }),
    );
    const mai = serie.find((l) => l.mois === "2026-05" && l.currency === "MUR")!;
    expect(mai.entrees).toBe("2000.00");
    expect(mai.sorties).toBe("500.00");
    expect(mai.variation).toBe("1500.00");

    const juin = serie.find((l) => l.mois === "2026-06" && l.currency === "MUR")!;
    // Juin MUR : crédit 1000 + le 40 de la transaction tardive UTC (fuseau) = 1040 ;
    // débit 300 ; le tombstone 99 est exclu.
    expect(juin.entrees).toBe("1040.00");
    expect(juin.sorties).toBe("300.00");
    expect(juin.variation).toBe("740.00");
  });

  it("FUSEAU Maurice : la transaction 31/05 22:00 UTC compte en JUIN, pas en mai", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      syntheseParMois(tx, { moisFin: "2026-06", nbMois: 3 }),
    );
    const mai = serie.find((l) => l.mois === "2026-05" && l.currency === "MUR")!;
    // Si le fuseau était ignoré, le 40 tomberait en mai (entrées 2040). Il est en juin.
    expect(mai.entrees).toBe("2000.00");
  });

  it("multi-devises : USD séparé du MUR, jamais additionné", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      syntheseParMois(tx, { moisFin: "2026-06", nbMois: 3 }),
    );
    const usd = serie.find((l) => l.mois === "2026-06" && l.currency === "USD")!;
    expect(usd.entrees).toBe("700.00");
    expect(usd.sorties).toBe("0");
  });

  it("fenêtre nbMois : demander 2 mois (mai+juin) EXCLUT avril", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      syntheseParMois(tx, { moisFin: "2026-06", nbMois: 2 }),
    );
    expect(serie.some((l) => l.mois === "2026-04")).toBe(false);
    expect(serie.some((l) => l.mois === "2026-05")).toBe(true);
    expect(serie.some((l) => l.mois === "2026-06")).toBe(true);
  });

  it("mois sans transaction : absent de la série (pas de ligne fabriquée)", async () => {
    // Juillet n'a aucune transaction → demander une fenêtre incluant juillet ne
    // crée pas de ligne juillet (le Front comble l'axe s'il le souhaite).
    const serie = await withWorkspace(sessionA, (tx) =>
      syntheseParMois(tx, { moisFin: "2026-07", nbMois: 2 }),
    );
    expect(serie.some((l) => l.mois === "2026-07")).toBe(false);
    expect(serie.some((l) => l.mois === "2026-06")).toBe(true);
  });

  it("ISOLATION : la série de A ne contient jamais le débit 7777 de B", async () => {
    const serie = await withWorkspace(sessionA, (tx) =>
      syntheseParMois(tx, { moisFin: "2026-06", nbMois: 3 }),
    );
    const juin = serie.find((l) => l.mois === "2026-06" && l.currency === "MUR")!;
    // 7777 n'entre jamais dans les sorties de A (RLS tenant_isolation).
    expect(juin.sorties).toBe("300.00");

    // Et B voit SES flux, pas ceux de A.
    const serieB = await withWorkspace(sessionB, (tx) =>
      syntheseParMois(tx, { moisFin: "2026-06", nbMois: 3 }),
    );
    expect(serieB).toHaveLength(1);
    expect(serieB[0]).toMatchObject({ mois: "2026-06", currency: "MUR", sorties: "7777.00" });
  });
});
