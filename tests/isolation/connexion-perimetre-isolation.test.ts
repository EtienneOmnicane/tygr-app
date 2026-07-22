/**
 * Suite anti-IDOR — refus NOMMÉ de connexion bancaire hors périmètre
 * (ENTITY-CONNEXION-REFUS-NOMME1).
 *
 * CE QUI EST EN JEU. Connecter une banque CRÉE des comptes neufs, et un compte neuf naît
 * `entity_id = NULL` (l'ingestion n'assigne jamais d'entité — CLAUDE.md « Entités
 * multi-tenant »). Les deux policies RESTRICTIVE de `bank_accounts` refusent donc cet
 * INSERT dès qu'un périmètre est posé. Ce fail-closed est VOULU et PRÉEXISTE à ce lot :
 * la sécurité n'est pas le sujet ici. Le sujet est que le refus n'avait pas de NOM — il
 * remontait en 42501 noyé dans « La connexion bancaire a échoué. Réessayez. », et un
 * membre borné réessayait indéfiniment un geste qui ne lui appartient pas (règle 3 :
 * chaque erreur a un nom, catch-all interdit).
 *
 * ⚠️ CE QUE CETTE SUITE PROUVE, ET CE QU'ELLE NE PROUVE PAS. Elle prouve que le refus
 * est nommé sur les DEUX chemins (garde amont + ceinture 42501 à l'écriture) et que la
 * garde n'a rien acheté d'autre. Elle ne prouve PAS l'isolation elle-même : celle-ci
 * appartient aux policies `entity_scope` (0014) et `account_scope` (0016), couvertes par
 * leurs propres suites. Supprimer la garde applicative dégraderait le message, jamais
 * l'isolation — c'est exactement pour cela que le test 4 (contre-preuve de non-régression
 * d'écriture) reste indispensable.
 *
 * LE PIÈGE QUE CETTE FIXTURE DÉSAMORCE. `estLecteurBorne` est un OU de deux clauses, et
 * `ENTITES` implique toujours `COMPTES` (les entités sont traduites en comptes par
 * `withWorkspace`). Une fixture qui borne un membre par `member_entity_scopes` rend donc
 * les DEUX clauses vraies à la fois : supprimer la clause `accountScope` laisserait une
 * telle suite VERTE. Seul un membre borné UNIQUEMENT par `user_scopes` (zéro ligne
 * `member_entity_scopes`) épingle la seconde clause isolément — c'est le rôle de
 * MGR_COMPTE, et le test 1 asserte explicitement que les deux axes ne sont PAS corrélés.
 *
 * Pattern du dossier : DDL = migrations réelles, rôle applicatif = provisioning prod,
 * exécution sous `tygr_app` NON-propriétaire (sinon la RLS est ignorée — test 0).
 * Fixtures propres à cette suite (chaque fichier du dossier est autonome).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/server/db/schema";
import {
  createWithWorkspace,
  estLecteurBorne,
  WorkspaceAccessDeniedError,
  type ExecuterWorkspace,
} from "@/server/db/tenancy";
import type { OmniFiAccount, OmniFiClient } from "@/server/omnifi";
import {
  ConnexionHorsPerimetreError,
  ConnexionNonAutoriseeError,
  demarrerConnexion,
  persisterConnexionEtComptes,
} from "@/server/widget/orchestration";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes (lisibilité des assertions) ───────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Les acteurs bornés sont MANAGER, jamais VIEWER : `demarrerConnexion` teste
// `peutModifier(ctx.role)` AVANT `estLecteurBorne(ctx)`. Sous un VIEWER, la garde de
// périmètre serait inatteignable et les tests 2/3 passeraient pour la mauvaise raison
// (c'est précisément ce que le test 5 verrouille).
const MGR_GLOBAL = "11111111-1111-4111-8111-111111111111"; // aucun scope → Vision Globale
const MGR_ENTITE = "22222222-2222-4222-8222-222222222222"; // member_entity_scopes SEUL
const MGR_COMPTE = "33333333-3333-4333-8333-333333333333"; // user_scopes SEUL (axe pur)
const VIEWER_BORNE = "44444444-4444-4444-8444-444444444444"; // VIEWER *et* borné
const MGR_B = "55555555-5555-4555-8555-555555555555"; // WS_B (témoin étage 1)

const ENT_SUCRE = "e0100000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A
const CONN_A = "c0a10000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_SUCRE = "acc01000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A, → ENT_SUCRE

const execWs =
  (userId: string, workspaceId: string): ExecuterWorkspace =>
  (fn) =>
    withWorkspace({ userId, activeWorkspaceId: workspaceId }, fn);

/**
 * Client Omni-FI FACTICE (aucun réseau). Seul `creerLinkToken` compte ici : les
 * assertions `not.toHaveBeenCalled()` sur ce spy sont la preuve qu'un refus de périmètre
 * n'a coûté AUCUN appel amont.
 */
