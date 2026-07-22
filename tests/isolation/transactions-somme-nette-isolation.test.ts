/**
 * Suite isolation — AGRÉGAT « somme nette des résultats filtrés » (/transactions,
 * TX-RECHERCHE-SOMME-NETTE1). Nouvelle LECTURE FINANCIÈRE ⇒ preuve d'isolation
 * obligatoire (CLAUDE.md règles 2, 3 et 8). Prouve :
 *
 * - RLS TENANT : un workspace ne somme JAMAIS les transactions d'un autre — et la
 *   contre-preuve R1 montre que c'est bien la RLS qui protège l'agrégat (sous l'owner,
 *   la même somme voit les deux tenants).
 * - PÉRIMÈTRE ENTITÉ (étage 2, ENTITY-READ-JOIN1) : un membre en Vision Entité ne somme
 *   que les comptes de SON périmètre — pas de fuite intra-groupe dans un total.
 * - GROUP BY DEVISE : une ligne par devise, JAMAIS d'addition cross-devise (règle 8).
 * - CONVENTION DE SIGNE (le piège de cet agrégat, cf. ci-dessous).
 * - `net = entrées − sorties`, vérifié en CENTIMES ENTIERS (BigInt) — zéro float, y
 *   compris dans le test.
 * - Tombstone (`is_removed`) exclu ; filtres (recherche / dates / statut / compte /
 *   catégorie TX-QA-FILTRE-CAT1) appliqués EXACTEMENT comme dans la liste
 *   (assertion croisée avec `listerTransactions` : le total totalise bien les
 *   lignes affichées).
 *
 * ⚠️⚠️ CONVENTION DE SIGNE — POURQUOI LE SEMIS EST EN MONTANTS POSITIFS.
 * En base, `transactions_cache.amount` est une valeur ABSOLUE : l'ingestion
 * (`normaliserMontant`, regex `^\d{1,13}(\.\d+)?$`) REJETTE tout signe, et
 * `upsertTransactions` est le seul chemin d'écriture applicatif. Le SENS vit sur
 * `credit_debit` (seule colonne sous CHECK). Ce semis reproduit donc la PRODUCTION —
 * comme le font déjà `dashboard-synthese-mensuelle` et `dashboard-isolation`.
 *
 * NE PAS « corriger » ce fichier en semant des montants négatifs (comme le fait
 * `transactions-isolation.test.ts`, où le signe est invisible : il n'y lit `amount`
 * qu'à travers `abs()`). Un semis négatif rendrait VERT un agrégat
 * `net = sum(amount)` — qui, en production, ADDITIONNE les sorties aux entrées. Le cas
 * « convention de signe » ci-dessous verrouille ce piège.
 *
 * Tourne sous le rôle `tygr_app` non-owner (RLS active) avec migrations + provisioning
 * RÉELS (même socle que les autres suites d'isolation, bloquante en CI).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  listerTransactions,
  sommeNetteParDevise,
  type SommeNetteDevise,
} from "@/server/repositories/transactions";
import {
  listerTransactionsSchema,
  sommeNetteSchema,
} from "@/lib/transactions-schema";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111"; // WS_A, AUCUN scope → Vision Globale
const BOB = "22222222-2222-4222-8222-222222222222"; // WS_B
const CAROL = "33333333-3333-4333-8333-333333333333"; // WS_A, scopée BU Nord → Vision Entité

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };
const sessionCarol = { userId: CAROL, activeWorkspaceId: WS_A };

const CONN_A = "cccc0001-cccc-4ccc-8ccc-cccccccccccc";
const CONN_B = "cccc0002-cccc-4ccc-8ccc-cccccccccccc";
const ACC_MUR = "dddd0001-dddd-4ddd-8ddd-dddddddddddd"; // WS_A · MUR · BU Nord
const ACC_USD = "dddd0002-dddd-4ddd-8ddd-dddddddddddd"; // WS_A · USD · BU Sud
const ACC_B = "dddd0003-dddd-4ddd-8ddd-dddddddddddd"; // WS_B
const ENT_NORD = "eeee0001-eeee-4eee-8eee-eeeeeeeeeeee";
const ENT_SUD = "eeee0002-eeee-4eee-8eee-eeeeeeeeeeee";
const CAT_A = "aaaacccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Filtre par catégorie (TX-QA-FILTRE-CAT1) :
const CAT_MIN = "aaaacccd-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A · split MINORITAIRE sur M2 (préserve la sémantique EXISTS vs dominante)
const CAT_SANS = "aaaaccce-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A · ACTIVE mais AUCUN split
const CAT_B = "bbbbcccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // WS_B · jamais visible depuis A

// ── Jeu de données WS_A (montants POSITIFS + sens sur credit_debit = PRODUCTION) ──
// MUR (ACC_MUR) :
//   M1  2026-03-15  Credit 1000.00  « Salaire ACME »       (non catégorisé)
//   M2  2026-03-14  Debit   300.00  « Achat Fournisseur »  (PARTIEL : splits 100 CAT_A + 150 CAT_MIN)
//   M3  2026-03-13  Debit   200.00  « Loyer ACME »         (COMPLET : split 200)
//   M4  2026-03-12  Debit   999.00  « Supprimee »          ← TOMBSTONE (is_removed)
//   M5  2026-03-11  Credit    50.00 « Remboursement »      (non catégorisé)
//   ⇒ entrées 1050.00 · sorties 500.00 · NET 550.00 · 4 opérations
//   ⚠️ `sum(amount)` NU vaudrait 1550.00 (= 1000+300+200+50) : c'est le bug que la
//      convention de signe évite, et que le describe dédié verrouille.
// USD (ACC_USD) :
//   U1  2026-03-15  Credit 500.00 « Stripe payout »
//   U2  2026-03-14  Debit  100.00 « AWS »
//   ⇒ entrées 500.00 · sorties 100.00 · NET 400.00 · 2 opérations
const M1 = "10000001-0000-4000-8000-000000000000";
const M2 = "10000002-0000-4000-8000-000000000000";
const M3 = "10000003-0000-4000-8000-000000000000";
const M4 = "10000004-0000-4000-8000-000000000000";
const M5 = "10000005-0000-4000-8000-000000000000";
const U1 = "20000001-0000-4000-8000-000000000000";
const U2 = "20000002-0000-4000-8000-000000000000";
// WS_B : un gros débit qui ne doit JAMAIS entrer dans un total de A.
const B1 = "30000001-0000-4000-8000-000000000000";

/**
 * Chaîne décimale → CENTIMES entiers (BigInt). La SEULE façon honnête de comparer /
 * additionner des montants, y compris dans un test : `parseFloat` perd des centimes
 * (règle 8, « jamais de float, y compris à l'affichage »).
 *
 * NB : `BigInt(100)` et non le littéral `100n` — le `target` du projet est ES2017, où
 * la SYNTAXE littérale `…n` n'existe pas (TS2737) ; le TYPE bigint, lui, est disponible.
 * La garantie « zéro float » est donc intacte.
 */
