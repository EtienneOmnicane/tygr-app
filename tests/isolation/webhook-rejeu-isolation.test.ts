/**
 * Rejeu de quarantaine W5 (drizzle-sur-PGlite) — prouve sur un Postgres réel ce que
 * l'unitaire ne traverse pas : les primitives de rejeu SOUS tygr_service (listing
 * borné par replayed_at/plafond, marquage, compteur, purge TTL avec distinction
 * abandon), leurs gardes de rôle fail-closed, et un rejeu de BOUT EN BOUT
 * (résolution réelle → audit réel avec dédup → sortie de quarantaine).
 * Même montage que webhook-integration-isolation.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/server/db/schema";
import { auditEvents } from "@/server/db/schema";
import {
  createEnregistrerEchecRejeu,
  createListerQuarantaineEnAttente,
  createMarquerQuarantaineRejouee,
  createPurgerQuarantaineExpiree,
  createResoudreConnexion,
  type LigneQuarantaineEnAttente,
} from "@/server/db/service";
import { createExecuterSysteme } from "@/server/db/systeme";
import { consignerEvenementWebhook } from "@/server/repositories/audit";
import {
  PLAFOND_REJEUX,
  rejouerEvenement,
  type DepsRejeuWebhook,
} from "@/server/webhooks/omnifi/rejeu";

const client = new PGlite();
const db = drizzle(client, { schema });
const resoudre = createResoudreConnexion(db);
const lister = createListerQuarantaineEnAttente(db);
const marquer = createMarquerQuarantaineRejouee(db);
const compterEchec = createEnregistrerEchecRejeu(db);
const purger = createPurgerQuarantaineExpiree(db);
const executerSysteme = createExecuterSysteme(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const CONN_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Insère une ligne de quarantaine sous tygr_service (seule voie d'écriture). */
async function seedQuarantaine(o: {
  eventId: string;
  omnifiConnectionId?: string;
  eventType?: string;
  recuIlYAJours?: number;
  replayedAt?: boolean;
  replayCount?: number;
}) {
  await client.exec(`
    set role tygr_service;
    insert into webhook_events_pending
      (omnifi_event_id, omnifi_connection_id, event_type, omnifi_environment, motif,
       received_at, replayed_at, replay_count)
    values (
      '${o.eventId}',
      '${o.omnifiConnectionId ?? "omni-conn-A"}',
      '${o.eventType ?? "sync.completed"}',
      'sandbox',
      'CONNEXION_INCONNUE',
      now() - interval '${o.recuIlYAJours ?? 0} days',
      ${o.replayedAt ? "now()" : "NULL"},
      ${o.replayCount ?? 0}
    );
    reset role;
  `);
}

