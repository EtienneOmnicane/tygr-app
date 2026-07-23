/**
 * Suite d'isolation du rôle `tygr_service` (lot W3) — preuve que le rôle de
 * résolution webhook est confiné à un PÉRIMÈTRE GELÉ : SELECT de 3 colonnes non
 * métier sur `bank_connections`, plus la gestion de `webhook_events_pending`, et
 * RIEN d'autre. Spec : docs/specs/PLAN-webhook-ingestion.md §5.2 / §7.2 / §10.2.
 *
 * Comme la suite tombstone, on pilote PGlite en SQL brut : la preuve porte sur les
 * PRIVILÈGES et la RLS (permission denied / 0 ligne), au plus près du moteur.
 * L'ordre de setup reproduit la prod (migrate -> provision) — le provisioning est la
 * SOURCE UNIQUE du rôle et de ses policies.
 *
 * PROTOCOLE DE MUTATION (§10.2) : après le commit vert, muter CHAQUE garde une par
 * une (retirer le REVOKE, retirer la policy webhook_resolution, élargir le GRANT à une
 * 4e colonne) et vérifier que le test correspondant ROUGIT. Une garde dont la mutation
 * laisse la suite verte n'est pas prouvée.
 *
 * NB couverture (cross-review W3) : la garde SQL `LIMIT 2` (multiplicité) n'est PAS
 * exerçable ici — l'unique GLOBALE de omnifi_connection_id interdit de seeder 2 lignes
 * pour une même clé (le vrai test à 2 tenants arrive au CONTRACT, §5.4). La DÉCISION
 * d'ambiguïté (≥2 lignes → AMBIGUE, jamais un choix) est prouvée par le test unitaire
 * pur `tests/unit/webhook-resolution.test.ts`. La garde RUNTIME `exigerRoleService`
 * (que le SQL brut ne traverse pas) est prouvée par `webhook-integration-isolation`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const client = new PGlite();

// Deux tenants : la résolution est cross-tenant par nature (elle VOIT les deux).
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const CONN_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONN_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** Déplie la chaîne des `cause` (une erreur PGlite peut être enveloppée). */
function flatten(e: unknown): string {
  let msg = "";
  let cur: unknown = e;
  while (cur instanceof Error) {
    msg += cur.message + " | ";
    cur = cur.cause;
  }
  return msg;
}

/** Exécute un statement SQL brut et renvoie l'erreur éventuelle (null = succès). */
async function tenter(statement: string): Promise<unknown> {
  try {
    await client.exec(statement);
    return null;
  } catch (e) {
    return e;
  }
}

beforeAll(async () => {
  // 1. Migrations RÉELLES depuis le disque (le DDL que la prod applique, 0026 inclus).
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of raw.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await client.exec(statement);
    }
  }

  // 2. Seed minimal sous OWNER (RLS contournée) : deux tenants, une connexion chacun.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id, omnifi_environment) values
      ('${WS_A}', 'BU A', 'INTERNAL_BU', 'enduser-A', 'sandbox'),
      ('${WS_B}', 'BU B', 'INTERNAL_BU', 'enduser-B', 'sandbox');
    insert into users (id, email, full_name) values
      ('${ALICE}', 'alice@groupe.mu', 'Alice');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}', '${WS_A}', 'omni-conn-A', 'inst-1', '${ALICE}'),
      ('${CONN_B}', '${WS_B}', 'omni-conn-B', 'inst-2', '${ALICE}');
  `);

  // 3. Provisioning RÉEL (source unique) APRÈS migrate : crée tygr_service, ses GRANT
  //    column-level, la policy webhook_resolution, et les gardes webhook_events_pending.
  const provisioning = readFileSync(
    path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
    "utf8",
  );
  await client.exec(provisioning);

  // 4. Seed d'une ligne de quarantaine SOUS tygr_service (la table est en FORCE RLS
  //    sans policy owner → l'owner ne peut pas l'insérer ; c'est voulu).
  await client.exec(`set role tygr_service;`);
  await client.exec(`
    insert into webhook_events_pending
      (id, omnifi_event_id, omnifi_connection_id, event_type, omnifi_environment, motif, payload)
      values
      ('${EVT}', 'evt-1', 'omni-conn-A', 'sync.completed', 'sandbox', 'CONNEXION_INCONNUE', '{}'::jsonb);
  `);
  await client.exec(`reset role;`);
});

afterAll(async () => {
  await client.close();
});

describe("préconditions", () => {
  it("0. le rôle tygr_service existe et n'est pas superuser/bypassrls", async () => {
    const r = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`select rolsuper, rolbypassrls from pg_roles where rolname = 'tygr_service'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].rolsuper, "jamais superuser").toBe(false);
    expect(r.rows[0].rolbypassrls, "jamais BYPASSRLS").toBe(false);
  });
});

