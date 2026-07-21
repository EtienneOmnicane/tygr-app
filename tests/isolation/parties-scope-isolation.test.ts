/**
 * Suite anti-IDOR — ENTITY-PARTIES-SCOPE1 : périmètre d'ÉTAGE 2 sur
 * `account_party_role` (policy `account_scope` RESTRICTIVE FOR ALL, migration
 * 0024). Plan de référence : PLAN-entity-parties-scope.md §4.
 *
 * CE QUE CETTE SUITE PROUVE (et pourquoi elle est séparée) : elle vit dans un
 * fichier NEUF plutôt que dans `parties-isolation.test.ts` — ce dernier couvre
 * l'ÉTAGE 1 (tenant) et doit rester lisible. Confondre les deux étages est la
 * première cause d'erreur d'analyse sur ce dépôt.
 *
 *   0   Précondition : requêtes sous `tygr_app` (sous l'owner, RLS ignorée → toute
 *       la suite serait un faux vert) + garde STRUCTURELLE sur la policy elle-même.
 *   1   ⭐ SELECT DIRECT (sans jointure) sous scope Sucrière → 2 lignes.
 *   2   SELECT DIRECT en Vision Globale → 5 lignes (non-régression).
 *   3   ⭐ `WHERE bank_account_id = <compte hors périmètre>` FORGÉ → 0 ligne.
 *   4   ⭐ INSERT visant un compte hors périmètre → refus WITH CHECK (42501).
 *   5   INSERT d'ingestion en Vision Globale → accepté (garde ANTI-fail-closed).
 *   6   Sentinelle UUID-nul (DROIT = ∅) → 0 ligne, JAMAIS « tout ».
 *   7   `view_filter` — clause prouvée SÉPARÉMENT de `account_scope`.
 *   8   `listerComptes` sous scope Sucrière → le compte hors scope ET son
 *       titulaire restent absents (régression guard du chemin déjà borné).
 *   9   ⚠️ CONTRE-PREUVE VOLONTAIRE (décision D2) : `parties` reste VISIBLE hors
 *       périmètre. À INVERSER le jour où le P2 `parties` sera traité.
 *   10  ⭐ GARDE D'ORDRE (auto-référence du résolveur) : un membre scopé par
 *       PARTY voit bien ses comptes.
 *
 * ── CARDINALITÉS DISTINCTES, à ne pas « simplifier » ────────────────────────
 * La fixture donne 2 lignes `account_party_role` du côté Sucrière et 3 du côté
 * Énergie, et les trois tables en jeu ont des totaux DIFFÉRENTS sur WS_A :
 * `bank_accounts` = 3, `account_party_role` = 5, `parties` = 6. C'est
 * DÉLIBÉRÉ : une fixture symétrique (2/2, ou deux tables au même total) rend
 * plusieurs bugs indétectables — un prédicat pointé sur la MAUVAISE table
 * (mutation-check n°4) produirait alors exactement le même compte de lignes et
 * la suite resterait verte. Une fixture antérieure de ce dépôt corrélait deux
 * clauses d'un OR et n'en testait AUCUNE ; on ne refait pas l'erreur.
 * Les assertions portent en outre sur des IDENTIFIANTS, pas sur des comptes
 * nus, partout où c'est possible.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { listerComptes } from "@/server/repositories/dashboard";
import { createWithWorkspace } from "@/server/db/tenancy";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes ───────────────────────────────────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // Vision Globale
const MGR_BU = "22222222-2222-4222-8222-222222222222"; // member_entity_scopes → SUCRE
const MGR_PARTY = "33333333-3333-4333-8333-333333333333"; // user_scopes party → PARTY_S
const MGR_VIDE = "44444444-4444-4444-8444-444444444444"; // scopé sur une party SANS compte
const BOB_B = "66666666-6666-4666-8666-666666666666"; // membre WS_B

// Entités (BU) du groupe WS_A.
const ENT_SUCRE = "e0000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENT_ENERGIE = "e0000002-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Comptes WS_A (+ témoin WS_B).
const ACC_S1 = "acc05100-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // entité SUCRE
const ACC_S2 = "acc05200-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // entité SUCRE
const ACC_E = "acc0e100-cccc-4ccc-8ccc-cccccccccccc"; // entité ÉNERGIE — la cible IDOR
const ACC_B = "acc0bbbb-eeee-4eee-8eee-eeeeeeeeeeee"; // WS_B

// Parties WS_A. PARTY_S détient les 2 comptes Sucrière ; ÉNERGIE est co-détenue
// par 3 parties (cardinalité 3 ≠ 2, cf. en-tête). PARTY_VIDE et PARTY_LIBRE
// n'ont AUCUNE détention — cas réel : une party remontée par l'amont dont le
// compte n'est pas encore ingéré.
const PARTY_S = "9a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_E = "9b000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARTY_CO_E1 = "9c000000-cccc-4ccc-8ccc-cccccccccccc";
const PARTY_CO_E2 = "9d000000-dddd-4ddd-8ddd-dddddddddddd";
const PARTY_VIDE = "9e000000-eeee-4eee-8eee-eeeeeeeeeeee"; // sentinelle (cas 6)
const PARTY_LIBRE = "9f000000-ffff-4fff-8fff-ffffffffffff"; // cible des écritures 4/5
const PARTY_B = "90000000-0000-4000-8000-000000000000"; // WS_B

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sessAdmin = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessBu = { userId: MGR_BU, activeWorkspaceId: WS_A };
const sessParty = { userId: MGR_PARTY, activeWorkspaceId: WS_A };
const sessVide = { userId: MGR_VIDE, activeWorkspaceId: WS_A };
const sessB = { userId: BOB_B, activeWorkspaceId: WS_B };

/** Déplie la chaîne des causes (Drizzle enveloppe les erreurs driver RLS/FK). */
const flatten = (e: unknown): string => {
  let msg = "";
  let cur: unknown = e;
  while (cur instanceof Error) {
    msg += cur.message + " | ";
    cur = cur.cause;
  }
  return msg;
};

