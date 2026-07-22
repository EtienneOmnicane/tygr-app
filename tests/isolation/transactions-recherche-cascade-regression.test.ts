/**
 * Régression : ISSUE-001 — la recherche /transactions était AVEUGLE aux
 * transactions sans `clean_label` (32 % du volume réel au 2026-07-15).
 * Trouvé par /qa le 2026-07-15.
 * Rapport : .gstack/qa-reports/qa-report-tygr-local-2026-07-15.md
 *
 * Mode de défaillance d'origine : `conditionsFiltres` (repositories/transactions.ts)
 * n'interrogeait QUE `clean_label`, alors que la colonne Libellé AFFICHE le brut en
 * repli (cascade `resoudreLibelle`) et que le moteur de règles matche déjà
 * `coalesce(nullif(trim(clean_label), ''), bank_label_raw)`
 * (regles-categorisation.ts). L'utilisateur voyait une ligne à l'écran, la
 * cherchait par son libellé… et la recherche ne la trouvait pas.
 *
 * Prouve, sous RLS réelle (rôle applicatif, harness identique aux autres suites) :
 * - une tx `clean_label` NULL est trouvée par son BRUT (le bug d'origine) ;
 * - une tx `clean_label` composé d'espaces (trim → vide) retombe aussi sur le brut ;
 * - le chemin marchand (clean_label non vide) reste prioritaire et fonctionne ;
 * - insensibilité à la casse et échappement littéral des méta-caractères LIKE
 *   valent AUSSI sur le brut ;
 * - le TOTAL filtré (`sommeNetteTransactions`) suit la même sémantique (fragment
 *   partagé `conditionsFiltres`) — le bandeau « Total des résultats » ne peut pas
 *   diverger de la liste ;
 * - aucune fuite : le terme présent chez un AUTRE workspace ne remonte jamais.
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
} from "@/server/repositories/transactions";
import {
  listerTransactionsSchema,
  sommeNetteSchema,
} from "@/lib/transactions-schema";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_R = "0aaa0000-aaaa-4aaa-8aaa-000000000001";
const WS_X = "0bbb0000-bbbb-4bbb-8bbb-000000000002";
const REMI = "0e110000-1111-4111-8111-000000000001";
const XENA = "0e220000-2222-4222-8222-000000000002";
const sessionR = { userId: REMI, activeWorkspaceId: WS_R };

const ACC_R = "0acc0000-dddd-4ddd-8ddd-000000000001";
const ACC_X = "0acc0000-dddd-4ddd-8ddd-000000000002";

// 4 transactions du workspace R, une par niveau de la cascade cherchable :
// R1 : clean_label présent (« Salaire Alpha »)              → trouvable par le MARCHAND.
// R2 : clean_label NULL, brut « …ACME-NORD LTD »              → LE BUG : introuvable avant.
// R3 : clean_label "   " (trim → vide), brut « DODOPAY »    → nullif(trim) → brut.
// R4 : brut avec méta-caractères LIKE (« Remise 50% x_y »)  → littéralité sur le BRUT.
const R1 = "0f010000-0000-4000-8000-000000000001";
const R2 = "0f020000-0000-4000-8000-000000000002";
const R3 = "0f030000-0000-4000-8000-000000000003";
const R4 = "0f040000-0000-4000-8000-000000000004";

const parse = (f: Record<string, unknown>) => {
  const r = listerTransactionsSchema.safeParse(f);
  if (!r.success) throw new Error("filtre de test invalide: " + r.error.message);
  return r.data;
};

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const st of raw.split("--> statement-breakpoint")) {
      if (st.trim().length > 0) await client.exec(st);
    }
  }

  await client.exec(`
    insert into workspaces (id,name,kind,omnifi_client_user_id) values
      ('${WS_R}','BU R','INTERNAL_BU','eu-r'), ('${WS_X}','BU X','INTERNAL_BU','eu-x');
    insert into users (id,email,full_name) values
      ('${REMI}','r@g.mu','Rémi'), ('${XENA}','x@g.mu','Xena');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${REMI}','${WS_R}','MANAGER'), ('${XENA}','${WS_X}','MANAGER');
    insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,institution_name,created_by) values
      ('0cc00000-cccc-4ccc-8ccc-000000000001','${WS_R}','c-r','mcb','MCB','${REMI}'),
      ('0cc00000-cccc-4ccc-8ccc-000000000002','${WS_X}','c-x','mcb','MCB','${XENA}');
    insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
      ('${ACC_R}','${WS_R}','0cc00000-cccc-4ccc-8ccc-000000000001','a-r','CC','MUR'),
      ('${ACC_X}','${WS_X}','0cc00000-cccc-4ccc-8ccc-000000000002','a-x','CC','MUR');

    -- ⚠️ MONTANTS POSITIFS + sens sur credit_debit = convention de PRODUCTION
    -- (même semis que transactions-somme-nette-isolation.test.ts).
    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label,is_removed) values
      ('${R1}','${WS_R}','${ACC_R}','r1','2026-03-15','2026-03-15T08:00:00Z','500.00','MUR','Credit','raw sans terme','Salaire Alpha',false),
      ('${R2}','${WS_R}','${ACC_R}','r2','2026-03-14','2026-03-14T08:00:00Z','70000.50','MUR','Debit','IB Account Transfer|Inv May 26|ACME-NORD LTD',null,false),
      ('${R3}','${WS_R}','${ACC_R}','r3','2026-03-13','2026-03-13T08:00:00Z','200.00','MUR','Debit','VIREMENT DODOPAY','   ',false),
      ('${R4}','${WS_R}','${ACC_R}','r4','2026-03-12','2026-03-12T08:00:00Z','100.00','MUR','Debit','Remise 50% x_y ACME-NORD',null,false);

    -- Même terme chez un AUTRE workspace : ne doit JAMAIS remonter pour R.
    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label,is_removed) values
      ('0f990000-0000-4000-8000-000000000009','${WS_X}','${ACC_X}','x9','2026-03-15','2026-03-15T08:00:00Z','999.00','MUR','Debit','ACME-NORD SECRET X',null,false);
  `);

  // Même socle que les autres suites d'isolation : provisioning RÉEL du rôle
  // applicatif puis bascule dessus — la RLS ne mord que sous un non-owner (C6).
  await client.exec(
    readFileSync(path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"), "utf8"),
  );
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

const rechercher = (terme: string) =>
  withWorkspace(sessionR, (tx, ctx) =>
    listerTransactions(tx, ctx, parse({ recherche: terme, limite: 100 })),
  );

describe("recherche sur la cascade de libellé (marchand → brut)", () => {
  it("trouve une transaction SANS clean_label par son libellé brut (bug d'origine)", async () => {
    const page = await rechercher("ACME-NORD LTD");
    expect(page.lignes.map((l) => l.id)).toEqual([R2]);
    expect(page.lignes[0].cleanLabel).toBeNull();
  });

  it("est insensible à la casse sur le brut aussi", async () => {
    const page = await rechercher("acme-nord ltd");
    expect(page.lignes.map((l) => l.id)).toEqual([R2]);
  });

  it("un clean_label d'espaces (trim → vide) retombe sur le brut", async () => {
    const page = await rechercher("dodopay");
    expect(page.lignes.map((l) => l.id)).toEqual([R3]);
  });

  it("le chemin marchand (clean_label non vide) fonctionne toujours", async () => {
    const page = await rechercher("salaire alpha");
    expect(page.lignes.map((l) => l.id)).toEqual([R1]);
  });

  it("le marchand PRIME : un terme présent seulement dans le brut d'une tx à clean_label non vide ne matche pas", async () => {
    // R1 a clean_label « Salaire Alpha » et un brut « raw sans terme » : chercher
    // « raw sans » ne doit PAS la trouver (le libellé affiché est le marchand).
    const page = await rechercher("raw sans");
    expect(page.lignes).toHaveLength(0);
  });

  it("échappe les méta-caractères LIKE sur le brut (recherche littérale)", async () => {
    const p50 = await rechercher("50%");
    expect(p50.lignes.map((l) => l.id)).toEqual([R4]);
    const pxy = await rechercher("x_y");
    expect(pxy.lignes.map((l) => l.id)).toEqual([R4]);
  });

  it("ne fuit JAMAIS le terme d'un autre workspace (RLS)", async () => {
    const page = await rechercher("ACME-NORD");
    // R2 et R4 (brut) — jamais la ligne « ACME-NORD SECRET X » du workspace X.
    expect(page.lignes.map((l) => l.id).sort()).toEqual([R2, R4].sort());
    expect(page.lignes.some((l) => l.bankLabelRaw?.includes("SECRET"))).toBe(false);
  });

  it("le TOTAL filtré suit la même sémantique que la liste (fragment partagé)", async () => {
    const filtres = sommeNetteSchema.safeParse({ recherche: "ACME-NORD" });
    if (!filtres.success) throw new Error("filtre somme invalide");
    const totaux = await withWorkspace(sessionR, (tx, ctx) =>
      sommeNetteParDevise(tx, ctx, filtres.data),
    );
    // R2 (−70 000,50) + R4 (−100,00) en MUR : sorties sommées, aucune entrée.
    const mur = totaux.find((t) => t.currency === "MUR");
    expect(mur).toBeDefined();
    expect(mur!.sorties).toBe("70100.50");
    expect(mur!.entrees).toBe("0.00");
    expect(mur!.nbTransactions).toBe(2);
  });
});
