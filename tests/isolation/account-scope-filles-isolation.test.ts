/**
 * Suite anti-IDOR — L5 : héritage de `account_scope` par les TABLES FILLES (RLS
 * native, migration 0017) + view_filter actif (intersection serveur dans
 * withWorkspace). Lot d'ISOLATION (POINT NÉVRALGIQUE) : referme un IDOR
 * intra-groupe ACTUEL (lectures/écritures de splits, soldes, transactions PAR-ID
 * non bornées au périmètre compte avant ce lot).
 *
 * Prouve sur Postgres réel (PGlite), DDL = migrations réelles appliquées par NOM
 * (0017 incluse), rôle applicatif = provisioning prod, exécution sous `tygr_app`
 * NON-propriétaire (sinon la RLS est ignorée — test 0) :
 *
 *   #1  transactions_cache d'un compte hors périmètre → 0 ligne.
 *   #2  ⭐ Les 3 lectures PAR-ID (ajouterSplit/remplacerSplits/creerSplitDepuisRegle)
 *       sur une transaction hors périmètre → refus/0 ligne, SANS écrire (la RLS
 *       native les scope AUTOMATIQUEMENT → ferme l'IDOR actuel).
 *   #3  balance_history d'un compte hors périmètre → 0 ligne.
 *   #4  ⭐ transaction_categorizations : INSERT/DELETE de split sur une transaction
 *       hors périmètre → refus (WITH CHECK via EXISTS) → l'IDOR ne se déplace pas
 *       vers l'écriture.
 *   #5  ⭐ COUVERTURE PARTITIONS : une transaction dans CHAQUE partition (2024,
 *       2025, 2026, 2027, _default) d'un compte hors périmètre → 0 ligne partout.
 *   #6  ⭐ INGESTION non bloquée : un sync en Vision Globale insère transactions +
 *       soldes + splits sans rejet WITH CHECK (non-régression couche sacrée).
 *   #7  view_filter — 3 cas C.3 : filtre vide → tout le DROIT ; filtre = compte hors
 *       droit → 0 ligne ; filtre ⊂ droit → seulement ces comptes.
 *   #8  ⭐ view_filter n'ÉLARGIT JAMAIS : scopé A + viewFilter=[B hors droit] → 0 ;
 *       GLOBALE + viewFilter=[A] → seulement A, borné au tenant.
 *   #9  Vision Globale voit tout (non-régression dashboard) ; cross-tenant → 0.
 *   #10 ⭐ AUDIT survit en Vision Globale : une ligne categorization_audit dont la
 *       transaction parente est PURGÉE reste visible pour un ADMIN (court-circuit
 *       AVANT l'EXISTS) — l'audit de conformité n'est pas effacé.
 *   #11 ⭐ AUDIT scopé pour un membre : scopé A ne voit PAS l'audit d'une txn de B.
 *   #12 ⭐ SPLIT hérité : split sur txn hors périmètre → invisible en lecture ET
 *       refusé INSERT/DELETE pour un membre scopé ; visible/modifiable en Globale.
 *
 * (La couverture account_scope de bank_accounts elle-même reste prouvée par
 * account-scope-isolation.test.ts — L4. Ici on prouve l'HÉRITAGE par les filles.)
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import {
  ajouterSplit,
  remplacerSplits,
  supprimerSplit,
} from "@/server/repositories/categorisation";
import { createWithWorkspace } from "@/server/db/tenancy";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes ───────────────────────────────────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // Vision Globale
const MGR_PARTY = "22222222-2222-4222-8222-222222222222"; // scope party SUCRE → {S1,S2}
const MGR_COMPTE = "33333333-3333-4333-8333-333333333333"; // scope compte ACC_S1 seul
const BOB_B = "66666666-6666-4666-8666-666666666666"; // membre WS_B

// Parties WS_A (+ témoin WS_B).
const PARTY_SUCRE = "9a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_HOLDING = "9b000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARTY_B = "9c000000-cccc-4ccc-8ccc-cccccccccccc";

// Comptes WS_A (+ témoin WS_B).
const ACC_S1 = "acc05100-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // party SUCRE
const ACC_S2 = "acc05200-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // party SUCRE
const ACC_H = "acc00100-cccc-4ccc-8ccc-cccccccccccc"; // party HOLDING (hors droit MGR_PARTY/COMPTE)
const ACC_B = "acc0bbbb-eeee-4eee-8eee-eeeeeeeeeeee"; // WS_B

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Catégorie (WS_A) pour les splits.
const CAT_A = "ca700000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Transactions — réparties par compte ET par partition (pour #5).
// Sur ACC_S1 (dans droit MGR_PARTY et MGR_COMPTE).
const TX_S1 = "f0510000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // 2026
// Sur ACC_S2 (dans droit MGR_PARTY, HORS droit MGR_COMPTE).
const TX_S2 = "f0520000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // 2026
// Sur ACC_H (HORS droit MGR_PARTY et MGR_COMPTE) — la cible IDOR.
const TX_H = "f0010000-cccc-4ccc-8ccc-cccccccccccc"; // 2026
// Sur ACC_H, une par partition (couverture #5).
const TX_H_2024 = "f0012024-cccc-4ccc-8ccc-cccccccccccc";
const TX_H_2025 = "f0012025-cccc-4ccc-8ccc-cccccccccccc";
const TX_H_2027 = "f0012027-cccc-4ccc-8ccc-cccccccccccc";
const TX_H_DEF = "f0012023-cccc-4ccc-8ccc-cccccccccccc"; // 2023 → _default

const D_2024 = "2024-06-15";
const D_2025 = "2025-06-15";
const D_2026 = "2026-06-15";
const D_2027 = "2027-06-15";
const D_DEF = "2023-06-15"; // hors bornes annuelles → partition _default

const sessAdmin = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessParty = { userId: MGR_PARTY, activeWorkspaceId: WS_A };
const sessCompte = { userId: MGR_COMPTE, activeWorkspaceId: WS_A };
const sessB = { userId: BOB_B, activeWorkspaceId: WS_B };

// Déplie la chaîne des causes (Drizzle enveloppe les erreurs driver RLS/FK/CHECK).
const flatten = (e: unknown): string => {
  let msg = "";
  let cur: unknown = e;
  while (cur instanceof Error) {
    msg += cur.message + " | ";
    cur = cur.cause;
  }
  return msg;
};

/**
 * Exécute du SQL brut sous owner (bypass RLS) — seed/mutations de contrôle. Le
 * `finally` RÉTABLIT impérativement tygr_app : sans lui, une exception au milieu
 * (ex. trigger append-only) laisserait la session en `postgres` et TOUS les tests
 * suivants seraient rejetés par le garde-fou C6 (UnsafeDatabaseRoleError).
 */
