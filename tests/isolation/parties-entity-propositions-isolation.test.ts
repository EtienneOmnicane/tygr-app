/**
 * Suite anti-IDOR / RBAC + INVARIANT RE-SYNC — PONT Party→entité en PRÉ-REMPLISSAGE
 * (ENTITY-PARTY1, décision PO 2026-07-02 : proposition + validation ADMIN). Prouve sur
 * Postgres réel (PGlite), sous le rôle applicatif NON-propriétaire `tygr_app` (RLS
 * active), que :
 *
 *   - `listerPropositionsPartyEntite` est **ADMIN-only** (garde du repository) ET ne
 *     surface JAMAIS une party/un compte d'un AUTRE workspace (RLS tenant + jointure
 *     bank_accounts, ENTITY-READ-JOIN1) ;
 *   - la CONFIRMATION (chemin composé : creerEntite + assignerPartieEntite +
 *     assignerCompteEntite, exactement ce que fait confirmerPropositionAction dans
 *     withWorkspace) est **ADMIN-only** (un MANAGER Vision Globale est refusé AVANT
 *     toute écriture) et pose enfin les entity_id via les GATES existantes ;
 *   - **INVARIANT** : l'entity_id posé par la confirmation SURVIT à un re-sync
 *     (upsertCompte / upsertPartieEtRole omettent entity_id de leur ON CONFLICT).
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
  assignerCompteEntite,
  assignerPartieEntite,
  creerEntite,
  EntiteNonAutoriseError,
  listerPropositionsPartyEntite,
} from "@/server/repositories/entites";
import { upsertCompte, upsertPartieEtRole } from "@/server/repositories/ingestion";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // ADMIN de WS_A
const MANAGER_A = "22222222-2222-4222-8222-222222222222"; // MANAGER de WS_A (Vision Globale)
const ADMIN_B = "33333333-3333-4333-8333-333333333333"; // ADMIN de WS_B

const ENT_ENERGIE = "e0e00000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // WS_A (cible existante)

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ACC_A1 = "acc05001-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A, party A
const ACC_A2 = "acc05002-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A, party A
const ACC_B1 = "acc0b001-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // WS_B (témoin cross-tenant)

const PARTY_A = "9a9a0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // party WS_A
const PARTY_B = "9b9b0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // party WS_B (témoin cross-tenant)
const OMNI_PARTY_A = "omni-party-a"; // PartyId Omni-FI de PARTY_A
const OMNI_ACC_A1 = "oa-a1"; // AccountId Omni-FI de ACC_A1 (clé de dédup re-sync)

const sAdminA = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sManagerA = { userId: MANAGER_A, activeWorkspaceId: WS_A };

/** Lit entity_id d'un compte SOUS L'OWNER (bypass RLS) — la vérité en base, hors RLS. */
async function accEntityIdSousOwner(id: string): Promise<string | null> {
  await client.exec(`reset role;`);
  const r = await client.query<{ entity_id: string | null }>(
    `select entity_id from bank_accounts where id = '${id}'`,
  );
  await client.exec(`set role tygr_app;`);
  return r.rows[0]?.entity_id ?? null;
}

