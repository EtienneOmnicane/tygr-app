/**
 * PROD-TRESO-EOD1 — fix du bug cross-devise de `courbeTresorerie` (§2.4, §7-E7). Prouve
 * sur Postgres réel (PGlite) qu'un workspace MUR + USD produit DEUX séries (une par
 * devise), JAMAIS une addition cross-devise (roupies + dollars dans un seul point). Le
 * `GROUP BY (balance_date, currency)` est ce qui garde l'invariant.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { courbeTresorerie } from "@/server/repositories/dashboard";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALICE = "11111111-1111-4111-8111-111111111111";
const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACC_MUR1 = "dddd1111-dddd-4ddd-8ddd-dddddddddddd";
const ACC_MUR2 = "dddd2222-dddd-4ddd-8ddd-dddddddddddd";
const ACC_USD = "dddd3333-dddd-4ddd-8ddd-dddddddddddd";

const session = { userId: ALICE, activeWorkspaceId: WS };

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
      ('${WS}','A','INTERNAL_BU','eu-a');
    insert into users (id, email, full_name) values ('${ALICE}','a@g.mu','A');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}','${WS}','MANAGER');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN}','${WS}','oc','mcb','${ALICE}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, is_selected) values
      ('${ACC_MUR1}','${WS}','${CONN}','oa-mur1','MUR 1','MUR',true),
      ('${ACC_MUR2}','${WS}','${CONN}','oa-mur2','MUR 2','MUR',true),
      ('${ACC_USD}','${WS}','${CONN}','oa-usd','USD','USD',true);
    -- MÊME jour, MÊME workspace : 2 comptes MUR (1000 + 2000) + 1 compte USD (500).
    insert into balance_history (workspace_id, bank_account_id, balance_date, balance, currency) values
      ('${WS}','${ACC_MUR1}','2026-06-10','1000.00','MUR'),
      ('${WS}','${ACC_MUR2}','2026-06-10','2000.00','MUR'),
      ('${WS}','${ACC_USD}','2026-06-10','500.00','USD');
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

describe("courbeTresorerie — multi-devise (§7-E7)", () => {
  it("MUR + USD le même jour → DEUX séries, jamais d'addition cross-devise", async () => {
    const pts = await withWorkspace(session, (tx) =>
      courbeTresorerie(tx, { from: "2026-06-01", to: "2026-06-30" }),
    );
    // Une ligne par (date, devise) : MUR consolidé (1000+2000=3000), USD séparé (500).
    expect(pts).toEqual([
      { date: "2026-06-10", currency: "MUR", soldeConsolide: "3000.00" },
      { date: "2026-06-10", currency: "USD", soldeConsolide: "500.00" },
    ]);
    // Garde explicite : jamais le total cross-devise 3500 dans un seul point.
    expect(pts.some((p) => p.soldeConsolide === "3500.00")).toBe(false);
  });
});
