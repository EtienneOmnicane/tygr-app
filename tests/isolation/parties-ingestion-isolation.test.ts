/**
 * Suite anti-IDOR + invariants — ingestion des PARTIES (L3, détention compte↔party).
 *
 * Prouve sur un Postgres réel (PGlite, rôle `tygr_app` NON-propriétaire — sinon la
 * RLS est ignorée) que l'ingestion des parties :
 *  - est IDEMPOTENTE (re-sync ne duplique pas ; rafraîchit name/ownership_type) ;
 *  - PRÉSERVE les champs HUMAINS (entity_id, is_active posés par l'ADMIN survivent
 *    au re-sync — test cœur, aligné sur l'invariant bank_accounts.entity_id) ;
 *  - ne fabrique AUCUNE party pour un compte sans PartyId (fail-closed) ;
 *  - itère sur une collection N-N-ready (deux comptes, même PartyId → 1 party, 2 liens) ;
 *  - fail-soft STRUCTUREL : un échec parties (transaction séparée) ne défait JAMAIS les
 *    comptes déjà commités (preuve que la couche sacrée est protégée) ;
 *  - fail-soft qui NE MASQUE PAS l'isolation : une erreur systémique de tenancy levée
 *    pendant la phase parties est RE-LEVÉE (jamais avalée) ;
 *  - isolation tenant : une party de WS_A est invisible depuis WS_B (RLS).
 *
 * Même montage que ingestion-isolation.test.ts : migrations réelles, provisioning
 * tygr_app, `set role tygr_app`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { accountPartyRole, parties } from "@/server/db/schema";
import {
  createWithWorkspace,
  WorkspaceAccessDeniedError,
  type ExecuterWorkspace,
} from "@/server/db/tenancy";
import { persisterConnexionEtComptes } from "@/server/widget/orchestration";
import type { OmniFiAccount } from "@/server/omnifi";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111"; // MANAGER de A
const BOB = "22222222-2222-4222-8222-222222222222"; // MANAGER de B

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

/** Fabrique un OmniFiAccount minimal (Enabled) avec une party optionnelle. */
function compteOmnifi(
  accountId: string,
  party?: { id: string; name?: string | null; ownership?: string },
): OmniFiAccount {
  return {
    AccountId: accountId,
    Status: "Enabled",
    Currency: "MUR",
    Balances: [{ Type: "ITAV", Amount: { Amount: "1000.00", Currency: "MUR" } }],
    PartyId: party?.id ?? null,
    PartyName: party?.name ?? null,
    OwnershipType: party?.ownership,
  };
}

const ECHANGE = { ConnectionId: "conn-l3", InstitutionId: "mcb", InstitutionName: "MCB" };

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

