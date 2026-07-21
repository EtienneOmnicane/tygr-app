/**
 * Suite anti-IDOR — signal « hors périmètre » du dashboard (NUDGE-VISION-ENTITE1).
 *
 * CE QUI EST EN JEU. Pour distinguer « cet espace n'a aucune banque » de « ses comptes
 * ne me sont pas accessibles », le dashboard compte les connexions du TENANT
 * (`compterConnexionsTenant`). Un compteur qui ignore un filtre est exactement la forme
 * que prend une fuite : cette suite prouve que celui-ci reste borné au workspace, et
 * qu'il n'a acheté aucune visibilité sur les comptes au passage.
 *
 * Pourquoi `bank_connections` et pas `bank_accounts` : cette table ne porte QUE
 * `tenant_isolation` (0003), jamais `entity_scope`. Le comptage est donc borné par la
 * RLS elle-même. Compter les comptes « hors scope » aurait exigé de neutraliser
 * `app.current_entity_scope` — c'est-à-dire de contourner l'étage 2 (CLAUDE.md règle 2).
 * Le test 3 fige cette propriété : le compteur est INSENSIBLE au périmètre entité, ce
 * qui est précisément ce qui le rend utilisable sans le rendre indiscret.
 *
 * Pattern du dossier : DDL = migrations réelles, rôle applicatif = provisioning prod,
 * exécution sous `tygr_app` NON-propriétaire (sinon la RLS est ignorée — test 0).
 * Fixtures propres à cette suite (chaque fichier du dossier est autonome).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  compterConnexionsTenant,
  listerComptes,
} from "@/server/repositories/dashboard";
import { choisirEtatDashboard } from "@/lib/etat-dashboard";
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes (lisibilité des assertions) ───────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // WS_A, aucun scope → Globale
const SCOPED_VIDE = "22222222-2222-4222-8222-222222222222"; // WS_A, scopé sur ENT_VIDE
const MEMBRE_B = "33333333-3333-4333-8333-333333333333"; // WS_B (témoin étage 1)

const ENT_LOGISTIQUE = "e0100000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A, PORTE un compte
const ENT_VIDE = "e0200000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // WS_A, AUCUN compte
const ENT_B = "e0300000-cccc-4ccc-8ccc-cccccccccccc"; // WS_B (témoin)

// WS_A porte DEUX connexions : un COUNT qui renverrait 1 (un `limit` oublié) ou 3
// (la connexion de WS_B comptée) échouerait de façon distincte.
const CONN_A1 = "c0a10000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_A2 = "c0a20000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONN_B = "c0b00000-cccc-4ccc-8ccc-cccccccccccc";

const ACC_LOGISTIQUE = "acc01000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // → ENT_LOGISTIQUE
const ACC_NON_ASSIGNE = "acc02000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // entity_id NULL
const ACC_B = "acc0b000-cccc-4ccc-8ccc-cccccccccccc"; // WS_B

const sessGlobale = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessScopedVide = { userId: SCOPED_VIDE, activeWorkspaceId: WS_A };
const sessB = { userId: MEMBRE_B, activeWorkspaceId: WS_B };

beforeAll(async () => {
  // 1. Migrations réelles (le DDL que la prod exécutera).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou anti-faux-vert : `bank_connections` doit porter `tenant_isolation`
  //    et AUCUNE policy de périmètre. C'est l'hypothèse EXACTE sur laquelle repose le
  //    choix de cette table pour le comptage. Si une migration future y posait un
  //    `entity_scope`, le compteur deviendrait silencieusement dépendant du périmètre
  //    (l'état « hors périmètre » ne se déclencherait plus jamais) : cette suite doit
  //    échouer BRUYAMMENT ce jour-là, pas rendre un vert trompeur.
  const pol = await client.query<{ policyname: string; permissive: string }>(
    `select policyname, permissive from pg_policies where tablename = 'bank_connections'`,
  );
  const noms = pol.rows.map((r) => r.policyname).sort();
  if (!noms.includes("tenant_isolation")) {
    throw new Error(
      `bank_connections doit porter tenant_isolation (étage 1) — trouvé : ${JSON.stringify(noms)}.`,
    );
  }
  const parasites = noms.filter((n) => n !== "tenant_isolation");
  if (parasites.length > 0) {
    throw new Error(
      `bank_connections porte une policy de périmètre inattendue : ${JSON.stringify(parasites)}. ` +
        `compterConnexionsTenant suppose un comptage NON scopé par entité — relire ` +
        `PLAN-nudge-vision-entite.md §2 avant de toucher à cette table.`,
    );
  }

  // 3. Seed owner (bypass RLS). WS_A : 2 connexions, 1 compte assigné à ENT_LOGISTIQUE,
  //    1 compte non assigné, et une entité ENT_VIDE qui ne porte AUCUN compte — c'est
  //    elle qui reproduit le cas réel (membre scopé qui ne voit rien).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${SCOPED_VIDE}','scoped@a.mu','Scoped Vide'),
      ('${MEMBRE_B}','membre@b.mu','Membre B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${SCOPED_VIDE}','${WS_A}','VIEWER'),
      ('${MEMBRE_B}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_LOGISTIQUE}','${WS_A}','Logistique','LOG',true),
      ('${ENT_VIDE}','${WS_A}','Nouvelle BU','NBU',true),
      ('${ENT_B}','${WS_B}','Entité B','XB',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A1}','${WS_A}','oc-a1','mcb','${ADMIN_A}'),
      ('${CONN_A2}','${WS_A}','oc-a2','sbm','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${MEMBRE_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_LOGISTIQUE}','${WS_A}','${CONN_A1}','oa-log','Compte Logistique','MUR','5000.00',true,'${ENT_LOGISTIQUE}'),
      ('${ACC_NON_ASSIGNE}','${WS_A}','${CONN_A2}','oa-none','Compte Non Assigné','MUR','1000.00',true,null),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true,'${ENT_B}');
    -- Vision Entité : SCOPED_VIDE ne couvre QUE l'entité SANS compte. ADMIN_A n'a
    -- AUCUNE ligne → Vision Globale.
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${SCOPED_VIDE}','${ENT_VIDE}');
  `);

  // 4. Rôle applicatif non-propriétaire (source unique : provisioning prod).
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
  it("0. requêtes sous tygr_app (sinon la RLS est ignorée et tout passe)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

describe("étage 1 — le compteur de connexions ne franchit pas la frontière tenant", () => {
  it("1. WS_A ne compte QUE ses 2 connexions (celle de WS_B est invisible)", async () => {
    const n = await withWorkspace(sessGlobale, (tx) =>
      compterConnexionsTenant(tx),
    );
    expect(n).toBe(2);
  });

  it("2. WS_B ne compte QUE la sienne — et le total de la table vaut 3 (contre-preuve)", async () => {
    const n = await withWorkspace(sessB, (tx) => compterConnexionsTenant(tx));
    expect(n).toBe(1);

    // Contre-preuve : sans RLS (owner), la table en contient bien 3. Si les deux
    // assertions ci-dessus renvoyaient 3, le test passerait « par hasard » sur un
    // compteur non filtré — c'est ce total qui rend l'écart significatif.
    await client.exec(`reset role;`);
    const total = await client.query<{ n: number }>(
      `select count(*)::int as n from bank_connections`,
    );
    await client.exec(`set role tygr_app;`);
    expect(total.rows[0].n).toBe(3);
  });
});

describe("étage 2 — le compteur n'achète aucune visibilité sur les comptes", () => {
  it("3. le compteur est INSENSIBLE au périmètre entité (Globale == Entité)", async () => {
    // Propriété RECHERCHÉE, pas un effet de bord : c'est elle qui permet de détecter
    // « le tenant a une banque » depuis un périmètre qui n'en voit aucun compte. Elle
    // prouve aussi que le comptage ne joint jamais bank_accounts.
    const globale = await withWorkspace(sessGlobale, (tx) =>
      compterConnexionsTenant(tx),
    );
    const scope = await withWorkspace(sessScopedVide, (tx) =>
      compterConnexionsTenant(tx),
    );
    expect(scope).toBe(globale);
    expect(scope).toBe(2);
  });

  it("4. sous Vision Entité vide, AUCUN compte ne devient visible", async () => {
    // Le cœur de la non-régression : le nouveau signal ne doit rien assouplir. Ni le
    // compte d'une autre entité, ni le compte NON assigné (invisible en Vision Entité,
    // fail-closed), ni évidemment celui de WS_B.
    const comptes = await withWorkspace(sessScopedVide, (tx) =>
      listerComptes(tx),
    );
    expect(comptes).toEqual([]);
  });

  it("5. en Vision Globale, les comptes du tenant restent visibles (contre-preuve)", async () => {
    // Sans ce témoin, le test 4 passerait aussi si `listerComptes` était cassée.
    const comptes = await withWorkspace(sessGlobale, (tx) => listerComptes(tx));
    const ids = comptes.map((c) => c.bankAccountId).sort();
    expect(ids).toEqual([ACC_LOGISTIQUE, ACC_NON_ASSIGNE].sort());
    expect(ids).not.toContain(ACC_B); // étage 1 : jamais le compte de WS_B
  });
});

describe("bout en bout — l'état d'affichage résolu depuis les VRAIES lectures", () => {
  /** Enveloppe minimale : seuls `comptes` et les deux drapeaux décident de l'état. */
  const donneesDepuis = (
    comptes: Awaited<ReturnType<typeof listerComptes>>,
    aDesConnexionsTenant: boolean,
    lecteurBorne: boolean,
  ): DonneesDashboard => ({
    comptes,
    soldesParDevise: [],
    flux: [],
    synthesesMois: [],
    topVendors: { direction: "outflow", lignes: [] },
    serieMensuelle: [],
    grilleMensuelle: [],
    prevision: null,
    transactionsRecentes: [],
    aDesConnexionsTenant,
    lecteurBorne,
  });

  it("6. membre scopé sur une entité sans compte → HORS PÉRIMÈTRE, jamais « vide »", async () => {
    // Le défaut que ce lot corrige, reproduit de bout en bout sur les vraies lectures :
    // l'écran affichait « Aucune banque n'est encore connectée à cet espace » alors que
    // le tenant en a DEUX — et que /banques les lui montre dans la même session.
    const { comptes, nbConnexions, borne } = await withWorkspace(
      sessScopedVide,
      async (tx, ctx) => ({
        comptes: await listerComptes(tx),
        nbConnexions: await compterConnexionsTenant(tx),
        borne:
          ctx.entityScope.mode === "ENTITES" ||
          ctx.accountScope.mode === "COMPTES",
      }),
    );

    expect(comptes).toEqual([]);
    expect(nbConnexions).toBeGreaterThan(0);
    expect(borne).toBe(true);
    expect(
      choisirEtatDashboard(donneesDepuis(comptes, nbConnexions > 0, borne)),
    ).toBe("hors-perimetre");
  });

  it("7. ADMIN en Vision Globale n'atteint JAMAIS l'état hors périmètre", async () => {
    // Garde-fou du constat de cross-review : une connexion peut exister sans compte
    // visible pour des raisons étrangères au périmètre (découverte vide, comptes
    // écartés). Dire à un ADMIN non borné « un administrateur peut vous donner accès »
    // serait un mensonge. Le drapeau `lecteurBorne` est ce qui l'empêche — on le vérifie
    // ici sur le CONTEXTE réel, pas sur une valeur fabriquée.
    const { nbConnexions, borne } = await withWorkspace(
      sessGlobale,
      async (tx, ctx) => ({
        nbConnexions: await compterConnexionsTenant(tx),
        borne:
          ctx.entityScope.mode === "ENTITES" ||
          ctx.accountScope.mode === "COMPTES",
      }),
    );

    expect(borne).toBe(false);
    // Même avec zéro compte visible ET des connexions au tenant : l'état reste « vide ».
    expect(
      choisirEtatDashboard(donneesDepuis([], nbConnexions > 0, borne)),
    ).toBe("vide");
  });
});
