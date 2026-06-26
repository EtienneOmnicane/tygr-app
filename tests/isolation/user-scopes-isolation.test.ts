/**
 * Suite anti-IDOR — Périmètre party/compte par membre (L2, plan
 * PLAN-architecture-multi-tenant-omnicane.md §5). Prouve sur Postgres réel
 * (PGlite) les garanties STRUCTURELLES de la table `user_scopes` introduite par la
 * migration 0015 :
 *
 *   • isolation TENANT (étage 1) — un workspace ne voit jamais les scopes d'un autre ;
 *   • FK composites scopées workspace — party/compte d'un autre tenant refusés EN BASE ;
 *   • CHECK d'exclusivité — exactement une cible (party XOR compte) ;
 *   • ON DELETE — CASCADE membre (purge des octrois) ; RESTRICT party (archivage) ;
 *   • RLS + FORCE + policy tenant_isolation présentes.
 *
 * PÉRIMÈTRE EXACT DE CE LOT (L2) : tenant + intégrité référentielle + invariants de
 * la table. La policy `account_scope` (étage 2 : GUC app.current_account_scope,
 * Vision restreinte party/compte EFFECTIVE) et le résolveur de périmètre sont le lot
 * L4 — ILS N'EXISTENT PAS encore et NE SONT PAS testés ici. Ce fichier ne prouve donc
 * QUE l'étage 1 et les contraintes structurelles, jamais l'étage 2 de périmètre.
 *
 * Comme les autres suites : DDL = migrations réelles (drizzle/migrations/*.sql),
 * rôle applicatif = drizzle/provisioning/tygr_app.sql, exécution sous `tygr_app`
 * NON-propriétaire (sinon la RLS est ignorée — vérifié au test 0).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { userScopes } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes (lisibilité des assertions) ───────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Deux membres de A (ADMIN + un manager scopé) + un membre de B.
const ADMIN_A = "11111111-1111-4111-8111-111111111111";
const MANAGER_A = "22222222-2222-4222-8222-222222222222";
const BOB_B = "33333333-3333-4333-8333-333333333333";

// Parties — A (deux) et B (témoin cross-tenant).
const PARTY_SUCRE = "9a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_HOLDING = "9b000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARTY_B = "9c000000-cccc-4ccc-8ccc-cccccccccccc"; // WS_B

// Comptes — A (deux) et B (témoin cross-tenant).
const ACC_A1 = "acc0a100-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_A2 = "acc0a200-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC_B = "acc0bbbb-dddd-4ddd-8ddd-dddddddddddd"; // WS_B

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sessA = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessB = { userId: BOB_B, activeWorkspaceId: WS_B };

beforeAll(async () => {
  // 1. Migrations réelles (le DDL que la prod exécutera), appliquées par NOM trié —
  //    0015 trie après 0014, donc user_scopes est créé.
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou structurel : user_scopes DOIT être ENABLE+FORCE RLS et porter
  //    tenant_isolation. Sans FORCE, l'owner (et un GUC absent) verrait tout — la
  //    suite croirait à une isolation prouvée alors qu'elle ne mord pas.
  const rls = await client.query<{ rls: boolean; force: boolean }>(
    `select relrowsecurity as rls, relforcerowsecurity as force
     from pg_class where relname = 'user_scopes'`,
  );
  if (!rls.rows[0]?.rls || !rls.rows[0]?.force) {
    throw new Error(
      `user_scopes doit être ENABLE+FORCE ROW LEVEL SECURITY — trouvé ${JSON.stringify(rls.rows[0])}.`,
    );
  }
  const pol = await client.query<{ policyname: string }>(
    `select policyname from pg_policies where tablename = 'user_scopes'`,
  );
  if (!pol.rows.some((r) => r.policyname === "tenant_isolation")) {
    throw new Error("Policy tenant_isolation absente de user_scopes.");
  }

  // 3. Seed owner (bypass RLS). WS_A : 2 membres, 2 parties, 2 comptes + un octroi
  //    party (MANAGER_A → SUCRE) et un octroi compte (MANAGER_A → ACC_A1).
  //    WS_B : un membre, une party, un compte (témoins cross-tenant), AUCUN octroi.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${MANAGER_A}','mgr@a.mu','Manager A'),
      ('${BOB_B}','b@b.mu','Bob B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MANAGER_A}','${WS_A}','MANAGER'),
      ('${BOB_B}','${WS_B}','MANAGER');
    insert into parties (id, workspace_id, omnifi_party_id, name, is_active) values
      ('${PARTY_SUCRE}','${WS_A}','pid-suc','Société Sucrière',true),
      ('${PARTY_HOLDING}','${WS_A}','pid-hold','Holding',true),
      ('${PARTY_B}','${WS_B}','pid-b','Partie B',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected) values
      ('${ACC_A1}','${WS_A}','${CONN_A}','oa-a1','Compte A1','MUR','5000.00',true),
      ('${ACC_A2}','${WS_A}','${CONN_A}','oa-a2','Compte A2','MUR','8000.00',true),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true);
    -- MANAGER_A est scopé : un octroi PARTY (SUCRE) + un octroi COMPTE (ACC_A1).
    insert into user_scopes (workspace_id, user_id, party_id) values
      ('${WS_A}','${MANAGER_A}','${PARTY_SUCRE}');
    insert into user_scopes (workspace_id, user_id, bank_account_id) values
      ('${WS_A}','${MANAGER_A}','${ACC_A1}');
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

describe("préconditions", () => {
  it("0. requêtes sous tygr_app (sinon RLS ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

describe("étage 1 — TENANT (les scopes d'un autre workspace sont invisibles)", () => {
  it("1. session A ne voit que SES scopes (les deux de MANAGER_A), jamais ceux de B", async () => {
    // (On ajoute un octroi côté B pour prouver qu'il reste invisible depuis A.)
    await withWorkspace(sessB, (tx) =>
      tx.insert(userScopes).values({
        workspaceId: WS_B,
        userId: BOB_B,
        partyId: PARTY_B,
      }),
    );
    const vues = await withWorkspace(sessA, (tx) =>
      tx
        .select({ id: userScopes.id, party: userScopes.partyId, acc: userScopes.bankAccountId })
        .from(userScopes),
    );
    expect(vues).toHaveLength(2); // uniquement les 2 octrois de WS_A
    const parties = vues.map((v) => v.party).filter(Boolean);
    const comptes = vues.map((v) => v.acc).filter(Boolean);
    expect(parties).toEqual([PARTY_SUCRE]);
    expect(comptes).toEqual([ACC_A1]);
  });

  it("2. WHERE forgé visant les scopes de B depuis A → 0 ligne", async () => {
    const r = await withWorkspace(sessA, (tx) =>
      tx.execute(sql`select * from user_scopes where workspace_id = ${WS_B}`),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("3. session B ne voit que SON scope, jamais ceux de A (symétrie)", async () => {
    const vues = await withWorkspace(sessB, (tx) =>
      tx.select({ party: userScopes.partyId }).from(userScopes),
    );
    expect(vues.map((v) => v.party)).toEqual([PARTY_B]);
  });
});

describe("FK composites scopées workspace — cross-tenant impossible EN BASE", () => {
  it("4. octroi PARTY visant une party d'un AUTRE workspace → refus FK composite", async () => {
    // (party_id, workspace_id) → parties : PARTY_B n'existe pas dans (id=PARTY_B, ws=WS_A).
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(userScopes).values({
          workspaceId: WS_A,
          userId: MANAGER_A,
          partyId: PARTY_B, // party de WS_B
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "octroi vers une party cross-tenant doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(
      /foreign key|violates|constraint|policy|row-level/i,
    );
  });

  it("5. octroi COMPTE visant un compte d'un AUTRE workspace → refus FK composite", async () => {
    // (bank_account_id, workspace_id) → bank_accounts : ACC_B n'existe pas dans WS_A.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(userScopes).values({
          workspaceId: WS_A,
          userId: MANAGER_A,
          bankAccountId: ACC_B, // compte de WS_B
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "octroi vers un compte cross-tenant doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(
      /foreign key|violates|constraint|policy|row-level/i,
    );
  });

  it("6. octroi visant un MEMBRE absent du workspace → refus FK composite membre", async () => {
    // (user_id, workspace_id) → workspace_members : BOB_B n'est pas membre de WS_A.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(userScopes).values({
          workspaceId: WS_A,
          userId: BOB_B, // membre de WS_B uniquement
          partyId: PARTY_SUCRE,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "octroi pour un non-membre doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(
      /foreign key|violates|constraint|policy|row-level/i,
    );
  });
});

describe("CHECK exclusivité — exactement une cible (party XOR compte)", () => {
  it("7. insert avec DEUX cibles (party ET compte) → refus CHECK", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(userScopes).values({
          workspaceId: WS_A,
          userId: MANAGER_A,
          partyId: PARTY_HOLDING,
          bankAccountId: ACC_A2,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "deux cibles doivent être rejetées").not.toBeNull();
    expect(flatten(thrown)).toMatch(/check|violates|constraint/i);
  });

  it("8. insert avec ZÉRO cible (ni party ni compte) → refus CHECK", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(userScopes).values({
          workspaceId: WS_A,
          userId: MANAGER_A,
          // partyId et bankAccountId laissés NULL
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "zéro cible doit être rejetée").not.toBeNull();
    expect(flatten(thrown)).toMatch(/check|violates|constraint/i);
  });

  it("9. insert avec UNE seule cible → accepté (contre-preuve, pas de faux positif)", async () => {
    // Octroi party valide pour MANAGER_A (PARTY_HOLDING, intra-tenant) puis nettoyage.
    await withWorkspace(sessA, (tx) =>
      tx.insert(userScopes).values({
        workspaceId: WS_A,
        userId: MANAGER_A,
        partyId: PARTY_HOLDING,
      }),
    );
    const vues = await withWorkspace(sessA, (tx) =>
      tx
        .select({ id: userScopes.id })
        .from(userScopes)
        .where(
          and(
            eq(userScopes.userId, MANAGER_A),
            eq(userScopes.partyId, PARTY_HOLDING),
          ),
        ),
    );
    expect(vues).toHaveLength(1);
    // Remise en état (indépendance des tests suivants).
    await withWorkspace(sessA, (tx) =>
      tx
        .delete(userScopes)
        .where(
          and(
            eq(userScopes.userId, MANAGER_A),
            eq(userScopes.partyId, PARTY_HOLDING),
          ),
        ),
    );
  });
});

describe("idempotence — UNIQUE partiels (pas deux fois le même grant)", () => {
  it("10. ré-octroyer la MÊME party au même membre → refus UNIQUE partiel", async () => {
    // user_scopes_user_party_unique (workspace_id, user_id, party_id) WHERE party IS NOT NULL.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(userScopes).values({
          workspaceId: WS_A,
          userId: MANAGER_A,
          partyId: PARTY_SUCRE, // déjà octroyée au seed
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "doublon d'octroi party doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(/unique|duplicate|violates|constraint/i);
  });
});

describe("ON DELETE — CASCADE membre vs RESTRICT party", () => {
  it("11. retirer un MEMBRE du workspace purge ses user_scopes (CASCADE)", async () => {
    // user_scopes_member_fk (user_id, workspace_id) → workspace_members ON DELETE CASCADE.
    // On crée un membre jetable + un octroi, on retire le membre, on vérifie la purge.
    const TMP_USER = "44444444-4444-4444-8444-444444444444";
    await client.exec(`
      insert into users (id, email, full_name) values
        ('${TMP_USER}','tmp@a.mu','Temp A');
    `); // (owner — création d'utilisateur global hors RLS)
    await withWorkspace(sessA, (tx) =>
      tx
        .insert(schema.workspaceMembers)
        .values({ userId: TMP_USER, workspaceId: WS_A, role: "VIEWER" }),
    );
    await withWorkspace(sessA, (tx) =>
      tx.insert(userScopes).values({
        workspaceId: WS_A,
        userId: TMP_USER,
        partyId: PARTY_HOLDING,
      }),
    );

    // Retrait du membre (workspace_members a DELETE en liste blanche).
    await withWorkspace(sessA, (tx) =>
      tx
        .delete(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.userId, TMP_USER),
            eq(schema.workspaceMembers.workspaceId, WS_A),
          ),
        ),
    );

    // Ses octrois ont été purgés par la cascade.
    const restant = await withWorkspace(sessA, (tx) =>
      tx
        .select({ id: userScopes.id })
        .from(userScopes)
        .where(eq(userScopes.userId, TMP_USER)),
    );
    expect(restant).toHaveLength(0);
  });

  it("12. hard-delete d'une PARTY encore référencée par un octroi → refus RESTRICT", async () => {
    // user_scopes_party_fk (party_id, workspace_id) → parties ON DELETE RESTRICT :
    // PARTY_SUCRE est référencée par l'octroi de MANAGER_A → le DELETE échoue
    // (l'app archive is_active=false, jamais d'effacement physique tant que référencée).
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.delete(schema.parties).where(eq(schema.parties.id, PARTY_SUCRE)),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "DELETE d'une party référencée doit être refusé").not.toBeNull();
    expect(flatten(thrown)).toMatch(/foreign key|violates|constraint|restrict/i);
  });
});