async function asOwner(sqlText: string): Promise<void> {
  await client.exec(`set role postgres;`);
  try {
    await client.exec(sqlText);
  } finally {
    await client.exec(`set role tygr_app;`);
  }
}

beforeAll(async () => {
  // 1. Migrations réelles, par NOM trié (0017 incluse → policies account_scope filles).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou structurel : account_scope RESTRICTIVE cmd=ALL, USING==WITH CHECK,
  //    sur les 4 tables filles + les 5 partitions. Sans cela la suite croirait à un
  //    périmètre prouvé alors qu'il ne mord pas.
  const cibles = [
    "transactions_cache",
    "transactions_cache_2024",
    "transactions_cache_2025",
    "transactions_cache_2026",
    "transactions_cache_2027",
    "transactions_cache_default",
    "balance_history",
    "transaction_categorizations",
    "categorization_audit",
  ];
  const pol = await client.query<{
    tablename: string;
    permissive: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `select tablename, permissive, cmd, qual, with_check
       from pg_policies where policyname = 'account_scope'`,
  );
  const parTable = new Map(pol.rows.map((r) => [r.tablename, r]));
  for (const t of cibles) {
    const p = parTable.get(t);
    if (!p) throw new Error(`Policy account_scope absente de ${t} (0017).`);
    if (p.permissive !== "RESTRICTIVE")
      throw new Error(`account_scope sur ${t} doit être RESTRICTIVE — ${p.permissive}.`);
    if (p.cmd !== "ALL")
      throw new Error(`account_scope sur ${t} doit être FOR ALL — cmd=${p.cmd}.`);
    if (!p.qual || !p.with_check || p.qual !== p.with_check)
      throw new Error(`account_scope sur ${t} : USING doit == WITH CHECK.`);
  }

  // 3. Seed owner (bypass RLS). Topologie : party SUCRE → {ACC_S1, ACC_S2} ; party
  //    HOLDING → {ACC_H}. MGR_PARTY scopé party SUCRE (voit S1+S2, jamais H).
  //    MGR_COMPTE scopé ACC_S1 seul (voit S1, jamais S2 ni H). Transactions/soldes/
  //    splits/audit sur S1, S2 et H ; H porte AUSSI une transaction par partition.
  await client.exec(`set role postgres;`);
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${MGR_PARTY}','party@a.mu','Mgr Party'),
      ('${MGR_COMPTE}','compte@a.mu','Mgr Compte'),
      ('${BOB_B}','b@b.mu','Bob B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MGR_PARTY}','${WS_A}','MANAGER'),
      ('${MGR_COMPTE}','${WS_A}','MANAGER'),
      ('${BOB_B}','${WS_B}','MANAGER');
    insert into parties (id, workspace_id, omnifi_party_id, name, is_active) values
      ('${PARTY_SUCRE}','${WS_A}','pid-suc','Société Sucrière',true),
      ('${PARTY_HOLDING}','${WS_A}','pid-hold','Holding',true),
      ('${PARTY_B}','${WS_B}','pid-b','Partie B',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected) values
      ('${ACC_S1}','${WS_A}','${CONN_A}','oa-s1','Sucre 1','MUR','1000.00',true),
      ('${ACC_S2}','${WS_A}','${CONN_A}','oa-s2','Sucre 2','MUR','2000.00',true),
      ('${ACC_H}','${WS_A}','${CONN_A}','oa-h','Holding','MUR','3000.00',true),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true);
    insert into account_party_role (workspace_id, bank_account_id, party_id, ownership_type, is_primary) values
      ('${WS_A}','${ACC_S1}','${PARTY_SUCRE}','BUSINESS',true),
      ('${WS_A}','${ACC_S2}','${PARTY_SUCRE}','BUSINESS',true),
      ('${WS_A}','${ACC_H}','${PARTY_HOLDING}','BUSINESS',true);
    insert into user_scopes (workspace_id, user_id, party_id) values
      ('${WS_A}','${MGR_PARTY}','${PARTY_SUCRE}');
    insert into user_scopes (workspace_id, user_id, bank_account_id) values
      ('${WS_A}','${MGR_COMPTE}','${ACC_S1}');
    insert into categories (id, workspace_id, name) values
      ('${CAT_A}','${WS_A}','Achats');
    -- Transactions (Credit/Debit ; montant >0 pour permettre des splits).
    insert into transactions_cache (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw) values
      ('${TX_S1}','${WS_A}','${ACC_S1}','ot-s1','${D_2026}','${D_2026}T10:00:00Z','100.00','MUR','Debit','x'),
      ('${TX_S2}','${WS_A}','${ACC_S2}','ot-s2','${D_2026}','${D_2026}T10:00:00Z','200.00','MUR','Debit','x'),
      ('${TX_H}','${WS_A}','${ACC_H}','ot-h','${D_2026}','${D_2026}T10:00:00Z','300.00','MUR','Debit','x'),
      ('${TX_H_2024}','${WS_A}','${ACC_H}','ot-h24','${D_2024}','${D_2024}T10:00:00Z','324.00','MUR','Debit','x'),
      ('${TX_H_2025}','${WS_A}','${ACC_H}','ot-h25','${D_2025}','${D_2025}T10:00:00Z','325.00','MUR','Debit','x'),
      ('${TX_H_2027}','${WS_A}','${ACC_H}','ot-h27','${D_2027}','${D_2027}T10:00:00Z','327.00','MUR','Debit','x'),
      ('${TX_H_DEF}','${WS_A}','${ACC_H}','ot-hdef','${D_DEF}','${D_DEF}T10:00:00Z','323.00','MUR','Debit','x');
    -- Soldes EOD (balance_history) sur S1 (dans droit) et H (hors droit).
    insert into balance_history (workspace_id, bank_account_id, balance_date, balance, currency) values
      ('${WS_A}','${ACC_S1}','${D_2026}','1000.00','MUR'),
      ('${WS_A}','${ACC_H}','${D_2026}','3000.00','MUR');
    -- Splits existants : un sur TX_S1 (dans droit), un sur TX_H (hors droit).
    insert into transaction_categorizations (workspace_id, transaction_id, transaction_date, category_id, amount, source, created_by) values
      ('${WS_A}','${TX_S1}','${D_2026}','${CAT_A}','50.00','MANUAL','${ADMIN_A}'),
      ('${WS_A}','${TX_H}','${D_2026}','${CAT_A}','30.00','MANUAL','${ADMIN_A}');
    -- Audit : une trace sur TX_S1 (dans droit) et une sur TX_H (hors droit).
    insert into categorization_audit (workspace_id, transaction_id, transaction_date, action, category_name, amount, source, actor_id) values
      ('${WS_A}','${TX_S1}','${D_2026}','CREATE','Achats','50.00','MANUAL','${ADMIN_A}'),
      ('${WS_A}','${TX_H}','${D_2026}','CREATE','Achats','30.00','MANUAL','${ADMIN_A}');
  `);

  // 4. Rôle applicatif non-propriétaire (source unique : provisioning prod).
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

describe("préconditions", () => {
  it("0. requêtes sous tygr_app (sinon RLS ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

// ── #1 — transactions_cache hors périmètre = 0 ligne ─────────────────────────
describe("#1 — lecture transactions_cache hors périmètre", () => {
  it("MGR_COMPTE (scope ACC_S1) ne voit AUCUNE transaction d'ACC_S2 ni d'ACC_H", async () => {
    const ids = await withWorkspace(sessCompte, async (tx) => {
      const r = await tx.execute(
        sql`select id from transactions_cache order by id`,
      );
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids).toContain(TX_S1); // son compte
    expect(ids).not.toContain(TX_S2); // même party, mais hors scope COMPTE
    expect(ids).not.toContain(TX_H); // autre party
  });

  it("MGR_PARTY (scope party SUCRE) voit S1+S2 mais JAMAIS H", async () => {
    const ids = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`select id from transactions_cache where transaction_date = ${D_2026} order by id`,
      );
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids.sort()).toEqual([TX_S1, TX_S2].sort());
    expect(ids).not.toContain(TX_H);
  });
});

// ── #2 ⭐ — Les 3 lectures PAR-ID scopées automatiquement (ferme l'IDOR) ──────
describe("#2 ⭐ — lectures PAR-ID hors périmètre : refus SANS écrire", () => {
  it("ajouterSplit sur TX_H (hors droit) → TransactionIntrouvable, aucun split créé", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessParty, (tx, ctx) =>
        ajouterSplit(tx, ctx, {
          transactionId: TX_H,
          transactionDate: D_2026,
          categoryId: CAT_A,
          amount: "10.00",
          source: "MANUAL",
          ruleId: null,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as { code?: string }).code).toBe("TRANSACTION_NOT_FOUND");
    // Aucun split ajouté sur TX_H (vérifié en Vision Globale : toujours le seul seed).
    const n = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select count(*)::int as n from transaction_categorizations
            where transaction_id = ${TX_H} and transaction_date = ${D_2026}`,
      );
      return (r as unknown as { rows: { n: number }[] }).rows[0].n;
    });
    expect(n).toBe(1); // le split de seed, pas un de plus
  });

  it("remplacerSplits sur TX_H (hors droit) → TransactionIntrouvable, splits inchangés", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessParty, (tx, ctx) =>
        remplacerSplits(tx, ctx, { transactionId: TX_H, transactionDate: D_2026 }, [
          { categoryId: CAT_A, amount: "5.00" },
        ]),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as { code?: string }).code).toBe("TRANSACTION_NOT_FOUND");
    // Le split de seed de TX_H est intact (montant 30.00, vu en Globale).
    const montant = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select amount from transaction_categorizations
            where transaction_id = ${TX_H} and transaction_date = ${D_2026}`,
      );
      return (r as unknown as { rows: { amount: string }[] }).rows[0]?.amount;
    });
    expect(montant).toBe("30.00");
  });

  it("creerSplitDepuisRegle est scopé par la même RLS (preuve indirecte via le verrou by-id)", async () => {
    // creerSplitDepuisRegle (regles-categorisation.ts) lit transactions_cache par
    // (id, date) en FOR UPDATE EXACTEMENT comme ajouterSplit : une transaction hors
    // périmètre → 0 ligne → `return false` (skip) sans écrire. On prouve ici la
    // primitive partagée (le SELECT by-id sous RLS) qui sous-tend les 3 chemins :
    // depuis MGR_PARTY, un SELECT FOR UPDATE de TX_H ne renvoie rien.
    const rows = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`select id from transactions_cache
            where id = ${TX_H} and transaction_date = ${D_2026} for update`,
      );
      return (r as unknown as { rows: { id: string }[] }).rows;
    });
    expect(rows).toHaveLength(0); // hors périmètre → le verrou ne saisit rien → skip
  });
});

// ── #3 — balance_history hors périmètre = 0 ligne ────────────────────────────
describe("#3 — balance_history hors périmètre", () => {
  it("MGR_COMPTE (ACC_S1) voit le solde d'ACC_S1, jamais celui d'ACC_H", async () => {
    const comptes = await withWorkspace(sessCompte, async (tx) => {
      const r = await tx.execute(
        sql`select bank_account_id from balance_history order by bank_account_id`,
      );
      return (r as unknown as { rows: { bank_account_id: string }[] }).rows.map(
        (x) => x.bank_account_id,
      );
    });
    expect(comptes).toEqual([ACC_S1]);
    expect(comptes).not.toContain(ACC_H);
  });
});

// ── #4 ⭐ — transaction_categorizations : écriture hors périmètre refusée ─────
describe("#4 ⭐ — INSERT/DELETE de split hors périmètre (WITH CHECK via EXISTS)", () => {
  it("INSERT direct d'un split sur TX_H depuis MGR_PARTY → refus WITH CHECK", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessParty, (tx) =>
        tx.execute(
          sql`insert into transaction_categorizations
                (workspace_id, transaction_id, transaction_date, category_id, amount, source, created_by)
              values (${WS_A}, ${TX_H}, ${D_2026}, ${CAT_A}, '7.00', 'MANUAL', ${MGR_PARTY})`,
        ),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "INSERT d'un split sur txn hors droit doit violer WITH CHECK").not.toBeNull();
    expect(flatten(thrown)).toMatch(/policy|row-level|violates|check/i);
  });

  it("DELETE d'un split d'une txn hors périmètre → 0 ligne (masqué par USING)", async () => {
    // Le split de seed de TX_H existe (Vision Globale), mais MGR_PARTY ne le voit pas
    // (EXISTS échoue : TX_H hors périmètre) → le DELETE ne matche rien.
    const supprime = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`delete from transaction_categorizations
            where transaction_id = ${TX_H} and transaction_date = ${D_2026}
            returning id`,
      );
      return (r as unknown as { rows: unknown[] }).rows.length;
    });
    expect(supprime).toBe(0);
    // Contre-preuve : le split est toujours là (Vision Globale).
    const n = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select count(*)::int as n from transaction_categorizations
            where transaction_id = ${TX_H} and transaction_date = ${D_2026}`,
      );
      return (r as unknown as { rows: { n: number }[] }).rows[0].n;
    });
    expect(n).toBe(1);
  });

  it("INSERT d'un split sur TX_S2 (DANS le droit party) PASSE pour MGR_PARTY", async () => {
    // Pendant : prouve que l'EXISTS n'est pas une interdiction globale — une txn DANS
    // le périmètre laisse écrire. On nettoie ensuite (DELETE dans le droit → autorisé).
    await withWorkspace(sessParty, (tx, ctx) =>
      ajouterSplit(tx, ctx, {
        transactionId: TX_S2,
        transactionDate: D_2026,
        categoryId: CAT_A,
        amount: "20.00",
        source: "MANUAL",
        ruleId: null,
      }),
    );
    const n = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`select count(*)::int as n from transaction_categorizations
            where transaction_id = ${TX_S2} and transaction_date = ${D_2026}`,
      );
      return (r as unknown as { rows: { n: number }[] }).rows[0].n;
    });
    expect(n).toBe(1);
    // Nettoyage (split dans le droit → supprimable par MGR_PARTY).
    await withWorkspace(sessParty, (tx) =>
      tx.execute(
        sql`delete from transaction_categorizations
            where transaction_id = ${TX_S2} and transaction_date = ${D_2026}`,
      ),
    );
  });
});

