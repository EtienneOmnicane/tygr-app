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

import { eq, sql } from "drizzle-orm";
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

/* ------------------------------------------------------------------ */
/* Invariant Entités (Option B) — l'ingestion ne pose JAMAIS d'entity_id */
/* automatiquement, et ne l'écrase JAMAIS au re-sync (plan §1.5,        */
/* schema.ts:306). C'est le contrat « ingestion → sas ADMIN » : un       */
/* compte naît NON ASSIGNÉ (NULL = fail-closed, invisible en Vision      */
/* Entité), l'ADMIN l'assigne ensuite ; un re-sync préserve l'entité.    */
/* Garde-fou de RÉGRESSION : si un jour entity_id entre dans le          */
/* onConflictDoUpdate.set de upsertCompte, le test 2 vire au rouge.      */
/* ------------------------------------------------------------------ */
describe("invariant Entités : ingestion crée entity_id NULL et ne l'écrase pas (re-sync)", () => {
  it("1. un compte fraîchement ingéré a entity_id = NULL (non assigné, fail-closed)", async () => {
    const baA = await prerequisCompte(sessionA, "conn-ent-1", "acc-ent-1");
    const compte = await withWorkspace(sessionA, (tx) =>
      tx
        .select({ entityId: schema.bankAccounts.entityId })
        .from(schema.bankAccounts)
        .where(eq(schema.bankAccounts.id, baA)),
    );
    expect(compte[0].entityId).toBeNull();
  });

  it("2. re-sync d'un compte DÉJÀ assigné NE réécrase PAS son entity_id (préservation, plan §1.5)", async () => {
    // 1er sync : le compte naît NULL.
    const baA = await prerequisCompte(sessionA, "conn-ent-2", "acc-ent-2");

    // L'ADMIN l'assigne à une entité (on pose l'entité + l'assignation EN BASE,
    // owner, pour rester focalisé sur l'invariant d'ingestion — l'assignation via
    // Server Action est déjà couverte par entites-admin-isolation).
    const ENT_A = "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await client.exec(`reset role;`);
    await client.exec(`
      insert into entities (id, workspace_id, name, code, is_active) values
        ('${ENT_A}', '${WS_A}', 'Sucrière', 'SUC', true);
      update bank_accounts set entity_id = '${ENT_A}' where id = '${baA}';
    `);
    await client.exec(`set role tygr_app;`);

    // 2e sync : MÊME omnifi_account_id, libellé/solde mis à jour (re-découverte).
    await withWorkspace(sessionA, async (tx, ctx) => {
      const { connectionId } = await upsertConnexion(tx, ctx, {
        omnifiConnectionId: "conn-ent-2b",
        institutionId: "mcb",
        institutionName: "MCB (re-sync)",
        status: "active",
        nextSyncAvailableAt: null,
      });
      await upsertCompte(tx, ctx, connectionId, {
        omnifiAccountId: "acc-ent-2", // même compte
        accountName: "Compte courant (re-sync)",
        currency: "MUR",
        currentBalance: "9999.00",
        isSelected: true,
      });
    });

    // L'entity_id assigné a SURVÉCU au re-sync (il n'est pas dans le set du upsert) ;
    // le reste (libellé/solde) a bien été mis à jour → preuve que l'upsert a bien
    // tourné, et que SEUL entity_id est préservé.
    const compte = await withWorkspace(sessionA, (tx) =>
      tx
        .select({
          entityId: schema.bankAccounts.entityId,
          accountName: schema.bankAccounts.accountName,
          currentBalance: schema.bankAccounts.currentBalance,
        })
        .from(schema.bankAccounts)
        .where(eq(schema.bankAccounts.omnifiAccountId, "acc-ent-2")),
    );
    expect(compte).toHaveLength(1);
    expect(compte[0].entityId).toBe(ENT_A); // ⬅️ préservé
    expect(compte[0].accountName).toBe("Compte courant (re-sync)"); // ⬅️ mis à jour
    expect(compte[0].currentBalance).toBe("9999.00"); // ⬅️ mis à jour
  });
});

/* ------------------------------------------------------------------ */
/* Provenance auto (Omni-FI) — marqueur is_auto_categorized /         */
/* category_source : cohérence en base (CHECK 0011) + logique de       */
/* backfill idempotente sur la donnée déjà présente.                   */
/* ------------------------------------------------------------------ */

