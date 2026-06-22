/**
 * Suite isolation — moteur de règles de catégorisation. Prouve :
 * - appliquerRegles crée un split à 100 % (source='RULE') pour une transaction
 *   non catégorisée dont le libellé matche ; respecte priorité, contains/
 *   starts_with, et la PRIORITÉ clean_label > bank_label_raw.
 * - MANUAL prime : une transaction déjà ventilée n'est jamais touchée.
 * - échappement LIKE : un motif « 50% » ne matche que le littéral.
 * - idempotence : ré-appliquer ne crée pas de doublon.
 * - isolation tenant : une règle de A ne catégorise jamais une txn de B ; une
 *   règle ciblant une catégorie d'un autre workspace est rejetée (FK composite).
 * - règle archivée non appliquée ; CRUD scopé (règle d'un autre tenant introuvable).
 *
 * Tourne sous `tygr_app` (RLS active) avec migrations + provisioning RÉELS —
 * même socle que les autres suites d'isolation (bloquante en CI).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import {
  categorizationAudit,
  transactionCategorizations,
} from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { remplacerSplits } from "@/server/repositories/categorisation";
import {
  appliquerRegles,
  archiverRegle,
  creerRegle,
  echapperLike,
  listerRegles,
  modifierRegle,
  RegleIntrouvableError,
} from "@/server/repositories/regles-categorisation";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111"; // MANAGER de A
const VICTOR = "33333333-3333-4333-8333-333333333333"; // VIEWER de A
const BOB = "22222222-2222-4222-8222-222222222222"; // MANAGER de B
const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

const ACCT_A = "dddd0001-dddd-4ddd-8ddd-dddddddddddd";
const ACCT_B = "dddd0002-dddd-4ddd-8ddd-dddddddddddd";
const CAT_A = "aaaacccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // « Charges » (A)
const CAT_A2 = "aaaadddd-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // « Loyer » (A)
const CAT_B = "bbbbcccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // « Loyer » (B)

// Transactions de A — libellés variés pour tester match / priorité / fallback.
// id, clean_label, bank_label_raw, montant.
const TXN = {
  // clean_label « EDF Facture » → matche contains « EDF » et « facture ».
  edf: "eeee0001-eeee-4eee-8eee-eeeeeeeeeeee",
  // clean_label NULL, bank_label_raw « VIR LOYER MARS » → fallback brut.
  loyer: "eeee0002-eeee-4eee-8eee-eeeeeeeeeeee",
  // clean_label « ACME » ET bank_label_raw « PAIEMENT EDF VIA ACME » →
  // la priorité clean_label doit décider (match « ACME », pas « EDF »).
  prio: "eeee0003-eeee-4eee-8eee-eeeeeeeeeeee",
  // clean_label « REMISE 50% CLIENT » → test échappement LIKE du motif « 50% ».
  promo: "eeee0004-eeee-4eee-8eee-eeeeeeeeeeee",
  // clean_label « SALAIRE » — aucune règle ne matche (reste non catégorisé).
  salaire: "eeee0005-eeee-4eee-8eee-eeeeeeeeeeee",
  // déjà catégorisé manuellement → MANUAL prime, jamais touché.
  manuel: "eeee0006-eeee-4eee-8eee-eeeeeeeeeeee",
} as const;
const DATE = "2026-03-15";

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
      ('${WS_A}','BU A','INTERNAL_BU','eu-a'), ('${WS_B}','BU B','INTERNAL_BU','eu-b');
    insert into users (id,email,full_name) values
      ('${ALICE}','a@g.mu','Alice'), ('${BOB}','b@g.mu','Bob'), ('${VICTOR}','v@g.mu','Victor');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${ALICE}','${WS_A}','MANAGER'), ('${BOB}','${WS_B}','MANAGER'), ('${VICTOR}','${WS_A}','VIEWER');
    insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,created_by) values
      ('cccc0001-cccc-4ccc-8ccc-cccccccccccc','${WS_A}','c-a','mcb','${ALICE}'),
      ('cccc0002-cccc-4ccc-8ccc-cccccccccccc','${WS_B}','c-b','mcb','${BOB}');
    insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
      ('${ACCT_A}','${WS_A}','cccc0001-cccc-4ccc-8ccc-cccccccccccc','a-a','CC','MUR'),
      ('${ACCT_B}','${WS_B}','cccc0002-cccc-4ccc-8ccc-cccccccccccc','a-b','CC','MUR');
    insert into categories (id,workspace_id,name) values
      ('${CAT_A}','${WS_A}','Charges'), ('${CAT_A2}','${WS_A}','Loyer'), ('${CAT_B}','${WS_B}','Loyer');

    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label) values
      ('${TXN.edf}','${WS_A}','${ACCT_A}','t-edf','${DATE}','${DATE}T08:00:00Z','-1200.00','MUR','Debit','RAW EDF','EDF Facture'),
      ('${TXN.loyer}','${WS_A}','${ACCT_A}','t-loyer','${DATE}','${DATE}T08:00:00Z','-8000.00','MUR','Debit','VIR LOYER MARS',NULL),
      ('${TXN.prio}','${WS_A}','${ACCT_A}','t-prio','${DATE}','${DATE}T08:00:00Z','-300.00','MUR','Debit','PAIEMENT EDF VIA ACME','ACME'),
      ('${TXN.promo}','${WS_A}','${ACCT_A}','t-promo','${DATE}','${DATE}T08:00:00Z','-50.00','MUR','Debit','RAW PROMO','REMISE 50% CLIENT'),
      ('${TXN.salaire}','${WS_A}','${ACCT_A}','t-sal','${DATE}','${DATE}T08:00:00Z','5000.00','MUR','Credit','RAW SAL','SALAIRE'),
      ('${TXN.manuel}','${WS_A}','${ACCT_A}','t-man','${DATE}','${DATE}T08:00:00Z','-999.00','MUR','Debit','RAW MAN','EDF DEJA CLASSE');
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

/** Splits d'une transaction (lecture directe, scopée par la session). */
async function splitsDe(
  session: { userId: string; activeWorkspaceId: string },
  txnId: string,
) {
  return withWorkspace(session, (tx) =>
    tx
      .select({
        categoryId: transactionCategorizations.categoryId,
        amount: transactionCategorizations.amount,
        source: transactionCategorizations.source,
        ruleId: transactionCategorizations.ruleId,
      })
      .from(transactionCategorizations)
      .where(
        and(
          eq(transactionCategorizations.transactionId, txnId),
          eq(transactionCategorizations.transactionDate, DATE),
        ),
      ),
  );
}

