/**
 * Suite isolation — Seed du référentiel de catégories (scripts/seed-categories.mjs).
 *
 * Le seed est un script owner-role (DATABASE_URL_ADMIN) : ce test exerce sa LOGIQUE
 * DATA (le même pattern d'INSERT, le même référentiel importé) sous Postgres réel
 * (PGlite) + migrations + provisioning RÉELS, et prouve :
 *   - FORCE RLS : sous app.current_workspace_id posé (owner), l'INSERT passe le WITH
 *     CHECK tenant_isolation ; chaque catégorie naît dans le BON workspace ;
 *   - hiérarchie : Natures (parent_id NULL) + Sous-natures rattachées via la FK
 *     COMPOSITE (parent_id, workspace_id) — un parent d'un autre tenant serait rejeté ;
 *   - idempotence : le garde « ≥1 catégorie ⇒ skip » empêche tout doublon au re-run ;
 *   - tenant-scopé : sous le rôle applicatif tygr_app (RLS), `listerCategories` ne
 *     remonte QUE le référentiel du workspace courant (pas de fuite cross-tenant).
 *
 * On importe le RÉFÉRENTIEL réel (scripts/categories-referentiel.mjs) : une seule
 * source de vérité script/test (pas de dérive — CLAUDE.md règle 9).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { listerCategories } from "@/server/repositories/categorisation";
import {
  NB_CATEGORIES_REFERENTIEL,
  REFERENTIEL_CATEGORIES,
} from "../../scripts/categories-referentiel.mjs";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

/**
 * Réplique de la boucle de seed PAR WORKSPACE de scripts/seed-categories.mjs, sous le
 * rôle OWNER (le test n'a pas encore `set role tygr_app` quand on l'appelle, comme le
 * script tourne sous DATABASE_URL_ADMIN). Pose le GUC tenant, applique le garde
 * d'idempotence, insère Natures puis Sous-natures. Retourne le nb de catégories
 * insérées (0 si workspace déjà pourvu) — exactement la sémantique du script.
 */
async function seederWorkspace(workspaceId: string): Promise<number> {
  await client.query("begin");
  try {
    await client.query(
      "select set_config('app.current_workspace_id', $1, true)",
      [workspaceId],
    );
    // Filtre EXPLICITE workspace_id (comme le seeder corrigé) : robuste même sous
    // un rôle BYPASSRLS — PGlite tourne en superuser `postgres` (BYPASSRLS), donc
    // un garde reposant sur la seule RLS verrait les autres tenants → faux skip.
    const deja = await client.query(
      "select 1 from categories where workspace_id = $1 limit 1",
      [workspaceId],
    );
    if (deja.rows.length > 0) {
      await client.query("commit");
      return 0; // idempotence : workspace déjà pourvu → no-op
    }

    let insere = 0;
    for (const groupe of REFERENTIEL_CATEGORIES) {
      const nat = await client.query<{ id: string }>(
        `insert into categories (workspace_id, name, parent_id)
         values ($1, $2, null) returning id`,
        [workspaceId, groupe.nature],
      );
      const parentId = nat.rows[0].id;
      insere += 1;
      for (const sous of groupe.sousNatures) {
        await client.query(
          `insert into categories (workspace_id, name, parent_id)
           values ($1, $2, $3)`,
          [workspaceId, sous, parentId],
        );
        insere += 1;
      }
    }
    await client.query("commit");
    return insere;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const st of raw.split("--> statement-breakpoint")) {
      if (st.trim().length > 0) await client.exec(st);
    }
  }

  // Seed (owner) : 2 workspaces + 1 membre MANAGER chacun (pour relire via RLS).
  await client.exec(`
    insert into workspaces (id,name,kind,omnifi_client_user_id) values
      ('${WS_A}','Omnicane','INTERNAL_BU','eu-a'), ('${WS_B}','Autre Groupe','INTERNAL_BU','eu-b');
    insert into users (id,email,full_name) values
      ('${ALICE}','a@g.mu','Alice'), ('${BOB}','b@g.mu','Bob');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${ALICE}','${WS_A}','MANAGER'), ('${BOB}','${WS_B}','MANAGER');
  `);

  await client.exec(
    readFileSync(
      path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
      "utf8",
    ),
  );
  // NB : on RESTE owner ici (le seed est owner). Les tests basculent vers tygr_app
  // explicitement quand ils relisent via la RLS.
});

afterAll(async () => {
  await client.close();
});