describe("tygr_service : périmètre GELÉ (3 colonnes de bank_connections)", () => {
  beforeAll(async () => {
    await client.exec(`set role tygr_service;`);
  });
  afterAll(async () => {
    await client.exec(`reset role;`);
  });

  it("1. SELECT d'une colonne HORS périmètre (institution_id) → permission denied", async () => {
    const err = await tenter(`select institution_id from bank_connections`);
    expect(err, "colonne non accordée").not.toBeNull();
    expect(flatten(err)).toMatch(/permission denied/i);
  });

  it("1bis. SELECT created_by (hors périmètre) → permission denied", async () => {
    const err = await tenter(`select created_by from bank_connections`);
    expect(err).not.toBeNull();
    expect(flatten(err)).toMatch(/permission denied/i);
  });

  it("2. SELECT sur transactions_cache / users / workspaces → permission denied (D2 non appliquée)", async () => {
    for (const tbl of ["transactions_cache", "users", "workspaces"]) {
      const err = await tenter(`select 1 from ${tbl} limit 1`);
      expect(err, `aucun accès à ${tbl}`).not.toBeNull();
      expect(flatten(err)).toMatch(/permission denied/i);
    }
  });

  it("3. INSERT / UPDATE / DELETE sur bank_connections → permission denied", async () => {
    const insertErr = await tenter(
      `insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by)
       values ('99999999-9999-4999-8999-999999999999', '${WS_A}', 'x', 'y', '${ALICE}')`,
    );
    expect(insertErr, "INSERT interdit").not.toBeNull();
    expect(flatten(insertErr)).toMatch(/permission denied/i);

    const updateErr = await tenter(
      `update bank_connections set institution_id = 'z' where id = '${CONN_A}'`,
    );
    expect(updateErr, "UPDATE interdit").not.toBeNull();
    expect(flatten(updateErr)).toMatch(/permission denied/i);

    const deleteErr = await tenter(
      `delete from bank_connections where id = '${CONN_A}'`,
    );
    expect(deleteErr, "DELETE interdit").not.toBeNull();
    expect(flatten(deleteErr)).toMatch(/permission denied/i);
  });

  it("4. la résolution VOIT les connexions des DEUX tenants (3 colonnes), et rien d'autre", async () => {
    // Cross-tenant VOULU : la policy webhook_resolution USING(true) + FOR SELECT.
    const r = await client.query<{ workspaceId: string }>(
      `select workspace_id as "workspaceId" from bank_connections order by workspace_id`,
    );
    const workspaces = new Set(r.rows.map((l) => l.workspaceId));
    expect(workspaces.has(WS_A) && workspaces.has(WS_B), "voit A ET B").toBe(true);

    // La résolution par omnifi_connection_id (LIMIT 2) : 1 ligne pour une clé connue.
    const un = await client.query(
      `select id, omnifi_connection_id, workspace_id from bank_connections
       where omnifi_connection_id = 'omni-conn-A' limit 2`,
    );
    expect(un.rows).toHaveLength(1);
  });
});

describe("contre-preuve : webhook_resolution ne fuit PAS vers tygr_app", () => {
  it("5. tygr_app SANS GUC → 0 ligne sur bank_connections (policy bornée au rôle service)", async () => {
    await client.exec(`set role tygr_app;`);
    // Aucun app.current_workspace_id posé : tenant_isolation renvoie NULL → 0 ligne.
    // webhook_resolution est TO tygr_service : elle ne s'applique pas à tygr_app.
    const r = await client.query(
      `select id from bank_connections where omnifi_connection_id = 'omni-conn-A'`,
    );
    await client.exec(`reset role;`);
    expect(r.rows, "tygr_app ne résout jamais une connexion").toHaveLength(0);
  });
});