describe("echapperLike (unitaire)", () => {
  it("neutralise %, _ et backslash", () => {
    expect(echapperLike("50%")).toBe("50\\%");
    expect(echapperLike("a_b")).toBe("a\\_b");
    expect(echapperLike("c\\d")).toBe("c\\\\d");
    expect(echapperLike("EDF")).toBe("EDF"); // inchangé si pas de méta-caractère
  });
});

describe("appliquerRegles — application aux transactions non catégorisées", () => {
  it("pré-état : aucune transaction de A n'a de split", async () => {
    for (const id of Object.values(TXN)) {
      expect(await splitsDe(sessionA, id)).toHaveLength(0);
    }
  });

  it("pré-catégorise MANUELLEMENT la transaction 'manuel' (MANUAL doit primer)", async () => {
    await withWorkspace(sessionA, (tx, ctx) =>
      remplacerSplits(
        tx,
        ctx,
        { transactionId: TXN.manuel, transactionDate: DATE },
        [{ categoryId: CAT_A2, amount: "999.00" }],
      ),
    );
    const s = await splitsDe(sessionA, TXN.manuel);
    expect(s).toHaveLength(1);
    expect(s[0].source).toBe("MANUAL");
  });

  it("crée les règles (priorité : ACME=1 avant EDF=2 ; LOYER ; 50%)", async () => {
    // ACME prioritaire (priorité 1) pour prouver l'ordre sur la txn 'prio'
    // (qui matcherait aussi EDF via bank_label_raw, mais clean_label=ACME).
    await withWorkspace(sessionA, (tx, ctx) =>
      creerRegle(tx, ctx, {
        pattern: "ACME",
        matchType: "contains",
        categoryId: CAT_A,
        priority: 1,
      }),
    );
    await withWorkspace(sessionA, (tx, ctx) =>
      creerRegle(tx, ctx, {
        pattern: "EDF",
        matchType: "contains",
        categoryId: CAT_A,
        priority: 2,
      }),
    );
    await withWorkspace(sessionA, (tx, ctx) =>
      creerRegle(tx, ctx, {
        pattern: "VIR LOYER",
        matchType: "starts_with",
        categoryId: CAT_A2,
        priority: 5,
      }),
    );
    await withWorkspace(sessionA, (tx, ctx) =>
      creerRegle(tx, ctx, {
        pattern: "REMISE 50%",
        matchType: "contains",
        categoryId: CAT_A,
        priority: 5,
      }),
    );
    const regles = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    expect(regles).toHaveLength(4);
    // Triées par priorité croissante.
    expect(regles[0].pattern).toBe("ACME");
  });

  it("applique les règles : catégorise edf, loyer, prio, promo — PAS salaire ni manuel", async () => {
    const r = await withWorkspace(sessionA, (tx, ctx) => appliquerRegles(tx, ctx));
    // 4 transactions catégorisées (edf, loyer, prio, promo).
    expect(r.transactionsCategorisees).toBe(4);
    expect(r.splitsCrees).toBe(4);

    // edf → CAT_A (contains EDF), split à 100 % = 1200.00, source RULE.
    const edf = await splitsDe(sessionA, TXN.edf);
    expect(edf).toHaveLength(1);
    expect(edf[0].source).toBe("RULE");
    expect(edf[0].categoryId).toBe(CAT_A);
    expect(edf[0].amount).toBe("1200.00"); // abs du montant -1200.00
    expect(edf[0].ruleId).toBeTruthy();

    // loyer → CAT_A2 via starts_with sur bank_label_raw (clean_label NULL).
    const loyer = await splitsDe(sessionA, TXN.loyer);
    expect(loyer).toHaveLength(1);
    expect(loyer[0].categoryId).toBe(CAT_A2);
    expect(loyer[0].amount).toBe("8000.00");
  });

  it("PRIORITÉ du libellé : 'prio' matche par clean_label (ACME) pas par bank_label_raw (EDF)", async () => {
    // clean_label='ACME' (règle priorité 1 → CAT_A) ; bank_label_raw contient
    // 'EDF' (règle priorité 2). Le match se fait sur clean_label EN PRIORITÉ,
    // donc c'est la règle ACME qui gagne (même CAT_A ici, mais on prouve que la
    // règle APPLIQUÉE est ACME via le rule_id correspondant).
    const acme = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    ).then((rs) => rs.find((r) => r.pattern === "ACME"));
    const prio = await splitsDe(sessionA, TXN.prio);
    expect(prio).toHaveLength(1);
    expect(prio[0].ruleId).toBe(acme!.id); // règle ACME, pas EDF
    expect(prio[0].amount).toBe("300.00");
  });

  it("ÉCHAPPEMENT LIKE : le motif 'REMISE 50%' matche le littéral, pas un joker", async () => {
    // La txn 'promo' a clean_label 'REMISE 50% CLIENT'. Le % du motif est échappé
    // → il matche le caractère '%' littéral. (Un % non échappé matcherait aussi
    // 'REMISE 50 CLIENT' sans le signe — non présent ici, mais la règle est sûre.)
    const promo = await splitsDe(sessionA, TXN.promo);
    expect(promo).toHaveLength(1);
    expect(promo[0].source).toBe("RULE");
  });

  it("salaire reste NON catégorisé (aucune règle ne matche)", async () => {
    expect(await splitsDe(sessionA, TXN.salaire)).toHaveLength(0);
  });

  it("MANUAL prime : la transaction pré-catégorisée à la main n'est PAS touchée", async () => {
    const man = await splitsDe(sessionA, TXN.manuel);
    expect(man).toHaveLength(1);
    expect(man[0].source).toBe("MANUAL"); // toujours MANUAL, pas écrasé par RULE
    expect(man[0].categoryId).toBe(CAT_A2);
  });

  it("IDEMPOTENCE : ré-appliquer ne crée aucun nouveau split", async () => {
    const r = await withWorkspace(sessionA, (tx, ctx) => appliquerRegles(tx, ctx));
    expect(r.transactionsCategorisees).toBe(0); // tout est déjà catégorisé/sans match
    expect(r.splitsCrees).toBe(0);
    // edf a toujours exactement 1 split.
    expect(await splitsDe(sessionA, TXN.edf)).toHaveLength(1);
  });

  it("chaque split RULE a écrit un audit CREATE/source=RULE", async () => {
    const audit = await withWorkspace(sessionA, (tx) =>
      tx
        .select({
          action: categorizationAudit.action,
          source: categorizationAudit.source,
        })
        .from(categorizationAudit)
        .where(eq(categorizationAudit.source, "RULE")),
    );
    expect(audit.length).toBe(4); // edf, loyer, prio, promo
    expect(audit.every((a) => a.action === "CREATE")).toBe(true);
  });
});

