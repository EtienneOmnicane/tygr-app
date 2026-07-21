/**
 * Suite anti-IDOR + justesse — Répartition par catégorie (camembert, chantier
 * Graphiques). Prouve sur Postgres réel (PGlite) que `repartitionParCategorie` :
 *  1. ne renvoie QUE les données du workspace courant (RLS tenant_isolation) — un
 *     workspace ne voit jamais les catégories d'un autre (anti-IDOR, règle 2) ;
 *  2. agrège par catégorie ET PAR DEVISE, sans addition cross-devise (règle 8) : le
 *     `total` et `part` sont relatifs à la devise (part ∈ [0,1], somme = 1) ;
 *  3. exclut les tombstones (is_removed) ;
 *  4. replie `primary_category` NULL, '' **ou** sentinelle Omni-FI (« UNCLASSIFIED »,
 *     « Uncategorized », insensible casse+espaces) sur un poste « Non catégorisé »
 *     (estNonCategorise=true), TOUJOURS trié en dernier, même quand leur montant
 *     cumulé dépasse une vraie catégorie ;
 *  5. sépare les sens (inflow=Credit, outflow=Debit) — un donut ne mélange pas les deux ;
 *  6. respecte la borne haute INCLUSIVE (transaction le jour `to` comptée) ;
 *  7. valide ses paramètres en profondeur (sens, dates calendaires, from ≤ to, et la
 *     paire de bornes précédentes ensemble ou pas du tout) ;
 *  8. expose `montantMoyen` par devise (total/nb, EN SQL — L2) ;
 *  9. renseigne `montantPrecedent` par part depuis la fenêtre précédente (L4) via une
 *     2e requête séparée : « 0.00 » pour une catégorie absente avant (→ « nouveau »).
 *
 * Rôle tygr_app NON-propriétaire (sinon la RLS est ignorée). Même squelette de seed
 * que insights-isolation.test.ts (migrations → seed owner → provisioning → set role).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  InsightsParamsInvalidesError,
  repartitionParCategorie,
} from "@/server/repositories/insights";
import type { SensFlux } from "@/server/insights/types";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ACC_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_A_USD = "aaaa3333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACC_B = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONN_A = "aaaacccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "bbbbcccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

const JUIN = { from: "2026-06-01", to: "2026-06-30" } as const;
// Fenêtre PRÉCÉDENTE de juin (L4) : mai, baseline de `montantPrecedent`.
const MAI = { from: "2026-05-01", to: "2026-05-31" } as const;

beforeAll(async () => {
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // WS_A : comptes MUR + USD (multi-devise). WS_B : MUR (témoin d'isolation).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','A','INTERNAL_BU','eu-a'), ('${WS_B}','B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ALICE}','a@g.mu','A'), ('${BOB}','b@g.mu','B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}','${WS_A}','MANAGER'), ('${BOB}','${WS_B}','MANAGER');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ALICE}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected) values
      ('${ACC_A}','${WS_A}','${CONN_A}','oa-a','Compte A','MUR','5000.00',true),
      ('${ACC_A_USD}','${WS_A}','${CONN_A}','oa-a-usd','Compte A USD','USD','800.00',true),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true);
    -- ⚠️ primary_category porte des clés OBIE **ANGLAISES** — c'est ce que l'amont
    -- Omni-FI émet réellement (sonde runtime 2026-06-23, cf. src/lib/categories-fr.ts).
    -- Depuis le Lot 0, le donut les TRADUIT dans son GROUP BY : les assertions portent
    -- donc sur les libellés FR. Une fixture en français ne prouverait rien (elle sortirait
    -- entièrement en « Non catégorisé », clés non cartographiées).
    --
    -- WS_A MUR SORTIES : rent 300 (05) + rent 200 (20) = « Loyer » 500 ;
    --   utilities 150 (08) = « Charges » ; NULL 150 (12) + '' 100 (15) =
    --   « Non catégorisé » 250 (repli + collapse) ; tombstone rent 99 (08) EXCLU.
    --   Total sorties MUR = 900 (nb 5).
    -- WS_A MUR ENTRÉES : income 1000 (05) = « Revenus », other 250 (06) = « Autres ».
    --   Total entrées MUR 1250.
    -- WS_A USD SORTIES : bank charges 200 (09) = « Frais bancaires » — une seule
    --   catégorie (anneau plein côté UI).
    -- WS_B MUR SORTIES : healthcare 7777 (05) = « Santé » — ne doit JAMAIS fuiter chez A.
    -- WS_A MAI SORTIES (fenêtre PRÉCÉDENTE, L4) : rent 400 (10) = « Loyer » ; trois
    --   SENTINELLES Omni-FI collapsées en « Non catégorisé » 250 — 'UNCLASSIFIED' 150
    --   (12), 'Uncategorized' 60 (15), '  unclassified  ' 40 (18) : prouve le repli
    --   insensible casse+espaces. Total MAI MUR = 650 (nb 4). Pas de « Charges » en mai
    --   (→ « Charges » = « nouveau » en juin). Sert de baseline montantPrecedent.
    --
    -- JUILLET (Lot 0, fenêtre DÉDIÉE — n'interfère avec aucune assertion ci-dessus) :
    -- WS_A MUR ENTRÉES : income 600 (03) + revenue 400 (04) + 'Income' 100 (05) →
    --   trois clés OBIE distinctes, UN seul libellé « Revenus » 1100 (nb 3). Prouve la
    --   fusion MANY-TO-ONE en SQL **et** l'insensibilité à la casse.
    -- WS_A MUR SORTIES : rent 700 (03) = « Loyer » ; 'crypto-mining' 300 (04) (clé HORS
    --   catalogue) + NULL 200 (05) → « Non catégorisé » 500 (nb 2). Total 1200 (nb 3).
    insert into transactions_cache (workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, clean_label, primary_category, is_removed) values
      ('${WS_A}','${ACC_A}','txa-in1','2026-06-05','2026-06-05T05:30:00Z','1000.00','MUR','Credit','VIR','Client A','income',false),
      ('${WS_A}','${ACC_A}','txa-in2','2026-06-06','2026-06-06T05:30:00Z','250.00','MUR','Credit','SUBV','État','other',false),
      ('${WS_A}','${ACC_A}','txa-o1','2026-06-05','2026-06-05T05:30:00Z','300.00','MUR','Debit','LOYER','Bailleur','rent',false),
      ('${WS_A}','${ACC_A}','txa-o2','2026-06-20','2026-06-20T05:30:00Z','200.00','MUR','Debit','LOYER C','Bailleur','rent',false),
      ('${WS_A}','${ACC_A}','txa-o3','2026-06-08','2026-06-08T05:30:00Z','150.00','MUR','Debit','CEB','CEB','utilities',false),
      ('${WS_A}','${ACC_A}','txa-o4','2026-06-12','2026-06-12T05:30:00Z','150.00','MUR','Debit','DIVERS',null,null,false),
      ('${WS_A}','${ACC_A}','txa-o5','2026-06-15','2026-06-15T05:30:00Z','100.00','MUR','Debit','DIVERS 2',null,'',false),
      ('${WS_A}','${ACC_A}','txa-tomb','2026-06-08','2026-06-08T05:30:00Z','99.00','MUR','Debit','SUPPR','X','rent',true),
      ('${WS_A}','${ACC_A_USD}','txa-usd1','2026-06-09','2026-06-09T05:30:00Z','200.00','USD','Debit','FEES','Bank fees','bank charges',false),
      ('${WS_A}','${ACC_A}','txa-mai1','2026-05-10','2026-05-10T05:30:00Z','400.00','MUR','Debit','LOYER MAI','Bailleur','rent',false),
      ('${WS_A}','${ACC_A}','txa-mai2','2026-05-12','2026-05-12T05:30:00Z','150.00','MUR','Debit','DIVERS MAI','X','UNCLASSIFIED',false),
      ('${WS_A}','${ACC_A}','txa-mai3','2026-05-15','2026-05-15T05:30:00Z','60.00','MUR','Debit','DIVERS MAI 2','Y','Uncategorized',false),
      ('${WS_A}','${ACC_A}','txa-mai4','2026-05-18','2026-05-18T05:30:00Z','40.00','MUR','Debit','DIVERS MAI 3','Z','  unclassified  ',false),
      ('${WS_A}','${ACC_A}','txa-jui1','2026-07-03','2026-07-03T05:30:00Z','600.00','MUR','Credit','VTE 1','Client','income',false),
      ('${WS_A}','${ACC_A}','txa-jui2','2026-07-04','2026-07-04T05:30:00Z','400.00','MUR','Credit','VTE 2','Client','revenue',false),
      ('${WS_A}','${ACC_A}','txa-jui3','2026-07-05','2026-07-05T05:30:00Z','100.00','MUR','Credit','VTE 3','Client','Income',false),
      ('${WS_A}','${ACC_A}','txa-jui4','2026-07-03','2026-07-03T05:30:00Z','700.00','MUR','Debit','LOYER JUI','Bailleur','rent',false),
      ('${WS_A}','${ACC_A}','txa-jui5','2026-07-04','2026-07-04T05:30:00Z','300.00','MUR','Debit','CRYPTO','X','crypto-mining',false),
      ('${WS_A}','${ACC_A}','txa-jui6','2026-07-05','2026-07-05T05:30:00Z','200.00','MUR','Debit','DIVERS JUI','Y',null,false),
      ('${WS_B}','${ACC_B}','txb1','2026-06-05','2026-06-05T05:30:00Z','7777.00','MUR','Debit','SECRET B','Secret B','healthcare',false);
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

describe("repartitionParCategorie — agrégat par catégorie/devise + isolation", () => {
  it("WS_A sorties : MUR (Loyer 500 / Charges 150 / Non catégorisé 250) + USD (Frais bancaires 200), sans addition cross-devise", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...JUIN }),
    );
    expect(rep.sens).toBe("outflow");

    // Exactement deux devises, JAMAIS fusionnées.
    expect(rep.devises.map((d) => d.currency).sort()).toEqual(["MUR", "USD"]);

    const mur = rep.devises.find((d) => d.currency === "MUR");
    expect(mur?.total).toBe("900.00"); // 500 + 150 + 250, tombstone 99 exclu
    expect(mur?.nbTransactions).toBe(5); // 2 rent + 1 utilities + 2 non-cat
    // L2 — moyenne / opération de LA devise = total / nb (EN SQL) : 900 / 5 = 180.00.
    expect(mur?.montantMoyen).toBe("180.00");

    // Ordre : montant décroissant, « Non catégorisé » TOUJOURS en dernier (250 > 150
    // mais repoussé après Charges — preuve du tri estNonCategorise-last).
    expect(mur?.parts.map((p) => p.categorie)).toEqual([
      "Loyer",
      "Charges",
      "Non catégorisé",
    ]);

    const loyer = mur?.parts[0];
    expect(loyer?.montant).toBe("500.00");
    expect(loyer?.nbTransactions).toBe(2);
    expect(loyer?.estNonCategorise).toBe(false);
    expect(Number(loyer?.part)).toBeCloseTo(500 / 900, 6);

    const nonCat = mur?.parts[2];
    expect(nonCat?.estNonCategorise).toBe(true); // NULL + '' repliés/collapsés
    expect(nonCat?.montant).toBe("250.00");
    expect(nonCat?.nbTransactions).toBe(2);
    expect(Number(nonCat?.part)).toBeCloseTo(250 / 900, 6);

    // Les parts d'une devise somment à 1 (fraction relative à SA devise).
    const sommeMur = (mur?.parts ?? []).reduce((s, p) => s + Number(p.part), 0);
    expect(sommeMur).toBeCloseTo(1, 6);

    const usd = rep.devises.find((d) => d.currency === "USD");
    expect(usd?.total).toBe("200.00");
    expect(usd?.montantMoyen).toBe("200.00"); // 200 / 1 op
    expect(usd?.parts).toHaveLength(1);
    expect(usd?.parts[0].categorie).toBe("Frais bancaires");
    expect(Number(usd?.parts[0].part)).toBeCloseTo(1, 6); // seule catégorie USD

    // Sans fenêtre précédente demandée, `montantPrecedent` retombe sur « 0.00 ».
    expect(mur?.parts.every((p) => p.montantPrecedent === "0.00")).toBe(true);
  });

  it("SENTINELLES Omni-FI : 'UNCLASSIFIED' / 'Uncategorized' / '  unclassified  ' collapsent en « Non catégorisé » (mai)", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...MAI }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");
    // Un SEUL poste non-catégorisé regroupant les 3 sentinelles (casse/espaces ignorés).
    expect(mur?.parts.map((p) => p.categorie)).toEqual(["Loyer", "Non catégorisé"]);
    expect(mur?.total).toBe("650.00"); // 400 + 250
    expect(mur?.montantMoyen).toBe("162.50"); // 650 / 4 op

    const nonCat = mur?.parts.find((p) => p.estNonCategorise);
    expect(nonCat?.montant).toBe("250.00"); // 150 + 60 + 40
    expect(nonCat?.nbTransactions).toBe(3); // les 3 sentinelles fusionnées
    // Aucune sentinelle brute ne fuit en libellé (repli FR appliqué).
    expect(
      mur?.parts.some((p) => /unclassified|uncategorized/i.test(p.categorie)),
    ).toBe(false);
  });

  it("L4 montantPrecedent : juin comparé à mai (Loyer 400, Charges « nouveau », Non catégorisé 250)", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, {
        sens: "outflow",
        ...JUIN,
        fromPrecedent: MAI.from,
        toPrecedent: MAI.to,
      }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");
    expect(rep.fromPrecedent).toBe("2026-05-01");
    expect(rep.toPrecedent).toBe("2026-05-31");

    const parNom = new Map(mur?.parts.map((p) => [p.categorie, p]));
    // Loyer existait en mai (400) → montantPrecedent recopié tel quel.
    expect(parNom.get("Loyer")?.montantPrecedent).toBe("400.00");
    // « Charges » ABSENTE en mai → « 0.00 » (l'UI en fera un « nouveau »).
    expect(parNom.get("Charges")?.montantPrecedent).toBe("0.00");
    // Non catégorisé : 250 en mai (sentinelles) ↔ 250 en juin (NULL/'') — merge par label.
    expect(parNom.get("Non catégorisé")?.montantPrecedent).toBe("250.00");

    // La requête précédente NE contamine PAS le donut courant (montants juin intacts).
    expect(mur?.total).toBe("900.00");
    expect(parNom.get("Loyer")?.montant).toBe("500.00");
  });

  it("rejette une paire de bornes précédentes incomplète (XOR interdit)", async () => {
    await expect(
      withWorkspace(sessionA, (tx) =>
        repartitionParCategorie(tx, {
          sens: "outflow",
          ...JUIN,
          fromPrecedent: MAI.from, // toPrecedent manquant → XOR
        }),
      ),
    ).rejects.toBeInstanceOf(InsightsParamsInvalidesError);
  });

  it("WS_A entrées : sépare les crédits (Revenus 1000, Autres 250) — jamais de débit", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "inflow", ...JUIN }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");
    expect(mur?.total).toBe("1250.00");
    expect(mur?.parts.map((p) => p.categorie)).toEqual(["Revenus", "Autres"]);
    // Aucune catégorie de sortie (Loyer/Charges) ne doit apparaître côté entrées.
    expect(mur?.parts.some((p) => p.categorie === "Loyer")).toBe(false);
    // Pas de devise USD (aucun crédit USD dans la fenêtre).
    expect(rep.devises.some((d) => d.currency === "USD")).toBe(false);
  });

  it("ISOLATION : WS_B ne voit que « Santé » (7777), jamais les catégories de A", async () => {
    const rep = await withWorkspace(sessionB, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...JUIN }),
    );
    expect(rep.devises.map((d) => d.currency)).toEqual(["MUR"]);
    expect(rep.devises[0].parts.map((p) => p.categorie)).toEqual(["Santé"]);
    expect(rep.devises[0].total).toBe("7777.00");
    expect(
      rep.devises[0].parts.some((p) => p.categorie === "Loyer"),
    ).toBe(false);
  });

  it("borne haute INCLUSIVE : une transaction le jour `to` est comptée", async () => {
    // to = 2026-06-05 → doit inclure le débit Loyer 300 de ce jour (et exclure le
    // crédit du même jour, sens outflow).
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, {
        sens: "outflow",
        from: "2026-06-05",
        to: "2026-06-05",
      }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");
    expect(mur?.total).toBe("300.00");
    expect(mur?.parts.map((p) => p.categorie)).toEqual(["Loyer"]);
  });

  it("fenêtre sans transaction → aucune devise (jamais null, pas de 0 fabriqué)", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, {
        sens: "outflow",
        from: "2020-01-01",
        to: "2020-01-31",
      }),
    );
    expect(rep.devises).toEqual([]);
  });

  it("rejette un sens invalide (défense en profondeur repository)", async () => {
    await expect(
      withWorkspace(sessionA, (tx) =>
        repartitionParCategorie(tx, {
          sens: "both" as unknown as SensFlux,
          ...JUIN,
        }),
      ),
    ).rejects.toBeInstanceOf(InsightsParamsInvalidesError);
  });

  it("rejette une date calendaire invalide", async () => {
    await expect(
      withWorkspace(sessionA, (tx) =>
        repartitionParCategorie(tx, {
          sens: "outflow",
          from: "2026-13-01",
          to: "2026-06-30",
        }),
      ),
    ).rejects.toBeInstanceOf(InsightsParamsInvalidesError);
  });

  it("rejette from > to", async () => {
    await expect(
      withWorkspace(sessionA, (tx) =>
        repartitionParCategorie(tx, {
          sens: "outflow",
          from: "2026-06-30",
          to: "2026-06-01",
        }),
      ),
    ).rejects.toBeInstanceOf(InsightsParamsInvalidesError);
  });
});

// ── Garde-fou L7a : la suite tourne-t-elle vraiment sous tygr_app ? ───────────
describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app, pas sous l'owner (sinon la RLS est ignorée)", async () => {
    await client.exec(`set role tygr_app;`);
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
  });
});

// Contre-preuve R1 : prouve POURQUOI le rôle non-owner est vital. Sous l'owner la
// frontière tenant ne filtre pas ; sous tygr_app elle filtre.
describe("contre-preuve R1 : la RLS NE protège PAS sous le propriétaire", () => {
  afterAll(async () => {
    await client.exec(`set role tygr_app;`);
  });

  it("R1a. sous l'owner, un SELECT sans contexte voit l'AUTRE tenant (RLS ignorée)", async () => {
    await client.exec(`reset role;`);
    const res = await client.query<{ workspace_id: string }>(
      "select workspace_id from transactions_cache",
    );
    expect(res.rows.some((r) => r.workspace_id === WS_B)).toBe(true);
  });

  it("R1b. sous tygr_app, le contexte A ne voit JAMAIS le tenant B (la RLS filtre)", async () => {
    await client.exec(`set role tygr_app;`);
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...JUIN }),
    );
    const toutesCategories = rep.devises.flatMap((d) =>
      d.parts.map((p) => p.categorie),
    );
    expect(toutesCategories).not.toContain("Santé");
  });
});