function enCentimes(montant: string): bigint {
  const t = montant.trim();
  const negatif = t.startsWith("-");
  const sansSigne = negatif ? t.slice(1) : t;
  const [entier, decimales = ""] = sansSigne.split(".");
  const c =
    BigInt(entier) * BigInt(100) + BigInt((decimales + "00").slice(0, 2));
  return negatif ? -c : c;
}

const parseSomme = (f: Record<string, unknown>) => {
  const r = sommeNetteSchema.safeParse(f);
  if (!r.success) throw new Error("filtre de test invalide: " + r.error.message);
  return r.data;
};

const parseListe = (f: Record<string, unknown>) => {
  const r = listerTransactionsSchema.safeParse(f);
  if (!r.success) throw new Error("filtre de test invalide: " + r.error.message);
  return r.data;
};

type Session = { userId: string; activeWorkspaceId: string };

/** Somme nette (agrégat SERVEUR) pour une session + un jeu de filtres. */
function somme(session: Session, filtres: Record<string, unknown> = {}) {
  return withWorkspace(session, (tx, ctx) =>
    sommeNetteParDevise(tx, ctx, parseSomme(filtres)),
  );
}

/** La LISTE (mêmes filtres) — sert aux assertions croisées « le total totalise bien
 *  les lignes affichées ». Limite 100 : le jeu de test tient largement en une page. */
function liste(session: Session, filtres: Record<string, unknown> = {}) {
  return withWorkspace(session, (tx, ctx) =>
    listerTransactions(tx, ctx, parseListe({ ...filtres, limite: 100 })),
  );
}

