/**
 * Suite anti-IDOR — orchestration du flux Link Widget (PR-W2, CLAUDE.md règle 2).
 *
 * Prouve sur Postgres réel (PGlite, rôle tygr_app) que :
 *  - finaliserConnexion persiste connexion + comptes UNIQUEMENT dans le workspace
 *    courant (le ClientUserId vient du workspace, jamais d'un paramètre) ;
 *  - un workspace ne voit jamais les connexions/comptes d'un autre ;
 *  - le gating VIEWER bloque démarrage ET finalisation ;
 *  - un workspace sans omnifi_client_user_id échoue proprement.
 *
 * Le client Omni-FI est FACTICE (aucun réseau) : on injecte les réponses
 * d'echangerPublicToken / getSyncJobAccounts.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/server/db/schema";
import { bankAccounts, bankConnections } from "@/server/db/schema";
import {
  createWithWorkspace,
  WorkspaceAccessDeniedError,
  type ExecuterWorkspace,
} from "@/server/db/tenancy";
import type { OmniFiClient } from "@/server/omnifi";
import { OmniFiApiError } from "@/server/omnifi";
import {
  ConnexionDesalignmentError,
  ConnexionNonAutoriseeError,
  ReparationContexteInvalideError,
  demarrerConnexion,
  demarrerReparation,
  finaliserConnexion,
  finaliserConnexionDropin,
  finaliserConnexionsDropin,
  resynchroniserConnexion,
  synchroniserConnexionsDepuisOmnifi,
} from "@/server/widget/orchestration";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // ADMIN de A
const VIEWER_A = "33333333-3333-4333-8333-333333333333"; // VIEWER de A
const ADMIN_B = "22222222-2222-4222-8222-222222222222"; // ADMIN de B

const execWs =
  (userId: string, workspaceId: string): ExecuterWorkspace =>
  (fn) =>
    withWorkspace({ userId, activeWorkspaceId: workspaceId }, fn);

/** Client factice : echange + accounts + connexions injectables. */
function clientFactice(over: {
  exchange?: Partial<{ ConnectionId: string; InstitutionId: string; CustomerType: "business" }>;
  accounts?: Array<{ AccountId: string; Status: string; Currency: string; PartyName?: string; Balances?: unknown[] }>;
  connections?: Array<{ ConnectionId: string; InstitutionId: string; InstitutionName?: string; Status: string; NextSyncAvailableAt?: string | null }>;
  transactions?: Array<Record<string, unknown>>;
  /** Surcharge le SyncJob renvoyé par le polling (getSyncJobServeur). */
  syncJob?: Record<string, unknown>;
  /** Fait REJETER declencherSync (ex. OmniFiApiError 400/429) au lieu de réussir. */
  declencherSyncErreur?: unknown;
  /** Surcharge le SyncJob renvoyé par getLatestSyncJob (après un 400 concurrent). */
  latestSyncJob?: Record<string, unknown>;
} = {}): OmniFiClient {
  return {
    creerLinkToken: vi.fn().mockResolvedValue({ LinkToken: "lt_x", Expiration: "2026-06-15T00:15:00Z" }),
    echangerPublicToken: vi.fn().mockResolvedValue({
      ConnectionId: over.exchange?.ConnectionId ?? "conn-omnifi-1",
      InstitutionId: over.exchange?.InstitutionId ?? "mcb",
      CustomerType: "business",
    }),
    getSyncJobAccounts: vi.fn().mockResolvedValue({
      Account: over.accounts ?? [
        { AccountId: "oa-1", Status: "Enabled", Currency: "MUR", PartyName: "Compte 1", Balances: [{ Type: "ITAV", Amount: { Amount: "5000.00", Currency: "MUR" } }] },
      ],
    }),
    // GET /connections?clientUserId= (chemin synchronisation) : enveloppe complète.
    listerConnexions: vi.fn().mockResolvedValue({
      Data: {
        Connections: over.connections ?? [
          { ConnectionId: over.exchange?.ConnectionId ?? "conn-omnifi-1", InstitutionId: over.exchange?.InstitutionId ?? "mcb", InstitutionName: "MCB", CustomerType: "CORPORATE", Status: "active", CreatedAt: "2026-06-16T00:00:00Z" },
        ],
      },
      Links: {},
      Meta: { TotalPages: 1 },
    }),
    // GET /accounts?connectionId= (flux drop-in) : enveloppe { Data, Links, Meta }.
    listerComptesConnexion: vi.fn().mockResolvedValue({
      Data: {
        Account: over.accounts ?? [
          { AccountId: "oa-1", Status: "Enabled", Currency: "MUR", PartyName: "Compte 1", Balances: [{ Type: "ITAV", Amount: { Amount: "5000.00", Currency: "MUR" } }] },
        ],
      },
      Links: {},
      Meta: { TotalPages: 1 },
    }),
    // GET /accounts/{id}/transactions (ingestion des transactions au fil de la synchro).
    listerTransactionsPage: vi.fn().mockResolvedValue({
      Data: { Transaction: over.transactions ?? [] },
      Links: { Next: null },
      Meta: { TotalPages: 1 },
    }),
    // POST /sync/{connectionId} (déclenchement réel) : par défaut un job PENDING
    // (l'attente le verra COMPLETED via getSyncJobServeur ci-dessous). Si
    // declencherSyncErreur est fourni, on REJETTE (ex. 400/429).
    declencherSync: over.declencherSyncErreur
      ? vi.fn().mockRejectedValue(over.declencherSyncErreur)
      : vi.fn().mockResolvedValue({
          JobId: "job-sync-1",
          Status: "PENDING",
          IsManual: true,
        }),
    // GET /sync/job/{jobId} (polling ApiKey) : par défaut COMPLETED dès le 1er poll
    // (cas sandbox t+0s), PersistenceStats à 0 (sandbox gelée). Surchargeable.
    getSyncJobServeur: vi.fn().mockResolvedValue(
      over.syncJob ?? {
        JobId: "job-sync-1",
        Status: "COMPLETED",
        PersistenceStats: {
          TransactionsCreated: 0,
          TransactionsUpdated: 0,
          TransactionsDuplicated: 0,
          AccountsUpdated: 0,
        },
      },
    ),
    // GET /sync/{connectionId}/latest-job (récup JobId d'un sync en cours / cooldown).
    getLatestSyncJob: vi.fn().mockResolvedValue(
      over.latestSyncJob ?? {
        JobId: "job-sync-1",
        Status: "COMPLETED",
        NextSyncAvailableAt: null,
      },
    ),
  } as unknown as OmniFiClient;
}

/**
 * Sème une connexion RÉELLE dans WS_A (via le chemin widget drop-in, le SEUL qui crée
 * une connexion neuve) et son compte, puis revient. Indispensable depuis le LOT 1 :
 * `synchroniserConnexionsDepuisOmnifi` ne RAFRAÎCHIT plus que les connexions DÉJÀ en
 * base — un cas de sync doit donc pré-semer sa connexion, sinon le périmètre l'ignore.
 * Idempotent vis-à-vis du sync qui suit (mêmes upserts sur omnifi_*_id).
 */
