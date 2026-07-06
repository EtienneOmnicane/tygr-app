/**
 * Suite isolation — Seed du référentiel de catégories (QA-ONBOARD-CATEG1).
 *
 * Le seed CLI est owner-role (DATABASE_URL_ADMIN) : ce test exerce la FONCTION
 * RÉELLE partagée (scripts/seed-categories-lib.mjs — celle qu'appellent
 * seed-admin.mjs, seed-omnifi-demo.ts et seed-categories.mjs) sous Postgres réel
 * (PGlite) + migrations + provisioning RÉELS, et prouve :
 *   - FORCE RLS : sous app.current_workspace_id posé (owner), l'INSERT passe le WITH
 *     CHECK tenant_isolation ; chaque catégorie naît dans le BON workspace ;
 *   - hiérarchie : Natures (parent_id NULL) + Sous-natures rattachées via la FK
 *     COMPOSITE (parent_id, workspace_id) — un parent d'un autre tenant serait rejeté ;
 *   - idempotence : le garde « ≥1 catégorie ⇒ skip » empêche tout doublon au re-run ;
 *   - tout-ou-rien : la variante « dans la transaction de l'appelant » (chemin
 *     seed-admin) est annulée par un ROLLBACK appelant (jamais de référentiel partiel) ;
 *   - tenant-scopé : sous le rôle applicatif tygr_app (RLS), `listerCategories` ne
 *     remonte QUE le référentiel du workspace courant (pas de fuite cross-tenant).
 *
 * On importe le RÉFÉRENTIEL réel (src/lib/categories-referentiel.mjs) ET la lib
 * réelle : une seule source de vérité script/app/test (pas de dérive — règle 9).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  archiverCategorie,
  CategorieNonAutoriseeError,
  importerReferentielCategories,
  listerCategories,
} from "@/server/repositories/categorisation";
import {
  NB_CATEGORIES_REFERENTIEL,
  REFERENTIEL_CATEGORIES,
} from "@/lib/categories-referentiel.mjs";
import {
  seederCategoriesDansTransaction,
  seederCategoriesWorkspace,
} from "../../scripts/seed-categories-lib.mjs";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Workspace CTA (import applicatif) — CAROL est ADMIN. */
const WS_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
/** Workspace SANS membre : sert la contre-preuve rollback (chemin seed-admin). */
const WS_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/** Workspace CTA non-admin — EVE est MANAGER (preuve du refus de rôle). */
const WS_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "c0000000-cccc-4ccc-8ccc-cccccccccccc";
const EVE = "e0000000-eeee-4eee-8eee-eeeeeeeeeeee";
const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };
/** ADMIN de WS_C — autorisé à importer le référentiel via le CTA. */
const sessionCarol = { userId: CAROL, activeWorkspaceId: WS_C };
/** MANAGER de WS_E — doit être REFUSÉ par la garde de rôle du CTA. */
const sessionEve = { userId: EVE, activeWorkspaceId: WS_E };

/**
 * Seed d'un workspace = LA FONCTION RÉELLE des scripts (seed-categories-lib.mjs),
 * importée telle quelle — plus de réplique locale : ce que la CI prouve est
 * exactement ce que seed-admin / seed-omnifi-demo / seed-categories exécutent
 * (zéro dérive script/test, CLAUDE.md règle 9). Exécutée sous OWNER, comme les
 * scripts (DATABASE_URL_ADMIN) : PGlite tourne en superuser (BYPASSRLS) — le
 * garde d'idempotence de la lib filtre EXPLICITEMENT sur workspace_id, il reste
 * donc correct même quand la RLS ne borne pas la lecture.
 */
