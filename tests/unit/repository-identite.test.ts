/**
 * Repository identité sur PGlite — migrations réelles, rôle non-propriétaire
 * (même rigueur que la suite isolation : la RLS n'existe que pour un rôle
 * non-owner). Couvre persistance lockout, fenêtre IP et lookup email.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { VERROU_BASE_MS } from "@/lib/auth/lockout";
import { creerRepositoryIdentite } from "@/repositories/identite";

const client = new PGlite();
const db = drizzle(client, { schema });
const identite = creerRepositoryIdentite(db);

const T0 = new Date("2026-06-12T10:00:00.000Z");
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of raw.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await client.exec(statement);
      }
    }
  }

  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}', 'BU Logistique', 'INTERNAL_BU', 'enduser-ws-a'),
      ('${WS_B}', 'BU Retail',     'INTERNAL_BU', 'enduser-ws-b');
    insert into users (id, email, full_name, password_hash) values
      ('${ALICE}', 'Alice@Groupe.MU', 'Alice Manager', 'hash-fictif'),
      ('${BOB}',   'bob@groupe.mu',   'Bob Manager',   null);
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}', '${WS_A}', 'MANAGER'),
      ('${ALICE}', '${WS_B}', 'VIEWER'),
      ('${BOB}',   '${WS_B}', 'MANAGER');
  `);

  // Rôle applicatif non-propriétaire : conditions de production.
  await client.exec(`
    create role tygr_app nologin;
    grant usage on schema public to tygr_app;
    grant select, insert, update, delete on all tables in schema public to tygr_app;
    set role tygr_app;
  `);
});

afterAll(async () => {
  await client.close();
});

describe("trouverParEmail", () => {
  it("lookup insensible à la casse", async () => {
    const u = await identite.trouverParEmail("ALICE@groupe.mu");
    expect(u?.id).toBe(ALICE);
    expect(u?.passwordHash).toBe("hash-fictif");
  });

  it("email inconnu → null (pas d'erreur)", async () => {
    expect(await identite.trouverParEmail("personne@groupe.mu")).toBeNull();
  });
});

describe("machine d'état lockout persistée", () => {
  it("4 échecs : compteur monte, pas de verrou ; 5e échec : verrou 60s", async () => {
    for (let i = 0; i < 4; i++) {
      await identite.enregistrerEchec(ALICE, T0);
    }
    let u = await identite.trouverParEmail("alice@groupe.mu");
    expect(u?.failedLoginCount).toBe(4);
    expect(u?.lockedUntil).toBeNull();

    await identite.enregistrerEchec(ALICE, T0);
    u = await identite.trouverParEmail("alice@groupe.mu");
    expect(u?.failedLoginCount).toBe(5);
    expect(u?.lockedUntil).toEqual(new Date(T0.getTime() + VERROU_BASE_MS));
  });

  it("succès : remise à zéro complète", async () => {
    await identite.reinitialiserEchecs(ALICE);
    const u = await identite.trouverParEmail("alice@groupe.mu");
    expect(u?.failedLoginCount).toBe(0);
    expect(u?.lockedUntil).toBeNull();
  });

  it("échec sur un utilisateur disparu : silencieux (pas d'oracle)", async () => {
    await expect(
      identite.enregistrerEchec("99999999-9999-4999-8999-999999999999", T0),
    ).resolves.toBeUndefined();
  });
});

describe("fenêtre glissante IP", () => {
  it("ne compte que les tentatives de l'IP dans la fenêtre", async () => {
    // Hors fenêtre (inséré en owner pour contrôler attempted_at).
    await client.exec(`reset role;`);
    await client.exec(`
      insert into login_attempts (ip, succeeded, attempted_at) values
        ('203.0.113.7', false, '${new Date(T0.getTime() - 16 * 60_000).toISOString()}'),
        ('203.0.113.7', false, '${new Date(T0.getTime() - 14 * 60_000).toISOString()}'),
        ('198.51.100.9', false, '${new Date(T0.getTime() - 1_000).toISOString()}');
    `);
    await client.exec(`set role tygr_app;`);

    expect(await identite.compterTentativesIp("203.0.113.7", T0)).toBe(1);
    expect(await identite.compterTentativesIp("198.51.100.9", T0)).toBe(1);
    expect(await identite.compterTentativesIp("192.0.2.1", T0)).toBe(0);
  });

  it("enregistrerTentativeIp insère sous le rôle applicatif", async () => {
    await identite.enregistrerTentativeIp("192.0.2.1", true);
    const apres = new Date(Date.now() + 60_000);
    expect(await identite.compterTentativesIp("192.0.2.1", apres)).toBe(1);
  });
});

describe("membershipsDe (lecture pré-contexte sous RLS)", () => {
  it("retourne les memberships de l'utilisateur, triés par workspace_id", async () => {
    const m = await identite.membershipsDe(ALICE);
    expect(m).toEqual([
      { workspaceId: WS_A, role: "MANAGER" },
      { workspaceId: WS_B, role: "VIEWER" },
    ]);
  });

  it("ne fuit JAMAIS les memberships d'autrui (policy own_memberships_select)", async () => {
    const m = await identite.membershipsDe(BOB);
    expect(m).toEqual([{ workspaceId: WS_B, role: "MANAGER" }]);
    // Et un utilisateur sans membership ne voit rien.
    expect(
      await identite.membershipsDe("99999999-9999-4999-8999-999999999999"),
    ).toEqual([]);
  });
});
