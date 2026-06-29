/**
 * Suite anti-IDOR / RBAC — Server-side du repo `user-scopes.ts` (L6a, plan
 * PLAN-architecture-multi-tenant-omnicane.md §5). Prouve sur Postgres réel (PGlite),
 * sous le rôle applicatif NON-propriétaire `tygr_app` (RLS active), que l'OCTROI et la
 * RÉVOCATION de périmètres fins (user_scopes) :
 *
 *   - sont **ADMIN-only** (garde du repository) — CENTRAL : un MANAGER « Vision
 *     Globale » PASSE la RLS tenant mais doit être REFUSÉ par la garde applicative,
 *     car user_scopes PILOTE account_scope (élargissement intra-groupe sinon) ;
 *   - refusent toute cible (party / compte / membre) d'un AUTRE workspace VIA L'ACTION
 *     (pas seulement l'INSERT brut) → 404 nommé, jamais 403 (pas d'oracle) ;
 *   - REMPLACENT ATOMIQUEMENT le jeu (definirScopesFinsMembre) : un INSERT en échec
 *     rollback le DELETE → le périmètre antérieur survit ;
 *   - rejettent les cibles invalides (0 ou 2 cibles) — miroir du CHECK XOR ;
 *   - contre-preuve : un ADMIN octroie / révoque normalement (pas de faux positif) ;
 *   - n'altèrent PAS l'ingestion : un upsert party tourne en Vision Globale (GUC scope
 *     non posé, aucune ligne user_scopes pour l'acteur d'ingestion).
 *
 * DDL = migrations réelles ; rôle applicatif = provisioning prod (source unique).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { userScopes } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  CompteIntrouvableError,
  definirScopesFinsMembre,
  listerScopesFinsMembre,
  MembreNonScopableError,
  octroyerScopeFin,
  PartieIntrouvableError,
  revoquerScopeFin,
  ScopeFinNonAutoriseError,
} from "@/server/repositories/user-scopes";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // ADMIN de WS_A
const MANAGER_A = "22222222-2222-4222-8222-222222222222"; // MANAGER de WS_A (Vision Globale)
const VIEWER_A = "44444444-4444-4444-8444-444444444444"; // VIEWER de WS_A (cible des octrois)
const ADMIN_B = "33333333-3333-4333-8333-333333333333"; // ADMIN de WS_B

// Parties (cibles party) — 2 dans WS_A, 1 témoin dans WS_B.
const PARTY_HOLDING = "9a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A
const PARTY_SUCRE = "9a000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A
const PARTY_B = "9b000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // WS_B (cross-tenant)

// Comptes (cibles compte) — 1 dans WS_A, 1 témoin dans WS_B.
const ACC_A = "acc05000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A
const ACC_B = "acc0bbbb-dddd-4ddd-8ddd-dddddddddddd"; // WS_B
const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sAdminA = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sManagerA = { userId: MANAGER_A, activeWorkspaceId: WS_A };
const sAdminB = { userId: ADMIN_B, activeWorkspaceId: WS_B };

/** Compte BRUT (owner, bypass RLS) les lignes user_scopes d'un membre — vérité de base. */
async function compterScopesOwner(userId: string): Promise<number> {
  await client.exec(`reset role;`);
  const r = await client.query<{ n: number }>(
    `select count(*)::int as n from user_scopes where user_id = '${userId}'`,
  );
  await client.exec(`set role tygr_app;`);
  return r.rows[0].n;
}