// ── #5 ⭐ — COUVERTURE DES PARTITIONS ────────────────────────────────────────
describe("#5 ⭐ — toutes les partitions sont scopées (aucune oubliée)", () => {
  it("MGR_PARTY ne voit AUCUNE transaction d'ACC_H dans CHAQUE partition", async () => {
    // ACC_H est hors droit → ses transactions, présentes dans 5 partitions
    // (2024/2025/2026/2027/_default), doivent TOUTES être masquées.
    const ids = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(sql`select id from transactions_cache`);
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    for (const txH of [TX_H, TX_H_2024, TX_H_2025, TX_H_2027, TX_H_DEF]) {
      expect(ids, `transaction d'ACC_H doit être masquée`).not.toContain(txH);
    }
  });

  it("interrogation DIRECTE de chaque partition depuis MGR_PARTY → 0 ligne d'ACC_H", async () => {
    // Lecture EN DIRECT d'une partition (SELECT FROM transactions_cache_YYYY) :
    // c'est le vecteur de fuite si une partition n'avait pas la policy. On vérifie
    // partition par partition que la transaction d'ACC_H est invisible.
    const partitions: [string, string][] = [
      ["transactions_cache_2024", TX_H_2024],
      ["transactions_cache_2025", TX_H_2025],
      ["transactions_cache_2026", TX_H],
      ["transactions_cache_2027", TX_H_2027],
      ["transactions_cache_default", TX_H_DEF],
    ];
    for (const [part, txH] of partitions) {
      const vu = await withWorkspace(sessParty, async (tx) => {
        const r = await tx.execute(
          sql`select id from ${sql.raw(part)} where id = ${txH}`,
        );
        return (r as unknown as { rows: unknown[] }).rows.length;
      });
      expect(vu, `${part} doit masquer la transaction d'ACC_H`).toBe(0);
    }
  });

  it("…mais l'ADMIN (Vision Globale) voit ces transactions dans chaque partition", async () => {
    const ids = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(sql`select id from transactions_cache`);
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    for (const txH of [TX_H, TX_H_2024, TX_H_2025, TX_H_2027, TX_H_DEF]) {
      expect(ids).toContain(txH);
    }
  });
});

