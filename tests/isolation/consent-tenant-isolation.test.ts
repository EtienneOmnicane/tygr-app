/**
 * Suite d'isolation — ÉMISSION des consentements (Epic 1 / L3.2,
 * PLAN-epic1-auth-consent.md §5.2). Complète `audit-append-only-isolation.test.ts`
 * (L3.1), qui prouve l'append-only des tables ; ici on prouve que le REPOSITORY qui
 * les alimente respecte ses invariants.
 *
 * Ce qui est prouvé (chaque cas correspond à un critère de sortie du plan) :
 *   IDOR   — une connexion d'un AUTRE tenant est invisible → refus non-énumérant,
 *            et RIEN n'est écrit. Un compte d'une autre connexion est rejeté AVANT
 *            tout appel réseau.
 *   PII    — un scope hors liste blanche lève AUDIT_PAYLOAD_INVALID ; le scope écrit
 *            ne porte QUE des identifiants opaques et des masques `••••XXXX`.
 *   SNAP   — acteur non résolvable → AUDIT_SNAPSHOT_INCOMPLET, fail-closed (on
 *            n'écrit PAS un consentement anonyme).
 *   ORDRE  — l'appel Omni-FI précède l'écriture : si l'appel échoue, rien n'est écrit.
 *   PORTÉE — le re-sync (qui partage `persisterConnexionEtComptes`) n'émet AUCUN
 *            consentement. Sans cette garde, chaque synchro écrirait un faux GRANTED
 *            dans une table append-only, irrattrapable.
 *
 * Comme les autres suites d'isolation : migrations réelles, provisioning réel,
 * requêtes sous `tygr_app` (rôle NON-propriétaire) — sans quoi la RLS serait ignorée
 * et les tests prouveraient du vide.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  AuditPayloadInvalideError,
  AuditSnapshotIncompletError,
  consigner,
  enregistrerConsentement,
} from "@/server/repositories/audit";
import {
  ConnexionNonAutoriseeError,
  ConsentAccountUnknownError,
  persisterConnexionEtComptes,
  selectionnerComptes,
} from "@/server/widget/orchestration";
import type { OmniFiAccount } from "@/server/omnifi";
import { OmniFiApiError } from "@/server/omnifi";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ALICE = "11111111-1111-4111-8111-111111111111"; // MANAGER de A
const BOB = "22222222-2222-4222-8222-222222222222"; // MANAGER de B
/** Membre de A dont l'email est vide → le snapshot d'identité ne peut se résoudre. */
const FANTOME = "33333333-3333-4333-8333-333333333333";

const CONN_A = "f1111111-1111-4111-8111-111111111111";
const CONN_B = "f2222222-2222-4222-8222-222222222222";

const CPT_A1 = "c1111111-1111-4111-8111-111111111111";
const CPT_A2 = "c2222222-2222-4222-8222-222222222222";
/** Compte de A, mais rattaché à une AUTRE connexion (piège de sélection). */
const CPT_A_AUTRE_CONN = "c4444444-4444-4444-8444-444444444444";
const CONN_A_BIS = "f4444444-4444-4444-8444-444444444444";
/** Compte du tenant B — cible IDOR. */
const CPT_B1 = "c3333333-3333-4333-8333-333333333333";

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };
const sessionFantome = { userId: FANTOME, activeWorkspaceId: WS_A };

const executerA = <T,>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
  withWorkspace(sessionA, fn);
const executerB = <T,>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
  withWorkspace(sessionB, fn);
const executerFantome = <T,>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
  withWorkspace(sessionFantome, fn);

/**
 * Faux client Omni-FI : `selectionnerComptes` n'utilise QUE cette méthode. On
 * enregistre les appels pour prouver l'ORDRE (réseau avant écriture) et on peut la
 * faire échouer pour prouver qu'aucune ligne n'est écrite quand l'amont refuse.
 */
function fauxClient(comportement?: () => Promise<void>) {
  const appels: { connectionId: string; ids: string[] }[] = [];
  const c = {
    definirComptesAutorises: async (connectionId: string, ids: string[]) => {
      appels.push({ connectionId, ids });
      if (comportement) await comportement();
    },
  };
  // `selectionnerComptes` ne consomme que `definirComptesAutorises` — le cast borne
  // le faux à cette surface (aucun réseau n'est atteignable depuis ce test).
  return { client: c as unknown as Parameters<typeof selectionnerComptes>[0], appels };
}

