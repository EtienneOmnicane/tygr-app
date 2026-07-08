/**
 * Suite anti-IDOR — Échéances prévisionnelles (Epic 8, cadrage
 * PLAN-cadrage-echeances.md ; migration 0019). Prouve sur Postgres réel (PGlite)
 * que la table `echeances` porte les DEUX étages d'isolation de bank_accounts,
 * ET qu'elle est bien ÉDITABLE / SUPPRIMABLE (donnée de projection, ECH-D3 —
 * PAS append-only) :
 *
 *   Étage 1 (TENANT, dur)  — une échéance / une entité / une catégorie d'un autre
 *                            workspace est invisible et non-forgeable (FK composites).
 *   Étage 2 (ENTITÉ, scopé) — policy RESTRICTIVE `entity_scope` FOR ALL sur echeances,
 *                            pilotée par app.current_entity_scope posé DEPUIS
 *                            member_entity_scopes (jamais un paramètre client).
 *   DELETE                 — autorisé (liste blanche tygr_app.sql) MAIS borné au
 *                            périmètre (USING) : contre-preuve « non append-only ».
 *
 * Même harnais que les autres suites : DDL = migrations réelles
 * (drizzle/migrations/*.sql), rôle applicatif = drizzle/provisioning/tygr_app.sql,
 * exécution sous `tygr_app` NON-propriétaire (sinon la RLS est ignorée — test 0).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { echeances } from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes (lisibilité des assertions) ───────────────────────────
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Membres de WS_A : GLOBALE (sans scope) et SCOPED (Vision Entité = Sucrière).
const GLOBALE = "11111111-1111-4111-8111-111111111111"; // ADMIN, aucun scope
const SCOPED = "22222222-2222-4222-8222-222222222222"; // VIEWER, scopé Sucrière
const BOB_B = "33333333-3333-4333-8333-333333333333"; // membre de WS_B (témoin)

// Entités de WS_A + une de WS_B (témoin étage 1).
const ENT_SUCRE = "5c000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // Sucrière
const ENT_ENERGIE = "e0e00000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // Énergie
const ENT_B = "b0b00000-cccc-4ccc-8ccc-cccccccccccc"; // entité de WS_B

// Catégories (pour prouver la 2ᵉ FK composite scopée : categorie_id, workspace_id).
const CAT_A = "ca000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // WS_A
const CAT_B = "ca00bbbb-dddd-4ddd-8ddd-dddddddddddd"; // WS_B (témoin)

// Échéances de WS_A : une par entité + une NON rattachée (entity_id NULL) ;
// une de WS_B (témoin étage 1).
const ECH_SUCRE = "ec000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // → Sucrière
const ECH_ENERGIE = "ec00e000-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // → Énergie
const ECH_NONE = "ec000000-cccc-4ccc-8ccc-cccccccccccc"; // entity_id NULL
const ECH_B = "ec00bbbb-dddd-4ddd-8ddd-dddddddddddd"; // WS_B (témoin)

const sessGlobale = { userId: GLOBALE, activeWorkspaceId: WS_A };
const sessScoped = { userId: SCOPED, activeWorkspaceId: WS_A };

beforeAll(async () => {
  // 1. Migrations réelles (le DDL que la prod exécutera — journal inclus).
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou (anti faux-vert) : la policy entity_scope DOIT exister sur
  //    echeances, être RESTRICTIVE et FOR ALL (USING + WITH CHECK). Une policy
  //    absente / PERMISSIVE / FOR SELECT ferait croire à une isolation prouvée
  //    alors que l'étage 2 (écriture) serait inopérant.
  const pol = await client.query<{
    policyname: string;
    permissive: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `select policyname, permissive, cmd, qual, with_check
     from pg_policies where tablename = 'echeances'`,
  );
  const entityScope = pol.rows.find((r) => r.policyname === "entity_scope");
  if (!entityScope) {
    throw new Error(
      `Policy entity_scope absente de echeances — l'étage 2 n'existe pas. ` +
        `État : ${JSON.stringify(pol.rows)}`,
    );
  }
  if (entityScope.permissive !== "RESTRICTIVE") {
    throw new Error(
      `Policy entity_scope doit être RESTRICTIVE (sinon OR avec tenant_isolation ` +
        `→ filtre inopérant), trouvée : ${entityScope.permissive}.`,
    );
  }
  if (
    entityScope.cmd !== "ALL" ||
    entityScope.qual == null ||
    entityScope.with_check == null
  ) {
    throw new Error(
      `Policy entity_scope doit être FOR ALL avec USING ET WITH CHECK — trouvé ` +
        `cmd=${entityScope.cmd}, qual=${entityScope.qual}, ` +
        `with_check=${entityScope.with_check}.`,
    );
  }
  if (!pol.rows.some((r) => r.policyname === "tenant_isolation")) {
    throw new Error("Policy tenant_isolation absente de echeances (étage 1).");
  }

  // 2bis. FORCE RLS (ajout MANUEL de la migration) : sans lui, un accès sous
  //       l'owner court-circuiterait les DEUX étages. On garde la ceinture.
  const rls = await client.query<{
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `select relrowsecurity, relforcerowsecurity
     from pg_class where relname = 'echeances'`,
  );
  if (!rls.rows[0]?.relrowsecurity || !rls.rows[0]?.relforcerowsecurity) {
    throw new Error(
      `echeances doit avoir ENABLE + FORCE ROW LEVEL SECURITY — trouvé ` +
        `${JSON.stringify(rls.rows[0])}.`,
    );
  }

  // 3. Seed owner (bypass RLS). WS_A = deux entités + une échéance non rattachée ;
  //    WS_B = témoin de l'étage 1.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b');
    insert into users (id, email, full_name) values
      ('${GLOBALE}','g@a.mu','Globale Admin'),
      ('${SCOPED}','s@a.mu','Scoped Viewer'),
      ('${BOB_B}','b@b.mu','Bob B');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${GLOBALE}','${WS_A}','ADMIN'),
      ('${SCOPED}','${WS_A}','VIEWER'),
      ('${BOB_B}','${WS_B}','MANAGER');
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière','SUC',true),
      ('${ENT_ENERGIE}','${WS_A}','Énergie','ENE',true),
      ('${ENT_B}','${WS_B}','Entité B','XB',true);
    insert into categories (id, workspace_id, name) values
      ('${CAT_A}','${WS_A}','Ventes'),
      ('${CAT_B}','${WS_B}','Ventes B');
    insert into echeances
      (id, workspace_id, entity_id, direction, libelle, montant, devise, date_echeance, statut, created_by) values
      ('${ECH_SUCRE}','${WS_A}','${ENT_SUCRE}','encaissement','Facture Sucre','10000.00','MUR','2026-07-20','en_cours','${GLOBALE}'),
      ('${ECH_ENERGIE}','${WS_A}','${ENT_ENERGIE}','decaissement','Loyer Énergie','5000.00','MUR','2026-07-25','en_cours','${GLOBALE}'),
      ('${ECH_NONE}','${WS_A}',null,'encaissement','Échéance non rattachée','3000.00','MUR','2026-07-28','en_cours','${GLOBALE}'),
      ('${ECH_B}','${WS_B}','${ENT_B}','encaissement','Facture B','9999.00','MUR','2026-07-30','en_cours','${BOB_B}');
    -- Vision Entité : SCOPED ne couvre QUE Sucrière. GLOBALE n'a AUCUNE ligne.
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${SCOPED}','${ENT_SUCRE}');
  `);

  // 4. Rôle applicatif non-propriétaire (source unique : provisioning prod).
  //    echeances est dans la liste blanche DELETE → tygr_app reçoit DELETE ici
  //    (chemin migrate→provision : la table existe déjà).
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

// Déplie la chaîne des causes (Drizzle enveloppe les erreurs driver RLS/FK).
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

  it("0b. tygr_app a bien le privilège DELETE sur echeances (liste blanche)", async () => {
    const r = await client.query<{ ok: boolean }>(
      `select has_table_privilege('tygr_app','echeances','DELETE') as ok`,
    );
    expect(r.rows[0].ok).toBe(true);
  });
});

describe("étage 1 — TENANT (échéance/entité/catégorie d'un autre workspace invisibles/non-forgeables)", () => {
  it("1. session A ne voit que SES échéances, jamais celle de B", async () => {
    const vues = await withWorkspace(sessGlobale, (tx) =>
      tx.select({ id: echeances.id }).from(echeances),
    );
    const ids = vues.map((e) => e.id);
    expect(ids).toContain(ECH_SUCRE);
    expect(ids).toContain(ECH_ENERGIE);
    expect(ids).toContain(ECH_NONE);
    expect(ids).not.toContain(ECH_B); // échéance de WS_B
  });

  it("2. WHERE forgé visant l'échéance de B depuis A → 0 ligne", async () => {
    const r = await withWorkspace(sessGlobale, (tx) =>
      tx.execute(sql`select * from echeances where id = ${ECH_B}`),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("3. créer une échéance rattachée à une entité d'un AUTRE workspace → refus FK composite", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessGlobale, (tx) =>
        tx.insert(echeances).values({
          workspaceId: WS_A,
          entityId: ENT_B, // entité de WS_B
          direction: "encaissement",
          libelle: "Forgé cross-tenant",
          montant: "1.00",
          devise: "MUR",
          dateEcheance: "2026-08-01",
          createdBy: GLOBALE,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "l'échéance cross-tenant doit être rejetée").not.toBeNull();
    // FK composite (entity_id, workspace_id) → entities : (ENT_B, WS_A) n'existe pas.
    expect(flatten(thrown)).toMatch(/foreign key|violates|constraint/i);
  });

  it("4. créer une échéance rattachée à une catégorie d'un AUTRE workspace → refus FK composite", async () => {
    let thrown: unknown = null;
    try {
      await withWorkspace(sessGlobale, (tx) =>
        tx.insert(echeances).values({
          workspaceId: WS_A,
          categorieId: CAT_B, // catégorie de WS_B
          direction: "encaissement",
          libelle: "Forgé cat cross-tenant",
          montant: "1.00",
          devise: "MUR",
          dateEcheance: "2026-08-01",
          createdBy: GLOBALE,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "la catégorie cross-tenant doit être rejetée").not.toBeNull();
    expect(flatten(thrown)).toMatch(/foreign key|violates|constraint/i);
  });
});

describe("étage 2 — ENTITÉ (policy entity_scope via le 3ᵉ GUC, posé depuis member_entity_scopes)", () => {
  it("5. Vision Globale voit TOUTES les échéances du tenant (Sucrière + Énergie + non rattachée)", async () => {
    const vues = await withWorkspace(sessGlobale, (tx) =>
      tx.select({ id: echeances.id }).from(echeances),
    );
    const ids = vues.map((e) => e.id);
    expect(ids).toContain(ECH_SUCRE);
    expect(ids).toContain(ECH_ENERGIE);
    expect(ids).toContain(ECH_NONE);
    expect(ids).toHaveLength(3);
  });

  it("6. Vision Entité (Sucrière) ne voit QUE l'échéance Sucrière — Énergie masquée", async () => {
    const vues = await withWorkspace(sessScoped, (tx) =>
      tx.select({ id: echeances.id }).from(echeances),
    );
    const ids = vues.map((e) => e.id);
    expect(ids).toEqual([ECH_SUCRE]); // exactement une, la sienne
    expect(ids).not.toContain(ECH_ENERGIE); // étage 2 : Énergie masquée
    expect(ids).not.toContain(ECH_NONE); // non rattachée masquée
  });

  it("7. échéance entity_id NULL : invisible en Vision Entité, visible en Vision Globale", async () => {
    const enScoped = await withWorkspace(sessScoped, (tx) =>
      tx
        .select({ id: echeances.id })
        .from(echeances)
        .where(eq(echeances.id, ECH_NONE)),
    );
    expect(enScoped).toHaveLength(0); // masquée (fail-closed)

    const enGlobale = await withWorkspace(sessGlobale, (tx) =>
      tx
        .select({ id: echeances.id })
        .from(echeances)
        .where(eq(echeances.id, ECH_NONE)),
    );
    expect(enGlobale).toHaveLength(1); // l'ADMIN la voit (sas d'assignation)
  });
});

describe("étage 2 — écriture bornée par scope (policy FOR ALL : USING + WITH CHECK)", () => {
  it("8. un VIEWER scopé Sucrière crée normalement une échéance DANS son périmètre", async () => {
    const NOUV = "ec0f0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await withWorkspace(sessScoped, (tx) =>
      tx.insert(echeances).values({
        id: NOUV,
        workspaceId: WS_A,
        entityId: ENT_SUCRE, // in-scope
        direction: "encaissement",
        libelle: "In-scope OK",
        montant: "500.00",
        devise: "MUR",
        dateEcheance: "2026-08-05",
        createdBy: SCOPED,
      }),
    );
    // Il la voit (in-scope) ; nettoyage sous owner pour l'indépendance.
    const vues = await withWorkspace(sessScoped, (tx) =>
      tx.select({ id: echeances.id }).from(echeances).where(eq(echeances.id, NOUV)),
    );
    expect(vues).toHaveLength(1);
    await client.exec(`reset role;`);
    await client.exec(`delete from echeances where id = '${NOUV}';`);
    await client.exec(`set role tygr_app;`);
  });

  it("9. un VIEWER scopé ne peut PAS déplacer son échéance hors scope (WITH CHECK lève 42501)", async () => {
    // ECH_SUCRE est in-scope (ciblable par le USING) ; l'état résultant
    // (entity_id = Énergie) viole le WITH CHECK → PostgreSQL LÈVE (ERRCODE 42501).
    let thrown: unknown = null;
    try {
      await withWorkspace(sessScoped, (tx) =>
        tx
          .update(echeances)
          .set({ entityId: ENT_ENERGIE })
          .where(eq(echeances.id, ECH_SUCRE)),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "le déplacement hors scope doit être rejeté").not.toBeNull();
    expect(flatten(thrown)).toMatch(/policy|row-level|violates|check/i);

    // Sous l'owner : ECH_SUCRE est TOUJOURS rattachée à Sucrière (non déplacée).
    await client.exec(`reset role;`);
    const v = await client.query<{ entity_id: string }>(
      `select entity_id from echeances where id = '${ECH_SUCRE}'`,
    );
    await client.exec(`set role tygr_app;`);
    expect(v.rows[0].entity_id).toBe(ENT_SUCRE);
  });

  it("10. fail-closed : un VIEWER scopé ne peut pas créer une échéance NON rattachée (entity_id NULL)", async () => {
    // WITH CHECK : NULL n'est dans aucun scope → refus. Un membre borné ne crée
    // pas d'échéances non-assignées. FK + tenant_isolation satisfaits ; c'est
    // bien entity_scope qui rejette.
    let thrown: unknown = null;
    try {
      await withWorkspace(sessScoped, (tx) =>
        tx.insert(echeances).values({
          workspaceId: WS_A,
          direction: "encaissement",
          libelle: "Ne doit pas naître",
          montant: "1.00",
          devise: "MUR",
          dateEcheance: "2026-08-10",
          createdBy: SCOPED,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "INSERT NULL sous Vision Entité doit être refusé").not.toBeNull();
    expect(flatten(thrown)).toMatch(/policy|row-level|violates|check/i);
  });

  it("11. NON-RÉGRESSION Vision Globale : INSERT entity_id NULL (saisie non rattachée) OK", async () => {
    const NOUV = "ec0f0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await withWorkspace(sessGlobale, (tx) =>
      tx.insert(echeances).values({
        id: NOUV,
        workspaceId: WS_A,
        direction: "decaissement",
        libelle: "Non rattachée (Globale)",
        montant: "42.00",
        devise: "MUR",
        dateEcheance: "2026-08-12",
        createdBy: GLOBALE,
      }),
    );
    await client.exec(`reset role;`);
    const cree = await client.query<{ n: number }>(
      `select count(*)::int as n from echeances where id = '${NOUV}'`,
    );
    expect(cree.rows[0].n).toBe(1);
    await client.exec(`delete from echeances where id = '${NOUV}';`);
    await client.exec(`set role tygr_app;`);
  });
});

describe("DELETE — éditable/supprimable (contre-preuve « non append-only »), mais borné au scope", () => {
  it("12. Vision Globale : une échéance se SUPPRIME (echeances n'est PAS append-only)", async () => {
    const DEL = "ec0de000-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await withWorkspace(sessGlobale, (tx) =>
      tx.insert(echeances).values({
        id: DEL,
        workspaceId: WS_A,
        entityId: ENT_ENERGIE,
        direction: "encaissement",
        libelle: "À supprimer",
        montant: "7.00",
        devise: "MUR",
        dateEcheance: "2026-08-15",
        createdBy: GLOBALE,
      }),
    );
    await withWorkspace(sessGlobale, (tx) =>
      tx.delete(echeances).where(eq(echeances.id, DEL)),
    );
    const reste = await withWorkspace(sessGlobale, (tx) =>
      tx.select({ id: echeances.id }).from(echeances).where(eq(echeances.id, DEL)),
    );
    expect(reste).toHaveLength(0); // supprimée physiquement (aucun trigger append-only)
  });

  it("13. Vision Entité : un DELETE sans WHERE ne supprime QUE le périmètre (USING borne)", async () => {
    // Le scopé Sucrière tente d'effacer TOUTES les échéances : seules celles
    // in-scope disparaissent ; Énergie + non rattachée sont hors USING → intactes.
    await withWorkspace(sessScoped, (tx) => tx.delete(echeances));

    await client.exec(`reset role;`);
    const reste = await client.query<{ id: string }>(
      `select id from echeances where workspace_id = '${WS_A}' order by id`,
    );
    await client.exec(`set role tygr_app;`);
    const ids = reste.rows.map((r) => r.id);
    expect(ids).toContain(ECH_ENERGIE); // hors scope : intacte
    expect(ids).toContain(ECH_NONE); // non rattachée : intacte
    expect(ids).not.toContain(ECH_SUCRE); // in-scope : supprimée

    // Restauration (owner) pour l'hygiène (indépendance si extension future).
    await client.exec(`reset role;`);
    await client.exec(`
      insert into echeances
        (id, workspace_id, entity_id, direction, libelle, montant, devise, date_echeance, statut, created_by) values
        ('${ECH_SUCRE}','${WS_A}','${ENT_SUCRE}','encaissement','Facture Sucre','10000.00','MUR','2026-07-20','en_cours','${GLOBALE}');
    `);
    await client.exec(`set role tygr_app;`);
  });
});
