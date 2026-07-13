/**
 * Suite anti-IDOR / RBAC — chaînage « créer un membre + assigner ses entités » à la
 * création (`creerMembreAvecScopes`, repo provisioning). Prouve sur Postgres réel
 * (PGlite), sous le rôle applicatif NON-propriétaire `tygr_app` (RLS active), que :
 *
 *   - le chaînage est ADMIN-only (garde du repo `creerUtilisateurEtRattacher`) — un
 *     MANAGER est refusé AVANT toute écriture ;
 *   - ATOMICITÉ (le cœur, règle 3) : un membre créé dans le workspace A ne reçoit JAMAIS
 *     un scope d'entité de B — un entityId d'un autre tenant lève (FK composite) et
 *     rollback l'INSERT user + membership → RIEN ne persiste sur échec ;
 *   - Vision Globale : entityIds=[] → membership sans aucune ligne member_entity_scopes ;
 *   - anti-écrasement (morceau 3) : ré-« provisionner » un email DÉJÀ membre ne réécrit
 *     PAS son mot de passe ET ne touche PAS son périmètre existant ;
 *   - réutilisation cross-workspace : un user existant (d'un autre workspace) est rattaché
 *     au workspace courant sans réécrire son hash.
 *
 * DDL = migrations réelles ; rôle applicatif = provisioning prod (source unique).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  creerMembreAvecScopes,
  ProvisioningNonAutoriseError,
} from "@/server/repositories/provisioning";
import { EntiteIntrouvableError } from "@/server/repositories/entites";
import { AdminNonScopableError } from "@/server/repositories/entites";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // ADMIN de WS_A
const MANAGER_A = "22222222-2222-4222-8222-222222222222"; // MANAGER de WS_A (non-admin)
const MEMBRE_EXISTANT = "44444444-4444-4444-8444-444444444444"; // membre VIEWER de WS_A
const USER_IN_B = "33333333-3333-4333-8333-333333333333"; // membre de WS_B (réutilisation)

const ENT_SUCRE = "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A
const ENT_ENERGIE = "e0e00000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // WS_A
const ENT_B = "b0b00000-cccc-4ccc-8ccc-cccccccccccc"; // WS_B (témoin cross-tenant)

const HASH_EXISTANT_A = "hash-original-membre-a";
const HASH_EXISTANT_B = "hash-original-user-b";

const sAdminA = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sManagerA = { userId: MANAGER_A, activeWorkspaceId: WS_A };

/** Lit une valeur brute (owner, bypass RLS) — vérité de base. */
async function enOwner<T>(fn: () => Promise<T>): Promise<T> {
  await client.exec(`reset role;`);
  try {
    return await fn();
  } finally {
    await client.exec(`set role tygr_app;`);
  }
}

async function compterParEmail(email: string): Promise<number> {
  return enOwner(async () => {
    const r = await client.query<{ n: number }>(
      `select count(*)::int as n from users where lower(email) = lower('${email}')`,
    );
    return r.rows[0].n;
  });
}

async function hashDe(email: string): Promise<string | null> {
  return enOwner(async () => {
    const r = await client.query<{ password_hash: string | null }>(
      `select password_hash from users where lower(email) = lower('${email}')`,
    );
    return r.rows[0]?.password_hash ?? null;
  });
}

async function scopesDe(userId: string): Promise<string[]> {
  return enOwner(async () => {
    const r = await client.query<{ entity_id: string }>(
      `select entity_id from member_entity_scopes where user_id = '${userId}' order by entity_id`,
    );
    return r.rows.map((x) => x.entity_id);
  });
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
    insert into users (id, email, full_name, password_hash) values
      ('${ADMIN_A}','admin@a.mu','Admin A',null),
      ('${MANAGER_A}','mgr@a.mu','Manager A',null),
      ('${MEMBRE_EXISTANT}','existant@a.mu','Membre Existant','${HASH_EXISTANT_A}'),
      ('${USER_IN_B}','inb@b.mu','User In B','${HASH_EXISTANT_B}');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MANAGER_A}','${WS_A}','MANAGER'),
      ('${MEMBRE_EXISTANT}','${WS_A}','VIEWER'),
      ('${USER_IN_B}','${WS_B}','VIEWER');
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière','SUC',true),
      ('${ENT_ENERGIE}','${WS_A}','Énergie','ENE',true),
      ('${ENT_B}','${WS_B}','Entité B','XB',true);
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${MEMBRE_EXISTANT}','${ENT_ENERGIE}');
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

