/**
 * Suite anti-IDOR / RBAC + INVARIANT RE-SYNC — `assignerPartieEntite` (Option B, L6b ;
 * pendant côté `parties` de `assignerCompteEntite`). Prouve sur Postgres réel (PGlite),
 * sous le rôle applicatif NON-propriétaire `tygr_app` (RLS active), que :
 *
 *   - l'assignation/détachement party→entité est **ADMIN-only** (garde du repository :
 *     un MANAGER, y compris Vision Globale, est refusé) ;
 *   - une party d'un AUTRE workspace est invisible et non-manipulable (404 nommé) ; un
 *     entity_id d'un autre workspace est rejeté par la FK composite (→ 404 nommé) ;
 *   - **INVARIANT CENTRAL L6b** : une assignation `entity_id` posée à la main par
 *     l'ADMIN SURVIT à un re-appel ultérieur de `upsertPartieEtRole` (re-sync) — le
 *     chemin d'écriture est SÉPARÉ et l'ON CONFLICT de l'ingestion OMET `entity_id` ;
 *   - contre-preuve : un ADMIN assigne PUIS détache normalement (pas de faux positif) ;
 *   - l'ingestion n'est pas bloquée (upsertPartieEtRole reste idempotent et opérant).
 *
 * DDL = migrations réelles ; rôle applicatif = provisioning prod (source unique).
 * Test 0 : tout sous `tygr_app` (non-bypassrls), JAMAIS sous l'owner.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  assignerPartieEntite,
  EntiteIntrouvableError,
  EntiteNonAutoriseError,
  PartieIntrouvableError,
} from "@/server/repositories/entites";
import { upsertPartieEtRole } from "@/server/repositories/ingestion";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // ADMIN de WS_A
const MANAGER_A = "22222222-2222-4222-8222-222222222222"; // MANAGER de WS_A (Vision Globale)
const ADMIN_B = "33333333-3333-4333-8333-333333333333"; // ADMIN de WS_B

const ENT_SUCRE = "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A
const ENT_ENERGIE = "e0e00000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // WS_A
const ENT_B = "b0b00000-cccc-4ccc-8ccc-cccccccccccc"; // WS_B (témoin cross-tenant)

const ACC_A = "acc05000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // compte WS_A (cible du rôle party)
const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const PARTY_A = "9a9a0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // party WS_A
const PARTY_B = "9b9b0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // party WS_B (témoin cross-tenant)
const OMNI_PARTY_A = "omni-party-a"; // PartyId Omni-FI de PARTY_A (clé de dédup re-sync)

const sAdminA = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sManagerA = { userId: MANAGER_A, activeWorkspaceId: WS_A };
// (Pas de session ADMIN_B : tous les cas IDOR partent d'ADMIN_A visant des
// ressources de WS_B — invisibles sous RLS. PARTY_B/ENT_B/ADMIN_B restent seedés
// comme témoins cross-tenant.)

/** Lit entity_id d'une party SOUS L'OWNER (bypass RLS) — la vérité en base, hors RLS. */
async function entityIdSousOwner(partyId: string): Promise<string | null> {
  await client.exec(`reset role;`);
  const r = await client.query<{ entity_id: string | null }>(
    `select entity_id from parties where id = '${partyId}'`,
  );
  await client.exec(`set role tygr_app;`);
  return r.rows[0]?.entity_id ?? null;
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
      ('${ADMIN_B}','admin@b.mu','Admin B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MANAGER_A}','${WS_A}','MANAGER'),
      ('${ADMIN_B}','${WS_B}','ADMIN');
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière','SUC',true),
      ('${ENT_ENERGIE}','${WS_A}','Énergie','ENE',true),
      ('${ENT_B}','${WS_B}','Entité B','XB',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${ADMIN_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_A}','${WS_A}','${CONN_A}','oa-a','Compte A','MUR','100.00',true,null);
    -- Parties seedées NON rattachées (entity_id NULL) : l'assignation est l'acte testé.
    insert into parties (id, workspace_id, entity_id, omnifi_party_id, name, ownership_type, is_active) values
      ('${PARTY_A}','${WS_A}',null,'${OMNI_PARTY_A}','Omnicane Sugar Ltd','PRIMARY',true),
      ('${PARTY_B}','${WS_B}',null,'omni-party-b','Partie B Ltd','PRIMARY',true);
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

describe("RBAC — assignation party→entité ADMIN-only (garde du repository)", () => {
  it("1. un MANAGER (Vision Globale) ne peut PAS assigner une party (EntiteNonAutoriseError)", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        assignerPartieEntite(tx, ctx, { partyId: PARTY_A, entityId: ENT_SUCRE }),
      ),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
    // En base, rien n'a bougé (refus AVANT toute écriture).
    expect(await entityIdSousOwner(PARTY_A)).toBeNull();
  });

  it("2. un MANAGER ne peut PAS détacher non plus (entityId null)", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        assignerPartieEntite(tx, ctx, { partyId: PARTY_A, entityId: null }),
      ),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
  });
});

