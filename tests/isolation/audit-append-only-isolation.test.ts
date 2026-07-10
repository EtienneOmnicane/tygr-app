/**
 * Suite d'isolation — APPEND-ONLY STRICT de `consent_records` et `audit_events`
 * (Epic 1 / L3.1, PLAN-epic1-auth-consent.md §8, cas 1 → 7bis).
 *
 * Ces deux tables sont le socle du narratif réglementaire (BOM Innov8) : si on
 * peut y faire un UPDATE ou un DELETE, l'audit trail ne prouve rien. Elles sont
 * donc append-only STRICTES — à distinguer de `transactions_cache` /
 * `balance_history`, append-only au DELETE seul (l'UPDATE tombstone y est permis).
 *
 * TROIS gardes, prouvées séparément parce qu'aucune ne suffit :
 *   (1) hors liste blanche DELETE de `tygr_app.sql` (étape 5)
 *   (2) `REVOKE UPDATE, DELETE` explicite (étape 6) — le GRANT global de
 *       l'étape 3 accorde `UPDATE ON ALL TABLES`, il faut le retirer
 *   (3) trigger `BEFORE UPDATE OR DELETE` (migration 0021) — la SEULE défense
 *       indépendante du privilège ET du chemin : elle mord même sous l'OWNER
 *       (cas 4), même via une cascade FK.
 *
 * Le cas 5 prouve en plus l'AUTO-SUFFISANCE (décision Q2, plan §2.4) : après
 * suppression de la connexion et modification de l'utilisateur, la ligne d'audit
 * reste lisible à l'identique, sans jointure. C'est ce qui justifie l'absence de
 * FK vers `bank_connections` et `users`.
 *
 * Comme la suite anti-IDOR de référence, les requêtes tournent sous `tygr_app`
 * (rôle NON-propriétaire) — sans quoi la RLS serait ignorée et le test prouverait
 * du vide. Migrations + provisioning réels (source unique de vérité).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";

const client = new PGlite();
drizzle(client, { schema });

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const CONN_A = "f1111111-1111-4111-8111-111111111111";
const CONN_B = "f2222222-2222-4222-8222-222222222222";

/** Consentement de A, posé au seed (owner). Sert de cible aux UPDATE/DELETE. */
const CONSENT_A = "c1111111-1111-4111-8111-111111111111";
/** Événement d'audit de A, posé au seed. */
const EVENT_A = "e1111111-1111-4111-8111-111111111111";
/** Consentement de A rattaché à une connexion qu'on supprimera (cas 5). */
const CONSENT_PURGE = "c3333333-3333-4333-8333-333333333333";
const CONN_PURGE = "f3333333-3333-4333-8333-333333333333";

/** Valeurs snapshotées au seed : le cas 5 vérifie qu'elles survivent VERBATIM. */
const SNAP_INSTITUTION = "Absa Internet Banking";
const SNAP_EMAIL = "alice@omnicane.mu";
const SNAP_NOM = "Alice Dupont";

/**
 * Exécute `fn` sous l'OWNER puis REND l'état à `tygr_app`, même en cas d'échec.
 * Sans le `finally`, une assertion qui lève laisserait la suite sous l'owner —
 * la RLS ne filtrerait plus et les tests SUIVANTS deviendraient des faux-rouges
 * (ou pire, des faux-verts).
 */
async function sousOwner<T>(fn: () => Promise<T>): Promise<T> {
  await client.exec(`reset role;`);
  try {
    return await fn();
  } finally {
    await client.exec(`set role tygr_app;`);
  }
}

/** Pose le contexte tenant (GUC) pour que la RLS laisse passer les écritures. */
async function poserContexte(workspaceId: string): Promise<void> {
  await client.exec(
    `select set_config('app.current_workspace_id', '${workspaceId}', false);`,
  );
}

