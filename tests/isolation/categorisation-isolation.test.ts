/**
 * Suite isolation — catégorisation manuelle + ventilation (Pilier 1). Prouve :
 * - IDOR : un split/une catégorie d'un workspace n'est jamais visible/modifiable
 *   depuis un autre (RLS tenant_isolation).
 * - Invariant de ventilation : somme des splits ≤ |montant txn| (sous verrou).
 * - Double verrou source/rule_id (CHECK SQL).
 * - Audit append-only : UPDATE/DELETE refusés (trigger + privilège).
 *
 * Tourne sous le rôle `tygr_app` non-owner (RLS active) avec migrations +
 * provisioning RÉELS — même socle que les autres suites d'isolation (bloquante
 * en CI).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { categorizationAudit } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  ajouterSplit,
  listerSplits,
  supprimerSplit,
  VentilationDepasseError,
  TransactionIntrouvableError,
} from "@/server/repositories/categorisation";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

// Données fixes par workspace.
const TXN_A = "eeee1111-eeee-4eee-8eee-eeeeeeeeeeee";
const TXN_B = "eeee2222-eeee-4eee-8eee-eeeeeeeeeeee";
const CAT_A = "aaaacccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAT_B = "bbbbcccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const st of raw.split("--> statement-breakpoint")) {
      if (st.trim().length > 0) await client.exec(st);
    }
  }

  // Seed (owner) : 2 workspaces, users, 1 compte + 1 txn + 1 catégorie chacun.
  // Montant des transactions = 1000.00 (abs) pour tester l'invariant.
  await client.exec(`
    insert into workspaces (id,name,kind,omnifi_client_user_id) values
      ('${WS_A}','BU A','INTERNAL_BU','eu-a'), ('${WS_B}','BU B','INTERNAL_BU','eu-b');
    insert into users (id,email,full_name) values
      ('${ALICE}','a@g.mu','Alice'), ('${BOB}','b@g.mu','Bob');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${ALICE}','${WS_A}','MANAGER'), ('${BOB}','${WS_B}','MANAGER');
    insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,created_by) values
      ('cccc0001-cccc-4ccc-8ccc-cccccccccccc','${WS_A}','c-a','mcb','${ALICE}'),
      ('cccc0002-cccc-4ccc-8ccc-cccccccccccc','${WS_B}','c-b','mcb','${BOB}');
    insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
      ('dddd0001-dddd-4ddd-8ddd-dddddddddddd','${WS_A}','cccc0001-cccc-4ccc-8ccc-cccccccccccc','a-a','CC','MUR'),
      ('dddd0002-dddd-4ddd-8ddd-dddddddddddd','${WS_B}','cccc0002-cccc-4ccc-8ccc-cccccccccccc','a-b','CC','MUR');
    insert into transactions_cache (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw) values
      ('${TXN_A}','${WS_A}','dddd0001-dddd-4ddd-8ddd-dddddddddddd','t-a','2026-03-15','2026-03-15T08:00:00Z','-1000.00','MUR','Debit','x'),
      ('${TXN_B}','${WS_B}','dddd0002-dddd-4ddd-8ddd-dddddddddddd','t-b','2026-03-15','2026-03-15T08:00:00Z','-1000.00','MUR','Debit','y');
    insert into categories (id,workspace_id,name) values
      ('${CAT_A}','${WS_A}','Fournisseurs'), ('${CAT_B}','${WS_B}','Loyer');
  `);

  await client.exec(
    readFileSync(path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"), "utf8"),
  );
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

const refA = { transactionId: TXN_A, transactionDate: "2026-03-15" };

describe("ventilation : invariant somme ≤ |montant txn|", () => {
  it("accepte des splits dont la somme reste ≤ 1000 (600 + 400)", async () => {
    await withWorkspace(sessionA, (tx, ctx) =>
      ajouterSplit(tx, ctx, { ...refA, categoryId: CAT_A, amount: "600.00", source: "MANUAL", ruleId: null }),
    );
    await withWorkspace(sessionA, (tx, ctx) =>
      ajouterSplit(tx, ctx, { ...refA, categoryId: CAT_A, amount: "400.00", source: "MANUAL", ruleId: null }),
    );
    const splits = await withWorkspace(sessionA, (tx, ctx) => listerSplits(tx, ctx, refA));
    expect(splits).toHaveLength(2);
  });

  it("REFUSE un split qui ferait dépasser 1000 (déjà 1000, +0.01)", async () => {
    await expect(
      withWorkspace(sessionA, (tx, ctx) =>
        ajouterSplit(tx, ctx, { ...refA, categoryId: CAT_A, amount: "0.01", source: "MANUAL", ruleId: null }),
      ),
    ).rejects.toBeInstanceOf(VentilationDepasseError);
  });

  it("REFUSE un split sur une transaction inexistante dans le workspace", async () => {
    await expect(
      withWorkspace(sessionA, (tx, ctx) =>
        ajouterSplit(tx, ctx, {
          transactionId: "99999999-9999-4999-8999-999999999999",
          transactionDate: "2026-03-15",
          categoryId: CAT_A,
          amount: "10.00",
          source: "MANUAL",
          ruleId: null,
        }),
      ),
    ).rejects.toBeInstanceOf(TransactionIntrouvableError);
  });
});

describe("isolation inter-workspace (anti-IDOR)", () => {
  it("les splits de A ne sont pas visibles depuis B", async () => {
    const vuParB = await withWorkspace(sessionB, (tx, ctx) => listerSplits(tx, ctx, refA));
    expect(vuParB).toHaveLength(0);
  });

  it("B ne peut pas catégoriser la transaction de A (txn invisible → introuvable)", async () => {
    // Depuis B, la txn de A est masquée par la RLS → traitée comme inexistante.
    await expect(
      withWorkspace(sessionB, (tx, ctx) =>
        ajouterSplit(tx, ctx, { ...refA, categoryId: CAT_B, amount: "10.00", source: "MANUAL", ruleId: null }),
      ),
    ).rejects.toBeInstanceOf(TransactionIntrouvableError);
  });

  it("A ne peut pas catégoriser avec une category_id d'un AUTRE workspace (FK composite scopée)", async () => {
    // Correctif cross-review MAJEUR : la FK (category_id, workspace_id) exige que
    // la catégorie appartienne au workspace du split. CAT_B (workspace B) dans un
    // split de A → rejeté par la FK composite (pas une référence cross-tenant).
    let thrown: unknown = null;
    try {
      await withWorkspace(sessionA, (tx, ctx) =>
        ajouterSplit(tx, ctx, { ...refA, categoryId: CAT_B, amount: "10.00", source: "MANUAL", ruleId: null }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "category_id d'un autre workspace doit être rejeté").not.toBeNull();
  });

  it("B ne peut pas supprimer un split de A (RLS → 0 ligne, pas d'effet)", async () => {
    const splitsA = await withWorkspace(sessionA, (tx, ctx) => listerSplits(tx, ctx, refA));
    const cibleId = splitsA[0].id;
    const r = await withWorkspace(sessionB, (tx, ctx) => supprimerSplit(tx, ctx, cibleId));
    expect(r.supprime).toBe(false);
    // Le split de A est toujours là.
    const apres = await withWorkspace(sessionA, (tx, ctx) => listerSplits(tx, ctx, refA));
    expect(apres.some((s) => s.id === cibleId)).toBe(true);
  });
});

describe("audit append-only", () => {
  it("chaque ajout a écrit une ligne d'audit CREATE (scopée workspace)", async () => {
    const audit = await withWorkspace(sessionA, (tx) =>
      tx.select().from(categorizationAudit).where(eq(categorizationAudit.action, "CREATE")),
    );
    expect(audit.length).toBeGreaterThanOrEqual(2); // les 2 splits 600+400
  });

  it("UPDATE de l'audit est refusé (append-only, sous tygr_app)", async () => {
    let thrown: unknown = null;
    try {
      await client.exec(`update categorization_audit set action = 'DELETE'`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "UPDATE de l'audit doit être refusé").not.toBeNull();
  });

  it("DELETE de l'audit est refusé (append-only, sous tygr_app)", async () => {
    let thrown: unknown = null;
    try {
      await client.exec(`delete from categorization_audit`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "DELETE de l'audit doit être refusé").not.toBeNull();
  });
});

describe("double verrou source/rule_id", () => {
  it("REFUSE un split MANUAL avec rule_id (CHECK SQL)", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessionA, (tx, ctx) =>
        // On contourne le Zod (test du CHECK base) : insert direct via repo
        // avec un payload incohérent → le CHECK SQL doit rejeter.
        ajouterSplit(tx, ctx, {
          ...refA,
          categoryId: CAT_A,
          amount: "1.00",
          source: "MANUAL",
          ruleId: CAT_A, // incohérent : MANUAL + rule_id
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "MANUAL + rule_id doit être rejeté par le CHECK").not.toBeNull();
  });
});

describe("la table transactions_cache reste read-only (jamais écrite par la catégorisation)", () => {
  it("aucun split n'a modifié le montant de la transaction", async () => {
    const rows = await withWorkspace(sessionA, (tx) =>
      tx
        .select({ amount: schema.transactionsCache.amount })
        .from(schema.transactionsCache)
        .where(
          and(
            eq(schema.transactionsCache.id, TXN_A),
            eq(schema.transactionsCache.transactionDate, "2026-03-15"),
          ),
        ),
    );
    expect(rows[0].amount).toBe("-1000.00"); // inchangé
  });
});
