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
import { createWithWorkspace, type ExecuterWorkspace } from "@/server/db/tenancy";
import type { OmniFiClient } from "@/server/omnifi";
import {
  ConnexionDesalignmentError,
  ConnexionNonAutoriseeError,
  demarrerConnexion,
  finaliserConnexion,
  finaliserConnexionDropin,
  finaliserConnexionsDropin,
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
  connections?: Array<{ ConnectionId: string; InstitutionId: string; InstitutionName?: string; Status: string }>;
  transactions?: Array<Record<string, unknown>>;
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
  } as unknown as OmniFiClient;
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
    const c = clientFactice({
      connections: [{ ConnectionId: "conn-tx", InstitutionId: "mcb", InstitutionName: "MCB", Status: "active" }],
      accounts: [{ AccountId: "oa-tx", Status: "Enabled", Currency: "MUR", PartyName: "Cpt", Balances: [{ Type: "ITAV", Amount: { Amount: "9000.00", Currency: "MUR" } }] }],
      transactions: [
        {
          TransactionId: "tx-sync-1",
          AccountId: "oa-tx",
          Description: "PAIEMENT CLIENT",
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
});
