/**
 * Suite anti-IDOR — primitive SYSTÈME `executerPourWorkspaceSysteme` (lot W1,
 * PLAN-ingestion-webhook-omnifi.md §6.1).
 *
 * La primitive contourne la re-validation de membership (chemins sans session :
 * fonctions Inngest). Ce qu'elle NE contourne JAMAIS, prouvé ici sur un
 * Postgres réel (PGlite, migrations réelles, rôle tygr_app non-propriétaire) :
 *  - la RLS tenant : tout ce que fait le job est borné au workspace demandé —
 *    lectures ET écritures (ingestion complète) ;
 *  - fail-closed cross-tenant : une connexion d'un AUTRE workspace résout à
 *    « inconnue » (aucun appel amont, aucune ligne routée) ;
 *  - la garde owner C6 : sous le propriétaire des tables, la primitive REFUSE
 *    de servir (UnsafeDatabaseRoleError) ;
 *  - le contrat §6.1 : GUC workspace posé, PAS de app.current_user_id, aucun
 *    GUC d'étage 2 (Vision Globale).
 *
 * Même montage que ingestion-isolation.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { transactionsCache } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  createExecuterSysteme,
  WorkspaceSystemeInvalideError,
} from "@/server/db/systeme";
import {
  ingererComptesConnexion,
  listerComptesAIngerer,
  resoudreContexteConnexion,
} from "@/server/inngest/fonctions/sync-ingest";
import { upsertCompte, upsertConnexion } from "@/server/repositories/ingestion";
import type { OmniFiClient } from "@/server/omnifi";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);
const executerSysteme = createExecuterSysteme(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111"; // MANAGER de A
const BOB = "22222222-2222-4222-8222-222222222222"; // MANAGER de B

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

/** Connexion + compte SÉLECTIONNÉ dans un workspace (chemin normal, sous session). */
async function prerequisCompte(
  session: typeof sessionA,
  omnifiConnId: string,
  omnifiAccId: string,
) {
  return withWorkspace(session, async (tx, ctx) => {
    const { connectionId } = await upsertConnexion(tx, ctx, {
      omnifiConnectionId: omnifiConnId,
      institutionId: "mcb",
      institutionName: "MCB (fixture)",
      status: "active",
      nextSyncAvailableAt: null,
    });
    const { bankAccountId } = await upsertCompte(tx, ctx, connectionId, {
      omnifiAccountId: omnifiAccId,
      accountName: "Compte courant",
      currency: "MUR",
      currentBalance: "1000.00",
      isSelected: true,
    });
    return bankAccountId;
  });
}

/** Client Omni-FI factice : 1 page de 2 transactions + 1 page de 1 solde EOD. */
function clientFakeUnePage(omnifiAccId: string): OmniFiClient {
  return {
    listerTransactionsPage: async () => ({
      Data: {
        Transaction: [
          {
            TransactionId: `tx-${omnifiAccId}-1`,
            AccountId: omnifiAccId,
            TransactionInformation: "LOYER EBENE",
            Amount: { Amount: "1500.00", Currency: "MUR" },
            CreditDebitIndicator: "Debit",
            Status: "Booked",
            BookingDateTime: "2026-06-10T05:30:00Z",
          },
          {
            TransactionId: `tx-${omnifiAccId}-2`,
            AccountId: omnifiAccId,
            TransactionInformation: "VIREMENT CLIENT",
            Amount: { Amount: "2500.00", Currency: "MUR" },
            CreditDebitIndicator: "Credit",
            Status: "Booked",
            BookingDateTime: "2026-06-11T05:30:00Z",
          },
        ],
      },
      Links: { Next: null },
      Meta: { TotalPages: 1 },
    }),
    historiqueSoldes: async () => ({
      Data: {
        HistoricalBalances: [
          {
            Date: "2026-06-10",
            Balance: { Amount: { Amount: "1000.00", Currency: "MUR" } },
          },
        ],
      },
      Links: { Next: null },
      Meta: { TotalPages: 1 },
    }),
  } as unknown as OmniFiClient;
}