/**
 * SQL brut sous owner (bypass RLS) — seed et remise en état. Le `finally`
 * RÉTABLIT impérativement `tygr_app` : sans lui, une exception au milieu
 * laisserait la session en `postgres` et TOUS les tests suivants seraient
 * rejetés par le garde-fou C6 (UnsafeDatabaseRoleError).
 */
async function asOwner(sqlText: string): Promise<void> {
  await client.exec(`set role postgres;`);
  try {
    await client.exec(sqlText);
  } finally {
    await client.exec(`set role tygr_app;`);
  }
}

/** Lignes (compte, party) de `account_party_role` visibles dans le contexte. */
async function lignesVisibles(
  session: Parameters<typeof withWorkspace>[0],
  filtre?: ReturnType<typeof sql>,
): Promise<{ compte: string; party: string }[]> {
  return withWorkspace(session, async (tx) => {
    const r = await tx.execute(
      filtre
        ? sql`select bank_account_id, party_id from account_party_role where ${filtre} order by bank_account_id, party_id`
        : sql`select bank_account_id, party_id from account_party_role order by bank_account_id, party_id`,
    );
    return (
      r as unknown as { rows: { bank_account_id: string; party_id: string }[] }
    ).rows.map((x) => ({ compte: x.bank_account_id, party: x.party_id }));
  });
}