async function semerConnexionEnBase(omnifiConnId: string, accountId: string) {
  const c = clientFactice({
    exchange: { ConnectionId: omnifiConnId, InstitutionId: "mcb" },
    accounts: [
      { AccountId: accountId, Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "100.00", Currency: "MUR" } }] },
    ],
  });
  await finaliserConnexionDropin(c, execWs(ADMIN_A, WS_A), { publicToken: `pt-seed-${omnifiConnId}` });
}

beforeAll(async () => {
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','A','INTERNAL_BU','enduser-a'),
      ('${WS_B}','B','INTERNAL_BU','enduser-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admina@g.mu','Admin A'),
      ('${VIEWER_A}','viewera@g.mu','Viewer A'),
      ('${ADMIN_B}','adminb@g.mu','Admin B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${VIEWER_A}','${WS_A}','VIEWER'),
      ('${ADMIN_B}','${WS_B}','ADMIN');
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

describe("finaliserConnexion — isolation tenant", () => {
  it("persiste connexion + comptes dans le workspace courant (A), invisible de B", async () => {
    const c = clientFactice({
      exchange: { ConnectionId: "conn-A", InstitutionId: "mcb" },
      accounts: [
        { AccountId: "oa-A1", Status: "Enabled", Currency: "MUR", PartyName: "Cpt A1", Balances: [{ Type: "ITAV", Amount: { Amount: "1000.00", Currency: "MUR" } }] },
        { AccountId: "oa-A2", Status: "Disabled", Currency: "MUR" }, // exclu (état non exploitable explicite)
      ],
    });
    const r = await finaliserConnexion(c, execWs(ADMIN_A, WS_A), {
      publicToken: "pt", sessionToken: "st", jobId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(r.comptesRattaches).toBe(1); // seul le compte Enabled (le Disabled est exclu)

    // Sous A : la connexion + le compte existent.
    const vuA = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) => ({
      conns: (await tx.select().from(bankConnections)).length,
      accs: (await tx.select().from(bankAccounts)).length,
    }));
    expect(vuA.conns).toBe(1);
    expect(vuA.accs).toBe(1);

    // Sous B : RIEN (RLS).
    const vuB = await withWorkspace({ userId: ADMIN_B, activeWorkspaceId: WS_B }, async (tx) => ({
      conns: (await tx.select().from(bankConnections)).length,
      accs: (await tx.select().from(bankAccounts)).length,
    }));
    expect(vuB.conns).toBe(0);
    expect(vuB.accs).toBe(0);
  });

  // Régression 2026-06-18 : le sandbox Omni-FI renvoie `Status: null` sur des comptes
  // pourtant valides (vérifié runtime, 21 connexions / comptes avec soldes réels). Le
  // filtre strict `Status === "Enabled"` les rejetait → « 0 compte rattaché sur N banques ».
  // Un Status ABSENT doit être traité comme exploitable ; seul un état non-actif EXPLICITE
  // (Disabled, etc.) est exclu.
  it("rattache un compte au Status null/absent (cas sandbox), exclut un Disabled", async () => {
    const c = clientFactice({
      exchange: { ConnectionId: "conn-null", InstitutionId: "absa" },
      accounts: [
        { AccountId: "oa-null", Status: null, Currency: "MUR", Nickname: "Compte sans statut", Balances: [{ Type: "ITAV", Amount: { Amount: "1710400.00", Currency: "MUR" } }] } as never,
        { AccountId: "oa-undef", Currency: "USD", Nickname: "Statut absent", Balances: [{ Type: "ITAV", Amount: { Amount: "44800.00", Currency: "USD" } }] } as never,
        { AccountId: "oa-off", Status: "Disabled", Currency: "MUR" } as never,
      ],
    });
    const r = await finaliserConnexion(c, execWs(ADMIN_A, WS_A), {
      publicToken: "pt2", sessionToken: "st2", jobId: "550e8400-e29b-41d4-a716-4466554400a1",
    });
    expect(r.comptesRattaches).toBe(2); // les 2 sans statut, PAS le Disabled
  });

  it("1.1 — désalignement exchange↔accounts : comptes d'une AUTRE institution → rejet, RIEN persisté", async () => {
    // L'exchange dit "mcb" mais le job /accounts rapporte un compte "sbm" :
    // signal d'un sessionToken/jobId d'un autre flux → fail-closed.
    const c = clientFactice({
      exchange: { ConnectionId: "conn-mcb", InstitutionId: "mcb" },
      accounts: [
        { AccountId: "oa-sbm", Status: "Enabled", Currency: "MUR", InstitutionId: "sbm", Balances: [] } as never,
      ],
    });
    await expect(
      finaliserConnexion(c, execWs(ADMIN_A, WS_A), {
        publicToken: "pt", sessionToken: "st-autre-flux", jobId: "550e8400-e29b-41d4-a716-446655440099",
      }),
    ).rejects.toBeInstanceOf(ConnexionDesalignmentError);

    // Aucune connexion/compte de ce flux n'a été persisté (au-delà des tests précédents).
    const apres = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) => {
      const conns = await tx.select().from(bankConnections);
      return conns.some((x) => x.omnifiConnectionId === "conn-mcb");
    });
    expect(apres).toBe(false);
  });

  it("le ClientUserId envoyé à Omni-FI est celui du workspace COURANT (frontière tenant)", async () => {
    const c = clientFactice();
    await finaliserConnexion(c, execWs(ADMIN_B, WS_B), {
      publicToken: "pt", sessionToken: "st", jobId: "550e8400-e29b-41d4-a716-446655440001",
    });
    // echangerPublicToken(publicToken, clientUserId) — clientUserId = enduser-b
    expect(c.echangerPublicToken).toHaveBeenCalledWith("pt", "enduser-b");
  });
});

describe("gating de rôle", () => {
  it("VIEWER ne peut PAS démarrer une connexion", async () => {
    const c = clientFactice();
    await expect(
      demarrerConnexion(c, execWs(VIEWER_A, WS_A), { redirectOrigin: "https://app.mu" }),
    ).rejects.toBeInstanceOf(ConnexionNonAutoriseeError);
    expect(c.creerLinkToken).not.toHaveBeenCalled();
  });

  it("VIEWER ne peut PAS finaliser (aucune écriture, aucun appel exchange)", async () => {
    const c = clientFactice();
    await expect(
      finaliserConnexion(c, execWs(VIEWER_A, WS_A), {
        publicToken: "pt", sessionToken: "st", jobId: "550e8400-e29b-41d4-a716-446655440002",
      }),
    ).rejects.toBeInstanceOf(ConnexionNonAutoriseeError);
    expect(c.echangerPublicToken).not.toHaveBeenCalled();
  });

  it("ADMIN peut démarrer : le ClientUserId du workspace est transmis à creerLinkToken", async () => {
    const c = clientFactice();
    const r = await demarrerConnexion(c, execWs(ADMIN_A, WS_A), {
      redirectOrigin: "https://app.mu",
    });
    expect(r.linkToken).toBe("lt_x");
    expect(c.creerLinkToken).toHaveBeenCalledWith(
      expect.objectContaining({ ClientUserId: "enduser-a", RedirectOrigin: "https://app.mu" }),
    );
  });
});