describe("webhook_events_pending : DEUX gardes complémentaires contre tygr_app", () => {
  it("6a. PRIVILÈGE — tygr_app : SELECT et INSERT → permission denied (REVOKE ALL)", async () => {
    await client.exec(`set role tygr_app;`);
    const selErr = await tenter(`select 1 from webhook_events_pending`);
    const insErr = await tenter(
      `insert into webhook_events_pending
        (omnifi_event_id, omnifi_connection_id, event_type, omnifi_environment, motif)
        values ('x', 'y', 'sync.completed', 'sandbox', 'AMBIGUE')`,
    );
    await client.exec(`reset role;`);
    expect(flatten(selErr)).toMatch(/permission denied/i);
    expect(flatten(insErr)).toMatch(/permission denied/i);
  });

  it("6b. RLS (garde INDÉPENDANTE du privilège) — même avec un GRANT SELECT accidentel, tygr_app voit 0 ligne", async () => {
    // On simule une RÉGRESSION de privilège (un GRANT réapparu par accident) et on
    // prouve que le FORCE RLS + l'absence de policy pour tygr_app tient le fail-closed.
    await client.exec(`grant select on webhook_events_pending to tygr_app;`);
    await client.exec(`set role tygr_app;`);
    const r = await client.query(`select 1 from webhook_events_pending`);
    await client.exec(`reset role;`);
    await client.exec(`revoke select on webhook_events_pending from tygr_app;`);
    expect(r.rows, "aucune policy pour tygr_app ⇒ 0 ligne").toHaveLength(0);
  });

  it("6c. tygr_service : SELECT / INSERT / UPDATE / DELETE OK (table système, non append-only)", async () => {
    await client.exec(`set role tygr_service;`);
    const sel = await client.query(
      `select id from webhook_events_pending where id = '${EVT}'`,
    );
    expect(sel.rows, "voit la ligne seedée").toHaveLength(1);

    const upd = await tenter(
      `update webhook_events_pending set replay_count = replay_count + 1 where id = '${EVT}'`,
    );
    expect(upd, "UPDATE autorisé").toBeNull();

    const ins = await tenter(
      `insert into webhook_events_pending
        (omnifi_event_id, omnifi_connection_id, event_type, omnifi_environment, motif)
        values ('evt-2', 'omni-conn-B', 'sync.failed', 'sandbox', 'AMBIGUE')`,
    );
    expect(ins, "INSERT autorisé").toBeNull();

    const del = await tenter(
      `delete from webhook_events_pending where omnifi_event_id = 'evt-2'`,
    );
    expect(del, "DELETE autorisé (purge TTL W5)").toBeNull();
    await client.exec(`reset role;`);
  });
});

describe("non-régression : aucune RESTRICTIVE sur bank_connections (§10.2 cas 9)", () => {
  it("9. une policy RESTRICTIVE casserait la résolution (AND) → il ne doit y en avoir AUCUNE", async () => {
    // webhook_resolution est PERMISSIVE (s'OR-e). Si une RESTRICTIVE apparaissait un
    // jour sur bank_connections, elle AND-erait et masquerait les lignes en silence
    // sous tygr_service. Cette assertion fige l'invariant du plan §1.1.
    const r = await client.query<{ policyname: string }>(
      `select policyname from pg_policies
       where tablename = 'bank_connections' and permissive = 'RESTRICTIVE'`,
    );
    expect(r.rows, "aucune policy RESTRICTIVE sur bank_connections").toHaveLength(0);
  });
});

// NB : l'effet de FORCE ROW LEVEL SECURITY sur le PROPRIÉTAIRE (réparation sous owner
// exige SET ROLE tygr_service, §7.2) n'est PAS démontrable en PGlite : le rôle bootstrap
// (`reset role`) y est SUPERUSER, qui contourne toujours la RLS (FORCE ne mord que sur un
// owner NON-superuser, ex. tygr_owner en prod). Le FORCE reste posé (0026) par cohérence
// avec 0001/0003/0021 ; la sécurité ne dépend PAS de cette propriété (tygr_app bloqué par
// REVOKE + RLS ci-dessus ; l'owner est de toute façon refusé au runtime par la garde C6).