/**
 * Dernière ligne écrite, lue SOUS RLS par Alice. Le journal étant append-only et
 * jamais purgé (cf. `deltaAudit`), « la dernière » est sans ambiguïté celle que le
 * test vient de produire.
 */
async function dernierConsentement() {
  const lignes = await executerA(async (tx) =>
    tx
      .select()
      .from(schema.consentRecords)
      .orderBy(desc(schema.consentRecords.createdAt))
      .limit(1),
  );
  return lignes[0];
}

async function dernierEvenement() {
  const lignes = await executerA(async (tx) =>
    tx
      .select()
      .from(schema.auditEvents)
      .orderBy(desc(schema.auditEvents.createdAt))
      .limit(1),
  );
  return lignes[0];
}

function compteOmnifi(accountId: string): OmniFiAccount {
  return {
    AccountId: accountId,
    Status: "Enabled",
    Currency: "MUR",
    Balances: [{ Type: "ITAV", Amount: { Amount: "1000.00", Currency: "MUR" } }],
  } as OmniFiAccount;
}

/** Compte les lignes d'audit sous l'owner (bypass RLS : on veut la vérité brute). */
async function compterSousOwner(table: string, workspaceId?: string): Promise<number> {
  await client.exec(`reset role;`);
  try {
    const where = workspaceId ? `where workspace_id = '${workspaceId}'` : "";
    const res = await client.query<{ n: number }>(
      `select count(*)::int as n from ${table} ${where}`,
    );
    return res.rows[0].n;
  } finally {
    await client.exec(`set role tygr_app;`);
  }
}

/**
 * ⚠️ Ces deux tables sont APPEND-ONLY STRICTES : ni DELETE, ni TRUNCATE, même sous
 * l'owner (migration 0021, gardes 3a/3b). Un `beforeEach` qui les viderait échoue —
 * et c'est le comportement VOULU, pas un obstacle à contourner. On raisonne donc en
 * DELTA autour de chaque test plutôt qu'en valeur absolue après nettoyage.
 *
 * Effet de bord bénéfique : le harnais lui-même prouve, à chaque exécution, qu'aucun
 * chemin de test ne peut effacer l'audit.
 */
async function deltaAudit<T>(
  fn: () => Promise<T>,
): Promise<{ resultat: T | undefined; erreur: unknown; consents: number; events: number }> {
  const consentsAvant = await compterSousOwner("consent_records");
  const eventsAvant = await compterSousOwner("audit_events");

  let resultat: T | undefined;
  let erreur: unknown;
  try {
    resultat = await fn();
  } catch (e) {
    erreur = e;
  }

  return {
    resultat,
    erreur,
    consents: (await compterSousOwner("consent_records")) - consentsAvant,
    events: (await compterSousOwner("audit_events")) - eventsAvant,
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
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}', 'Omnicane Groupe', 'CONSOLIDATION',   'enduser-a'),
      ('${WS_B}', 'Tenant Étranger', 'EXTERNAL_CLIENT', 'enduser-b');

    -- FANTOME a une ligne users (la FK workspace_members -> users l'impose) mais un
    -- email VIDE : un NOT NULL n'interdit pas la chaine vide. Le snapshot ne peut
    -- alors designer personne -> fail-closed attendu (cas SNAP). C'est aussi l'etat
    -- que produirait une anonymisation RGPD qui viderait le champ sans le purger.
    insert into users (id, email, full_name) values
      ('${ALICE}',   'alice@omnicane.mu', 'Alice Dupont'),
      ('${BOB}',     'bob@etranger.mu',   'Bob'),
      ('${FANTOME}', '',                  'Sans identité');

    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}',   '${WS_A}', 'MANAGER'),
      ('${FANTOME}', '${WS_A}', 'MANAGER'),
      ('${BOB}',     '${WS_B}', 'MANAGER');

    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, institution_name, status, created_by) values
      ('${CONN_A}',     '${WS_A}', 'omnifi-conn-a',     'absa', 'Absa Internet Banking', 'active', '${ALICE}'),
      ('${CONN_A_BIS}', '${WS_A}', 'omnifi-conn-a-bis', 'mcb',  'MCB Group',             'active', '${ALICE}'),
      ('${CONN_B}',     '${WS_B}', 'omnifi-conn-b',     'mcb',  'MCB Group',             'active', '${BOB}');

    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency) values
      ('${CPT_A1}',           '${WS_A}', '${CONN_A}',     'omnifi-acct-a1',    'Courant MUR', 'MUR'),
      ('${CPT_A2}',           '${WS_A}', '${CONN_A}',     'omnifi-acct-a2',    'Épargne MUR', 'MUR'),
      ('${CPT_A_AUTRE_CONN}', '${WS_A}', '${CONN_A_BIS}', 'omnifi-acct-abis',  'Autre conn',  'MUR'),
      ('${CPT_B1}',           '${WS_B}', '${CONN_B}',     'omnifi-acct-b1',    'Compte de B', 'MUR');
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

describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app (sinon la RLS est ignorée)", async () => {
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
  });

  it("0bis. le journal ne peut PAS être vidé, même sous l'owner (garde 0021)", async () => {
    // Confirme que le choix du harnais (delta, jamais de nettoyage) est CONTRAINT
    // par l'append-only, et pas un artefact de style.
    await client.exec(`reset role;`);
    try {
      // TRUNCATE est un trigger FOR EACH STATEMENT : il mord même sur table vide.
      await expect(client.exec(`truncate audit_events`)).rejects.toThrow(
        /append_only_no_truncate/i,
      );

      // DELETE est FOR EACH ROW : sur une table VIDE il n'a aucune ligne à visiter
      // et « réussit » sans rien faire (0 ligne). Ce n'est pas une faille — mais
      // pour prouver la garde il faut une ligne réelle à supprimer.
      await client.exec(`
        insert into audit_events (workspace_id, event_type, payload)
        values ('${WS_A}', 'consent.granted', '{}');
      `);
      await expect(client.exec(`delete from audit_events`)).rejects.toThrow(
        /append_only_no_mutation/i,
      );
    } finally {
      await client.exec(`set role tygr_app;`);
    }
  });
});

describe("ACCOUNTS_SELECTED — anti-IDOR (exit-criterion règle 3)", () => {
  it("1. connexion d'un AUTRE tenant → refus non-énumérant, aucune écriture", async () => {
    const { client: omnifi, appels } = fauxClient();

    // Alice (tenant A) cible la connexion de B.
    const d = await deltaAudit(() =>
      selectionnerComptes(omnifi, executerA, {
        connectionId: CONN_B,
        bankAccountIds: [CPT_B1],
      }),
    );

    expect(d.erreur).toBeInstanceOf(ConnexionNonAutoriseeError);
    // Le refus tombe AVANT le réseau, et rien n'est consigné.
    expect(appels).toHaveLength(0);
    expect(d.consents).toBe(0);
    expect(d.events).toBe(0);
  });

  it("2. compte d'un AUTRE tenant sur sa propre connexion → refus, aucune écriture", async () => {
    const { client: omnifi, appels } = fauxClient();

    const d = await deltaAudit(() =>
      selectionnerComptes(omnifi, executerA, {
        connectionId: CONN_A,
        bankAccountIds: [CPT_A1, CPT_B1], // CPT_B1 invisible sous RLS
      }),
    );

    expect(d.erreur).toBeInstanceOf(ConsentAccountUnknownError);
    expect(appels).toHaveLength(0);
    expect(d.consents).toBe(0);
  });

  it("3. compte du BON tenant mais d'une AUTRE connexion → refus (sélection non partielle)", async () => {
    const { client: omnifi, appels } = fauxClient();

    const d = await deltaAudit(() =>
      selectionnerComptes(omnifi, executerA, {
        connectionId: CONN_A,
        bankAccountIds: [CPT_A1, CPT_A_AUTRE_CONN],
      }),
    );

    // Une sélection partiellement honorée serait un consentement non donné.
    expect(d.erreur).toBeInstanceOf(ConsentAccountUnknownError);
    expect(appels).toHaveLength(0);
    expect(d.consents).toBe(0);
  });

  it("4. le tenant B ne voit AUCUN consentement écrit par A (RLS)", async () => {
    const { client: omnifi } = fauxClient();
    const d = await deltaAudit(() =>
      selectionnerComptes(omnifi, executerA, {
        connectionId: CONN_A,
        bankAccountIds: [CPT_A1],
      }),
    );
    expect(d.consents).toBe(1); // la ligne existe bien (vue sous l'owner)

    const vusParB = await executerB(async (tx) =>
      tx.select().from(schema.consentRecords),
    );
    expect(vusParB).toHaveLength(0);
  });
});