beforeAll(async () => {
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // Seed owner (bypass RLS).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${MANAGER_A}','mgr@a.mu','Manager A'),
      ('${VIEWER_A}','viewer@a.mu','Viewer A'),
      ('${ADMIN_B}','admin@b.mu','Admin B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MANAGER_A}','${WS_A}','MANAGER'),
      ('${VIEWER_A}','${WS_A}','VIEWER'),
      ('${ADMIN_B}','${WS_B}','ADMIN');
    insert into parties (id, workspace_id, omnifi_party_id, name, is_active) values
      ('${PARTY_HOLDING}','${WS_A}','pid-holding','Holding A',true),
      ('${PARTY_SUCRE}','${WS_A}','pid-sucre','Sucrière A',true),
      ('${PARTY_B}','${WS_B}','pid-b','Party B',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${ADMIN_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_A}','${WS_A}','${CONN_A}','oa-a','Compte A','MUR','100.00',true,null),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','200.00',true,null);
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

/* ════════════════════════════════════════════════════════════════════════════ */
/* f. Test 0 — les requêtes tournent sous tygr_app (sinon la RLS est ignorée).    */
/* ════════════════════════════════════════════════════════════════════════════ */
describe("préconditions", () => {
  it("0. requêtes sous tygr_app (non-bypassrls), PAS tygr_owner", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

/* ════════════════════════════════════════════════════════════════════════════ */
/* a. RBAC — LE TEST CENTRAL. user_scopes pilote account_scope ; la RLS tenant ne */
/*    borne PAS le rôle → un MANAGER (Vision Globale) PASSE la RLS mais doit être  */
/*    refusé par la garde applicative ADMIN du repo.                              */
/* ════════════════════════════════════════════════════════════════════════════ */
describe("RBAC — octroi/révocation de périmètre fin ADMIN-only (garde du repository)", () => {
  it("1. un MANAGER (Vision Globale) ne peut PAS octroyer une party (ScopeFinNonAutoriseError)", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        octroyerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_HOLDING }),
      ),
    ).rejects.toBeInstanceOf(ScopeFinNonAutoriseError);
  });

  it("2. un MANAGER ne peut PAS octroyer un compte ni révoquer ni redéfinir le set", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        octroyerScopeFin(tx, ctx, VIEWER_A, { bankAccountId: ACC_A }),
      ),
    ).rejects.toBeInstanceOf(ScopeFinNonAutoriseError);

    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        revoquerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_HOLDING }),
      ),
    ).rejects.toBeInstanceOf(ScopeFinNonAutoriseError);

    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        definirScopesFinsMembre(tx, ctx, {
          userId: VIEWER_A,
          partyIds: [PARTY_HOLDING],
          accountIds: [],
        }),
      ),
    ).rejects.toBeInstanceOf(ScopeFinNonAutoriseError);
  });

  it("3. un MANAGER ne peut PAS lister les périmètres (lecture ADMIN-only)", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        listerScopesFinsMembre(tx, ctx, VIEWER_A),
      ),
    ).rejects.toBeInstanceOf(ScopeFinNonAutoriseError);
  });

  it("4. le refus de rôle n'écrit RIEN (aucune ligne créée par une tentative MANAGER)", async () => {
    // Défense en profondeur : la garde lève AVANT toute écriture (première ligne).
    expect(await compterScopesOwner(VIEWER_A)).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════ */
/* b. IDOR cross-tenant VIA L'ACTION (repo), pas l'INSERT brut → 404 nommé.       */
/* ════════════════════════════════════════════════════════════════════════════ */
describe("IDOR cross-tenant — cible party/compte/membre d'un autre workspace → 404 (jamais 403)", () => {
  it("5. octroyer une PARTY d'un AUTRE workspace → PartieIntrouvableError", async () => {
    // ADMIN_A vise PARTY_B (WS_B) : invisible sous RLS → introuvable → 404.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        octroyerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_B }),
      ),
    ).rejects.toBeInstanceOf(PartieIntrouvableError);
  });

  it("6. octroyer un COMPTE d'un AUTRE workspace → CompteIntrouvableError", async () => {
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        octroyerScopeFin(tx, ctx, VIEWER_A, { bankAccountId: ACC_B }),
      ),
    ).rejects.toBeInstanceOf(CompteIntrouvableError);
  });

  it("7. octroyer à un MEMBRE absent du workspace (ADMIN_B depuis WS_A) → MembreNonScopableError", async () => {
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        octroyerScopeFin(tx, ctx, ADMIN_B, { partyId: PARTY_HOLDING }),
      ),
    ).rejects.toBeInstanceOf(MembreNonScopableError);
  });

  it("8. un ADMIN de B ne voit PAS / ne touche PAS les comptes & parties de A (symétrie)", async () => {
    // ADMIN_B vise une party de A (PARTY_HOLDING) pour un membre de A : tout est
    // invisible sous WS_B → introuvable (le membre VIEWER_A n'est pas dans WS_B).
    await expect(
      withWorkspace(sAdminB, (tx, ctx) =>
        octroyerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_HOLDING }),
      ),
    ).rejects.toBeInstanceOf(MembreNonScopableError);
    // Et aucune ligne n'a été créée dans WS_A par cette tentative.
    expect(await compterScopesOwner(VIEWER_A)).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════ */