/** Listing sous tygr_service (plafond réel), role remis derrière. */
async function listerEnService(filtre?: {
  omnifiConnectionId?: string;
  limite?: number;
}): Promise<LigneQuarantaineEnAttente[]> {
  await client.exec(`set role tygr_service;`);
  try {
    return await lister({
      omnifiConnectionId: filtre?.omnifiConnectionId,
      plafondRejeux: PLAFOND_REJEUX,
      limite: filtre?.limite ?? 100,
    });
  } finally {
    await client.exec(`reset role;`);
  }
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
      ('${CONN_A}', '${WS_A}', 'omni-conn-A', 'inst-1', '${ALICE}');
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

describe("listing en attente — bornes replayed_at / plafond / connexion / limite", () => {
  it("ne rend que les lignes NON rejouées et SOUS le plafond, en FIFO", async () => {
    await seedQuarantaine({ eventId: "L1", recuIlYAJours: 2 });
    await seedQuarantaine({ eventId: "L2", omnifiConnectionId: "omni-conn-X", recuIlYAJours: 1 });
    await seedQuarantaine({ eventId: "L3", replayedAt: true }); // déjà rejouée
    await seedQuarantaine({ eventId: "L4", replayCount: PLAFOND_REJEUX }); // au plafond

    const lignes = await listerEnService();
    const ids = lignes.map((l) => l.omnifiEventId);
    expect(ids).toContain("L1");
    expect(ids).toContain("L2");
    expect(ids, "une ligne rejouée sort du balayage").not.toContain("L3");
    expect(ids, "une ligne au plafond sort du balayage").not.toContain("L4");
    // FIFO : L1 (J-2) avant L2 (J-1).
    expect(ids.indexOf("L1")).toBeLessThan(ids.indexOf("L2"));
  });

  it("filtre par connexion (chemin link-exchange) et respecte la limite", async () => {
    const cibles = await listerEnService({ omnifiConnectionId: "omni-conn-X" });
    expect(cibles.map((l) => l.omnifiEventId)).toEqual(["L2"]);

    const borne = await listerEnService({ limite: 1 });
    expect(borne, "limite appliquée").toHaveLength(1);
    expect(borne[0].omnifiEventId, "la plus ancienne d'abord").toBe("L1");
  });
});

describe("marquage et compteur d'échec", () => {
  it("marquerQuarantaineRejouee → la ligne sort du balayage", async () => {
    await seedQuarantaine({ eventId: "M1" });
    const avant = await listerEnService();
    const ligne = avant.find((l) => l.omnifiEventId === "M1");
    expect(ligne).toBeDefined();

    await client.exec(`set role tygr_service;`);
    await marquer(ligne!.id);
    await client.exec(`reset role;`);

    const apres = await listerEnService();
    expect(apres.map((l) => l.omnifiEventId)).not.toContain("M1");
  });

  it("enregistrerEchecRejeu incrémente et rend le total ; au plafond la ligne sort du balayage", async () => {
    await seedQuarantaine({ eventId: "M2", replayCount: PLAFOND_REJEUX - 2 });
    const [ligne] = (await listerEnService()).filter((l) => l.omnifiEventId === "M2");

    await client.exec(`set role tygr_service;`);
    const a = await compterEchec(ligne.id);
    expect(a.tentatives).toBe(PLAFOND_REJEUX - 1);
    const b = await compterEchec(ligne.id);
    expect(b.tentatives).toBe(PLAFOND_REJEUX);
    await client.exec(`reset role;`);

    const apres = await listerEnService();
    expect(apres.map((l) => l.omnifiEventId)).not.toContain("M2");
  });
});

describe("purge TTL — jamais silencieuse, distinction abandon", () => {
  it("supprime les lignes expirées seulement, en distinguant abandonnées / rejouées", async () => {
    await seedQuarantaine({ eventId: "P1", recuIlYAJours: 31 }); // expirée, jamais rejouée
    await seedQuarantaine({ eventId: "P2", recuIlYAJours: 31, replayedAt: true }); // expirée, rejouée
    await seedQuarantaine({ eventId: "P3", recuIlYAJours: 5 }); // récente

    await client.exec(`set role tygr_service;`);
    const purgees = await purger(new Date(Date.now() - 30 * 24 * 3600 * 1000));
    await client.exec(`reset role;`);

    const parId = new Map(purgees.map((p) => [p.omnifiEventId, p]));
    expect(parId.get("P1")?.abandonnee, "jamais rejouée = ABANDON").toBe(true);
    expect(parId.get("P2")?.abandonnee, "rejouée = purge de trace, pas un abandon").toBe(false);
    expect(parId.has("P3"), "une ligne récente survit à la purge").toBe(false);

    const restantes = await listerEnService();
    expect(restantes.map((l) => l.omnifiEventId)).toContain("P3");
    expect(restantes.map((l) => l.omnifiEventId)).not.toContain("P1");
  });
});

describe("gardes de rôle — fail-closed sur les 4 primitives", () => {
  it("sous tygr_app → ROLE_SERVICE_INATTENDU sur lister/marquer/compter/purger", async () => {
    await client.exec(`set role tygr_app;`);
    const attendu = { code: "ROLE_SERVICE_INATTENDU" };
    await expect(
      lister({ plafondRejeux: PLAFOND_REJEUX, limite: 10 }),
    ).rejects.toMatchObject(attendu);
    await expect(marquer("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject(attendu);
    await expect(compterEchec("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject(attendu);
    await expect(purger(new Date())).rejects.toMatchObject(attendu);
    await client.exec(`reset role;`);
  });

  it("sous l'OWNER → ROLE_SERVICE_INATTENDU (jamais de purge sous un rôle trop puissant)", async () => {
    await client.exec(`reset role;`);
    await expect(purger(new Date())).rejects.toMatchObject({
      code: "ROLE_SERVICE_INATTENDU",
    });
  });
});

describe("rejeu de bout en bout — pipeline complet sur SQL réel", () => {
  /** Deps câblées PGlite : chaque étage sous SON rôle (comme en prod). */
  function depsPglite(
    enqueue: DepsRejeuWebhook["enqueue"] = vi.fn(async () => {}),
  ): DepsRejeuWebhook {
    return {
      envDeploiement: "sandbox",
      resoudreConnexion: async (id) => {
        await client.exec(`set role tygr_service;`);
        try {
          return await resoudre(id);
        } finally {
          await client.exec(`reset role;`);
        }
      },
      lireEnvWorkspace: async (workspaceId) => {
        await client.exec(`set role tygr_app;`);
        try {
          return await executerSysteme(workspaceId)(async (tx) => {
            const r = await tx
              .select({ env: schema.workspaces.omnifiEnvironment })
              .from(schema.workspaces)
              .where(eq(schema.workspaces.id, workspaceId))
              .limit(1);
            const env = r[0]?.env;
            return env === "sandbox" || env === "production" ? env : null;
          });
        } finally {
          await client.exec(`reset role;`);
        }
      },
      enqueue,
      consignerAudit: async (workspaceId, evt) => {
        await client.exec(`set role tygr_app;`);
        try {
          return await executerSysteme(workspaceId)((tx, ctx) =>
            consignerEvenementWebhook(tx, ctx, evt),
          );
        } finally {
          await client.exec(`reset role;`);
        }
      },
      marquerRejouee: async (id) => {
        await client.exec(`set role tygr_service;`);
        try {
          await marquer(id);
        } finally {
          await client.exec(`reset role;`);
        }
      },
      enregistrerEchec: async (id) => {
        await client.exec(`set role tygr_service;`);
        try {
          return await compterEchec(id);
        } finally {
          await client.exec(`reset role;`);
        }
      },
    };
  }

  it("événement quarantiné dont la connexion existe DÉSORMAIS → livré, audité (WEBHOOK_REJEU, sans acteur), sorti du balayage", async () => {
    await seedQuarantaine({ eventId: "E2E-1", omnifiConnectionId: "omni-conn-A" });
    const [ligne] = (await listerEnService()).filter((l) => l.omnifiEventId === "E2E-1");
    expect(ligne).toBeDefined();

    const enqueues: unknown[] = [];
    const enqueue: DepsRejeuWebhook["enqueue"] = async (donnees) => {
      enqueues.push(donnees);
    };
    const r = await rejouerEvenement(depsPglite(enqueue), ligne, "e2e-run");
    expect(r).toEqual({ issue: "REJOUE" });
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0]).toMatchObject({
      workspaceId: WS_A,
      cleIdempotence: "wh:E2E-1",
    });

    // Trace d'audit dans WS_A : acte système (actor NULL), signature NULL, payload rejeu.
    await client.exec(`set role tygr_app;`);
    const audits = await executerSysteme(WS_A)((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.omnifiEventId, "E2E-1")),
    );
    await client.exec(`reset role;`);
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBeNull();
    expect(audits[0].hmacSignatureTruncated).toBeNull();
    expect(audits[0].payload).toMatchObject({ declencheur: "WEBHOOK_REJEU" });

    // Sortie de quarantaine.
    const restantes = await listerEnService();
    expect(restantes.map((l) => l.omnifiEventId)).not.toContain("E2E-1");
  });

  it("rejeu concurrent du même événement → l'audit déduplique (DEJA_VU), jamais deux traces", async () => {
    // Re-simule la course : la ligne a déjà été livrée (audit posé ci-dessus) mais un
    // second run la retient encore (listing lu avant le marquage du premier).
    const ligneFantome: LigneQuarantaineEnAttente = {
      id: "00000000-0000-4000-8000-00000000e2e1",
      omnifiEventId: "E2E-1",
      omnifiConnectionId: "omni-conn-A",
      eventType: "sync.completed",
      omnifiJobId: null,
      motif: "CONNEXION_INCONNUE",
      replayCount: 0,
    };
    const r = await rejouerEvenement(depsPglite(), ligneFantome, "e2e-run-2");
    expect(r).toEqual({ issue: "DEJA_VU" });

    await client.exec(`set role tygr_app;`);
    const audits = await executerSysteme(WS_A)((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.omnifiEventId, "E2E-1")),
    );
    await client.exec(`reset role;`);
    expect(audits, "une seule trace malgré deux livraisons").toHaveLength(1);
  });

  it("connexion toujours inconnue sur SQL réel → échec compté, la ligne reste en attente", async () => {
    await seedQuarantaine({ eventId: "E2E-2", omnifiConnectionId: "omni-conn-jamais-vue" });
    const [ligne] = (await listerEnService()).filter((l) => l.omnifiEventId === "E2E-2");

    const enqueue = vi.fn(async () => {});
    const r = await rejouerEvenement(depsPglite(enqueue), ligne, "e2e-run-3");
    expect(r).toMatchObject({
      issue: "TOUJOURS_EN_QUARANTAINE",
      motif: "CONNEXION_INCONNUE",
      tentatives: 1,
    });
    expect(enqueue).not.toHaveBeenCalled();

    const restantes = await listerEnService();
    const encore = restantes.find((l) => l.omnifiEventId === "E2E-2");
    expect(encore, "toujours en attente, compteur incrémenté").toBeDefined();
    expect(encore!.replayCount).toBe(1);
  });
});
