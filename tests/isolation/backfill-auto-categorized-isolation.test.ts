/**
 * Suite isolation — BACKFILL de la provenance auto des catégories (Lot A,
 * `docs/specs/PLAN-fiabilite-unclassified.md` §2).
 *
 * On exerce la FONCTION RÉELLE du script (`scripts/backfill-auto-categorized-lib.mjs`,
 * celle que lance `npm run db:backfill-auto-categorized`) sous Postgres réel + les
 * migrations RÉELLES — pas de SQL recopié dans le test (règle 9 : ce que la CI prouve
 * est exactement ce que la prod exécute).
 *
 * L'état de départ REPRODUIT le défaut mesuré (CONSTAT §6.1) : avant #243,
 * "UNCLASSIFIED" passait pour une vraie catégorie → `is_auto_categorized = true` +
 * `category_source = 'OMNIFI'` sur 100 % des lignes, alors que seule une minorité
 * porte une classification réelle. Le backfill doit ramener la base à la vérité SANS
 * casser les lignes légitimement classées.
 *
 * Tourne sous l'OWNER (PGlite superuser), comme le script en prod
 * (`DATABASE_URL_ADMIN`) : c'est un test de MIGRATION DE DONNÉES, pas de RLS. Le
 * périmètre n'est donc pas borné par le tenant — c'est voulu et documenté (le backfill
 * corrige TOUS les workspaces en une passe), d'où la preuve explicite qu'il traverse
 * bien deux workspaces distincts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backfillProvenanceAutoDansTransaction,
  compterProvenanceAuto,
} from "../../scripts/backfill-auto-categorized-lib.mjs";

const client = new PGlite();

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";
const CNX_A = "dddd0001-dddd-4ddd-8ddd-dddddddddddd";
const CNX_B = "dddd0011-dddd-4ddd-8ddd-dddddddddddd";
const ACC_A = "dddd0002-dddd-4ddd-8ddd-dddddddddddd";
const ACC_B = "dddd0012-dddd-4ddd-8ddd-dddddddddddd";

/** Lignes à NEUTRALISER (sentinelles amont, toutes graphies + blancs exotiques). */
const TX_UNCLASSIFIED = "eeee0001-eeee-4eee-8eee-eeeeeeeeeeee";
const TX_UNCLASSIFIED_CASSE = "eeee0002-eeee-4eee-8eee-eeeeeeeeeeee";
const TX_UNCATEGORIZED = "eeee0003-eeee-4eee-8eee-eeeeeeeeeeee";
const TX_VIDE = "eeee0004-eeee-4eee-8eee-eeeeeeeeeeee";
const TX_NULL = "eeee0005-eeee-4eee-8eee-eeeeeeeeeeee";
const TX_TAB = "eeee0006-eeee-4eee-8eee-eeeeeeeeeeee";
/** Lignes à PRÉSERVER (contre-preuve : vraies catégories de l'inventaire). */
const TX_UTILITIES = "ffff0001-ffff-4fff-8fff-ffffffffffff";
const TX_BANKING = "ffff0002-ffff-4fff-8fff-ffffffffffff";
const TX_INTER = "ffff0003-ffff-4fff-8fff-ffffffffffff";
/** Ligne d'un AUTRE workspace (le backfill est global, il doit la corriger aussi). */
const TX_AUTRE_WS = "ffff0004-ffff-4fff-8fff-ffffffffffff";
/** Lignes de partitions distinctes (l'UPDATE sur la mère doit toutes les couvrir). */
const TX_2024 = "ffff1024-ffff-4fff-8fff-ffffffffffff";
const TX_2025 = "ffff1025-ffff-4fff-8fff-ffffffffffff";
const TX_2027 = "ffff1027-ffff-4fff-8fff-ffffffffffff";
const TX_DEFAUT = "ffff1099-ffff-4fff-8fff-ffffffffffff";

const D2024 = "2024-05-05";
const D2025 = "2025-05-05";
const D2026 = "2026-05-05";
const D2027 = "2027-05-05";
const D_DEFAUT = "2030-05-05"; // hors partitions nommées → partition DEFAULT

const JOURNAL = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "drizzle", "migrations", "meta", "_journal.json"),
    "utf8",
  ),
) as { entries: { idx: number; tag: string }[] };

async function appliquerMigrations() {
  const tags = JOURNAL.entries
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.tag);
  for (const tag of tags) {
    const fichier = path.join(process.cwd(), "drizzle", "migrations", `${tag}.sql`);
    for (const st of readFileSync(fichier, "utf8").split("--> statement-breakpoint")) {
      if (st.trim().length > 0) await client.exec(st);
    }
  }
}