describe("ACCOUNTS_SELECTED — ordre Omni-FI → audit (plan §2.3)", () => {
  it("5. l'appel amont précède l'écriture, avec les identifiants OMNI-FI", async () => {
    const { client: omnifi, appels } = fauxClient();

    const d = await deltaAudit(() =>
      selectionnerComptes(omnifi, executerA, {
        connectionId: CONN_A,
        bankAccountIds: [CPT_A1, CPT_A2],
      }),
    );

    expect(d.erreur).toBeUndefined();
    expect(d.resultat?.comptesAutorises).toBe(2);
    expect(appels).toHaveLength(1);
    // Le PUT reçoit l'omnifi_connection_id et les omnifi_account_id, JAMAIS nos UUID.
    expect(appels[0].connectionId).toBe("omnifi-conn-a");
    expect(appels[0].ids.sort()).toEqual(["omnifi-acct-a1", "omnifi-acct-a2"]);
    expect(d.consents).toBe(1);
    expect(d.events).toBe(1);
  });

  it("6. si Omni-FI échoue, RIEN n'est écrit (pas de consentement fantôme)", async () => {
    const { client: omnifi, appels } = fauxClient(async () => {
      throw new OmniFiApiError(500, null, []);
    });

    const d = await deltaAudit(() =>
      selectionnerComptes(omnifi, executerA, {
        connectionId: CONN_A,
        bankAccountIds: [CPT_A1],
      }),
    );

    expect(d.erreur).toBeInstanceOf(OmniFiApiError);
    expect(appels).toHaveLength(1); // l'appel a bien eu lieu…
    expect(d.consents).toBe(0); // …et rien n'est écrit
    expect(d.events).toBe(0);
  });

  it("7. 409 ACCOUNT_NOT_FOUND amont → CONSENT_ACCOUNT_UNKNOWN, aucune écriture", async () => {
    const { client: omnifi } = fauxClient(async () => {
      throw new OmniFiApiError(409, "ACCOUNT_NOT_FOUND", []);
    });

    const d = await deltaAudit(() =>
      selectionnerComptes(omnifi, executerA, {
        connectionId: CONN_A,
        bankAccountIds: [CPT_A1],
      }),
    );

    expect(d.erreur).toBeInstanceOf(ConsentAccountUnknownError);
    expect(d.consents).toBe(0);
  });
});

describe("ACCOUNTS_SELECTED — discipline PII du scope (règle 8)", () => {
  it("8. le scope ne porte que des identifiants opaques et des masques ••••XXXX", async () => {
    const { client: omnifi } = fauxClient();
    await selectionnerComptes(omnifi, executerA, {
      connectionId: CONN_A,
      bankAccountIds: [CPT_A1],
    });

    const ligne = await dernierConsentement();
    const scope = ligne.scope as {
      accountIds: string[];
      accountsLabels: { accountId: string; masked: string }[];
    };

    expect(scope.accountIds).toEqual(["omnifi-acct-a1"]);
    // 4 derniers caractères de « omnifi-acct-a1 », rien de plus.
    expect(scope.accountsLabels[0].masked).toBe("••••t-a1");
    // Le libellé bancaire (`account_name`) ne fuit NULLE PART dans la ligne.
    expect(JSON.stringify(ligne.scope)).not.toContain("Courant MUR");
  });

  it("9. le snapshot d'identité et d'institution est copié dans la ligne", async () => {
    const { client: omnifi } = fauxClient();
    await selectionnerComptes(omnifi, executerA, {
      connectionId: CONN_A,
      bankAccountIds: [CPT_A1],
    });

    const ligne = await dernierConsentement();
    expect(ligne.grantedByEmail).toBe("alice@omnicane.mu");
    expect(ligne.grantedByName).toBe("Alice Dupont");
    expect(ligne.institutionName).toBe("Absa Internet Banking");
    expect(ligne.action).toBe("ACCOUNTS_SELECTED");
  });

  it("10. l'événement d'audit corrélé est applicatif (omnifi_event_id NULL)", async () => {
    const { client: omnifi } = fauxClient();
    await selectionnerComptes(omnifi, executerA, {
      connectionId: CONN_A,
      bankAccountIds: [CPT_A1],
    });

    const evt = await dernierEvenement();
    expect(evt.eventType).toBe("consent.accounts_selected");
    expect(evt.omnifiEventId).toBeNull();
    expect(evt.actorUserId).toBe(ALICE);
    expect(evt.connectionId).toBe(CONN_A);
  });
});