function clientFactice(): OmniFiClient {
  return {
    creerLinkToken: vi.fn().mockResolvedValue({
      LinkToken: "lt_x",
      Expiration: "2026-07-22T00:15:00Z",
    }),
  } as unknown as OmniFiClient;
}

/** Compte Omni-FI minimal et VALIDE pour le chemin d'écriture. */
function compteAmont(accountId: string): OmniFiAccount {
  return {
    AccountId: accountId,
    Status: "Enabled",
    Currency: "MUR",
    PartyName: "Titulaire",
    Balances: [
      { Type: "ITAV", Amount: { Amount: "5000.00", Currency: "MUR" } },
    ],
  } as unknown as OmniFiAccount;
}

/** omnifi_account_id de TOUS les comptes de la base, lus sous l'OWNER (hors RLS). */
async function comptesEnBaseSousOwner(): Promise<string[]> {
  await client.exec(`reset role;`);
  const r = await client.query<{ oa: string }>(
    `select omnifi_account_id as oa from bank_accounts order by omnifi_account_id`,
  );
  await client.exec(`set role tygr_app;`);
  return r.rows.map((l) => l.oa);
}

beforeAll(async () => {
  // 1. Migrations réelles (le DDL que la prod exécutera).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou anti-faux-vert : `bank_accounts` DOIT porter au moins une policy
  //    RESTRICTIVE applicable au rôle applicatif. C'est l'hypothèse EXACTE dont dépend
  //    toute cette suite : sans elle, l'INSERT d'un compte neuf par un membre borné
  //    PASSERAIT, la ceinture 42501 ne se déclencherait jamais, et les tests 6/7
  //    échoueraient de façon obscure (« attendu ConnexionHorsPerimetreError, reçu
  //    rien »). On veut un échec BRUYANT et explicite ce jour-là.
  const pol = await client.query<{
    policyname: string;
    permissive: string;
    roles: string;
  }>(
    `select policyname, permissive, roles::text as roles
     from pg_policies where tablename = 'bank_accounts'`,
  );
  const restrictivesApplicables = pol.rows.filter(
    (r) =>
      r.permissive === "RESTRICTIVE" &&
      (r.roles.includes("public") || r.roles.includes("tygr_app")),
  );
  if (restrictivesApplicables.length === 0) {
    throw new Error(
      `bank_accounts ne porte AUCUNE policy RESTRICTIVE applicable au rôle applicatif — ` +
        `trouvé : ${JSON.stringify(pol.rows.map((r) => r.policyname))}. Le refus de ` +
        `périmètre à l'INSERT (42501) que cette suite prouve REPOSE sur elles ` +
        `(entity_scope 0014, account_scope 0016).`,
    );
  }

  // 3. Seed owner (bypass RLS). WS_A porte une connexion et un compte DÉJÀ assignés à
  //    ENT_SUCRE — ils servent de cible aux scopes, pas d'objet de test.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','enduser-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','enduser-b');
    insert into users (id, email, full_name) values
      ('${MGR_GLOBAL}','global@a.mu','Manager Global'),
      ('${MGR_ENTITE}','entite@a.mu','Manager Entité'),
      ('${MGR_COMPTE}','compte@a.mu','Manager Compte'),
      ('${VIEWER_BORNE}','viewer@a.mu','Viewer Borné'),
      ('${MGR_B}','mgr@b.mu','Manager B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${MGR_GLOBAL}','${WS_A}','MANAGER'),
      ('${MGR_ENTITE}','${WS_A}','MANAGER'),
      ('${MGR_COMPTE}','${WS_A}','MANAGER'),
      ('${VIEWER_BORNE}','${WS_A}','VIEWER'),
      ('${MGR_B}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière','SUC',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a1','mcb','${MGR_GLOBAL}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_SUCRE}','${WS_A}','${CONN_A}','oa-sucre','Compte Sucrière','MUR','5000.00',true,'${ENT_SUCRE}');

    -- Axe ENTITÉ pur : MGR_ENTITE est borné par member_entity_scopes.
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${MGR_ENTITE}','${ENT_SUCRE}'),
      ('${WS_A}','${VIEWER_BORNE}','${ENT_SUCRE}');

    -- Axe COMPTE pur : MGR_COMPTE n'a AUCUNE ligne member_entity_scopes — son périmètre
    -- ne vient QUE d'ici. Il résout donc entityScope=GLOBALE et accountScope=COMPTES,
    -- la seule combinaison qui épingle la clause « compte » de estLecteurBorne isolément
    -- (cf. docstring de tête : sans lui, la suite serait verte sans cette clause).
    insert into user_scopes (workspace_id, user_id, bank_account_id) values
      ('${WS_A}','${MGR_COMPTE}','${ACC_SUCRE}');
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

  it("1. la fixture SÉPARE les deux axes de estLecteurBorne (anti-corrélation)", async () => {
    const lire = (userId: string) =>
      withWorkspace({ userId, activeWorkspaceId: WS_A }, async (_tx, ctx) => ({
        entite: ctx.entityScope.mode,
        compte: ctx.accountScope.mode,
        // La VRAIE fonction, jamais une copie de sa formule : une copie ici et une
        // autre en production rendrait ce test tautologique (docstring de tenancy.ts).
        borne: estLecteurBorne(ctx),
      }));

    // Vision Globale : aucune des deux clauses.
    expect(await lire(MGR_GLOBAL)).toEqual({
      entite: "GLOBALE",
      compte: "GLOBALE",
      borne: false,
    });

    // Axe ENTITÉ : `ENTITES` implique `COMPTES` — les deux clauses sont vraies, ce
    // membre ne peut donc PAS prouver la clause `accountScope` à lui seul.
    expect(await lire(MGR_ENTITE)).toEqual({
      entite: "ENTITES",
      compte: "COMPTES",
      borne: true,
    });

    // Axe COMPTE PUR : entityScope reste GLOBALE. C'est CE cas — et lui seul — qui
    // épingle la seconde clause. Si cette assertion tombe à `entite: "ENTITES"`, la
    // fixture a été corrélée et les tests 3 et 7 ne prouvent plus rien.
    expect(await lire(MGR_COMPTE)).toEqual({
      entite: "GLOBALE",
      compte: "COMPTES",
      borne: true,
    });
  });
});