describe("finaliserConnexionDropin — flux widget natif (GET /accounts ApiKey)", () => {
  it("persiste connexion + comptes du workspace courant, invisibles d'un autre", async () => {
    const c = clientFactice({
      exchange: { ConnectionId: "conn-dropin-A", InstitutionId: "mcb" },
      accounts: [
        { AccountId: "oa-dropin-A1", Status: "Enabled", Currency: "MUR", PartyName: "Cpt A", Balances: [{ Type: "ITAV", Amount: { Amount: "2000.00", Currency: "MUR" } }] },
      ],
    });
    const r = await finaliserConnexionDropin(c, execWs(ADMIN_A, WS_A), { publicToken: "pt-dropin" });
    expect(r.comptesRattaches).toBe(1);
    expect(r.connectionId).toBe("conn-dropin-A");

    const vuB = await withWorkspace({ userId: ADMIN_B, activeWorkspaceId: WS_B }, async (tx) =>
      (await tx.select().from(bankConnections)).some((x) => x.omnifiConnectionId === "conn-dropin-A"),
    );
    expect(vuB).toBe(false); // RLS : invisible de B
  });

  it("ClientUserId du workspace courant transmis à echangerPublicToken (frontière tenant)", async () => {
    const c = clientFactice();
    await finaliserConnexionDropin(c, execWs(ADMIN_B, WS_B), { publicToken: "pt-b" });
    expect(c.echangerPublicToken).toHaveBeenCalledWith("pt-b", "enduser-b");
    // découverte de comptes filtrée PAR la connexion échangée, sous le bon clientUserId
    expect(c.listerComptesConnexion).toHaveBeenCalledWith(expect.any(String), "enduser-b", expect.anything());
  });

  it("VIEWER ne peut pas finaliser (dropin) — aucun exchange", async () => {
    const c = clientFactice();
    await expect(
      finaliserConnexionDropin(c, execWs(VIEWER_A, WS_A), { publicToken: "pt" }),
    ).rejects.toBeInstanceOf(ConnexionNonAutoriseeError);
    expect(c.echangerPublicToken).not.toHaveBeenCalled();
  });

  it("désalignement institution → ConnexionDesalignmentError (rien persisté)", async () => {
    const c = clientFactice({
      exchange: { ConnectionId: "conn-x", InstitutionId: "mcb" },
      accounts: [{ AccountId: "oa-sbm", Status: "Enabled", Currency: "MUR", InstitutionId: "sbm" } as never],
    });
    await expect(
      finaliserConnexionDropin(c, execWs(ADMIN_A, WS_A), { publicToken: "pt" }),
    ).rejects.toBeInstanceOf(ConnexionDesalignmentError);
  });
});

describe("finaliserConnexionsDropin — payload multi-connexions du hook", () => {
  /**
   * Client dont l'exchange dépend du PublicToken : un token "ko-*" lève (échec
   * d'une connexion), les autres réussissent avec une connexion/compte distincts.
   * Permet de prouver le fail-soft (succès partiel) et le rejet si tout échoue.
   */
  function clientParToken(): OmniFiClient {
    return {
      echangerPublicToken: vi.fn(async (publicToken: string, clientUserId: string) => {
        if (publicToken.startsWith("ko")) throw new Error("exchange refusé");
        // Simule la frontière tenant Omni-FI (403 PUBLIC_TOKEN_CLIENT_MISMATCH) :
        // un publicToken préfixé "tenantB-" n'appartient qu'à enduser-b. Présenté
        // sous un autre clientUserId → l'exchange refuse.
        if (publicToken.startsWith("tenantB-") && clientUserId !== "enduser-b") {
          throw new Error("PUBLIC_TOKEN_CLIENT_MISMATCH");
        }
        return { ConnectionId: `conn-${publicToken}`, InstitutionId: "mcb", CustomerType: "business" };
      }),
      listerComptesConnexion: vi.fn(async (connectionId: string) => ({
        Data: {
          Account: [
            { AccountId: `oa-${connectionId}`, Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "100.00", Currency: "MUR" } }] },
          ],
        },
        Links: {},
        Meta: { TotalPages: 1 },
      })),
    } as unknown as OmniFiClient;
  }

  it("agrège plusieurs connexions du payload (toutes réussies)", async () => {
    const c = clientParToken();
    const r = await finaliserConnexionsDropin(c, execWs(ADMIN_A, WS_A), ["ok-1", "ok-2"]);
    expect(r.reussies).toHaveLength(2);
    expect(r.echecs).toBe(0);
    expect(r.comptesRattaches).toBe(2);
    expect(c.echangerPublicToken).toHaveBeenCalledTimes(2);
    // WIDGET-RD1 : `echecs === 0` est la SOURCE du drapeau `complet` exposé par
    // finaliserConnexionDropinAction (succès TOTAL → le Front redirige).
    expect(r.echecs === 0).toBe(true);
  });

  it("succès partiel (fail-soft) : une connexion échoue, l'autre est persistée", async () => {
    const c = clientParToken();
    const r = await finaliserConnexionsDropin(c, execWs(ADMIN_A, WS_A), ["ok-3", "ko-x"]);
    expect(r.reussies).toHaveLength(1);
    expect(r.echecs).toBe(1);
    expect(r.comptesRattaches).toBe(1);
    // WIDGET-RD1 : ≥ 1 échec → `complet` vaut false (succès PARTIEL → pas de
    // redirection auto, on ne masque pas l'échec).
    expect(r.echecs === 0).toBe(false);
  });

  it("toutes les connexions échouent → rejette (jamais de faux succès)", async () => {
    const c = clientParToken();
    await expect(
      finaliserConnexionsDropin(c, execWs(ADMIN_A, WS_A), ["ko-1", "ko-2"]),
    ).rejects.toBeTruthy();
  });

  it("VIEWER ne peut finaliser aucune connexion (rejet, aucun exchange)", async () => {
    const c = clientParToken();
    await expect(
      finaliserConnexionsDropin(c, execWs(VIEWER_A, WS_A), ["ok-1"]),
    ).rejects.toBeInstanceOf(ConnexionNonAutoriseeError);
    expect(c.echangerPublicToken).not.toHaveBeenCalled();
  });

  it("IDOR boucle : un publicToken d'un AUTRE tenant échoue (rien persisté pour lui)", async () => {
    // ADMIN_A finalise un lot où se glisse un token appartenant au tenant B.
    // La frontière (clientUserId = enduser-a, relu du workspace par itération)
    // fait refuser l'exchange du token de B → compté en échec, jamais rattaché à A.
    const c = clientParToken();
    const r = await finaliserConnexionsDropin(c, execWs(ADMIN_A, WS_A), [
      "ok-legit-A",
      "tenantB-vole",
    ]);
    expect(r.reussies).toHaveLength(1); // seul le token légitime de A passe
    expect(r.echecs).toBe(1); // le token de B est refusé (mismatch)
    // Le token de B n'a JAMAIS été échangé sous le clientUserId de B.
    expect(c.echangerPublicToken).toHaveBeenCalledWith("tenantB-vole", "enduser-a");
    const connexionsA = r.reussies.map((x) => x.connectionId);
    expect(connexionsA).not.toContain("conn-tenantB-vole");
  });

  it("doublon de publicToken : échangé UNE seule fois (pas de double-comptage)", async () => {
    const c = clientParToken();
    const r = await finaliserConnexionsDropin(c, execWs(ADMIN_A, WS_A), ["dup-1", "dup-1"]);
    expect(r.reussies).toHaveLength(1); // une seule banque, pas deux
    expect(r.comptesRattaches).toBe(1);
    expect(c.echangerPublicToken).toHaveBeenCalledTimes(1);
  });
});