beforeAll(async () => {
  // 1. Migrations réelles (dossier = source de vérité, 0021 comprise).
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

  // 2. Seed sous owner (bypass RLS volontaire pour les fixtures).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}', 'Omnicane Groupe', 'CONSOLIDATION',   'enduser-a'),
      ('${WS_B}', 'Tenant Étranger', 'EXTERNAL_CLIENT', 'enduser-b');

    insert into users (id, email, full_name) values
      ('${ALICE}', '${SNAP_EMAIL}', '${SNAP_NOM}'),
      ('${BOB}',   'bob@etranger.mu', 'Bob');

    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}', '${WS_A}', 'ADMIN'),
      ('${BOB}',   '${WS_B}', 'ADMIN');

    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, institution_name, status, created_by) values
      ('${CONN_A}',     '${WS_A}', 'conn-a',     'absa', '${SNAP_INSTITUTION}', 'active', '${ALICE}'),
      ('${CONN_PURGE}', '${WS_A}', 'conn-purge', 'absa', '${SNAP_INSTITUTION}', 'active', '${ALICE}'),
      ('${CONN_B}',     '${WS_B}', 'conn-b',     'mcb',  'MCB Group',           'active', '${BOB}');

    insert into consent_records
      (id, workspace_id, connection_id, institution_name, granted_by_user_id, granted_by_email, granted_by_name, action, scope) values
      ('${CONSENT_A}',     '${WS_A}', '${CONN_A}',     '${SNAP_INSTITUTION}', '${ALICE}', '${SNAP_EMAIL}', '${SNAP_NOM}', 'GRANTED', '{"requestedScopes":["accounts"]}'),
      ('${CONSENT_PURGE}', '${WS_A}', '${CONN_PURGE}', '${SNAP_INSTITUTION}', '${ALICE}', '${SNAP_EMAIL}', '${SNAP_NOM}', 'GRANTED', '{"requestedScopes":["accounts"]}');

    insert into audit_events (id, workspace_id, event_type, connection_id, actor_user_id, payload) values
      ('${EVENT_A}', '${WS_A}', 'consent.granted', '${CONN_A}', '${ALICE}', '{}');
  `);

  // 3. Rôle applicatif non-propriétaire (source unique : provisioning prod).
  const provisioning = readFileSync(
    path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
    "utf8",
  );
  await client.exec(provisioning);
  await client.exec(`set role tygr_app;`);
  await poserContexte(WS_A);
});

afterAll(async () => {
  await client.close();
});

describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app (sinon la RLS est ignorée)", async () => {
    const res = await client.query<{ who: string }>(
      "select current_user as who",
    );
    expect(res.rows[0].who).toBe("tygr_app");
  });

  it("0bis. le contexte tenant est posé (sinon 0 ligne et les tests prouvent du vide)", async () => {
    const res = await client.query<{ n: number }>(
      "select count(*)::int as n from consent_records",
    );
    expect(res.rows[0].n).toBe(2);
  });
});

describe("consent_records — append-only strict (gardes 1, 2, 3)", () => {
  it("1. UPDATE refusé sous tygr_app", async () => {
    await expect(
      client.exec(
        `update consent_records set action = 'REVOKED' where id = '${CONSENT_A}'`,
      ),
    ).rejects.toThrow(/append_only_no_mutation|permission denied/i);
  });

  it("2. DELETE refusé sous tygr_app", async () => {
    await expect(
      client.exec(`delete from consent_records where id = '${CONSENT_A}'`),
    ).rejects.toThrow(/append_only_no_mutation|permission denied/i);
  });

  it("2bis. la ligne est intacte après les tentatives", async () => {
    const res = await client.query<{ action: string }>(
      `select action from consent_records where id = '${CONSENT_A}'`,
    );
    expect(res.rows[0]?.action).toBe("GRANTED");
  });
});

describe("audit_events — append-only strict (gardes 1, 2, 3)", () => {
  it("3a. UPDATE refusé sous tygr_app", async () => {
    await expect(
      client.exec(
        `update audit_events set event_type = 'falsifie' where id = '${EVENT_A}'`,
      ),
    ).rejects.toThrow(/append_only_no_mutation|permission denied/i);
  });

  it("3b. DELETE refusé sous tygr_app", async () => {
    await expect(
      client.exec(`delete from audit_events where id = '${EVENT_A}'`),
    ).rejects.toThrow(/append_only_no_mutation|permission denied/i);
  });

  it("3c. la ligne est intacte après les tentatives", async () => {
    const res = await client.query<{ event_type: string }>(
      `select event_type from audit_events where id = '${EVENT_A}'`,
    );
    expect(res.rows[0]?.event_type).toBe("consent.granted");
  });
});

describe("garde (3) — le TRIGGER mord même sous l'OWNER", () => {
  /*
   * LE cas qui prouve que le trigger est indispensable EN PLUS du privilège.
   * Sous l'owner, le REVOKE ne s'applique pas (il possède les tables) : si le
   * trigger n'existait pas, ces deux requêtes PASSERAIENT — et une migration de
   * réparation pourrait réécrire silencieusement l'audit réglementaire.
   */
  it("4a. UPDATE de consent_records refusé sous l'owner", async () => {
    await sousOwner(async () => {
      await expect(
        client.exec(
          `update consent_records set action = 'REVOKED' where id = '${CONSENT_A}'`,
        ),
      ).rejects.toThrow(/append_only_no_mutation/i);
    });
  });

  it("4b. DELETE d'audit_events refusé sous l'owner", async () => {
    await sousOwner(async () => {
      await expect(
        client.exec(`delete from audit_events where id = '${EVENT_A}'`),
      ).rejects.toThrow(/append_only_no_mutation/i);
    });
  });

  it("4c. on est bien revenu sous tygr_app (le finally a joué)", async () => {
    const res = await client.query<{ who: string }>(
      "select current_user as who",
    );
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

describe("cas 5 — cascade + AUTO-SUFFISANCE (décision Q2, plan §2.4)", () => {
  /*
   * Le cas qui justifie l'absence de FK. `bank_connections` et `users` sont
   * ÉDITABLES (liste blanche DELETE). On simule :
   *   - la RÉVOCATION (L3.3) : suppression de la connexion consentie ;
   *   - l'OFFBOARDING RGPD (dette #6) : modification de l'utilisateur.
   * Avec une FK RESTRICT, le DELETE échouerait → révocation impossible.
   * Avec une FK CASCADE, le DELETE tenterait d'effacer le consentement → le
   * trigger lèverait → révocation impossible ET message incompréhensible.
   * Sans FK : le DELETE passe, le consentement SURVIT, et ses snapshots le
   * gardent lisible SANS JOINTURE.
   */
  it("5a. la connexion consentie peut être supprimée (pas de FK RESTRICT/CASCADE)", async () => {
    await sousOwner(async () => {
      await client.exec(
        `delete from bank_connections where id = '${CONN_PURGE}'`,
      );
      const res = await client.query<{ n: number }>(
        `select count(*)::int as n from bank_connections where id = '${CONN_PURGE}'`,
      );
      expect(res.rows[0].n).toBe(0);
    });
  });

  it("5b. le consentement SURVIT à la disparition de sa connexion", async () => {
    const res = await client.query<{ n: number }>(
      `select count(*)::int as n from consent_records where id = '${CONSENT_PURGE}'`,
    );
    expect(res.rows[0].n).toBe(1);
  });

  it("5c. l'identité de l'acteur survit à sa modification (offboarding RGPD)", async () => {
    // Anonymisation réaliste : `users.full_name` est NOT NULL, donc l'offboarding
    // RÉÉCRIT l'identité, il ne la vide pas. C'est justement pour cela qu'une FK
    // `granted_by → users(id)` ne suffirait pas : la ligne existerait encore, mais
    // porterait le mauvais nom. Seul le SNAPSHOT préserve « qui a consenti ».
    await sousOwner(async () => {
      await client.exec(
        `update users set email = 'anonyme@purge.invalid', full_name = 'Utilisateur supprimé' where id = '${ALICE}'`,
      );
    });

    const res = await client.query<{
      institution_name: string;
      granted_by_email: string;
      granted_by_name: string;
    }>(
      `select institution_name, granted_by_email, granted_by_name
       from consent_records where id = '${CONSENT_PURGE}'`,
    );

    // Les snapshots rendent la ligne AUTO-SUFFISANTE : lisible à l'identique,
    // sans jointure, alors que la connexion n'existe plus et que l'utilisateur
    // a été anonymisé.
    expect(res.rows[0]).toEqual({
      institution_name: SNAP_INSTITUTION,
      granted_by_email: SNAP_EMAIL,
      granted_by_name: SNAP_NOM,
    });
  });
});

describe("contre-preuves — le durcissement n'a pas tout cassé", () => {
  it("6a. INSERT reste autorisé sous tygr_app", async () => {
    await client.exec(
      `insert into consent_records
         (workspace_id, connection_id, institution_name, granted_by_user_id, granted_by_email, granted_by_name, action, scope)
       values ('${WS_A}', '${CONN_A}', '${SNAP_INSTITUTION}', '${ALICE}', '${SNAP_EMAIL}', '${SNAP_NOM}', 'ACCOUNTS_SELECTED', '{"accountIds":[]}')`,
    );
    const res = await client.query<{ n: number }>(
      `select count(*)::int as n from consent_records where action = 'ACCOUNTS_SELECTED'`,
    );
    expect(res.rows[0].n).toBe(1);
  });

  it("6b. SELECT reste autorisé sous tygr_app", async () => {
    const res = await client.query<{ n: number }>(
      "select count(*)::int as n from audit_events",
    );
    expect(res.rows[0].n).toBe(1);
  });

  it("6c. le CHECK sur `action` refuse une valeur hors énumération", async () => {
    await expect(
      client.exec(
        `insert into consent_records
           (workspace_id, connection_id, granted_by_user_id, granted_by_email, action, scope)
         values ('${WS_A}', '${CONN_A}', '${ALICE}', '${SNAP_EMAIL}', 'INVENTE', '{}')`,
      ),
    ).rejects.toThrow(/consent_records_action_check|violates check/i);
  });
});

describe("cas 7bis — UNIQUE composite (workspace_id, omnifi_event_id) [Q4]", () => {
  const EVENT_ID = "evt-omnifi-42";

  it("7bis-a. le même EventId passe dans DEUX workspaces (unicité scopée, pas globale)", async () => {
    await client.exec(
      `insert into audit_events (workspace_id, event_type, omnifi_event_id, payload)
       values ('${WS_A}', 'sync.completed', '${EVENT_ID}', '{}')`,
    );

    // Bascule de tenant : le GUC décide de ce que la RLS laisse écrire.
    await poserContexte(WS_B);
    await client.exec(
      `insert into audit_events (workspace_id, event_type, omnifi_event_id, payload)
       values ('${WS_B}', 'sync.completed', '${EVENT_ID}', '{}')`,
    );
    await poserContexte(WS_A);

    const res = await sousOwner(async () =>
      client.query<{ n: number }>(
        `select count(*)::int as n from audit_events where omnifi_event_id = '${EVENT_ID}'`,
      ),
    );
    // Un UNIQUE GLOBAL aurait fait échouer le 2e INSERT (oracle d'existence
    // cross-tenant + DoS d'ingestion). Le composite l'autorise.
    expect(res.rows[0].n).toBe(2);
  });

  it("7bis-b. le même EventId DEUX FOIS dans le même workspace est refusé (idempotence)", async () => {
    await expect(
      client.exec(
        `insert into audit_events (workspace_id, event_type, omnifi_event_id, payload)
         values ('${WS_A}', 'sync.completed', '${EVENT_ID}', '{}')`,
      ),
    ).rejects.toThrow(
      /audit_events_workspace_omnifi_event_unique|duplicate key/i,
    );
  });

  it("7bis-c. N événements APPLICATIFS (omnifi_event_id NULL) coexistent", async () => {
    // Comportement PostgreSQL : un UNIQUE n'est jamais violé par des NULL.
    // C'est ce qui permet à l'émission applicative (consent.*) de fonctionner.
    // Passer la colonne en NOT NULL casserait tout le lot L3.2.
    await client.exec(
      `insert into audit_events (workspace_id, event_type, payload)
       values ('${WS_A}', 'consent.revoke_requested', '{}'),
              ('${WS_A}', 'consent.revoked', '{}')`,
    );
    const res = await client.query<{ n: number }>(
      `select count(*)::int as n from audit_events
       where workspace_id = '${WS_A}' and omnifi_event_id is null`,
    );
    // 1 (seed) + 2 = 3.
    expect(res.rows[0].n).toBe(3);
  });
});

describe("isolation tenant — les tables d'audit ne fuient pas (étage 1)", () => {
  it("8. un SELECT sans WHERE sous WS_A ne rend AUCUNE ligne de WS_B", async () => {
    const res = await client.query<{ workspace_id: string }>(
      "select workspace_id from audit_events",
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const ligne of res.rows) {
      expect(ligne.workspace_id).toBe(WS_A);
    }
  });

  it("9. un INSERT ciblant WS_B depuis le contexte WS_A est refusé (WITH CHECK)", async () => {
    await expect(
      client.exec(
        `insert into consent_records
           (workspace_id, connection_id, granted_by_user_id, granted_by_email, action, scope)
         values ('${WS_B}', '${CONN_B}', '${ALICE}', '${SNAP_EMAIL}', 'GRANTED', '{}')`,
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

describe("idempotence du provisioning", () => {
  it("10. rejouer tygr_app.sql ne casse rien (REVOKE en boucle, conditionnel)", async () => {
    const provisioning = readFileSync(
      path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
      "utf8",
    );
    await sousOwner(async () => {
      await client.exec(provisioning);
      await client.exec(provisioning);
    });

    // Le REVOKE tient toujours après re-provision.
    await expect(
      client.exec(`delete from audit_events where id = '${EVENT_A}'`),
    ).rejects.toThrow(/append_only_no_mutation|permission denied/i);
  });
});