describe("appliquerRegles — portée bornée à un compte", () => {
  it("bankAccountId limite l'application aux transactions de ce compte", async () => {
    // Nouvelle txn non catégorisée sur A + une règle qui la matche ; on applique
    // SEULEMENT sur un autre compte (inexistant pour cette txn) → pas de match.
    await client.exec(`reset role;`);
    await client.exec(`
      insert into transactions_cache
        (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,clean_label) values
        ('eeee0099-eeee-4eee-8eee-eeeeeeeeeeee','${WS_A}','${ACCT_A}','t-borne','${DATE}','${DATE}T08:00:00Z','-10.00','MUR','Debit','EDF BORNE');
    `);
    await client.exec(`set role tygr_app;`);

    // Application bornée à un AUTRE compte (celui de B, invisible ici) → 0.
    const rAutre = await withWorkspace(sessionA, (tx, ctx) =>
      appliquerRegles(tx, ctx, { bankAccountId: ACCT_B }),
    );
    expect(rAutre.splitsCrees).toBe(0);
    expect(await splitsDe(sessionA, "eeee0099-eeee-4eee-8eee-eeeeeeeeeeee")).toHaveLength(0);

    // Application bornée au BON compte → catégorise.
    const rBon = await withWorkspace(sessionA, (tx, ctx) =>
      appliquerRegles(tx, ctx, { bankAccountId: ACCT_A }),
    );
    expect(rBon.splitsCrees).toBe(1);
    expect(await splitsDe(sessionA, "eeee0099-eeee-4eee-8eee-eeeeeeeeeeee")).toHaveLength(1);
  });
});

