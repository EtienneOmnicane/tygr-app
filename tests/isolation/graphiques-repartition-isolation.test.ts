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

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  axeCategorieEffective,
  InsightsParamsInvalidesError,
  repartitionParCategorie,
} from "@/server/repositories/insights";
// I1 compare l'agrégat du donut au KPI « Sorties » RÉELLEMENT affiché sur le dashboard
// (Q5) — un autre chemin de calcul, sans aucun split : l'auto-cohérence ne suffit pas.
import { synthesePeriodeParDevise } from "@/server/repositories/dashboard";
import type { SensFlux } from "@/server/insights/types";
import { caseCategorieFr } from "@/server/insights/categorie-fr-sql";
import { categorieFr, CORRESPONDANCE_FR } from "@/lib/categories-fr";

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

// ── Lot 1/2 — fixtures de l'AXE EFFECTIF (fenêtre AOÛT, cf. bloc de seed) ────────
// Catégories TYGR de WS_A. « Loyer » est VOLONTAIREMENT homonyme du libellé FR de la
// catégorie amont `rent` : les deux ne doivent JAMAIS fusionner (espaces de noms).
const CAT_CHARGES = "ca000000-0000-4000-8000-000000000001"; // racine (Nature)
const CAT_LOYER = "ca000000-0000-4000-8000-000000000002"; // feuille sous CAT_CHARGES
const CAT_FOURN = "ca000000-0000-4000-8000-000000000003"; // racine
const CAT_SALAIRES = "ca000000-0000-4000-8000-000000000004"; // racine
const CAT_B = "cb000000-0000-4000-8000-000000000001"; // catégorie du tenant B
const RULE_A = "fa000000-0000-4000-8000-000000000001";

const TX_PARTIELLE = "a0000001-0000-4000-8000-000000000001";
const TX_3SPLITS = "a0000001-0000-4000-8000-000000000002";
const TX_COMPLETE = "a0000001-0000-4000-8000-000000000003";
const TX_TOMBSTONE = "a0000001-0000-4000-8000-000000000004";
const TX_NUE = "a0000001-0000-4000-8000-000000000005";
const TX_USD = "a0000001-0000-4000-8000-000000000006";
const TX_B = "b0000001-0000-4000-8000-000000000001";
// Fenêtre SEPTEMBRE — ventilation PÉRIMÉE + bornes de fenêtre (cf. seed dédié).
const TX_SURVENT = "a0000001-0000-4000-8000-000000000007";
const TX_SEPT_OK = "a0000001-0000-4000-8000-000000000008";
const TX_SEPT_BORNE = "a0000001-0000-4000-8000-000000000009";
const TX_SEPT_HORS = "a0000001-0000-4000-8000-00000000000a";

const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