describe("IDOR cross-tenant — party/entity d'un autre workspace → 404 (jamais 403)", () => {
  it("3. assigner une party d'un AUTRE workspace → PartieIntrouvableError", async () => {
    // ADMIN_A vise PARTY_B (workspace B) : invisible sous RLS → 0 ligne → 404.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        assignerPartieEntite(tx, ctx, { partyId: PARTY_B, entityId: ENT_SUCRE }),
      ),
    ).rejects.toBeInstanceOf(PartieIntrouvableError);
    // La party B n'a pas été touchée (sous owner, vérité hors RLS).
    expect(await entityIdSousOwner(PARTY_B)).toBeNull();
  });

  it("4. assigner SA party à une entité d'un AUTRE workspace → EntiteIntrouvableError (FK composite)", async () => {
    // PARTY_A est bien à WS_A, mais ENT_B est à WS_B : la FK (entity_id, workspace_id)
    // n'a pas de ligne (ENT_B, WS_A) → violation FK → mappée EntiteIntrouvableError.
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        assignerPartieEntite(tx, ctx, { partyId: PARTY_A, entityId: ENT_B }),
      ),
    ).rejects.toBeInstanceOf(EntiteIntrouvableError);
    // Échec FK → aucune assignation persistée.
    expect(await entityIdSousOwner(PARTY_A)).toBeNull();
  });

  it("5. assigner une party INEXISTANTE → PartieIntrouvableError", async () => {
    await expect(
      withWorkspace(sAdminA, (tx, ctx) =>
        assignerPartieEntite(tx, ctx, {
          partyId: "00000000-0000-4000-8000-000000000000",
          entityId: ENT_SUCRE,
        }),
      ),
    ).rejects.toBeInstanceOf(PartieIntrouvableError);
  });
});

describe("contre-preuve — un ADMIN assigne/détache normalement (pas de faux positif)", () => {
  it("6. ADMIN assigne PARTY_A à Sucrière, puis détache (null)", async () => {
    // Assigner.
    await withWorkspace(sAdminA, (tx, ctx) =>
      assignerPartieEntite(tx, ctx, { partyId: PARTY_A, entityId: ENT_SUCRE }),
    );
    expect(await entityIdSousOwner(PARTY_A)).toBe(ENT_SUCRE);

    // Détacher (null).
    await withWorkspace(sAdminA, (tx, ctx) =>
      assignerPartieEntite(tx, ctx, { partyId: PARTY_A, entityId: null }),
    );
    expect(await entityIdSousOwner(PARTY_A)).toBeNull();
  });
});

describe("INVARIANT CENTRAL L6b — l'assignation ADMIN survit à un re-sync (upsertPartieEtRole)", () => {
  it("7. (a) ADMIN assigne entity_id ; (b) un re-appel upsertPartieEtRole NE réécrase PAS cet entity_id", async () => {
    // (a) L'ADMIN rattache PARTY_A à Énergie, par le chemin SÉPARÉ (UPDATE direct).
    await withWorkspace(sAdminA, (tx, ctx) =>
      assignerPartieEntite(tx, ctx, { partyId: PARTY_A, entityId: ENT_ENERGIE }),
    );
    expect(await entityIdSousOwner(PARTY_A)).toBe(ENT_ENERGIE);

    // (b) Re-sync : on ré-exécute l'ingestion sur la MÊME party (même PartyId Omni-FI),
    // avec des hints amont DIFFÉRENTS (name/ownershipType rafraîchis). C'est exactement
    // ce qui se passe au re-sync : conflit sur (workspace_id, omnifi_party_id) → l'ON
    // CONFLICT met à jour name/ownership_type mais OMET entity_id.
    await withWorkspace(sAdminA, (tx, ctx) =>
      upsertPartieEtRole(tx, ctx, ACC_A, {
        omnifiPartyId: OMNI_PARTY_A,
        name: "Omnicane Sugar Limited (renommée)",
        ownershipType: "JOINT",
      }),
    );

    // INVARIANT : entity_id INCHANGÉ (Énergie) — le re-sync n'a pas écrasé le
    // rattachement BU posé à la main. C'est le cœur de L6b.
    expect(await entityIdSousOwner(PARTY_A)).toBe(ENT_ENERGIE);

    // ET le re-sync a bien rafraîchi les hints amont (preuve qu'il a opéré, pas no-op).
    await client.exec(`reset role;`);
    const apres = await client.query<{ name: string; ownership_type: string }>(
      `select name, ownership_type from parties where id = '${PARTY_A}'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(apres.rows[0].name).toBe("Omnicane Sugar Limited (renommée)");
    expect(apres.rows[0].ownership_type).toBe("JOINT");
  });

  it("8. l'ingestion n'est pas bloquée : upsertPartieEtRole reste idempotent (2e appel sans erreur)", async () => {
    // Ré-appel à l'identique : aucune exception, entity_id toujours préservé.
    await withWorkspace(sAdminA, (tx, ctx) =>
      upsertPartieEtRole(tx, ctx, ACC_A, {
        omnifiPartyId: OMNI_PARTY_A,
        name: "Omnicane Sugar Limited (renommée)",
        ownershipType: "JOINT",
      }),
    );
    expect(await entityIdSousOwner(PARTY_A)).toBe(ENT_ENERGIE);

    // Une seule ligne party pour ce PartyId (dédup scopée respectée, pas de doublon).
    await client.exec(`reset role;`);
    const n = await client.query<{ n: number }>(
      `select count(*)::int as n from parties where workspace_id = '${WS_A}' and omnifi_party_id = '${OMNI_PARTY_A}'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(n.rows[0].n).toBe(1);
  });
});