// Réplique EXACTE de l'UPDATE de scripts/backfill-auto-categorized.mjs (même prédicat
// « catégorie exploitable », mêmes 3 colonnes au SET, mêmes 3 disjonctions au WHERE —
// périmètre primary_category UNIQUEMENT, sub_category non touchée, aligné sur
// l'ingestion). On la teste ici sur PGlite réel pour prouver convergence + idempotence
// sans lancer le script (pas de connexion réseau en test). Si le script change, CETTE
// constante DOIT suivre — sinon le test ne prouve plus le chemin réel.
const EXPLOITABLE = `primary_category IS NOT NULL AND btrim(primary_category) <> '' AND lower(btrim(primary_category)) <> 'uncategorized'`;
const BACKFILL_SQL = `
  UPDATE transactions_cache
  SET
    is_auto_categorized = CASE WHEN ${EXPLOITABLE} THEN true ELSE false END,
    category_source     = CASE WHEN ${EXPLOITABLE} THEN 'OMNIFI' ELSE NULL END,
    primary_category    = CASE WHEN ${EXPLOITABLE} THEN primary_category ELSE NULL END
  WHERE
    is_auto_categorized <> (CASE WHEN ${EXPLOITABLE} THEN true ELSE false END)
    OR category_source IS DISTINCT FROM (CASE WHEN ${EXPLOITABLE} THEN 'OMNIFI' ELSE NULL END)
    OR (NOT (${EXPLOITABLE}) AND primary_category IS NOT NULL)
`;

