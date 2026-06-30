/**
 * Suite anti-IDOR — Périmètre party/compte EFFECTIF (L4, plan
 * PLAN-architecture-multi-tenant-omnicane.md §3.2 / §5). POINT NÉVRALGIQUE.
 *
 * Prouve sur Postgres réel (PGlite) la policy RLS `account_scope` (migration 0016)
 * + le résolveur de périmètre de withWorkspace (src/server/db/tenancy.ts) :
 *
 *   #1  Vision restreinte PARTY → comptes hors party = 0 ligne.
 *   #2  Vision restreinte COMPTE → seul ce compte ; autres comptes même party = 0.
 *   #3  Union party + compte hors-party → exactement comptes(party) ∪ {compte}.
 *   #4  Vision Globale (0 scope) → voit TOUS les comptes (non-régression).
 *   #5  ⭐ PÉRIMÈTRE VIDE (≥1 scope, DROIT ∅) → 0 ligne, PAS « voir tout »
 *       (prouve que la sentinelle UUID-nul n'inverse pas « vide → tout »).
 *   #6  ⭐ INGESTION en Vision Globale (GUC absent) → INSERT/UPDATE passent sous
 *       account_scope FOR ALL (non-régression couche sacrée).
 *   #7  ÉCRITURE hors périmètre → refus (USING + WITH CHECK).
 *   #aut ⭐ AUTO-RÉFÉRENCE : membre scopé par BU (member_entity_scopes) résout ses
 *       comptes SANS interaction parasite avec entity_scope déjà posé.
 *   #8  Compte sans party / entity_id NULL → invisible en restreint, visible Globale.
 *   #9  Étage 1 préservé : cross-tenant reste 0 ligne (account_scope n'affaiblit
 *       pas tenant_isolation).
 *   #10 view_filter INERTE en L4 : current_view_filter jamais posé ; clause neutre.
 *
 * Comme les autres suites : DDL = migrations réelles (drizzle/migrations/*.sql,
 * appliquées par NOM trié → 0016 incluse), rôle applicatif = provisioning prod,
 * exécution sous `tygr_app` NON-propriétaire (sinon la RLS est ignorée — test 0).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { bankAccounts, userScopes } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes (lisibilité des assertions) ───────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Membres WS_A : un ADMIN (Vision Globale) + quatre membres scopés.
const ADMIN_A = "11111111-1111-4111-8111-111111111111";
const MGR_PARTY = "22222222-2222-4222-8222-222222222222"; // scope party SUCRE
const MGR_COMPTE = "33333333-3333-4333-8333-333333333333"; // scope compte ACC_S1
const MGR_BU = "44444444-4444-4444-8444-444444444444"; // scope entité ENT_SUCRE
const MGR_VIDE = "55555555-5555-4555-8555-555555555555"; // scope party FANTOME (∅)
const BOB_B = "66666666-6666-4666-8666-666666666666"; // membre WS_B

// Entité (axe BU) — WS_A.
const ENT_SUCRE = "e0000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Parties WS_A (+ témoin WS_B).
const PARTY_SUCRE = "9a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARTY_HOLDING = "9b000000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PARTY_FANTOME = "9f000000-ffff-4fff-8fff-ffffffffffff"; // AUCUN compte lié → DROIT ∅
const PARTY_B = "9c000000-cccc-4ccc-8ccc-cccccccccccc"; // WS_B

// Comptes WS_A (+ témoin WS_B).
const ACC_S1 = "acc05100-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // party SUCRE + entity ENT_SUCRE
const ACC_S2 = "acc05200-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // party SUCRE
const ACC_H = "acc00100-cccc-4ccc-8ccc-cccccccccccc"; // party HOLDING
const ACC_ORPHELIN = "acc00200-dddd-4ddd-8ddd-dddddddddddd"; // SANS party, entity_id NULL
const ACC_B = "acc0bbbb-eeee-4eee-8eee-eeeeeeeeeeee"; // WS_B

const CONN_A = "c0aa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "c0bb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sessAdmin = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessParty = { userId: MGR_PARTY, activeWorkspaceId: WS_A };
const sessCompte = { userId: MGR_COMPTE, activeWorkspaceId: WS_A };
const sessBu = { userId: MGR_BU, activeWorkspaceId: WS_A };
const sessVide = { userId: MGR_VIDE, activeWorkspaceId: WS_A };
const sessB = { userId: BOB_B, activeWorkspaceId: WS_B };

/** Tous les bank_accounts.id visibles dans la session (via le résolveur + RLS). */
async function comptesVisibles(sess: {
  userId: string;
  activeWorkspaceId: string;
}): Promise<string[]> {
  const lignes = await withWorkspace(sess, (tx) =>
    tx.select({ id: bankAccounts.id }).from(bankAccounts).orderBy(bankAccounts.id),
  );
  return lignes.map((l) => l.id);
}