describe("seed catégories — injection sous FORCE RLS (owner + GUC tenant)", () => {
  it("1. injecte le référentiel complet dans un workspace vierge (Natures + Sous-natures)", async () => {
    const n = await seederWorkspace(WS_A);
    expect(n).toBe(NB_CATEGORIES_REFERENTIEL);

    // Vérif directe (owner, GUC posé) : autant de lignes que le référentiel.
    await client.query("select set_config('app.current_workspace_id', $1, true)", [
      WS_A,
    ]);
    const total = await client.query<{ n: number }>(
      `select count(*)::int as n from categories where workspace_id = '${WS_A}'`,
    );
    expect(total.rows[0].n).toBe(NB_CATEGORIES_REFERENTIEL);

    // Les Natures (parent_id NULL) correspondent exactement aux racines du référentiel.
    const natures = await client.query<{ name: string }>(
      `select name from categories where workspace_id = '${WS_A}' and parent_id is null order by name`,
    );
    expect(natures.rows.map((r) => r.name).sort()).toEqual(
      REFERENTIEL_CATEGORIES.map((g) => g.nature).sort(),
    );
  });

  it("2. chaque Sous-nature pointe une Nature DU MÊME workspace (FK composite)", async () => {
    // Toute sous-nature (parent_id non NULL) a un parent lui-même racine et même ws.
    const orphelins = await client.query<{ n: number }>(
      `select count(*)::int as n
         from categories c
         left join categories p
           on p.id = c.parent_id and p.workspace_id = c.workspace_id
        where c.workspace_id = '${WS_A}'
          and c.parent_id is not null
          and p.id is null`,
    );
    expect(orphelins.rows[0].n).toBe(0);

    // Le compte de sous-natures = total - nb de natures.
    const sous = await client.query<{ n: number }>(
      `select count(*)::int as n from categories
        where workspace_id = '${WS_A}' and parent_id is not null`,
    );
    expect(sous.rows[0].n).toBe(
      NB_CATEGORIES_REFERENTIEL - REFERENTIEL_CATEGORIES.length,
    );
  });

  it("3. IDEMPOTENT : re-seeder le même workspace est un no-op (aucun doublon)", async () => {
    const n = await seederWorkspace(WS_A); // déjà pourvu → 0
    expect(n).toBe(0);

    await client.query("select set_config('app.current_workspace_id', $1, true)", [
      WS_A,
    ]);
    const total = await client.query<{ n: number }>(
      `select count(*)::int as n from categories where workspace_id = '${WS_A}'`,
    );
    expect(total.rows[0].n).toBe(NB_CATEGORIES_REFERENTIEL); // inchangé
  });
});

describe("seed catégories — tenant-scopé (lecture applicative sous tygr_app/RLS)", () => {
  it("4. listerCategories ne voit QUE le référentiel du workspace courant", async () => {
    // Seeder AUSSI WS_B, puis relire chaque workspace via le repo sous RLS.
    const nB = await seederWorkspace(WS_B);
    expect(nB).toBe(NB_CATEGORIES_REFERENTIEL);

    await client.exec(`set role tygr_app;`);
    try {
      const catsA = await withWorkspace(sessionA, (tx, ctx) =>
        listerCategories(tx, ctx),
      );
      const catsB = await withWorkspace(sessionB, (tx, ctx) =>
        listerCategories(tx, ctx),
      );

      // listerCategories filtre is_active=true → tout le référentiel (actif par défaut).
      expect(catsA).toHaveLength(NB_CATEGORIES_REFERENTIEL);
      expect(catsB).toHaveLength(NB_CATEGORIES_REFERENTIEL);

      // Aucune catégorie de A ne porte un id présent dans B (jeux disjoints, pas de fuite).
      const idsB = new Set(catsB.map((c) => c.id));
      expect(catsA.every((c) => !idsB.has(c.id))).toBe(true);

      // Les noms de Natures sont identiques (même référentiel) mais les LIGNES sont
      // distinctes par workspace — preuve que le seed est bien intra-tenant.
      const naturesA = catsA.filter((c) => c.parentId === null).map((c) => c.name);
      expect(naturesA.sort()).toEqual(
        REFERENTIEL_CATEGORIES.map((g) => g.nature).sort(),
      );
    } finally {
      await client.exec(`reset role;`);
    }
  });
});

// ── Garde-fou L7a : la suite tourne-t-elle vraiment sous tygr_app ? ───────────
// Sans cette précondition, un `set role tygr_app` régressé ferait tourner la suite
// sous l'owner (RLS ignorée) en passant au vert silencieusement (faux-vert). Le test
// pose lui-même le rôle (auto-suffisant : ne dépend pas de l'état laissé par un autre
// cas — ici le dernier finit sur `reset role`).
describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app, pas sous l'owner (sinon la RLS est ignorée)", async () => {
    await client.exec(`set role tygr_app;`);
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

// Contre-preuve R1 : prouve POURQUOI le rôle non-owner est vital. Sous l'owner la
// frontière tenant ne filtre pas ; sous tygr_app elle filtre. Si l'app pointait sur
// l'owner (RLS contournée), R1a casserait — l'angle mort devient bloquant.
describe("contre-preuve R1 : la RLS NE protège PAS sous le propriétaire", () => {
  afterAll(async () => {
    // Restaure l'invariant pour toute exécution ultérieure : rôle applicatif.
    await client.exec(`set role tygr_app;`);
  });

  it("R1a. sous l'owner, un SELECT sans contexte voit l'AUTRE tenant (RLS ignorée)", async () => {
    await client.exec(`reset role;`);
    const res = await client.query<{ workspace_id: string }>(
      "select workspace_id from workspace_members",
    );
    expect(res.rows.some((r) => r.workspace_id === WS_B)).toBe(true);
  });

  it("R1b. sous tygr_app, le contexte A ne voit JAMAIS le tenant B (la RLS filtre)", async () => {
    await client.exec(`set role tygr_app;`);
    const vus = await withWorkspace(sessionA, (tx) =>
      tx.select().from(schema.workspaceMembers),
    );
    expect(vus.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(vus.some((r) => r.workspaceId === WS_B)).toBe(false);
  });
});
