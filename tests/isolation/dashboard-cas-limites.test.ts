/**
 * Cas limites des services de lecture du dashboard (Epic 3). Complète
 * dashboard-isolation.test.ts (qui prouve la RLS) en validant la JUSTESSE des
 * agrégats aux bornes : soldes négatifs, variation négative, mois sans
 * transaction, fenêtre hors données, gros montants, multi-comptes, tombstones.
 * Postgres réel (PGlite), rôle tygr_app. Données factices injectées (owner).
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
  soldeConsolideCourant,
  soldesCourantsParDevise,
  syntheseMois,
  transactionsRecentes,
} from "@/server/repositories/dashboard";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER = "44444444-4444-4444-8444-444444444444";
const CONN = "ccccdddd-cccc-4ccc-8ccc-cccccccccccc";
const ACC1 = "cccc1111-cccc-4ccc-8ccc-cccccccccccc";
const ACC2 = "cccc2222-cccc-4ccc-8ccc-cccccccccccc"; // 2e compte (multi-comptes)
const session = { userId: USER, activeWorkspaceId: WS };

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
      ('${WS}','CasLimites','INTERNAL_BU','eu-c');
    insert into users (id, email, full_name) values ('${USER}','c@g.mu','C');
    insert into workspace_members (user_id, workspace_id, role) values ('${USER}','${WS}','MANAGER');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN}','${WS}','oc-c','mcb','${USER}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, is_selected) values
      ('${ACC1}','${WS}','${CONN}','oa-c1','Compte 1','MUR',true),
      ('${ACC2}','${WS}','${CONN}','oa-c2','Compte 2','MUR',true);

    -- Soldes : compte 1 NÉGATIF au dernier EOD, compte 2 positif → consolidé = somme
    insert into balance_history (workspace_id, bank_account_id, balance_date, balance, currency) values
      ('${WS}','${ACC1}','2026-05-31','1000.00','MUR'),
      ('${WS}','${ACC1}','2026-06-10','-2500.50','MUR'),   -- dernier EOD compte 1 (négatif)
      ('${WS}','${ACC2}','2026-06-10','8000.00','MUR');     -- dernier EOD compte 2

    -- Transactions juin : gros crédit, gros débit (variation peut être négative),
    -- 1 tombstone exclu, multi-comptes.
    insert into transactions_cache (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, is_removed) values
      ('${WS}','${ACC1}','c1','2026-06-02','2026-06-02T05:30:00Z','500.00','MUR','Credit','X',false),
      ('${WS}','${ACC1}','c2','2026-06-03','2026-06-03T05:30:00Z','9999999.99','MUR','Debit','GROS',false),
      ('${WS}','${ACC2}','c3','2026-06-04','2026-06-04T05:30:00Z','250.00','MUR','Credit','Y',false),
      ('${WS}','${ACC1}','c4','2026-06-05','2026-06-05T05:30:00Z','42.00','MUR','Debit','TOMBSTONE',true);
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

describe("soldeConsolideCourant — cas limites", () => {
  it("somme un solde négatif et un positif au dernier EOD (multi-comptes)", async () => {
    // dernier EOD : compte1 = -2500.50, compte2 = 8000.00 → 5499.50
    const s = await withWorkspace(session, (tx) => soldeConsolideCourant(tx));
    expect(s).toBe("5499.50");
  });
});

describe("courbeTresorerie — cas limites", () => {
  it("consolide négatif+positif le même jour ; un jour mono-compte reste seul", async () => {
    const pts = await withWorkspace(session, (tx) =>
      courbeTresorerie(tx, { from: "2026-05-01", to: "2026-06-30" }),
    );
    // 2026-05-31 : seul compte1 = 1000 ; 2026-06-10 : -2500.50 + 8000 = 5499.50
    expect(pts).toEqual([
      { date: "2026-05-31", soldeConsolide: "1000.00" },
      { date: "2026-06-10", soldeConsolide: "5499.50" },
    ]);
  });

  it("fenêtre hors données → liste vide (pas d'erreur)", async () => {
    const pts = await withWorkspace(session, (tx) =>
      courbeTresorerie(tx, { from: "2020-01-01", to: "2020-12-31" }),
    );
    expect(pts).toEqual([]);
  });

  it("bornes inclusives : from=to sur un jour avec donnée → 1 point", async () => {
    const pts = await withWorkspace(session, (tx) =>
      courbeTresorerie(tx, { from: "2026-06-10", to: "2026-06-10" }),
    );
    expect(pts).toEqual([{ date: "2026-06-10", soldeConsolide: "5499.50" }]);
  });
});

describe("syntheseMois — cas limites", () => {
  it("variation NÉGATIVE quand sorties > entrées, gros montant, tombstone exclu", async () => {
    // entrées = 500 + 250 = 750 ; sorties = 9999999.99 (le tombstone 42 exclu)
    const s = await withWorkspace(session, (tx) => syntheseMois(tx, "2026-06"));
    expect(s.entrees).toBe("750.00");
    expect(s.sorties).toBe("9999999.99");
    expect(s.variation).toBe("-9999249.99"); // négatif
  });

  it("mois sans aucune transaction → tout à 0 (pas de NULL, pas d'erreur)", async () => {
    const s = await withWorkspace(session, (tx) => syntheseMois(tx, "2026-01"));
    expect(s).toEqual({
      libelleMois: "2026-01",
      entrees: "0",
      sorties: "0",
      variation: "0",
    });
  });

  it("borne haute exclusive : une transaction du 1er juillet n'entre pas dans juin", async () => {
    // reset role : repasse à l'utilisateur de session PGlite (owner), pour
    // insérer hors RLS. (PGlite n'a pas de rôle "tygr_owner" nommé — c'est
    // l'owner de la stack Docker, pas d'ici.)
    await client.exec(`reset role;`);
    await client.exec(`
      insert into transactions_cache (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, is_removed) values
        ('${WS}','${ACC1}','juil1','2026-07-01','2026-07-01T05:30:00Z','111.00','MUR','Credit','JUILLET',false);
    `);
    await client.exec(`set role tygr_app;`);
    const juin = await withWorkspace(session, (tx) => syntheseMois(tx, "2026-06"));
    expect(juin.entrees).toBe("750.00"); // le 111 de juillet n'est pas compté
    const juil = await withWorkspace(session, (tx) => syntheseMois(tx, "2026-07"));
    expect(juil.entrees).toBe("111.00");
  });
});

describe("soldesCourantsParDevise — multi-devises (DASH-INST1 / solde courant)", () => {
  // Données propres à ce describe : on pose des current_balance (les comptes du
  // setup n'en ont pas) + un 3e compte USD pour prouver le GROUP BY devise. On
  // insère hors RLS (reset role), comme le test « borne haute exclusive ».
  const ACC_USD = "cccc3333-cccc-4ccc-8ccc-cccccccccccc";
  beforeAll(async () => {
    await client.exec(`reset role;`);
    await client.exec(`
      update bank_accounts set current_balance = '7074400.00' where id = '${ACC1}';
      update bank_accounts set current_balance = '1000000.00' where id = '${ACC2}';
      insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected) values
        ('${ACC_USD}','${WS}','${CONN}','oa-usd','Compte USD','USD','179200.00',true);
    `);
    await client.exec(`set role tygr_app;`);
  });

  it("somme par devise, jamais d'addition cross-devise (MUR + USD séparés)", async () => {
    const soldes = await withWorkspace(session, (tx) => soldesCourantsParDevise(tx));
    // MUR = 7074400 + 1000000 = 8074400 ; USD = 179200. Ordonné par devise (MUR<USD).
    expect(soldes).toEqual([
      { currency: "MUR", total: "8074400.00" },
      { currency: "USD", total: "179200.00" },
    ]);
  });

  it("ne dépend PAS de balance_history (source = current_balance)", async () => {
    // balance_history du WS ne contient que du MUR ; le compte USD n'y est pas, et
    // il ressort quand même → preuve que la source est bien bank_accounts.
    const soldes = await withWorkspace(session, (tx) => soldesCourantsParDevise(tx));
    expect(soldes.some((s) => s.currency === "USD" && s.total === "179200.00")).toBe(true);
  });
});

describe("transactionsRecentes — cas limites", () => {
  it("respecte la limite et le tri date desc ; exclut les tombstones", async () => {
    const r = await withWorkspace(session, (tx) => transactionsRecentes(tx, 2));
    expect(r.length).toBe(2);
    // Tri date desc : la plus récente non-tombstone d'abord.
    expect(r[0].transactionDate >= r[1].transactionDate).toBe(true);
    expect(r.every((t) => t.omnifiTxnId !== "c4")).toBe(true); // tombstone jamais
  });

  it("limite 0 → liste vide", async () => {
    const r = await withWorkspace(session, (tx) => transactionsRecentes(tx, 0));
    expect(r).toEqual([]);
  });
});