const JUIN = { from: "2026-06-01", to: "2026-06-30" } as const;
// Fenêtre PRÉCÉDENTE de juin (L4) : mai, baseline de `montantPrecedent`.
const MAI = { from: "2026-05-01", to: "2026-05-31" } as const;
// Fenêtre DÉDIÉE au Lot 0 (traduction FR) — isolée pour ne perturber aucune assertion
// existante : fusion many-to-one, insensibilité à la casse, repli hors catalogue.
const JUILLET = { from: "2026-07-01", to: "2026-07-31" } as const;
// Fenêtre DÉDIÉE à l'axe effectif (Lots 1-2) — isolée pour ne perturber aucune
// assertion ci-dessus (aucune fixture antérieure ne porte de split).
const AOUT = { from: "2026-08-01", to: "2026-08-31" } as const;
// Fenêtre DÉDIÉE à la ventilation PÉRIMÉE (Σ splits > |montant| après re-sync) et aux
// BORNES de fenêtre — isolée pour ne pas déplacer les totaux d'août.
const SEPTEMBRE = { from: "2026-09-01", to: "2026-09-30" } as const;

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

  // ══ Fixtures ADVERSES de l'axe effectif (Lots 1-2) — fenêtre AOÛT ═══════════════
  //
  // Écrites POUR FAIRE ÉCHOUER une implémentation naïve (leçon
  // `piege-fixture-demo-trop-favorable`) : un jeu 100 % ventilé rendrait I1 et I6 vrais
  // PAR ACCIDENT, et une somme des seuls splits passerait au vert sans rien prouver.
  // Chaque transaction ci-dessous casse une hypothèse simplificatrice précise :
  //
  //   TX_PARTIELLE  1 200, 500 ventilés  → l'inégalité `Σ splits ≤ |montant|` en acte.
  //                 Sommer les splits afficherait 500 pour 1 200 réellement sortis (I1).
  //                 Sa catégorie TYGR « Loyer » est HOMONYME du libellé FR de sa
  //                 catégorie amont `rent` → deux parts « Loyer » qui ne doivent pas
  //                 fusionner (la clé porte l'origine, pas le seul libellé).
  //   TX_3SPLITS      900, 3 lignes (600) → DEUX lignes sur la MÊME catégorie : la part
  //                 « Fournisseurs » agrège 2 lignes mais UNE transaction (D-f / I3).
  //                 Sans `count(distinct)`, la devise compterait 8 lignes au lieu de 4.
  //   TX_COMPLETE     400, 400 ventilés  → COMPLET : doit produire ZÉRO ligne de reste
  //                 (I6, `> 0` strict), sinon une part fantôme à 0,00. Source RULE :
  //                 prouve que la branche splits ne discrimine pas MANUAL/RULE (D-c).
  //   TX_TOMBSTONE  5 000, ventilés, is_removed=true → le split SURVIT au tombstone
  //                 (append-only, aucune cascade). Un `is_removed=false` oublié sur la
  //                 branche splits ferait RÉAPPARAÎTRE 5 000 Rs effacés (I5).
  //   TX_NUE          100, aucun split, primary_category NULL → poste « Non catégorisé ».
  //   TX_USD          300 USD, 100 ventilés → « Fournisseurs » existe dans DEUX devises
  //                 et ne doit jamais s'additionner à travers elles (I2).
  //   TX_B (WS_B)   8 888, ventilés sur une catégorie du tenant B → ne doit JAMAIS
  //                 apparaître chez A, ni l'inverse (I4, étage 1).
  //
  // Totaux AOÛT attendus, WS_A / MUR / sorties : 1200 + 900 + 400 + 100 = 2 600
  // (le tombstone de 5 000 EXCLU), pour 4 transactions distinctes et 8 lignes d'axe.
  await client.exec(`
    insert into categories (id, workspace_id, name, parent_id) values
      ('${CAT_CHARGES}','${WS_A}','Charges d''exploitation', null),
      ('${CAT_LOYER}','${WS_A}','Loyer','${CAT_CHARGES}'),
      ('${CAT_FOURN}','${WS_A}','Fournisseurs', null),
      ('${CAT_SALAIRES}','${WS_A}','Salaires', null),
      ('${CAT_B}','${WS_B}','Catégorie B secrète', null);
    insert into categorization_rules (id, workspace_id, pattern, match_type, category_id, created_by) values
      ('${RULE_A}','${WS_A}','fourn','contains','${CAT_FOURN}','${ALICE}');
    insert into transactions_cache (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, clean_label, primary_category, is_removed) values
      ('${TX_PARTIELLE}','${WS_A}','${ACC_A}','txa-ao1','2026-08-03','2026-08-03T05:30:00Z','1200.00','MUR','Debit','LOYER AOUT','Bailleur','rent',false),
      ('${TX_3SPLITS}','${WS_A}','${ACC_A}','txa-ao2','2026-08-05','2026-08-05T05:30:00Z','900.00','MUR','Debit','CEB AOUT','CEB','utilities',false),
      ('${TX_COMPLETE}','${WS_A}','${ACC_A}','txa-ao3','2026-08-07','2026-08-07T05:30:00Z','400.00','MUR','Debit','RESTO AOUT','Traiteur','food & drink',false),
      ('${TX_TOMBSTONE}','${WS_A}','${ACC_A}','txa-ao4','2026-08-09','2026-08-09T05:30:00Z','5000.00','MUR','Debit','SUPPR AOUT','X','rent',true),
      ('${TX_NUE}','${WS_A}','${ACC_A}','txa-ao5','2026-08-11','2026-08-11T05:30:00Z','100.00','MUR','Debit','DIVERS AOUT','Y',null,false),
      ('${TX_USD}','${WS_A}','${ACC_A_USD}','txa-ao6','2026-08-13','2026-08-13T05:30:00Z','300.00','USD','Debit','FEES AOUT','Bank fees','bank charges',false),
      ('${TX_B}','${WS_B}','${ACC_B}','txb-ao1','2026-08-03','2026-08-03T05:30:00Z','8888.00','MUR','Debit','SECRET B AOUT','Secret B','healthcare',false);
    -- ══ SEPTEMBRE — ventilation PÉRIMÉE + bornes ═══════════════════════════════════
    -- TX_SURVENT reproduit l'état d'APRÈS un re-sync qui RÉTRÉCIT le montant : la
    -- transaction valait 1 200 et avait été ventilée intégralement ; l'amont la corrige
    -- à 900 (ingestion.ts écrase amount et laisse les splits intacts) → Σ splits (1 200)
    -- DÉPASSE |montant| (900). Sans garde, la branche splits émettrait 1 200 pendant que
    -- le reliquat (−300) serait avalé par le filtre > 0 : total 1 200 pour un flux de 900.
    -- TX_SEPT_BORNE tombe le jour to (INCLUS) et TX_SEPT_HORS le lendemain (EXCLU) :
    -- le donut et le KPI dashboard doivent trancher IDENTIQUEMENT (bornes équivalentes).
    insert into transactions_cache (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, clean_label, primary_category, is_removed) values
      ('${TX_SURVENT}','${WS_A}','${ACC_A}','txa-se1','2026-09-03','2026-09-03T05:30:00Z','900.00','MUR','Debit','LOYER CORRIGE','Bailleur','rent',false),
      ('${TX_SEPT_OK}','${WS_A}','${ACC_A}','txa-se2','2026-09-05','2026-09-05T05:30:00Z','500.00','MUR','Debit','CEB SEPT','CEB','utilities',false),
      ('${TX_SEPT_BORNE}','${WS_A}','${ACC_A}','txa-se3','2026-09-30','2026-09-30T05:30:00Z','100.00','MUR','Debit','LOYER 30/09','Bailleur','rent',false),
      ('${TX_SEPT_HORS}','${WS_A}','${ACC_A}','txa-se4','2026-10-01','2026-10-01T05:30:00Z','7000.00','MUR','Debit','HORS FENETRE','Bailleur','rent',false);
    insert into transaction_categorizations (workspace_id, transaction_id, transaction_date, category_id, amount, source, rule_id, created_by) values
      -- PARTIELLE : 500 sur 1 200 → 700 restent à imputer à la catégorie BANCAIRE.
      ('${WS_A}','${TX_PARTIELLE}','2026-08-03','${CAT_LOYER}','500.00','MANUAL',null,'${ALICE}'),
      -- 3 splits dont DEUX sur CAT_FOURN (légal : l'unicité (txn, catégorie) n'est pas
      -- contrainte en base, cf. §8 du plan) → 350 pour UNE transaction.
      ('${WS_A}','${TX_3SPLITS}','2026-08-05','${CAT_FOURN}','200.00','MANUAL',null,'${ALICE}'),
      ('${WS_A}','${TX_3SPLITS}','2026-08-05','${CAT_FOURN}','150.00','MANUAL',null,'${ALICE}'),
      ('${WS_A}','${TX_3SPLITS}','2026-08-05','${CAT_SALAIRES}','250.00','MANUAL',null,'${ALICE}'),
      -- COMPLET (400 = 400) et posé par une RÈGLE, pas à la main.
      ('${WS_A}','${TX_COMPLETE}','2026-08-07','${CAT_FOURN}','400.00','RULE','${RULE_A}','${ALICE}'),
      -- Le split d'une transaction TOMBSTONÉE : il existe toujours en base.
      ('${WS_A}','${TX_TOMBSTONE}','2026-08-09','${CAT_LOYER}','2000.00','MANUAL',null,'${ALICE}'),
      -- USD : « Fournisseurs » dans une SECONDE devise (I2).
      ('${WS_A}','${TX_USD}','2026-08-13','${CAT_FOURN}','100.00','MANUAL',null,'${ALICE}'),
      -- Tenant B (I4).
      ('${WS_B}','${TX_B}','2026-08-03','${CAT_B}','8888.00','MANUAL',null,'${BOB}'),
      -- PÉRIMÉ : 1 200 ventilés sur une transaction qui n'en vaut plus que 900.
      ('${WS_A}','${TX_SURVENT}','2026-09-03','${CAT_LOYER}','1200.00','MANUAL',null,'${ALICE}'),
      -- Voisine SAINE : prouve que la garde de péremption ne déborde pas sur les autres.
      ('${WS_A}','${TX_SEPT_OK}','2026-09-05','${CAT_FOURN}','200.00','MANUAL',null,'${ALICE}');
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

  // ── Lot 0 — traduction FR dans le GROUP BY (D-d) ────────────────────────────────
  // Ces cas prouvent que la traduction est un GROUPEMENT, pas un relabel d'affichage :
  // s'ils passaient avec une traduction faite au rendu, la fusion serait impossible sans
  // additionner des montants côté JS (interdit, règle 8).

  it("LOT 0 — aucun libellé OBIE anglais ne subsiste dans la sortie (juin, 2 sens)", async () => {
    const [sorties, entrees] = await withWorkspace(sessionA, async (tx) => [
      await repartitionParCategorie(tx, { sens: "outflow", ...JUIN }),
      await repartitionParCategorie(tx, { sens: "inflow", ...JUIN }),
    ]);
    const libelles = [...sorties.devises, ...entrees.devises].flatMap((d) =>
      d.parts.map((p) => p.categorie),
    );
    // Les clés OBIE brutes présentes en fixture ne doivent JAMAIS ressortir telles quelles.
    for (const cleObie of ["rent", "utilities", "income", "other", "bank charges"]) {
      expect(libelles).not.toContain(cleObie);
    }
    // …et les libellés FR attendus sont bien là (assertion positive : sans elle, un
    // repli global en « Non catégorisé » passerait le test ci-dessus).
    expect(libelles).toEqual(
      expect.arrayContaining(["Loyer", "Charges", "Frais bancaires", "Revenus"]),
    );
  });

  it("LOT 0 — FUSION many-to-one : income + revenue + 'Income' → UN seul secteur « Revenus », sommé EN SQL", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "inflow", ...JUILLET }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");

    // LE cœur du Lot 0 : trois clés OBIE distinctes (dont une de casse différente)
    // n'exposent qu'UN poste. Deux secteurs homonymes seraient le défaut à éviter.
    expect(mur?.parts).toHaveLength(1);
    const revenus = mur?.parts[0];
    expect(revenus?.categorie).toBe("Revenus");
    // 600 + 400 + 100 : la somme est faite par le sum() SQL, jamais côté JS.
    expect(revenus?.montant).toBe("1100.00");
    expect(revenus?.nbTransactions).toBe(3);
    expect(revenus?.estNonCategorise).toBe(false);
    // Seule catégorie de la devise → part = 1 (et non trois parts d'un tiers chacune).
    expect(Number(revenus?.part)).toBeCloseTo(1, 6);

    // Contre-preuve de la fusion : sans elle, on aurait 3 parts de 600/400/100.
    expect(mur?.parts.map((p) => p.montant)).not.toContain("600.00");
  });

  it("LOT 0 — repli « Non catégorisé » : clé HORS catalogue + NULL collapsent en un poste", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...JUILLET }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");

    expect(mur?.parts.map((p) => p.categorie)).toEqual(["Loyer", "Non catégorisé"]);
    // 'crypto-mining' (hors catalogue, 300) + NULL (200) → un seul poste de 500.
    const nonCat = mur?.parts.find((p) => p.estNonCategorise);
    expect(nonCat?.montant).toBe("500.00");
    expect(nonCat?.nbTransactions).toBe(2);
    // La clé hors catalogue ne fuit pas en anglais dans l'UI FR.
    expect(mur?.parts.map((p) => p.categorie)).not.toContain("crypto-mining");
  });

  it("LOT 0 — non-régression : le total central de la devise reste la somme des parts", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...JUILLET }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");

    // Total de devise (window SQL) = 700 (Loyer) + 500 (Non catégorisé).
    expect(mur?.total).toBe("1200.00");
    expect(mur?.nbTransactions).toBe(3);
    expect(mur?.montantMoyen).toBe("400.00"); // 1200 / 3, calculé EN SQL

    // Le total central ne doit pas dériver de la fusion : il vaut exactement la somme
    // des parts affichées (contrôle en centimes entiers, jamais en float — règle 8).
    const sommeCentimes = (mur?.parts ?? []).reduce(
      (s, p) => s + Math.round(Number(p.montant) * 100),
      0,
    );
    expect(sommeCentimes).toBe(Math.round(Number(mur?.total) * 100));
    // Et les parts d'une devise somment toujours à 1.
    const sommeParts = (mur?.parts ?? []).reduce((s, p) => s + Number(p.part), 0);
    expect(sommeParts).toBeCloseTo(1, 6);
  });

  it("LOT 0 — la fusion vaut AUSSI pour la fenêtre précédente (clés de merge L4 alignées)", async () => {
    // Juillet comparé à juin : « Revenus » existait en juin (income 1000) et fusionne
    // en juillet (income+revenue+Income = 1100). Si les deux requêtes ne partageaient pas
    // la MÊME clé de groupe, `montantPrecedent` retomberait à « 0.00 » (faux « nouveau »).
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, {
        sens: "inflow",
        ...JUILLET,
        fromPrecedent: JUIN.from,
        toPrecedent: JUIN.to,
      }),
    );
    const revenus = rep.devises
      .find((d) => d.currency === "MUR")
      ?.parts.find((p) => p.categorie === "Revenus");
    expect(revenus?.montant).toBe("1100.00");
    expect(revenus?.montantPrecedent).toBe("1000.00");
  });

  it("LOT 0 — le CASE SQL et categorieFr (TS) donnent le MÊME libellé, clé par clé", async () => {
    // Deux implémentations de la même règle vivent côte à côte : `categorieFr` (rendu,
    // /transactions + dashboard) et `caseCategorieFr` (agrégat, donut). Si elles
    // divergent, la MÊME transaction s'affiche sous deux catégories selon l'écran — une
    // incohérence invisible au lint, au typecheck et au build. Ce test les confronte.
    const echantillons = [
      // Toutes les clés du dictionnaire, dans leur graphie canonique…
      ...Object.keys(CORRESPONDANCE_FR),
      // …puis les graphies RÉELLEMENT observées en base le 2026-07-21 (l'amont émet en
      // SCREAMING_SNAKE_CASE, le dictionnaire est en minuscules à espaces).
      "UTILITIES",
      "BANKING_AND_FINANCE",
      "INTER_ACCOUNT_TRANSFER",
      "UNCLASSIFIED",
      // …et les cas limites : casse mixte, espaces parasites, hors catalogue, vide.
      "Income",
      "  rent  ",
      "FOOD_AND_DRINK",
      "crypto-mining",
      "",
    ];

    for (const brut of echantillons) {
      const [ligne] = await db
        .select({ fr: caseCategorieFr(sql`${brut}::text`) })
        .from(sql`(select 1) as _`);
      expect(
        ligne.fr,
        `divergence TS/SQL sur la clé « ${brut} »`,
      ).toBe(categorieFr(brut));
    }
  });

  it("LOT 0 — SCREAMING_SNAKE_CASE de l'amont : BANKING_AND_FINANCE → « Frais bancaires »", async () => {
    // Constat de QA sur donnée réelle (2026-07-21) : sans normalisation de la clé, les
    // 180 transactions BANKING_AND_FINANCE de la base tombaient en « Non catégorisé » —
    // une RÉGRESSION (le donut affichait au moins l'étiquette brute avant le Lot 0).
    const cas = [
      ["BANKING_AND_FINANCE", "Frais bancaires"],
      ["INTER_ACCOUNT_TRANSFER", "Virements internes"],
      ["UTILITIES", "Charges"],
      ["UNCLASSIFIED", "Non catégorisé"],
    ] as const;

    for (const [brut, attendu] of cas) {
      const [ligne] = await db
        .select({ fr: caseCategorieFr(sql`${brut}::text`) })
        .from(sql`(select 1) as _`);
      expect(ligne.fr, `clé amont « ${brut} »`).toBe(attendu);
    }
  });

  // ══ Lots 1-2 — AXE « CATÉGORIE EFFECTIVE » : invariants I1 → I6 ═══════════════════
  // Ces cas portent sur la fenêtre AOÛT, seule fenêtre à contenir des splits. Ils
  // prouvent la CORRECTION de l'agrégat (l'exhaustivité des montants), pas seulement
  // l'isolation : un donut de trésorerie dont les parts ne somment pas au flux réel est
  // un défaut de justesse, invisible au lint, au typecheck et au build.

  it("I1 — EXHAUSTIVITÉ : Σ parts = Σ |montant| = KPI « Sorties » du dashboard (avec un PARTIEL)", async () => {
    // LE cœur du chantier. La fixture contient une transaction PARTIELLE (500 ventilés
    // sur 1 200) : sommer les seuls splits donnerait 1 350 au lieu de 2 600, et le donut
    // divergerait du KPI « Sorties » affiché sur le dashboard — sur la même période, sans
    // aucun message. La comparaison au KPI fait partie du test (Q5), pas seulement
    // l'auto-cohérence du donut.
    const [rep, kpi] = await withWorkspace(sessionA, async (tx) => [
      await repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
      await synthesePeriodeParDevise(tx, { from: AOUT.from, to: AOUT.to }),
    ]);

    const mur = rep.devises.find((d) => d.currency === "MUR");
    const kpiMur = kpi.find((k) => k.currency === "MUR");

    // (a) le total du donut vaut le flux réel de la période — pas la part ventilée.
    expect(mur?.total).toBe("2600.00");
    // (b) …et il est ÉGAL au KPI « Sorties » du dashboard, calculé par un tout autre
    // chemin (somme conditionnelle directe sur transactions_cache, sans aucun split).
    expect(kpiMur?.sorties).toBe(mur?.total);
    // (c) la somme des parts affichées vaut ce total (contrôle en centimes ENTIERS,
    // jamais en float — règle 8).
    const sommeCentimes = (mur?.parts ?? []).reduce(
      (s, p) => s + Math.round(Number(p.montant) * 100),
      0,
    );
    expect(sommeCentimes).toBe(260000);
    // (d) contre-preuve : la seule part ventilée du PARTIEL ne suffit PAS. Si le reste
    // n'était pas imputé, on trouverait 1 350 (500+350+250+400+100·0) et ce test
    // tomberait — c'est lui qui interdit l'implémentation naïve.
    const sommeTygr = (mur?.parts ?? [])
      .filter((p) => p.origine === "TYGR")
      .reduce((s, p) => s + Math.round(Number(p.montant) * 100), 0);
    expect(sommeTygr).toBe(150000); // 500 + 350 + 250 + 400 = 1 500 seulement
    expect(sommeTygr).toBeLessThan(sommeCentimes);
    // (e) les parts d'une devise somment toujours à 1.
    const sommeParts = (mur?.parts ?? []).reduce((s, p) => s + Number(p.part), 0);
    expect(sommeParts).toBeCloseTo(1, 6);
  });

  it("I1bis — le RESTE non ventilé porte la catégorie BANCAIRE, jamais « Non catégorisé »", async () => {
    // Q5 : le reliquat d'une transaction PARTIELLE garde l'étiquette de la banque. Le
    // verser à « Non catégorisé » serait plus simple et FAUX — l'information existe.
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");

    // TX_PARTIELLE : 1 200 dont 500 ventilés sur la catégorie TYGR « Loyer » → les 700
    // restants sont imputés à sa catégorie bancaire `rent` → « Loyer » AMONT.
    const resteAmont = mur?.parts.find(
      (p) => p.categorie === "Loyer" && p.origine === "AMONT",
    );
    expect(resteAmont?.montant).toBe("700.00");
    expect(resteAmont?.categorieId).toBeNull();
    expect(resteAmont?.estNonCategorise).toBe(false);

    // Le poste « Non catégorisé » ne contient QUE la transaction que la banque
    // n'étiquette pas (TX_NUE, 100) — pas le reliquat des PARTIELS.
    const nonCat = mur?.parts.find((p) => p.estNonCategorise);
    expect(nonCat?.origine).toBe("AUCUNE");
    expect(nonCat?.montant).toBe("100.00");
  });

  it("I7bis — « Loyer » TYGR et « Loyer » bancaire restent DEUX parts (espaces de noms)", async () => {
    // La clé de groupe porte l'ORIGINE. Sur le seul libellé, ces deux parts
    // fusionneraient en une seule de 1 200 — l'utilisateur croirait avoir ventilé toute
    // la transaction alors qu'il n'en a classé que 500.
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");
    const loyers = mur?.parts.filter((p) => p.categorie === "Loyer") ?? [];

    expect(loyers).toHaveLength(2);
    expect(loyers.map((p) => p.origine).sort()).toEqual(["AMONT", "TYGR"]);
    // La part TYGR porte l'id de la catégorie de l'utilisateur ; la part bancaire, non.
    const tygr = loyers.find((p) => p.origine === "TYGR");
    expect(tygr?.montant).toBe("500.00");
    expect(tygr?.categorieId).toBe(CAT_LOYER);
    expect(loyers.find((p) => p.origine === "AMONT")?.categorieId).toBeNull();
  });

  it("I3 / D-f — `nbTransactions` compte les TRANSACTIONS, pas les lignes de split", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");

    // « Fournisseurs » agrège 3 lignes de split (200 + 150 sur TX_3SPLITS, 400 sur
    // TX_COMPLETE) mais seulement DEUX transactions distinctes.
    const fourn = mur?.parts.find((p) => p.categorie === "Fournisseurs");
    expect(fourn?.montant).toBe("750.00");
    expect(fourn?.nbTransactions).toBe(2); // 3 si l'on comptait les lignes

    // Au niveau DEVISE, l'écart est encore plus net : 8 lignes d'axe pour 4 transactions
    // (TX_PARTIELLE ×2, TX_3SPLITS ×4, TX_COMPLETE ×1, TX_NUE ×1). C'est ce que le
    // raccourci `sum(count(distinct …)) over (…)` aurait gonflé.
    expect(mur?.nbTransactions).toBe(4);
    expect(mur?.montantMoyen).toBe("650.00"); // 2 600 / 4, EN SQL

    // Corollaire assumé (D-f) : les cardinalités des parts ne s'additionnent PAS au nb de
    // la devise — une transaction PARTIELLE contribue à deux parts.
    const sommeNbParts = (mur?.parts ?? []).reduce((s, p) => s + p.nbTransactions, 0);
    expect(sommeNbParts).toBeGreaterThan(mur?.nbTransactions ?? 0);
  });

  it("I6 — une transaction COMPLÈTE ne produit AUCUNE ligne « reste » (pas de part fantôme)", async () => {
    // TX_COMPLETE : 400 ventilés sur 400. Sans le `> 0` STRICT, elle ajouterait une part
    // bancaire « Charges » à 0,00 — un secteur invisible mais présent en légende.
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");

    // Aucune part à zéro, quelle que soit l'origine.
    expect(mur?.parts.every((p) => Number(p.montant) > 0)).toBe(true);
    // La part bancaire « Charges » ne vaut QUE le reliquat de TX_3SPLITS (900 − 600),
    // sans le 0 de TX_COMPLETE (qui porte pourtant la même catégorie amont `utilities`).
    const charges = mur?.parts.find(
      (p) => p.categorie === "Charges" && p.origine === "AMONT",
    );
    expect(charges?.montant).toBe("300.00");
    expect(charges?.nbTransactions).toBe(1); // TX_3SPLITS seule, pas TX_COMPLETE
  });

  it("I5 — TOMBSTONE : une transaction effacée est exclue des DEUX branches, splits compris", async () => {
    // Le split de 5 000 SURVIT à son tombstone (append-only, aucune cascade). Un
    // `is_removed = false` oublié sur la branche splits le ferait réapparaître : « Loyer »
    // TYGR passerait de 500 à 5 500 et le total de 2 600 à 7 600.
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");

    expect(mur?.total).toBe("2600.00"); // et non 7 600
    const loyerTygr = mur?.parts.find(
      (p) => p.categorie === "Loyer" && p.origine === "TYGR",
    );
    expect(loyerTygr?.montant).toBe("500.00"); // et non 5 500
    expect(loyerTygr?.nbTransactions).toBe(1);

    // Contre-preuve INDISPENSABLE : le split tombstoné EXISTE bien en base — sans elle,
    // le test passerait aussi « parce qu'il n'y a rien à voir ». La lecture se fait sous
    // l'OWNER (`reset role`) : sous `tygr_app` hors `withWorkspace`, aucun
    // `app.current_workspace_id` n'est posé et la RLS renverrait 0 ligne, ce qui
    // ressemblerait trait pour trait à une absence de donnée.
    await client.exec(`reset role;`);
    const restant = await client.query<{ n: string }>(
      `select count(*) as n from transaction_categorizations where transaction_id = '${TX_TOMBSTONE}'`,
    );
    await client.exec(`set role tygr_app;`); // restauré AVANT toute assertion
    expect(Number(restant.rows[0].n)).toBe(1);
  });

  it("I2 — UNION ALL : aucune addition cross-devise (« Fournisseurs » existe en MUR ET en USD)", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
    );
    expect(rep.devises.map((d) => d.currency)).toEqual(["MUR", "USD"]);

    const mur = rep.devises.find((d) => d.currency === "MUR");
    const usd = rep.devises.find((d) => d.currency === "USD");

    // La MÊME catégorie TYGR porte deux montants indépendants, jamais 850.
    expect(mur?.parts.find((p) => p.categorie === "Fournisseurs")?.montant).toBe("750.00");
    expect(usd?.parts.find((p) => p.categorie === "Fournisseurs")?.montant).toBe("100.00");

    // USD : 100 ventilés + 200 de reliquat bancaire = 300, une seule transaction.
    expect(usd?.total).toBe("300.00");
    expect(usd?.nbTransactions).toBe(1);
    expect(usd?.parts.find((p) => p.origine === "AMONT")?.categorie).toBe(
      "Frais bancaires",
    );
    // Les parts de CHAQUE devise somment à 1 séparément.
    for (const d of rep.devises) {
      const somme = d.parts.reduce((s, p) => s + Number(p.part), 0);
      expect(somme, `parts de ${d.currency}`).toBeCloseTo(1, 6);
    }
  });

  it("I4 — ISOLATION : les splits de WS_B n'atteignent jamais WS_A (et réciproquement)", async () => {
    const [repA, repB] = [
      await withWorkspace(sessionA, (tx) =>
        repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
      ),
      await withWorkspace(sessionB, (tx) =>
        repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
      ),
    ];

    const categoriesA = repA.devises.flatMap((d) => d.parts.map((p) => p.categorie));
    expect(categoriesA).not.toContain("Catégorie B secrète");

    // B voit SA ventilation, et rien de A : 8 888 intégralement ventilés (donc aucune
    // part bancaire) sur sa propre catégorie.
    const murB = repB.devises.find((d) => d.currency === "MUR");
    expect(murB?.total).toBe("8888.00");
    expect(murB?.parts).toHaveLength(1);
    expect(murB?.parts[0].categorie).toBe("Catégorie B secrète");
    expect(murB?.parts[0].origine).toBe("TYGR");
    expect(murB?.parts[0].categorieId).toBe(CAT_B);
    const categoriesB = repB.devises.flatMap((d) => d.parts.map((p) => p.categorie));
    expect(categoriesB).not.toContain("Fournisseurs");
    expect(categoriesB).not.toContain("Loyer");
  });

  it("tri : montant décroissant, « Non catégorisé » toujours en dernier (axe effectif)", async () => {
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");
    // « Non catégorisé » (100) est le plus petit ici, mais le tri ne doit pas en dépendre :
    // il est repoussé par l'origine AUCUNE, pas par son montant.
    expect(mur?.parts.map((p) => `${p.categorie}/${p.origine}`)).toEqual([
      "Fournisseurs/TYGR", // 750
      "Loyer/AMONT", // 700
      "Loyer/TYGR", // 500
      "Charges/AMONT", // 300
      "Salaires/TYGR", // 250
      "Non catégorisé/AUCUNE", // 100, en dernier
    ]);
  });

  it("L4 sur l'axe effectif : la variation d'une part TYGR se relie à la MÊME clé", async () => {
    // Septembre (vide) comparé à août : chaque part d'août doit se retrouver comme
    // « précédent » quand on inverse les fenêtres. On compare donc août à juillet
    // (juillet n'a aucun split) : les parts TYGR d'août sont toutes « nouvelles »,
    // tandis que « Non catégorisé » existait déjà — preuve que la clé se relie bien
    // par (devise, origine, catégorie) et non par le seul libellé.
    const rep = await withWorkspace(sessionA, (tx) =>
      repartitionParCategorie(tx, {
        sens: "outflow",
        ...AOUT,
        fromPrecedent: JUILLET.from,
        toPrecedent: JUILLET.to,
      }),
    );
    const mur = rep.devises.find((d) => d.currency === "MUR");
    const parCle = new Map(
      mur?.parts.map((p) => [`${p.categorie}/${p.origine}`, p]),
    );

    // Aucune catégorie TYGR n'existait en juillet → « 0.00 » (l'UI en fait un « nouv. »).
    expect(parCle.get("Loyer/TYGR")?.montantPrecedent).toBe("0.00");
    expect(parCle.get("Fournisseurs/TYGR")?.montantPrecedent).toBe("0.00");
    // La catégorie BANCAIRE « Loyer », elle, existait en juillet (rent 700, non ventilé).
    expect(parCle.get("Loyer/AMONT")?.montantPrecedent).toBe("700.00");
    // « Non catégorisé » : 500 en juillet (crypto-mining 300 + NULL 200).
    expect(parCle.get("Non catégorisé/AUCUNE")?.montantPrecedent).toBe("500.00");
    // La requête précédente ne contamine pas les montants courants.
    expect(mur?.total).toBe("2600.00");
  });

  it("VENTILATION PÉRIMÉE — Σ splits > |montant| : la ventilation est ignorée, le total reste EXACT", async () => {
    // L'invariant `Σ splits ≤ |montant|` n'est validé QU'À L'ÉCRITURE du split ; l'upsert
    // de re-sync (`ingestion.ts`) écrase `amount` et laisse les splits intacts. Une
    // transaction ventilée à 100 % dont le montant RÉTRÉCIT devient donc sur-ventilée
    // sans le moindre bug d'écriture. Sans garde, la branche splits émet 1 200 et le
    // reliquat négatif (−300) disparaît via le `> 0` : le donut afficherait 1 200 pour un
    // flux réel de 900, et divergerait du KPI « Sorties » sur le même écran.
    const [rep, kpi] = await withWorkspace(sessionA, async (tx) => [
      await repartitionParCategorie(tx, { sens: "outflow", ...SEPTEMBRE }),
      await synthesePeriodeParDevise(tx, {
        from: SEPTEMBRE.from,
        to: SEPTEMBRE.to,
      }),
    ]);
    const mur = rep.devises.find((d) => d.currency === "MUR");

    // Exhaustivité préservée : 900 (sur-ventilée) + 500 + 100 (jour `to`) = 1 500,
    // ÉGAL au KPI dashboard — et non 1 800 (ce que donnerait la sur-émission des splits).
    expect(mur?.total).toBe("1500.00");
    expect(kpi.find((k) => k.currency === "MUR")?.sorties).toBe(mur?.total);

    // La ventilation périmée est IGNORÉE : la transaction est imputée entièrement à sa
    // catégorie bancaire. Aucune part TYGR « Loyer » ne doit exister en septembre.
    expect(
      mur?.parts.some((p) => p.categorie === "Loyer" && p.origine === "TYGR"),
    ).toBe(false);
    const loyerBanque = mur?.parts.find(
      (p) => p.categorie === "Loyer" && p.origine === "AMONT",
    );
    expect(loyerBanque?.montant).toBe("1000.00"); // 900 (périmée) + 100 (borne)

    // La garde ne DÉBORDE PAS sur les transactions saines : TX_SEPT_OK garde sa
    // ventilation (200 TYGR) et son reliquat bancaire (300).
    expect(
      mur?.parts.find((p) => p.categorie === "Fournisseurs" && p.origine === "TYGR")
        ?.montant,
    ).toBe("200.00");
    expect(
      mur?.parts.find((p) => p.categorie === "Charges" && p.origine === "AMONT")
        ?.montant,
    ).toBe("300.00");

    // Somme des parts = total (centimes entiers, jamais de float — règle 8).
    const sommeCentimes = (mur?.parts ?? []).reduce(
      (s, p) => s + Math.round(Number(p.montant) * 100),
      0,
    );
    expect(sommeCentimes).toBe(150000);
  });

  it("BORNES — le donut et le KPI dashboard tranchent IDENTIQUEMENT au jour près", async () => {
    // Les deux fonctions bornent différemment EN APPARENCE : `lte(to)` pour le KPI,
    // `< to + 1 jour` pour le donut. C'est équivalent sur une colonne `date` — mais
    // l'équivalence n'était épinglée par AUCUNE fixture (aucune transaction ne tombait
    // le jour `to` ni le lendemain). Si une borne dérivait, ou si la colonne devenait
    // `timestamptz`, I1 ne le verrait pas. Ces deux transactions ferment le trou.
    const [rep, kpi] = await withWorkspace(sessionA, async (tx) => [
      await repartitionParCategorie(tx, { sens: "outflow", ...SEPTEMBRE }),
      await synthesePeriodeParDevise(tx, {
        from: SEPTEMBRE.from,
        to: SEPTEMBRE.to,
      }),
    ]);
    const mur = rep.devises.find((d) => d.currency === "MUR");

    // Le 30/09 (jour `to`) est INCLUS des deux côtés ; le 01/10 (7 000) est EXCLU des
    // deux côtés — sinon l'un des deux afficherait 8 500.
    expect(mur?.total).toBe("1500.00");
    expect(kpi.find((k) => k.currency === "MUR")?.sorties).toBe("1500.00");
    expect(mur?.nbTransactions).toBe(3); // et non 4
  });

  it("I4 étage 2 — PÉRIMÈTRE : un viewFilter borne les splits ET le reste", async () => {
    // L'étage 1 (tenant) était seul couvert. Or la table dérivée `ventile` est la SEULE
    // lecture de l'axe qui ne porte pas `innerJoin(bankAccounts)` — elle n'est bornée que
    // par la policy `account_scope` (migration 0017, EXISTS récursif). Si ce chemin
    // cédait, le « reste » d'une transaction serait calculé avec des splits hors
    // périmètre : un montant FAUX, silencieux, sans filet. Ce cas l'épingle.
    const sessionUsdSeul = {
      userId: ALICE,
      activeWorkspaceId: WS_A,
      viewFilter: [ACC_A_USD],
    };
    const rep = await withWorkspace(sessionUsdSeul, (tx) =>
      repartitionParCategorie(tx, { sens: "outflow", ...AOUT }),
    );

    // Seule la devise du compte au périmètre : le MUR (2 600, dont 1 500 ventilés)
    // disparaît ENTIÈREMENT — parts TYGR comprises.
    expect(rep.devises.map((d) => d.currency)).toEqual(["USD"]);
    const usd = rep.devises[0];
    expect(usd.total).toBe("300.00");

    // Les DEUX branches restent justes sous périmètre réduit : la ventilation du compte
    // visible (100) et son reliquat bancaire (200) — le reste n'est ni gonflé ni raboté.
    expect(usd.parts.map((p) => `${p.categorie}/${p.origine}`).sort()).toEqual([
      "Fournisseurs/TYGR",
      "Frais bancaires/AMONT",
    ]);
    expect(
      usd.parts.find((p) => p.origine === "TYGR")?.montant,
    ).toBe("100.00");
    expect(
      usd.parts.find((p) => p.origine === "AMONT")?.montant,
    ).toBe("200.00");

    // Aucune catégorie propre au compte MUR ne fuit (Loyer, Salaires, Charges).
    const libelles = usd.parts.map((p) => p.categorie);
    for (const horsPerimetre of ["Loyer", "Salaires", "Charges"]) {
      expect(libelles).not.toContain(horsPerimetre);
    }
  });

  it("D-e — le fragment partagé remonte à la NATURE quand `niveau=\"nature\"`", async () => {
    // Le paramètre existe pour la future matrice catégorie × mois (D-a) et n'est PAS
    // exposé à l'UI (Q3). On le PROUVE quand même : un paramètre non testé est du code
    // mort qui casserait au premier usage réel — et c'est justement l'autre écran qui
    // s'en servirait, donc l'erreur se verrait là-bas, pas ici.
    const parNiveau = async (niveau: "feuille" | "nature") =>
      withWorkspace(sessionA, async (tx) => {
        const axe = axeCategorieEffective(
          tx,
          { sens: "outflow", from: AOUT.from, to: AOUT.to, niveau },
          "axe_test",
        );
        return tx
          .select({
            categorie: axe.categorie,
            origine: axe.origine,
            montant: sql<string>`sum(${axe.montant})::numeric(15,2)::text`,
          })
          .from(axe)
          .where(sql`${axe.origine} = 'TYGR' and ${axe.currency} = 'MUR'`)
          .groupBy(axe.categorie, axe.origine)
          .orderBy(axe.categorie);
      });

    // Feuille : la catégorie telle que saisie sur le split.
    const feuille = await parNiveau("feuille");
    expect(feuille.map((r) => r.categorie)).toEqual([
      "Fournisseurs",
      "Loyer",
      "Salaires",
    ]);

    // Nature : « Loyer » (feuille) remonte sous sa racine « Charges d'exploitation » ;
    // « Fournisseurs » et « Salaires » SONT des racines et restent eux-mêmes (coalesce —
    // sans lui, les splits posés sur une racine disparaîtraient purement et simplement).
    const nature = await parNiveau("nature");
    expect(nature.map((r) => r.categorie)).toEqual([
      "Charges d'exploitation",
      "Fournisseurs",
      "Salaires",
    ]);
    // Les montants sont conservés à l'identique — seul le libellé de l'axe change.
    expect(nature.find((r) => r.categorie === "Charges d'exploitation")?.montant).toBe(
      "500.00",
    );
    expect(nature.find((r) => r.categorie === "Fournisseurs")?.montant).toBe("750.00");
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
