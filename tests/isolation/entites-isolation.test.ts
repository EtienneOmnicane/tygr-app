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
 * ⚠️ NB SCOPE-PAR-JOINTURE (dette ENTITY-READ-JOIN1, P1 — LEVÉE) : la policy
 * entity_scope vit sur bank_accounts. Les transactions/soldes n'héritent du périmètre
 * QUE via une JOINTURE sur bank_accounts. Les repos de lecture du dashboard joignent
 * désormais bank_accounts (cf. dashboard.ts) — prouvé sur les VRAIES fonctions par le
 * bloc « étage 2 hérité par jointure » ci-dessous. Une lecture SQL DIRECTE de
 * transactions_cache (sans jointure) reste non filtrée par entité : ce n'est pas une
 * faille cross-tenant (tenant_isolation couvre transactions_cache), mais l'étage 2 ne
 * mord que par la jointure — d'où la garde au niveau repository (jamais de lecture
 * directe de ces tables filles sans joindre bank_accounts). L'ÉCRITURE est elle aussi
 * bornée depuis 0009 (ENTITY-WRITE-SCOPE1 — policy FOR ALL, USING + WITH CHECK) : voir le
 * bloc « écriture bornée par scope » (tests 14/14b/14c). Les DEUX P1 du GATE sont levées.
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
// ENTITY-READ-JOIN1 : on prouve la levée au niveau des VRAIS repos de lecture
// (la jointure bank_accounts y fait hériter la policy entity_scope), pas sur une
// requête SQL brute — c'est le périmètre exact de la dette.
import {
  courbeTresorerie,
  syntheseMois,
  transactionsRecentes,
} from "@/server/repositories/dashboard";

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

  // 2. Garde-fou : la policy entity_scope DOIT exister, être RESTRICTIVE et porter
  //    SES DEUX expressions (USING + WITH CHECK). Depuis 0009 (ENTITY-WRITE-SCOPE1),
  //    elle est FOR ALL : USING borne la lecture/ciblage, WITH CHECK borne l'écriture.
  //    Une policy absente / PERMISSIVE / FOR SELECT / sans WITH CHECK ferait croire à
  //    une isolation prouvée alors que l'étage 2 (écriture) serait inopérant (faux vert).
  const pol = await client.query<{
    policyname: string;
    permissive: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `select policyname, permissive, cmd, qual, with_check
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
  if (entityScope.cmd !== "ALL" || entityScope.qual == null || entityScope.with_check == null) {
    throw new Error(
      `Policy entity_scope doit être FOR ALL avec USING ET WITH CHECK (0009, ` +
        `ENTITY-WRITE-SCOPE1) — trouvé cmd=${entityScope.cmd}, ` +
        `qual=${entityScope.qual}, with_check=${entityScope.with_check}.`,
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
    -- Soldes EOD : un point par compte (même jour) pour prouver l'héritage du scope
    -- par la courbe de trésorerie (courbeTresorerie joint bank_accounts).
    insert into balance_history (workspace_id, bank_account_id, balance_date, balance, currency) values
      ('${WS_A}','${ACC_SUCRE}','2026-06-05','5000.00','MUR'),
      ('${WS_A}','${ACC_ENERGIE}','2026-06-05','8000.00','MUR'),
      ('${WS_A}','${ACC_NONE}','2026-06-05','1000.00','MUR');
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

/**
 * ENTITY-READ-JOIN1 LEVÉE — les repos de LECTURE du dashboard joignent désormais
 * bank_accounts, donc la policy entity_scope (étage 2) MORD par héritage sur les
 * transactions/soldes. On le prouve sur les VRAIES fonctions du repository
 * (transactionsRecentes / syntheseMois / courbeTresorerie), pas sur une requête SQL
 * brute : c'est le périmètre exact de la dette (« brancher les repos sur la jointure »).
 *
 * Ces tests REMPLACENT les anciens « fuites latentes 13/13b » qui asservissaient le
 * comportement de fuite : ils sont l'inversion attendue (la dette est close). NB : une
 * lecture SQL DIRECTE de transactions_cache (sans jointure) resterait non filtrée par
 * entité — c'est pourquoi la garde vit dans le repository (CLAUDE.md : ne jamais lire
 * ces tables filles sans joindre bank_accounts). L'étage 1 (tenant) reste prouvé plus
 * haut, inchangé.
 */
describe("étage 2 hérité par jointure — repos de lecture (ENTITY-READ-JOIN1 levée)", () => {
  it("13. transactionsRecentes : Vision Entité Sucrière ne voit QUE Sucrière ; Globale voit tout", async () => {
    const scoped = await withWorkspace(sessScoped, (tx) =>
      transactionsRecentes(tx),
    );
    const idsScoped = scoped.map((t) => t.omnifiTxnId);
    expect(idsScoped).toEqual(["tx-suc"]); // Énergie + non assigné masqués par héritage
    expect(idsScoped).not.toContain("tx-ene");
    expect(idsScoped).not.toContain("tx-none");

    // Contre-preuve anti-régression : Vision Globale (GUC vide) voit les 3.
    const globale = await withWorkspace(sessGlobale, (tx) =>
      transactionsRecentes(tx),
    );
    expect(globale.map((t) => t.omnifiTxnId).sort()).toEqual([
      "tx-ene",
      "tx-none",
      "tx-suc",
    ]);
  });

  it("13b. syntheseMois : la synthèse Vision Entité ne somme que le périmètre", async () => {
    // Seul tx-suc (Crédit 100) est dans le scope Sucrière → entrées = 100.
    const scoped = await withWorkspace(sessScoped, (tx) =>
      syntheseMois(tx, "2026-06"),
    );
    expect(scoped.entrees).toBe("100.00");

    // Vision Globale : 100 + 200 + 300 = 600 (les 3 comptes).
    const globale = await withWorkspace(sessGlobale, (tx) =>
      syntheseMois(tx, "2026-06"),
    );
    expect(globale.entrees).toBe("600.00");
  });

  it("13c. courbeTresorerie : le solde EOD consolidé Vision Entité exclut les autres entités", async () => {
    const fenetre = { from: "2026-06-01", to: "2026-06-30" };

    // Sucrière seule : 5000 au 05/06.
    const scoped = await withWorkspace(sessScoped, (tx) =>
      courbeTresorerie(tx, fenetre),
    );
    expect(scoped).toHaveLength(1);
    expect(scoped[0].date).toBe("2026-06-05");
    // sum(...)::text conserve l'échelle numeric de la colonne (2 décimales).
    expect(scoped[0].soldeConsolide).toBe("5000.00");

    // Vision Globale : 5000 + 8000 + 1000 = 14000 au même jour.
    const globale = await withWorkspace(sessGlobale, (tx) =>
      courbeTresorerie(tx, fenetre),
    );
    expect(globale).toHaveLength(1);
    expect(globale[0].soldeConsolide).toBe("14000.00");
  });
});

/**
 * ENTITY-WRITE-SCOPE1 LEVÉE (migration 0009) — la policy entity_scope passe de
 * FOR SELECT à FOR ALL (USING + WITH CHECK). L'écriture sur bank_accounts est désormais
 * bornée au périmètre entité : un membre scopé ne peut ni muter/supprimer un compte hors
 * scope (USING), ni créer/déplacer un compte hors scope (WITH CHECK). Ces tests
 * REMPLACENT les anciens « fuites latentes 14/14b » qui asservissaient le trou d'écriture
 * (UPDATE sans WHERE mutant Énergie) : ils sont l'inversion attendue (la dette est close).
 * En Vision Globale (GUC vide) la RESTRICTIVE laisse tout passer → l'ingestion et le sas
 * ADMIN ne régressent pas (prouvé en 14c). La garde de RÔLE (assignation ADMIN-only) reste
 * applicative — la RLS borne le périmètre, pas le rôle.
 */
describe("étage 2 — écriture bornée par scope (ENTITY-WRITE-SCOPE1 levée, policy FOR ALL)", () => {
  it("14. un VIEWER scopé Sucrière : UPDATE sans WHERE ne mute QUE Sucrière (USING borne le ciblage)", async () => {
    // Le même UPDATE qui FUITAIT avant 0009 (mutait Énergie + non assigné) ne touche
    // plus que les lignes visibles au scope (USING) → Sucrière uniquement.
    await withWorkspace(sessScoped, (tx) =>
      tx.update(bankAccounts).set({ accountName: "MUTÉ_IN_SCOPE" }),
    );
    // Vérif sous l'owner (voit tout) : Sucrière muté, Énergie + non assigné INTACTS.
    await client.exec(`reset role;`);
    const apres = await client.query<{ id: string; account_name: string }>(
      `select id, account_name from bank_accounts where workspace_id = '${WS_A}' order by id`,
    );
    await client.exec(`set role tygr_app;`);
    const parId = Object.fromEntries(
      apres.rows.map((r) => [r.id, r.account_name]),
    );
    expect(parId[ACC_SUCRE]).toBe("MUTÉ_IN_SCOPE"); // in-scope : muté
    expect(parId[ACC_ENERGIE]).toBe("Compte Énergie"); // hors scope : INTACT
    expect(parId[ACC_NONE]).toBe("Compte Non Assigné"); // non assigné : INTACT

    // Remise en état (owner) pour l'indépendance des tests.
    await client.exec(`reset role;`);
    await client.exec(
      `update bank_accounts set account_name = 'Compte Sucrière' where id = '${ACC_SUCRE}';`,
    );
    await client.exec(`set role tygr_app;`);
  });

  it("14b. un VIEWER scopé ne peut PAS déplacer son compte hors scope (WITH CHECK lève 42501)", async () => {
    // Tentative de réassigner ACC_SUCRE (in-scope, donc CIBLABLE par le USING) vers
    // Énergie (hors scope). L'état RÉSULTANT (entity_id = Énergie) viole le WITH CHECK.
    // ⚠️ Sémantique PostgreSQL : une violation de WITH CHECK LÈVE (ERRCODE 42501),
    // contrairement à un USING non satisfait (0 ligne silencieuse). On attend donc une
    // exception — pas un RETURNING vide.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessScoped, (tx) =>
        tx
          .update(bankAccounts)
          .set({ entityId: ENT_ENERGIE })
          .where(eq(bankAccounts.id, ACC_SUCRE)),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "le déplacement hors scope doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(/policy|row-level|violates|check/i);

    // Sous l'owner : ACC_SUCRE est TOUJOURS rattaché à Sucrière (non déplacé).
    await client.exec(`reset role;`);
    const v = await client.query<{ entity_id: string }>(
      `select entity_id from bank_accounts where id = '${ACC_SUCRE}'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(v.rows[0].entity_id).toBe(ENT_SUCRE);
  });

  it("14c. NON-RÉGRESSION Vision Globale : INSERT entity_id NULL (ingestion) OK ; SCOPÉ refusé", async () => {
    // Ingestion (Vision Globale, GUC vide) : un compte neuf naît entity_id=NULL → le
    // WITH CHECK (branche « GUC vide » = TRUE) laisse passer. C'est le chemin upsertCompte.
    const NOUV = "acc0face-eeee-4eee-8eee-eeeeeeeeeeee";
    await withWorkspace(sessGlobale, (tx) =>
      tx.insert(bankAccounts).values({
        id: NOUV,
        workspaceId: WS_A,
        connectionId: CONN_A,
        omnifiAccountId: "oa-nouv",
        accountName: "Compte Frais",
        currency: "MUR",
        currentBalance: "0.00",
        isSelected: true,
        // entityId omis → NULL (non assigné), comme à l'ingestion réelle.
      }),
    );
    await client.exec(`reset role;`);
    const cree = await client.query<{ n: number }>(
      `select count(*)::int as n from bank_accounts where id = '${NOUV}'`,
    );
    expect(cree.rows[0].n).toBe(1); // créé en Vision Globale
    // Nettoyage (owner — bank_accounts a le DELETE en liste blanche, mais on est owner).
    await client.exec(`delete from bank_accounts where id = '${NOUV}';`);
    await client.exec(`set role tygr_app;`);

    // Fail-closed : le MÊME INSERT entity_id=NULL sous Vision Entité (SCOPED) est REFUSÉ
    // (WITH CHECK : NULL n'est dans aucun scope). Un membre borné ne crée pas de comptes
    // non-assignés. La FK + tenant_isolation sont satisfaites ; c'est bien entity_scope
    // qui rejette → on cible le message RLS/policy.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessScoped, (tx) =>
        tx.insert(bankAccounts).values({
          id: "acc0dead-ffff-4fff-8fff-ffffffffffff",
          workspaceId: WS_A,
          connectionId: CONN_A,
          omnifiAccountId: "oa-dead",
          accountName: "Ne doit pas naître",
          currency: "MUR",
          currentBalance: "0.00",
          isSelected: true,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "INSERT NULL sous Vision Entité doit être refusé").not.toBeNull();
    expect(flatten(thrown)).toMatch(/policy|row-level|violates|check/i);
  });
});