/**
 * Ligne de fixture dans l'état LEGACY (pré-#243) : marqueur auto posé À TORT sur
 * TOUTES les lignes, y compris les sentinelles — c'est l'état réel constaté en base.
 * La TRACE (confidence/classification/rule_id) est peuplée partout : elle doit
 * ressortir intacte du backfill.
 */
function ligneLegacy(
  id: string,
  workspaceId: string,
  compteId: string,
  date: string,
  categorieSql: string,
): string {
  return `('${id}','${workspaceId}','${compteId}','txn-${id.slice(0, 8)}','${date}','${date}T08:00:00Z','100.00','MUR','Debit','x',${categorieSql},'Low','ML_FALLBACK','rule-42',true,'OMNIFI')`;
}

beforeAll(async () => {
  await appliquerMigrations();

  await client.exec(`
    insert into workspaces (id,name,kind,omnifi_client_user_id) values
      ('${WS_A}','Omnicane','INTERNAL_BU','eu-a'),
      ('${WS_B}','Autre Groupe','INTERNAL_BU','eu-b');
    insert into users (id,email,full_name) values ('${USER}','u@g.mu','U');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${USER}','${WS_A}','ADMIN'), ('${USER}','${WS_B}','ADMIN');
    insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,created_by) values
      ('${CNX_A}','${WS_A}','c-a','mcb','${USER}'),
      ('${CNX_B}','${WS_B}','c-b','mcb','${USER}');
    insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
      ('${ACC_A}','${WS_A}','${CNX_A}','a-a','CC A','MUR'),
      ('${ACC_B}','${WS_B}','${CNX_B}','a-b','CC B','MUR');
  `);

  await client.exec(`
    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,
       amount,currency,credit_debit,bank_label_raw,primary_category,
       confidence_level,classification_source,rule_id_match,is_auto_categorized,category_source)
    values
      ${ligneLegacy(TX_UNCLASSIFIED, WS_A, ACC_A, D2026, `'UNCLASSIFIED'`)},
      ${ligneLegacy(TX_UNCLASSIFIED_CASSE, WS_A, ACC_A, D2026, `'  Unclassified '`)},
      ${ligneLegacy(TX_UNCATEGORIZED, WS_A, ACC_A, D2026, `'Uncategorized'`)},
      ${ligneLegacy(TX_VIDE, WS_A, ACC_A, D2026, `'   '`)},
      ${ligneLegacy(TX_NULL, WS_A, ACC_A, D2026, `null`)},
      ${ligneLegacy(TX_TAB, WS_A, ACC_A, D2026, `E'\\tUNCLASSIFIED'`)},
      ${ligneLegacy(TX_UTILITIES, WS_A, ACC_A, D2026, `'UTILITIES'`)},
      ${ligneLegacy(TX_BANKING, WS_A, ACC_A, D2026, `'BANKING_AND_FINANCE'`)},
      ${ligneLegacy(TX_INTER, WS_A, ACC_A, D2026, `'INTER_ACCOUNT_TRANSFER'`)},
      ${ligneLegacy(TX_AUTRE_WS, WS_B, ACC_B, D2026, `'UNCLASSIFIED'`)},
      ${ligneLegacy(TX_2024, WS_A, ACC_A, D2024, `'UNCLASSIFIED'`)},
      ${ligneLegacy(TX_2025, WS_A, ACC_A, D2025, `'UNCLASSIFIED'`)},
      ${ligneLegacy(TX_2027, WS_A, ACC_A, D2027, `'UNCLASSIFIED'`)},
      ${ligneLegacy(TX_DEFAUT, WS_A, ACC_A, D_DEFAUT, `'UNCLASSIFIED'`)};
  `);
});

afterAll(async () => {
  await client.close();
});

async function lire(id: string) {
  const { rows } = await client.query(
    `select primary_category, is_auto_categorized, category_source,
            confidence_level, classification_source, rule_id_match
       from transactions_cache where id = $1`,
    [id],
  );
  return rows[0] as {
    primary_category: string | null;
    is_auto_categorized: boolean;
    category_source: string | null;
    confidence_level: string | null;
    classification_source: string | null;
    rule_id_match: string | null;
  };
}

describe("backfill provenance auto — état de départ (le défaut à corriger)", () => {
  it("0. reproduit le défaut : 100 % des lignes marquées auto-catégorisées", async () => {
    const { total, auto, non_auto } = await compterProvenanceAuto(client);
    expect(total).toBe(14);
    expect(auto).toBe(14);
    expect(non_auto).toBe(0);
  });
});

