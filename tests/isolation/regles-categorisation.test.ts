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
  OrdreReglesInvalideError,
  RegleIntrouvableError,
  RegleNonAutoriseeError,
  reordonnerRegles,
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
const sessionViewer = { userId: VICTOR, activeWorkspaceId: WS_A }; // VIEWER de A

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

describe("autorisation d'authoring — VIEWER refusé AU SERVEUR (garde repository)", () => {
  // La garde peutModifier(ctx.role) est portée par le REPOSITORY (pattern
  // creerCategorie) → testable sous RLS réelle, rôle résolu depuis workspace_members.
  // VICTOR est VIEWER de A. Le rôle est vérifié AVANT l'existence (anti-oracle).
  it("VIEWER ne peut PAS créer une règle (RegleNonAutorisee)", async () => {
    await expect(
      withWorkspace(sessionViewer, (tx, ctx) =>
        creerRegle(tx, ctx, {
          pattern: "INTERDIT",
          matchType: "contains",
          categoryId: CAT_A,
        }),
      ),
    ).rejects.toBeInstanceOf(RegleNonAutoriseeError);
  });

  it("VIEWER ne peut PAS modifier une règle (rôle AVANT existence : id bidon → NonAutorisee)", async () => {
    // Un VIEWER n'apprend même pas si la règle existe : la garde de rôle précède le
    // check d'existence. On vise volontairement un id inexistant → pas RULE_NOT_FOUND.
    await expect(
      withWorkspace(sessionViewer, (tx, ctx) =>
        modifierRegle(tx, ctx, {
          ruleId: "99999999-9999-4999-8999-999999999999",
          isActive: false,
        }),
      ),
    ).rejects.toBeInstanceOf(RegleNonAutoriseeError);
  });

  it("VIEWER ne peut PAS archiver une règle (RegleNonAutorisee)", async () => {
    const regleA = await withWorkspace(sessionA, (tx, ctx) => listerRegles(tx, ctx));
    await expect(
      withWorkspace(sessionViewer, (tx, ctx) =>
        archiverRegle(tx, ctx, regleA[0].id),
      ),
    ).rejects.toBeInstanceOf(RegleNonAutoriseeError);
  });

  it("VIEWER ne peut PAS réordonner (gouvernance — RegleNonAutorisee)", async () => {
    const regleA = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    await expect(
      withWorkspace(sessionViewer, (tx, ctx) =>
        reordonnerRegles(
          tx,
          ctx,
          regleA.map((r) => r.id),
        ),
      ),
    ).rejects.toBeInstanceOf(RegleNonAutoriseeError);
  });
});

describe("réactivation via modifierRegle (isActive=true)", () => {
  it("une règle archivée puis réactivée redevient active ET ré-applicable", async () => {
    // Nouvelle txn non catégorisée + règle dédiée, archivée avant application.
    await client.exec(`reset role;`);
    await client.exec(`
      insert into transactions_cache
        (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,clean_label) values
        ('eeee0200-eeee-4eee-8eee-eeeeeeeeeeee','${WS_A}','${ACCT_A}','t-react','${DATE}','${DATE}T08:00:00Z','-42.00','MUR','Debit','REACTIVE ME');
    `);
    await client.exec(`set role tygr_app;`);

    const { ruleId } = await withWorkspace(sessionA, (tx, ctx) =>
      creerRegle(tx, ctx, {
        pattern: "REACTIVE ME",
        matchType: "contains",
        categoryId: CAT_A,
      }),
    );
    await withWorkspace(sessionA, (tx, ctx) => archiverRegle(tx, ctx, ruleId));

    // Archivée : n'apparaît plus dans les actives.
    const activesApresArchive = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    expect(activesApresArchive.some((r) => r.id === ruleId)).toBe(false);

    // Réactivation via l'édition.
    await withWorkspace(sessionA, (tx, ctx) =>
      modifierRegle(tx, ctx, { ruleId, isActive: true }),
    );
    const activesApresReactive = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    expect(activesApresReactive.some((r) => r.id === ruleId)).toBe(true);

    // Et elle catégorise à nouveau (preuve fonctionnelle de la réactivation).
    const r = await withWorkspace(sessionA, (tx, ctx) =>
      appliquerRegles(tx, ctx, { bankAccountId: ACCT_A }),
    );
    expect(r.splitsCrees).toBeGreaterThanOrEqual(1);
    expect(
      await splitsDe(sessionA, "eeee0200-eeee-4eee-8eee-eeeeeeeeeeee"),
    ).toHaveLength(1);
  });
});

