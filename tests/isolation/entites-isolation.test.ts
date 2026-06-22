/**
 * Suite anti-IDOR — Entités multi-tenant (Option B, plan PLAN-entites-multi-tenant.md
 * §6.3). Prouve sur Postgres réel (PGlite) les DEUX étages d'isolation introduits
 * par la migration 0008 + le 3ᵉ GUC de withWorkspace :
 *
 *   Étage 1 (TENANT, dur)  — inchangé : une entité / un scope / un compte d'un
 *                            autre workspace est invisible et non-forgeable.
 *   Étage 2 (ENTITÉ, scopé) — policy RESTRICTIVE `entity_scope` sur bank_accounts,
 *                            pilotée par app.current_entity_scope posé DEPUIS
 *                            member_entity_scopes (jamais un paramètre client).
 *
 * Comme les autres suites : DDL = migrations réelles (drizzle/migrations/*.sql),
 * rôle applicatif = drizzle/provisioning/tygr_app.sql, exécution sous `tygr_app`
 * NON-propriétaire (sinon la RLS est ignorée — vérifié au test 0).
 *
 * ⚠️ NB SCOPE-PAR-JOINTURE (dette ENTITY-READ-JOIN1, P1) : la policy entity_scope
 * vit sur bank_accounts. Les transactions/soldes n'héritent du périmètre QUE via
 * une JOINTURE sur bank_accounts. Les tests « transactions » ci-dessous joignent
 * donc explicitement bank_accounts — c'est le chemin correct, celui que les repos
 * de lecture devront tous adopter (cf. ENTITY-READ-JOIN1). Une lecture directe de
 * transactions_cache (sans jointure) n'est PAS filtrée par entité : ce n'est pas
 * une faille cross-tenant (tenant_isolation couvre transactions_cache), mais
 * l'étage 2 ne mord que par la jointure — d'où la dette bloquante avant prod.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { bankAccounts, entities, memberEntityScopes } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes (lisibilité des assertions) ───────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Membres de WS_A : GLOBALE (sans scope) et SCOPED (Vision Entité = Sucrière).
const GLOBALE = "11111111-1111-4111-8111-111111111111"; // ADMIN, aucun scope
const SCOPED = "22222222-2222-4222-8222-222222222222"; // VIEWER, scopé Sucrière
const BOB_B = "33333333-3333-4333-8333-333333333333"; // membre de WS_B (témoin)

// Entités de WS_A.
const ENT_SUCRE = "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // Sucrière
const ENT_ENERGIE = "e0e00000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // Énergie
const ENT_B = "b0b00000-cccc-4ccc-8ccc-cccccccccccc"; // entité de WS_B (témoin)

// Comptes de WS_A : un par entité + un NON assigné (entity_id NULL).
const ACC_SUCRE = "acc05000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // → Sucrière
const ACC_ENERGIE = "acc0e000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // → Énergie
const ACC_NONE = "acc00000-cccc-4ccc-8ccc-cccccccccccc"; // entity_id NULL
const ACC_B = "acc0bbbb-dddd-4ddd-8ddd-dddddddddddd"; // WS_B (témoin étage 1)

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sessGlobale = { userId: GLOBALE, activeWorkspaceId: WS_A };
const sessScoped = { userId: SCOPED, activeWorkspaceId: WS_A };

beforeAll(async () => {
  // 1. Migrations réelles (le DDL que la prod exécutera).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou : la policy entity_scope DOIT exister, être RESTRICTIVE et
  //    porter son expression. Une policy absente/PERMISSIVE ferait croire à une
  //    isolation prouvée alors que l'étage 2 serait inopérant (faux vert).
  const pol = await client.query<{
    policyname: string;
    permissive: string;
    cmd: string;
    qual: string | null;
  }>(
    `select policyname, permissive, cmd, qual
     from pg_policies where tablename = 'bank_accounts'`,
  );
  const entityScope = pol.rows.find((r) => r.policyname === "entity_scope");
  if (!entityScope) {
    throw new Error(
      `Policy entity_scope absente de bank_accounts — l'étage 2 n'existe pas. ` +
        `État : ${JSON.stringify(pol.rows)}`,
    );
  }
  if (entityScope.permissive !== "RESTRICTIVE") {
    throw new Error(
      `Policy entity_scope doit être RESTRICTIVE (sinon OR avec tenant_isolation ` +
        `→ filtre inopérant), trouvée : ${entityScope.permissive}.`,
    );
  }
  if (entityScope.cmd !== "SELECT" || entityScope.qual == null) {
    throw new Error(
      `Policy entity_scope doit être FOR SELECT avec expression USING — ` +
        `trouvé cmd=${entityScope.cmd}, qual=${entityScope.qual}.`,
    );
  }

  // 3. Seed owner (bypass RLS). WS_A = deux entités + un compte non assigné ;
  //    WS_B = témoin de l'étage 1.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${GLOBALE}','g@a.mu','Globale Admin'),
      ('${SCOPED}','s@a.mu','Scoped Viewer'),
      ('${BOB_B}','b@b.mu','Bob B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${GLOBALE}','${WS_A}','ADMIN'),
      ('${SCOPED}','${WS_A}','VIEWER'),
      ('${BOB_B}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière','SUC',true),
      ('${ENT_ENERGIE}','${WS_A}','Énergie','ENE',true),
      ('${ENT_B}','${WS_B}','Entité B','XB',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${GLOBALE}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_SUCRE}','${WS_A}','${CONN_A}','oa-suc','Compte Sucrière','MUR','5000.00',true,'${ENT_SUCRE}'),
      ('${ACC_ENERGIE}','${WS_A}','${CONN_A}','oa-ene','Compte Énergie','MUR','8000.00',true,'${ENT_ENERGIE}'),
      ('${ACC_NONE}','${WS_A}','${CONN_A}','oa-none','Compte Non Assigné','MUR','1000.00',true,null),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true,'${ENT_B}');
    -- Transactions : une par compte (pour prouver l'héritage par jointure).
    insert into transactions_cache (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, clean_label, is_removed) values
      ('${WS_A}','${ACC_SUCRE}','tx-suc','2026-06-05','2026-06-05T05:30:00Z','100.00','MUR','Credit','SUCRE','Sucre',false),
      ('${WS_A}','${ACC_ENERGIE}','tx-ene','2026-06-05','2026-06-05T05:30:00Z','200.00','MUR','Credit','ENERGIE','Energie',false),
      ('${WS_A}','${ACC_NONE}','tx-none','2026-06-05','2026-06-05T05:30:00Z','300.00','MUR','Credit','NONE','None',false);
    -- Vision Entité : SCOPED ne couvre QUE Sucrière. GLOBALE n'a AUCUNE ligne.
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${SCOPED}','${ENT_SUCRE}');
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

// Déplie la chaîne des causes (Drizzle enveloppe les erreurs driver RLS/FK).
const flatten = (e: unknown): string => {
  let msg = "";
  let cur: unknown = e;
  while (cur instanceof Error) {
    msg += cur.message + " | ";
    cur = cur.cause;
  }
  return msg;
};

describe("préconditions", () => {
  it("0. requêtes sous tygr_app (sinon RLS ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

describe("étage 1 — TENANT (entités & scopes d'un autre workspace invisibles/non-forgeables)", () => {
  it("1. session A ne voit que SES entités, jamais celle de B", async () => {
    const vues = await withWorkspace(sessGlobale, (tx) =>
      tx.select({ id: entities.id, name: entities.name }).from(entities),
    );
    const ids = vues.map((e) => e.id);
    expect(ids).toContain(ENT_SUCRE);
    expect(ids).toContain(ENT_ENERGIE);
    expect(ids).not.toContain(ENT_B); // entité de WS_B
  });

  it("2. WHERE forgé visant l'entité de B depuis A → 0 ligne", async () => {
    const r = await withWorkspace(sessGlobale, (tx) =>
      tx.execute(sql`select * from entities where id = ${ENT_B}`),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("3. assigner un compte à une entité d'un AUTRE workspace → refus FK composite", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessGlobale, (tx) =>
        tx
          .update(bankAccounts)
          .set({ entityId: ENT_B }) // entité de WS_B
          .where(eq(bankAccounts.id, ACC_SUCRE)),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "l'UPDATE cross-tenant doit être rejeté").not.toBeNull();
    // FK composite (entity_id, workspace_id) → entities : l'entité de B n'existe
    // pas dans (id=ENT_B, workspace_id=WS_A) → violation de clé étrangère.
    expect(flatten(thrown)).toMatch(/foreign key|violates|constraint/i);
  });

  it("4. INSERT member_entity_scopes avec une entité de B depuis A → refus FK composite", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessGlobale, (tx) =>
        tx.insert(memberEntityScopes).values({
          workspaceId: WS_A,
          userId: GLOBALE,
          entityId: ENT_B, // entité de WS_B
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "le scope cross-tenant doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(
      /foreign key|violates|constraint|policy|row-level/i,
    );
  });
});

describe("étage 2 — ENTITÉ (policy entity_scope via le 3ᵉ GUC, posé depuis member_entity_scopes)", () => {
  it("5. le contexte expose le bon scope : GLOBALE sans scope, SCOPED borné Sucrière", async () => {
    const g = await withWorkspace(
      sessGlobale,
      async (_tx, ctx) => ctx.entityScope,
    );
    expect(g).toEqual({ mode: "GLOBALE" });

    const s = await withWorkspace(
      sessScoped,
      async (_tx, ctx) => ctx.entityScope,
    );
    expect(s).toEqual({ mode: "ENTITES", entityIds: [ENT_SUCRE] });
  });

  it("6. Vision Globale voit TOUS les comptes du tenant (Sucrière + Énergie + non assigné)", async () => {
    const comptes = await withWorkspace(sessGlobale, (tx) =>
      tx.select({ id: bankAccounts.id }).from(bankAccounts),
    );
    const ids = comptes.map((c) => c.id);
    expect(ids).toContain(ACC_SUCRE);
    expect(ids).toContain(ACC_ENERGIE);
    expect(ids).toContain(ACC_NONE); // le non-assigné est visible en Globale
    expect(ids).toHaveLength(3);
  });

  it("7. Vision Entité (Sucrière) ne voit QUE le compte Sucrière — Énergie masqué", async () => {
    const comptes = await withWorkspace(sessScoped, (tx) =>
      tx.select({ id: bankAccounts.id }).from(bankAccounts),
    );
    const ids = comptes.map((c) => c.id);
    expect(ids).toEqual([ACC_SUCRE]); // exactement un, le sien
    expect(ids).not.toContain(ACC_ENERGIE); // étage 2 : Énergie masqué
    expect(ids).not.toContain(ACC_NONE); // compte non assigné masqué
  });

  it("8. compte entity_id NULL : invisible en Vision Entité, visible en Vision Globale", async () => {
    const enScoped = await withWorkspace(sessScoped, (tx) =>
      tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, ACC_NONE)),
    );
    expect(enScoped).toHaveLength(0); // masqué (fail-closed)

    const enGlobale = await withWorkspace(sessGlobale, (tx) =>
      tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, ACC_NONE)),
    );
    expect(enGlobale).toHaveLength(1); // l'ADMIN le voit (sas d'assignation)
  });

  it("9. transactions héritent du scope PAR JOINTURE sur bank_accounts (Énergie masqué pour Sucrière)", async () => {
    // Chemin correct (cf. ENTITY-READ-JOIN1) : joindre bank_accounts porte la
    // policy entity_scope sur la lecture des transactions.
    const txScoped = await withWorkspace(sessScoped, (tx) =>
      tx.execute(sql`
        select t.omnifi_txn_id as id
        from transactions_cache t
        join bank_accounts a on a.id = t.bank_account_id
        order by t.omnifi_txn_id
      `),
    );
    const ids = (txScoped.rows as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["tx-suc"]); // seules les transactions Sucrière
    expect(ids).not.toContain("tx-ene"); // Énergie masqué par la jointure
    expect(ids).not.toContain("tx-none"); // compte non assigné masqué

    // Contre-preuve : en Vision Globale, la même jointure voit tout.
    const txGlobale = await withWorkspace(sessGlobale, (tx) =>
      tx.execute(sql`
        select t.omnifi_txn_id as id
        from transactions_cache t
        join bank_accounts a on a.id = t.bank_account_id
      `),
    );
    expect((txGlobale.rows as { id: string }[]).length).toBe(3);
  });
});

describe("anti-élargissement — le scope ne vient QUE de member_entity_scopes (jamais d'un paramètre)", () => {
  it("10. la frontière d'API interdit d'injecter un scope : session = 2 champs stricts", async () => {
    // L'anti-élargissement est STRUCTUREL : withWorkspace(session, fn) ne prend
    // que `session` comme entrée client, et workspaceSessionSchema est .strict()
    // à exactement deux champs (userId, activeWorkspaceId). Il n'existe AUCUN
    // canal par lequel un appelant pourrait passer un entityScope/entity_id : le
    // scope est calculé en interne depuis member_entity_scopes. On le prouve en
    // tentant de glisser un champ supplémentaire (un scope forgé) dans la
    // session → le schéma strict le REJETTE avant toute requête SQL.
    await expect(
      withWorkspace(
        {
          userId: SCOPED,
          activeWorkspaceId: WS_A,
          // Champ pirate : une tentative d'imposer son propre périmètre.
          entityScope: [ENT_ENERGIE],
        } as unknown as { userId: string; activeWorkspaceId: string },
        async () => "ne doit jamais s'exécuter",
      ),
    ).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });

  it("11. withWorkspace NE pose JAMAIS un scope absent de member_entity_scopes (preuve serveur)", async () => {
    // LE test qui compte : par le chemin légitime (withWorkspace), SCOPED reçoit
    // EXACTEMENT son périmètre (Sucrière), jamais Énergie — quelle que soit la
    // requête. C'est la garantie d'anti-élargissement : le GUC est dérivé de la
    // base (member_entity_scopes), pas d'un paramètre.
    const ctxScope = await withWorkspace(
      sessScoped,
      async (_tx, ctx) => ctx.entityScope,
    );
    expect(ctxScope).toEqual({ mode: "ENTITES", entityIds: [ENT_SUCRE] });
    expect(
      ctxScope.mode === "ENTITES" && ctxScope.entityIds.includes(ENT_ENERGIE),
    ).toBe(false);

    // Et la lecture effective reste bornée à Sucrière (pas de fuite Énergie).
    const comptes = await withWorkspace(sessScoped, (tx) =>
      tx.select({ id: bankAccounts.id }).from(bankAccounts),
    );
    expect(comptes.map((c) => c.id)).toEqual([ACC_SUCRE]);
  });
});

describe("contre-preuve — pas de faux positif (le mécanisme n'est pas cassé au point de tout masquer)", () => {
  it("12. un membre du workspace courant assigne normalement dans son périmètre", async () => {
    // GLOBALE (ADMIN, Vision Globale) réassigne le compte non assigné à Énergie :
    // opération légitime, autorisée (écriture gouvernée par tenant_isolation).
    await withWorkspace(sessGlobale, (tx) =>
      tx
        .update(bankAccounts)
        .set({ entityId: ENT_ENERGIE })
        .where(eq(bankAccounts.id, ACC_NONE)),
    );
    const apres = await withWorkspace(sessGlobale, (tx) =>
      tx
        .select({ entityId: bankAccounts.entityId })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, ACC_NONE)),
    );
    expect(apres[0].entityId).toBe(ENT_ENERGIE);

    // Remise en état pour l'indépendance des tests (entity_id NULL = non assigné).
    await withWorkspace(sessGlobale, (tx) =>
      tx
        .update(bankAccounts)
        .set({ entityId: null })
        .where(eq(bankAccounts.id, ACC_NONE)),
    );
  });
});