/** Indexe les totaux par devise (l'agrégat renvoie un tableau ordonné). */
function parDevise(lignes: SommeNetteDevise[]): Record<string, SommeNetteDevise> {
  return Object.fromEntries(lignes.map((l) => [l.currency, l]));
}

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const st of raw.split("--> statement-breakpoint")) {
      if (st.trim().length > 0) await client.exec(st);
    }
  }

  await client.exec(`
    insert into workspaces (id,name,kind,omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'), ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id,email,full_name) values
      ('${ALICE}','a@g.mu','Alice'), ('${BOB}','b@g.mu','Bob'), ('${CAROL}','c@g.mu','Carol');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${ALICE}','${WS_A}','MANAGER'), ('${BOB}','${WS_B}','MANAGER'),
      ('${CAROL}','${WS_A}','MANAGER');

    -- Deux entités (BU) dans le MÊME workspace : l'entité n'est PAS une frontière de
    -- tenant, c'est l'étage 2 (périmètre intra-groupe).
    insert into entities (id,workspace_id,name) values
      ('${ENT_NORD}','${WS_A}','BU Nord'), ('${ENT_SUD}','${WS_A}','BU Sud');

    insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,institution_name,created_by) values
      ('${CONN_A}','${WS_A}','c-a','mcb','Mauritius Commercial Bank','${ALICE}'),
      ('${CONN_B}','${WS_B}','c-b','mcb','Bank One','${BOB}');

    -- 1 credential = comptes de PLUSIEURS entités (raison d'être de l'Option B).
    insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency,entity_id) values
      ('${ACC_MUR}','${WS_A}','${CONN_A}','a-mur','CC MUR','MUR','${ENT_NORD}'),
      ('${ACC_USD}','${WS_A}','${CONN_A}','a-usd','CC USD','USD','${ENT_SUD}'),
      ('${ACC_B}','${WS_B}','${CONN_B}','b-mur','CC B','MUR',null);

    -- CAROL est scopée sur la BU Nord (⇒ Vision Entité). ALICE n'a AUCUN scope
    -- (⇒ Vision Globale : elle voit tout le tenant).
    insert into member_entity_scopes (workspace_id,user_id,entity_id) values
      ('${WS_A}','${CAROL}','${ENT_NORD}');

    insert into categories (id,workspace_id,name) values
      ('${CAT_A}','${WS_A}','Fournisseurs'),
      ('${CAT_MIN}','${WS_A}','Transport'),
      ('${CAT_SANS}','${WS_A}','Divers'),
      ('${CAT_B}','${WS_B}','Frais B');

    -- ⚠️ MONTANTS POSITIFS + sens sur credit_debit = convention de PRODUCTION
    -- (normaliserMontant rejette tout signe). Cf. l'avertissement en tête de fichier.
    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label,is_removed) values
      ('${M1}','${WS_A}','${ACC_MUR}','m1','2026-03-15','2026-03-15T08:00:00Z','1000.00','MUR','Credit','raw1','Salaire ACME',false),
      ('${M2}','${WS_A}','${ACC_MUR}','m2','2026-03-14','2026-03-14T08:00:00Z','300.00','MUR','Debit','raw2','Achat Fournisseur',false),
      ('${M3}','${WS_A}','${ACC_MUR}','m3','2026-03-13','2026-03-13T08:00:00Z','200.00','MUR','Debit','raw3','Loyer ACME',false),
      ('${M4}','${WS_A}','${ACC_MUR}','m4','2026-03-12','2026-03-12T08:00:00Z','999.00','MUR','Debit','raw4','Supprimee',true),
      ('${M5}','${WS_A}','${ACC_MUR}','m5','2026-03-11','2026-03-11T08:00:00Z','50.00','MUR','Credit','raw5','Remboursement',false),
      ('${U1}','${WS_A}','${ACC_USD}','u1','2026-03-15','2026-03-15T08:00:00Z','500.00','USD','Credit','raw6','Stripe payout',false),
      ('${U2}','${WS_A}','${ACC_USD}','u2','2026-03-14','2026-03-14T08:00:00Z','100.00','USD','Debit','raw7','AWS',false);

    -- Workspace B : ne doit JAMAIS entrer dans un total de A.
    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label,is_removed) values
      ('${B1}','${WS_B}','${ACC_B}','b1','2026-03-15','2026-03-15T08:00:00Z','7777.00','MUR','Debit','rawB','Secret B',false);

    -- Splits : M2 PARTIEL (100 CAT_A + 150 CAT_MIN = 250/300 — CAT_A y est
    -- MINORITAIRE, la dominante est CAT_MIN : c'est ce qui rend la sémantique du
    -- filtre catégorie FALSIFIABLE, cf. le cas « appartenance, pas dominance ») ;
    -- M3 COMPLET (200 CAT_A / 200). M1/M5 sans split. B1 ventilé sur CAT_B (WS_B).
    insert into transaction_categorizations
      (workspace_id,transaction_id,transaction_date,category_id,amount,source,created_by) values
      ('${WS_A}','${M2}','2026-03-14','${CAT_A}','100.00','MANUAL','${ALICE}'),
      ('${WS_A}','${M2}','2026-03-14','${CAT_MIN}','150.00','MANUAL','${ALICE}'),
      ('${WS_A}','${M3}','2026-03-13','${CAT_A}','200.00','MANUAL','${ALICE}'),
      ('${WS_B}','${B1}','2026-03-15','${CAT_B}','50.00','MANUAL','${BOB}');
  `);

  await client.exec(
    readFileSync(
      path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
      "utf8",
    ),
  );
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