/** Client PIÉGÉ : tout appel réseau est une faute (prouve « zéro appel amont »). */
function clientPiege(): OmniFiClient {
  const boom = () => {
    throw new Error("appel amont interdit dans ce scénario");
  };
  return {
    listerTransactionsPage: boom,
    historiqueSoldes: boom,
    declencherSync: boom,
    getSyncJobServeur: boom,
    getLatestSyncJob: boom,
  } as unknown as OmniFiClient;
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
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}', 'BU A', 'INTERNAL_BU', 'enduser-a'),
      ('${WS_B}', 'BU B', 'INTERNAL_BU', 'enduser-b');
    insert into users (id, email, full_name) values
      ('${ALICE}', 'alice@groupe.mu', 'Alice'),
      ('${BOB}',   'bob@groupe.mu',   'Bob');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}', '${WS_A}', 'MANAGER'),
      ('${BOB}',   '${WS_B}', 'MANAGER');
  `);

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

describe("primitive système — contrat §6.1", () => {
  it("refuse un workspaceId non-UUID (rejet bruyant, avant toute transaction)", () => {
    expect(() => executerSysteme("pas-un-uuid")).toThrow(
      WorkspaceSystemeInvalideError,
    );
  });

  it("pose le GUC workspace, PAS de current_user_id, aucun GUC d'étage 2 (Vision Globale)", async () => {
    const gucs = await executerSysteme(WS_A)(async (tx) => {
      const r = await tx.execute(
        sql`select current_setting('app.current_workspace_id', true) as ws,
                   current_setting('app.current_user_id', true) as usr,
                   current_setting('app.current_entity_scope', true) as ent,
                   current_setting('app.current_account_scope', true) as acc`,
      );
      return (
        r as unknown as {
          rows: { ws: string; usr: string | null; ent: string | null; acc: string | null }[];
        }
      ).rows[0];
    });
    expect(gucs.ws).toBe(WS_A);
    // set_config jamais appelé pour ces GUC dans la transaction : vide ou NULL.
    expect(gucs.usr ?? "").toBe("");
    expect(gucs.ent ?? "").toBe("");
    expect(gucs.acc ?? "").toBe("");
  });

  it("fournit un contexte Vision Globale (MANAGER, utilisateur sentinelle)", async () => {
    const ctx = await executerSysteme(WS_A)(async (_tx, c) => c);
    expect(ctx.workspaceId).toBe(WS_A);
    expect(ctx.role).toBe("MANAGER");
    expect(ctx.userId).toBe("00000000-0000-0000-0000-000000000000");
    expect(ctx.entityScope).toEqual({ mode: "GLOBALE" });
    expect(ctx.accountScope).toEqual({ mode: "GLOBALE" });
  });

  it("garde owner C6 : sous le propriétaire des tables, REFUSE de servir (fail-closed)", async () => {
    await client.exec(`reset role;`);
    try {
      await expect(
        executerSysteme(WS_A)(async () => "ne doit jamais servir"),
      ).rejects.toMatchObject({ code: "UNSAFE_DB_ROLE" });
    } finally {
      await client.exec(`set role tygr_app;`);
    }
  });
});

describe("primitive système — isolation tenant de l'ingestion durable", () => {
  it("ingère les comptes d'une connexion DANS son workspace ; rien n'est visible de l'autre tenant", async () => {
    await prerequisCompte(sessionA, "conn-sys-a", "acc-sys-a");

    const resultat = await ingererComptesConnexion(
      clientFakeUnePage("acc-sys-a"),
      executerSysteme(WS_A),
      { omnifiConnectionId: "conn-sys-a", clientUserId: "enduser-a" },
    );

    expect(resultat).toEqual({
      statut: "OK",
      comptes: 1,
      transactions: 2,
      soldes: 1,
    });

    // Sous A : les 2 transactions ingérées par le chemin SYSTÈME sont là.
    const vuParA = await withWorkspace(sessionA, (tx) =>
      tx.select().from(transactionsCache),
    );
    expect(
      vuParA.filter((t) => t.omnifiTxnId.startsWith("tx-acc-sys-a")).length,
    ).toBe(2);

    // Sous B : zéro ligne (RLS) — l'ingestion système n'a rien routé hors tenant.
    const vuParB = await withWorkspace(sessionB, (tx) =>
      tx.select().from(transactionsCache),
    );
    expect(vuParB.length).toBe(0);
  });

  it("cross-tenant fail-closed : la connexion d'un AUTRE workspace est INCONNUE (zéro appel amont)", async () => {
    // Résolution : la connexion de A n'existe pas vue de B (RLS, pas un WHERE).
    const contexte = await resoudreContexteConnexion(
      executerSysteme(WS_B),
      "conn-sys-a",
    );
    expect(contexte).toEqual({ present: false });

    // Comptes à ingérer : aucun — et le client piégé prouve qu'AUCUN appel
    // amont n'est parti pour ce tenant.
    const comptes = await listerComptesAIngerer(executerSysteme(WS_B), "conn-sys-a");
    expect(comptes).toEqual([]);

    const resultat = await ingererComptesConnexion(clientPiege(), executerSysteme(WS_B), {
      omnifiConnectionId: "conn-sys-a",
      clientUserId: "enduser-b",
    });
    expect(resultat).toEqual({
      statut: "AUCUN_COMPTE",
      comptes: 0,
      transactions: 0,
      soldes: 0,
    });
  });

  it("contre-preuve : la même ingestion sous le workspace LÉGITIME voit bien la connexion", async () => {
    const contexte = await resoudreContexteConnexion(
      executerSysteme(WS_A),
      "conn-sys-a",
    );
    expect(contexte).toMatchObject({ present: true, clientUserId: "enduser-a" });
  });
});