describe("synchroniserConnexionsDepuisOmnifi — contournement GET /connections (postMessage cassé)", () => {
  it("liste les connexions par ClientUserId du workspace et persiste comptes (isolé de B)", async () => {
    await semerConnexionEnBase("conn-sync-A", "oa-sync-A1"); // périmètre LOT 1 : connue en base
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-sync-A", InstitutionId: "mcb", Status: "active" }],
      accounts: [
        { AccountId: "oa-sync-A1", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "3000.00", Currency: "MUR" } }] },
      ],
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    expect(r.connexions).toBe(1);
    expect(r.comptesRattaches).toBe(1);
    // Frontière tenant : on liste avec le ClientUserId du workspace A, jamais un param.
    expect(c.listerConnexions).toHaveBeenCalledWith("enduser-a", expect.anything());
    // Invisible de B (RLS).
    const vuB = await withWorkspace({ userId: ADMIN_B, activeWorkspaceId: WS_B }, async (tx) =>
      (await tx.select().from(bankConnections)).some((x) => x.omnifiConnectionId === "conn-sync-A"),
    );
    expect(vuB).toBe(false);
  });

  it("persiste InstitutionName depuis GET /connections (DASH-INST1)", async () => {
    // Régression : ce chemin (bouton « Synchroniser mes comptes ») jetait
    // InstitutionName — la connexion restait institution_name=NULL malgré la donnée
    // API. On vérifie qu'il est désormais capturé et persisté.
    // Périmètre LOT 1 : on sème la connexion (institution_name=NULL au semis, le drop-in
    // ne le porte pas) puis le sync doit la RAFRAÎCHIR avec le nom de GET /connections.
    await semerConnexionEnBase("conn-named", "oa-named");
    const c = clientFactice({
      connections: [
        {
          ConnectionId: "conn-named",
          InstitutionId: "absa",
          InstitutionName: "Absa Internet Banking",
          Status: "active",
        },
      ],
      accounts: [
        { AccountId: "oa-named", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "100.00", Currency: "MUR" } }] },
      ],
    });
    await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));

    const conn = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) =>
      (await tx.select().from(bankConnections)).find((x) => x.omnifiConnectionId === "conn-named"),
    );
    expect(conn?.institutionName).toBe("Absa Internet Banking");
  });

  it("idempotent : deux synchros n'accumulent pas (upserts)", async () => {
    await semerConnexionEnBase("conn-idem", "oa-idem"); // périmètre LOT 1 : connue en base
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-idem", InstitutionId: "mcb", Status: "active" }],
      accounts: [{ AccountId: "oa-idem", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "1000.00", Currency: "MUR" } }] }],
    });
    await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    const n = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) =>
      (await tx.select().from(bankConnections)).filter((x) => x.omnifiConnectionId === "conn-idem").length,
    );
    expect(n).toBe(1); // une seule ligne malgré deux synchros
  });

  it("ignore les connexions non actives", async () => {
    // Périmètre LOT 1 : seule l'active est semée en base (la revoked est de toute façon
    // exclue en amont par le filtre de Status — on ne sème donc QUE conn-active).
    await semerConnexionEnBase("conn-active", "oa-actif-only");
    const c = clientFactice({
      connections: [
        { ConnectionId: "conn-active", InstitutionId: "mcb", Status: "active" },
        { ConnectionId: "conn-revoked", InstitutionId: "mcb", Status: "revoked" },
      ],
      // AccountId unique à ce test : la contrainte UNIQUE globale omnifi_account_id
      // + RLS interdit d'écraser un compte déjà inséré par un autre test (dette 1.1).
      accounts: [{ AccountId: "oa-actif-only", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "1.00", Currency: "MUR" } }] }],
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    expect(r.connexions).toBe(1); // seule l'active est rattachée
  });

  it("VIEWER ne peut pas synchroniser (rejet, aucune liste)", async () => {
    const c = clientFactice();
    await expect(
      synchroniserConnexionsDepuisOmnifi(c, execWs(VIEWER_A, WS_A)),
    ).rejects.toBeInstanceOf(ConnexionNonAutoriseeError);
    expect(c.listerConnexions).not.toHaveBeenCalled();
  });

  it("importe AUSSI les transactions du compte (débloque Détails + Transactions récentes)", async () => {
    // La synchro ne doit pas seulement rattacher les comptes : elle ingère leurs
    // transactions (pipeline par page) — sinon le dashboard reste vide.
    await semerConnexionEnBase("conn-tx", "oa-tx"); // périmètre LOT 1 : connue en base
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-tx", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active" }],
      accounts: [{ AccountId: "oa-tx", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "9000.00", Currency: "MUR" } }] }],
      transactions: [
        {
          TransactionId: "tx-sync-1",
          AccountId: "oa-tx",
          TransactionInformation: "PAIEMENT CLIENT",
          Amount: { Amount: "1500.00", Currency: "MUR" },
          CreditDebitIndicator: "Credit",
          Status: "Booked",
          BookingDateTime: "2026-06-10T05:30:00Z",
        },
      ],
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    // ≥ 1 : la synchro ingère les transactions de TOUS les comptes sélectionnés du
    // workspace (l'état PGlite accumule les comptes des tests précédents) — la preuve
    // ciblée est la persistance de NOTRE transaction ci-dessous.
    expect(r.transactionsImportees).toBeGreaterThanOrEqual(1);
    expect(c.listerTransactionsPage).toHaveBeenCalled();

    // La transaction est bien persistée et visible sous le tenant A.
    const txns = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) =>
      (await tx.select().from(schema.transactionsCache)).filter((t) => t.omnifiTxnId === "tx-sync-1"),
    );
    expect(txns.length).toBe(1);
    expect(txns[0].creditDebit).toBe("Credit");
  });

  it("DÉCLENCHE un sync RÉEL (POST /sync) avant de lire, puis ingère (job COMPLETED)", async () => {
    // Cœur du chantier : le bouton ne se contente plus de relire le cache amont, il
    // POST /sync/{connectionId} puis attend le job avant la boucle de lecture existante.
    await semerConnexionEnBase("conn-trig", "oa-trig"); // périmètre LOT 1 : connue en base
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-trig", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active" }],
      accounts: [{ AccountId: "oa-trig", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "100.00", Currency: "MUR" } }] }],
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));

    // Le déclenchement a eu lieu pour cette connexion, AVANT la lecture des transactions.
    expect(c.declencherSync).toHaveBeenCalledWith("conn-trig", "enduser-a");
    expect(c.getSyncJobServeur).toHaveBeenCalled(); // attente du job
    expect(r.aReparer).toEqual([]);
    expect(r.rateLimited).toEqual([]);
  });

  it("re-sync repassé en OTP_REQUESTED → NEEDS_REPAIR (pas de lecture pour cette connexion)", async () => {
    // Le scraping redemande un OTP : on ne pilote pas la MFA serveur → on remonte le
    // signal de réparation (l'UI rouvrira le widget natif en REPAIR) et on STOPPE
    // cette connexion sans ingérer.
    await semerConnexionEnBase("conn-otp", "oa-otp"); // périmètre LOT 1 : connue en base
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-otp", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active" }],
      accounts: [{ AccountId: "oa-otp", Status: "Enabled", Currency: "MUR", PartyName: "Cpt" }],
      syncJob: { JobId: "job-sync-1", Status: "OTP_REQUESTED" },
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));

    // Le JobId remonté est celui du sync DÉCLENCHÉ (declencherSync → job-sync-1),
    // celui que l'UI passera au link-token de REPAIR.
    expect(r.aReparer).toEqual([{ connectionId: "conn-otp", jobId: "job-sync-1" }]);
    // Comptes rattachés (étape a), mais AUCUNE lecture de transactions pour conn-otp.
    expect(c.listerTransactionsPage).not.toHaveBeenCalled();
  });

  it("cooldown amont (NextSyncAvailableAt futur) → RATE_LIMITED, NE déclenche PAS mais relit l'état", async () => {
    // Garde anti-429 : si la connexion a un NextSyncAvailableAt dans le futur (vu dans
    // GET /connections), on ne re-déclenche pas — mais on relit quand même les comptes
    // et leurs transactions (le user voit le dernier état connu).
    const futur = new Date(Date.now() + 10 * 60_000).toISOString();
    await semerConnexionEnBase("conn-cd", "oa-cd"); // périmètre LOT 1 : connue en base
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-cd", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active", NextSyncAvailableAt: futur }],
      accounts: [{ AccountId: "oa-cd", Status: "Enabled", Currency: "MUR", PartyName: "Cpt" }],
      transactions: [
        {
          TransactionId: "tx-cd-1",
          AccountId: "oa-cd",
          TransactionInformation: "ACHAT",
          Amount: { Amount: "42.00", Currency: "MUR" },
          CreditDebitIndicator: "Debit",
          Status: "Booked",
          BookingDateTime: "2026-06-12T05:30:00Z",
        },
      ],
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));

    // Pas de déclenchement (cooldown), mais lecture effectuée.
    expect(c.declencherSync).not.toHaveBeenCalled();
    expect(r.rateLimited).toEqual([{ connectionId: "conn-cd", nextSyncAt: futur }]);
    expect(c.listerTransactionsPage).toHaveBeenCalled();
    const txns = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) =>
      (await tx.select().from(schema.transactionsCache)).filter((t) => t.omnifiTxnId === "tx-cd-1"),
    );
    expect(txns.length).toBe(1);
  });

  it("400 'sync already running' → poll le job EN COURS (latest-job non terminal), pas de re-trigger", async () => {
    // Un job tourne déjà côté Omni-FI : declencherSync renvoie 400 « already running ».
    // On récupère le JobId courant et on poll dessus (latest-job STARTED → puis le
    // polling le verra terminal), sans re-déclencher.
    await semerConnexionEnBase("conn-run", "oa-run"); // périmètre LOT 1 : connue en base
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-run", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active" }],
      accounts: [{ AccountId: "oa-run", Status: "Enabled", Currency: "MUR", PartyName: "Cpt" }],
      declencherSyncErreur: new OmniFiApiError(400, "400 sync already running", []),
      latestSyncJob: { JobId: "job-running", Status: "STARTED", NextSyncAvailableAt: null },
      // Le polling de job-running aboutit à COMPLETED.
      syncJob: { JobId: "job-running", Status: "COMPLETED", PersistenceStats: { TransactionsCreated: 0 } },
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));

    expect(c.getLatestSyncJob).toHaveBeenCalledWith("conn-run", "enduser-a");
    expect(c.getSyncJobServeur).toHaveBeenCalledWith("job-running", "enduser-a");
    // Aucun cas de réparation/rate-limit : le job en cours a abouti normalement.
    expect(r.aReparer).toEqual([]);
    expect(r.rateLimited).toEqual([]);
  });

  it("400 AMBIGU (autre cause, pas 'running') → FAIL-SOFT : compté en échec, PAS de throw, PAS de faux 'sync effectué'", async () => {
    // Régression visée par la revue : un 400 d'une autre cause ne doit pas partir
    // poller un vieux latest-job et conclure « sync effectué » (toujours vrai). MAIS,
    // depuis le correctif fail-soft, il ne fait PLUS `throw` non plus : il est capturé,
    // compté dans `echecs`, et la fonction atteint son `return`.
    await semerConnexionEnBase("conn-bad", "oa-bad"); // périmètre LOT 1 : connue en base
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-bad", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active" }],
      accounts: [{ AccountId: "oa-bad", Status: "Enabled", Currency: "MUR", PartyName: "Cpt" }],
      declencherSyncErreur: new OmniFiApiError(400, "BAD_REQUEST", []),
    });

    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    expect(r.echecs).toBe(1);
    expect(r.echecsDetail).toEqual([
      { connectionId: "conn-bad", code: "OMNIFI_API_ERROR", status: 400, obieCode: "BAD_REQUEST" },
    ]);
    // On n'a PAS été chercher le dernier job sur ce 400 ambigu (garde inchangée).
    expect(c.getLatestSyncJob).not.toHaveBeenCalled();
  });

  // LOT 1 — PÉRIMÈTRE : le sync ne rafraîchit QUE les connexions déjà en base (créées
  // via le widget). Une connexion vue par GET /connections mais ABSENTE de
  // bank_connections est IGNORÉE : ni upsert, ni appel Omni-FI pour elle. Pour ajouter
  // une banque → widget uniquement (DÉCISION PRODUIT actée).
  it("une connexion vue par GET /connections mais ABSENTE de bank_connections n'est PAS créée (ignorée)", async () => {
    // `listerConnexions` ne renvoie QU'UNE connexion JAMAIS semée en base : sur le code
    // d'avant le périmètre, le sync la crée (upsert) et déclenche un sync pour elle. Le
    // périmètre l'exclut AVANT la boucle → aucun appel Omni-FI pour elle, pas comptée.
    const c = clientFactice({
      connections: [
        { ConnectionId: "conn-fantome", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active" },
      ],
      accounts: [{ AccountId: "oa-fantome", Status: "Enabled", Currency: "MUR", PartyName: "Cpt" }],
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));

    // Connue côté Omni-FI mais absente de la base → ni traitée, ni comptée.
    expect(r.connexions).toBe(0);
    // Aucun appel Omni-FI émis pour elle : ni découverte de comptes, ni déclenchement.
    expect(c.listerComptesConnexion).not.toHaveBeenCalledWith(
      "conn-fantome",
      expect.anything(),
      expect.anything(),
    );
    expect(c.declencherSync).not.toHaveBeenCalled();
    // Et elle n'a PAS été créée en base (le sync ne crée jamais une connexion inconnue).
    const creee = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) =>
      (await tx.select().from(bankConnections)).some((x) => x.omnifiConnectionId === "conn-fantome"),
    );
    expect(creee).toBe(false);
  });
});

