/**
 * Journal `sync_runs` (W2, drizzle-sur-PGlite) — prouve sur un Postgres réel :
 * le cycle ouvrir (RUNNING) → clore (terminal), la RLS tenant (un run de A
 * invisible depuis B), la FK COMPOSITE scopée workspace (un run ne peut pas
 * référencer la connexion d'un autre tenant), le CHECK de cohérence
 * RUNNING ⇔ finished_at NULL, la CASCADE de déconnexion, et l'énumération
 * système des workspaces par environnement (itérateur du cron).
 * Même montage que webhook-integration-isolation.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq, sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { syncRuns } from "@/server/db/schema";
import {
  createExecuterSysteme,
  createListerWorkspacesSysteme,
} from "@/server/db/systeme";
import { cloreSyncRun, ouvrirSyncRun } from "@/server/repositories/sync-runs";

const client = new PGlite();
const db = drizzle(client, { schema });
const executerSysteme = createExecuterSysteme(db);
const listerWorkspaces = createListerWorkspacesSysteme(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // sandbox
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // sandbox
const WS_PROD = "cccccccc-cccc-4ccc-8ccc-cccccccc0000"; // production
const ALICE = "11111111-1111-4111-8111-111111111111";
const CONN_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONN_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONN_A2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of raw.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await client.exec(statement);
    }
  }
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id, omnifi_environment) values
      ('${WS_A}', 'BU A', 'INTERNAL_BU', 'enduser-a', 'sandbox'),
      ('${WS_B}', 'BU B', 'INTERNAL_BU', 'enduser-b', 'sandbox'),
      ('${WS_PROD}', 'BU Prod', 'INTERNAL_BU', 'enduser-p', 'production');
    insert into users (id, email, full_name) values ('${ALICE}', 'alice@groupe.mu', 'Alice');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}', '${WS_A}', 'omni-conn-A', 'inst-1', '${ALICE}'),
      ('${CONN_A2}', '${WS_A}', 'omni-conn-A2', 'inst-1', '${ALICE}'),
      ('${CONN_B}', '${WS_B}', 'omni-conn-B', 'inst-2', '${ALICE}');
  `);
  const provisioning = readFileSync(
    path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
    "utf8",
  );
  await client.exec(provisioning);
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.exec(`reset role;`);
  await client.close();
});

describe("cycle de vie ouvrir → clore", () => {
  it("ouvrirSyncRun → RUNNING, finished_at NULL ; cloreSyncRun → terminal + compteurs + finished_at", async () => {
    const { syncRunId } = await executerSysteme(WS_A)((tx, ctx) =>
      ouvrirSyncRun(tx, ctx, { connectionId: CONN_A, declencheur: "CRON" }),
    );

    const ouvert = await executerSysteme(WS_A)((tx) =>
      tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)),
    );
    expect(ouvert).toHaveLength(1);
    expect(ouvert[0].status).toBe("RUNNING");
    expect(ouvert[0].triggerSource).toBe("CRON");
    expect(ouvert[0].finishedAt).toBeNull();
    expect(ouvert[0].workspaceId).toBe(WS_A);

    await executerSysteme(WS_A)((tx, ctx) =>
      cloreSyncRun(tx, ctx, {
        syncRunId,
        statut: "COMPLETED",
        comptesTraites: 3,
        transactionsUpsertees: 42,
      }),
    );
    const clos = await executerSysteme(WS_A)((tx) =>
      tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)),
    );
    expect(clos[0].status).toBe("COMPLETED");
    expect(clos[0].comptesTraites).toBe(3);
    expect(clos[0].transactionsUpsertees).toBe(42);
    expect(clos[0].finishedAt).not.toBeNull();
  });

  it("clôture FAILED avec erreur_code (code machine seul)", async () => {
    const { syncRunId } = await executerSysteme(WS_A)((tx, ctx) =>
      ouvrirSyncRun(tx, ctx, { connectionId: CONN_A, declencheur: "WEBHOOK" }),
    );
    await executerSysteme(WS_A)((tx, ctx) =>
      cloreSyncRun(tx, ctx, {
        syncRunId,
        statut: "FAILED",
        comptesTraites: 0,
        transactionsUpsertees: 0,
        erreurCode: "LOGIN_FAILED",
      }),
    );
    const [run] = await executerSysteme(WS_A)((tx) =>
      tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)),
    );
    expect(run.status).toBe("FAILED");
    expect(run.erreurCode).toBe("LOGIN_FAILED");
  });
});

describe("isolation tenant (RLS) + FK composite scopée workspace", () => {
  it("un run de A est INVISIBLE depuis B (0 ligne, pas une erreur)", async () => {
    const { syncRunId } = await executerSysteme(WS_A)((tx, ctx) =>
      ouvrirSyncRun(tx, ctx, { connectionId: CONN_A2, declencheur: "MANUAL" }),
    );
    const vuParB = await executerSysteme(WS_B)((tx) =>
      tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)),
    );
    expect(vuParB).toHaveLength(0);
  });

  it("ouvrir un run depuis B en pointant une connexion de A → REJETÉ (FK composite)", async () => {
    await expect(
      executerSysteme(WS_B)((tx, ctx) =>
        ouvrirSyncRun(tx, ctx, { connectionId: CONN_A, declencheur: "CRON" }),
      ),
    ).rejects.toThrow();
  });

  it("cloreSyncRun depuis B sur un run de A → sans effet (RLS + WHERE workspace)", async () => {
    const { syncRunId } = await executerSysteme(WS_A)((tx, ctx) =>
      ouvrirSyncRun(tx, ctx, { connectionId: CONN_A, declencheur: "MANUAL" }),
    );
    await executerSysteme(WS_B)((tx, ctx) =>
      cloreSyncRun(tx, ctx, {
        syncRunId,
        statut: "COMPLETED",
        comptesTraites: 99,
        transactionsUpsertees: 99,
      }),
    );
    const [run] = await executerSysteme(WS_A)((tx) =>
      tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)),
    );
    expect(run.status, "toujours RUNNING — B n'a rien pu clore").toBe("RUNNING");
  });
});

describe("intégrité du journal", () => {
  it("CHECK de cohérence : passer un run en COMPLETED SANS finished_at → check_violation", async () => {
    const { syncRunId } = await executerSysteme(WS_A)((tx, ctx) =>
      ouvrirSyncRun(tx, ctx, { connectionId: CONN_A, declencheur: "CRON" }),
    );
    // Drizzle enveloppe l'erreur PG (« Failed query: … ») : on prouve le REJET
    // puis l'invariance de la ligne, pas le libellé du driver.
    await expect(
      executerSysteme(WS_A)((tx) =>
        tx.execute(
          dsql`update sync_runs set status = 'COMPLETED' where id = ${syncRunId}`,
        ),
      ),
    ).rejects.toThrow();
    const [run] = await executerSysteme(WS_A)((tx) =>
      tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)),
    );
    expect(run.status, "la ligne n'a pas bougé (CHECK)").toBe("RUNNING");
  });

  it("DELETE direct sous tygr_app → permission denied (hors liste blanche — contre-preuve m5)", async () => {
    // La CASCADE de déconnexion (test suivant) est le SEUL chemin de
    // suppression : un DELETE direct doit échouer au PRIVILÈGE. Sans cette
    // contre-preuve, une régression de provisioning (sync_runs ajoutée à la
    // liste blanche, ou GRANT DELETE en bloc) passerait la CI.
    await expect(
      executerSysteme(WS_A)((tx) => tx.execute(dsql`delete from sync_runs`)),
    ).rejects.toThrow();
  });

  it("déconnexion d'une banque → CASCADE : ses runs disparaissent (journal probant = audit_events, pas ici)", async () => {
    const CONN_TMP = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await executerSysteme(WS_A)((tx) =>
      tx.execute(dsql`
        insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by)
        values (${CONN_TMP}, ${WS_A}, 'omni-conn-tmp', 'inst-9', ${ALICE})
      `),
    );
    const { syncRunId } = await executerSysteme(WS_A)((tx, ctx) =>
      ouvrirSyncRun(tx, ctx, { connectionId: CONN_TMP, declencheur: "CRON" }),
    );
    await executerSysteme(WS_A)((tx) =>
      tx.execute(dsql`delete from bank_connections where id = ${CONN_TMP}`),
    );
    const restes = await executerSysteme(WS_A)((tx) =>
      tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)),
    );
    expect(restes).toHaveLength(0);
  });
});

describe("énumération système des workspaces (itérateur du cron)", () => {
  it("filtre par environnement : sandbox rend A et B, jamais le workspace production", async () => {
    const sandbox = await listerWorkspaces("sandbox");
    const ids = sandbox.map((w) => w.id);
    expect(ids).toContain(WS_A);
    expect(ids).toContain(WS_B);
    expect(ids, "cloison d'environnement — même règle que le cross-check webhook").not.toContain(WS_PROD);

    const production = await listerWorkspaces("production");
    expect(production.map((w) => w.id)).toEqual([WS_PROD]);
  });

  it("sous le rôle OWNER → refus (garde C6 fail-closed, jamais d'énumération hors rôle applicatif)", async () => {
    await client.exec(`reset role;`);
    try {
      await expect(listerWorkspaces("sandbox")).rejects.toMatchObject({
        code: "UNSAFE_DB_ROLE",
      });
    } finally {
      await client.exec(`set role tygr_app;`);
    }
  });
});
