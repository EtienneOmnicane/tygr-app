/**
 * Epic 2 — bascule (S1) + provisioning ADMIN (S3) + cas IDOR (S4), sur PGlite
 * avec migrations réelles + provisioning tygr_app + rôle non-owner (mêmes
 * conditions que la suite isolation). Ces tests sont BLOQUANTS (anti-IDOR).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import argon2 from "argon2";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import {
  createWithWorkspace,
  WorkspaceAccessDeniedError,
} from "@/server/db/tenancy";
import { creerRepositoryIdentite } from "@/server/repositories/identite";
import {
  creerUtilisateurEtRattacher,
  ProvisioningNonAutoriseError,
} from "@/server/repositories/provisioning";
import {
  validerBascule,
  WorkspaceSwitchDeniedError,
} from "@/server/auth/workspace-switch";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);
const identite = creerRepositoryIdentite(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // ADMIN de A
const VIEWER_A = "22222222-2222-4222-8222-222222222222"; // VIEWER de A
const MULTI = "33333333-3333-4333-8333-333333333333"; // membre de A ET B

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(migrationsDir)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const raw = readFileSync(path.join(migrationsDir, f), "utf8");
    for (const s of raw.split("--> statement-breakpoint"))
      if (s.trim()) await client.exec(s);
  }
  // Provisioning tygr_app via le script versionné (source unique).
  await client.exec(
    readFileSync(
      path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
      "utf8",
    ),
  );

  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}', 'Workspace A', 'INTERNAL_BU', 'eu-a'),
      ('${WS_B}', 'Workspace B', 'INTERNAL_BU', 'eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}',  'admin-a@g.mu',  'Admin A'),
      ('${VIEWER_A}', 'viewer-a@g.mu', 'Viewer A'),
      ('${MULTI}',    'multi@g.mu',    'Multi WS');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}',  '${WS_A}', 'ADMIN'),
      ('${VIEWER_A}', '${WS_A}', 'VIEWER'),
      ('${MULTI}',    '${WS_A}', 'MANAGER'),
      ('${MULTI}',    '${WS_B}', 'VIEWER');
  `);
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

describe("bascule de workspace (S1)", () => {
  it("MULTI peut basculer entre ses 2 workspaces", async () => {
    const m = await identite.membershipsDe(MULTI);
    expect(validerBascule(WS_A, m)).toBe(WS_A);
    expect(validerBascule(WS_B, m)).toBe(WS_B);
  });

  it("S4a — IDOR : ADMIN_A ne peut PAS basculer vers WS_B (non-membre) → rejet", async () => {
    const m = await identite.membershipsDe(ADMIN_A); // membre de A seulement
    expect(() => validerBascule(WS_B, m)).toThrow(WorkspaceSwitchDeniedError);
  });
});

describe("provisioning ADMIN (S3)", () => {
  it("un ADMIN crée + rattache un nouvel utilisateur à SON workspace", async () => {
    const hash = await argon2.hash("MotDePasse-initial-123");
    const { userId } = await withWorkspace(
      { userId: ADMIN_A, activeWorkspaceId: WS_A },
      (tx, ctx) =>
        creerUtilisateurEtRattacher(tx, ctx, {
          email: "nouveau@g.mu",
          fullName: "Nouveau Membre",
          passwordHash: hash,
          role: "VIEWER",
        }),
    );
    expect(userId).toBeTruthy();
    // Le membership existe bien dans WS_A (lu par le nouvel utilisateur).
    expect(await identite.membershipsDe(userId)).toEqual([
      { workspaceId: WS_A, role: "VIEWER" },
    ]);
  });

  it("S4b — IDOR : un VIEWER ne peut PAS provisionner → rejet (garde de rôle)", async () => {
    const hash = await argon2.hash("MotDePasse-initial-123");
    await expect(
      withWorkspace({ userId: VIEWER_A, activeWorkspaceId: WS_A }, (tx, ctx) =>
        creerUtilisateurEtRattacher(tx, ctx, {
          email: "intrus@g.mu",
          fullName: "Intrus",
          passwordHash: hash,
          role: "ADMIN",
        }),
      ),
    ).rejects.toBeInstanceOf(ProvisioningNonAutoriseError);
  });

  it("S4c — IDOR : ADMIN_A ne peut pas provisionner dans WS_B (non-membre) → 404 withWorkspace", async () => {
    // ADMIN_A n'est pas membre de WS_B : withWorkspace refuse d'ouvrir le
    // contexte AVANT même d'atteindre creerUtilisateurEtRattacher.
    const hash = await argon2.hash("MotDePasse-initial-123");
    await expect(
      withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_B }, (tx, ctx) =>
        creerUtilisateurEtRattacher(tx, ctx, {
          email: "cross@g.mu",
          fullName: "Cross Tenant",
          passwordHash: hash,
          role: "VIEWER",
        }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it("aucune ligne intruse n'a persisté (ceinture-bretelles, vérifié en owner)", async () => {
    await client.exec(`reset role;`);
    const intrus = await client.query(
      `select 1 from users where email in ('intrus@g.mu','cross@g.mu')`,
    );
    await client.exec(`set role tygr_app;`);
    expect(intrus.rows).toHaveLength(0);
  });
});