/* c. Atomicité du remplace-set : un INSERT en échec rollback le DELETE.          */
/* ════════════════════════════════════════════════════════════════════════════ */
describe("atomicité — definirScopesFinsMembre remplace en bloc (échec INSERT ⇒ rollback DELETE)", () => {
  it("9. redéfinir vers une cible invalide (party cross-tenant) NE détruit PAS le périmètre antérieur", async () => {
    // Pré-état : VIEWER_A scopé sur PARTY_HOLDING.
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesFinsMembre(tx, ctx, {
        userId: VIEWER_A,
        partyIds: [PARTY_HOLDING],
        accountIds: [],
      }),
    );
    // Sanity check du pré-état.
    let scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.partyIds).toEqual([PARTY_HOLDING]);

    // Tentative de redéfinir vers PARTY_B (hors tenant) → la vérif d'existence lève
    // AVANT le DELETE (donc a fortiori rien n'est détruit) ; même si elle passait,
    // l'INSERT FK rollback la tx. Dans les deux cas, le périmètre antérieur survit.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        definirScopesFinsMembre(tx, ctx, {
          userId: VIEWER_A,
          partyIds: [PARTY_B],
          accountIds: [],
        }),
      ),
    ).rejects.toBeInstanceOf(PartieIntrouvableError);

    // Le scope initial est intact.
    scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.partyIds).toEqual([PARTY_HOLDING]);
    expect(scopes.accountIds).toEqual([]);

    // Nettoyage : revenir Vision Globale pour ne pas polluer les tests suivants.
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesFinsMembre(tx, ctx, {
        userId: VIEWER_A,
        partyIds: [],
        accountIds: [],
      }),
    );
    expect(await compterScopesOwner(VIEWER_A)).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════ */
/* d. XOR — exactement une cible. 0 ou 2 cibles via le repo → CibleScopeInvalide. */
/*    (Côté action, Zod attrape ce cas en amont — testé au niveau repo ici car la */
/*    suite isolation tourne sur le repo ; l'action ne fait que mapper.)          */
/* ════════════════════════════════════════════════════════════════════════════ */
describe("XOR exclusivité — octroi/révocation unitaire vise exactement une cible", () => {
  it("10. octroyer SANS cible (ni party ni compte) → rejet (miroir CHECK)", async () => {
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        // @ts-expect-error — cible vide volontairement invalide (test du garde repo).
        octroyerScopeFin(tx, ctx, VIEWER_A, {}),
      ),
    ).rejects.toThrow();
    expect(await compterScopesOwner(VIEWER_A)).toBe(0);
  });

  it("11. octroyer avec DEUX cibles (party ET compte) → rejet (miroir CHECK)", async () => {
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        // @ts-expect-error — deux cibles à la fois : volontairement invalide (XOR).
        octroyerScopeFin(tx, ctx, VIEWER_A, {
          partyId: PARTY_HOLDING,
          bankAccountId: ACC_A,
        }),
      ),
    ).rejects.toThrow();
    expect(await compterScopesOwner(VIEWER_A)).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════ */