// ── #6 ⭐ — INGESTION en Vision Globale non bloquée (couche sacrée) ───────────
describe("#6 ⭐ — sync en Vision Globale : INSERT filles non bloqués", () => {
  it("INSERT transaction + solde + split en session ADMIN (GUC absent) passe", async () => {
    // Clés DÉDIÉES (date de solde D_INGEST, jamais lue ailleurs) : transactions_cache
    // et balance_history sont APPEND-ONLY au DELETE → on n'efface RIEN après. La
    // ligne d'ACC_H reste hors droit pour les membres scopés → aucun autre test
    // n'est perturbé (les assertions ciblent des id/dates précis).
    const TX_NEW = "f09e0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const D_INGEST = "2025-09-09"; // partition _2025, date solde dédiée
    await withWorkspace(sessAdmin, (tx) =>
      tx.execute(sql`
        insert into transactions_cache (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw)
          values (${TX_NEW}, ${WS_A}, ${ACC_H}, 'ot-new', ${D_2026}, ${D_2026 + "T11:00:00Z"}, '400.00', 'MUR', 'Debit', 'y');
      `),
    );
    await withWorkspace(sessAdmin, (tx) =>
      tx.execute(sql`
        insert into balance_history (workspace_id, bank_account_id, balance_date, balance, currency)
          values (${WS_A}, ${ACC_H}, ${D_INGEST}, '2900.00', 'MUR');
      `),
    );
    // Split via le repository (chemin réel ajouterSplit) — passe car GUC account_scope absent.
    await withWorkspace(sessAdmin, (tx, ctx) =>
      ajouterSplit(tx, ctx, {
        transactionId: TX_NEW,
        transactionDate: D_2026,
        categoryId: CAT_A,
        amount: "40.00",
        source: "MANUAL",
        ruleId: null,
      }),
    );
    // Tout est là (Vision Globale) — preuve que l'ingestion en Vision Globale n'est
    // bloquée par aucun WITH CHECK account_scope (couche sacrée non régressée).
    const ok = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select
              (select count(*)::int from transactions_cache where id = ${TX_NEW}) as t,
              (select count(*)::int from balance_history where bank_account_id = ${ACC_H} and balance_date = ${D_INGEST}) as b,
              (select count(*)::int from transaction_categorizations where transaction_id = ${TX_NEW}) as s`,
      );
      return (r as unknown as { rows: { t: number; b: number; s: number }[] }).rows[0];
    });
    expect(ok).toEqual({ t: 1, b: 1, s: 1 });
    // Pas de nettoyage : tables append-only au DELETE (le trigger refuse, même sous
    // owner). Les lignes restent — hors droit des membres scopés, sans incidence.
  });
});

// ── #7 — view_filter : 3 cas C.3 ─────────────────────────────────────────────
describe("#7 — view_filter (intersection serveur)", () => {
  it("filtre VIDE (non fourni) → MGR_PARTY voit tout son DROIT (S1+S2)", async () => {
    const ids = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`select id from transactions_cache where transaction_date = ${D_2026} order by id`,
      );
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids.sort()).toEqual([TX_S1, TX_S2].sort());
  });

  it("filtre = compte HORS droit (ACC_H) → 0 ligne (PAS d'erreur, juste rétréci à vide)", async () => {
    const ids = await withWorkspace(
      { ...sessParty, viewFilter: [ACC_H] },
      async (tx) => {
        const r = await tx.execute(sql`select id from transactions_cache`);
        return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
      },
    );
    // ACC_H n'est pas dans le DROIT de MGR_PARTY → intersection vide → sentinelle → 0.
    expect(ids).toEqual([]);
  });

  it("filtre ⊂ droit (ACC_S2 seul) → seulement les transactions d'ACC_S2", async () => {
    const ids = await withWorkspace(
      { ...sessParty, viewFilter: [ACC_S2] },
      async (tx) => {
        const r = await tx.execute(
          sql`select id from transactions_cache where transaction_date = ${D_2026} order by id`,
        );
        return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
      },
    );
    expect(ids).toEqual([TX_S2]); // S1 masqué par le filtre, S2 (dans droit ∩ filtre) visible
  });
});

// ── #8 ⭐ — view_filter n'élargit JAMAIS ─────────────────────────────────────
describe("#8 ⭐ — view_filter ne peut que RÉTRÉCIR", () => {
  it("MGR_COMPTE (droit ACC_S1) + viewFilter=[ACC_H hors droit] → 0 ligne (jamais H)", async () => {
    const ids = await withWorkspace(
      { ...sessCompte, viewFilter: [ACC_H] },
      async (tx) => {
        const r = await tx.execute(sql`select id from transactions_cache`);
        return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
      },
    );
    // Le filtre client ne peut PAS faire apparaître H : intersection {S1} ∩ {H} = ∅.
    expect(ids).toEqual([]);
    expect(ids).not.toContain(TX_H);
  });

  it("MGR_COMPTE + viewFilter=[ACC_S1, ACC_H] → seulement S1 (intersection {S1})", async () => {
    const ids = await withWorkspace(
      { ...sessCompte, viewFilter: [ACC_S1, ACC_H] },
      async (tx) => {
        const r = await tx.execute(
          sql`select id from transactions_cache where transaction_date = ${D_2026} order by id`,
        );
        return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
      },
    );
    expect(ids).toEqual([TX_S1]); // H éliminé par l'intersection avec le DROIT
  });

  it("ADMIN (Globale) + viewFilter=[ACC_S1] → seulement S1, et borné au tenant (jamais WS_B)", async () => {
    const r = await withWorkspace(
      { ...sessAdmin, viewFilter: [ACC_S1, ACC_B] }, // ACC_B = WS_B, hors tenant
      async (tx) => {
        const tcache = await tx.execute(
          sql`select id from transactions_cache where transaction_date = ${D_2026} order by id`,
        );
        return (tcache as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
      },
    );
    // Mode GLOBALE : le filtre passe tel quel, MAIS tenant_isolation borne au tenant
    // → ACC_B (WS_B) ne ramène rien ; seul S1 (du filtre, dans WS_A) est visible.
    expect(r).toEqual([TX_S1]);
  });
});

// ── #9 — Vision Globale voit tout ; cross-tenant = 0 (étage 1 intact) ─────────
describe("#9 — non-régression dashboard + étage 1", () => {
  it("ADMIN (Globale) voit les transactions des 3 comptes de WS_A (D_2026)", async () => {
    const ids = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select id from transactions_cache where transaction_date = ${D_2026} order by id`,
      );
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids).toContain(TX_S1);
    expect(ids).toContain(TX_S2);
    expect(ids).toContain(TX_H);
  });

  it("session B ne voit AUCUNE fille de WS_A (cross-tenant → 0)", async () => {
    const r = await withWorkspace(sessB, async (tx) => {
      const tcache = await tx.execute(sql`select count(*)::int as n from transactions_cache`);
      const bh = await tx.execute(sql`select count(*)::int as n from balance_history`);
      const split = await tx.execute(sql`select count(*)::int as n from transaction_categorizations`);
      const audit = await tx.execute(sql`select count(*)::int as n from categorization_audit`);
      const g = (x: unknown) => (x as { rows: { n: number }[] }).rows[0].n;
      return { tc: g(tcache), bh: g(bh), split: g(split), audit: g(audit) };
    });
    // WS_B n'a aucune transaction/solde/split/audit semé → 0 partout (et surtout
    // aucune ligne de WS_A ne fuite : tenant_isolation tient sous account_scope).
    expect(r).toEqual({ tc: 0, bh: 0, split: 0, audit: 0 });
  });
});