describe("chaînage création + scopes — ADMIN-only, atomique, tenant-scopé", () => {
  it("1. heureux : ADMIN crée un MANAGER neuf scopé Sucrière → user + membership + 1 scope", async () => {
    const res = await withWorkspace(sAdminA, (tx, ctx) =>
      creerMembreAvecScopes(tx, ctx, {
        email: "nouveau@a.mu",
        fullName: "Nouveau Manager",
        passwordHash: "hash-nouveau",
        role: "MANAGER",
        entityIds: [ENT_SUCRE],
      }),
    );
    expect(res.utilisateurCree).toBe(true);
    expect(res.membershipCreee).toBe(true);
    expect(res.scopesDefinis).toBe(true);

    expect(await compterParEmail("nouveau@a.mu")).toBe(1);
    expect(await scopesDe(res.userId)).toEqual([ENT_SUCRE]);
    // Membership bien dans WS_A, rôle MANAGER.
    const role = await enOwner(async () => {
      const r = await client.query<{ role: string }>(
        `select role from workspace_members where user_id = '${res.userId}' and workspace_id = '${WS_A}'`,
      );
      return r.rows[0]?.role ?? null;
    });
    expect(role).toBe("MANAGER");
  });

  it("2. ATOMICITÉ (règle 3) : créer dans A avec une entité de B → rejet + RIEN ne persiste", async () => {
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        creerMembreAvecScopes(tx, ctx, {
          email: "cross@a.mu",
          fullName: "Cross Tenant",
          passwordHash: "hash-cross",
          role: "MANAGER",
          entityIds: [ENT_B], // entité de WS_B → FK composite (ENT_B, WS_A) absente
        }),
      ),
    ).rejects.toBeInstanceOf(EntiteIntrouvableError);

    // Rollback total : aucun utilisateur, aucune membership, aucun scope n'a persisté.
    expect(await compterParEmail("cross@a.mu")).toBe(0);
    const orphelins = await enOwner(async () => {
      const r = await client.query<{ n: number }>(
        `select count(*)::int as n from member_entity_scopes where entity_id = '${ENT_B}' and workspace_id = '${WS_A}'`,
      );
      return r.rows[0].n;
    });
    expect(orphelins).toBe(0);
  });

  it("3. Vision Globale : entityIds=[] → membership sans aucune ligne de scope", async () => {
    const res = await withWorkspace(sAdminA, (tx, ctx) =>
      creerMembreAvecScopes(tx, ctx, {
        email: "globale@a.mu",
        fullName: "Membre Globale",
        passwordHash: "hash-globale",
        role: "VIEWER",
        entityIds: [],
      }),
    );
    expect(res.membershipCreee).toBe(true);
    expect(res.scopesDefinis).toBe(false);
    expect(await scopesDe(res.userId)).toEqual([]);
  });

  it("4. non-ADMIN : un MANAGER ne peut PAS provisionner → ProvisioningNonAutoriseError, rien créé", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        creerMembreAvecScopes(tx, ctx, {
          email: "intrus@a.mu",
          fullName: "Intrus",
          passwordHash: "hash-intrus",
          role: "ADMIN",
          entityIds: [ENT_SUCRE],
        }),
      ),
    ).rejects.toBeInstanceOf(ProvisioningNonAutoriseError);
    expect(await compterParEmail("intrus@a.mu")).toBe(0);
  });

  it("5. anti-écrasement : ré-provisionner un email DÉJÀ membre ne touche NI le mdp NI le périmètre", async () => {
    const res = await withWorkspace(sAdminA, (tx, ctx) =>
      creerMembreAvecScopes(tx, ctx, {
        email: "existant@a.mu",
        fullName: "Nom Différent Ignoré",
        passwordHash: "hash-tentative-ecrasement",
        role: "VIEWER",
        entityIds: [ENT_SUCRE], // tentative de re-scoper → doit être ignorée (déjà membre)
      }),
    );
    expect(res.utilisateurCree).toBe(false);
    expect(res.membershipCreee).toBe(false);
    expect(res.scopesDefinis).toBe(false);

    // Mot de passe INCHANGÉ (anti-écrasement) ; périmètre existant PRÉSERVÉ (Énergie).
    expect(await hashDe("existant@a.mu")).toBe(HASH_EXISTANT_A);
    expect(await scopesDe(MEMBRE_EXISTANT)).toEqual([ENT_ENERGIE]);
  });

  it("6. réutilisation cross-workspace : un user d'un AUTRE workspace est rattaché à A sans réécrire son hash", async () => {
    const res = await withWorkspace(sAdminA, (tx, ctx) =>
      creerMembreAvecScopes(tx, ctx, {
        email: "inb@b.mu", // existe déjà (membre de WS_B)
        fullName: "Ignoré",
        passwordHash: "hash-tentative",
        role: "VIEWER",
        entityIds: [],
      }),
    );
    expect(res.utilisateurCree).toBe(false); // user réutilisé (global)
    expect(res.membershipCreee).toBe(true); // nouvelle membership dans A
    expect(res.userId).toBe(USER_IN_B);

    // Hash d'origine (B) conservé — jamais réécrit.
    expect(await hashDe("inb@b.mu")).toBe(HASH_EXISTANT_B);
    // Rattaché aux DEUX workspaces désormais.
    const nbMemberships = await enOwner(async () => {
      const r = await client.query<{ n: number }>(
        `select count(*)::int as n from workspace_members where user_id = '${USER_IN_B}'`,
      );
      return r.rows[0].n;
    });
    expect(nbMemberships).toBe(2);
  });
});

