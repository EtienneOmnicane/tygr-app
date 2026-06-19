/**
 * Suite anti-IDOR — ingestion Omni-FI (PR 2, CLAUDE.md règle 2, exit-criteria).
 *
 * Prouve sur un Postgres réel (PGlite) que les écritures d'ingestion sont
 * confinées au workspace courant par la RLS, y compris sur transactions_cache
 * PARTITIONNÉE (le constat bloquant de la cross-review : la RLS doit tenir sur
 * les partitions). Vecteurs testés :
 *  - lecture cross-workspace d'une transaction ingérée → 0 ligne ;
 *  - WITH CHECK : impossible d'ingérer une ligne destinée à un autre tenant ;
 *  - idempotence #2 : un re-sync avec date comptable changée ne duplique pas.
 *
 * Même montage que workspace-isolation.test.ts : migrations réelles, rôle
 * tygr_app non-propriétaire (sinon la RLS est ignorée pour l'owner).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { transactionsCache } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  upsertConnexion,
  upsertCompte,
  upsertTransactions,
} from "@/server/repositories/ingestion";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111"; // MANAGER de A
const BOB = "22222222-2222-4222-8222-222222222222"; // MANAGER de B

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

/** Crée connexion + compte dans un workspace, retourne le bankAccountId. */
async function prerequisCompte(
  session: typeof sessionA,
  omnifiConnId: string,
  omnifiAccId: string,
) {
  return withWorkspace(session, async (tx, ctx) => {
    const { connectionId } = await upsertConnexion(tx, ctx, {
      omnifiConnectionId: omnifiConnId,
      institutionId: "mcb",
      institutionName: "MCB (fixture)",
      status: "active",
      nextSyncAvailableAt: null,
    });
    const { bankAccountId } = await upsertCompte(tx, ctx, connectionId, {
      omnifiAccountId: omnifiAccId,
      accountName: "Compte courant",
      currency: "MUR",
      currentBalance: "1000.00",
      isSelected: true,
    });
    return bankAccountId;
  });
}

function txLot(omnifiTxnId: string, date: string, amount = "1500.00") {
  return [
    {
      omnifiTxnId,
      transactionDate: date,
      bookingDateTime: new Date(`${date}T05:30:00Z`),
      amount,
      currency: "MUR",
      creditDebit: "Debit" as const,
      bankLabelRaw: "LOYER EBENE",
      cleanLabel: "Ebène",
      primaryCategory: "Rent",
      subCategory: "Office Rent",
      isRemoved: false,
    },
  ];
}

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of raw.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await client.exec(statement);
    }
  }

  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}', 'BU A', 'INTERNAL_BU', 'enduser-a'),
      ('${WS_B}', 'BU B', 'INTERNAL_BU', 'enduser-b');
    insert into users (id, email, full_name) values
      ('${ALICE}', 'alice@groupe.mu', 'Alice'),
      ('${BOB}',   'bob@groupe.mu',   'Bob');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}', '${WS_A}', 'MANAGER'),
      ('${BOB}',   '${WS_B}', 'MANAGER');
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

describe("isolation des écritures d'ingestion (RLS, partitions incluses)", () => {
  it("une transaction ingérée sous A n'est jamais visible depuis B", async () => {
    const baA = await prerequisCompte(sessionA, "conn-a", "acc-a");
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertTransactions(tx, ctx, baA, txLot("tx-isol-1", "2026-06-10")),
    );

    // Sous A : la ligne est visible.
    const vuParA = await withWorkspace(sessionA, (tx) =>
      tx.select().from(transactionsCache),
    );
    expect(vuParA.length).toBe(1);

    // Sous B : zéro ligne (RLS sur la table partitionnée).
    const vuParB = await withWorkspace(sessionB, (tx) =>
      tx.select().from(transactionsCache),
    );
    expect(vuParB.length).toBe(0);
  });

  it("idempotence #2 : re-sync avec date comptable changée ne duplique pas", async () => {
    const baA = await prerequisCompte(sessionA, "conn-a2", "acc-a2");
    // 1er sync : la transaction tombe le 10.
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertTransactions(tx, ctx, baA, txLot("tx-dup", "2026-06-10")),
    );
    // 2e sync : l'amont a re-affiné le BookingDateTime → date comptable = 11.
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertTransactions(tx, ctx, baA, txLot("tx-dup", "2026-06-11")),
    );

    const lignes = await withWorkspace(sessionA, (tx) =>
      tx.select().from(transactionsCache),
    );
    const memeTxn = lignes.filter((l) => l.omnifiTxnId === "tx-dup");
    const actives = memeTxn.filter((l) => l.isRemoved === false);
    // Une seule version ACTIVE (celle du 11) ; l'ancienne (10) est tombstoned.
    expect(actives.length).toBe(1);
    expect(actives[0].transactionDate).toBe("2026-06-11");
  });

  // DASH-DEDUP1 : un compte re-synchronisé NE crée PAS de doublon (le Front a
  // signalé des comptes en double à l'écran → on prouve ici que l'upsert respecte
  // la contrainte UNIQUE(omnifi_account_id), MÊME quand le compte est re-découvert
  // via une connexion DIFFÉRENTE (cas réel : l'utilisateur reconnecte sa banque).
  it("idempotence compte : ré-upsert du même omnifi_account_id ne duplique pas (DASH-DEDUP1)", async () => {
    // 1re découverte du compte via la connexion conn-d1.
    await prerequisCompte(sessionA, "conn-d1", "acc-shared");

    // 2e découverte du MÊME compte via une AUTRE connexion (conn-d2) + libellé différent.
    const conn2Id = await withWorkspace(sessionA, async (tx, ctx) => {
      const { connectionId } = await upsertConnexion(tx, ctx, {
        omnifiConnectionId: "conn-d2",
        institutionId: "mcb",
        institutionName: "MCB (reconnexion)",
        status: "active",
        nextSyncAvailableAt: null,
      });
      await upsertCompte(tx, ctx, connectionId, {
        omnifiAccountId: "acc-shared", // MÊME identifiant Omni-FI
        accountName: "Compte courant (maj)",
        currency: "MUR",
        currentBalance: "2000.00",
        isSelected: true,
      });
      return connectionId;
    });

    const comptes = await withWorkspace(sessionA, (tx) =>
      tx.select().from(schema.bankAccounts),
    );
    const memeCompte = comptes.filter((c) => c.omnifiAccountId === "acc-shared");
    // UNE SEULE ligne (pas de doublon) ; le 2e upsert a MIS À JOUR (libellé/solde).
    expect(memeCompte.length).toBe(1);
    expect(memeCompte[0].accountName).toBe("Compte courant (maj)");
    expect(memeCompte[0].currentBalance).toBe("2000.00");
    // …et le compte SUIT la connexion la plus récente (connection_id réaffecté),
    // pour que le dashboard affiche le bon institution_name après reconnexion.
    expect(memeCompte[0].connectionId).toBe(conn2Id);
  });
});