describe("demarrerConnexion — le refus de périmètre précède tout appel amont", () => {
  it("2. axe ENTITÉ : refus nommé, sans solliciter Omni-FI", async () => {
    const c = clientFactice();
    await expect(
      demarrerConnexion(c, execWs(MGR_ENTITE, WS_A), {
        redirectOrigin: "https://app.mu",
      }),
    ).rejects.toBeInstanceOf(ConnexionHorsPerimetreError);
    // Le cœur du lot : échouer AVANT le LinkToken. Sans cette garde, le membre
    // traversait tout le widget — identifiants bancaires et OTP saisis — pour échouer
    // à la dernière étape.
    expect(c.creerLinkToken).not.toHaveBeenCalled();
  });

  it("3. axe COMPTE SEUL : refus nommé, sans solliciter Omni-FI", async () => {
    const c = clientFactice();
    await expect(
      demarrerConnexion(c, execWs(MGR_COMPTE, WS_A), {
        redirectOrigin: "https://app.mu",
      }),
    ).rejects.toBeInstanceOf(ConnexionHorsPerimetreError);
    expect(c.creerLinkToken).not.toHaveBeenCalled();
  });

  it("4. contre-preuve : un MANAGER non borné démarre normalement", async () => {
    const c = clientFactice();
    const r = await demarrerConnexion(c, execWs(MGR_GLOBAL, WS_A), {
      redirectOrigin: "https://app.mu",
    });
    expect(r.linkToken).toBe("lt_x");
    // Le ClientUserId vient du WORKSPACE, jamais d'un paramètre (frontière tenant).
    // Sans cette assertion positive, les `not.toHaveBeenCalled` ci-dessus passeraient
    // aussi sur un `demarrerConnexion` cassé qui n'appelle plus jamais l'amont.
    expect(c.creerLinkToken).toHaveBeenCalledWith(
      expect.objectContaining({
        ClientUserId: "enduser-a",
        RedirectOrigin: "https://app.mu",
      }),
    );
  });

  it("5. le RÔLE prime sur le PÉRIMÈTRE : un VIEWER borné est refusé pour son rôle", async () => {
    const c = clientFactice();
    // VIEWER_BORNE cumule les deux causes de refus. L'ordre des gardes décide laquelle
    // le nomme — et ce doit être le rôle : « Action non autorisée. » (MESSAGE_REFUS)
    // sanctionne un droit, là où le message de périmètre oriente vers un administrateur.
    // Les intervertir dirait au VIEWER que son périmètre est en cause, ce qui est faux.
    await expect(
      demarrerConnexion(c, execWs(VIEWER_BORNE, WS_A), {
        redirectOrigin: "https://app.mu",
      }),
    ).rejects.toBeInstanceOf(ConnexionNonAutoriseeError);
    expect(c.creerLinkToken).not.toHaveBeenCalled();
  });
});

