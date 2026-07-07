/**
 * Suite anti-IDOR — lecture TITULAIRE de listerComptes (bandeau/sélecteur groupés
 * par party, PLAN-bandeau-titulaire-accordeon.md L1). Prouve sur Postgres réel
 * (PGlite, rôle tygr_app non-propriétaire) que :
 *
 *  1. `holderName` remonte pour un compte avec party primaire, `null` sans party
 *     (bucket « Non regroupé » côté UI) ;
 *  2. UNE SEULE ligne par compte même quand le compte porte 2 rôles party (D2 —
 *     anti-multiplication : la party PRIMAIRE gagne, pas de doublon du compte) ;
 *  3. un PartyName d'un AUTRE workspace n'apparaît JAMAIS (tenant_isolation sur
 *     parties + account_party_role, jointure pilotée par bank_accounts) ;
 *  4. en Vision Entité, un compte hors scope reste masqué AVEC son titulaire
 *     (héritage entity_scope par la jointure — ENTITY-READ-JOIN1).
 *
 * Le groupement lui-même est DISPLAY-ONLY (règle 2) : ces cas protègent le seul
 * point où la lecture s'élargit (2 tables jointes en plus).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { listerComptes } from "@/server/repositories/dashboard";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
/** Membre de WS_A SCOPÉ sur l'entité E1 (Vision Entité) — cas 4. */
const ANNA = "33333333-3333-4333-8333-333333333333";
const BOB = "22222222-2222-4222-8222-222222222222";
const ENT_A1 = "eeee1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_A = "aaaacccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "bbbbcccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Compte A1 : 2 rôles party (primaire « Holding Alpha », secondaire « Filiale Beta »). */
const ACC_A1 = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Compte A2 : AUCUN rôle party → holder null. Non assigné à une entité (NULL). */
const ACC_A2 = "aaaa2222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_B = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARTY_ALPHA = "1a111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_BETA = "1b222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_B = "1c333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionAnna = { userId: ANNA, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

beforeAll(async () => {
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // Seed owner (bypass RLS). WS_A : 2 comptes (avec/sans party) + entité E1 ;
  // WS_B : 1 compte avec un PartyName « SECRET HOLDER B » (témoin de fuite).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','A','INTERNAL_BU','eu-a'), ('${WS_B}','B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ALICE}','a@g.mu','A'), ('${ANNA}','anna@g.mu','Anna'), ('${BOB}','b@g.mu','B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}','${WS_A}','MANAGER'),
      ('${ANNA}','${WS_A}','MANAGER'),
      ('${BOB}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name) values
      ('${ENT_A1}','${WS_A}','Entite Un');
    -- ANNA en Vision Entité (scopée E1) ; ALICE/BOB en Vision Globale (aucune ligne).
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${ANNA}','${ENT_A1}');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ALICE}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB}');
    -- ACC_A1 assigné à E1 (visible par ANNA) ; ACC_A2 non assigné (masqué en Vision Entité).
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_A1}','${WS_A}','${CONN_A}','oa-a1','Compte Alpha','MUR','5000.00',true,'${ENT_A1}'),
      ('${ACC_A2}','${WS_A}','${CONN_A}','oa-a2','Compte Sans Party','MUR','100.00',true,null),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true,null);
    insert into parties (id, workspace_id, omnifi_party_id, name) values
      ('${PARTY_ALPHA}','${WS_A}','op-alpha','Holding Alpha'),
      ('${PARTY_BETA}','${WS_A}','op-beta','Filiale Beta'),
      ('${PARTY_B}','${WS_B}','op-b','SECRET HOLDER B');
    -- ACC_A1 porte DEUX rôles (joint) : la primaire « Holding Alpha » doit gagner
    -- et le compte ne doit sortir qu'UNE fois (D2).
    insert into account_party_role (workspace_id, bank_account_id, party_id, ownership_type, is_primary) values
      ('${WS_A}','${ACC_A1}','${PARTY_BETA}','JOINT_OWNER',false),
      ('${WS_A}','${ACC_A1}','${PARTY_ALPHA}','PRIMARY',true),
      ('${WS_B}','${ACC_B}','${PARTY_B}','PRIMARY',true);
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

describe("listerComptes — titulaire (party primaire)", () => {
  it("chemin heureux : holderName pour le compte avec party, null sans party", async () => {
    const a = await withWorkspace(sessionA, (tx) => listerComptes(tx));
    const alpha = a.find((c) => c.bankAccountId === ACC_A1);
    const sans = a.find((c) => c.bankAccountId === ACC_A2);
    expect(alpha?.holderName).toBe("Holding Alpha");
    expect(alpha?.holderId).toBe(PARTY_ALPHA);
    expect(sans?.holderName).toBeNull();
    expect(sans?.holderId).toBeNull();
  });

  it("D2 : UNE SEULE ligne pour le compte à 2 rôles party, la primaire gagne", async () => {
    const a = await withWorkspace(sessionA, (tx) => listerComptes(tx));
    // Pas de multiplication : 2 comptes sélectionnés → exactement 2 lignes.
    expect(a).toHaveLength(2);
    const lignesAlpha = a.filter((c) => c.bankAccountId === ACC_A1);
    expect(lignesAlpha).toHaveLength(1);
    // is_primary DESC : « Holding Alpha » (primaire), jamais « Filiale Beta ».
    expect(lignesAlpha[0].holderName).toBe("Holding Alpha");
  });

  it("isolation tenant : un PartyName d'un autre workspace n'apparaît JAMAIS", async () => {
    const a = await withWorkspace(sessionA, (tx) => listerComptes(tx));
    const b = await withWorkspace(sessionB, (tx) => listerComptes(tx));
    expect(a.map((c) => c.holderName)).not.toContain("SECRET HOLDER B");
    expect(b).toHaveLength(1);
    expect(b[0].holderName).toBe("SECRET HOLDER B");
    expect(b.map((c) => c.holderName)).not.toContain("Holding Alpha");
  });

  it("Vision Entité : le compte hors scope reste masqué AVEC son titulaire", async () => {
    const anna = await withWorkspace(sessionAnna, (tx) => listerComptes(tx));
    // ANNA (scopée E1) voit ACC_A1 seul ; ACC_A2 (entity_id NULL) est masqué
    // fail-closed — donc aucun holder « fantôme » ne fuit par la jointure.
    expect(anna.map((c) => c.bankAccountId)).toEqual([ACC_A1]);
    expect(anna[0].holderName).toBe("Holding Alpha");
  });
});
