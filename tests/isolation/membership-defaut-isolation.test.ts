/**
 * Suite d'isolation — choix du workspace par défaut au login (DASH-WSACTIF1).
 *
 * `membershipParDefaut` choisit le workspace de l'utilisateur qui contient le
 * plus de comptes bancaires, pour que le dashboard affiche des chiffres dès la
 * connexion (le « 0,00 Rs » venait d'un choix arbitraire par UUID). Ce test
 * prouve : (1) le bon workspace est choisi ; (2) le départage est déterministe
 * par nom à égalité ; (3) aucun membership → null ; (4) AUCUNE fuite — un tenant
 * dont l'utilisateur n'est pas membre n'est jamais compté ni choisi, même s'il
 * regorge de comptes.
 *
 * Comme la suite anti-IDOR de référence, les requêtes tournent sous `tygr_app`
 * (rôle NON-propriétaire) — sans quoi la RLS serait ignorée et le test
 * prouverait du vide. Migrations + provisioning réels (source unique de vérité).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { creerRepositoryIdentite } from "@/server/repositories/identite";

const client = new PGlite();
const db = drizzle(client, { schema });
const identite = creerRepositoryIdentite(db);

// Workspaces. Noms choisis pour exercer le départage par NOM (ASC) :
// « Alpha BU » < « Omega BU » alphabétiquement.
const WS_GROUPE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // « Zeta Groupe », 0 compte
const WS_PLEIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // « Alpha BU », 3 comptes
const WS_AUTRE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // « Tenant Étranger », 9 comptes — NON membre
const WS_EGAL_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // « Beta BU », 2 comptes
const WS_EGAL_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // « Gamma BU », 2 comptes

// Utilisateurs.
const DORIS = "11111111-1111-4111-8111-111111111111"; // membre GROUPE(0) + PLEIN(3)
const EVE = "22222222-2222-4222-8222-222222222222"; // membre EGAL_A(2) + EGAL_B(2) — égalité
const FRANK = "33333333-3333-4333-8333-333333333333"; // membre d'un seul (GROUPE)
const GINA = "44444444-4444-4444-8444-444444444444"; // AUCUN membership

// Connexions (une par workspace ; uuids explicites, préfixe par workspace).
const CONN_GROUPE = "f1111111-1111-4111-8111-111111111111";
const CONN_PLEIN = "f2222222-2222-4222-8222-222222222222";
const CONN_AUTRE = "f3333333-3333-4333-8333-333333333333";
const CONN_EGAL_A = "f4444444-4444-4444-8444-444444444444";
const CONN_EGAL_B = "f5555555-5555-4555-8555-555555555555";

/**
 * Génère les VALUES de N comptes bancaires pour un workspace. `lettre` est un
 * chiffre hexa servant de préfixe d'UUID lisible et distinct par workspace
 * (chaque compte = `<lettre><i>...`). omnifi_account_id globalement unique.
 */