describe("demarrerReparation — LinkToken Mode REPAIR (SYNC-REPAIR-UI1)", () => {
  /** Crée une connexion RÉELLE dans WS_A et renvoie son omnifi_connection_id. */
  async function semerConnexionA(omnifiConnId: string, accountId: string) {
    const c = clientFactice({
      exchange: { ConnectionId: omnifiConnId, InstitutionId: "mcb" },
      accounts: [
        { AccountId: accountId, Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "100.00", Currency: "MUR" } }] },
      ],
    });
    await finaliserConnexionDropin(c, execWs(ADMIN_A, WS_A), { publicToken: `pt-${omnifiConnId}` });
  }

  it("ADMIN : transmet ConnectionId + JobId + ClientUserId du workspace à creerLinkToken", async () => {
    await semerConnexionA("conn-rep-A", "oa-rep-A");
    const c = clientFactice();
    const r = await demarrerReparation(c, execWs(ADMIN_A, WS_A), {
      redirectOrigin: "https://app.mu",
      connectionId: "conn-rep-A",
      jobId: "job-rep-A",
    });
    expect(r.linkToken).toBe("lt_x");
    // Mode REPAIR : le couple ConnectionId/JobId est passé, sous le ClientUserId du WS.
    expect(c.creerLinkToken).toHaveBeenCalledWith(
      expect.objectContaining({
        ClientUserId: "enduser-a",
        ConnectionId: "conn-rep-A",
        JobId: "job-rep-A",
        RedirectOrigin: "https://app.mu",
      }),
    );
  });

  it("VIEWER ne peut PAS démarrer une réparation (rejet, aucun link-token)", async () => {
    const c = clientFactice();
    await expect(
      demarrerReparation(c, execWs(VIEWER_A, WS_A), {
        redirectOrigin: "https://app.mu",
        connectionId: "conn-rep-A",
        jobId: "job-rep-A",
      }),
    ).rejects.toBeInstanceOf(ConnexionNonAutoriseeError);
    expect(c.creerLinkToken).not.toHaveBeenCalled();
  });

  it("anti-IDOR : un ConnectionId INCONNU du tenant → ReparationContexteInvalideError (aucun link-token)", async () => {
    const c = clientFactice();
    await expect(
      demarrerReparation(c, execWs(ADMIN_A, WS_A), {
        redirectOrigin: "https://app.mu",
        connectionId: "conn-inexistante",
        jobId: "job-x",
      }),
    ).rejects.toBeInstanceOf(ReparationContexteInvalideError);
    expect(c.creerLinkToken).not.toHaveBeenCalled();
  });

  it("anti-IDOR : la connexion d'un AUTRE tenant (B) est invisible de A → ReparationContexteInvalideError", async () => {
    // Sème une connexion sous B, puis tente une réparation sous A avec son id Omni-FI :
    // la RLS la rend invisible à A → refus (pas d'oracle d'existence cross-tenant).
    const cB = clientFactice({
      exchange: { ConnectionId: "conn-rep-B", InstitutionId: "mcb" },
      accounts: [{ AccountId: "oa-rep-B", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "1.00", Currency: "MUR" } }] }],
    });
    await finaliserConnexionDropin(cB, execWs(ADMIN_B, WS_B), { publicToken: "pt-conn-rep-B" });

    const c = clientFactice();
    await expect(
      demarrerReparation(c, execWs(ADMIN_A, WS_A), {
        redirectOrigin: "https://app.mu",
        connectionId: "conn-rep-B",
        jobId: "job-b",
      }),
    ).rejects.toBeInstanceOf(ReparationContexteInvalideError);
    expect(c.creerLinkToken).not.toHaveBeenCalled();
  });
});