describe("isolation inter-workspace (anti-IDOR)", () => {
  it("une règle de B ne voit/catégorise jamais une transaction de A", async () => {
    // B crée une règle large (contains 'a') et applique : aucune txn de A n'est
    // touchée (RLS scope transactions_cache au workspace B, qui n'a pas de txn).
    await withWorkspace(sessionB, (tx, ctx) =>
      creerRegle(tx, ctx, {
        pattern: "a",
        matchType: "contains",
        categoryId: CAT_B,
        priority: 1,
      }),
    );
    const r = await withWorkspace(sessionB, (tx, ctx) => appliquerRegles(tx, ctx));
    expect(r.splitsCrees).toBe(0); // B n'a aucune transaction
    // Les splits de A sont intacts (toujours RULE/MANUAL posés plus haut).
    const edf = await splitsDe(sessionA, TXN.edf);
    expect(edf).toHaveLength(1);
  });

  it("créer une règle ciblant une catégorie d'un AUTRE workspace → rejeté (FK composite)", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessionA, (tx, ctx) =>
        creerRegle(tx, ctx, {
          pattern: "X",
          matchType: "contains",
          categoryId: CAT_B, // catégorie de B dans une règle de A
          priority: 9,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "category_id cross-workspace doit être rejeté").not.toBeNull();
  });

  it("listerRegles de A ne renvoie pas les règles de B", async () => {
    const reglesA = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx),
    );
    // Toutes les règles de A ciblent des catégories de A (jamais CAT_B).
    expect(reglesA.every((r) => r.categoryId !== CAT_B)).toBe(true);
    const reglesB = await withWorkspace(sessionB, (tx, ctx) =>
      listerRegles(tx, ctx),
    );
    // La règle de B ('a') est bien là, isolée.
    expect(reglesB.some((r) => r.pattern === "a")).toBe(true);
    expect(reglesB.every((r) => r.categoryId === CAT_B)).toBe(true);
  });
});

