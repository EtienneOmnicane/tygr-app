/**
 * Suite anti-IDOR — Couche Parties (L0 + L1, plan
 * PLAN-architecture-multi-tenant-omnicane.md §5.1). Prouve sur Postgres réel
 * (PGlite) l'isolation TENANT (étage 1) des deux nouvelles tables introduites par
 * la migration 0013, et les garanties structurelles des FK composites scopées :
 *
 *   • parties (entité légale Omni-FI PartyId) — RLS tenant + FORCE.
 *   • account_party_role (détention compte↔party, N-N) — RLS tenant + FORCE.
 *   • bank_accounts UNIQUE(id, workspace_id) [L0] — cible des FK composites.
 *
 * PÉRIMÈTRE EXACT DE CE LOT (L0+L1) : tenant + intégrité référentielle scopée.
 * Le périmètre par PARTY/COMPTE d'un utilisateur (policy `account_scope`, GUC
 * app.current_account_scope, Vision restreinte party/compte) est le lot L4 — il
 * N'EST PAS testé ici (aucune policy account_scope n'existe encore ; la créer est
 * L4, sous cross-review sécu contradictoire). Ce fichier ne prouve donc QUE
 * l'étage 1 et les FK — pas l'étage 2 de périmètre.
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
import {
  accountPartyRole,
  bankAccounts,
  parties,
} from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes (lisibilité des assertions) ───────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111";
const BOB_B = "33333333-3333-4333-8333-333333333333";

// Entités (BU) — A et B (témoin étage 1 pour le rattachement party→BU).
const ENT_A = "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENT_B = "b0b00000-cccc-4ccc-8ccc-cccccccccccc";

// Parties — A (deux) et B (témoin).
const PARTY_SUCRE = "9a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_HOLDING = "9b000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARTY_B = "9c000000-cccc-4ccc-8ccc-cccccccccccc"; // WS_B

// Comptes — A (deux) et B (témoin).
const ACC_A1 = "acc0a100-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_A2 = "acc0a200-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC_B = "acc0bbbb-dddd-4ddd-8ddd-dddddddddddd"; // WS_B

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sessA = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessB = { userId: BOB_B, activeWorkspaceId: WS_B };

beforeAll(async () => {
  // 1. Migrations réelles (le DDL que la prod exécutera).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou structurel : les deux nouvelles tables DOIVENT être sous RLS
  //    FORCÉE et porter tenant_isolation. Une table sans RLS/FORCE ferait croire à
  //    une isolation prouvée alors que l'owner (et un GUC absent) verrait tout.
  const rls = await client.query<{
    relname: string;
    rls: boolean;
    force: boolean;
  }>(
    `select relname, relrowsecurity as rls, relforcerowsecurity as force
     from pg_class where relname in ('parties','account_party_role')`,
  );
  for (const t of ["parties", "account_party_role"]) {
    const row = rls.rows.find((r) => r.relname === t);
    if (!row || !row.rls || !row.force) {
      throw new Error(
        `Table ${t} doit être ENABLE+FORCE ROW LEVEL SECURITY — trouvé ${JSON.stringify(row)}.`,
      );
    }
  }
  const pol = await client.query<{ tablename: string; policyname: string }>(
    `select tablename, policyname from pg_policies
     where tablename in ('parties','account_party_role')`,
  );
  for (const t of ["parties", "account_party_role"]) {
    if (!pol.rows.some((r) => r.tablename === t && r.policyname === "tenant_isolation")) {
      throw new Error(`Policy tenant_isolation absente de ${t}.`);
    }
  }

  // 3. Seed owner (bypass RLS). WS_A = deux parties + deux comptes ; WS_B = témoin.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','a@a.mu','Admin A'),
      ('${BOB_B}','b@b.mu','Bob B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${BOB_B}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_A}','${WS_A}','BU A','BUA',true),
      ('${ENT_B}','${WS_B}','BU B','BUB',true);
    -- Parties : SUCRE rattachée à la BU A ; HOLDING non rattachée (entity_id NULL).
    insert into parties (id, workspace_id, entity_id, omnifi_party_id, name, is_active) values
      ('${PARTY_SUCRE}','${WS_A}','${ENT_A}','pid-suc','Société Sucrière',true),
      ('${PARTY_HOLDING}','${WS_A}',null,'pid-hold','Holding',true),
      ('${PARTY_B}','${WS_B}',null,'pid-b','Partie B',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected) values
      ('${ACC_A1}','${WS_A}','${CONN_A}','oa-a1','Compte A1','MUR','5000.00',true),
      ('${ACC_A2}','${WS_A}','${CONN_A}','oa-a2','Compte A2','MUR','8000.00',true),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true);
    -- Détention : ACC_A1 détenu par SUCRE (rôle principal) ; ACC_A2 par HOLDING.
    insert into account_party_role (workspace_id, bank_account_id, party_id, ownership_type, is_primary) values
      ('${WS_A}','${ACC_A1}','${PARTY_SUCRE}','BUSINESS',true),
      ('${WS_A}','${ACC_A2}','${PARTY_HOLDING}','BUSINESS',true);
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

describe("étage 1 — TENANT (parties & rôles d'un autre workspace invisibles/non-forgeables)", () => {
  it("1. session A ne voit que SES parties, jamais celle de B", async () => {
    const vues = await withWorkspace(sessA, (tx) =>
      tx.select({ id: parties.id, name: parties.name }).from(parties),
    );
    const ids = vues.map((p) => p.id);
    expect(ids).toContain(PARTY_SUCRE);
    expect(ids).toContain(PARTY_HOLDING);
    expect(ids).not.toContain(PARTY_B); // partie de WS_B
    expect(ids).toHaveLength(2);
  });

  it("2. session A ne voit que SES rôles de détention, jamais ceux de B", async () => {
    // (B n'a pas de rôle seedé, mais on prouve le filtre par un WHERE forgé.)
    const r = await withWorkspace(sessA, (tx) =>
      tx.execute(sql`select * from account_party_role where workspace_id = ${WS_B}`),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("3. WHERE forgé visant la partie de B depuis A → 0 ligne", async () => {
    const r = await withWorkspace(sessA, (tx) =>
      tx.execute(sql`select * from parties where id = ${PARTY_B}`),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("4. session B voit SA partie, jamais celles de A (symétrie)", async () => {
    const vues = await withWorkspace(sessB, (tx) =>
      tx.select({ id: parties.id }).from(parties),
    );
    const ids = vues.map((p) => p.id);
    expect(ids).toEqual([PARTY_B]);
  });
});

describe("FK composites scopées workspace — cross-tenant impossible EN BASE", () => {
  it("5. rattacher une party à une entité (BU) d'un AUTRE workspace → refus FK composite", async () => {
    // parties.entity_id → entities(id, workspace_id) : ENT_B n'existe pas dans
    // (id=ENT_B, workspace_id=WS_A) → violation de FK composite.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx
          .update(parties)
          .set({ entityId: ENT_B }) // BU de WS_B
          .where(eq(parties.id, PARTY_HOLDING)),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "le rattachement BU cross-tenant doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(/foreign key|violates|constraint/i);
  });

  it("6. INSERT account_party_role visant une party d'un AUTRE workspace → refus FK", async () => {
    // (party_id, workspace_id) → parties : PARTY_B n'existe pas dans WS_A.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(accountPartyRole).values({
          workspaceId: WS_A,
          bankAccountId: ACC_A1,
          partyId: PARTY_B, // partie de WS_B
          ownershipType: "BUSINESS",
          isPrimary: false,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "le rôle vers une party cross-tenant doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(
      /foreign key|violates|constraint|policy|row-level/i,
    );
  });

  it("7. INSERT account_party_role visant un compte d'un AUTRE workspace → refus FK", async () => {
    // (bank_account_id, workspace_id) → bank_accounts : ACC_B n'existe pas dans WS_A.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(accountPartyRole).values({
          workspaceId: WS_A,
          bankAccountId: ACC_B, // compte de WS_B
          partyId: PARTY_SUCRE,
          ownershipType: "BUSINESS",
          isPrimary: false,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "le rôle vers un compte cross-tenant doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(
      /foreign key|violates|constraint|policy|row-level/i,
    );
  });
});

describe("ON DELETE — RESTRICT (party référencée) vs CASCADE (compte → rôle)", () => {
  it("8. supprimer une party ENCORE RÉFÉRENCÉE par un rôle → refus RESTRICT", async () => {
    // account_party_role.party_id → parties ON DELETE RESTRICT : PARTY_SUCRE est
    // référencée par le rôle de ACC_A1 → le DELETE échoue (l'app archive is_active).
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.delete(parties).where(eq(parties.id, PARTY_SUCRE)),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "DELETE d'une party référencée doit être refusé").not.toBeNull();
    expect(flatten(thrown)).toMatch(/foreign key|violates|constraint|restrict/i);
  });

  it("9. supprimer un COMPTE purge ses rôles de détention (CASCADE légitime)", async () => {
    // account_party_role.bank_account_id → bank_accounts ON DELETE CASCADE : c'est
    // une table de LIAISON (non append-only). On crée un compte+rôle jetables pour
    // ne pas perturber le seed, puis on supprime le compte et on vérifie la purge.
    const ACC_TMP = "acc0face-eeee-4eee-8eee-eeeeeeeeeeee";
    await withWorkspace(sessA, (tx) =>
      tx.insert(bankAccounts).values({
        id: ACC_TMP,
        workspaceId: WS_A,
        connectionId: CONN_A,
        omnifiAccountId: "oa-tmp",
        accountName: "Compte Jetable",
        currency: "MUR",
        currentBalance: "0.00",
        isSelected: true,
      }),
    );
    await withWorkspace(sessA, (tx) =>
      tx.insert(accountPartyRole).values({
        workspaceId: WS_A,
        bankAccountId: ACC_TMP,
        partyId: PARTY_HOLDING,
        ownershipType: "BUSINESS",
        isPrimary: true,
      }),
    );

    // Suppression du compte (bank_accounts a DELETE en liste blanche).
    await withWorkspace(sessA, (tx) =>
      tx.delete(bankAccounts).where(eq(bankAccounts.id, ACC_TMP)),
    );

    // Le rôle a été purgé par la cascade.
    const restant = await withWorkspace(sessA, (tx) =>
      tx
        .select({ acc: accountPartyRole.bankAccountId })
        .from(accountPartyRole)
        .where(eq(accountPartyRole.bankAccountId, ACC_TMP)),
    );
    expect(restant).toHaveLength(0);
  });
});

describe("contre-preuve & idempotence — pas de faux positif", () => {
  it("10. opérations légitimes intra-tenant autorisées (party→BU, rôle valide)", async () => {
    // Rattacher HOLDING à la BU A (même workspace) : autorisé.
    await withWorkspace(sessA, (tx) =>
      tx
        .update(parties)
        .set({ entityId: ENT_A })
        .where(eq(parties.id, PARTY_HOLDING)),
    );
    const apres = await withWorkspace(sessA, (tx) =>
      tx
        .select({ entityId: parties.entityId })
        .from(parties)
        .where(eq(parties.id, PARTY_HOLDING)),
    );
    expect(apres[0].entityId).toBe(ENT_A);
    // Remise en état (entity_id NULL = non rattachée) pour l'indépendance.
    await withWorkspace(sessA, (tx) =>
      tx.update(parties).set({ entityId: null }).where(eq(parties.id, PARTY_HOLDING)),
    );

    // Un rôle valide (compte ET party du même workspace) est accepté : on ajoute
    // un second détenteur (compte joint) à ACC_A1, puis on le retire.
    await withWorkspace(sessA, (tx) =>
      tx.insert(accountPartyRole).values({
        workspaceId: WS_A,
        bankAccountId: ACC_A1,
        partyId: PARTY_HOLDING, // co-détenteur
        ownershipType: "JOINT_OWNER",
        isPrimary: false,
      }),
    );
    const roles = await withWorkspace(sessA, (tx) =>
      tx
        .select({ p: accountPartyRole.partyId })
        .from(accountPartyRole)
        .where(eq(accountPartyRole.bankAccountId, ACC_A1)),
    );
    expect(roles.map((r) => r.p).sort()).toEqual(
      [PARTY_SUCRE, PARTY_HOLDING].sort(),
    );
    await withWorkspace(sessA, (tx) =>
      tx
        .delete(accountPartyRole)
        .where(
          and(
            eq(accountPartyRole.bankAccountId, ACC_A1),
            eq(accountPartyRole.partyId, PARTY_HOLDING),
          ),
        ),
    );
  });

  it("11. idempotence d'ingestion : ré-insérer la même party (PartyId) est rejeté par l'unique scopé", async () => {
    // parties_workspace_omnifi_party_unique (workspace_id, omnifi_party_id) :
    // l'upsert d'ingestion ne crée jamais de doublon. Un INSERT nu du même PartyId
    // viole l'unique → c'est ce que onConflictDoUpdate absorbera côté ingestion (L3).
    let thrown: unknown = null;
    try {
      await withWorkspace(sessA, (tx) =>
        tx.insert(parties).values({
          workspaceId: WS_A,
          omnifiPartyId: "pid-suc", // déjà pris par PARTY_SUCRE
          name: "Doublon",
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "doublon de PartyId dans le même workspace doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(/unique|duplicate|violates|constraint/i);

    // Le MÊME omnifi_party_id dans un AUTRE workspace est permis (scopé) : WS_B en a
    // déjà un autre ; on prouve qu'aucune unicité GLOBALE n'est imposée en réinsérant
    // 'pid-suc' côté B (légitime — deux groupes peuvent avoir le même PartyId source
    // sans collision, l'unicité est (workspace_id, omnifi_party_id)).
    await withWorkspace(sessB, (tx) =>
      tx.insert(parties).values({
        workspaceId: WS_B,
        omnifiPartyId: "pid-suc",
        name: "Même PartyId, autre groupe",
      }),
    );
    const cote = await withWorkspace(sessB, (tx) =>
      tx
        .select({ id: parties.id })
        .from(parties)
        .where(eq(parties.omnifiPartyId, "pid-suc")),
    );
    expect(cote).toHaveLength(1); // accepté côté B
  });
});
