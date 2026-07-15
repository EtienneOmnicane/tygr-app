/**
 * Suite isolation — AMPUTATION DU viewFilter sur les surfaces de GESTION (TOOLBAR-
 * PERIMETRE-AMPUTATION1). Prouve, sur Postgres réel (PGlite) + migrations + provisioning
 * réels, exécution sous `tygr_app` NON-propriétaire, la CORRECTION apportée par le passage
 * de `exigerSessionWorkspace` (session complète) à `exigerSessionSansPerimetre` (session
 * amputée) sur `/banques` et `/regles`.
 *
 * Le mécanisme : le `viewFilter` (sélecteur « Périmètre », L8b-1) est posé par
 * `withWorkspace` en GUC `app.current_view_filter`, consommé par la 2ᵉ clause AND des
 * policies `account_scope` (0016/0017, RESTRICTIVE FOR ALL, USING **et** WITH CHECK). Une
 * session qui le porte RÉTRÉCIT lecture ET écriture de `bank_accounts` (et de ses filles) ;
 * une session amputée ne pose jamais le GUC → clause neutre → tout le DROIT dur.
 *
 * ⚠️ Contrainte du harnais (déjà assumée par la suite `account-scope-isolation` #ent) : on
 * ne peut PAS appeler les Server Actions (runtime Next). On teste la COMPOSITION
 * ÉQUIVALENTE — la SEULE différence entre les deux mondes est la session passée à
 * `withWorkspace` : `{userId, activeWorkspaceId, viewFilter}` (ce que faisait
 * `exigerSessionWorkspace`) vs `{userId, activeWorkspaceId}` (ce que fait
 * `exigerSessionSansPerimetre`). C'est exactement ce que change le correctif.
 *
 * Cas prouvés :
 *   #regles-repro  Sous un viewFilter actif, `appliquerRegles` (INNER JOIN bank_accounts)
 *                  ne recatégorise QUE le compte filtré → « Ré-analyser » partiel (le bug).
 *   #regles-fix    Session AMPUTÉE → `appliquerRegles` recatégorise TOUT le tenant.
 *   #banques-repro Sous un viewFilter actif, l'INSERT d'un compte hors filtre est REFUSÉ
 *                  (WITH CHECK) → « sync qui attache 0 compte sans erreur » (le bug).
 *   #banques-fix   Session AMPUTÉE → l'INSERT passe : tous les comptes d'une connexion
 *                  s'attachent.
 *   #secu          L'amputation ne touche PAS `tenant_isolation` : un WHERE forgé visant
 *                  WS_B renvoie 0 ligne (le filtre ne fait que RÉTRÉCIR, jamais élargir).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { bankAccounts, transactionCategorizations } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { appliquerRegles } from "@/server/repositories/regles-categorisation";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes ───────────────────────────────────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_A = "11111111-1111-4111-8111-111111111111"; // Vision Globale (aucun user_scope)
const BOB_B = "22222222-2222-4222-8222-222222222222"; // témoin WS_B
// Membre WS_A RÉELLEMENT scopé EN BASE (user_scopes=[ACC_1]) — prouve que l'amputation
// n'élargit QUE jusqu'au droit dur (étage 2), jamais au-delà (« risque n°1 »).
const BOB_SCOPE = "33333333-3333-4333-8333-333333333333";

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ACC_1 = "acc00001-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // dans le filtre
const ACC_2 = "acc00002-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // HORS filtre (même connexion)
const ACC_3 = "acc00003-cccc-4ccc-8ccc-cccccccccccc"; // « nouveau compte » du sync
const ACC_B = "acc0bbbb-eeee-4eee-8eee-eeeeeeeeeeee"; // témoin WS_B

const CAT = "ca700000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RULE = "4e700000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const T1 = "77770001-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // sur ACC_1, matche la règle
const T2 = "77770002-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // sur ACC_2, matche la règle
const DATE = "2026-03-15";

// Les deux sessions que le correctif oppose : filtrée (ancien comportement) vs amputée.
const sessAmputee = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessFiltre = { userId: ADMIN_A, activeWorkspaceId: WS_A, viewFilter: [ACC_1] };

/** Splits d'une transaction, lus sous une session AMPUTÉE (voit tout le tenant). */
async function splitsDe(txnId: string): Promise<{ ruleId: string | null }[]> {
  return withWorkspace(sessAmputee, (tx) =>
    tx
      .select({ ruleId: transactionCategorizations.ruleId })
      .from(transactionCategorizations)
      .where(
        and(
          eq(transactionCategorizations.transactionId, txnId),
          eq(transactionCategorizations.transactionDate, DATE),
        ),
      ),
  );
}