describe("repository — liste blanche de payload (AUDIT_PAYLOAD_INVALID)", () => {
  it("11. une clé hors liste blanche est refusée, rien n'est écrit", async () => {
    const d = await deltaAudit(() =>
      executerA(async (tx, ctx) =>
        enregistrerConsentement(tx, ctx, {
          connectionId: CONN_A,
          action: "GRANTED",
          // `iban` n'est déclaré dans AUCUN schéma : c'est précisément le vecteur
          // d'exfiltration que la liste blanche existe pour fermer.
          scope: { institutionId: "absa", iban: "MU17BOMM0101234567890123456789" },
        }),
      ),
    );

    expect(d.erreur).toBeInstanceOf(AuditPayloadInvalideError);
    expect(d.consents).toBe(0);
    expect(d.events).toBe(0);
  });

  it("12. le message d'erreur cite la CLÉ refusée, jamais sa VALEUR (l'IBAN)", async () => {
    let capturee: unknown;
    try {
      await executerA(async (tx, ctx) =>
        consigner(tx, ctx, {
          eventType: "consent.granted",
          payload: { iban: "MU17BOMM0101234567890123456789" },
        }),
      );
    } catch (e) {
      capturee = e;
    }
    expect(capturee).toBeInstanceOf(AuditPayloadInvalideError);
    const message = (capturee as Error).message;
    expect(message).toContain("iban");
    expect(message).not.toContain("MU17BOMM"); // la valeur ne fuit pas dans le log
  });

  it("13. un accountIds vide est refusé (une sélection vide n'est pas un consentement)", async () => {
    const d = await deltaAudit(() =>
      executerA(async (tx, ctx) =>
        enregistrerConsentement(tx, ctx, {
          connectionId: CONN_A,
          action: "ACCOUNTS_SELECTED",
          scope: { accountIds: [], accountsLabels: [] },
        }),
      ),
    );

    expect(d.erreur).toBeInstanceOf(AuditPayloadInvalideError);
    expect(d.consents).toBe(0);
  });
});

describe("repository — snapshot fail-closed (AUDIT_SNAPSHOT_INCOMPLET)", () => {
  it("14. acteur sans identité (email vide) → refus, aucun consentement anonyme écrit", async () => {
    const d = await deltaAudit(() =>
      executerFantome(async (tx, ctx) =>
        enregistrerConsentement(tx, ctx, {
          connectionId: CONN_A,
          action: "GRANTED",
          scope: { institutionId: "absa" },
        }),
      ),
    );

    expect(d.erreur).toBeInstanceOf(AuditSnapshotIncompletError);
    expect(d.consents).toBe(0);
    expect(d.events).toBe(0);
  });
});

describe("GRANTED — portée de l'émission (garde anti-faux-consentement)", () => {
  const ECHANGE = {
    ConnectionId: "omnifi-conn-nouvelle",
    InstitutionId: "absa",
    InstitutionName: "Absa Internet Banking",
  };

  it("15. link-exchange (options.consentement) → un GRANTED, atomique", async () => {
    const d = await deltaAudit(() =>
      persisterConnexionEtComptes(
        executerA,
        ECHANGE,
        [compteOmnifi("omnifi-acct-neuf")],
        { consentement: {} },
      ),
    );

    expect(d.erreur).toBeUndefined();
    expect(d.consents).toBe(1);
    expect(d.events).toBe(1);

    const ligne = await dernierConsentement();
    expect(ligne.action).toBe("GRANTED");
    expect(ligne.grantedByEmail).toBe("alice@omnicane.mu");
    // Le snapshot d'institution est bien celui de la connexion fraîchement créée.
    expect(ligne.institutionName).toBe("Absa Internet Banking");
  });

  it("16. re-sync (sans options) → AUCUN consentement (sinon faux GRANTED à chaque synchro)", async () => {
    // Exactement l'appel des chemins de re-synchronisation : pas d'options.
    const d = await deltaAudit(() =>
      persisterConnexionEtComptes(executerA, ECHANGE, [
        compteOmnifi("omnifi-acct-neuf"),
      ]),
    );

    expect(d.erreur).toBeUndefined();
    expect(d.consents).toBe(0);
    expect(d.events).toBe(0);
  });

  it("17. un re-link explicite réémet un GRANTED (append-only : on n'écrase pas l'histoire)", async () => {
    const d = await deltaAudit(async () => {
      await persisterConnexionEtComptes(executerA, ECHANGE, [], { consentement: {} });
      await persisterConnexionEtComptes(executerA, ECHANGE, [], { consentement: {} });
    });

    // Deux actes de consentement horodatés, malgré l'upsert idempotent de la connexion.
    expect(d.erreur).toBeUndefined();
    expect(d.consents).toBe(2);
  });
});