describe("§12 — créer un ADMIN AVEC un périmètre est refusé (garde héritée)", () => {
  it("7. ⭐ creerMembreAvecScopes refuse un ADMIN scopé — et RIEN ne persiste (atomicité)", async () => {
    // creerMembreAvecScopes CHAÎNE definirScopesMembre : il hérite donc de la garde §12,
    // sans la redéclarer. Un seul point de vérité. Et comme tout vit dans la MÊME
    // transaction, le refus rollback la création du user ET de la membership : on ne
    // laisse pas un ADMIN à moitié créé.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        creerMembreAvecScopes(tx, ctx, {
          email: "admin.scope@a.mu",
          fullName: "Admin Scopé",
          passwordHash: "hash",
          role: "ADMIN",
          entityIds: [ENT_SUCRE],
        }),
      ),
    ).rejects.toBeInstanceOf(AdminNonScopableError);

    // Ni user, ni membership, ni scope : la transaction a rollback.
    await client.exec(`reset role;`);
    const u = await client.query<{ n: number }>(
      `select count(*)::int as n from users where email = 'admin.scope@a.mu'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(u.rows[0]?.n).toBe(0);
  });

  it("8. contre-preuve — créer un ADMIN SANS périmètre passe normalement", async () => {
    // On n'a pas cassé le provisioning d'ADMIN : seule la COMBINAISON est refusée.
    const res = await withWorkspace(sAdminA, (tx, ctx) =>
      creerMembreAvecScopes(tx, ctx, {
        email: "admin.global@a.mu",
        fullName: "Admin Global",
        passwordHash: "hash",
        role: "ADMIN",
        entityIds: [],
      }),
    );
    expect(res.membershipCreee).toBe(true);
    expect(res.scopesDefinis).toBe(false);
  });
});