// Déplie la chaîne des causes (Drizzle enveloppe les erreurs driver RLS/CHECK).
const flatten = (e: unknown): string => {
  let msg = "";
  let cur: unknown = e;
  while (cur instanceof Error) {
    msg += cur.message + " | ";
    cur = cur.cause;
  }
  return msg;
};

beforeAll(async () => {
  // 1. Migrations réelles (0016/0017 incluses → policy account_scope + filles).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde structurelle : account_scope RESTRICTIVE FOR ALL, USING == WITH CHECK.
  //    Sans elle, la suite croirait à un filtre prouvé alors qu'il ne mord pas.
  const pol = await client.query<{
    permissive: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `select permissive, cmd, qual, with_check from pg_policies
       where tablename = 'bank_accounts' and policyname = 'account_scope'`,
  );
  const p = pol.rows[0];
  if (!p) throw new Error("Policy account_scope absente de bank_accounts.");
  if (p.permissive !== "RESTRICTIVE" || p.cmd !== "ALL")
    throw new Error(`account_scope doit être RESTRICTIVE FOR ALL — ${p.permissive}/${p.cmd}.`);
  if (!p.qual || !p.with_check || p.qual !== p.with_check)
    throw new Error("account_scope : USING doit être identique à WITH CHECK.");

  // 3. Seed (owner, bypass RLS). WS_A : ADMIN Vision Globale ; 1 connexion ; 2 comptes
  //    ACC_1/ACC_2 (même connexion) ; 1 catégorie ; 1 règle ACTIVE « EDF » ; 1 txn non
  //    catégorisée matchant la règle SUR CHAQUE compte. WS_B : témoin cross-tenant.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${BOB_SCOPE}','scoped@a.mu','Bob Scopé'),
      ('${BOB_B}','b@b.mu','Bob B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${BOB_SCOPE}','${WS_A}','MANAGER'),
      ('${BOB_B}','${WS_B}','MANAGER');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency) values
      ('${ACC_1}','${WS_A}','${CONN_A}','oa-1','Compte 1','MUR'),
      ('${ACC_2}','${WS_A}','${CONN_A}','oa-2','Compte 2','MUR'),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR');
    insert into categories (id, workspace_id, name) values
      ('${CAT}','${WS_A}','Énergie');
    insert into categorization_rules (id, workspace_id, pattern, match_type, category_id, priority, is_active, created_by) values
      ('${RULE}','${WS_A}','EDF','contains','${CAT}',0,true,'${ADMIN_A}');
    insert into transactions_cache
      (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, clean_label) values
      ('${T1}','${WS_A}','${ACC_1}','t-1','${DATE}','${DATE}T08:00:00Z','-1200.00','MUR','Debit','RAW1','EDF Facture'),
      ('${T2}','${WS_A}','${ACC_2}','t-2','${DATE}','${DATE}T08:00:00Z','-3400.00','MUR','Debit','RAW2','EDF Boutique');
    -- Octroi de périmètre DUR (compte) : BOB_SCOPE ne peut voir/écrire que ACC_1.
    insert into user_scopes (workspace_id, user_id, bank_account_id) values
      ('${WS_A}','${BOB_SCOPE}','${ACC_1}');
  `);

  // 4. Rôle applicatif non-propriétaire (source unique : provisioning prod).
  await client.exec(
    readFileSync(path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"), "utf8"),
  );
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

describe("préconditions", () => {
  it("0. requêtes sous tygr_app (sinon RLS ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });

  it("pré-état : ni T1 ni T2 n'ont de split", async () => {
    expect(await splitsDe(T1)).toHaveLength(0);
    expect(await splitsDe(T2)).toHaveLength(0);
  });
});

describe("#regles — « Ré-analyser » : le viewFilter le rendait PARTIEL", () => {
  it("REPRO : sous viewFilter=[ACC_1], appliquerRegles ne catégorise QUE ACC_1 (T1)", async () => {
    // appliquerRegles fait un INNER JOIN bank_accounts → sous le filtre, seuls les
    // candidats de ACC_1 sont vus. T2 (ACC_2, hors filtre) n'est même pas candidat.
    const r = await withWorkspace(sessFiltre, (tx, ctx) => appliquerRegles(tx, ctx));
    expect(r.transactionsCategorisees).toBe(1);
    expect(await splitsDe(T1)).toHaveLength(1); // ACC_1 catégorisé
    expect(await splitsDe(T2)).toHaveLength(0); // ACC_2 LAISSÉ (le bug : ré-analyse partielle)
  });

  it("FIX : session AMPUTÉE, appliquerRegles rattrape ACC_2 (T2) — tout le tenant", async () => {
    // Le correctif (exigerSessionSansPerimetre) ne pose pas app.current_view_filter →
    // T2 redevient candidat. T1 est idempotent (déjà splitté) → on ne traite que T2.
    const r = await withWorkspace(sessAmputee, (tx, ctx) => appliquerRegles(tx, ctx));
    expect(r.transactionsCategorisees).toBe(1); // le compte que le filtre avait manqué
    // Désormais LES DEUX comptes sont catégorisés (portée = tout le tenant).
    expect(await splitsDe(T1)).toHaveLength(1);
    expect(await splitsDe(T2)).toHaveLength(1);
  });
});

describe("#banques — sync : le viewFilter faisait attacher 0 compte SANS erreur", () => {
  it("REPRO : sous viewFilter=[ACC_1], l'INSERT d'un compte hors filtre (ACC_3) est REFUSÉ (WITH CHECK)", async () => {
    // Le pendant « écriture » : l'état résultant (un compte hors app.current_view_filter)
    // viole WITH CHECK → l'INSERT lève. Côté sync réel, l'erreur était avalée en fail-soft
    // → comptesRattaches tombait à 0 « sans erreur » visible (« spinner puis rien »).
    let thrown: unknown = null;
    try {
      await withWorkspace(sessFiltre, (tx) =>
        tx.insert(bankAccounts).values({
          id: ACC_3,
          workspaceId: WS_A,
          connectionId: CONN_A,
          omnifiAccountId: "oa-3",
          accountName: "Compte 3 (découvert)",
          currency: "MUR",
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "INSERT hors filtre doit violer WITH CHECK").not.toBeNull();
    expect(flatten(thrown)).toMatch(/policy|row-level|violates|check/i);
    // Contre-preuve : le compte n'existe pas (rien n'a été attaché).
    const vus = await withWorkspace(sessAmputee, (tx) =>
      tx.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.id, ACC_3)),
    );
    expect(vus).toHaveLength(0);
  });

  it("FIX : session AMPUTÉE, l'INSERT de ACC_3 passe (tous les comptes de la connexion s'attachent)", async () => {
    await withWorkspace(sessAmputee, (tx) =>
      tx.insert(bankAccounts).values({
        id: ACC_3,
        workspaceId: WS_A,
        connectionId: CONN_A,
        omnifiAccountId: "oa-3",
        accountName: "Compte 3 (découvert)",
        currency: "MUR",
      }),
    );
    const vus = await withWorkspace(sessAmputee, (tx) =>
      tx.select({ id: bankAccounts.id }).from(bankAccounts).where(eq(bankAccounts.id, ACC_3)),
    );
    expect(vus).toEqual([{ id: ACC_3 }]);
  });
});

describe("#secu — l'amputation ne touche PAS l'étage 1 (tenant_isolation)", () => {
  it("session amputée : un WHERE forgé visant WS_B renvoie 0 ligne", async () => {
    // L'amputation retire le filtre d'affichage, JAMAIS la frontière tenant : le DROIT dur
    // (workspace_id) reste posé. Le filtre ne peut que RÉTRÉCIR, jamais élargir cross-tenant.
    const r = await withWorkspace(sessAmputee, (tx) =>
      tx.execute(sql`select id from bank_accounts where workspace_id = ${WS_B}`),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("session amputée : ne voit QUE les comptes de WS_A (jamais ACC_B)", async () => {
    const vus = await withWorkspace(sessAmputee, (tx) =>
      tx.select({ id: bankAccounts.id }).from(bankAccounts).orderBy(bankAccounts.id),
    );
    const ids = vus.map((l) => l.id);
    expect(ids).toContain(ACC_1);
    expect(ids).toContain(ACC_2);
    expect(ids).not.toContain(ACC_B); // étage 1 intact
  });
});

describe("#secu-etage2 — un membre scopé EN BASE reste borné même AMPUTÉ (droit dur ≠ filtre)", () => {
  // LE cas qui verrouille le « risque n°1 » : l'amputation retire le FILTRE d'affichage
  // (`app.current_view_filter`, session), JAMAIS le DROIT DUR (`account_scope`, résolu
  // depuis `user_scopes` EN BASE). Elle n'élargit donc que jusqu'au droit, jamais au-delà.
  // Sans ce cas, une régression future qui résoudrait account_scope depuis la SESSION
  // resterait invisible (le cas #secu, purement tenant, resterait vert).
  const sessScopeAmpute = { userId: BOB_SCOPE, activeWorkspaceId: WS_A };

  it("amputé (aucun viewFilter), un membre user_scopes=[ACC_1] voit ACC_1 SEUL — jamais ACC_2", async () => {
    const vus = await withWorkspace(sessScopeAmpute, (tx) =>
      tx.select({ id: bankAccounts.id }).from(bankAccounts).orderBy(bankAccounts.id),
    );
    const ids = vus.map((l) => l.id);
    expect(ids).toEqual([ACC_1]); // borné à son droit dur…
    expect(ids).not.toContain(ACC_2); // …dans le tenant, mais hors de son droit
    expect(ids).not.toContain(ACC_B); // …et cross-tenant (étage 1)
  });

  it("son ctx.accountScope dérive de user_scopes EN BASE (COMPTES [ACC_1]), pas de la session", async () => {
    const scope = await withWorkspace(sessScopeAmpute, async (_tx, ctx) => ctx.accountScope);
    expect(scope).toEqual({ mode: "COMPTES", accountIds: [ACC_1] });
  });

  it("ÉCRITURE : amputé, il ne peut PAS UPDATE un compte hors droit (ACC_2) → 0 ligne (USING)", async () => {
    // L'amputation n'ouvre pas l'écriture hors droit : la policy account_scope (USING) masque
    // ACC_2 pour ce membre → l'UPDATE ne matche rien (droit dur préservé côté écriture aussi).
    const maj = await withWorkspace(sessScopeAmpute, (tx) =>
      tx
        .update(bankAccounts)
        .set({ accountName: "PIRATE" })
        .where(eq(bankAccounts.id, ACC_2))
        .returning({ id: bankAccounts.id }),
    );
    expect(maj).toHaveLength(0);
  });
});
