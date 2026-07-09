/**
 * Suite dédiée à la MIGRATION 0020 (FB0709-CAT-DOUBLONS1) — dédoublonnage de
 * l'existant AVANT pose de l'index unique fonctionnel.
 *
 * Les autres suites appliquent 0000→0020 sur une base VIERGE (aucun doublon
 * pré-existant) → elles prouvent que l'index se pose, pas que la fusion des
 * doublons LEGACY fonctionne. Ici on reproduit l'état AVANT correctif : on
 * applique les migrations JUSQU'À 0019, on INSÈRE des doublons (que l'ancien
 * UNIQUE laissait passer : casse + parent NULL), PUIS on applique 0020 et on
 * vérifie :
 *   - la survivante = la plus ancienne (created_at min) ;
 *   - les splits et règles ont été re-pointés vers la survivante ;
 *   - une sous-catégorie dont le parent était un doublon suit la survivante ;
 *   - les règles devenues doublon exact sont dédupliquées (pas de violation de
 *     categorization_rules_workspace_unique) ;
 *   - l'index final REJETTE tout nouveau doublon de casse.
 *
 * Tourne sous l'OWNER (les migrations + le seed de doublons legacy s'exécutent
 * sous le rôle propriétaire, comme en prod `DATABASE_URL_ADMIN`). C'est un test
 * de MIGRATION, pas de RLS.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const client = new PGlite();

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const TXN = "eeee1111-eeee-4eee-8eee-eeeeeeeeeeee";

// Deux Natures « VAT » (casse + parent NULL → l'ancien UNIQUE les laissait passer).
const VAT_ANCIEN = "cccc0001-cccc-4ccc-8ccc-cccccccccccc"; // created_at min → survivante
const VAT_RECENT = "cccc0002-cccc-4ccc-8ccc-cccccccccccc"; // doublon → fusionné
// Une sous-catégorie rattachée au doublon récent (doit suivre la survivante).
const SOUS_DU_RECENT = "cccc0003-cccc-4ccc-8ccc-cccccccccccc";

function statements(sqlText: string): string[] {
  return sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0);
}

async function appliquer(tag: string) {
  const file = path.join(process.cwd(), "drizzle", "migrations", `${tag}.sql`);
  for (const st of statements(readFileSync(file, "utf8"))) {
    await client.exec(st);
  }
}

// Ordre RÉEL des migrations jusqu'à 0019 (0009 orpheline exclue, cf.
// migrations-journal-coherence). On lit le journal pour rester fidèle à la prod.
const JOURNAL = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "drizzle", "migrations", "meta", "_journal.json"),
    "utf8",
  ),
) as { entries: { idx: number; tag: string }[] };

beforeAll(async () => {
  const avant0020 = JOURNAL.entries
    .filter((e) => e.idx < 20)
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.tag);
  for (const tag of avant0020) await appliquer(tag);

  // Seed d'un état LEGACY avec doublons (impossible à créer via le repo N-1, mais
  // que l'ancien UNIQUE sensible-casse / NULL≠NULL autorisait en base).
  await client.exec(`
    insert into workspaces (id,name,kind,omnifi_client_user_id) values
      ('${WS}','BU','INTERNAL_BU','eu');
    insert into users (id,email,full_name) values ('${USER}','u@g.mu','U');
    insert into workspace_members (user_id,workspace_id,role) values ('${USER}','${WS}','ADMIN');
    insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,created_by) values
      ('dddd0001-dddd-4ddd-8ddd-dddddddddddd','${WS}','c','mcb','${USER}');
    insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
      ('dddd0002-dddd-4ddd-8ddd-dddddddddddd','${WS}','dddd0001-dddd-4ddd-8ddd-dddddddddddd','a','CC','MUR');
    insert into transactions_cache (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw) values
      ('${TXN}','${WS}','dddd0002-dddd-4ddd-8ddd-dddddddddddd','t','2026-03-15','2026-03-15T08:00:00Z','-1000.00','MUR','Debit','x');

    -- Deux Natures « VAT » / « vat » (parent NULL) — doublon de casse + NULL.
    insert into categories (id,workspace_id,name,parent_id,created_at) values
      ('${VAT_ANCIEN}','${WS}','VAT',null,'2026-01-01T00:00:00Z'),
      ('${VAT_RECENT}','${WS}','vat',null,'2026-02-01T00:00:00Z'),
      ('${SOUS_DU_RECENT}','${WS}','Import','${VAT_RECENT}'::uuid,'2026-02-02T00:00:00Z');

    -- Un split rattaché au DOUBLON récent (doit être re-pointé vers la survivante).
    insert into transaction_categorizations (id,workspace_id,transaction_id,transaction_date,category_id,amount,source,created_by) values
      ('ffff0001-ffff-4fff-8fff-ffffffffffff','${WS}','${TXN}','2026-03-15','${VAT_RECENT}','500.00','MANUAL','${USER}');

    -- Deux règles IDENTIQUES (même pattern/type) pointant l'une la survivante,
    -- l'autre le doublon → après re-pointage elles seraient un doublon exact : la
    -- migration doit en supprimer une (sinon violation du UNIQUE des règles).
    insert into categorization_rules (id,workspace_id,pattern,match_type,category_id,priority,created_by) values
      ('11110001-1111-4111-8111-111111111111','${WS}','TVA','contains','${VAT_ANCIEN}',0,'${USER}'),
      ('11110002-1111-4111-8111-111111111111','${WS}','TVA','contains','${VAT_RECENT}',1,'${USER}');
  `);

  // Applique 0020 (dédoublonnage + index).
  await appliquer("0020_categories-unicite-insensible-casse");
});

afterAll(async () => {
  await client.close();
});

describe("migration 0020 — dédoublonnage LEGACY", () => {
  it("fusionne les deux « VAT » : seule la survivante (created_at min) subsiste", async () => {
    const res = await client.query<{ id: string; name: string }>(
      `select id, name from categories where lower(name) = 'vat'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].id).toBe(VAT_ANCIEN); // la plus ancienne gagne
  });

  it("re-pointe le split du doublon vers la survivante", async () => {
    const res = await client.query<{ category_id: string }>(
      `select category_id from transaction_categorizations where id = 'ffff0001-ffff-4fff-8fff-ffffffffffff'`,
    );
    expect(res.rows[0].category_id).toBe(VAT_ANCIEN);
  });

  it("fait suivre la sous-catégorie du doublon vers la survivante (parent re-pointé)", async () => {
    const res = await client.query<{ parent_id: string }>(
      `select parent_id from categories where id = '${SOUS_DU_RECENT}'`,
    );
    expect(res.rows[0].parent_id).toBe(VAT_ANCIEN);
  });

  it("déduplique les règles devenues identiques (une seule règle TVA/contains reste)", async () => {
    const res = await client.query<{ n: number }>(
      `select count(*)::int as n from categorization_rules
       where workspace_id = '${WS}' and pattern = 'TVA' and match_type = 'contains'`,
    );
    expect(res.rows[0].n).toBe(1);
    // Et elle pointe la survivante.
    const cat = await client.query<{ category_id: string }>(
      `select category_id from categorization_rules where pattern = 'TVA' and match_type = 'contains'`,
    );
    expect(cat.rows[0].category_id).toBe(VAT_ANCIEN);
  });

  it("l'index unique fonctionnel REFUSE désormais un nouveau doublon de casse", async () => {
    let thrown: unknown = null;
    try {
      await client.exec(
        `insert into categories (id,workspace_id,name,parent_id) values
         ('cccc0009-cccc-4ccc-8ccc-cccccccccccc','${WS}','Vat',null)`,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "un 3e « Vat » racine doit violer l'index unique fonctionnel").not.toBeNull();
  });
});
