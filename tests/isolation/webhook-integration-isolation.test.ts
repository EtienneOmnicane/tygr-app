/**
 * Intégration webhook (drizzle-sur-PGlite) — prouve, sur un Postgres réel, ce que le
 * SQL brut ne traverse pas : la GARDE RUNTIME `exigerRoleService` (miroir C6), le
 * writer de quarantaine sous tygr_service, le ROUTAGE d'audit borné au tenant (§10.2
 * cas 7), et la dédup `ON CONFLICT`. Même montage que systeme-execution-isolation.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { auditEvents } from "@/server/db/schema";
import {
  createInsererQuarantaine,
  createResoudreConnexion,
} from "@/server/db/service";
import { createExecuterSysteme } from "@/server/db/systeme";
import { consignerEvenementWebhook } from "@/server/repositories/audit";

const client = new PGlite();
const db = drizzle(client, { schema });
const resoudre = createResoudreConnexion(db);
const quarantaine = createInsererQuarantaine(db);
const executerSysteme = createExecuterSysteme(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const CONN_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONN_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function evtQuarantaine(omnifiEventId: string) {
  return {
    omnifiEventId,
    omnifiConnectionId: "omni-conn-A",
    eventType: "sync.completed",
    omnifiEnvironment: "sandbox" as const,
    motif: "CONNEXION_INCONNUE" as const,
    payload: {},
  };
}

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
      ('${WS_B}', 'BU B', 'INTERNAL_BU', 'enduser-b', 'sandbox');
    insert into users (id, email, full_name) values ('${ALICE}', 'alice@groupe.mu', 'Alice');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}', '${WS_A}', 'omni-conn-A', 'inst-1', '${ALICE}'),
      ('${CONN_B}', '${WS_B}', 'omni-conn-B', 'inst-2', '${ALICE}');
  `);
  const provisioning = readFileSync(
    path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
    "utf8",
  );
  await client.exec(provisioning);
});

afterAll(async () => {
  await client.close();
});

describe("garde runtime exigerRoleService (miroir C6, fail-closed)", () => {
  it("sous tygr_service → résout la connexion (1 ligne, workspace attendu)", async () => {
    await client.exec(`set role tygr_service;`);
    const r = await resoudre("omni-conn-A");
    await client.exec(`reset role;`);
    expect(r).toHaveLength(1);
    expect(r[0].workspaceId).toBe(WS_A);
  });

  it("sous l'OWNER → RoleServiceInattenduError (jamais de résolution sous un rôle trop puissant)", async () => {
    await client.exec(`reset role;`); // owner
    await expect(resoudre("omni-conn-A")).rejects.toMatchObject({
      code: "ROLE_SERVICE_INATTENDU",
    });
  });

  it("sous tygr_app → RoleServiceInattenduError", async () => {
    await client.exec(`set role tygr_app;`);
    await expect(resoudre("omni-conn-A")).rejects.toMatchObject({
      code: "ROLE_SERVICE_INATTENDU",
    });
    await client.exec(`reset role;`);
  });
});

describe("writer de quarantaine (tygr_service)", () => {
  it("sous tygr_service → INSERT puis dédup ON CONFLICT (même EventId)", async () => {
    await client.exec(`set role tygr_service;`);
    const a = await quarantaine(evtQuarantaine("evt-q1"));
    const b = await quarantaine(evtQuarantaine("evt-q1"));
    await client.exec(`reset role;`);
    expect(a.insere).toBe(true);
    expect(b.insere).toBe(false); // dédup : pas de doublon
  });

  it("sous tygr_app → la garde runtime REFUSE avant toute écriture", async () => {
    await client.exec(`set role tygr_app;`);
    await expect(quarantaine(evtQuarantaine("evt-q2"))).rejects.toMatchObject({
      code: "ROLE_SERVICE_INATTENDU",
    });
    await client.exec(`reset role;`);
  });
});

describe("routage audit — borné au tenant résolu (§10.2 cas 7)", () => {
  it("un événement de WS_A n'apparaît JAMAIS dans l'audit de WS_B", async () => {
    await client.exec(`set role tygr_app;`);
    const res = await executerSysteme(WS_A)((tx, ctx) =>
      consignerEvenementWebhook(tx, ctx, {
        omnifiEventId: "evt-route",
        eventType: "sync.completed",
        connectionId: CONN_A,
        hmacSignatureTruncated: "abcd1234",
      }),
    );
    expect(res.insere).toBe(true);

    const vuParA = await executerSysteme(WS_A)((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.omnifiEventId, "evt-route")),
    );
    const vuParB = await executerSysteme(WS_B)((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.omnifiEventId, "evt-route")),
    );
    await client.exec(`reset role;`);

    expect(vuParA).toHaveLength(1);
    // actor_user_id = null (acte système, jamais la sentinelle) ; connection = interne A.
    expect(vuParA[0].actorUserId).toBeNull();
    expect(vuParA[0].connectionId).toBe(CONN_A);
    expect(vuParB, "aucune fuite cross-tenant de l'audit").toHaveLength(0);
  });

  it("dédup : le même EventId dans le même workspace → insere=false la 2e fois", async () => {
    await client.exec(`set role tygr_app;`);
    const evt = {
      omnifiEventId: "evt-dedup",
      eventType: "sync.completed",
      connectionId: CONN_A,
      hmacSignatureTruncated: "beef0000",
    };
    const a = await executerSysteme(WS_A)((tx, ctx) =>
      consignerEvenementWebhook(tx, ctx, evt),
    );
    const b = await executerSysteme(WS_A)((tx, ctx) =>
      consignerEvenementWebhook(tx, ctx, evt),
    );
    await client.exec(`reset role;`);
    expect(a.insere).toBe(true);
    expect(b.insere).toBe(false);
  });
});