describe("ceinture 42501 — le chemin d'ÉCRITURE nomme aussi le refus", () => {
  // Les Server Actions de finalisation sont atteignables SANS être passé par le
  // démarrage (une action est un POST : rien n'oblige à enchaîner les étapes). Sans
  // cette ceinture, ces chemins-là garderaient le catch-all générique.

  it("6. axe ENTITÉ : l'INSERT du compte neuf est refusé et NOMMÉ", async () => {
    await expect(
      persisterConnexionEtComptes(
        execWs(MGR_ENTITE, WS_A),
        { ConnectionId: "oc-refus-entite", InstitutionId: "mcb" },
        [compteAmont("oa-refus-entite")],
      ),
    ).rejects.toBeInstanceOf(ConnexionHorsPerimetreError);
  });

  it("7. axe COMPTE SEUL : idem — l'id d'un compte NEUF n'est jamais dans le droit", async () => {
    await expect(
      persisterConnexionEtComptes(
        execWs(MGR_COMPTE, WS_A),
        { ConnectionId: "oc-refus-compte", InstitutionId: "mcb" },
        [compteAmont("oa-refus-compte")],
      ),
    ).rejects.toBeInstanceOf(ConnexionHorsPerimetreError);
  });

  it("8. la ceinture ne MAQUILLE pas les autres échecs (42501 seul est traduit)", async () => {
    // Un membre de WS_B visant WS_A échoue à la frontière TENANT. Cette erreur-là doit
    // remonter À L'IDENTIQUE : la maquiller en refus de périmètre dirait à un intrus
    // « votre périmètre est insuffisant », ce qui confirmerait l'existence du workspace
    // (oracle) tout en effaçant un signal de sécurité. C'est le catch-all que la
    // règle 3 interdit, et le mode de défaillance principal d'un `catch` par SQLSTATE.
    await expect(
      persisterConnexionEtComptes(
        execWs(MGR_B, WS_A),
        { ConnectionId: "oc-intrus", InstitutionId: "mcb" },
        [compteAmont("oa-intrus")],
      ),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it("9. contre-preuve : un MANAGER non borné persiste réellement le compte", async () => {
    // Sans elle, les tests 6/7 passeraient sur un `persisterConnexionEtComptes`
    // universellement cassé (tout refuser n'est pas isoler).
    const n = await persisterConnexionEtComptes(
      execWs(MGR_GLOBAL, WS_A),
      { ConnectionId: "oc-ok", InstitutionId: "mcb" },
      [compteAmont("oa-ok")],
    );
    expect(n).toBe(1);
  });

  it("10. aucun compte n'a été écrit par les tentatives refusées", async () => {
    // La preuve que le refus est bien un ROLLBACK, et non un message posé sur une
    // écriture déjà passée. Lecture sous l'OWNER : un `[]` sous `tygr_app` serait
    // ambigu (RLS ou absence ?) — ici la question ne se pose pas.
    const comptes = await comptesEnBaseSousOwner();
    expect(comptes).toEqual(["oa-ok", "oa-sucre"]);
    expect(comptes).not.toContain("oa-refus-entite");
    expect(comptes).not.toContain("oa-refus-compte");
    expect(comptes).not.toContain("oa-intrus");
  });
});
