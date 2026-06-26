/**
 * Suite NON-RÉGRESSION — L5 : ACTE la dette ENTITY×ACCOUNT-DOUBLE-AXIS, dans sa
 * manifestation « incohérence de maille FICHE ≠ FLUX » pour un membre à DOUBLE AXE.
 *
 * ── Contexte (établi au cross-review L4/L5, NE PAS re-litiger ici) ────────────
 * `withWorkspace` (tenancy.ts) pose DEUX GUC en parallèle pour un membre qui cumule
 * un `member_entity_scopes` (axe BU) ET un `user_scopes` (party/compte) :
 *   • `account_scope` = l'UNION des deux axes traduite en comptes (le DROIT) ;
 *   • `entity_scope`  = le CSV des entités de l'axe BU (demeure actif EN PARALLÈLE).
 * La FICHE `bank_accounts` porte les DEUX policies RESTRICTIVE (account_scope 0016 +
 * entity_scope 0014) → elle subit leur AND = `account_scope ∩ entity_scope`. Les
 * TABLES FILLES (transactions_cache/balance_history/transaction_categorizations) ne
 * portent QUE `account_scope` (0017, héritage). D'où une INCOHÉRENCE DE MAILLE :
 *   → un compte octroyé par la PARTY (donc dans `account_scope`) mais dont l'entité
 *     est HORS du scope BU (entity_id NULL ou autre entité) est MASQUÉ sur sa FICHE
 *     (intersection) tout en laissant voir ses FLUX (les filles, account_scope seul).
 *
 * Ce comportement est FAIL-CLOSED DES DEUX CÔTÉS : le membre voit, sur la fiche,
 * MOINS que son droit (sur-restriction), JAMAIS plus ; et AUCUNE ligne hors de ses
 * deux axes ne lui parvient — ni fiche, ni flux. Ce n'est PAS un IDOR, c'est une
 * SUR-restriction bénigne (un oracle d'inférence UX au pire : « ce compte a des flux
 * mais pas de fiche »). C'est la dette ENTITY×ACCOUNT-DOUBLE-AXIS (TODOS.md), qui se
 * DISSOUT au retrait d'`entity_scope` en L9. On NE la corrige PAS ici (corriger =
 * élargir L5 avec une policy qu'on retirera en L9) — on l'ACTE par ce test.
 *
 * ⚠️ CE TEST DOIT ÊTRE REVISITÉ EN L9 : après retrait d'`entity_scope`, la maille de
 * la fiche se réaligne sur celle des filles → la fiche DEVRA montrer ACC_S2 (le cas
 * `voit la fiche d'ACC_S2` ci-dessous, qui asserte aujourd'hui l'INVISIBILITÉ, devra
 * être INVERSÉ). Le seul invariant intangible à toute époque = ⭐ ACC_H invisible
 * partout (hors des deux axes).
 *
 * Topologie (sous role tygr_app NON-bypassrls, DDL = migrations réelles par NOM) :
 *   • MGR_DUO : DOUBLE AXE — `user_scopes` party SUCRE (→ ACC_S1, ACC_S2) ET
 *     `member_entity_scopes` entité ENT_S (→ ne couvre QUE ACC_S1).
 *   • ACC_S1 : party SUCRE, entity_id = ENT_S  (dans les DEUX axes).
 *   • ACC_S2 : party SUCRE, entity_id = NULL   (dans account_scope, HORS entity_scope).
 *   • ACC_H  : party HOLDING, entity_id = NULL (HORS des deux axes — la sentinelle).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes ───────────────────────────────────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // Vision Globale (contre-preuve)
const MGR_DUO = "44444444-4444-4444-8444-444444444444"; // DOUBLE AXE : party SUCRE + entité ENT_S

const PARTY_SUCRE = "9a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_HOLDING = "9b000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ENT_S = "e0510000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // entité scopée → couvre ACC_S1 seul

// ACC_S1 ∈ party SUCRE ET entity ENT_S ; ACC_S2 ∈ party SUCRE, entity NULL ;
// ACC_H ∈ party HOLDING, entity NULL (hors des deux axes).
const ACC_S1 = "acc05100-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_S2 = "acc05200-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC_H = "acc00100-cccc-4ccc-8ccc-cccccccccccc";

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAT_A = "ca700000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Transactions (toutes 2026 → partition _2026 ; la couverture des partitions est
// déjà prouvée par account-scope-filles-isolation.test.ts #5, hors scope ici).
const TX_S1 = "f0510000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // ACC_S1
const TX_S2 = "f0520000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // ACC_S2 (le cœur du cas)
const TX_H = "f0010000-cccc-4ccc-8ccc-cccccccccccc"; // ACC_H (la sentinelle)

const D_2026 = "2026-06-15";

const sessAdmin = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessDuo = { userId: MGR_DUO, activeWorkspaceId: WS_A };

beforeAll(async () => {
  // 1. Migrations réelles, par NOM trié (0008 entité + 0014 entity_scope FOR ALL +
  //    0016/0017 account_scope filles → toutes nécessaires à ce cas).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou structurel : sans les DEUX policies actives sur la FICHE, le test
  //    croirait à une intersection prouvée alors qu'elle ne mord pas. On exige
  //    entity_scope (FOR ALL) ET account_scope (FOR ALL) RESTRICTIVE sur bank_accounts.
  const pol = await client.query<{ policyname: string; permissive: string; cmd: string }>(
    `select policyname, permissive, cmd from pg_policies
       where tablename = 'bank_accounts' and policyname in ('entity_scope','account_scope')`,
  );
  const parNom = new Map(pol.rows.map((r) => [r.policyname, r]));
  for (const nom of ["entity_scope", "account_scope"]) {
    const p = parNom.get(nom);
    if (!p) throw new Error(`Policy ${nom} absente de bank_accounts (0014/0016).`);
    if (p.permissive !== "RESTRICTIVE")
      throw new Error(`${nom} sur bank_accounts doit être RESTRICTIVE — ${p.permissive}.`);
    if (p.cmd !== "ALL")
      throw new Error(`${nom} sur bank_accounts doit être FOR ALL — cmd=${p.cmd}.`);
  }

  // 3. Seed owner (bypass RLS). MGR_DUO porte les DEUX axes ; ACC_S1 a entity_id=ENT_S,
  //    ACC_S2 et ACC_H ont entity_id=NULL.
  await client.exec(`set role postgres;`);
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${MGR_DUO}','duo@a.mu','Mgr Duo');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MGR_DUO}','${WS_A}','MANAGER');
    insert into entities (id, workspace_id, name, is_active) values
      ('${ENT_S}','${WS_A}','BU Sucre',true);
    insert into parties (id, workspace_id, omnifi_party_id, name, is_active) values
      ('${PARTY_SUCRE}','${WS_A}','pid-suc','Société Sucrière',true),
      ('${PARTY_HOLDING}','${WS_A}','pid-hold','Holding',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}');
    -- ACC_S1 rattaché à ENT_S ; ACC_S2 et ACC_H entity_id NULL.
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_S1}','${WS_A}','${CONN_A}','oa-s1','Sucre 1','MUR','1000.00',true,'${ENT_S}'),
      ('${ACC_S2}','${WS_A}','${CONN_A}','oa-s2','Sucre 2','MUR','2000.00',true,null),
      ('${ACC_H}','${WS_A}','${CONN_A}','oa-h','Holding','MUR','3000.00',true,null);
    insert into account_party_role (workspace_id, bank_account_id, party_id, ownership_type, is_primary) values
      ('${WS_A}','${ACC_S1}','${PARTY_SUCRE}','BUSINESS',true),
      ('${WS_A}','${ACC_S2}','${PARTY_SUCRE}','BUSINESS',true),
      ('${WS_A}','${ACC_H}','${PARTY_HOLDING}','BUSINESS',true);
    -- DOUBLE AXE : party SUCRE (user_scopes) ET entité ENT_S (member_entity_scopes).
    insert into user_scopes (workspace_id, user_id, party_id) values
      ('${WS_A}','${MGR_DUO}','${PARTY_SUCRE}');
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${MGR_DUO}','${ENT_S}');
    insert into categories (id, workspace_id, name) values
      ('${CAT_A}','${WS_A}','Achats');
    -- Une transaction + un solde + un split par compte (S1 dans tout ; S2 = cas maille ;
    -- H = sentinelle hors droit).
    insert into transactions_cache (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw) values
      ('${TX_S1}','${WS_A}','${ACC_S1}','ot-s1','${D_2026}','${D_2026}T10:00:00Z','100.00','MUR','Debit','x'),
      ('${TX_S2}','${WS_A}','${ACC_S2}','ot-s2','${D_2026}','${D_2026}T10:00:00Z','200.00','MUR','Debit','x'),
      ('${TX_H}','${WS_A}','${ACC_H}','ot-h','${D_2026}','${D_2026}T10:00:00Z','300.00','MUR','Debit','x');
    insert into balance_history (workspace_id, bank_account_id, balance_date, balance, currency) values
      ('${WS_A}','${ACC_S1}','${D_2026}','1000.00','MUR'),
      ('${WS_A}','${ACC_S2}','${D_2026}','2000.00','MUR'),
      ('${WS_A}','${ACC_H}','${D_2026}','3000.00','MUR');
    insert into transaction_categorizations (workspace_id, transaction_id, transaction_date, category_id, amount, source, created_by) values
      ('${WS_A}','${TX_S1}','${D_2026}','${CAT_A}','50.00','MANUAL','${ADMIN_A}'),
      ('${WS_A}','${TX_S2}','${D_2026}','${CAT_A}','60.00','MANUAL','${ADMIN_A}'),
      ('${WS_A}','${TX_H}','${D_2026}','${CAT_A}','30.00','MANUAL','${ADMIN_A}');
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
  it("requêtes sous tygr_app (sinon RLS ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

// ── (a) FICHE bank_accounts : sur-restreinte par account_scope ∩ entity_scope ──
describe("(a) FICHE bank_accounts — intersection des deux axes", () => {
  it("MGR_DUO voit la fiche d'ACC_S1 (dans les DEUX axes)", async () => {
    const ids = await withWorkspace(sessDuo, async (tx) => {
      const r = await tx.execute(sql`select id from bank_accounts order by id`);
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids).toContain(ACC_S1);
  });

  it("⭐ MGR_DUO ne voit PAS la fiche d'ACC_S2 (octroyé par party, mais entity hors scope BU)", async () => {
    // C'est LE symptôme de la dette : ACC_S2 est dans account_scope (party SUCRE),
    // mais entity_scope={ENT_S} le masque (entity_id NULL). Intersection → invisible.
    // ⚠️ EN L9 (retrait d'entity_scope) : ce cas devra montrer ACC_S2 (maille réalignée).
    const ids = await withWorkspace(sessDuo, async (tx) => {
      const r = await tx.execute(sql`select id from bank_accounts order by id`);
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids).not.toContain(ACC_S2);
  });

  it("MGR_DUO ne voit PAS la fiche d'ACC_H (hors des deux axes)", async () => {
    const ids = await withWorkspace(sessDuo, async (tx) => {
      const r = await tx.execute(sql`select id from bank_accounts order by id`);
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids).not.toContain(ACC_H);
  });

  it("la fiche de MGR_DUO se réduit EXACTEMENT à {ACC_S1}", async () => {
    const ids = await withWorkspace(sessDuo, async (tx) => {
      const r = await tx.execute(sql`select id from bank_accounts order by id`);
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids).toEqual([ACC_S1]); // account_scope {S1,S2} ∩ entity_scope {S1} = {S1}
  });
});

// ── (b) FILLES : le DROIT = union des axes (account_scope seul, pas d'entity_scope) ─
describe("(b) FILLES (transactions/soldes/splits) — DROIT = union des axes", () => {
  it("⭐ MGR_DUO VOIT les transactions d'ACC_S1 ET d'ACC_S2 (jamais ACC_H)", async () => {
    // Les filles ne portent QUE account_scope = {S1,S2} → S2 est VISIBLE en flux,
    // alors que sa FICHE est masquée (cas (a)) : c'est l'incohérence de maille.
    const ids = await withWorkspace(sessDuo, async (tx) => {
      const r = await tx.execute(sql`select id from transactions_cache order by id`);
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(ids.sort()).toEqual([TX_S1, TX_S2].sort());
    expect(ids).not.toContain(TX_H);
  });

  it("⭐ MGR_DUO VOIT les soldes d'ACC_S1 ET d'ACC_S2 (jamais ACC_H)", async () => {
    const comptes = await withWorkspace(sessDuo, async (tx) => {
      const r = await tx.execute(
        sql`select bank_account_id from balance_history order by bank_account_id`,
      );
      return (r as unknown as { rows: { bank_account_id: string }[] }).rows.map(
        (x) => x.bank_account_id,
      );
    });
    expect(comptes.sort()).toEqual([ACC_S1, ACC_S2].sort());
    expect(comptes).not.toContain(ACC_H);
  });

  it("⭐ MGR_DUO VOIT les splits d'ACC_S1 ET d'ACC_S2 (jamais ACC_H)", async () => {
    // transaction_categorizations hérite via EXISTS vers transactions_cache (0017) →
    // visible pour S1 et S2 (filles), masqué pour H.
    const txns = await withWorkspace(sessDuo, async (tx) => {
      const r = await tx.execute(
        sql`select transaction_id from transaction_categorizations order by transaction_id`,
      );
      return (r as unknown as { rows: { transaction_id: string }[] }).rows.map(
        (x) => x.transaction_id,
      );
    });
    expect(txns.sort()).toEqual([TX_S1, TX_S2].sort());
    expect(txns).not.toContain(TX_H);
  });
});

// ── (c) ⭐ INVARIANT DE SÉCURITÉ : ACC_H invisible PARTOUT (la sur-restriction est bénigne) ─
describe("(c) ⭐ INVARIANT — aucune ligne d'ACC_H (hors des deux axes) ne fuit nulle part", () => {
  it("ACC_H absent de la FICHE, des transactions, des soldes ET des splits pour MGR_DUO", async () => {
    // C'est la preuve que l'incohérence de maille est une SUR-restriction bénigne et
    // PAS une fuite : un compte hors des deux axes ne se montre NI en fiche NI en flux.
    const r = await withWorkspace(sessDuo, async (tx) => {
      const fiche = await tx.execute(
        sql`select count(*)::int as n from bank_accounts where id = ${ACC_H}`,
      );
      const txns = await tx.execute(
        sql`select count(*)::int as n from transactions_cache where bank_account_id = ${ACC_H}`,
      );
      const soldes = await tx.execute(
        sql`select count(*)::int as n from balance_history where bank_account_id = ${ACC_H}`,
      );
      const splits = await tx.execute(
        sql`select count(*)::int as n from transaction_categorizations where transaction_id = ${TX_H}`,
      );
      const g = (x: unknown) => (x as { rows: { n: number }[] }).rows[0].n;
      return { fiche: g(fiche), txns: g(txns), soldes: g(soldes), splits: g(splits) };
    });
    expect(r).toEqual({ fiche: 0, txns: 0, soldes: 0, splits: 0 });
  });

  it("contre-preuve — l'ADMIN (Vision Globale) voit bien ACC_H partout (la donnée existe)", async () => {
    // Sans ce témoin, des compteurs à 0 prouveraient juste « rien en base ». L'ADMIN
    // voit ACC_H → les 0 de MGR_DUO sont bien le fait du périmètre, pas un seed vide.
    const r = await withWorkspace(sessAdmin, async (tx) => {
      const fiche = await tx.execute(
        sql`select count(*)::int as n from bank_accounts where id = ${ACC_H}`,
      );
      const txns = await tx.execute(
        sql`select count(*)::int as n from transactions_cache where bank_account_id = ${ACC_H}`,
      );
      const soldes = await tx.execute(
        sql`select count(*)::int as n from balance_history where bank_account_id = ${ACC_H}`,
      );
      const splits = await tx.execute(
        sql`select count(*)::int as n from transaction_categorizations where transaction_id = ${TX_H}`,
      );
      const g = (x: unknown) => (x as { rows: { n: number }[] }).rows[0].n;
      return { fiche: g(fiche), txns: g(txns), soldes: g(soldes), splits: g(splits) };
    });
    expect(r).toEqual({ fiche: 1, txns: 1, soldes: 1, splits: 1 });
  });
});