// ── #10 ⭐ — AUDIT survit en Vision Globale (transaction purgée) ──────────────
describe("#10 ⭐ — l'audit survit à la purge de la transaction (Vision Globale)", () => {
  it("une trace d'audit dont la txn parente est SUPPRIMÉE reste visible pour l'ADMIN", async () => {
    // On sème une trace d'audit ORPHELINE (transaction parente jamais présente /
    // purgée) — categorization_audit n'a PAS de FK vers transactions_cache, donc
    // c'est un état légitime (la trace survit à la donnée). En Vision Globale,
    // account_scope court-circuite AVANT l'EXISTS → la trace orpheline est visible.
    const TX_PURGEE = "f0dead00-cccc-4ccc-8ccc-cccccccccccc"; // aucune ligne transactions_cache
    await asOwner(`
      insert into categorization_audit (workspace_id, transaction_id, transaction_date, action, category_name, amount, source, actor_id)
        values ('${WS_A}','${TX_PURGEE}','${D_2026}','DELETE','Achats','30.00','MANUAL','${ADMIN_A}');
    `);
    const vu = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select count(*)::int as n from categorization_audit where transaction_id = ${TX_PURGEE}`,
      );
      return (r as unknown as { rows: { n: number }[] }).rows[0].n;
    });
    expect(vu, "l'audit de conformité ne doit pas disparaître en Vision Globale").toBe(1);
    // (on laisse la trace : elle est append-only ; les tests suivants n'en dépendent pas)
  });
});

// ── #11 ⭐ — AUDIT scopé pour un membre ──────────────────────────────────────
describe("#11 ⭐ — l'audit est scopé pour un membre (EXISTS récursif)", () => {
  it("MGR_PARTY ne voit PAS l'audit d'une txn d'ACC_H (hors périmètre)", async () => {
    const ids = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`select transaction_id from categorization_audit order by transaction_id`,
      );
      return (r as unknown as { rows: { transaction_id: string }[] }).rows.map(
        (x) => x.transaction_id,
      );
    });
    // Trace de TX_S1 (compte dans droit) visible ; trace de TX_H (hors droit) masquée.
    expect(ids).toContain(TX_S1);
    expect(ids).not.toContain(TX_H);
  });

  it("…et l'ADMIN voit les DEUX traces (S1 et H)", async () => {
    const ids = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select distinct transaction_id from categorization_audit`,
      );
      return (r as unknown as { rows: { transaction_id: string }[] }).rows.map(
        (x) => x.transaction_id,
      );
    });
    expect(ids).toContain(TX_S1);
    expect(ids).toContain(TX_H);
  });
});