describe("réordonnancement — priorité (drag/flèches)", () => {
  // Un workspace DÉDIÉ (WS_R) pour maîtriser l'ensemble exact des règles actives
  // (l'égalité d'ensembles porte sur TOUTES les actives du workspace).
  const WS_R = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const CAROL = "44444444-4444-4444-8444-444444444444"; // MANAGER de R
  const sessionR = { userId: CAROL, activeWorkspaceId: WS_R };
  const ACCT_R = "dddd0003-dddd-4ddd-8ddd-dddddddddddd";
  const CAT_R1 = "cccc1111-cccc-4ccc-8ccc-cccccccccccc";
  const CAT_R2 = "cccc2222-cccc-4ccc-8ccc-cccccccccccc";
  let idFoo = "";
  let idFooBar = "";

  it("prépare WS_R : 2 règles actives qui CHEVAUCHENT le même libellé", async () => {
    await client.exec(`reset role;`);
    await client.exec(`
      insert into workspaces (id,name,kind,omnifi_client_user_id) values
        ('${WS_R}','BU R','INTERNAL_BU','eu-r');
      insert into users (id,email,full_name) values ('${CAROL}','c@g.mu','Carol');
      insert into workspace_members (user_id,workspace_id,role) values ('${CAROL}','${WS_R}','MANAGER');
      insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,created_by) values
        ('cccc0003-cccc-4ccc-8ccc-cccccccccccc','${WS_R}','c-r','mcb','${CAROL}');
      insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
        ('${ACCT_R}','${WS_R}','cccc0003-cccc-4ccc-8ccc-cccccccccccc','a-r','CC','MUR');
      insert into categories (id,workspace_id,name) values
        ('${CAT_R1}','${WS_R}','R-Un'), ('${CAT_R2}','${WS_R}','R-Deux');
    `);
    await client.exec(`set role tygr_app;`);

    // Deux motifs qui matchent tous deux « FOO BAR SHOP » : « FOO » (→CAT_R1) et
    // « FOO BAR » (→CAT_R2). L'ordre décide lequel gagne.
    idFoo = (
      await withWorkspace(sessionR, (tx, ctx) =>
        creerRegle(tx, ctx, { pattern: "FOO", matchType: "contains", categoryId: CAT_R1 }),
      )
    ).ruleId;
    idFooBar = (
      await withWorkspace(sessionR, (tx, ctx) =>
        creerRegle(tx, ctx, { pattern: "FOO BAR", matchType: "contains", categoryId: CAT_R2 }),
      )
    ).ruleId;

    // Défaut max+1 : priorités DISTINCTES (0 puis 1), jamais deux fois 0.
    const regles = await withWorkspace(sessionR, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    const prios = regles.map((r) => r.priority).sort((a, b) => a - b);
    expect(prios).toEqual([0, 1]);
  });

  it("ordre initial (FOO en tête) : la règle FOO gagne le chevauchement", async () => {
    // FOO créée en premier → priority 0 → en tête → gagne.
    await withWorkspace(sessionR, (tx, ctx) =>
      reordonnerRegles(tx, ctx, [idFoo, idFooBar]),
    );
    await client.exec(`reset role;`);
    await client.exec(`
      insert into transactions_cache
        (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,clean_label) values
        ('eeee0301-eeee-4eee-8eee-eeeeeeeeeeee','${WS_R}','${ACCT_R}','t-r1','${DATE}','${DATE}T08:00:00Z','-11.00','MUR','Debit','FOO BAR SHOP');
    `);
    await client.exec(`set role tygr_app;`);

    await withWorkspace(sessionR, (tx, ctx) => appliquerRegles(tx, ctx));
    const s = await splitsDe(sessionR, "eeee0301-eeee-4eee-8eee-eeeeeeeeeeee");
    expect(s).toHaveLength(1);
    expect(s[0].categoryId).toBe(CAT_R1); // FOO a gagné
    expect(s[0].ruleId).toBe(idFoo);
  });

  it("après réordonnancement (FOO BAR en tête) : c'est FOO BAR qui gagne (l'ordre décide)", async () => {
    // On inverse l'ordre → FOO BAR devient priority 0.
    await withWorkspace(sessionR, (tx, ctx) =>
      reordonnerRegles(tx, ctx, [idFooBar, idFoo]),
    );
    // Densité : priorités normalisées 0,1 dans le nouvel ordre.
    const regles = await withWorkspace(sessionR, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    const parId = new Map(regles.map((r) => [r.id, r.priority]));
    expect(parId.get(idFooBar)).toBe(0);
    expect(parId.get(idFoo)).toBe(1);

    // NOUVELLE txn identique (l'ancienne est déjà splittée, exclue par NOT EXISTS).
    await client.exec(`reset role;`);
    await client.exec(`
      insert into transactions_cache
        (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,clean_label) values
        ('eeee0302-eeee-4eee-8eee-eeeeeeeeeeee','${WS_R}','${ACCT_R}','t-r2','${DATE}','${DATE}T08:00:00Z','-12.00','MUR','Debit','FOO BAR SHOP');
    `);
    await client.exec(`set role tygr_app;`);

    await withWorkspace(sessionR, (tx, ctx) => appliquerRegles(tx, ctx));
    const s = await splitsDe(sessionR, "eeee0302-eeee-4eee-8eee-eeeeeeeeeeee");
    expect(s).toHaveLength(1);
    expect(s[0].categoryId).toBe(CAT_R2); // FOO BAR gagne désormais
    expect(s[0].ruleId).toBe(idFooBar);
  });

  it("ATOMICITÉ + égalité d'ensembles : un ordre INCOMPLET est rejeté SANS rien écrire", async () => {
    // Ordre = un sous-ensemble (une seule des deux règles actives) → mismatch.
    // Vérifie qu'aucune priorité n'a bougé (état d'origine 0,1 préservé).
    const avant = await withWorkspace(sessionR, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    const prioAvant = new Map(avant.map((r) => [r.id, r.priority]));

    await expect(
      withWorkspace(sessionR, (tx, ctx) => reordonnerRegles(tx, ctx, [idFooBar])),
    ).rejects.toBeInstanceOf(OrdreReglesInvalideError);

    const apres = await withWorkspace(sessionR, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    for (const r of apres) {
      expect(r.priority).toBe(prioAvant.get(r.id)); // inchangé
    }
  });

  it("égalité d'ensembles : un ordre contenant un id ARCHIVÉ est rejeté", async () => {
    // On archive FOO BAR (n'est plus dans l'ensemble actif), puis on tente un ordre
    // qui l'inclut → mismatch (l'ordre doit être EXACTEMENT les actives).
    await withWorkspace(sessionR, (tx, ctx) => archiverRegle(tx, ctx, idFooBar));
    await expect(
      withWorkspace(sessionR, (tx, ctx) =>
        reordonnerRegles(tx, ctx, [idFoo, idFooBar]),
      ),
    ).rejects.toBeInstanceOf(OrdreReglesInvalideError);
    // Réordonner juste l'actif restant (idFoo seul) réussit.
    await withWorkspace(sessionR, (tx, ctx) => reordonnerRegles(tx, ctx, [idFoo]));
    const actives = await withWorkspace(sessionR, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    expect(actives).toHaveLength(1);
    expect(actives[0].priority).toBe(0);
    // Restaure pour l'isolation du test suivant.
    await withWorkspace(sessionR, (tx, ctx) =>
      modifierRegle(tx, ctx, { ruleId: idFooBar, isActive: true }),
    );
  });

  it("anti-IDOR par ensembles : un ordre incluant une règle d'un AUTRE tenant est rejeté ; l'autre tenant intact", async () => {
    // Une règle de A (WS_A) glissée dans l'ordre de R → invisible sous RLS de R,
    // donc absente de l'ensemble actif de R → cardinalité ≠ → mismatch. Et AUCUNE
    // règle de A n'est modifiée.
    const regleDeA = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    const idDeA = regleDeA[0].id;
    const prioDeA_avant = regleDeA[0].priority;

    const activesR = await withWorkspace(sessionR, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    );
    await expect(
      withWorkspace(sessionR, (tx, ctx) =>
        reordonnerRegles(tx, ctx, [...activesR.map((r) => r.id), idDeA]),
      ),
    ).rejects.toBeInstanceOf(OrdreReglesInvalideError);

    // La règle de A n'a pas bougé.
    const regleDeA_apres = await withWorkspace(sessionA, (tx, ctx) =>
      listerRegles(tx, ctx, { actives: true }),
    ).then((rs) => rs.find((r) => r.id === idDeA)!);
    expect(regleDeA_apres.priority).toBe(prioDeA_avant);
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

// ── FB0709-REGLES-CASSE1 : le matching règle ↔ libellé est INSENSIBLE À LA CASSE ─
// Le plan (B4) posait que le matching est DÉJÀ insensible à la casse (ILIKE) et que
// les règles ciblent les catégories par UUID — la « casse » perçue par Etienne
// venait des DOUBLONS de catégories (réglés en B2), pas du moteur. Ce bloc le PROUVE
// explicitement dans les deux sens : motif MAJUSCULE vs libellé minuscule ET
// l'inverse. On isole sur un compte dédié (ACCT_CASSE) + appliquerRegles borné.
describe("FB0709-REGLES-CASSE1 : matching insensible à la casse (ILIKE)", () => {
  const ACCT_CASSE = "dddd9999-dddd-4ddd-8ddd-dddddddddddd";
  const TXN_MAJ = "eeee9001-eeee-4eee-8eee-eeeeeeeeeeee"; // libellé MAJUSCULE, motif minuscule
  const TXN_MIN = "eeee9002-eeee-4eee-8eee-eeeeeeeeeeee"; // libellé minuscule, motif MAJUSCULE

  beforeAll(async () => {
    // Insert owner (comme le seed global) : compte + 2 transactions de casses opposées.
    await client.exec(`reset role;`);
    await client.exec(`
      insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
        ('${ACCT_CASSE}','${WS_A}','cccc0001-cccc-4ccc-8ccc-cccccccccccc','a-casse','CC','MUR');
      insert into transactions_cache
        (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label) values
        ('${TXN_MAJ}','${WS_A}','${ACCT_CASSE}','t-maj','${DATE}','${DATE}T08:00:00Z','-100.00','MUR','Debit','RAW','PAIEMENT NETFLIX'),
        ('${TXN_MIN}','${WS_A}','${ACCT_CASSE}','t-min','${DATE}','${DATE}T08:00:00Z','-200.00','MUR','Debit','RAW','abonnement spotify');
    `);
    await client.exec(`set role tygr_app;`);
  });

  it("motif MINUSCULE « netflix » matche un libellé MAJUSCULE « PAIEMENT NETFLIX »", async () => {
    await withWorkspace(sessionA, (tx, ctx) =>
      creerRegle(tx, ctx, { pattern: "netflix", matchType: "contains", categoryId: CAT_A }),
    );
    await withWorkspace(sessionA, (tx, ctx) =>
      appliquerRegles(tx, ctx, { bankAccountId: ACCT_CASSE }),
    );
    const s = await splitsDe(sessionA, TXN_MAJ);
    expect(s).toHaveLength(1);
    expect(s[0].categoryId).toBe(CAT_A);
    expect(s[0].source).toBe("RULE");
  });

  it("motif MAJUSCULE « SPOTIFY » matche un libellé minuscule « abonnement spotify »", async () => {
    await withWorkspace(sessionA, (tx, ctx) =>
      creerRegle(tx, ctx, { pattern: "SPOTIFY", matchType: "contains", categoryId: CAT_A2 }),
    );
    await withWorkspace(sessionA, (tx, ctx) =>
      appliquerRegles(tx, ctx, { bankAccountId: ACCT_CASSE }),
    );
    const s = await splitsDe(sessionA, TXN_MIN);
    expect(s).toHaveLength(1);
    expect(s[0].categoryId).toBe(CAT_A2);
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