describe("resynchroniserConnexion — re-lecture après réparation (SYNC-REPAIR-UI1)", () => {
  async function semerConnexionA(omnifiConnId: string, accountId: string) {
    const c = clientFactice({
      exchange: { ConnectionId: omnifiConnId, InstitutionId: "mcb" },
      accounts: [{ AccountId: accountId, Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "100.00", Currency: "MUR" } }] }],
    });
    await finaliserConnexionDropin(c, execWs(ADMIN_A, WS_A), { publicToken: `pt-${omnifiConnId}` });
  }

  it("re-lit la connexion : déclenche un sync, ingère les transactions du compte (job COMPLETED)", async () => {
    await semerConnexionA("conn-resync", "oa-resync");
    const c = clientFactice({
      accounts: [{ AccountId: "oa-resync", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "200.00", Currency: "MUR" } }] }],
      transactions: [
        {
          TransactionId: "tx-resync-1",
          AccountId: "oa-resync",
          TransactionInformation: "VIREMENT",
          Amount: { Amount: "300.00", Currency: "MUR" },
          CreditDebitIndicator: "Credit",
          Status: "Booked",
          BookingDateTime: "2026-06-11T05:30:00Z",
        },
      ],
    });
    const r = await resynchroniserConnexion(c, execWs(ADMIN_A, WS_A), "conn-resync");

    // Sync déclenché sous le ClientUserId du workspace (frontière tenant), pas un param.
    expect(c.declencherSync).toHaveBeenCalledWith("conn-resync", "enduser-a");
    expect(c.listerComptesConnexion).toHaveBeenCalledWith("conn-resync", "enduser-a", expect.anything());
    expect(r.transactionsImportees).toBeGreaterThanOrEqual(1);
    expect(r.reparationJobId).toBeUndefined();

    const txns = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) =>
      (await tx.select().from(schema.transactionsCache)).filter((t) => t.omnifiTxnId === "tx-resync-1"),
    );
    expect(txns.length).toBe(1);
  });

  it("re-sync repassé en OTP → reparationJobId (NOUVEAU jobId), aucune lecture de transactions", async () => {
    await semerConnexionA("conn-resync-otp", "oa-resync-otp");
    const c = clientFactice({
      accounts: [{ AccountId: "oa-resync-otp", Status: "Enabled", Currency: "MUR", PartyName: "Cpt" }],
      syncJob: { JobId: "job-sync-1", Status: "OTP_REQUESTED" },
    });
    const r = await resynchroniserConnexion(c, execWs(ADMIN_A, WS_A), "conn-resync-otp");
    expect(r.reparationJobId).toBe("job-sync-1");
    expect(c.listerTransactionsPage).not.toHaveBeenCalled();
  });

  it("sync FAILED → fail-soft : pas de throw, 0 transaction (pas de reparationJobId)", async () => {
    await semerConnexionA("conn-resync-fail", "oa-resync-fail");
    const c = clientFactice({
      accounts: [{ AccountId: "oa-resync-fail", Status: "Enabled", Currency: "MUR", PartyName: "Cpt" }],
      syncJob: { JobId: "job-sync-1", Status: "FAILED", Error: { Type: "LOGIN_FAILED" } },
    });
    const r = await resynchroniserConnexion(c, execWs(ADMIN_A, WS_A), "conn-resync-fail");
    expect(r.transactionsImportees).toBe(0);
    expect(r.reparationJobId).toBeUndefined();
    expect(c.listerTransactionsPage).not.toHaveBeenCalled();
  });

  it("VIEWER ne peut pas re-synchroniser (rejet, aucune découverte)", async () => {
    const c = clientFactice();
    await expect(
      resynchroniserConnexion(c, execWs(VIEWER_A, WS_A), "conn-resync"),
    ).rejects.toBeInstanceOf(ConnexionNonAutoriseeError);
    expect(c.listerComptesConnexion).not.toHaveBeenCalled();
  });

  it("anti-IDOR : connexion inconnue du tenant → ReparationContexteInvalideError (aucun appel amont)", async () => {
    const c = clientFactice();
    await expect(
      resynchroniserConnexion(c, execWs(ADMIN_A, WS_A), "conn-pas-a-moi"),
    ).rejects.toBeInstanceOf(ReparationContexteInvalideError);
    expect(c.listerComptesConnexion).not.toHaveBeenCalled();
  });
});