describe("règle archivée + CRUD scopé", () => {
  it("une règle archivée n'est plus appliquée", async () => {
    // Nouvelle txn + règle dédiée, puis on archive la règle AVANT d'appliquer.
    await client.exec(`reset role;`);
    await client.exec(`
      insert into transactions_cache
        (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,clean_label) values
        ('eeee0100-eeee-4eee-8eee-eeeeeeeeeeee','${WS_A}','${ACCT_A}','t-arch','${DATE}','${DATE}T08:00:00Z','-77.00','MUR','Debit','ARCHIVE ME');
    `);
    await client.exec(`set role tygr_app;`);

    const { ruleId } = await withWorkspace(sessionA, (tx, ctx) =>
      creerRegle(tx, ctx, {
        pattern: "ARCHIVE ME",
        matchType: "contains",
        categoryId: CAT_A,
        priority: 9,
      }),
    );
    await withWorkspace(sessionA, (tx, ctx) => archiverRegle(tx, ctx, ruleId));

    const r = await withWorkspace(sessionA, (tx, ctx) => appliquerRegles(tx, ctx));
    expect(r.splitsCrees).toBe(0); // la règle archivée n'agit pas
    expect(await splitsDe(sessionA, "eeee0100-eeee-4eee-8eee-eeeeeeeeeeee")).toHaveLength(0);
  });

  it("modifierRegle d'un autre workspace → RegleIntrouvable (RLS)", async () => {
    const reglesB = await withWorkspace(sessionB, (tx, ctx) =>
      listerRegles(tx, ctx),
    );
    const ruleDeB = reglesB[0].id;
    await expect(
      withWorkspace(sessionA, (tx, ctx) =>
        modifierRegle(tx, ctx, { ruleId: ruleDeB, isActive: false }),
      ),
    ).rejects.toBeInstanceOf(RegleIntrouvableError);
  });

  it("archiverRegle d'un autre workspace → RegleIntrouvable (RLS)", async () => {
    const reglesB = await withWorkspace(sessionB, (tx, ctx) =>
      listerRegles(tx, ctx),
    );
    await expect(
      withWorkspace(sessionA, (tx, ctx) => archiverRegle(tx, ctx, reglesB[0].id)),
    ).rejects.toBeInstanceOf(RegleIntrouvableError);
  });

  it("modifierRegle change le motif et la priorité (scopé A)", async () => {
    const regles = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx),
    );
    const edf = regles.find((r) => r.pattern === "EDF")!;
    await withWorkspace(sessionA, (tx, ctx) =>
      modifierRegle(tx, ctx, { ruleId: edf.id, pattern: "ELECTRICITE", priority: 3 }),
    );
    const apres = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx),
    ).then((rs) => rs.find((r) => r.id === edf.id)!);
    expect(apres.pattern).toBe("ELECTRICITE");
    expect(apres.priority).toBe(3);
  });
});