// ── Garde-fou : sans ça, un `set role` régressé ferait tourner toute la suite sous
// l'owner (RLS ignorée) et elle passerait au VERT en mentant (faux-vert).
describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app, pas sous l'owner", async () => {
    await client.exec(`set role tygr_app;`);
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

describe("RLS tenant — un workspace ne somme JAMAIS l'autre", () => {
  it("A ne totalise QUE ses propres transactions (le 7777 de B n'entre nulle part)", async () => {
    const totaux = parDevise(await somme(sessionA));

    expect(totaux.MUR).toMatchObject({
      entrees: "1050.00",
      sorties: "500.00",
      net: "550.00",
      nbTransactions: 4,
    });
    // Preuve directe de non-contamination : le débit de B (7777) gonflerait `sorties`
    // à 8277.00 s'il fuyait dans l'agrégat.
    expect(totaux.MUR.sorties).not.toBe("8277.00");
    expect(
      (await somme(sessionA)).some((l) => l.sorties.includes("7777")),
    ).toBe(false);
  });

  it("B ne totalise QUE la sienne (net NÉGATIF : elle ne sort que des sorties)", async () => {
    const totaux = await somme(sessionB);
    expect(totaux).toHaveLength(1);
    expect(totaux[0]).toMatchObject({
      currency: "MUR",
      entrees: "0.00",
      sorties: "7777.00",
      net: "-7777.00",
      nbTransactions: 1,
    });
  });
});