describe("backfill provenance auto — correction", () => {
  let lignesCorrigees = 0;

  it("1. corrige les lignes divergentes, laisse les autres", async () => {
    lignesCorrigees = await backfillProvenanceAutoDansTransaction(client);
    // 6 sentinelles WS_A + 1 sentinelle WS_B + 4 lignes de partitions = 11.
    // Les 3 vraies catégories étaient DÉJÀ conformes → non réécrites.
    expect(lignesCorrigees).toBe(11);
  });

  it("2. neutralise 'UNCLASSIFIED' : marqueur effacé ET catégorie nullifiée", async () => {
    for (const id of [TX_UNCLASSIFIED, TX_UNCLASSIFIED_CASSE, TX_UNCATEGORIZED]) {
      const l = await lire(id);
      expect(l.is_auto_categorized).toBe(false);
      expect(l.category_source).toBeNull();
      expect(l.primary_category).toBeNull();
    }
  });

  it("3. neutralise aussi vide / NULL / blancs non-espace (parité TS↔SQL)", async () => {
    for (const id of [TX_VIDE, TX_NULL, TX_TAB]) {
      const l = await lire(id);
      expect(l.is_auto_categorized).toBe(false);
      expect(l.category_source).toBeNull();
      expect(l.primary_category).toBeNull();
    }
  });

  it("4. CONTRE-PREUVE : les vraies catégories restent classées et intactes", async () => {
    const attendu: [string, string][] = [
      [TX_UTILITIES, "UTILITIES"],
      [TX_BANKING, "BANKING_AND_FINANCE"],
      [TX_INTER, "INTER_ACCOUNT_TRANSFER"],
    ];
    for (const [id, categorie] of attendu) {
      const l = await lire(id);
      expect(l.is_auto_categorized).toBe(true);
      expect(l.category_source).toBe("OMNIFI");
      expect(l.primary_category).toBe(categorie);
    }
  });

  it("5. NE TOUCHE JAMAIS la trace de classification, même sur une ligne neutralisée", async () => {
    // TECH-API-TRACE : confidence/classification/rule_id sont la matière première de
    // la future file de revue (Lot D). Les écraser ici serait irréversible.
    for (const id of [TX_UNCLASSIFIED, TX_TAB, TX_UTILITIES]) {
      const l = await lire(id);
      expect(l.confidence_level).toBe("Low");
      expect(l.classification_source).toBe("ML_FALLBACK");
      expect(l.rule_id_match).toBe("rule-42");
    }
  });

  it("6. couvre TOUTES les partitions (2024/2025/2026/2027 + DEFAULT)", async () => {
    for (const id of [TX_2024, TX_2025, TX_2027, TX_DEFAUT]) {
      const l = await lire(id);
      expect(l.is_auto_categorized).toBe(false);
      expect(l.primary_category).toBeNull();
    }
  });

  it("7. corrige TOUS les workspaces (backfill global, hors RLS — assumé)", async () => {
    const l = await lire(TX_AUTRE_WS);
    expect(l.is_auto_categorized).toBe(false);
    expect(l.primary_category).toBeNull();
  });

  it("8. APPEND-ONLY : aucune ligne supprimée ni créée", async () => {
    const { total, auto, non_auto } = await compterProvenanceAuto(client);
    expect(total).toBe(14); // identique à l'état de départ
    expect(auto).toBe(3); // les 3 vraies catégories, et elles seules
    expect(non_auto).toBe(11);
  });

  it("9. IDEMPOTENCE : un 2e passage ne modifie plus aucune ligne", async () => {
    expect(await backfillProvenanceAutoDansTransaction(client)).toBe(0);
    // …et l'état reste celui de la 1re passe.
    const { total, auto } = await compterProvenanceAuto(client);
    expect(total).toBe(14);
    expect(auto).toBe(3);
  });

  it("10. re-neutralise une ligne re-polluée (convergence, pas one-shot)", async () => {
    // Une ré-ingestion sous un code N-1 pourrait ré-écrire une sentinelle : le
    // backfill doit rester la fonction de convergence, rejouable à volonté.
    await client.query(
      `update transactions_cache
          set primary_category = 'UNCLASSIFIED', is_auto_categorized = true, category_source = 'OMNIFI'
        where id = $1`,
      [TX_UNCLASSIFIED],
    );
    expect(await backfillProvenanceAutoDansTransaction(client)).toBe(1);
    const l = await lire(TX_UNCLASSIFIED);
    expect(l.is_auto_categorized).toBe(false);
    expect(l.primary_category).toBeNull();
  });
});