describe("synchroniserConnexionsDepuisOmnifi — FAIL-SOFT par connexion + agrégat honnête", () => {
  /**
   * Client dont UNE connexion (`koConnId`) échoue « dur » au 1er appel
   * (`listerComptesConnexion` rejette), les autres réussissent (job COMPLETED).
   * Sert à prouver qu'un échec au milieu de N connexions ne fait PAS tout tomber.
   */
  function clientSyncAvecUnEchec(
    connIds: string[],
    koConnId: string,
    erreurKo: unknown,
  ): OmniFiClient {
    return {
      listerConnexions: vi.fn().mockResolvedValue({
        Data: {
          Connections: connIds.map((id) => ({
            ConnectionId: id,
            InstitutionId: "mcb",
            InstitutionName: "MCB",
            Status: "active",
          })),
        },
        Links: {},
        Meta: { TotalPages: 1 },
      }),
      listerComptesConnexion: vi.fn(async (connectionId: string) => {
        if (connectionId === koConnId) throw erreurKo;
        return {
          Data: {
            Account: [
              { AccountId: `oa-${connectionId}`, Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "10.00", Currency: "MUR" } }] },
            ],
          },
          Links: {},
          Meta: { TotalPages: 1 },
        };
      }),
      declencherSync: vi.fn().mockResolvedValue({ JobId: "job-x", Status: "PENDING", IsManual: true }),
      getSyncJobServeur: vi.fn().mockResolvedValue({
        JobId: "job-x",
        Status: "COMPLETED",
        PersistenceStats: { TransactionsCreated: 0 },
      }),
      getLatestSyncJob: vi.fn().mockResolvedValue({ JobId: "job-x", Status: "COMPLETED", NextSyncAvailableAt: null }),
      listerTransactionsPage: vi.fn().mockResolvedValue({
        Data: { Transaction: [] },
        Links: { Next: null },
        Meta: { TotalPages: 1 },
      }),
    } as unknown as OmniFiClient;
  }

  it("1 connexion qui THROW au milieu de 3 → echecs=1, les 2 autres rattachées, return ATTEINT (pas de throw)", async () => {
    const ids = ["fs-A", "fs-KO", "fs-C"];
    // Périmètre LOT 1 : les 3 connexions doivent être en base pour entrer dans la boucle
    // (sinon la KO serait filtrée AVANT listerComptesConnexion et ne lèverait jamais).
    for (const id of ids) await semerConnexionEnBase(id, `oa-${id}`);
    const c = clientSyncAvecUnEchec(ids, "fs-KO", new OmniFiApiError(500, "INTERNAL", []));

    // Ne throw PAS (le cœur du correctif) : on obtient bien un résultat.
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));

    expect(r.connexions).toBe(3);
    expect(r.echecs).toBe(1);
    expect(r.echecsDetail).toEqual([
      { connectionId: "fs-KO", code: "OMNIFI_API_ERROR", status: 500, obieCode: "INTERNAL" },
    ]);
    // Les 2 connexions saines ont bien été rattachées (la KO échoue AVANT persistance).
    expect(r.comptesRattaches).toBe(2);
    // La connexion KO a bien été tentée (preuve qu'on n'a pas court-circuité la boucle).
    expect(c.listerComptesConnexion).toHaveBeenCalledWith("fs-KO", "enduser-a", expect.anything());
    // Les comptes des 2 connexions saines existent sous le tenant A.
    const accs = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) =>
      (await tx.select().from(bankAccounts)).filter((a) => ["oa-fs-A", "oa-fs-C"].includes(a.omnifiAccountId)),
    );
    expect(accs.length).toBe(2);
  });

  it("403 désalignement EndUser (PUBLIC_TOKEN_CLIENT_MISMATCH) sur 1 connexion → bucket aReconnecter, PAS echecs, les autres continuent", async () => {
    // Incident prod : un 403 (EndUser/credential désaligné) était avalé en échec
    // silencieux → comptes vides + last_synced_at frais. On PROUVE qu'il atterrit
    // désormais dans `aReconnecter` (état actionnable dédié), qu'il n'est PAS compté
    // en `echecs`/`echecsDetail`, et qu'il n'interrompt PAS les autres connexions.
    const ids = ["rc-A", "rc-403", "rc-C"];
    for (const id of ids) await semerConnexionEnBase(id, `oa-${id}`); // périmètre LOT 1
    const c = clientSyncAvecUnEchec(
      ids,
      "rc-403",
      new OmniFiApiError(403, "PUBLIC_TOKEN_CLIENT_MISMATCH", []),
    );

    // (a) NE throw PAS : les autres connexions ne sont pas abandonnées.
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));

    expect(r.connexions).toBe(3);
    // (b) Le 403 va dans le bucket DÉDIÉ, avec code/status/obieCode sûrs — jamais en générique.
    expect(r.aReconnecter).toEqual([
      {
        connectionId: "rc-403",
        code: "OMNIFI_API_ERROR",
        status: 403,
        obieCode: "PUBLIC_TOKEN_CLIENT_MISMATCH",
      },
    ]);
    // Il n'est PAS compté comme un échec générique (le cœur du correctif).
    expect(r.echecs).toBe(0);
    expect(r.echecsDetail).toEqual([]);
    // Les 2 connexions saines ont bien été rattachées (le 403 échoue AVANT persistance).
    expect(r.comptesRattaches).toBe(2);
    // La connexion 403 a bien été tentée (preuve qu'on n'a pas court-circuité la boucle).
    expect(c.listerComptesConnexion).toHaveBeenCalledWith("rc-403", "enduser-a", expect.anything());
    const accs = await withWorkspace({ userId: ADMIN_A, activeWorkspaceId: WS_A }, async (tx) =>
      (await tx.select().from(bankAccounts)).filter((a) => ["oa-rc-A", "oa-rc-C"].includes(a.omnifiAccountId)),
    );
    expect(accs.length).toBe(2);
  });

  it("403 SANS obieCode → toujours routé en aReconnecter (le status 403 est le discriminant)", async () => {
    // L'enveloppe OBIE peut ne pas porter d'obieCode : le status 403 seul suffit à
    // classer la connexion en « à reconnecter » (jamais en échec générique silencieux).
    await semerConnexionEnBase("rc-noc", "oa-rc-noc");
    const c = clientSyncAvecUnEchec(["rc-noc"], "rc-noc", new OmniFiApiError(403, null, []));
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    expect(r.aReconnecter).toEqual([
      { connectionId: "rc-noc", code: "OMNIFI_API_ERROR", status: 403, obieCode: null },
    ]);
    expect(r.echecs).toBe(0);
    expect(r.echecsDetail).toEqual([]);
  });

  it("une erreur NON-OmniFiApiError (ex. panne DB) est aussi fail-soft (code machine, sans status)", async () => {
    const ids = ["fs2-OK", "fs2-KO"];
    for (const id of ids) await semerConnexionEnBase(id, `oa-${id}`); // périmètre LOT 1
    const c = clientSyncAvecUnEchec(ids, "fs2-KO", new Error("boom DB"));
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    expect(r.echecs).toBe(1);
    // Pas une OmniFiApiError → pas de status/obieCode, juste le code machine (name).
    expect(r.echecsDetail[0]).toEqual({ connectionId: "fs2-KO", code: "Error" });
    expect(r.comptesRattaches).toBe(1); // la connexion saine est passée
  });

  it("TOUTES les connexions échouent → echecs===connexions, comptesRattaches=0 (agrégat « tout échoué » côté action)", async () => {
    // 1 seule connexion, qui échoue : echecs===connexions ET 0 compte → l'action
    // remontera MESSAGE_SYNC_TOUT_ECHOUE (testé via le contrat du résultat ici).
    await semerConnexionEnBase("fs3-KO", "oa-fs3-KO"); // périmètre LOT 1 : connue en base
    const c = clientSyncAvecUnEchec(["fs3-KO"], "fs3-KO", new OmniFiApiError(503, "UNAVAILABLE", []));
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    expect(r.connexions).toBe(1);
    expect(r.echecs).toBe(1);
    expect(r.comptesRattaches).toBe(0);
  });

  it("SÉCURITÉ : une garde tenant (WorkspaceAccessDeniedError) n'est PAS avalée → propage (pas un échec fail-soft)", async () => {
    // Cross-review : le fail-soft ne doit JAMAIS transformer un signal fail-closed de
    // tenancy en simple « echec de connexion ». Si withWorkspace lève (rôle DB non sûr,
    // membership révoquée…), l'opération entière doit s'interrompre bruyamment.
    // Périmètre LOT 1 : sec-KO doit être en base pour entrer dans la boucle et atteindre
    // l'appel qui lève la garde tenant (sinon filtrée AVANT → l'erreur ne surviendrait pas).
    await semerConnexionEnBase("sec-KO", "oa-sec-KO");
    const c = clientSyncAvecUnEchec(["sec-KO"], "sec-KO", new WorkspaceAccessDeniedError());
    await expect(
      synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A)),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
  });

  it("aucun échec → echecs=0, echecsDetail vide (contrat inchangé pour le cas nominal)", async () => {
    const c = clientFactice({
      connections: [{ ConnectionId: "fs4-ok", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active" }],
      accounts: [{ AccountId: "oa-fs4-ok", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "5.00", Currency: "MUR" } }] }],
    });
    const r = await synchroniserConnexionsDepuisOmnifi(c, execWs(ADMIN_A, WS_A));
    expect(r.echecs).toBe(0);
    expect(r.echecsDetail).toEqual([]);
  });
});