describe("ingestion des parties (L3) — idempotence, invariants, isolation", () => {
  it("1. idempotence : 2 syncs du même compte+party → 1 party, 1 liaison ; hints rafraîchis", async () => {
    // 1er sync : party avec name/ownership initiaux.
    await persisterConnexionEtComptes(
      (fn) => withWorkspace(sessionA, fn),
      ECHANGE,
      [compteOmnifi("acc-idem", { id: "party-1", name: "Sucrière SA", ownership: "BUSINESS" })],
    );
    // 2e sync : MÊME party Omni-FI, name/ownership amont MODIFIÉS (renommage).
    await persisterConnexionEtComptes(
      (fn) => withWorkspace(sessionA, fn),
      ECHANGE,
      [compteOmnifi("acc-idem", { id: "party-1", name: "Sucrière Ltd", ownership: "TRUST" })],
    );

    const ps = await withWorkspace(sessionA, (tx) =>
      tx.select().from(parties).where(eq(parties.omnifiPartyId, "party-1")),
    );
    const liens = await withWorkspace(sessionA, (tx) =>
      tx.select().from(accountPartyRole).where(eq(accountPartyRole.partyId, ps[0].id)),
    );

    expect(ps).toHaveLength(1); // pas de doublon
    expect(liens).toHaveLength(1); // une seule liaison
    expect(ps[0].name).toBe("Sucrière Ltd"); // hint rafraîchi
    expect(ps[0].ownershipType).toBe("TRUST"); // hint rafraîchi
    expect(liens[0].ownershipType).toBe("TRUST"); // rôle rafraîchi
  });

  it("2. ⭐ champs HUMAINS préservés : entity_id + is_active=false survivent au re-sync", async () => {
    // 1er sync : la party naît (entity_id NULL, is_active true).
    await persisterConnexionEtComptes(
      (fn) => withWorkspace(sessionA, fn),
      ECHANGE,
      [compteOmnifi("acc-human", { id: "party-human", name: "Avant", ownership: "BUSINESS" })],
    );

    // L'ADMIN rattache la party à une entité ET l'archive (simulé en base, owner —
    // on isole l'invariant d'ingestion ; l'assignation via Server Action est couverte
    // ailleurs). On pose l'entité puis on mute entity_id + is_active sur la party.
    const ENT_A = "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await client.exec(`reset role;`);
    await client.exec(`
      insert into entities (id, workspace_id, name, code, is_active) values
        ('${ENT_A}', '${WS_A}', 'Sucrière', 'SUC', true);
      update parties set entity_id = '${ENT_A}', is_active = false
        where workspace_id = '${WS_A}' and omnifi_party_id = 'party-human';
    `);
    await client.exec(`set role tygr_app;`);

    // 2e sync : MÊME party, hints amont mis à jour (re-découverte).
    await persisterConnexionEtComptes(
      (fn) => withWorkspace(sessionA, fn),
      ECHANGE,
      [compteOmnifi("acc-human", { id: "party-human", name: "Après", ownership: "JOINT_OWNER" })],
    );

    const [p] = await withWorkspace(sessionA, (tx) =>
      tx
        .select({
          entityId: parties.entityId,
          isActive: parties.isActive,
          name: parties.name,
          ownershipType: parties.ownershipType,
        })
        .from(parties)
        .where(eq(parties.omnifiPartyId, "party-human")),
    );
    // Champs HUMAINS : INCHANGÉS (hors du set du upsert).
    expect(p.entityId).toBe(ENT_A);
    expect(p.isActive).toBe(false);
    // Hints amont : bien rafraîchis (preuve que l'upsert a tourné, et que SEULS les
    // champs humains sont préservés).
    expect(p.name).toBe("Après");
    expect(p.ownershipType).toBe("JOINT_OWNER");
  });

  it("3. PartyId null → aucune party, aucune liaison", async () => {
    await persisterConnexionEtComptes(
      (fn) => withWorkspace(sessionA, fn),
      { ConnectionId: "conn-sansparty", InstitutionId: "mcb", InstitutionName: "MCB" },
      [compteOmnifi("acc-sansparty")], // PartyId = null
    );

    const ps = await withWorkspace(sessionA, (tx) =>
      tx.select().from(parties),
    );
    const compte = await withWorkspace(sessionA, (tx) =>
      tx
        .select({ id: schema.bankAccounts.id })
        .from(schema.bankAccounts)
        .where(eq(schema.bankAccounts.omnifiAccountId, "acc-sansparty")),
    );
    // Le compte existe…
    expect(compte).toHaveLength(1);
    // …mais aucune party/liaison ne le cite (aucune party "acc-sansparty").
    const liens = await withWorkspace(sessionA, (tx) =>
      tx
        .select()
        .from(accountPartyRole)
        .where(eq(accountPartyRole.bankAccountId, compte[0].id)),
    );
    expect(liens).toHaveLength(0);
    // Sanity : aucune des parties existantes n'a un omnifi_party_id "null".
    expect(ps.some((p) => p.omnifiPartyId === "null")).toBe(false);
  });

  it("4. itération / N-N-ready : deux comptes même PartyId → 1 party, 2 liaisons", async () => {
    await persisterConnexionEtComptes(
      (fn) => withWorkspace(sessionA, fn),
      { ConnectionId: "conn-shared-party", InstitutionId: "mcb", InstitutionName: "MCB" },
      [
        compteOmnifi("acc-nn-1", { id: "party-shared", name: "Holding", ownership: "BUSINESS" }),
        compteOmnifi("acc-nn-2", { id: "party-shared", name: "Holding", ownership: "BUSINESS" }),
      ],
    );

    const ps = await withWorkspace(sessionA, (tx) =>
      tx.select().from(parties).where(eq(parties.omnifiPartyId, "party-shared")),
    );
    expect(ps).toHaveLength(1); // une seule party malgré deux comptes

    const liens = await withWorkspace(sessionA, (tx) =>
      tx.select().from(accountPartyRole).where(eq(accountPartyRole.partyId, ps[0].id)),
    );
    expect(liens).toHaveLength(2); // deux liaisons (une par compte)
  });

  it("5. ⭐ fail-soft structurel : un échec parties NE défait PAS les comptes commités", async () => {
    // On provoque une VRAIE erreur de DONNÉES : `ownership_type` est varchar(24) ;
    // un OwnershipType de >24 caractères fait lever « value too long » dès le 1er
    // upsert touché (parties), DANS la phase parties (transaction SÉPARÉE, exécutée
    // APRÈS le commit des comptes). La phase comptes ayant déjà commité, les comptes
    // doivent survivre — preuve que la couche sacrée est protégée (DÉCISION 2).
    const ownershipTropLong = "X".repeat(40); // > 24 → value too long en phase parties

    // On capture le warn fail-soft : il doit porter le code SANS PII (jamais PartyName).
    const warns: string[] = [];
    const warnOrig = console.warn;
    console.warn = (...a: unknown[]) => warns.push(String(a[0]));
    let n: number;
    try {
      // Ne doit PAS throw (l'erreur de données est avalée par le fail-soft).
      n = await persisterConnexionEtComptes(
        (fn) => withWorkspace(sessionA, fn),
        { ConnectionId: "conn-failsoft", InstitutionId: "mcb", InstitutionName: "MCB" },
        [
          compteOmnifi("acc-failsoft", {
            id: "party-failsoft",
            name: "PII Secret SARL", // ne doit JAMAIS apparaître dans le log
            ownership: ownershipTropLong,
          }),
        ],
      );
    } finally {
      console.warn = warnOrig;
    }
    expect(n).toBe(1); // le compte a bien été compté/persisté

    // Observabilité : le fail-soft a journalisé l'échec, code OPAQUE, ZÉRO PII.
    const log = warns.find((w) => w.includes("parties_ingestion_echec"));
    expect(log).toBeDefined();
    expect(log).toContain("acc-failsoft"); // identifiant Omni-FI opaque
    expect(log).not.toContain("PII Secret SARL"); // jamais de libellé/PartyName

    // Le COMPTE est persisté (la phase comptes a commité avant l'échec parties).
    const compte = await withWorkspace(sessionA, (tx) =>
      tx
        .select({ id: schema.bankAccounts.id })
        .from(schema.bankAccounts)
        .where(eq(schema.bankAccounts.omnifiAccountId, "acc-failsoft")),
    );
    expect(compte).toHaveLength(1);

    // La liaison n'existe PAS (l'upsert a échoué) — mais l'ingestion bancaire est saine.
    const liens = await withWorkspace(sessionA, (tx) =>
      tx
        .select()
        .from(accountPartyRole)
        .where(eq(accountPartyRole.bankAccountId, compte[0].id)),
    );
    expect(liens).toHaveLength(0);
  });

  it("6. fail-soft NE masque PAS l'isolation : une erreur systémique en phase parties est RE-LEVÉE", async () => {
    // `executer` instrumenté : la 1re invocation (phase COMPTES) tourne normalement
    // (withWorkspace réel, comptes commités) ; les suivantes (phase PARTIES) lèvent
    // WorkspaceAccessDeniedError — un signal d'isolation qui NE DOIT PAS être avalé.
    // persisterConnexionEtComptes fait exactement 1 appel comptes puis ≥1 appel
    // parties : compter les invocations isole déterministement la phase parties.
    let invocations = 0;
    const executerSysFail: ExecuterWorkspace = (fn) => {
      invocations += 1;
      if (invocations === 1) {
        return withWorkspace(sessionA, fn); // phase comptes : réelle
      }
      // phase parties : signal systémique de tenancy.
      throw new WorkspaceAccessDeniedError();
    };

    await expect(
      persisterConnexionEtComptes(
        executerSysFail,
        { ConnectionId: "conn-sysfail", InstitutionId: "mcb", InstitutionName: "MCB" },
        [compteOmnifi("acc-sysfail", { id: "party-sysfail", name: "Iso", ownership: "BUSINESS" })],
      ),
    ).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);

    // Et l'erreur a bien été levée DEPUIS la phase parties (≥2 invocations), pas avant.
    expect(invocations).toBeGreaterThanOrEqual(2);
  });

  it("7. isolation tenant : une party de WS_A est invisible depuis WS_B (RLS)", async () => {
    await persisterConnexionEtComptes(
      (fn) => withWorkspace(sessionA, fn),
      { ConnectionId: "conn-iso-a", InstitutionId: "mcb", InstitutionName: "MCB" },
      [compteOmnifi("acc-iso-a", { id: "party-iso-a", name: "Secret A", ownership: "BUSINESS" })],
    );

    // Sous A : visible.
    const vuParA = await withWorkspace(sessionA, (tx) =>
      tx.select().from(parties).where(eq(parties.omnifiPartyId, "party-iso-a")),
    );
    expect(vuParA).toHaveLength(1);

    // Sous B : zéro ligne (RLS scope par workspace_id), liaison comprise.
    const vuParB = await withWorkspace(sessionB, (tx) =>
      tx.select().from(parties).where(eq(parties.omnifiPartyId, "party-iso-a")),
    );
    expect(vuParB).toHaveLength(0);

    const liensVuB = await withWorkspace(sessionB, (tx) =>
      tx.select().from(accountPartyRole),
    );
    // B ne voit AUCUNE liaison de A.
    expect(liensVuB.every((l) => l.workspaceId === WS_B)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Mappeur pur versPartie — couverture en isolation (PartyId vide,    */
/* normalisation des hints).                                          */
/* ------------------------------------------------------------------ */
describe("versPartie (mappeur pur)", () => {
  it("retourne null quand PartyId est absent/vide/espaces", async () => {
    const { versPartie } = await import("@/server/repositories/ingestion");
    expect(versPartie(compteOmnifi("a"))).toBeNull(); // PartyId null
    expect(versPartie({ ...compteOmnifi("a"), PartyId: "" })).toBeNull();
    expect(versPartie({ ...compteOmnifi("a"), PartyId: "   " })).toBeNull();
  });

  it("normalise name/ownership vides en null, conserve PartyId", async () => {
    const { versPartie } = await import("@/server/repositories/ingestion");
    const p = versPartie({
      ...compteOmnifi("a"),
      PartyId: "party-x",
      PartyName: "  ",
      OwnershipType: "",
    });
    expect(p).toEqual({ omnifiPartyId: "party-x", name: null, ownershipType: null });
  });
});

// ── Garde-fou L7a : la suite tourne-t-elle vraiment sous tygr_app ? ───────────
// Sans cette précondition, un `set role tygr_app` régressé ferait tourner la suite
// sous l'owner (RLS ignorée) en passant au vert silencieusement (faux-vert).
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
    const vus = await withWorkspace(sessionA, (tx) =>
      tx.select().from(schema.workspaceMembers),
    );
    expect(vus.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(vus.some((r) => r.workspaceId === WS_B)).toBe(false);
  });
});