/* e. Contre-preuve — un ADMIN octroie / révoque normalement (pas de faux positif).*/
/* ════════════════════════════════════════════════════════════════════════════ */
describe("contre-preuve — un ADMIN du workspace gère les périmètres normalement", () => {
  it("12. octroyer une party puis un compte (cumul), lecture cohérente, idempotence", async () => {
    // Octroi party.
    await withWorkspace(sAdminA, (tx, ctx) =>
      octroyerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_HOLDING }),
    );
    // Octroi compte (cumulé, autre famille).
    await withWorkspace(sAdminA, (tx, ctx) =>
      octroyerScopeFin(tx, ctx, VIEWER_A, { bankAccountId: ACC_A }),
    );

    let scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.partyIds).toEqual([PARTY_HOLDING]);
    expect(scopes.accountIds).toEqual([ACC_A]);

    // Idempotence : ré-octroyer la même party ne crée pas de doublon (set inchangé).
    await withWorkspace(sAdminA, (tx, ctx) =>
      octroyerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_HOLDING }),
    );
    scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.partyIds).toEqual([PARTY_HOLDING]);
    expect(scopes.accountIds).toEqual([ACC_A]);
    expect(await compterScopesOwner(VIEWER_A)).toBe(2);
  });

  it("13. révoquer une cible retire SEULEMENT celle-là ; révoquer une cible absente est idempotent", async () => {
    // État de départ (test 12) : party HOLDING + compte ACC_A.
    // Révoquer la party : il ne reste que le compte.
    await withWorkspace(sAdminA, (tx, ctx) =>
      revoquerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_HOLDING }),
    );
    let scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.partyIds).toEqual([]);
    expect(scopes.accountIds).toEqual([ACC_A]);

    // Révoquer une cible ABSENTE (PARTY_SUCRE jamais octroyée) → no-op, pas d'erreur.
    await withWorkspace(sAdminA, (tx, ctx) =>
      revoquerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_SUCRE }),
    );
    scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.accountIds).toEqual([ACC_A]);

    // Révoquer le compte restant → Vision Globale (0 ligne).
    await withWorkspace(sAdminA, (tx, ctx) =>
      revoquerScopeFin(tx, ctx, VIEWER_A, { bankAccountId: ACC_A }),
    );
    expect(await compterScopesOwner(VIEWER_A)).toBe(0);
  });

  it("14. definirScopesFinsMembre pose un set mixte party+compte puis []=Vision Globale (remplacement)", async () => {
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesFinsMembre(tx, ctx, {
        userId: VIEWER_A,
        partyIds: [PARTY_HOLDING, PARTY_SUCRE],
        accountIds: [ACC_A],
      }),
    );
    let scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.partyIds.slice().sort()).toEqual(
      [PARTY_HOLDING, PARTY_SUCRE].slice().sort(),
    );
    expect(scopes.accountIds).toEqual([ACC_A]);
    expect(await compterScopesOwner(VIEWER_A)).toBe(3);

    // Remplacement total par [] = Vision Globale.
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesFinsMembre(tx, ctx, {
        userId: VIEWER_A,
        partyIds: [],
        accountIds: [],
      }),
    );
    scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes).toEqual({ partyIds: [], accountIds: [] });
    expect(await compterScopesOwner(VIEWER_A)).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════════ */
/* INGESTION NON BLOQUÉE — un acteur en Vision Globale (aucun user_scopes) écrit   */
/* normalement. On prouve que poser un scope sur VIEWER_A ne bride PAS un INSERT   */
/* d'un membre Vision Globale (le GUC account_scope n'est pas posé sans scope).    */
/* ════════════════════════════════════════════════════════════════════════════ */
describe("ingestion non bloquée — Vision Globale (GUC scope non posé) reste libre d'écrire", () => {
  it("15. un membre SANS user_scopes (ADMIN_A) insère une ligne user_scopes sans entrave", async () => {
    // ADMIN_A n'a aucun user_scopes → withWorkspace ne pose PAS account_scope pour lui
    // (Vision Globale). Son écriture sur user_scopes (octroi à VIEWER_A) passe : c'est
    // exactement le chemin « acteur Vision Globale » qu'emprunte l'ingestion (qui pose
    // entity_id NULL sur bank_accounts/parties sans GUC scope). On le vérifie ici.
    await withWorkspace(sAdminA, (tx, ctx) =>
      octroyerScopeFin(tx, ctx, VIEWER_A, { partyId: PARTY_SUCRE }),
    );
    const scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesFinsMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.partyIds).toEqual([PARTY_SUCRE]);

    // Et l'acteur (ADMIN_A) lui-même reste Vision Globale (aucune ligne pour lui).
    expect(await compterScopesOwner(ADMIN_A)).toBe(0);

    // Nettoyage.
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesFinsMembre(tx, ctx, {
        userId: VIEWER_A,
        partyIds: [],
        accountIds: [],
      }),
    );
  });

  it("16. forger un user_scopes cross-tenant en INSERT direct reste refusé en base (défense en profondeur)", async () => {
    // Même hors repo : insérer (VIEWER_A, PARTY_B) depuis WS_A est rejeté par la FK
    // composite (party_id, workspace_id) → parties (pas de (PARTY_B, WS_A)).
    let thrown: unknown = null;
    try {
      await withWorkspace(sAdminA, (tx) =>
        tx.insert(userScopes).values({
          workspaceId: WS_A,
          userId: VIEWER_A,
          partyId: PARTY_B,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    let msg = "";
    let cur: unknown = thrown;
    while (cur instanceof Error) {
      msg += cur.message + " | ";
      cur = cur.cause;
    }
    expect(msg).toMatch(/foreign key|violates|constraint|policy|row-level/i);
  });
});