beforeAll(async () => {
  // 1. Migrations réelles, par NOM trié (0024 incluse).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Seed owner (bypass RLS). Topologie :
  //    ENT_SUCRE   → ACC_S1, ACC_S2   détenus par PARTY_S            (2 lignes)
  //    ENT_ENERGIE → ACC_E            co-détenu par E/CO_E1/CO_E2    (3 lignes)
  //    MGR_BU scopé BU SUCRE ; MGR_PARTY scopé party PARTY_S ; MGR_VIDE scopé
  //    PARTY_VIDE (aucune détention → DROIT ∅ → sentinelle, cas 6).
  await client.exec(`set role postgres;`);
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${MGR_BU}','bu@a.mu','Mgr BU'),
      ('${MGR_PARTY}','party@a.mu','Mgr Party'),
      ('${MGR_VIDE}','vide@a.mu','Mgr Vide'),
      ('${BOB_B}','b@b.mu','Bob B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MGR_BU}','${WS_A}','MANAGER'),
      ('${MGR_PARTY}','${WS_A}','MANAGER'),
      ('${MGR_VIDE}','${WS_A}','MANAGER'),
      ('${BOB_B}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière'),
      ('${ENT_ENERGIE}','${WS_A}','Énergie');
    insert into parties (id, workspace_id, omnifi_party_id, name, is_active) values
      ('${PARTY_S}','${WS_A}','pid-suc','Société Sucrière',true),
      ('${PARTY_E}','${WS_A}','pid-ene','Société Énergie',true),
      ('${PARTY_CO_E1}','${WS_A}','pid-co1','Co-détentrice 1',true),
      ('${PARTY_CO_E2}','${WS_A}','pid-co2','Co-détentrice 2',true),
      ('${PARTY_VIDE}','${WS_A}','pid-vide','Party sans compte',true),
      ('${PARTY_LIBRE}','${WS_A}','pid-libre','Party libre',true),
      ('${PARTY_B}','${WS_B}','pid-b','Partie B',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB_B}');
    insert into bank_accounts (id, workspace_id, connection_id, entity_id, omnifi_account_id, account_name, currency, current_balance, is_selected) values
      ('${ACC_S1}','${WS_A}','${CONN_A}','${ENT_SUCRE}','oa-s1','Sucre 1','MUR','1000.00',true),
      ('${ACC_S2}','${WS_A}','${CONN_A}','${ENT_SUCRE}','oa-s2','Sucre 2','MUR','2000.00',true),
      ('${ACC_E}','${WS_A}','${CONN_A}','${ENT_ENERGIE}','oa-e','Énergie 1','MUR','3000.00',true),
      ('${ACC_B}','${WS_B}','${CONN_B}',null,'oa-b','Compte B','MUR','9999.00',true);
    -- 2 lignes côté Sucrière / 3 côté Énergie (cardinalités distinctes, cf. en-tête).
    insert into account_party_role (workspace_id, bank_account_id, party_id, ownership_type, is_primary) values
      ('${WS_A}','${ACC_S1}','${PARTY_S}','BUSINESS',true),
      ('${WS_A}','${ACC_S2}','${PARTY_S}','BUSINESS',true),
      ('${WS_A}','${ACC_E}','${PARTY_E}','BUSINESS',true),
      ('${WS_A}','${ACC_E}','${PARTY_CO_E1}','JOINT',false),
      ('${WS_A}','${ACC_E}','${PARTY_CO_E2}','JOINT',false);
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${MGR_BU}','${ENT_SUCRE}');
    insert into user_scopes (workspace_id, user_id, party_id) values
      ('${WS_A}','${MGR_PARTY}','${PARTY_S}'),
      ('${WS_A}','${MGR_VIDE}','${PARTY_VIDE}');
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

// ── 0 — Préconditions ────────────────────────────────────────────────────────
describe("0 — préconditions", () => {
  it("les requêtes tournent sous tygr_app (sinon la RLS est ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });

  it("garde STRUCTURELLE : account_scope sur account_party_role est RESTRICTIVE, FOR ALL, USING == WITH CHECK", async () => {
    // Sans cette garde, la suite pourrait passer au vert avec une policy
    // PERMISSIVE (qui ne filtre RIEN, cf. mutation n°3) ou FOR SELECT (qui
    // laisserait l'écriture ouverte — c'est exactement le faux vert de 0009).
    const r = await client.query<{
      permissive: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select permissive, cmd, qual, with_check from pg_policies
        where policyname = 'account_scope' and tablename = 'account_party_role'`,
    );
    expect(r.rows).toHaveLength(1);
    const p = r.rows[0];
    expect(p.permissive).toBe("RESTRICTIVE");
    expect(p.cmd).toBe("ALL");
    expect(p.qual).not.toBeNull();
    expect(p.with_check).not.toBeNull();
    expect(p.qual).toBe(p.with_check);
  });

  it("la fixture porte des cardinalités DISTINCTES par table (3 / 5 / 6 sur WS_A)", async () => {
    // Protège l'invariant de l'en-tête : si un jour la fixture est « simplifiée »
    // et que deux tables retombent au même total, la mutation n°4 (prédicat
    // pointé sur la mauvaise table) redevient indétectable.
    // Compté en Vision Globale via withWorkspace, PAS par un `client.query` nu :
    // une requête hors withWorkspace ne pose pas `app.current_workspace_id`, la
    // RLS tenant renvoie alors 0 partout — un « 0 == 0 » qui ne prouverait rien.
    const totaux = await withWorkspace(sessAdmin, async (tx) => {
      const r = await tx.execute(
        sql`select
              (select count(*) from bank_accounts)::int      as comptes,
              (select count(*) from account_party_role)::int as roles,
              (select count(*) from parties)::int            as parts`,
      );
      return (
        r as unknown as {
          rows: { comptes: number; roles: number; parts: number }[];
        }
      ).rows[0];
    });
    expect(totaux).toEqual({ comptes: 3, roles: 5, parts: 6 });
  });
});

// ── 1 ⭐ — SELECT DIRECT sous scope Sucrière ─────────────────────────────────
describe("1 ⭐ — SELECT DIRECT (sans jointure) sous scope Sucrière", () => {
  it("MGR_BU ne voit QUE les 2 détentions de ses comptes — jamais les 3 d'Énergie", async () => {
    // C'est LE cas que la policy ferme : une requête qui ne joint PAS
    // bank_accounts. Avant 0024 elle renvoyait les 5 lignes du tenant.
    const lignes = await lignesVisibles(sessBu);
    expect(lignes).toEqual([
      { compte: ACC_S1, party: PARTY_S },
      { compte: ACC_S2, party: PARTY_S },
    ]);
    expect(lignes.map((l) => l.compte)).not.toContain(ACC_E);
  });
});

// ── 2 — Vision Globale : non-régression ──────────────────────────────────────
describe("2 — SELECT DIRECT en Vision Globale", () => {
  it("l'ADMIN non scopé voit les 5 détentions du tenant, et AUCUNE de WS_B", async () => {
    const lignes = await lignesVisibles(sessAdmin);
    expect(lignes).toHaveLength(5);
    expect(lignes.filter((l) => l.compte === ACC_E)).toHaveLength(3);
    expect(lignes.map((l) => l.compte)).not.toContain(ACC_B);
  });

  it("un membre de WS_B ne voit AUCUNE détention de WS_A (étage 1 intact)", async () => {
    const lignes = await lignesVisibles(sessB);
    expect(lignes).toHaveLength(0);
  });
});

// ── 3 ⭐ — Prédicat FORGÉ vers un compte hors périmètre ──────────────────────
describe("3 ⭐ — WHERE bank_account_id forgé (tentative d'IDOR intra-groupe)", () => {
  it("MGR_BU ciblant explicitement le compte d'Énergie → 0 ligne", async () => {
    // Sans la policy, ce WHERE renverrait les 3 détentions d'ACC_E : c'est la
    // forme d'attaque la plus directe (l'id d'un compte du groupe n'est pas un
    // secret — il circule dans les URL et les payloads).
    const lignes = await lignesVisibles(
      sessBu,
      sql`bank_account_id = ${ACC_E}`,
    );
    expect(lignes).toHaveLength(0);
  });
});

// ── 4 ⭐ — Écriture hors périmètre refusée (WITH CHECK) ──────────────────────
describe("4 ⭐ — INSERT visant un compte hors périmètre", () => {
  it("MGR_BU tentant de s'attribuer une détention sur le compte d'Énergie → refus 42501", async () => {
    // Prouve FOR ALL : l'IDOR ne se déplace pas de la lecture vers l'écriture.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessBu, async (tx) => {
        await tx.execute(
          sql`insert into account_party_role
                (workspace_id, bank_account_id, party_id, ownership_type, is_primary)
              values (${WS_A}, ${ACC_E}, ${PARTY_LIBRE}, 'BUSINESS', false)`,
        );
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(flatten(thrown)).toMatch(/row-level security|42501/i);

    // Rien n'a été écrit (vérifié en Vision Globale) : le refus est bien un
    // rollback, pas une écriture silencieusement invisible.
    const lignes = await lignesVisibles(sessAdmin);
    expect(lignes).toHaveLength(5);
  });
});

// ── 5 — Ingestion en Vision Globale : garde ANTI-fail-closed ────────────────
describe("5 — INSERT d'ingestion en Vision Globale (non-régression)", () => {
  it("un upsert de détention passe inchangé quand aucun GUC d'étage 2 n'est posé", async () => {
    // L'ingestion (ingestion.ts:373-385) tourne en Vision Globale : les deux
    // clauses court-circuitent sur nullif(...) IS NULL. Si ce test rougit, la
    // migration a cassé la synchronisation bancaire — c'est la régression la
    // plus coûteuse que ce lot pouvait introduire.
    await withWorkspace(sessAdmin, async (tx) => {
      await tx.execute(
        sql`insert into account_party_role
              (workspace_id, bank_account_id, party_id, ownership_type, is_primary)
            values (${WS_A}, ${ACC_E}, ${PARTY_LIBRE}, 'BUSINESS', false)`,
      );
    });
    const apres = await lignesVisibles(sessAdmin);
    expect(apres).toHaveLength(6);

    // Remise en état : la fixture doit rester à 5 lignes pour les cas suivants
    // (chaque cas est indépendant de l'ordre d'exécution).
    await asOwner(
      `delete from account_party_role
        where workspace_id = '${WS_A}' and bank_account_id = '${ACC_E}'
          and party_id = '${PARTY_LIBRE}';`,
    );
    const restaure = await lignesVisibles(sessAdmin);
    expect(restaure).toHaveLength(5);
  });
});

// ── 6 — Sentinelle UUID-nul : « périmètre vide » ≠ « voir tout » ────────────
describe("6 — DROIT résolu à ∅ (sentinelle)", () => {
  it("MGR_VIDE (scopé sur une party SANS aucune détention) ne voit RIEN", async () => {
    // Cas (b) du résolveur (tenancy.ts:370-372) : ≥1 ligne de scope mais DROIT
    // vide → GUC = UUID-nul, jamais ''. Un GUC vide court-circuiterait la
    // policy et ouvrirait TOUT le tenant — l'inverse exact du fail-closed.
    const lignes = await lignesVisibles(sessVide);
    expect(lignes).toHaveLength(0);
  });
});

// ── 7 — view_filter, prouvé SÉPARÉMENT de account_scope ─────────────────────
describe("7 — clause view_filter", () => {
  it("MGR_BU + viewFilter=[compte d'Énergie hors droit] → 0 ligne (le filtre n'ÉLARGIT jamais)", async () => {
    const lignes = await lignesVisibles({
      ...sessBu,
      viewFilter: [ACC_E],
    });
    expect(lignes).toHaveLength(0);
  });

  it("ADMIN (Vision Globale) + viewFilter=[ACC_S1] → la SEULE détention d'ACC_S1", async () => {
    // Cas DISCRIMINANT : ici `account_scope` n'est pas posé du tout (Vision
    // Globale) — seule la clause `view_filter` peut filtrer. Sans elle, ce test
    // verrait les 5 lignes (mutation-check n°2). C'est ce qui prouve que les
    // deux clauses sont testées SÉPARÉMENT et non corrélées par la fixture.
    const lignes = await lignesVisibles({
      ...sessAdmin,
      viewFilter: [ACC_S1],
    });
    expect(lignes).toEqual([{ compte: ACC_S1, party: PARTY_S }]);
  });
});

// ── 8 — Régression guard : le chemin applicatif déjà borné ──────────────────
describe("8 — listerComptes sous scope Sucrière", () => {
  it("le compte d'Énergie ET son titulaire restent absents", async () => {
    // Ce chemin était DÉJÀ borné avant 0024 (jointure DEPUIS bank_accounts,
    // dashboard.ts:174-214). Le cas est ici pour prouver que la nouvelle policy
    // ne le CASSE pas — un titulaire qui disparaîtrait des comptes légitimes
    // serait une régression fonctionnelle silencieuse.
    const comptes = await withWorkspace(sessBu, (tx) => listerComptes(tx));
    expect(comptes.map((c) => c.bankAccountId).sort()).toEqual(
      [ACC_S1, ACC_S2].sort(),
    );
    expect(comptes.map((c) => c.bankAccountId)).not.toContain(ACC_E);
    // Le titulaire des comptes légitimes est TOUJOURS résolu (non-régression).
    for (const c of comptes) {
      expect(c.holderId).toBe(PARTY_S);
      expect(c.holderName).toBe("Société Sucrière");
    }
  });
});

// ── 9 ⚠️ — CONTRE-PREUVE VOLONTAIRE (décision D2) ───────────────────────────
describe("9 ⚠️ — `parties` reste HORS périmètre (contre-preuve assumée)", () => {
  it("MGR_BU voit ENCORE les parties d'Énergie — ce lot ne scope PAS `parties`", async () => {
    /*
     * ⚠️ CE TEST DOCUMENTE UNE LACUNE CONNUE, PAS UN COMPORTEMENT SOUHAITABLE.
     *
     * Décision D2 (PLAN-entity-parties-scope.md §3) : `parties` sort de ce lot
     * car ses deux seules lectures directes sont ADMIN-only STRICT, chaîne
     * prouvée maillon par maillon — et un ADMIN ne peut pas devenir scopé (il
     * n'existe AUCUN chemin d'UPDATE de rôle dans l'application). Le risque est
     * donc théorique AUJOURD'HUI.
     *
     * Il cesse de l'être le jour où une surface titulaire est ouverte à un rôle
     * NON-ADMIN : `entites.ts:612` surfacerait alors les noms de TOUS les
     * titulaires du groupe à un membre borné à une BU — de la donnée nominative,
     * sans erreur ni test rouge.
     *
     * ⇒ CE TEST DOIT ÊTRE INVERSÉ (attendre 0 party hors périmètre) le jour où
     *   le P2 `parties` est traité. Sans lui, un lecteur de la suite croirait
     *   que la classe entière est fermée. Voir TODOS.md « ENTITY-PARTIES-P2 ».
     */
    const noms = await withWorkspace(sessBu, async (tx) => {
      const r = await tx.execute(sql`select id from parties order by id`);
      return (r as unknown as { rows: { id: string }[] }).rows.map((x) => x.id);
    });
    expect(noms).toContain(PARTY_E); // ← à inverser au traitement du P2
    expect(noms).toHaveLength(6); // les 6 parties de WS_A, dont celles d'Énergie
    expect(noms).not.toContain(PARTY_B); // l'étage 1 (tenant), lui, mord bien
  });
});

// ── 10 ⭐ — GARDE D'ORDRE : auto-référence du résolveur ──────────────────────
describe("10 ⭐ — membre scopé par PARTY (défense contre l'auto-référence)", () => {
  it("MGR_PARTY résout bien ses 2 comptes et voit ses 2 détentions", async () => {
    /*
     * POURQUOI CE TEST EXISTE (ne pas le supprimer en croyant qu'il fait doublon
     * avec le cas 1) : `tenancy.ts:319-327` lit `account_party_role` pour
     * RÉSOUDRE le droit d'un membre scopé par party. Depuis 0024, cette table
     * porte une policy. La lecture n'est sûre que parce que la résolution
     * précède la pose des GUC (ordre documenté `tenancy.ts:246-251`).
     *
     * Si cet ordre est un jour INVERSÉ (refactor, extraction de helper,
     * réordonnancement « pour poser les GUC au plus tôt »), MGR_PARTY ne verrait
     * plus les lignes qui DÉFINISSENT SON PROPRE DROIT → DROIT ∅ → sentinelle →
     * dashboard VIDE, sans la moindre erreur. Fail-closed, donc aucune fuite —
     * mais un déni d'accès total et SILENCIEUX.
     *
     * Le commentaire de `tenancy.ts` n'échouera jamais ; ce test, si.
     */
    const comptes = await withWorkspace(sessParty, (tx) => listerComptes(tx));
    expect(comptes.map((c) => c.bankAccountId).sort()).toEqual(
      [ACC_S1, ACC_S2].sort(),
    );

    const lignes = await lignesVisibles(sessParty);
    expect(lignes).toEqual([
      { compte: ACC_S1, party: PARTY_S },
      { compte: ACC_S2, party: PARTY_S },
    ]);
  });
});