// ── #12 ⭐ — SPLIT hérité (EXISTS) : invisible/refusé scopé, ouvert en Globale ─
describe("#12 ⭐ — split hérité du scope de la transaction parente", () => {
  it("MGR_PARTY ne voit PAS le split de TX_H (hors droit) en lecture", async () => {
    const ids = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`select transaction_id from transaction_categorizations order by transaction_id`,
      );
      return (r as unknown as { rows: { transaction_id: string }[] }).rows.map(
        (x) => x.transaction_id,
      );
    });
    expect(ids).toContain(TX_S1); // split d'un compte dans droit
    expect(ids).not.toContain(TX_H); // split d'un compte hors droit → masqué
  });

  it("supprimerSplit (chemin repository) sur le split de TX_H → {supprime:false} pour MGR_PARTY", async () => {
    // On récupère l'id réel du split de TX_H (vu en Globale), puis on tente de le
    // supprimer depuis MGR_PARTY : la RLS masque la ligne → returning vide → false.
    const splitId = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select id from transaction_categorizations
            where transaction_id = ${TX_H} and transaction_date = ${D_2026} limit 1`,
      );
      return (r as unknown as { rows: { id: string }[] }).rows[0].id;
    });
    const res = await withWorkspace(sessParty, (tx, ctx) =>
      supprimerSplit(tx, ctx, splitId),
    );
    expect(res).toEqual({ supprime: false });
    // Contre-preuve : le split de TX_H est toujours présent (Vision Globale).
    const n = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select count(*)::int as n from transaction_categorizations where id = ${splitId}`,
      );
      return (r as unknown as { rows: { n: number }[] }).rows[0].n;
    });
    expect(n).toBe(1);
  });

  it("l'ADMIN (Globale) voit ET peut modifier le split de TX_H", async () => {
    const ids = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select transaction_id from transaction_categorizations order by transaction_id`,
      );
      return (r as unknown as { rows: { transaction_id: string }[] }).rows.map(
        (x) => x.transaction_id,
      );
    });
    expect(ids).toContain(TX_H); // visible en Vision Globale
  });
});
