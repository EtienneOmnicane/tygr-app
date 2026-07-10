/**
 * Suite anti-IDOR / RBAC — Server-side du repo `entites.ts` (Option B, L3 ; plan
 * PLAN-entites-multi-tenant.md §6.3). Prouve sur Postgres réel (PGlite), sous le rôle
 * applicatif NON-propriétaire `tygr_app` (RLS active), que :
 *
 *   - la gestion entités/scopes/assignation est **ADMIN-only** (garde du repository) ;
 *   - une entité / un compte / un membre d'un AUTRE workspace est invisible et
 *     non-manipulable (404 nommé, jamais 403 — pas d'oracle) ;
 *   - `definirScopesMembre` remplace ATOMIQUEMENT le périmètre (DELETE+INSERT en tx) ;
 *   - les FK composites scopées workspace bloquent toute cible cross-tenant en base ;
 *   - contre-preuve : un ADMIN du workspace courant opère normalement (pas de faux positif).
 *
 * DDL = migrations réelles ; rôle applicatif = provisioning prod (source unique).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { memberEntityScopes } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  assignerCompteEntite,
  archiverEntite,
  creerEntite,
  definirScopesMembre,
  EntiteIntrouvableError,
  EntiteNomDupliqueError,
  EntiteNonAutoriseError,
  CompteIntrouvableError,
  listerComptesAvecEntite,
  listerEntites,
  listerMembresWorkspace,
  listerScopesMembre,
  MembreNonScopableError,
  renommerEntite,
} from "@/server/repositories/entites";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // ADMIN de WS_A
const MANAGER_A = "22222222-2222-4222-8222-222222222222"; // MANAGER de WS_A
const VIEWER_A = "44444444-4444-4444-8444-444444444444"; // VIEWER de WS_A (cible scope)
const ADMIN_B = "33333333-3333-4333-8333-333333333333"; // ADMIN de WS_B

const ENT_SUCRE = "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A
const ENT_ENERGIE = "e0e00000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // WS_A
const ENT_B = "b0b00000-cccc-4ccc-8ccc-cccccccccccc"; // WS_B (témoin cross-tenant)

const ACC_A = "acc05000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // compte WS_A
const ACC_B = "acc0bbbb-dddd-4ddd-8ddd-dddddddddddd"; // compte WS_B
const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sAdminA = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sManagerA = { userId: MANAGER_A, activeWorkspaceId: WS_A };
const sAdminB = { userId: ADMIN_B, activeWorkspaceId: WS_B };

const flatten = (e: unknown): string => {
  let msg = "";
  let cur: unknown = e;
  while (cur instanceof Error) {
    msg += cur.message + " | ";
    cur = cur.cause;
  }
  return msg;
};

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
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière','SUC',true),
      ('${ENT_ENERGIE}','${WS_A}','Énergie','ENE',true),
      ('${ENT_B}','${WS_B}','Entité B','XB',true);
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

describe("préconditions", () => {
  it("0. requêtes sous tygr_app (sinon RLS ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

describe("RBAC — gestion entités ADMIN-only (garde du repository)", () => {
  it("1. un MANAGER ne peut PAS créer d'entité (EntiteNonAutoriseError)", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        creerEntite(tx, ctx, { name: "Pirate" }),
      ),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
  });

  it("2. un MANAGER ne peut PAS assigner un compte ni définir un scope", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        assignerCompteEntite(tx, ctx, {
          bankAccountId: ACC_A,
          entityId: ENT_SUCRE,
        }),
      ),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);

    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        definirScopesMembre(tx, ctx, {
          userId: VIEWER_A,
          entityIds: [ENT_SUCRE],
        }),
      ),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
  });

  it("3. un MANAGER ne peut PAS lister entités/scopes (lecture ADMIN-only)", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) => listerEntites(tx, ctx)),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        listerScopesMembre(tx, ctx, VIEWER_A),
      ),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
  });
});

describe("IDOR cross-tenant — entité/compte/membre d'un autre workspace → 404 (jamais 403)", () => {
  it("4. ADMIN de B ne voit pas les entités de A (listerEntites borné au tenant)", async () => {
    const vues = await withWorkspace(sAdminB, (tx, ctx) => listerEntites(tx, ctx));
    const ids = vues.map((e) => e.id);
    expect(ids).toContain(ENT_B);
    expect(ids).not.toContain(ENT_SUCRE);
    expect(ids).not.toContain(ENT_ENERGIE);
  });

  it("5. renommer/archiver une entité de A depuis B → EntiteIntrouvableError", async () => {
    await expect(
      withWorkspace(sAdminB, (tx, ctx) =>
        renommerEntite(tx, ctx, { entityId: ENT_SUCRE, name: "Hack" }),
      ),
    ).rejects.toBeInstanceOf(EntiteIntrouvableError);
    await expect(
      withWorkspace(sAdminB, (tx, ctx) => archiverEntite(tx, ctx, ENT_SUCRE)),
    ).rejects.toBeInstanceOf(EntiteIntrouvableError);
  });

  it("6. assigner un compte d'un AUTRE workspace → CompteIntrouvableError", async () => {
    // ADMIN_A vise ACC_B (workspace B) : invisible sous RLS → 0 ligne → 404.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        assignerCompteEntite(tx, ctx, {
          bankAccountId: ACC_B,
          entityId: ENT_SUCRE,
        }),
      ),
    ).rejects.toBeInstanceOf(CompteIntrouvableError);
  });

  it("7. assigner SON compte à une entité d'un AUTRE workspace → EntiteIntrouvableError (FK composite)", async () => {
    // ACC_A est bien à WS_A, mais ENT_B est à WS_B : la FK (entity_id, workspace_id)
    // n'a pas de ligne (ENT_B, WS_A) → violation FK → mappée EntiteIntrouvableError.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        assignerCompteEntite(tx, ctx, {
          bankAccountId: ACC_A,
          entityId: ENT_B,
        }),
      ),
    ).rejects.toBeInstanceOf(EntiteIntrouvableError);
  });

  it("8. définir un scope avec une entité d'un AUTRE workspace → EntiteIntrouvableError (FK) + DELETE rollback (atomicité)", async () => {
    // Pré-état : VIEWER_A scopé Sucrière.
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesMembre(tx, ctx, { userId: VIEWER_A, entityIds: [ENT_SUCRE] }),
    );
    // Tentative de redéfinir vers ENT_B (hors tenant) → l'INSERT viole la FK ; comme
    // DELETE+INSERT sont dans la MÊME transaction, le DELETE est rollback → le scope
    // initial (Sucrière) survit (atomicité prouvée).
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        definirScopesMembre(tx, ctx, { userId: VIEWER_A, entityIds: [ENT_B] }),
      ),
    ).rejects.toBeInstanceOf(EntiteIntrouvableError);

    const apres = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesMembre(tx, ctx, VIEWER_A),
    );
    expect(apres).toEqual([ENT_SUCRE]); // inchangé : la tx a rollback
  });

  it("9. définir un scope pour un user NON membre du workspace → MembreNonScopableError", async () => {
    // ADMIN_B (membre de WS_B, pas de WS_A) visé depuis une session WS_A : invisible
    // sous RLS → traité comme non-membre → 404.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        definirScopesMembre(tx, ctx, { userId: ADMIN_B, entityIds: [ENT_SUCRE] }),
      ),
    ).rejects.toBeInstanceOf(MembreNonScopableError);
  });
});

describe("contre-preuve — un ADMIN du workspace opère normalement (pas de faux positif)", () => {
  it("10. créer / renommer / nom dupliqué / assigner / archiver dans son workspace", async () => {
    // Créer.
    const { entityId } = await withWorkspace(sAdminA, (tx, ctx) =>
      creerEntite(tx, ctx, { name: "Logistique", code: "LOG" }),
    );
    expect(entityId).toBeTruthy();

    // Renommer.
    await withWorkspace(sAdminA, (tx, ctx) =>
      renommerEntite(tx, ctx, { entityId, name: "Logistique BU" }),
    );

    // Nom dupliqué (Sucrière existe déjà) → EntiteNomDupliqueError.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        creerEntite(tx, ctx, { name: "Sucrière" }),
      ),
    ).rejects.toBeInstanceOf(EntiteNomDupliqueError);

    // Assigner ACC_A à la nouvelle entité, puis désassigner (null). Vérif sous l'owner
    // (bypass RLS) : un client.query brut sous tygr_app SANS GUC serait masqué par
    // tenant_isolation (pas de workspace courant posé hors withWorkspace).
    await withWorkspace(sAdminA, (tx, ctx) =>
      assignerCompteEntite(tx, ctx, { bankAccountId: ACC_A, entityId }),
    );
    await client.exec(`reset role;`);
    let etat = await client.query<{ entity_id: string | null }>(
      `select entity_id from bank_accounts where id = '${ACC_A}'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(etat.rows[0].entity_id).toBe(entityId);

    await withWorkspace(sAdminA, (tx, ctx) =>
      assignerCompteEntite(tx, ctx, { bankAccountId: ACC_A, entityId: null }),
    );
    await client.exec(`reset role;`);
    etat = await client.query(
      `select entity_id from bank_accounts where id = '${ACC_A}'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(etat.rows[0].entity_id).toBeNull();

    // Archiver : disparaît du flag actif, mais la ligne demeure (RESTRICT, jamais DELETE).
    await withWorkspace(sAdminA, (tx, ctx) => archiverEntite(tx, ctx, entityId));
    const apres = await withWorkspace(sAdminA, (tx, ctx) => listerEntites(tx, ctx));
    expect(apres.find((e) => e.id === entityId)?.isActive).toBe(false);
  });

  it("11. definirScopesMembre remplace ATOMIQUEMENT et []=Vision Globale", async () => {
    // Définir 2 entités.
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesMembre(tx, ctx, {
        userId: VIEWER_A,
        entityIds: [ENT_SUCRE, ENT_ENERGIE],
      }),
    );
    let scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes.sort()).toEqual([ENT_SUCRE, ENT_ENERGIE].sort());

    // Réduire à 1 (remplacement, pas ajout).
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesMembre(tx, ctx, { userId: VIEWER_A, entityIds: [ENT_ENERGIE] }),
    );
    scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes).toEqual([ENT_ENERGIE]);

    // Vider = Vision Globale (aucune ligne).
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesMembre(tx, ctx, { userId: VIEWER_A, entityIds: [] }),
    );
    scopes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerScopesMembre(tx, ctx, VIEWER_A),
    );
    expect(scopes).toEqual([]);

    // Vérif directe owner : 0 ligne member_entity_scopes pour VIEWER_A.
    await client.exec(`reset role;`);
    const n = await client.query<{ n: number }>(
      `select count(*)::int as n from member_entity_scopes where user_id = '${VIEWER_A}'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(n.rows[0].n).toBe(0);
  });

  it("12. INSERT member_entity_scopes cross-tenant direct → refus (FK/RLS) — défense en base", async () => {
    // Même sans passer par le repo : forger un scope (VIEWER_A, ENT_B) depuis WS_A
    // est rejeté en base (FK composite entity → entities n'a pas (ENT_B, WS_A)).
    let thrown: unknown = null;
    try {
      await withWorkspace(sAdminA, (tx) =>
        tx.insert(memberEntityScopes).values({
          workspaceId: WS_A,
          userId: VIEWER_A,
          entityId: ENT_B,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(flatten(thrown)).toMatch(/foreign key|violates|constraint|policy|row-level/i);
  });
});

describe("listerMembresWorkspace — membres + scope joint (anti-N+1), ADMIN-only, tenant-scopé", () => {
  it("13. un MANAGER ne peut PAS lister les membres (garde ADMIN du repository)", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) => listerMembresWorkspace(tx, ctx)),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
  });

  it("14. ne remonte QUE les membres du workspace courant (RLS tenant) — pas de fuite cross-tenant", async () => {
    // Depuis WS_A : on voit ADMIN_A / MANAGER_A / VIEWER_A, jamais ADMIN_B.
    const membresA = await withWorkspace(sAdminA, (tx, ctx) =>
      listerMembresWorkspace(tx, ctx),
    );
    const idsA = membresA.map((m) => m.userId).sort();
    expect(idsA).toEqual([ADMIN_A, MANAGER_A, VIEWER_A].sort());
    expect(idsA).not.toContain(ADMIN_B);

    // Symétrie : depuis WS_B, on ne voit QUE ADMIN_B (témoin d'isolation).
    const membresB = await withWorkspace(sAdminB, (tx, ctx) =>
      listerMembresWorkspace(tx, ctx),
    );
    expect(membresB.map((m) => m.userId)).toEqual([ADMIN_B]);
  });

  it("15. expose nom/email/rôle exacts depuis users ⋈ workspace_members", async () => {
    const membres = await withWorkspace(sAdminA, (tx, ctx) =>
      listerMembresWorkspace(tx, ctx),
    );
    const viewer = membres.find((m) => m.userId === VIEWER_A);
    expect(viewer).toBeDefined();
    expect(viewer?.nomComplet).toBe("Viewer A");
    expect(viewer?.email).toBe("viewer@a.mu");
    expect(viewer?.role).toBe("VIEWER");
    expect(membres.find((m) => m.userId === ADMIN_A)?.role).toBe("ADMIN");
    expect(membres.find((m) => m.userId === MANAGER_A)?.role).toBe("MANAGER");
  });

  it("16. scopeInitial reflète le périmètre joint : [] pour un membre Vision Globale, sinon ses entityIds", async () => {
    // On FIXE l'état de départ (indépendance vis-à-vis des tests précédents) :
    // VIEWER_A scopé sur 2 entités, MANAGER_A en Vision Globale (aucun scope).
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesMembre(tx, ctx, {
        userId: VIEWER_A,
        entityIds: [ENT_SUCRE, ENT_ENERGIE],
      }),
    );
    await withWorkspace(sAdminA, (tx, ctx) =>
      definirScopesMembre(tx, ctx, { userId: MANAGER_A, entityIds: [] }),
    );

    const membres = await withWorkspace(sAdminA, (tx, ctx) =>
      listerMembresWorkspace(tx, ctx),
    );

    // Membre scopé : la jointure agrège ses 2 entityIds (ordre indifférent).
    const viewer = membres.find((m) => m.userId === VIEWER_A);
    expect(viewer?.scopeInitial.slice().sort()).toEqual(
      [ENT_SUCRE, ENT_ENERGIE].slice().sort(),
    );

    // Membre Vision Globale : array_remove(NULL) → [] (JAMAIS [null], piège du LEFT JOIN).
    const manager = membres.find((m) => m.userId === MANAGER_A);
    expect(manager?.scopeInitial).toEqual([]);
    expect(manager?.scopeInitial).not.toContain(null);
  });

  it("17. une seule ligne par membre même avec plusieurs scopes (pas de duplication par le LEFT JOIN)", async () => {
    // VIEWER_A a 2 scopes (cf. test 16) : il ne doit apparaître qu'UNE fois (GROUP BY).
    const membres = await withWorkspace(sAdminA, (tx, ctx) =>
      listerMembresWorkspace(tx, ctx),
    );
    const occurrences = membres.filter((m) => m.userId === VIEWER_A).length;
    expect(occurrences).toBe(1);
    // Et le total reste 3 membres (pas de lignes dupliquées).
    expect(membres).toHaveLength(3);
  });
});

describe("listerComptesAvecEntite — lecture ADMIN-only, bornée au tenant (L7)", () => {
  it("18. un MANAGER ne peut PAS lister les comptes (garde ADMIN du repository)", async () => {
    // La RLS tenant ne connaît PAS le rôle : sans cette garde applicative, un MANAGER
    // (Vision Globale) lirait tout le référentiel de comptes du groupe.
    await expect(
      withWorkspace(sManagerA, (tx, ctx) => listerComptesAvecEntite(tx, ctx)),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
  });

  it("19. ne remonte QUE les comptes du tenant courant (cross-workspace → 0 ligne)", async () => {
    // Depuis WS_A : ACC_A visible, ACC_B jamais (RLS tenant_isolation).
    const comptesA = await withWorkspace(sAdminA, (tx, ctx) =>
      listerComptesAvecEntite(tx, ctx),
    );
    const idsA = comptesA.map((c) => c.bankAccountId);
    expect(idsA).toContain(ACC_A);
    expect(idsA).not.toContain(ACC_B);

    // Symétrie : depuis WS_B on ne voit QUE ACC_B. `toEqual` (et non `not.toContain`)
    // pour attraper aussi une fuite d'un compte qu'on n'aurait pas nommé ici.
    const comptesB = await withWorkspace(sAdminB, (tx, ctx) =>
      listerComptesAvecEntite(tx, ctx),
    );
    expect(comptesB.map((c) => c.bankAccountId)).toEqual([ACC_B]);
  });

  // Fonctionnel (pas une contre-preuve de garde : il tourne sous ADMIN, il passerait
  // même sans `exigerAdmin` — c'est le cas 18 qui prouve la garde). Il prouve le
  // chemin que cette lecture existe pour servir : la DÉ-assignation.
  it("20. l'ADMIN lit nom/devise/entityId courants, et l'entityId suit l'assignation", async () => {
    // État de départ POSÉ ici (indépendance vis-à-vis de l'ordre des tests : le cas 10
    // laisse ACC_A désassigné, on ne s'appuie pas dessus).
    await withWorkspace(sAdminA, (tx, ctx) =>
      assignerCompteEntite(tx, ctx, {
        bankAccountId: ACC_A,
        entityId: ENT_SUCRE,
      }),
    );

    let comptes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerComptesAvecEntite(tx, ctx),
    );
    const compte = comptes.find((c) => c.bankAccountId === ACC_A);
    expect(compte).toBeDefined();
    expect(compte?.accountName).toBe("Compte A");
    expect(compte?.currency).toBe("MUR");
    expect(compte?.entityId).toBe(ENT_SUCRE);

    // Dé-assignation (le chemin que cette lecture est censée servir) : entityId → null.
    await withWorkspace(sAdminA, (tx, ctx) =>
      assignerCompteEntite(tx, ctx, { bankAccountId: ACC_A, entityId: null }),
    );
    comptes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerComptesAvecEntite(tx, ctx),
    );
    expect(
      comptes.find((c) => c.bankAccountId === ACC_A)?.entityId,
    ).toBeNull();
  });

  it("21. n'expose AUCUN montant (règle 8) — le contrat ne porte pas de solde", async () => {
    // ACC_A a bien un current_balance en base ('100.00') : la preuve est que la
    // projection ne le remonte pas (sinon on ouvrirait une surface de float en UI).
    const comptes = await withWorkspace(sAdminA, (tx, ctx) =>
      listerComptesAvecEntite(tx, ctx),
    );
    const compte = comptes.find((c) => c.bankAccountId === ACC_A);
    expect(Object.keys(compte ?? {}).sort()).toEqual([
      "accountName",
      "bankAccountId",
      "currency",
      "entityId",
    ]);
  });
});
