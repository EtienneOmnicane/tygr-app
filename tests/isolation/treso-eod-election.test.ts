/**
 * TRESO-EOD-ELECTION — élection EOD depuis `running_balance` (PLAN-treso-eod.md
 * §2.2, cas §7-B E1→E9) sur Postgres réel (PGlite, migrations réelles, rôle
 * `tygr_app` non-propriétaire).
 *
 * Prouve : le regroupement est LOCAL Maurice (E1 — deux instants du MÊME jour UTC
 * élisent DEUX jours comptables), l'ordre est ABSOLU (`booking_date_time DESC`,
 * départage stable `omnifi_txn_id DESC`), les gardes mordent (tombstone, solde
 * nul, devise D_c), l'écriture converge (idempotence + re-dérivation D4), et le
 * périmètre tient aux DEUX étages (tenant + Vision Entité) jusqu'à la lecture
 * consolidée `courbeTresorerieFiable` (report §3, D6-a, drapeau §4.2).
 *
 * Les dates comptables des fixtures sont DÉRIVÉES par `deriverDateComptableMaurice`
 * (E20) — jamais posées à la main : le test épingle la cohérence colonne/instant.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { balanceHistory, transactionsCache } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { deriverSoldesEod } from "@/server/repositories/ingestion";
import {
  courbeTresorerieFiable,
  mouvementsNetsParJour,
} from "@/server/repositories/dashboard";
import { deriverDateComptableMaurice } from "@/server/ingestion/conversion";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111"; // MANAGER A, Vision Globale
const SCOPE1 = "22222222-2222-4222-8222-222222222222"; // membre A borné ENT_1
const BOB = "33333333-3333-4333-8333-333333333333"; // MANAGER B (témoin étage 1)
const ENT_1 = "e0100000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENT_2 = "e0200000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONN_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccb";
const ACC_MUR = "dddd1111-dddd-4ddd-8ddd-dddddddddddd"; // ENT_1, MUR
const ACC_MUR2 = "dddd2222-dddd-4ddd-8ddd-dddddddddddd"; // ENT_2, MUR
const ACC_USD = "dddd3333-dddd-4ddd-8ddd-dddddddddddd"; // ENT_1, USD
const ACC_B = "dddd4444-dddd-4ddd-8ddd-dddddddddddd"; // WS_B, MUR

const sessionAlice = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionScope1 = { userId: SCOPE1, activeWorkspaceId: WS_A };
const sessionBob = { userId: BOB, activeWorkspaceId: WS_B };

/** Fenêtre de lecture des cas E7/E8/E9 (jours comptables Maurice, inclusifs). */
const FENETRE = { from: "2026-07-22", to: "2026-07-27" };

interface FixTx {
  id: string;
  compte: string;
  ws: string;
  booking: string; // instant ISO — transaction_date en est DÉRIVÉE (E20)
  amount: string;
  sens: "Credit" | "Debit";
  currency: string;
  rb: string | null;
  removed?: boolean;
}

/**
 * Fixtures IRRÉGULIÈRES (plan §7, note) : ex æquo, tombstone, solde nul en fin de
 * jour, devise FX, bascule de minuit Maurice — un jeu régulier ne capturerait ni
 * E1, ni E2, ni E6, ni le détecteur. Les `rb` sont VOLONTAIREMENT irréconciliés
 * avec les montants sur plusieurs jours (le drapeau §4.2 doit lever).
 */