describe("GROUP BY devise — JAMAIS d'addition cross-devise (règle 8)", () => {
  it("A obtient UNE ligne par devise, ordonnées, sans mélange MUR/USD", async () => {
    const totaux = await somme(sessionA);

    expect(totaux.map((l) => l.currency)).toEqual(["MUR", "USD"]);
    expect(totaux[0]).toMatchObject({ net: "550.00", nbTransactions: 4 });
    expect(totaux[1]).toMatchObject({
      entrees: "500.00",
      sorties: "100.00",
      net: "400.00",
      nbTransactions: 2,
    });

    // Le total « toutes devises confondues » (550 + 400 = 950) ne doit exister NULLE
    // PART : additionner des roupies et des dollars est interdit (aucun taux annoté).
    expect(totaux.some((l) => l.net === "950.00")).toBe(false);
    // Et aucune ligne n'agrège les deux devises (nb total = 6).
    expect(totaux.some((l) => l.nbTransactions === 6)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// LE PIÈGE DE CET AGRÉGAT. `amount` est stocké en valeur ABSOLUE (normaliserMontant
// rejette tout signe) : le sens vient de `credit_debit`. Un agrégat écrit
// `net = sum(amount)` (hypothèse « montant signé ») ADDITIONNERAIT donc les sorties aux
// entrées. Ces cas échouent si quelqu'un « re-corrige » l'agrégat dans ce sens.
// ══════════════════════════════════════════════════════════════════════════════════
describe("convention de signe — le sens vient de credit_debit, jamais du signe de amount", () => {
  it("les montants semés sont bien POSITIFS en base (sum(amount) NU = 1550, pas 550)", async () => {
    // Contrôle de la PRÉMISSE : si un jour l'ingestion persistait des montants signés,
    // ce cas tomberait et signalerait qu'il faut revoir l'agrégat — plutôt que de laisser
    // l'agrégat mentir en silence.
    const brut = await withWorkspace(sessionA, (tx) =>
      tx.execute(
        `select sum(amount)::text as total from transactions_cache
         where currency = 'MUR' and is_removed = false`,
      ),
    );
    const total = (brut as unknown as { rows: { total: string }[] }).rows[0].total;
    expect(enCentimes(total)).toBe(BigInt(155000)); // 1000 + 300 + 200 + 50
  });

  it("le NET soustrait les sorties (550.00) au lieu de les additionner (1550.00)", async () => {
    const totaux = parDevise(await somme(sessionA));
    expect(totaux.MUR.net).toBe("550.00");
    // ⛔ Ce qu'un `sum(amount)` nu aurait renvoyé — le bug que cet agrégat évite.
    expect(totaux.MUR.net).not.toBe("1550.00");
  });

  it("les SORTIES sont peuplées (500.00), pas vides comme le donnerait `filter (amount < 0)`", async () => {
    const totaux = parDevise(await somme(sessionA));
    expect(totaux.MUR.sorties).toBe("500.00");
    // ⛔ Ce qu'un `filter (where amount < 0)` aurait renvoyé sur des montants absolus.
    expect(totaux.MUR.sorties).not.toBe("0.00");
  });
});

describe("net = entrées − sorties (centimes entiers, ZÉRO float)", () => {
  it("l'identité tient sur CHAQUE ligne, pour les deux tenants", async () => {
    const lignes = [...(await somme(sessionA)), ...(await somme(sessionB))];
    expect(lignes.length).toBeGreaterThan(0);

    for (const l of lignes) {
      expect(enCentimes(l.net)).toBe(enCentimes(l.entrees) - enCentimes(l.sorties));
    }
  });

  it("l'ÉCHELLE est figée à 2 décimales — y compris un zéro (« 0.00 », jamais « 0 »)", async () => {
    // C'est ce qui aligne les virgules décimales d'une devise à l'autre à l'affichage
    // (contrat « chaîne décimale », §Formatage). Un `coalesce(..., 0)::text` nu
    // renverrait « 0 » quand une devise n'a aucune entrée → colonnes désalignées.
    const totaux = await somme(sessionB); // B n'a AUCUNE entrée → entrees = 0
    expect(totaux[0].entrees).toBe("0.00");

    for (const l of [...(await somme(sessionA)), ...totaux]) {
      for (const montant of [l.entrees, l.sorties, l.net]) {
        expect(montant).toMatch(/^-?\d+\.\d{2}$/);
      }
    }
  });
});

describe("tombstone — is_removed exclu du total", () => {
  it("le débit supprimé (999.00) ne compte NI dans les sorties NI dans le nombre d'opérations", async () => {
    const totaux = parDevise(await somme(sessionA));
    expect(totaux.MUR.sorties).toBe("500.00"); // et non 1499.00
    expect(totaux.MUR.nbTransactions).toBe(4); // et non 5
    expect(totaux.MUR.net).toBe("550.00"); // et non -449.00
  });
});

describe("filtres — le total totalise EXACTEMENT les lignes listées", () => {
  /**
   * Assertion CROISÉE, cœur de la fonctionnalité : pour un même jeu de filtres, le
   * nombre d'opérations de l'agrégat doit égaler, PAR DEVISE, le nombre de lignes que
   * la liste affiche. C'est la garantie « le total correspond à ce que je vois » — elle
   * casserait au premier filtre appliqué d'un seul côté.
   */
  async function verifierCoherenceListe(filtres: Record<string, unknown>) {
    const totaux = await somme(sessionA, filtres);
    const page = await liste(sessionA, filtres);

    const nbParDevise = new Map<string, number>();
    for (const l of page.lignes) {
      nbParDevise.set(l.currency, (nbParDevise.get(l.currency) ?? 0) + 1);
    }
    expect(totaux.map((t) => t.currency).sort()).toEqual(
      [...nbParDevise.keys()].sort(),
    );
    for (const t of totaux) {
      expect(t.nbTransactions).toBe(nbParDevise.get(t.currency));
    }
    return totaux;
  }

  it("recherche (ILIKE sur clean_label) — « ACME » ne garde que M1 (+1000) et M3 (−200)", async () => {
    const totaux = parDevise(await verifierCoherenceListe({ recherche: "acme" }));
    // Seule la devise MUR a des libellés « ACME » → l'USD disparaît du total.
    expect(Object.keys(totaux)).toEqual(["MUR"]);
    expect(totaux.MUR).toMatchObject({
      entrees: "1000.00",
      sorties: "200.00",
      net: "800.00",
      nbTransactions: 2,
    });
  });

  it("bornes de date (incluses) — 14→15 mars", async () => {
    const totaux = parDevise(
      await verifierCoherenceListe({
        dateDebut: "2026-03-14",
        dateFin: "2026-03-15",
      }),
    );
    // MUR : M1 (+1000) et M2 (−300) ; M3/M5 hors fenêtre, M4 tombstone.
    expect(totaux.MUR).toMatchObject({
      entrees: "1000.00",
      sorties: "300.00",
      net: "700.00",
      nbTransactions: 2,
    });
    // USD : U1 (+500) et U2 (−100).
    expect(totaux.USD).toMatchObject({ net: "400.00", nbTransactions: 2 });
  });

  it("statut COMPLET — ne garde que M3, et le NET devient NÉGATIF", async () => {
    const totaux = parDevise(await verifierCoherenceListe({ statut: "COMPLET" }));
    expect(Object.keys(totaux)).toEqual(["MUR"]);
    expect(totaux.MUR).toMatchObject({
      entrees: "0.00", // aucune entrée dans le jeu filtré
      sorties: "200.00",
      net: "-200.00", // un net négatif est une SORTIE nette, pas une erreur
      nbTransactions: 1,
    });
  });

  it("statut NON_CATEGORISE — M1 + M5 (MUR) et les deux USD", async () => {
    const totaux = parDevise(
      await verifierCoherenceListe({ statut: "NON_CATEGORISE" }),
    );
    expect(totaux.MUR).toMatchObject({
      entrees: "1050.00",
      sorties: "0.00",
      net: "1050.00",
      nbTransactions: 2,
    });
    expect(totaux.USD).toMatchObject({ net: "400.00", nbTransactions: 2 });
  });

  it("filtre de compte — ACC_MUR ne totalise que le MUR", async () => {
    const totaux = await verifierCoherenceListe({ bankAccountId: ACC_MUR });
    expect(totaux.map((t) => t.currency)).toEqual(["MUR"]);
    expect(totaux[0].net).toBe("550.00");
  });

  it("filtres CUMULÉS en AND (recherche + statut) — pas un OR", async () => {
    // « ACME » matche M1 (non catégorisé) et M3 (complet). En exigeant EN PLUS
    // statut=PARTIEL, l'AND doit vider le total (un OR renverrait des lignes).
    const totaux = await verifierCoherenceListe({
      recherche: "ACME",
      statut: "PARTIEL",
    });
    expect(totaux).toEqual([]);
  });

  it("aucun résultat → tableau VIDE (jamais une ligne à 0 dans une devise arbitraire)", async () => {
    const totaux = await somme(sessionA, { recherche: "introuvable-zzz" });
    expect(totaux).toEqual([]);
    // Un « Rs 0,00 » serait un mensonge : 0 dans QUELLE devise ? L'UI n'affiche rien.
  });

  // ── Filtre par CATÉGORIE (TX-QA-FILTRE-CAT1) — sémantique EXISTS, PLAN §2 ──

  it("catégorie CAT_A — ne garde que M2 et M3, total cohérent avec la liste", async () => {
    const totaux = parDevise(await verifierCoherenceListe({ categorieId: CAT_A }));
    expect(Object.keys(totaux)).toEqual(["MUR"]);
    expect(totaux.MUR).toMatchObject({
      entrees: "0.00",
      sorties: "500.00", // M2 (300) + M3 (200) — le jeu filtré n'a que des sorties
      net: "-500.00",
      nbTransactions: 2,
    });
    const page = await liste(sessionA, { categorieId: CAT_A });
    expect(page.lignes.map((l) => l.id).sort()).toEqual([M2, M3].sort());
  });

  it("catégorie — APPARTENANCE, pas dominance : le split MINORITAIRE suffit (arbitrage §2a)", async () => {
    // M2 est ventilé 100 CAT_A + 150 CAT_MIN : sa DOMINANTE est CAT_MIN. Le filtre
    // CAT_A doit QUAND MÊME retenir M2 — une implémentation « dominante = X »
    // (option b, écartée au PLAN) le cacherait et ce cas casserait. Et l'EXISTS ne
    // DUPLIQUE pas M2 malgré ses 2 splits (un JOIN nu le compterait deux fois).
    const page = await liste(sessionA, { categorieId: CAT_A });
    expect(page.lignes.filter((l) => l.id === M2)).toHaveLength(1);
    // Contre-angle : filtrer par la dominante CAT_MIN retient aussi M2, seul.
    const pageMin = await liste(sessionA, { categorieId: CAT_MIN });
    expect(pageMin.lignes.map((l) => l.id)).toEqual([M2]);
  });

  it("catégorie + statut PARTIEL cumulés en AND — ne garde que M2", async () => {
    const totaux = parDevise(
      await verifierCoherenceListe({ categorieId: CAT_A, statut: "PARTIEL" }),
    );
    expect(totaux.MUR).toMatchObject({
      sorties: "300.00",
      net: "-300.00",
      nbTransactions: 1,
    });
  });

  it("catégorie + NON_CATEGORISE = ensemble VIDE par construction (documenté, pas une erreur)", async () => {
    // Avoir un split de CAT_A contredit « aucun split » : l'AND est vide par
    // construction. C'est un état LÉGITIME (empty state standard côté UI), le
    // contrat ne le rejette pas — et liste ET somme se vident ENSEMBLE.
    const totaux = await verifierCoherenceListe({
      categorieId: CAT_A,
      statut: "NON_CATEGORISE",
    });
    expect(totaux).toEqual([]);
  });

  it("catégorie ACTIVE sans transaction → liste VIDE et somme [] sur le MÊME jeu (le vrai piège)", async () => {
    const page = await liste(sessionA, { categorieId: CAT_SANS });
    expect(page.lignes).toEqual([]);
    expect(await somme(sessionA, { categorieId: CAT_SANS })).toEqual([]);
    // Pas de « Rs 0,00 » : le bandeau UI se démonte AVEC la liste, jamais un total
    // au-dessus d'un vide.
  });

  it("catégorie × keyset — frontière de page SANS doublon ni trou (limite=1), pas de page fantôme", async () => {
    // Le prédicat EXISTS doit être NEUTRE en cardinalité malgré les 2 splits de M2 :
    // un JOIN nu dupliquerait M2, ferait mentir hasMore (page fantôme) et
    // calculerait le curseur depuis un doublon. Ordre keyset : (date DESC, id DESC).
    const p1 = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(
        tx,
        ctx,
        parseListe({ categorieId: CAT_A, limite: 1 }),
      ),
    );
    expect(p1.lignes.map((l) => l.id)).toEqual([M2]); // 2026-03-14
    expect(p1.hasMore).toBe(true);

    const p2 = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(
        tx,
        ctx,
        parseListe({
          categorieId: CAT_A,
          limite: 1,
          curseur: p1.curseurSuivant as string,
        }),
      ),
    );
    expect(p2.lignes.map((l) => l.id)).toEqual([M3]); // 2026-03-13, ni doublon ni trou
    expect(p2.hasMore).toBe(false); // pas de page fantôme résiduelle
  });
});

describe("filtre catégorie × RLS tenant — jamais d'oracle cross-workspace", () => {
  it("B filtré par SA catégorie voit B1 ; A armé du MÊME uuid voit 0 ligne", async () => {
    // Côté B (propriétaire de CAT_B) : le filtre mord normalement.
    const pageB = await liste(sessionB, { categorieId: CAT_B });
    expect(pageB.lignes.map((l) => l.id)).toEqual([B1]);
    const totauxB = await somme(sessionB, { categorieId: CAT_B });
    expect(totauxB).toHaveLength(1);
    expect(totauxB[0]).toMatchObject({
      currency: "MUR",
      sorties: "7777.00",
      nbTransactions: 1,
    });

    // Côté A, armé de l'uuid d'une catégorie du tenant B : 0 ligne et somme [] —
    // la MÊME réponse qu'une catégorie inexistante (aucun oracle d'existence, et
    // la RLS de transaction_categorizations rend le split de B invisible au
    // sous-EXISTS, quelle que soit la forme de la requête).
    const pageA = await liste(sessionA, { categorieId: CAT_B });
    expect(pageA.lignes).toEqual([]);
    expect(await somme(sessionA, { categorieId: CAT_B })).toEqual([]);
  });
});

/**
 * Périmètre intra-groupe (étage 2). ⚠️ HONNÊTETÉ DE LA PREUVE : ce bloc démontre
 * l'ABSENCE DE FUITE (ce qui compte), PAS que `innerJoin(bank_accounts)` en est le
 * mécanisme. Depuis la migration 0017, `transactions_cache` porte elle-même la policy
 * `account_scope`, et `withWorkspace` traduit le scope ENTITÉ d'un membre en liste de
 * COMPTES (GUC `account_scope`) : ces cas resteraient donc VERTS même si la jointure
 * était retirée de l'agrégat. Elle demeure de la défense en profondeur (axe entité) —
 * ne pas conclure de ce vert qu'elle est superflue.
 */
describe("périmètre ENTITÉ (étage 2) — pas de fuite intra-groupe dans un TOTAL", () => {
  it("Carol (Vision Entité, BU Nord) ne totalise QUE les comptes de son périmètre", async () => {
    const totaux = await somme(sessionCarol);

    // ACC_USD appartient à la BU Sud : ses 500 USD d'entrées ne doivent JAMAIS
    // apparaître dans le total de Carol (fuite intra-groupe = grave, même si elle
    // n'est pas cross-client).
    expect(totaux.map((l) => l.currency)).toEqual(["MUR"]);
    expect(totaux[0]).toMatchObject({
      entrees: "1050.00",
      sorties: "500.00",
      net: "550.00",
      nbTransactions: 4,
    });
  });

  it("Alice (Vision Globale, aucun scope) voit, elle, les DEUX entités", async () => {
    // Contre-preuve : sans scope, le périmètre ne filtre rien — c'est bien la présence
    // de `member_entity_scopes` qui borne Carol, pas un hasard de jointure.
    const totaux = await somme(sessionA);
    expect(totaux.map((l) => l.currency)).toEqual(["MUR", "USD"]);
  });
});

describe("contrat de lecture (sommeNetteSchema)", () => {
  it("REJETTE un curseur ou une limite — une somme ne porte pas sur UNE page", async () => {
    // C'est le piège TX-FILTRE1 rendu impossible par le contrat : sommer une page
    // (le seul jeu que le client détient) donnerait un total faux et crédible.
    expect(sommeNetteSchema.safeParse({ curseur: "abc" }).success).toBe(false);
    expect(sommeNetteSchema.safeParse({ limite: 50 }).success).toBe(false);
  });

  it("accepte les MÊMES filtres que la liste", () => {
    const filtres = {
      recherche: "acme",
      bankAccountId: ACC_MUR,
      categorieId: CAT_A,
      statut: "COMPLET" as const,
      dateDebut: "2026-03-01",
      dateFin: "2026-03-31",
    };
    expect(sommeNetteSchema.safeParse(filtres).success).toBe(true);
    expect(listerTransactionsSchema.safeParse(filtres).success).toBe(true);
  });

  it("REJETTE un intervalle inversé (dateDebut > dateFin)", () => {
    expect(
      sommeNetteSchema.safeParse({
        dateDebut: "2026-03-31",
        dateFin: "2026-03-01",
      }).success,
    ).toBe(false);
  });
});

// Contre-preuve R1 : prouve POURQUOI le rôle non-owner est vital POUR CET AGRÉGAT. Sous
// l'owner, la même somme franchit la frontière tenant ; sous tygr_app, non. Si l'app
// pointait sur l'owner (RLS contournée), R1a casserait — l'angle mort devient bloquant.
describe("contre-preuve R1 : c'est la RLS qui protège l'AGRÉGAT, pas un WHERE applicatif", () => {
  afterAll(async () => {
    await client.exec(`set role tygr_app;`); // restaure l'invariant de la suite
  });

  it("R1a. sous l'OWNER, une somme MUR sans contexte agrège les DEUX tenants", async () => {
    await client.exec(`reset role;`);
    const res = await client.query<{ total: string }>(
      `select sum(amount)::text as total from transactions_cache
       where currency = 'MUR' and is_removed = false`,
    );
    // 1550 (A) + 7777 (B) = 9327 → sans RLS, le total de A serait contaminé par B.
    expect(enCentimes(res.rows[0].total)).toBe(BigInt(932700));
  });

  it("R1b. sous tygr_app, le contexte A n'agrège JAMAIS le tenant B", async () => {
    await client.exec(`set role tygr_app;`);
    const totaux = parDevise(await somme(sessionA));
    // Magnitude totale vue par A en MUR = 1050 + 500 = 1550 — le 7777 de B est absent.
    expect(
      enCentimes(totaux.MUR.entrees) + enCentimes(totaux.MUR.sorties),
    ).toBe(BigInt(155000));
  });
});