beforeAll(async () => {
  // 1. Migrations réelles, appliquées par NOM trié (0016 trie après 0015 → la policy
  //    account_scope est créée). Le DDL exact que la prod exécutera.
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou structurel : account_scope DOIT exister, RESTRICTIVE, cmd=ALL, sur
  //    bank_accounts, et son USING == WITH CHECK. Sans cela la suite croirait à un
  //    périmètre prouvé alors qu'il ne mord pas.
  const pol = await client.query<{
    policyname: string;
    permissive: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `select policyname, permissive, cmd, qual, with_check
       from pg_policies where tablename = 'bank_accounts' and policyname = 'account_scope'`,
  );
  const p = pol.rows[0];
  if (!p) throw new Error("Policy account_scope absente de bank_accounts.");
  if (p.permissive !== "RESTRICTIVE")
    throw new Error(`account_scope doit être RESTRICTIVE — trouvé ${p.permissive}.`);
  if (p.cmd !== "ALL")
    throw new Error(`account_scope doit être FOR ALL — trouvé cmd=${p.cmd}.`);
  if (!p.qual || !p.with_check || p.qual !== p.with_check)
    throw new Error("account_scope : USING doit être identique à WITH CHECK.");
  // entity_scope (0014) doit rester EN PLACE (coexistence, non touchée par L4).
  const ent = await client.query<{ policyname: string }>(
    `select policyname from pg_policies
       where tablename = 'bank_accounts' and policyname = 'entity_scope'`,
  );
  if (!ent.rows.some((r) => r.policyname === "entity_scope"))
    throw new Error("entity_scope a disparu — L4 ne doit PAS la toucher.");

  // 3. Seed owner (bypass RLS). WS_A : entité ENT_SUCRE ; parties SUCRE/HOLDING +
  //    FANTOME (sans comptes) ; comptes ACC_S1(party SUCRE, entity ENT_SUCRE),
  //    ACC_S2(party SUCRE), ACC_H(party HOLDING), ACC_ORPHELIN(sans party, NULL) ;
  //    account_party_role SUCRE→{S1,S2}, HOLDING→{H} ; scopes : MGR_PARTY→SUCRE,
  //    MGR_COMPTE→ACC_S1, MGR_BU→ENT_SUCRE (member_entity_scopes), MGR_VIDE→FANTOME.
  //    WS_B : témoins cross-tenant, AUCUN scope.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${MGR_PARTY}','party@a.mu','Mgr Party'),
      ('${MGR_COMPTE}','compte@a.mu','Mgr Compte'),
      ('${MGR_BU}','bu@a.mu','Mgr BU'),
      ('${MGR_VIDE}','vide@a.mu','Mgr Vide'),
      ('${BOB_B}','b@b.mu','Bob B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MGR_PARTY}','${WS_A}','MANAGER'),
      ('${MGR_COMPTE}','${WS_A}','MANAGER'),
      ('${MGR_BU}','${WS_A}','MANAGER'),
      ('${MGR_VIDE}','${WS_A}','MANAGER'),
      ('${BOB_B}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière BU');
    insert into parties (id, workspace_id, omnifi_party_id, name, is_active) values
      ('${PARTY_SUCRE}','${WS_A}','pid-suc','Société Sucrière',true),
      ('${PARTY_HOLDING}','${WS_A}','pid-hold','Holding',true),
      ('${PARTY_FANTOME}','${WS_A}','pid-fant','Party Fantôme',true),
      ('${PARTY_B}','${WS_B}','pid-b','Partie B',true);
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN_A}','${WS_A}','oc-a','mcb','${ADMIN_A}'),
      ('${CONN_B}','${WS_B}','oc-b','mcb','${BOB_B}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency, current_balance, is_selected, entity_id) values
      ('${ACC_S1}','${WS_A}','${CONN_A}','oa-s1','Sucre 1','MUR','1000.00',true,'${ENT_SUCRE}'),
      ('${ACC_S2}','${WS_A}','${CONN_A}','oa-s2','Sucre 2','MUR','2000.00',true,null),
      ('${ACC_H}','${WS_A}','${CONN_A}','oa-h','Holding','MUR','3000.00',true,null),
      ('${ACC_ORPHELIN}','${WS_A}','${CONN_A}','oa-orph','Orphelin','MUR','4000.00',true,null),
      ('${ACC_B}','${WS_B}','${CONN_B}','oa-b','Compte B','MUR','9999.00',true,null);
    insert into account_party_role (workspace_id, bank_account_id, party_id, ownership_type, is_primary) values
      ('${WS_A}','${ACC_S1}','${PARTY_SUCRE}','BUSINESS',true),
      ('${WS_A}','${ACC_S2}','${PARTY_SUCRE}','BUSINESS',true),
      ('${WS_A}','${ACC_H}','${PARTY_HOLDING}','BUSINESS',true);
    -- Octrois de périmètre (user_scopes : party XOR compte) + axe BU.
    insert into user_scopes (workspace_id, user_id, party_id) values
      ('${WS_A}','${MGR_PARTY}','${PARTY_SUCRE}'),
      ('${WS_A}','${MGR_VIDE}','${PARTY_FANTOME}');
    insert into user_scopes (workspace_id, user_id, bank_account_id) values
      ('${WS_A}','${MGR_COMPTE}','${ACC_S1}');
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${MGR_BU}','${ENT_SUCRE}');
  `);

  // 4. Rôle applicatif non-propriétaire (source unique : provisioning prod).
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

// Déplie la chaîne des causes (Drizzle enveloppe les erreurs driver RLS/FK/CHECK).
const flatten = (e: unknown): string => {
  let msg = "";
  let cur: unknown = e;
  while (cur instanceof Error) {
    msg += cur.message + " | ";
    cur = cur.cause;
  }
  return msg;
};

describe("préconditions", () => {
  it("0. requêtes sous tygr_app (sinon RLS ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

describe("#1 — Vision restreinte par PARTY", () => {
  it("MGR_PARTY (scope party Sucrière) voit S1+S2, jamais Holding ni Orphelin", async () => {
    const vus = await comptesVisibles(sessParty);
    expect(vus.sort()).toEqual([ACC_S1, ACC_S2].sort());
    expect(vus).not.toContain(ACC_H);
    expect(vus).not.toContain(ACC_ORPHELIN);
  });

  it("le ctx.accountScope expose le DROIT résolu (lisible, non-autoritaire)", async () => {
    const scope = await withWorkspace(sessParty, async (_tx, ctx) => ctx.accountScope);
    expect(scope.mode).toBe("COMPTES");
    if (scope.mode === "COMPTES") {
      expect(scope.accountIds.sort()).toEqual([ACC_S1, ACC_S2].sort());
    }
  });
});

describe("#2 — Vision restreinte par COMPTE", () => {
  it("MGR_COMPTE (scope ACC_S1) voit S1 SEUL ; S2 (même party) reste invisible", async () => {
    const vus = await comptesVisibles(sessCompte);
    expect(vus).toEqual([ACC_S1]);
    expect(vus).not.toContain(ACC_S2); // même party SUCRE, mais hors scope COMPTE
  });
});

describe("#3 — Union party + compte hors-party", () => {
  it("scope = party SUCRE + compte ACC_H (Holding) → exactement {S1, S2, H}", async () => {
    // On AJOUTE temporairement un octroi COMPTE (ACC_H) à MGR_PARTY, sous owner pour
    // ne pas dépendre d'un chemin d'écriture applicatif, puis on nettoie.
    await client.exec(`set role postgres;`);
    await client.exec(
      `insert into user_scopes (workspace_id, user_id, bank_account_id)
         values ('${WS_A}','${MGR_PARTY}','${ACC_H}');`,
    );
    await client.exec(`set role tygr_app;`);
    try {
      const vus = await comptesVisibles(sessParty);
      expect(vus.sort()).toEqual([ACC_S1, ACC_S2, ACC_H].sort());
      expect(vus).not.toContain(ACC_ORPHELIN);
    } finally {
      await client.exec(`set role postgres;`);
      await client.exec(
        `delete from user_scopes
           where user_id = '${MGR_PARTY}' and bank_account_id = '${ACC_H}';`,
      );
      await client.exec(`set role tygr_app;`);
    }
  });
});

describe("#4 — Vision Globale (non-régression)", () => {
  it("ADMIN_A (0 scope) voit les QUATRE comptes de WS_A", async () => {
    const vus = await comptesVisibles(sessAdmin);
    expect(vus.sort()).toEqual([ACC_S1, ACC_S2, ACC_H, ACC_ORPHELIN].sort());
  });

  it("son ctx.accountScope est GLOBALE et le GUC account_scope n'est PAS posé", async () => {
    const r = await withWorkspace(sessAdmin, async (tx, ctx) => {
      const guc = await tx.execute(
        sql`select current_setting('app.current_account_scope', true) as v`,
      );
      return {
        scope: ctx.accountScope,
        guc: (guc as unknown as { rows: { v: string | null }[] }).rows[0].v,
      };
    });
    expect(r.scope).toEqual({ mode: "GLOBALE" });
    // GUC jamais posé en Vision Globale → current_setting(..., true) renvoie '' ou null.
    expect(r.guc === null || r.guc === "").toBe(true);
  });
});

describe("#5 ⭐ — PÉRIMÈTRE VIDE (≥1 scope, DROIT ∅) → 0 ligne, PAS « voir tout »", () => {
  it("MGR_VIDE (scope party FANTOME, AUCUN compte lié) ne voit AUCUN compte", async () => {
    const vus = await comptesVisibles(sessVide);
    expect(vus).toEqual([]); // surtout PAS les 4 comptes du tenant
  });

  it("le résolveur pose la SENTINELLE UUID-nul (pas '' ni GUC absent)", async () => {
    const r = await withWorkspace(sessVide, async (tx, ctx) => {
      const guc = await tx.execute(
        sql`select current_setting('app.current_account_scope', true) as v`,
      );
      return {
        scope: ctx.accountScope,
        guc: (guc as unknown as { rows: { v: string | null }[] }).rows[0].v,
      };
    });
    // accountScope lisible = COMPTES avec une liste VIDE (≥1 scope mais DROIT ∅).
    expect(r.scope).toEqual({ mode: "COMPTES", accountIds: [] });
    // Le GUC porte la sentinelle UUID-nul — JAMAIS '' (qui ferait lever ''::uuid).
    expect(r.guc).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("#6 ⭐ — INGESTION en Vision Globale non bloquée (couche sacrée)", () => {
  it("un INSERT bank_accounts en session ADMIN (GUC absent) passe sous account_scope FOR ALL", async () => {
    const NOUVEAU = "acc09e00-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await withWorkspace(sessAdmin, (tx) =>
      tx.insert(bankAccounts).values({
        id: NOUVEAU,
        workspaceId: WS_A,
        connectionId: CONN_A,
        omnifiAccountId: "oa-new",
        accountName: "Nouveau",
        currency: "MUR",
        // entity_id NULL : exactement ce que fait l'ingestion (upsertCompte).
      }),
    );
    // La ligne existe bien (visible en Vision Globale).
    const vus = await comptesVisibles(sessAdmin);
    expect(vus).toContain(NOUVEAU);
    // Nettoyage (DELETE en liste blanche pour bank_accounts).
    await withWorkspace(sessAdmin, (tx) =>
      tx.delete(bankAccounts).where(eq(bankAccounts.id, NOUVEAU)),
    );
  });

  it("un UPDATE bank_accounts en Vision Globale passe (WITH CHECK court-circuité)", async () => {
    await withWorkspace(sessAdmin, (tx) =>
      tx
        .update(bankAccounts)
        .set({ accountName: "Sucre 1 (maj)" })
        .where(eq(bankAccounts.id, ACC_S1)),
    );
    const r = await withWorkspace(sessAdmin, (tx) =>
      tx
        .select({ name: bankAccounts.accountName })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, ACC_S1)),
    );
    expect(r[0].name).toBe("Sucre 1 (maj)");
    // Remise en état.
    await withWorkspace(sessAdmin, (tx) =>
      tx.update(bankAccounts).set({ accountName: "Sucre 1" }).where(eq(bankAccounts.id, ACC_S1)),
    );
  });
});

describe("#7 — ÉCRITURE hors périmètre refusée (USING + WITH CHECK)", () => {
  it("MGR_PARTY ne peut pas UPDATE un compte hors droit (ACC_H) → 0 ligne touchée (USING)", async () => {
    const maj = await withWorkspace(sessParty, (tx) =>
      tx
        .update(bankAccounts)
        .set({ accountName: "PIRATE" })
        .where(eq(bankAccounts.id, ACC_H))
        .returning({ id: bankAccounts.id }),
    );
    // La ligne ACC_H est hors scope → masquée par USING → le UPDATE ne matche rien.
    expect(maj).toHaveLength(0);
    // Contre-vérif : ACC_H n'a pas changé (vu par l'ADMIN).
    const r = await withWorkspace(sessAdmin, (tx) =>
      tx
        .select({ name: bankAccounts.accountName })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, ACC_H)),
    );
    expect(r[0].name).toBe("Holding");
  });

  it("MGR_PARTY ne peut pas CRÉER un compte hors de son droit → refus WITH CHECK", async () => {
    // Un membre scopé tente d'INSÉRER un nouveau compte. L'état RÉSULTANT (un compte
    // dont l'id n'est PAS dans sa liste account_scope autorisée) viole WITH CHECK →
    // l'INSERT est refusé. C'est le pendant « écriture » du masquage en lecture :
    // account_scope FOR ALL borne aussi la création, pas seulement le SELECT.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessParty, (tx) =>
        tx.insert(bankAccounts).values({
          id: "acc0d1e0-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workspaceId: WS_A,
          connectionId: CONN_A,
          omnifiAccountId: "oa-pir",
          accountName: "Pirate",
          currency: "MUR",
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "INSERT d'un compte hors droit doit violer WITH CHECK").not.toBeNull();
    expect(flatten(thrown)).toMatch(/policy|row-level|violates|check/i);
  });
});

describe("#aut ⭐ — AUTO-RÉFÉRENCE (axe BU résolu sans interaction parasite)", () => {
  it("MGR_BU (member_entity_scopes ENT_SUCRE) voit le SEUL compte d'entité ENT_SUCRE (ACC_S1)", async () => {
    // ACC_S1 est le seul bank_account.entity_id = ENT_SUCRE. Le résolveur traduit
    // l'axe BU en comptes AVANT de poser entity_scope → la lecture de bank_accounts
    // pendant la résolution voit l'état tenant BRUT (pas de filtre d'étage 2 actif).
    const vus = await comptesVisibles(sessBu);
    expect(vus).toEqual([ACC_S1]);
  });

  it("entity_scope ET account_scope sont tous deux posés et cohérents", async () => {
    const r = await withWorkspace(sessBu, async (tx, ctx) => {
      const ent = await tx.execute(
        sql`select current_setting('app.current_entity_scope', true) as v`,
      );
      const acc = await tx.execute(
        sql`select current_setting('app.current_account_scope', true) as v`,
      );
      return {
        entityScope: ctx.entityScope,
        accountScope: ctx.accountScope,
        entGuc: (ent as unknown as { rows: { v: string | null }[] }).rows[0].v,
        accGuc: (acc as unknown as { rows: { v: string | null }[] }).rows[0].v,
      };
    });
    // Axe BU : entity_scope = ENT_SUCRE ; account_scope = le compte traduit (ACC_S1).
    expect(r.entityScope).toEqual({ mode: "ENTITES", entityIds: [ENT_SUCRE] });
    expect(r.accountScope).toEqual({ mode: "COMPTES", accountIds: [ACC_S1] });
    expect(r.entGuc).toBe(ENT_SUCRE);
    expect(r.accGuc).toBe(ACC_S1);
  });
});

describe("#8 — Compte sans party / entity_id NULL", () => {
  it("ACC_ORPHELIN (sans party, entity NULL) est INVISIBLE pour MGR_PARTY", async () => {
    const vus = await comptesVisibles(sessParty);
    expect(vus).not.toContain(ACC_ORPHELIN);
  });

  it("…mais VISIBLE pour l'ADMIN (Vision Globale)", async () => {
    const vus = await comptesVisibles(sessAdmin);
    expect(vus).toContain(ACC_ORPHELIN);
  });
});

describe("#9 — Étage 1 préservé (account_scope n'affaiblit pas tenant_isolation)", () => {
  it("session A (ADMIN, Vision Globale) ne voit AUCUN compte de WS_B", async () => {
    const vus = await comptesVisibles(sessAdmin);
    expect(vus).not.toContain(ACC_B);
  });

  it("WHERE forgé visant les comptes de B depuis A → 0 ligne", async () => {
    const r = await withWorkspace(sessAdmin, (tx) =>
      tx.execute(sql`select id from bank_accounts where workspace_id = ${WS_B}`),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("session B (témoin) ne voit que SON compte, jamais ceux de A", async () => {
    const vus = await comptesVisibles(sessB);
    expect(vus).toEqual([ACC_B]);
  });
});

describe("#10 — view_filter inerte SANS filtre (rétro-compat L4 préservée en L5)", () => {
  // En L5, view_filter devient ACTIF — mais UNIQUEMENT si la session porte un
  // `viewFilter`. Sans filtre (toutes les sessions L4 existantes), le GUC reste
  // NON posé → la clause view_filter des policies court-circuite (clause neutre).
  // La couverture ACTIVE de view_filter (intersection, rétrécissement, jamais
  // d'élargissement) est prouvée par la suite L5 account-scope-filles-isolation.
  it("une session SANS viewFilter ne pose JAMAIS app.current_view_filter", async () => {
    const guc = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`select current_setting('app.current_view_filter', true) as v`,
      );
      return (r as unknown as { rows: { v: string | null }[] }).rows[0].v;
    });
    // Pas de filtre demandé → GUC absent → current_setting(..., true) = '' ou null.
    expect(guc === null || guc === "").toBe(true);
  });
});

describe("#10bis ⭐ — la lecture DROIT-COMPLET (session sans viewFilter) ignore un view_filter actif", () => {
  // Verrou du correctif L8b-1 (bug « le sélecteur de périmètre s'auto-ampute »,
  // recon /tmp/recon-l8b1-fix.md §7.3). Le layout peuple le PerimetreSwitcher avec
  // une session SANS viewFilter ({ userId, activeWorkspaceId } seulement) PRÉCISÉMENT
  // pour que la liste reflète le DROIT COMPLET et non le filtre — sinon, une fois un
  // filtre actif, la liste s'amputerait à l'ensemble filtré et on ne pourrait plus
  // ré-élargir. On NE re-teste PAS ici l'intersection/le rétrécissement du view_filter
  // (déjà couverts par la suite L5 account-scope-filles) : on prouve seulement la
  // DIVERGENCE entre la session filtrée et la session droit-complet pour un MÊME membre.
  //
  // MGR_PARTY a pour DROIT {ACC_S1, ACC_S2}. On pose un viewFilter restreint à
  // {ACC_S1} (sous-ensemble strict de son droit) et on compare les deux lectures.
  const sessPartyFiltre = {
    userId: MGR_PARTY,
    activeWorkspaceId: WS_A,
    viewFilter: [ACC_S1],
  };

  it("AVEC viewFilter [ACC_S1] → la lecture ne voit QUE ACC_S1 (le filtre mord)", async () => {
    const vus = await comptesVisibles(sessPartyFiltre);
    expect(vus).toEqual([ACC_S1]);
    expect(vus).not.toContain(ACC_S2); // dans le droit, mais hors filtre d'affichage
  });

  it("SANS viewFilter (mêmes user+workspace) → la lecture voit TOUT le droit {S1, S2}", async () => {
    // C'est EXACTEMENT ce que fait le layout pour alimenter le sélecteur : on ne
    // passe que { userId, activeWorkspaceId } → le GUC view_filter n'est pas posé →
    // clause RLS neutre → tout le droit (account_scope/tenant_isolation restent posés).
    const vus = await comptesVisibles(sessParty);
    expect(vus.sort()).toEqual([ACC_S1, ACC_S2].sort());
  });

  it("la lecture droit-complet est un SUR-ENSEMBLE STRICT de la lecture filtrée (anti-amputation)", async () => {
    const droitComplet = await comptesVisibles(sessParty);
    const filtre = await comptesVisibles(sessPartyFiltre);
    // Tout ce que voit la vue filtrée est visible en droit-complet…
    for (const id of filtre) expect(droitComplet).toContain(id);
    // …et le droit-complet voit STRICTEMENT plus (au moins ACC_S2 en plus) : c'est la
    // garantie que le sélecteur ne perd jamais un compte décoché (le bug corrigé).
    expect(droitComplet.length).toBeGreaterThan(filtre.length);
    expect(droitComplet).toContain(ACC_S2);
    expect(filtre).not.toContain(ACC_S2);
  });

  it("la lecture droit-complet ne pose PAS le GUC view_filter, même quand un filtre EXISTE par ailleurs", async () => {
    // Preuve directe du mécanisme : la session sans viewFilter laisse le GUC absent,
    // donc la 2e clause AND de la policy account_scope court-circuite (neutre).
    const guc = await withWorkspace(sessParty, async (tx) => {
      const r = await tx.execute(
        sql`select current_setting('app.current_view_filter', true) as v`,
      );
      return (r as unknown as { rows: { v: string | null }[] }).rows[0].v;
    });
    expect(guc === null || guc === "").toBe(true);
  });
});

describe("résolveur — anti-élargissement (le scope ne vient QUE du contexte serveur)", () => {
  it("la session stricte (2 champs) interdit d'injecter un account_scope forgé", async () => {
    await expect(
      withWorkspace(
        {
          userId: MGR_PARTY,
          activeWorkspaceId: WS_A,
          accountScope: [ACC_H], // champ pirate
        } as unknown as { userId: string; activeWorkspaceId: string },
        async () => "ne doit jamais s'exécuter",
      ),
    ).rejects.toMatchObject({ code: "INVALID_SESSION" });
  });

  it("un octroi compte cross-tenant est de toute façon impossible EN BASE (FK composite)", async () => {
    // Défense en profondeur : même si on tentait de scoper MGR_PARTY sur ACC_B (WS_B),
    // la FK composite (bank_account_id, workspace_id) → bank_accounts le refuse.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessParty, (tx) =>
        tx.insert(userScopes).values({
          workspaceId: WS_A,
          userId: MGR_PARTY,
          bankAccountId: ACC_B,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(flatten(thrown)).toMatch(/foreign key|violates|constraint|policy|row-level/i);
  });
});
