/**
 * Suite d'isolation — contraintes UNIQUE composites scopées `workspace_id`
 * (PLAN-unique-composites.md, lot L3 ; CLAUDE.md règle 2/3, BLOQUANT CI).
 *
 * CE QUE CETTE PR (EXPAND, migration 0018) LIVRE ET PROUVE ICI :
 *  - Les 3 contraintes composites `UNIQUE(workspace_id, …)` existent
 *    (bank_connections / bank_accounts / transactions_cache) ET l'ingestion
 *    infère bien SUR ELLES (les 3 `onConflictDoUpdate` de ingestion.ts sont en
 *    lock-step avec le schéma). C'est l'ANCRE D'INVERSION : `ON CONFLICT (cols)`
 *    exige une UNIQUE portant EXACTEMENT ces colonnes ; sans la migration 0018 le
 *    code L2 lève « no unique constraint matching ON CONFLICT specification » →
 *    C1/C2/C3 VIRENT AU ROUGE. Retirer 0018 casse la suite : c'est le test.
 *  - L'idempotence intra-tenant est PRÉSERVÉE (ré-upsert du même identifiant →
 *    1 ligne, champs mis à jour) — la permissivité ajoutée ne casse pas la dédup.
 *
 * CE QUE L'EXPAND NE LIVRE PAS ENCORE (et pourquoi cette suite ne le prouve PAS) :
 *  Le bénéfice sécurité — deux workspaces peuvent porter le MÊME identifiant
 *  Omni-FI sans se percuter — n'arrive qu'au CONTRACT (migration 0019, PR2 / lot
 *  L4), qui DROP les 3 UNIQUE GLOBALES. Tant que la globale existe (fenêtre
 *  expand), un INSERT cross-tenant du même id viole la globale (23505) AVANT que
 *  l'arbitre composite ne joue — l'arbitre `ON CONFLICT (workspace_id, …)` ne
 *  couvre pas la globale (canal caché RLS + index unique : l'unicité est enforce
 *  au niveau stockage, indépendamment de la RLS). Vérifié empiriquement (PGlite).
 *  Cf. plan §9.4 : « la valeur sécurité est bornée au contract ».
 *  → C4a/b/c ÉPINGLENT cet état transitoire (collision ENCORE bloquée). Le lot L4
 *    (contract) INVERSERA ces trois assertions : `rejects.toThrow()` deviendra un
 *    succès + « chaque tenant voit exactement sa ligne » (RLS). Ne PAS supprimer
 *    ces cas : ils sont le point d'ancrage de l'inversion du contract.
 *
 * Montage calqué sur ingestion-isolation.test.ts : migrations réelles depuis le
 * disque (0018 réappliquée), rôle non-propriétaire `tygr_app` (sinon la RLS est
 * ignorée), 2 workspaces + 2 membres, provisioning depuis le script canonique.
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

/** Un lot d'UNE transaction (mêmes champs que la fixture d'ingestion-isolation). */
function txLot(omnifiTxnId: string, date: string, amount = "1500.00") {
  return [
    {
      omnifiTxnId,
      transactionDate: date,
      bookingDateTime: new Date(`${date}T05:30:00Z`),
      amount,
      currency: "MUR",
      creditDebit: "Debit" as const,
      runningBalance: null,
      bankLabelRaw: "LOYER EBENE",
      cleanLabel: "Ebène",
      primaryCategory: "Rent",
      subCategory: "Office Rent",
      confidenceLevel: "High",
      classificationSource: "SYSTEM_RULE",
      ruleIdMatch: "rule_rent_01",
      isAutoCategorized: true,
      categorySource: "OMNIFI" as const,
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

/* ------------------------------------------------------------------ */
/* Idempotence intra-tenant PRÉSERVÉE — ancre d'inversion.            */
/* Vert avec 0018 (l'arbitre composite existe) ; ROUGE sans (le       */
/* `ON CONFLICT (workspace_id, …)` du code L2 ne trouve aucune         */
/* contrainte → lève). Prouve à la fois que la composite existe et que */
/* la permissivité ajoutée reste bornée par tenant (la dédup tient).   */
/* ------------------------------------------------------------------ */
describe("idempotence intra-tenant sur la contrainte composite (0018 + code L2)", () => {
  it("C1 — ré-upsert du même omnifi_connection_id sous A ne duplique pas (met à jour)", async () => {
    // 1er upsert : crée la connexion.
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertConnexion(tx, ctx, {
        omnifiConnectionId: "c1-conn",
        institutionId: "mcb",
        institutionName: "MCB v1",
        status: "active",
        nextSyncAvailableAt: null,
      }),
    );
    // 2e upsert : MÊME identifiant, institution renommée + statut changé → l'arbitre
    // composite (workspace_id, omnifi_connection_id) matche → UPDATE en place.
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertConnexion(tx, ctx, {
        omnifiConnectionId: "c1-conn",
        institutionId: "mcb",
        institutionName: "MCB v2",
        status: "revoked",
        nextSyncAvailableAt: null,
      }),
    );

    const vuA = await withWorkspace(sessionA, (tx) =>
      tx.select().from(schema.bankConnections),
    );
    const memes = vuA.filter((x) => x.omnifiConnectionId === "c1-conn");
    expect(memes.length).toBe(1); // pas de doublon
    expect(memes[0].institutionName).toBe("MCB v2"); // l'upsert a bien mis à jour
    expect(memes[0].status).toBe("revoked");

    // RLS (étage 1) : B ne voit jamais la connexion de A.
    const vuB = await withWorkspace(sessionB, (tx) =>
      tx.select().from(schema.bankConnections),
    );
    expect(vuB.some((x) => x.omnifiConnectionId === "c1-conn")).toBe(false);
  });

  it("C2 — même omnifi_account_id via 2 connexions sous A ne duplique pas (DASH-DEDUP1)", async () => {
    // 1re découverte via conn1.
    await prerequisCompte(sessionA, "c2-conn1", "c2-acc");
    // 2e découverte du MÊME compte via une AUTRE connexion (libellé/solde différents).
    const conn2Id = await withWorkspace(sessionA, async (tx, ctx) => {
      const { connectionId } = await upsertConnexion(tx, ctx, {
        omnifiConnectionId: "c2-conn2",
        institutionId: "mcb",
        institutionName: "MCB (reconnexion)",
        status: "active",
        nextSyncAvailableAt: null,
      });
      await upsertCompte(tx, ctx, connectionId, {
        omnifiAccountId: "c2-acc", // MÊME identifiant Omni-FI
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
    const memes = comptes.filter((c) => c.omnifiAccountId === "c2-acc");
    expect(memes.length).toBe(1); // pas de doublon
    expect(memes[0].accountName).toBe("Compte courant (maj)"); // mis à jour
    expect(memes[0].currentBalance).toBe("2000.00");
    expect(memes[0].connectionId).toBe(conn2Id); // suit la connexion la plus récente
  });

  it("C3 — ré-upsert du même (omnifi_txn_id, date) sous A ne duplique pas (met à jour)", async () => {
    const baA = await prerequisCompte(sessionA, "c3-conn", "c3-acc");
    // 1er sync : montant 1500.
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertTransactions(tx, ctx, baA, txLot("c3-txn", "2026-06-10", "1500.00")),
    );
    // 2e sync : MÊME clé (txn, date), montant re-affiné → UPDATE via l'arbitre composite.
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertTransactions(tx, ctx, baA, txLot("c3-txn", "2026-06-10", "1750.00")),
    );

    const lignes = await withWorkspace(sessionA, (tx) =>
      tx.select().from(transactionsCache),
    );
    const memes = lignes.filter((l) => l.omnifiTxnId === "c3-txn");
    expect(memes.length).toBe(1); // pas de doublon
    expect(memes[0].amount).toBe("1750.00"); // mis à jour

    // RLS partitions incluses : B ne voit jamais la transaction de A.
    const vuB = await withWorkspace(sessionB, (tx) =>
      tx.select().from(transactionsCache),
    );
    expect(vuB.some((l) => l.omnifiTxnId === "c3-txn")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* État TRANSITOIRE (EXPAND) : la globale bloque ENCORE la collision   */
/* cross-tenant. ⚠️ CES 3 CAS SONT LE POINT D'ANCRAGE DE L'INVERSION   */
/* DU CONTRACT (lot L4, migration 0019) : quand le DROP des globales    */
/* sera livré, `rejects.toThrow()` devra devenir un SUCCÈS + « chaque   */
/* tenant voit exactement sa propre ligne » (RLS). Tant que la globale  */
/* existe, l'INSERT cross-tenant du même id la viole (23505) avant que  */
/* l'arbitre composite ne joue (l'arbitre ne couvre pas la globale).    */
/* ------------------------------------------------------------------ */
describe("EXPAND : collision cross-tenant encore bloquée par la globale (à inverser au CONTRACT L4)", () => {
  it("C4a — même omnifi_connection_id sous B après A → rejet (globale UNIQUE(omnifi_connection_id))", async () => {
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertConnexion(tx, ctx, {
        omnifiConnectionId: "c4a-shared",
        institutionId: "mcb",
        institutionName: "A",
        status: "active",
        nextSyncAvailableAt: null,
      }),
    );
    // B tente le MÊME id : l'arbitre composite (ws, conn) est neuf pour B → INSERT →
    // viole la globale (l'id existe déjà chez A, invisible sous RLS) → 23505.
    await expect(
      withWorkspace(sessionB, (tx, ctx) =>
        upsertConnexion(tx, ctx, {
          omnifiConnectionId: "c4a-shared",
          institutionId: "mcb",
          institutionName: "B",
          status: "active",
          nextSyncAvailableAt: null,
        }),
      ),
    ).rejects.toThrow();
  });

  it("C4b — même omnifi_account_id sous B après A → rejet (globale UNIQUE(omnifi_account_id))", async () => {
    await prerequisCompte(sessionA, "c4b-conn-a", "c4b-shared");
    // B crée sa PROPRE connexion (id distinct → OK), puis le MÊME omnifi_account_id
    // que A → viole la globale compte. (Toute la transaction withWorkspace roule back.)
    await expect(
      withWorkspace(sessionB, async (tx, ctx) => {
        const { connectionId } = await upsertConnexion(tx, ctx, {
          omnifiConnectionId: "c4b-conn-b",
          institutionId: "mcb",
          institutionName: "B",
          status: "active",
          nextSyncAvailableAt: null,
        });
        await upsertCompte(tx, ctx, connectionId, {
          omnifiAccountId: "c4b-shared", // MÊME que A
          accountName: "B",
          currency: "MUR",
          currentBalance: "1.00",
          isSelected: true,
        });
      }),
    ).rejects.toThrow();
  });

  it("C4c — même (omnifi_txn_id, date) sous B après A → rejet (globale UNIQUE(omnifi_txn_id, date))", async () => {
    const baA = await prerequisCompte(sessionA, "c4c-conn-a", "c4c-acc-a");
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertTransactions(tx, ctx, baA, txLot("c4c-shared", "2026-06-10")),
    );
    // B a son PROPRE compte (ids distincts → OK) : seule la clé txn collisionne.
    const baB = await prerequisCompte(sessionB, "c4c-conn-b", "c4c-acc-b");
    await expect(
      withWorkspace(sessionB, (tx, ctx) =>
        upsertTransactions(tx, ctx, baB, txLot("c4c-shared", "2026-06-10")),
      ),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Garde-fous anti faux-vert (identiques à ingestion-isolation).      */
/* ------------------------------------------------------------------ */
describe("préconditions", () => {
  it("C6 — les requêtes tournent sous tygr_app, pas sous l'owner (sinon RLS ignorée)", async () => {
    await client.exec(`set role tygr_app;`);
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

// Contre-preuve R1 : prouve POURQUOI le rôle non-owner est vital. Sous l'owner la
// frontière tenant ne filtre pas ; sous tygr_app elle filtre. Sans ça, C1–C3
// pourraient « réussir » par contournement RLS plutôt que par la contrainte.
describe("contre-preuve R1 : la RLS NE protège PAS sous le propriétaire", () => {
  afterAll(async () => {
    await client.exec(`set role tygr_app;`);
  });

  it("C5a — sous l'owner, un SELECT sans contexte voit l'AUTRE tenant (RLS ignorée)", async () => {
    await client.exec(`reset role;`);
    const res = await client.query<{ workspace_id: string }>(
      "select workspace_id from workspace_members",
    );
    expect(res.rows.some((r) => r.workspace_id === WS_B)).toBe(true);
  });

  it("C5b — sous tygr_app, le contexte A ne voit JAMAIS le tenant B (la RLS filtre)", async () => {
    await client.exec(`set role tygr_app;`);
    const vus = await withWorkspace(sessionA, (tx) =>
      tx.select().from(schema.workspaceMembers),
    );
    expect(vus.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(vus.some((r) => r.workspaceId === WS_B)).toBe(false);
  });
});