// ── Garde-fou L7a : la suite tourne-t-elle vraiment sous tygr_app ? ───────────
// Sans cette précondition, un `set role tygr_app` régressé ferait tourner la suite
// sous l'owner (RLS ignorée) en passant au vert silencieusement (faux-vert). Le test
// pose lui-même le rôle (auto-suffisant, indépendant de l'ordre des autres cas).
describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app, pas sous l'owner (sinon la RLS est ignorée)", async () => {
    await client.exec(`set role tygr_app;`);
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

// Contre-preuve R1 : prouve POURQUOI le rôle non-owner est vital. Sous l'owner la
// frontière tenant ne filtre pas ; sous tygr_app elle filtre. Si l'app pointait sur
// l'owner (RLS contournée), R1a casserait — l'angle mort devient bloquant.
describe("contre-preuve R1 : la RLS NE protège PAS sous le propriétaire", () => {
  afterAll(async () => {
    // Restaure l'invariant pour toute exécution ultérieure : rôle applicatif.
    await client.exec(`set role tygr_app;`);
  });

  it("R1a. sous l'owner, un SELECT sans contexte voit l'AUTRE tenant (RLS ignorée)", async () => {
    await client.exec(`reset role;`);
    const res = await client.query<{ workspace_id: string }>(
      "select workspace_id from workspace_members",
    );
    expect(res.rows.some((r) => r.workspace_id === WS_B)).toBe(true);
  });

  it("R1b. sous tygr_app, le contexte A ne voit JAMAIS le tenant B (la RLS filtre)", async () => {
    await client.exec(`set role tygr_app;`);
    const vus = await withWorkspace(
      { userId: ADMIN_A, activeWorkspaceId: WS_A },
      (tx) => tx.select().from(schema.workspaceMembers),
    );
    expect(vus.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(vus.some((r) => r.workspaceId === WS_B)).toBe(false);
  });
});
