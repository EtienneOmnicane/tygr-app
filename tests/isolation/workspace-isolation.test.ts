/**
 * Suite anti-IDOR — preuve d'isolation inter-workspace (CLAUDE.md règle 2,
 * critère d'acceptation §4.3 du cahier des charges).
 *
 * La preuve est par construction + adversariale : les politiques RLS sont des
 * invariants déclaratifs appliqués par PostgreSQL lui-même ; chaque test tente
 * une fuite par un vecteur distinct et doit échouer à fuir. La suite tourne
 * sur un Postgres réel (PGlite, en mémoire — aucune dépendance externe, donc
 * BLOQUANTE en CI sans infrastructure).
 *
 * Point décisif : les requêtes de test s'exécutent sous le rôle `tygr_app`
 * NON-propriétaire des tables — sans cela, Postgres ignore la RLS pour
 * l'owner et la suite "prouverait" du vide. Le setup le vérifie (test 0).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { workspaceMembers } from "@/server/db/schema";
import {
  createWithWorkspace,
  InvalidSessionError,
  UnsafeDatabaseRoleError,
  WorkspaceAccessDeniedError,
} from "@/server/db/tenancy";
import { creerRepositoryIdentite } from "@/server/repositories/identite";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// Identifiants fixes : lisibilité des assertions.
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111"; // MANAGER de A
const BOB = "22222222-2222-4222-8222-222222222222"; // MANAGER de B
const CARL = "33333333-3333-4333-8333-333333333333"; // sans workspace

beforeAll(async () => {
  // 1. Appliquer les MIGRATIONS RÉELLES (drizzle/migrations/*.sql) — la suite
  //    valide exactement le DDL que la production exécutera. (pushSchema de
  //    drizzle-kit/api perd les expressions USING/WITH CHECK des policies —
  //    bug constaté le 2026-06-11 — donc banni d'ici.)
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error("Aucune migration dans drizzle/migrations — rien à tester.");
  }
  for (const file of files) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of raw.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await client.exec(statement);
      }
    }
  }

  // 2. Garde-fou : politiques présentes ET porteuses de leur expression
  //    (qual non NULL). Une policy sans USING « passe » silencieusement à
  //    zéro ligne et ferait croire à une isolation prouvée sur une base vide
  //    de règles. Échec bruyant plutôt que faux vert.
  const policies = await client.query<{
    policyname: string;
    qual: string | null;
  }>(
    `select policyname, qual from pg_policies where tablename = 'workspace_members'`,
  );
  const byName = new Map(policies.rows.map((r) => [r.policyname, r.qual]));
  for (const required of ["tenant_isolation", "own_memberships_select"]) {
    if (!byName.has(required) || byName.get(required) == null) {
      throw new Error(
        `Policy "${required}" absente ou sans expression USING — ` +
          `la suite ne peut rien prouver. État : ${JSON.stringify(policies.rows)}`,
      );
    }
  }
  const force = await client.query<{ relforcerowsecurity: boolean }>(
    `select relforcerowsecurity from pg_class where relname = 'workspace_members'`,
  );
  if (!force.rows[0]?.relforcerowsecurity) {
    throw new Error("FORCE ROW LEVEL SECURITY absent (migration 0001).");
  }

  // 3. Seed en tant qu'owner (bypass RLS volontaire, données de test).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}', 'BU Logistique', 'INTERNAL_BU', 'enduser-ws-a'),
      ('${WS_B}', 'BU Retail',     'INTERNAL_BU', 'enduser-ws-b');
    insert into users (id, email, full_name) values
      ('${ALICE}', 'alice@groupe.mu', 'Alice Manager'),
      ('${BOB}',   'bob@groupe.mu',   'Bob Manager'),
      ('${CARL}',  'carl@groupe.mu',  'Carl Sans-Workspace');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}', '${WS_A}', 'MANAGER'),
      ('${BOB}',   '${WS_B}', 'MANAGER');
  `);

  // 4. Rôle applicatif non-propriétaire : c'est LUI que la RLS contraint.
  //    SOURCE UNIQUE DE VÉRITÉ (dette P0-b) : on applique le MÊME script que la
  //    production (drizzle/provisioning/tygr_app.sql) au lieu d'une définition
  //    inline divergente. Si le provisioning prod régresse, ce test casse.
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
  it("0. les requêtes tournent sous tygr_app, pas sous l'owner (sinon la RLS est ignorée)", async () => {
    const res = await client.query<{ who: string }>(
      "select current_user as who",
    );
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

describe("isolation inter-workspace (anti-IDOR)", () => {
  it("1. dans le contexte A, on ne voit que les lignes de A", async () => {
    const rows = await withWorkspace(
      { userId: ALICE, activeWorkspaceId: WS_A },
      (tx) => tx.select().from(workspaceMembers),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(WS_A);
  });

  it("2. clause WHERE oubliée → la RLS rend 0 ligne étrangère (pas de fuite par négligence)", async () => {
    // SELECT sans aucun filtre applicatif : le pire bug de repository possible.
    const rows = await withWorkspace(
      { userId: ALICE, activeWorkspaceId: WS_A },
      (tx) => tx.select().from(workspaceMembers),
    );
    expect(rows.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(rows.some((r) => r.workspaceId === WS_B)).toBe(false);
  });

  it("3. WHERE forgé visant explicitement le tenant B depuis le contexte A → 0 ligne", async () => {
    const rows = await withWorkspace(
      { userId: ALICE, activeWorkspaceId: WS_A },
      (tx) =>
        tx.execute(
          sql`select * from workspace_members where workspace_id = ${WS_B}`,
        ),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("4. alice ne peut pas ouvrir un contexte sur B (non-membre) → WorkspaceAccessDenied", async () => {
    await expect(
      withWorkspace({ userId: ALICE, activeWorkspaceId: WS_B }, async () => {
        throw new Error("fn ne doit jamais être appelée");
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it("5. hors de tout contexte (set_config jamais posé) → 0 ligne, fail-closed", async () => {
    const res = await client.query(
      "select * from workspace_members",
    );
    expect(res.rows).toHaveLength(0);
  });

  it("6. écriture cross-tenant depuis le contexte A (WITH CHECK) → rejetée par Postgres", async () => {
    // Drizzle enveloppe l'erreur driver ("Failed query: …") : le message RLS
    // de Postgres vit dans la chaîne des causes — on la déplie.
    const flatten = (e: unknown): string => {
      let msg = "";
      let cur: unknown = e;
      while (cur instanceof Error) {
        msg += cur.message + " | ";
        cur = cur.cause;
      }
      return msg;
    };
    let thrown: unknown = null;
    try {
      await withWorkspace({ userId: ALICE, activeWorkspaceId: WS_A }, (tx) =>
        tx
          .insert(workspaceMembers)
          .values({ userId: CARL, workspaceId: WS_B, role: "VIEWER" }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "l'insert cross-tenant doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(/row-level security|policy/i);

    // Ceinture-bretelles : aucune ligne n'a persisté (vérifié en owner).
    await client.exec(`reset role;`);
    const leaked = await client.query(
      `select 1 from workspace_members where user_id = '${CARL}'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(leaked.rows).toHaveLength(0);
  });

  it("7. session forgée (UUID invalides) → rejet AVANT toute requête SQL", async () => {
    await expect(
      withWorkspace(
        { userId: "1 OR 1=1", activeWorkspaceId: "x" },
        async () => null,
      ),
    ).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it("8. membership révoquée → l'accès tombe à la requête suivante (re-validation E14)", async () => {
    // Révocation en tant qu'owner (opération d'admin hors périmètre tygr_app).
    await client.exec(`reset role;`);
    await client.exec(
      `delete from workspace_members where user_id = '${ALICE}' and workspace_id = '${WS_A}';`,
    );
    await client.exec(`set role tygr_app;`);

    await expect(
      withWorkspace({ userId: ALICE, activeWorkspaceId: WS_A }, async () => {
        throw new Error("fn ne doit jamais être appelée");
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it("9. surface auth (PR auth-foundation) : la lecture pré-contexte des memberships ne rend QUE ses propres lignes", async () => {
    // Vecteur du login : avant tout contexte workspace, le JWT est construit
    // depuis membershipsDe() (policy own_memberships_select). Une fuite ici
    // permettrait de forger un activeWorkspaceId d'autrui dès la connexion.
    // NB : la membership d'Alice sur A a été révoquée au test 8.
    const identite = creerRepositoryIdentite(db);
    expect(await identite.membershipsDe(BOB)).toEqual([
      { workspaceId: WS_B, role: "MANAGER" },
    ]);
    expect(await identite.membershipsDe(ALICE)).toEqual([]);
    expect(await identite.membershipsDe(CARL)).toEqual([]);
  });
});

// Test négatif INVERSÉ (dette P0-b / C5) : prouve POURQUOI le rôle non-owner est
// vital, et arme la CI contre le scénario R1 (l'app pointe sur l'owner Neon →
// RLS contournée silencieusement). Si quelqu'un déprovisionne tygr_app ou
// configure l'app sous l'owner, CE test casse — l'angle mort devient bloquant.
describe("contre-preuve R1 : la RLS NE protège PAS sous le propriétaire (P0-b/C5)", () => {
  afterAll(async () => {
    // Restaure l'invariant des autres suites éventuelles : rôle applicatif.
    await client.exec(`set role tygr_app;`);
  });

  it("C5a. sous l'owner, un SELECT sans contexte voit TOUS les tenants (RLS ignorée)", async () => {
    await client.exec(`reset role;`); // redevient propriétaire des tables
    const res = await client.query<{ workspace_id: string }>(
      "select workspace_id from workspace_members",
    );
    // BOB/WS_B subsiste (la membership d'Alice/A a été supprimée au test 8).
    // Le point prouvé : l'owner voit des lignes SANS poser de contexte — donc
    // connecter l'app sous l'owner exposerait du cross-tenant. C'est le risque.
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.some((r) => r.workspace_id === WS_B)).toBe(true);
  });

  it("C5b. withWorkspace REFUSE de servir sous l'owner (garde-fou C6, fail-closed)", async () => {
    await client.exec(`reset role;`); // auto-suffisant : ne dépend pas de C5a
    // Le garde-fou runtime doit lever AVANT toute lecture de données — aucune
    // fuite cross-tenant possible sous l'owner.
    await expect(
      withWorkspace({ userId: BOB, activeWorkspaceId: WS_B }, async () => {
        throw new Error("fn ne doit JAMAIS être appelée sous l'owner");
      }),
    ).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
  });

  it("C5c. sous tygr_app, le même withWorkspace fonctionne (le rôle est la frontière)", async () => {
    await client.exec(`set role tygr_app;`);
    const role = await withWorkspace(
      { userId: BOB, activeWorkspaceId: WS_B },
      async (_tx, ctx) => ctx.role,
    );
    expect(role).toBe("MANAGER");
  });
});