function comptes(ws: string, conn: string, lettre: string, n: number): string {
  const lignes: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${lettre}${i}000000-0000-4000-8000-000000000000`;
    const omnifi = `acct-${lettre}-${i}`;
    lignes.push(
      `('${id}', '${ws}', '${conn}', '${omnifi}', 'Compte ${i}', 'MUR', true)`,
    );
  }
  return lignes.join(",\n");
}

beforeAll(async () => {
  // 1. Migrations réelles.
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of raw.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await client.exec(statement);
      }
    }
  }

  // 2. Seed (owner — bypass RLS volontaire pour les données de test).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_GROUPE}',  'Zeta Groupe',      'CONSOLIDATION', 'enduser-groupe'),
      ('${WS_PLEIN}',   'Alpha BU',         'INTERNAL_BU',   'enduser-plein'),
      ('${WS_AUTRE}',   'Tenant Étranger',  'EXTERNAL_CLIENT','enduser-autre'),
      ('${WS_EGAL_A}',  'Beta BU',          'INTERNAL_BU',   'enduser-egal-a'),
      ('${WS_EGAL_B}',  'Gamma BU',         'INTERNAL_BU',   'enduser-egal-b');

    insert into users (id, email, full_name) values
      ('${DORIS}', 'doris@groupe.mu', 'Doris'),
      ('${EVE}',   'eve@groupe.mu',   'Eve'),
      ('${FRANK}', 'frank@groupe.mu', 'Frank'),
      ('${GINA}',  'gina@groupe.mu',  'Gina');

    insert into workspace_members (user_id, workspace_id, role) values
      ('${DORIS}', '${WS_GROUPE}', 'ADMIN'),
      ('${DORIS}', '${WS_PLEIN}',  'MANAGER'),
      ('${EVE}',   '${WS_EGAL_A}', 'MANAGER'),
      ('${EVE}',   '${WS_EGAL_B}', 'MANAGER'),
      ('${FRANK}', '${WS_GROUPE}', 'VIEWER');

    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, status, created_by) values
      ('${CONN_GROUPE}',  '${WS_GROUPE}',  'conn-groupe',  'inst', 'active', '${DORIS}'),
      ('${CONN_PLEIN}',   '${WS_PLEIN}',   'conn-plein',   'inst', 'active', '${DORIS}'),
      ('${CONN_AUTRE}',   '${WS_AUTRE}',   'conn-autre',   'inst', 'active', '${DORIS}'),
      ('${CONN_EGAL_A}',  '${WS_EGAL_A}',  'conn-egal-a',  'inst', 'active', '${EVE}'),
      ('${CONN_EGAL_B}',  '${WS_EGAL_B}',  'conn-egal-b',  'inst', 'active', '${EVE}');

    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, is_selected) values
      ${comptes(WS_PLEIN, CONN_PLEIN, "b", 3)},
      ${comptes(WS_AUTRE, CONN_AUTRE, "c", 9)},
      ${comptes(WS_EGAL_A, CONN_EGAL_A, "d", 2)},
      ${comptes(WS_EGAL_B, CONN_EGAL_B, "e", 2)};
  `);

  // 3. Rôle applicatif non-propriétaire (source unique : provisioning prod).
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
  it("0. les requêtes tournent sous tygr_app (sinon la RLS est ignorée)", async () => {
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

describe("membershipParDefaut — choix du workspace le plus peuplé (DASH-WSACTIF1)", () => {
  it("1. choisit le workspace avec le PLUS de comptes (BU pleine > groupe vide)", async () => {
    // Doris : Zeta Groupe (0 compte) + Alpha BU (3 comptes) → Alpha BU.
    // C'EST le fix du « 0,00 Rs » : sans lui, le tri par UUID aurait pu
    // renvoyer Zeta Groupe (aaaa… < bbbb…), workspace vide.
    expect(await identite.membershipParDefaut(DORIS)).toBe(WS_PLEIN);
  });

  it("2. à égalité de comptes, départage DÉTERMINISTE par nom (ASC)", async () => {
    // Eve : Beta BU (2) et Gamma BU (2) → égalité. « Beta » < « Gamma » → Beta BU.
    expect(await identite.membershipParDefaut(EVE)).toBe(WS_EGAL_A);
  });

  it("3. un seul workspace → ce workspace (même s'il a 0 compte)", async () => {
    // Frank : membre du seul Zeta Groupe (0 compte). On le renvoie quand même —
    // c'est son unique workspace (le fix ne crée pas d'utilisateur sans défaut).
    expect(await identite.membershipParDefaut(FRANK)).toBe(WS_GROUPE);
  });

  it("4. aucun membership → null (chemin AucunWorkspaceActifError en amont)", async () => {
    expect(await identite.membershipParDefaut(GINA)).toBeNull();
  });

  it("5. ISOLATION : un tenant NON membre, même bourré de comptes, n'est jamais choisi", async () => {
    // « Tenant Étranger » a 9 comptes (le plus gros de la base) mais Doris n'en
    // est pas membre → il n'apparaît jamais dans son choix. Doris reste sur
    // Alpha BU (3), pas sur le tenant à 9. Preuve qu'on ne compte QUE ses
    // workspaces (own_memberships_select), jamais ceux d'autrui.
    expect(await identite.membershipParDefaut(DORIS)).not.toBe(WS_AUTRE);
    expect(await identite.membershipParDefaut(DORIS)).toBe(WS_PLEIN);
  });

  it("6. le GUC workspace posé pendant le comptage NE fuit PAS hors de la fonction", async () => {
    // membershipParDefaut pose app.current_workspace_id en transaction (local) ;
    // une fois revenu, le contexte ne doit pas rester « collé » à un workspace
    // (sinon une requête suivante hériterait d'un scope non voulu). On vérifie
    // qu'après l'appel, hors transaction, aucun workspace n'est en contexte →
    // bank_accounts rend 0 ligne (fail-closed), preuve que le GUC était bien
    // transaction-local.
    await identite.membershipParDefaut(DORIS);
    const res = await client.query("select * from bank_accounts");
    expect(res.rows).toHaveLength(0);
  });
});