const seederWorkspace = (workspaceId: string): Promise<number> =>
  seederCategoriesWorkspace(client, workspaceId);

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

  // Seed (owner) : workspaces + membres. WS_A/WS_B = MANAGER (relecture RLS) ;
  // WS_C = CAROL ADMIN (CTA autorisé) ; WS_E = EVE MANAGER (CTA refusé) ;
  // WS_D = sans membre (contre-preuve rollback, chemin seed-admin).
  await client.exec(`
    insert into workspaces (id,name,kind,omnifi_client_user_id) values
      ('${WS_A}','Omnicane','INTERNAL_BU','eu-a'), ('${WS_B}','Autre Groupe','INTERNAL_BU','eu-b'),
      ('${WS_C}','CTA Admin','INTERNAL_BU','eu-c'),
      ('${WS_D}','Rollback BU','INTERNAL_BU','eu-d'),
      ('${WS_E}','CTA Manager','INTERNAL_BU','eu-e');
    insert into users (id,email,full_name) values
      ('${ALICE}','a@g.mu','Alice'), ('${BOB}','b@g.mu','Bob'),
      ('${CAROL}','c@g.mu','Carol'), ('${EVE}','e@g.mu','Eve');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${ALICE}','${WS_A}','MANAGER'), ('${BOB}','${WS_B}','MANAGER'),
      ('${CAROL}','${WS_C}','ADMIN'), ('${EVE}','${WS_E}','MANAGER');
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

  it("3bis. TOUT-OU-RIEN : la variante « dans la transaction de l'appelant » est annulée par son ROLLBACK (chemin seed-admin)", async () => {
    // seed-admin.mjs appelle seederCategoriesDansTransaction DANS sa transaction
    // globale : si le seed admin échoue APRÈS l'étape catégories, le rollback
    // appelant ne doit laisser AUCUNE catégorie (jamais de référentiel partiel).
    await client.query("begin");
    const n = await seederCategoriesDansTransaction(client, WS_D);
    expect(n).toBe(NB_CATEGORIES_REFERENTIEL); // visibles DANS la transaction…
    await client.query("rollback");

    const total = await client.query<{ n: number }>(
      `select count(*)::int as n from categories where workspace_id = '${WS_D}'`,
    );
    expect(total.rows[0].n).toBe(0); // …et AUCUNE persistée après rollback.
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

// ── CTA in-app « Importer les catégories standard » (QA-ONBOARD-CATEG1) ────────
// Le pendant APPLICATIF du seed : importerReferentielCategories tourne sous le rôle
// tygr_app (RLS active), pas owner. Prouve : (5) un ADMIN importe le référentiel
// complet et récupère la liste fraîche ; (6) idempotent (re-clic = no-op, liste
// inchangée) ; (7) un non-ADMIN (MANAGER) est REFUSÉ par la garde de rôle SANS
// effet de bord ; (8) l'import est intra-tenant (aucune fuite cross-workspace).
describe("CTA « Importer les catégories standard » — importerReferentielCategories (applicatif, RLS)", () => {
  afterAll(async () => {
    await client.exec(`set role tygr_app;`);
  });

  it("5. ADMIN importe le référentiel complet dans un workspace vierge (sous tygr_app/RLS)", async () => {
    await client.exec(`set role tygr_app;`);
    const r = await withWorkspace(sessionCarol, (tx, ctx) =>
      importerReferentielCategories(tx, ctx),
    );
    expect(r.imported).toBe(NB_CATEGORIES_REFERENTIEL);
    // La liste FRAÎCHE renvoyée = tout le référentiel actif (pour peupler le picker).
    expect(r.categories).toHaveLength(NB_CATEGORIES_REFERENTIEL);
    const naturesC = r.categories
      .filter((c) => c.parentId === null)
      .map((c) => c.name);
    expect(naturesC.sort()).toEqual(
      REFERENTIEL_CATEGORIES.map((g) => g.nature).sort(),
    );
  });

  it("6. IDEMPOTENT : ré-importer (ADMIN) est un no-op (imported=0, liste inchangée)", async () => {
    await client.exec(`set role tygr_app;`);
    const r = await withWorkspace(sessionCarol, (tx, ctx) =>
      importerReferentielCategories(tx, ctx),
    );
    expect(r.imported).toBe(0); // déjà pourvu → aucun INSERT
    expect(r.categories).toHaveLength(NB_CATEGORIES_REFERENTIEL); // liste réelle quand même

    // Aucun doublon persistant : le compte total reste le référentiel exact.
    const cats = await withWorkspace(sessionCarol, (tx, ctx) =>
      listerCategories(tx, ctx),
    );
    expect(cats).toHaveLength(NB_CATEGORIES_REFERENTIEL);
  });

  it("7. NON-ADMIN (MANAGER) REFUSÉ : CategorieNonAutoriseeError, aucune catégorie créée", async () => {
    await client.exec(`set role tygr_app;`);
    await expect(
      withWorkspace(sessionEve, (tx, ctx) =>
        importerReferentielCategories(tx, ctx),
      ),
    ).rejects.toBeInstanceOf(CategorieNonAutoriseeError);

    // Effet de bord NUL : le workspace d'EVE reste VIERGE (la garde de rôle
    // s'exécute AVANT le verrou et le moindre INSERT).
    const cats = await withWorkspace(sessionEve, (tx, ctx) =>
      listerCategories(tx, ctx),
    );
    expect(cats).toHaveLength(0);
  });

  it("8. INTRA-TENANT : l'import de WS_C n'a rien écrit dans un autre workspace (WS_E toujours vierge)", async () => {
    // WS_C a été peuplé (test 5) ; WS_E n'a jamais eu d'import RÉUSSI (refus test 7).
    // Preuve d'isolation : le seed applicatif est borné au workspace du contexte.
    await client.exec(`set role tygr_app;`);
    const catsE = await withWorkspace(sessionEve, (tx, ctx) =>
      listerCategories(tx, ctx),
    );
    expect(catsE).toHaveLength(0);
  });

  it("9. dégénéré « tout archivé » : le garde compte les ARCHIVÉES → no-op (pas de doublon), liste active vide", async () => {
    await client.exec(`set role tygr_app;`);
    // Archive TOUT le référentiel de WS_C (ADMIN) → 0 active mais ≥1 archivée.
    await withWorkspace(sessionCarol, async (tx, ctx) => {
      const actives = await listerCategories(tx, ctx);
      for (const c of actives) await archiverCategorie(tx, ctx, c.id);
    });
    const apres = await withWorkspace(sessionCarol, (tx, ctx) =>
      listerCategories(tx, ctx),
    );
    expect(apres).toHaveLength(0); // plus aucune ACTIVE

    // Ré-import : le garde d'idempotence compte AUSSI les archivées → no-op. Ce
    // qui ÉVITE une violation d'unicité (ré-insérer « Revenus » heurterait la
    // ligne archivée du même nom) : imported=0, aucune exception, liste active
    // vide. C'est CE résultat (imported=0 && categories=[]) qui pilote le message
    // informatif du CTA côté UI (pas de clic dans le vide).
    const r = await withWorkspace(sessionCarol, (tx, ctx) =>
      importerReferentielCategories(tx, ctx),
    );
    expect(r.imported).toBe(0);
    expect(r.categories).toHaveLength(0);
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