/** Lit entity_id d'une party SOUS L'OWNER (bypass RLS). */
async function partyEntityIdSousOwner(id: string): Promise<string | null> {
  await client.exec(`reset role;`);
  const r = await client.query<{ entity_id: string | null }>(
    `select entity_id from parties where id = '${id}'`,
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
      ('${ENT_ENERGIE}','${WS_A}','Énergie','ENE',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${ADMIN_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_A1}','${WS_A}','${CONN_A}','${OMNI_ACC_A1}','Compte A1','MUR','100.00',true,null),
      ('${ACC_A2}','${WS_A}','${CONN_A}','oa-a2','Compte A2','USD','50.00',true,null),
      ('${ACC_B1}','${WS_B}','${CONN_B}','oa-b1','Compte B1','MUR','10.00',true,null);
    -- Parties seedées NON rattachées ; liaisons compte↔party best-effort (ingestion).
    insert into parties (id, workspace_id, entity_id, omnifi_party_id, name, ownership_type, is_active) values
      ('${PARTY_A}','${WS_A}',null,'${OMNI_PARTY_A}','OMNICANE THERMAL ENERGY','PRIMARY',true),
      ('${PARTY_B}','${WS_B}',null,'omni-party-b','AIRPORT HOTEL LTD','PRIMARY',true);
    insert into account_party_role (workspace_id, bank_account_id, party_id, ownership_type, is_primary) values
      ('${WS_A}','${ACC_A1}','${PARTY_A}','PRIMARY',true),
      ('${WS_A}','${ACC_A2}','${PARTY_A}','PRIMARY',true),
      ('${WS_B}','${ACC_B1}','${PARTY_B}','PRIMARY',true);
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

describe("RBAC — listerPropositionsPartyEntite est ADMIN-only", () => {
  it("1. un MANAGER (Vision Globale) ne peut PAS lire les propositions", async () => {
    await expect(
      withWorkspace(sManagerA, (tx, ctx) =>
        listerPropositionsPartyEntite(tx, ctx),
      ),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
  });
});

describe("Isolation — les propositions ne fuient jamais hors tenant", () => {
  it("2. ADMIN_A ne voit QUE la party de WS_A + ses comptes (jamais WS_B)", async () => {
    const props = await withWorkspace(sAdminA, (tx, ctx) =>
      listerPropositionsPartyEntite(tx, ctx),
    );
    // Une seule proposition (PARTY_A) ; PARTY_B (autre tenant) est invisible.
    expect(props).toHaveLength(1);
    const p = props[0];
    expect(p.partyId).toBe(PARTY_A);
    expect(p.partyName).toBe("OMNICANE THERMAL ENERGY");
    // Aucune entité homonyme active dans WS_A → création proposée (null).
    expect(p.entiteExistanteId).toBeNull();
    expect(p.entiteDejaRattacheeId).toBeNull();
    // Exactement les 2 comptes de WS_A rattachés à PARTY_A ; ACC_B1 jamais présent.
    const ids = p.comptes.map((c) => c.bankAccountId).sort();
    expect(ids).toEqual([ACC_A1, ACC_A2].sort());
    expect(ids).not.toContain(ACC_B1);
  });

  it("3. depuis WS_B, ADMIN_A ne voit rien de WS_A (symétrie) — contrôle via le compte témoin", async () => {
    // ADMIN_B lit ses propres propositions : uniquement PARTY_B + ACC_B1.
    const props = await withWorkspace(
      { userId: ADMIN_B, activeWorkspaceId: WS_B },
      (tx, ctx) => listerPropositionsPartyEntite(tx, ctx),
    );
    expect(props).toHaveLength(1);
    expect(props[0].partyId).toBe(PARTY_B);
    const ids = props[0].comptes.map((c) => c.bankAccountId);
    expect(ids).toEqual([ACC_B1]);
    // Aucun compte de WS_A ne fuit.
    expect(ids).not.toContain(ACC_A1);
    expect(ids).not.toContain(ACC_A2);
  });
});

describe("RBAC — la confirmation est ADMIN-only (chemin composé)", () => {
  it("4. un MANAGER ne peut PAS confirmer (creerEntite refuse AVANT toute écriture)", async () => {
    await expect(
      withWorkspace(sManagerA, async (tx, ctx) => {
        // Exactement la 1re étape de confirmerPropositionAction (création cible).
        await creerEntite(tx, ctx, { name: "OMNICANE THERMAL ENERGY" });
      }),
    ).rejects.toBeInstanceOf(EntiteNonAutoriseError);
    // Rien n'a été rattaché.
    expect(await partyEntityIdSousOwner(PARTY_A)).toBeNull();
    expect(await accEntityIdSousOwner(ACC_A1)).toBeNull();
    expect(await accEntityIdSousOwner(ACC_A2)).toBeNull();
  });
});

describe("Contre-preuve — l'ADMIN confirme : entity_id posé via les gates", () => {
  it("5. confirmation vers une entité EXISTANTE (Énergie) : party + comptes rattachés", async () => {
    await withWorkspace(sAdminA, async (tx, ctx) => {
      await assignerPartieEntite(tx, ctx, {
        partyId: PARTY_A,
        entityId: ENT_ENERGIE,
      });
      await assignerCompteEntite(tx, ctx, {
        bankAccountId: ACC_A1,
        entityId: ENT_ENERGIE,
      });
      await assignerCompteEntite(tx, ctx, {
        bankAccountId: ACC_A2,
        entityId: ENT_ENERGIE,
      });
    });
    expect(await partyEntityIdSousOwner(PARTY_A)).toBe(ENT_ENERGIE);
    expect(await accEntityIdSousOwner(ACC_A1)).toBe(ENT_ENERGIE);
    expect(await accEntityIdSousOwner(ACC_A2)).toBe(ENT_ENERGIE);
  });

  it("6. après confirmation, la proposition reflète le rattachement (entiteDejaRattacheeId + comptes déjà assignés)", async () => {
    const props = await withWorkspace(sAdminA, (tx, ctx) =>
      listerPropositionsPartyEntite(tx, ctx),
    );
    const p = props.find((x) => x.partyId === PARTY_A);
    expect(p?.entiteDejaRattacheeId).toBe(ENT_ENERGIE);
    // Les comptes portent maintenant leur entity_id actuel (bilan « déjà assigné »).
    expect(p?.comptes.every((c) => c.entityIdActuel === ENT_ENERGIE)).toBe(true);
  });
});

describe("INVARIANT — un re-sync ne réécrase PAS l'entity_id confirmé", () => {
  it("7. upsertCompte + upsertPartieEtRole (re-sync) préservent l'entity_id posé", async () => {
    // Re-sync du compte ACC_A1 (même AccountId Omni-FI) : hints rafraîchis, entity_id omis.
    await withWorkspace(sAdminA, (tx, ctx) =>
      upsertCompte(tx, ctx, CONN_A, {
        omnifiAccountId: OMNI_ACC_A1,
        accountName: "Compte A1 (renommé)",
        currency: "MUR",
        currentBalance: "150.00",
        isSelected: true,
      }),
    );
    // Re-sync de la party (même PartyId Omni-FI) : name rafraîchi, entity_id omis.
    await withWorkspace(sAdminA, (tx, ctx) =>
      upsertPartieEtRole(tx, ctx, ACC_A1, {
        omnifiPartyId: OMNI_PARTY_A,
        name: "OMNICANE THERMAL ENERGY (renommée)",
        ownershipType: "JOINT",
      }),
    );

    // INVARIANT : entity_id INCHANGÉ (Énergie) sur le compte ET la party.
    expect(await accEntityIdSousOwner(ACC_A1)).toBe(ENT_ENERGIE);
    expect(await partyEntityIdSousOwner(PARTY_A)).toBe(ENT_ENERGIE);
  });
});