const TXS: FixTx[] = [
  // E1 — même jour UTC (22/07), DEUX jours comptables Maurice : 19:59:59Z → J,
  // 20:00:00Z (minuit Maurice) → J+1.
  { id: "eod-t01", compte: ACC_MUR, ws: WS_A, booking: "2026-07-22T19:59:59Z", amount: "500.00", sens: "Credit", currency: "MUR", rb: "100.00" },
  { id: "eod-t02", compte: ACC_MUR, ws: WS_A, booking: "2026-07-22T20:00:00Z", amount: "100.00", sens: "Credit", currency: "MUR", rb: "200.00" },
  { id: "eod-t03", compte: ACC_MUR, ws: WS_A, booking: "2026-07-23T05:00:00Z", amount: "40.00", sens: "Debit", currency: "MUR", rb: "250.00" },
  // E2 — la DERNIÈRE du jour n'a pas de running_balance → l'avant-dernière est élue.
  { id: "eod-t04", compte: ACC_MUR, ws: WS_A, booking: "2026-07-24T03:00:00Z", amount: "50.00", sens: "Credit", currency: "MUR", rb: "300.00" },
  { id: "eod-t05", compte: ACC_MUR, ws: WS_A, booking: "2026-07-24T09:00:00Z", amount: "10.00", sens: "Debit", currency: "MUR", rb: null },
  // E3 — tombstone le plus tardif : exclu de l'élection (mais pas ressuscité ailleurs).
  { id: "eod-t06", compte: ACC_MUR, ws: WS_A, booking: "2026-07-25T03:00:00Z", amount: "20.00", sens: "Credit", currency: "MUR", rb: "400.00" },
  { id: "eod-t07", compte: ACC_MUR, ws: WS_A, booking: "2026-07-25T09:00:00Z", amount: "30.00", sens: "Credit", currency: "MUR", rb: "999.99", removed: true },
  // E4 — ex æquo PARFAIT de booking : départage stable omnifi_txn_id DESC ("…-z" gagne).
  { id: "eod-exaequo-a", compte: ACC_MUR, ws: WS_A, booking: "2026-07-26T05:00:00Z", amount: "5.00", sens: "Credit", currency: "MUR", rb: "510.00" },
  { id: "eod-exaequo-z", compte: ACC_MUR, ws: WS_A, booking: "2026-07-26T05:00:00Z", amount: "5.00", sens: "Credit", currency: "MUR", rb: "500.00" },
  // E6 — transaction FX (USD) sur le compte MUR, PLUS TARDIVE : non élue (garde D_c).
  { id: "eod-t11", compte: ACC_MUR, ws: WS_A, booking: "2026-07-27T05:00:00Z", amount: "10.00", sens: "Debit", currency: "MUR", rb: "600.00" },
  { id: "eod-t10", compte: ACC_MUR, ws: WS_A, booking: "2026-07-27T10:00:00Z", amount: "777.00", sens: "Credit", currency: "USD", rb: "777.77" },
  // E9 — 21h UTC = LENDEMAIN Maurice : l'EOD existe mais tombe HORS fenêtre [.., 27].
  { id: "eod-t12", compte: ACC_MUR, ws: WS_A, booking: "2026-07-27T21:00:00Z", amount: "50.00", sens: "Credit", currency: "MUR", rb: "650.00" },
  // ACC_MUR2 (ENT_2) : historique COURT — D6-a borne le consolidé Globale au 24/07.
  { id: "eod-u01", compte: ACC_MUR2, ws: WS_A, booking: "2026-07-24T05:00:00Z", amount: "1000.00", sens: "Credit", currency: "MUR", rb: "1000.00" },
  // ACC_USD (ENT_1) : série USD indépendante (E7).
  { id: "eod-v01", compte: ACC_USD, ws: WS_A, booking: "2026-07-23T05:00:00Z", amount: "50.00", sens: "Credit", currency: "USD", rb: "50.00" },
  // WS_B : témoin étage 1 (jamais visible depuis A).
  { id: "eod-b01", compte: ACC_B, ws: WS_B, booking: "2026-07-22T05:00:00Z", amount: "9999.00", sens: "Credit", currency: "MUR", rb: "9999.00" },
];

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
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ALICE}','alice@a.mu','Alice'),
      ('${SCOPE1}','scope1@a.mu','Scopé Un'),
      ('${BOB}','bob@b.mu','Bob');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}','${WS_A}','MANAGER'),
      ('${SCOPE1}','${WS_A}','MANAGER'),
      ('${BOB}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name) values
      ('${ENT_1}','${WS_A}','BU Un'),
      ('${ENT_2}','${WS_A}','BU Deux');
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${SCOPE1}','${ENT_1}');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ALICE}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, is_selected, entity_id) values
      ('${ACC_MUR}','${WS_A}','${CONN_A}','oa-mur','Courant MUR','MUR',true,'${ENT_1}'),
      ('${ACC_MUR2}','${WS_A}','${CONN_A}','oa-mur2','Courant MUR 2','MUR',true,'${ENT_2}'),
      ('${ACC_USD}','${WS_A}','${CONN_A}','oa-usd','Devise USD','USD',true,'${ENT_1}'),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR',true,null);
  `);

  // Transactions : transaction_date DÉRIVÉE de l'instant (E20), jamais posée à la main.
  const values = TXS.map((t) => {
    const dateMaurice = deriverDateComptableMaurice(t.booking);
    return `('${t.ws}','${t.compte}','${t.id}','${dateMaurice}','${t.booking}',${t.amount},'${t.currency}','${t.sens}',${t.rb === null ? "null" : t.rb},${t.removed ? "true" : "false"})`;
  }).join(",\n      ");
  await client.exec(`
    insert into transactions_cache
      (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, running_balance, is_removed)
    values
      ${values};
  `);

  const provisioning = readFileSync(
    path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
    "utf8",
  );
  await client.exec(provisioning);
  await client.exec(`set role tygr_app;`);

  // Dérivation sous le rôle applicatif, chacun DANS son tenant (Vision Globale —
  // le chemin réel : la sync tourne toujours en Globale).
  await withWorkspace(sessionAlice, async (tx, ctx) => {
    await deriverSoldesEod(tx, ctx, ACC_MUR);
    await deriverSoldesEod(tx, ctx, ACC_MUR2);
    await deriverSoldesEod(tx, ctx, ACC_USD);
  });
  await withWorkspace(sessionBob, (tx, ctx) => deriverSoldesEod(tx, ctx, ACC_B));
});

afterAll(async () => {
  await client.close();
});

/** EOD élus d'un compte, lus sous la session donnée (map date → solde). */
async function eodsDuCompte(
  session: typeof sessionAlice,
  compteId: string,
): Promise<Map<string, string>> {
  const lignes = await withWorkspace(session, (tx) =>
    tx
      .select({ date: balanceHistory.balanceDate, solde: balanceHistory.balance })
      .from(balanceHistory)
      .where(eq(balanceHistory.bankAccountId, compteId))
      .orderBy(balanceHistory.balanceDate),
  );
  return new Map(lignes.map((l) => [l.date, l.solde]));
}

describe("élection EOD — §2.2 (E1 → E6)", () => {
  it("E1 : deux instants du MÊME jour UTC → DEUX jours comptables Maurice distincts", async () => {
    const eods = await eodsDuCompte(sessionAlice, ACC_MUR);
    // 19:59:59Z reste le 22 ; 20:00:00Z (minuit Maurice) bascule au 23. Une
    // agrégation en jour UTC fusionnerait les deux (ce test la condamne).
    expect(eods.get("2026-07-22")).toBe("100.00");
    expect(eods.has("2026-07-23")).toBe(true);
  });

  it("l'instant le plus TARDIF du jour comptable porte la clôture (ordre absolu)", async () => {
    const eods = await eodsDuCompte(sessionAlice, ACC_MUR);
    // Jour Maurice 23/07 = t02 (20:00:00Z la veille UTC) puis t03 (05:00:00Z) :
    // t03 est postérieure → 250.00 (pas 200.00).
    expect(eods.get("2026-07-23")).toBe("250.00");
  });

  it("E2 : dernière transaction du jour SANS running_balance → l'avant-dernière est élue", async () => {
    const eods = await eodsDuCompte(sessionAlice, ACC_MUR);
    expect(eods.get("2026-07-24")).toBe("300.00"); // t05 (null) ignorée
  });

  it("E3 : le tombstone le plus tardif est EXCLU de l'élection", async () => {
    const eods = await eodsDuCompte(sessionAlice, ACC_MUR);
    expect(eods.get("2026-07-25")).toBe("400.00"); // t07 (999.99, is_removed) ignorée
  });

  it("E4 : ex æquo parfait de booking_date_time → départage STABLE (omnifi_txn_id DESC)", async () => {
    const eods = await eodsDuCompte(sessionAlice, ACC_MUR);
    expect(eods.get("2026-07-26")).toBe("500.00"); // "eod-exaequo-z" > "eod-exaequo-a"
  });

  it("E6 : une transaction USD sur le compte MUR n'est JAMAIS élue (garde D_c)", async () => {
    const eods = await eodsDuCompte(sessionAlice, ACC_MUR);
    // t10 (USD, 777.77) est POSTÉRIEURE à t11 (MUR, 600.00) : sans la garde, la
    // série MUR porterait un solde en dollars.
    expect(eods.get("2026-07-27")).toBe("600.00");
    expect([...eods.values()]).not.toContain("777.77");
  });

  it("E9 (écriture) : 21h UTC tombe le LENDEMAIN Maurice — l'EOD existe au 28/07", async () => {
    const eods = await eodsDuCompte(sessionAlice, ACC_MUR);
    expect(eods.get("2026-07-28")).toBe("650.00");
  });
});

describe("mouvements nets par jour — signe via credit_debit, gardes (§4.2)", () => {
  it("somme signée par jour ; tombstone et devise FX exclus", async () => {
    const mvts = await withWorkspace(sessionAlice, (tx) =>
      mouvementsNetsParJour(tx, { to: "2026-07-27" }),
    );
    const duCompte = new Map(
      mvts.filter((m) => m.bankAccountId === ACC_MUR).map((m) => [m.date, m.delta]),
    );
    expect(duCompte.get("2026-07-22")).toBe("500.00"); // +500 Credit
    expect(duCompte.get("2026-07-23")).toBe("60.00"); // +100 − 40
    expect(duCompte.get("2026-07-24")).toBe("40.00"); // +50 − 10 (t05 sans rb COMPTE quand même)
    expect(duCompte.get("2026-07-25")).toBe("20.00"); // t07 tombstone exclue
    expect(duCompte.get("2026-07-27")).toBe("-10.00"); // t10 (USD) exclue — sinon +767.00
  });
});

describe("lecture consolidée — report §3, D6-a, drapeau, fenêtre (E7/E9)", () => {
  it("E7 + D6-a (Globale) : une série PAR devise ; le consolidé MUR démarre quand TOUS ses comptes ont un EOD", async () => {
    const pts = await withWorkspace(sessionAlice, (tx) =>
      courbeTresorerieFiable(tx, FENETRE),
    );
    const mur = pts.filter((p) => p.currency === "MUR");
    const usd = pts.filter((p) => p.currency === "USD");
    // MUR : ACC_MUR démarre le 22, ACC_MUR2 le 24 → bord gauche D6-a = 24 (aucune
    // marche muette les 22-23).
    expect(mur.map((p) => p.date)).toEqual([
      "2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27",
    ]);
    expect(mur.map((p) => p.soldeConsolide)).toEqual([
      "1300.00", "1400.00", "1500.00", "1600.00",
    ]);
    // USD : série indépendante (report du seul point v01) — jamais sommée à MUR.
    expect(usd.map((p) => p.soldeConsolide)).toEqual([
      "50.00", "50.00", "50.00", "50.00", "50.00",
    ]);
    expect(pts.some((p) => p.soldeConsolide === "1650.00")).toBe(false); // pas de MUR+USD
  });

  it("drapeau §4.2 : un jour irréconcilié rend le consolidé douteux ; une série NON_EVALUABLE reste fiable", async () => {
    const pts = await withWorkspace(sessionAlice, (tx) =>
      courbeTresorerieFiable(tx, FENETRE),
    );
    // ACC_MUR 24/07 : Δ_observé = 300−250 = 50 ≠ Δ_attendu = +40 (t05 sans solde
    // mais mouvement réel) → INCOMPLET → le point consolidé est douteux. C'est le
    // mode de défaillance §4.1 rendu VISIBLE (plausible, unique, non nul et faux).
    expect(pts.find((p) => p.currency === "MUR" && p.date === "2026-07-24")?.fiable).toBe(false);
    // USD : un seul EOD (premier → NON_EVALUABLE §4.3) reporté — pas de faux drapeau.
    expect(pts.filter((p) => p.currency === "USD").every((p) => p.fiable)).toBe(true);
  });

  it("E9 (lecture) : l'EOD du lendemain Maurice reste HORS fenêtre bornée à aujourd'hui", async () => {
    const pts = await withWorkspace(sessionAlice, (tx) =>
      courbeTresorerieFiable(tx, FENETRE),
    );
    expect(pts.some((p) => p.date === "2026-07-28")).toBe(false);
    expect(pts.some((p) => p.soldeConsolide === "650.00")).toBe(false);
    // Élargir la fenêtre au 28 fait apparaître le point (1000 + 650).
    const plus = await withWorkspace(sessionAlice, (tx) =>
      courbeTresorerieFiable(tx, { from: "2026-07-22", to: "2026-07-28" }),
    );
    expect(
      plus.find((p) => p.currency === "MUR" && p.date === "2026-07-28")?.soldeConsolide,
    ).toBe("1650.00");
  });
});

describe("périmètre — étage 1 (tenant) et étage 2 (Vision Entité) (E8)", () => {
  it("E8a : rien ne fuit entre tenants, dans les DEUX sens", async () => {
    const ptsA = await withWorkspace(sessionAlice, (tx) =>
      courbeTresorerieFiable(tx, FENETRE),
    );
    expect(ptsA.some((p) => p.soldeConsolide.includes("9999"))).toBe(false);
    const ptsB = await withWorkspace(sessionBob, (tx) =>
      courbeTresorerieFiable(tx, FENETRE),
    );
    // B ne voit QUE sa série (9999 reporté sur toute la fenêtre), jamais celles de A.
    expect(new Set(ptsB.map((p) => p.soldeConsolide))).toEqual(new Set(["9999.00"]));
  });

  it("E8a-bis : dériver depuis B en visant un compte de A n'écrit RIEN (RLS fail-closed)", async () => {
    await withWorkspace(sessionBob, (tx, ctx) => deriverSoldesEod(tx, ctx, ACC_MUR));
    const chezB = await withWorkspace(sessionBob, (tx) =>
      tx.select().from(balanceHistory),
    );
    expect(chezB).toHaveLength(1); // uniquement l'EOD de ACC_B — rien d'injecté
    const eodsA = await eodsDuCompte(sessionAlice, ACC_MUR);
    expect(eodsA.size).toBe(7); // 22→28 : inchangé côté A
  });

  it("E8b : en Vision Entité, la courbe ne consolide QUE le périmètre (ACC_MUR2 invisible)", async () => {
    const pts = await withWorkspace(sessionScope1, (tx) =>
      courbeTresorerieFiable(tx, FENETRE),
    );
    const mur = pts.filter((p) => p.currency === "MUR");
    // Le compte ENT_2 est masqué par la RLS → la série MUR du membre borné est
    // CELLE d'ACC_MUR seul : démarre au 22 (D6-a sur le périmètre VISIBLE), et le
    // 24 vaut 300.00 — jamais le 1300.00 de la Vision Globale.
    expect(mur.map((p) => p.date)[0]).toBe("2026-07-22");
    expect(mur.find((p) => p.date === "2026-07-24")?.soldeConsolide).toBe("300.00");
    expect(pts.some((p) => p.soldeConsolide === "1300.00")).toBe(false);
  });
});

describe("idempotence & convergence (E5, D4)", () => {
  it("E5 : re-dériver sur donnée INCHANGÉE ⇒ mêmes valeurs, aucune ligne dupliquée (PK)", async () => {
    const avant = await eodsDuCompte(sessionAlice, ACC_MUR);
    await withWorkspace(sessionAlice, (tx, ctx) => deriverSoldesEod(tx, ctx, ACC_MUR));
    const apres = await eodsDuCompte(sessionAlice, ACC_MUR);
    expect(apres).toEqual(avant);
    expect(apres.size).toBe(7);
  });

  it("D4 : une passe ultérieure plus complète CORRIGE l'EOD du jour (UPDATE, jamais DELETE)", async () => {
    // Passe 2 : l'amont ré-affine le solde de t04 (le jour 24/07 était faux d'un
    // mouvement — mode §4.1). La re-dérivation ÉCRASE la valeur du jour.
    await withWorkspace(sessionAlice, (tx) =>
      tx
        .update(transactionsCache)
        .set({ runningBalance: "290.00" })
        .where(eq(transactionsCache.omnifiTxnId, "eod-t04")),
    );
    await withWorkspace(sessionAlice, (tx, ctx) => deriverSoldesEod(tx, ctx, ACC_MUR));
    const eods = await eodsDuCompte(sessionAlice, ACC_MUR);
    expect(eods.get("2026-07-24")).toBe("290.00");
    expect(eods.size).toBe(7); // toujours 7 jours — corrigé en place
  });
});