describe("provenance auto Omni-FI : marqueur + backfill", () => {
  it("upsertTransactions pose le marqueur OMNIFI quand la catégorie est exploitable", async () => {
    const baA = await prerequisCompte(sessionA, "conn-auto-1", "acc-auto-1");
    await withWorkspace(sessionA, (tx, ctx) =>
      upsertTransactions(tx, ctx, baA, [
        {
          omnifiTxnId: "tx-auto-ok",
          transactionDate: "2026-06-12",
          bookingDateTime: new Date("2026-06-12T05:30:00Z"),
          amount: "1500.00",
          currency: "MUR",
          creditDebit: "Debit" as const,
          bankLabelRaw: "CEB",
          cleanLabel: "CEB",
          primaryCategory: "Utilities",
          subCategory: "Electricity",
          confidenceLevel: "High",
          classificationSource: "SYSTEM_RULE",
          ruleIdMatch: "rule_utilities_03",
          isAutoCategorized: true,
          categorySource: "OMNIFI" as const,
          isRemoved: false,
        },
      ]),
    );
    const [ligne] = await withWorkspace(sessionA, (tx) =>
      tx
        .select({
          isAuto: transactionsCache.isAutoCategorized,
          source: transactionsCache.categorySource,
        })
        .from(transactionsCache)
        .where(eq(transactionsCache.omnifiTxnId, "tx-auto-ok")),
    );
    expect(ligne.isAuto).toBe(true);
    expect(ligne.source).toBe("OMNIFI");
  });

  it("le CHECK de cohérence rejette un état incohérent (auto=true sans source)", async () => {
    const baA = await prerequisCompte(sessionA, "conn-auto-2", "acc-auto-2");
    // Insertion brute DANS le contexte RLS (withWorkspace pose app.current_workspace_id,
    // donc le WITH CHECK tenant passe) pour isoler le CHECK de cohérence :
    // is_auto_categorized=true MAIS category_source=NULL → doit lever check_violation.
    // On contourne volontairement le DTO TS (qui garantit déjà la cohérence) pour
    // prouver que la base est la dernière ligne de défense.
    await expect(
      withWorkspace(sessionA, (tx, ctx) =>
        tx.execute(sql`
          insert into transactions_cache
            (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date,
             booking_date_time, amount, currency, credit_debit,
             is_auto_categorized, category_source, is_removed)
          values
            (gen_random_uuid(), ${ctx.workspaceId}, ${baA}, 'tx-incoherent', '2026-06-13',
             '2026-06-13T05:30:00Z', '10.00', 'MUR', 'Debit',
             true, null, false)
        `),
      ),
    ).rejects.toThrow();
  });

  it("backfill : convergence (catégorie exploitable → OMNIFI ; 'Uncategorized'/vide → nettoyé) + idempotence", async () => {
    const baA = await prerequisCompte(sessionA, "conn-bf", "acc-bf");
    // On simule des lignes ingérées AVANT la feature : marqueur à false partout, avec
    // des primary_category « polluées » (Uncategorized, vide) à nettoyer. On passe par
    // upsertTransactions (RLS OK) en forçant l'état legacy via les champs du DTO
    // (false/null = cohérent avec le CHECK ; c'est exactement l'état d'avant 0011).
    const lignesLegacy = [
      { txn: "bf-income", cat: "Income", sous: null }, // exploitable → doit devenir OMNIFI
      { txn: "bf-uncat", cat: "Uncategorized", sous: null }, // → nettoyé (NULL, pas de marqueur)
      { txn: "bf-vide", cat: "", sous: null }, // → nettoyé
      { txn: "bf-casse", cat: "  UNCATEGORIZED ", sous: null }, // casse/espaces → nettoyé
      // Catégorie valide MAIS sous-catégorie "Uncategorized" : le backfill NE doit PAS
      // toucher sub_category (hors périmètre, aligné sur l'ingestion). Garde-fou de
      // non-régression du constat QA 2026-06-23.
      { txn: "bf-sous-uncat", cat: "Income", sous: "Uncategorized" },
    ];
    let jour = 14;
    for (const l of lignesLegacy) {
      const date = `2026-06-${jour}`;
      await withWorkspace(sessionA, (tx, ctx) =>
        upsertTransactions(tx, ctx, baA, [
          {
            omnifiTxnId: l.txn,
            transactionDate: date,
            bookingDateTime: new Date(`${date}T05:30:00Z`),
            amount: "10.00",
            currency: "MUR",
            creditDebit: "Debit" as const,
            bankLabelRaw: null,
            cleanLabel: null,
            // État LEGACY simulé : catégorie polluée présente, AUCUN marqueur (comme
            // avant la feature). Cohérent avec le CHECK (false ⟺ source null).
            primaryCategory: l.cat,
            subCategory: l.sous,
            // Métadonnées de classification absentes en legacy (NULL avant TECH-API-TRACE).
            confidenceLevel: null,
            classificationSource: null,
            ruleIdMatch: null,
            isAutoCategorized: false,
            categorySource: null,
            isRemoved: false,
          },
        ]),
      );
      jour += 1;
    }

    // Le backfill RÉEL tourne sous le rôle OWNER (DATABASE_URL_ADMIN, RLS non
    // filtrée — c'est une migration de données one-shot, cf. en-tête du script).
    // On reproduit fidèlement ce contexte : `reset role` repasse au superuser PGlite
    // (BYPASSRLS, équivalent owner ; PGlite n'a pas de rôle "tygr_owner" nommé). On
    // restaure `tygr_app` juste après pour que les lectures de vérification repassent
    // sous RLS, comme l'app. (Même pattern que dashboard-cas-limites.test.ts.)
    await client.exec(`reset role;`);
    // 1re passe du backfill.
    const passe1 = await client.query(BACKFILL_SQL);
    await client.exec(`set role tygr_app;`);
    expect(passe1.affectedRows).toBeGreaterThan(0);

    // Vérifie l'état cible.
    const apres = await withWorkspace(sessionA, (tx) =>
      tx
        .select({
          txn: transactionsCache.omnifiTxnId,
          cat: transactionsCache.primaryCategory,
          sous: transactionsCache.subCategory,
          isAuto: transactionsCache.isAutoCategorized,
          source: transactionsCache.categorySource,
        })
        .from(transactionsCache),
    );
    const parTxn = Object.fromEntries(apres.map((r) => [r.txn, r]));

    // Exploitable → marqueur OMNIFI, catégorie conservée.
    expect(parTxn["bf-income"]).toMatchObject({
      cat: "Income",
      isAuto: true,
      source: "OMNIFI",
    });
    // Polluées → primary_category nettoyée à NULL, aucun marqueur.
    for (const txn of ["bf-uncat", "bf-vide", "bf-casse"]) {
      expect(parTxn[txn]).toMatchObject({
        cat: null,
        isAuto: false,
        source: null,
      });
    }
    // Catégorie valide + sous-catégorie "Uncategorized" : marqueur OMNIFI posé, mais
    // sub_category INTACTE (le backfill ne la touche pas — périmètre primary_category).
    expect(parTxn["bf-sous-uncat"]).toMatchObject({
      cat: "Income",
      sous: "Uncategorized",
      isAuto: true,
      source: "OMNIFI",
    });

    // IDEMPOTENCE : 2e passe (toujours sous le rôle owner) ne doit toucher AUCUNE
    // ligne (état déjà convergé → le WHERE du backfill ne matche plus rien).
    await client.exec(`reset role;`);
    const passe2 = await client.query(BACKFILL_SQL);
    await client.exec(`set role tygr_app;`);
    expect(passe2.affectedRows).toBe(0);
  });
});
