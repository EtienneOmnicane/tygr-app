/**
 * Suite d'isolation — Repository des ÉCHÉANCES (Epic 8 · FEAT-8.2, Lot 2 ; cadrage
 * PLAN-cadrage-echeances.md §6). Contrairement à `echeances-isolation.test.ts` (qui
 * prouve la RLS au niveau SQL BRUT), cette suite valide les FONCTIONS du repository
 * `@/server/repositories/echeances` — celles que les Server Actions appellent DANS
 * withWorkspace — avec leur mapping d'erreurs NOMMÉES (règle 3) :
 *
 *   Garde de rôle    — VIEWER refusé AVANT toute existence (anti-oracle) →
 *                      EcheanceNonAutoriseeError.
 *   FK composite      — entité/catégorie d'un autre tenant (23503) →
 *                      ReferenceEcheanceInvalideError.
 *   Périmètre entité  — création/déplacement HORS scope (RLS WITH CHECK 42501) →
 *                      EcheanceHorsPerimetreError (y compris entity_id NULL sous
 *                      Vision Entité — fail-closed).
 *   Tenant (USING)    — cible d'un autre tenant → 0 ligne → EcheanceIntrouvableError
 *                      (404, jamais 403).
 *   CHECK montant_regle — montant_regle > montant (23514) → MontantRegleInvalideError.
 *   Lecture           — dérivation « en retard » (aujourd'hui injecté, fuseau Maurice)
 *                      + synthèse par HORIZON × DEVISE (totaux EXACTS, restant dû,
 *                      terminaux exclus, overdue inclus, borne haute).
 *
 * Harnais identique aux autres suites : DDL = migrations réelles, rôle applicatif =
 * drizzle/provisioning/tygr_app.sql, exécution sous `tygr_app` NON-propriétaire
 * (sinon la RLS est ignorée — test 0). Les codes SQLSTATE (42501/23503/23514)
 * remontent via `.code` sous PGlite (vérifié), donc le mapping catch du repository
 * mord réellement.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  changerStatutEcheance,
  creerEcheance,
  listerEcheances,
  modifierEcheance,
  occurrencesSurFenetre,
  supprimerEcheance,
  synthetiserHorizon,
  EcheanceHorsPerimetreError,
  EcheanceIntrouvableError,
  EcheanceNonAutoriseeError,
  MontantRegleInvalideError,
  ReferenceEcheanceInvalideError,
  type SyntheseEcheances,
} from "@/server/repositories/echeances";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

// ── Identifiants fixes ───────────────────────────────────────────────────────
const WS_A = "a0000000-0000-4000-8000-000000000001"; // écritures
const WS_B = "b0000000-0000-4000-8000-000000000002"; // témoin cross-tenant
const WS_C = "c0000000-0000-4000-8000-000000000003"; // lecture / synthèse
// WS_D : synthèse des RÉCURRENTES (C0). Workspace SÉPARÉ à dessein — seeder des
// gabarits dans WS_C fausserait les totaux figés du test 17, qui est la preuve de
// non-régression du calcul historique.
const WS_D = "d0000000-0000-4000-8000-000000000004";

// Membres WS_A.
const ADMIN_A = "a1111111-1111-4111-8111-111111111111"; // ADMIN, Vision Globale
const MGR_SUCRE = "a2222222-2222-4222-8222-222222222222"; // MANAGER, scopé Sucrière
const VIEWER_A = "a3333333-3333-4333-8333-333333333333"; // VIEWER, Vision Globale
const USER_B = "b1111111-1111-4111-8111-111111111111"; // MANAGER WS_B
const ADMIN_C = "c1111111-1111-4111-8111-111111111111"; // ADMIN WS_C
const ADMIN_D = "d1111111-1111-4111-8111-111111111111"; // ADMIN WS_D

// Entités.
const ENT_SUCRE = "a5000000-0000-4000-8000-000000000001"; // WS_A (scope MGR_SUCRE)
const ENT_ENERGIE = "a5000000-0000-4000-8000-000000000002"; // WS_A (hors scope MGR)
const ENT_B = "b5000000-0000-4000-8000-000000000001"; // WS_B

// Catégories (2ᵉ FK composite scopée workspace).
const CAT_A = "a6000000-0000-4000-8000-000000000001"; // WS_A
const CAT_B = "b6000000-0000-4000-8000-000000000001"; // WS_B

// Échéances seedées (WS_A pour modif/statut/suppr ; WS_B témoin).
const ECH_A_MOD = "a7000000-0000-4000-8000-000000000001";
const ECH_A_STAT = "a7000000-0000-4000-8000-000000000002";
const ECH_A_STAT2 = "a7000000-0000-4000-8000-000000000003";
const ECH_A_DEL = "a7000000-0000-4000-8000-000000000004";
// C1 — projection du dashboard : deux échéances WS_A dans des entités DIFFÉRENTES, pour
// prouver que la zone prévisionnelle est AMPUTÉE au périmètre du lecteur (étage 2).
const ECH_A_SUCRE_PROJ = "a7000000-0000-4000-8000-000000000005";
const ECH_A_ENERGIE_PROJ = "a7000000-0000-4000-8000-000000000006";
const ECH_B = "b7000000-0000-4000-8000-000000000001";

// Échéances WS_C (synthèse déterministe, entity_id NULL).
const C1 = "c7000000-0000-4000-8000-000000000001"; // enc MUR 1000, 07-01 (OVERDUE)
const C2 = "c7000000-0000-4000-8000-000000000002"; // enc MUR 1000 partiel r=250, 07-20
const C3 = "c7000000-0000-4000-8000-000000000003"; // dec MUR 400, 07-25
const C4 = "c7000000-0000-4000-8000-000000000004"; // enc USD 300, 08-01
const C5 = "c7000000-0000-4000-8000-000000000005"; // enc MUR 500, 08-20 (H60+)
const C6 = "c7000000-0000-4000-8000-000000000006"; // dec MUR 200, 09-20 (H90+)
const C7 = "c7000000-0000-4000-8000-000000000007"; // enc MUR 9999 PAYEE (exclu)
const C8 = "c7000000-0000-4000-8000-000000000008"; // enc MUR 8888 ANNULEE past (exclu)
const C9 = "c7000000-0000-4000-8000-000000000009"; // enc MUR 7777, 12-01 (hors H90)

// Échéances WS_D — GABARITS récurrents (C0). Toutes entity_id NULL (Vision Globale).
// Le champ `recurrence` était STOCKÉ mais JAMAIS LU : ces cas échouaient tous avant C0.
const R1 = "d7000000-0000-4000-8000-000000000001"; // MENSUELLE dec MUR 10000, 07-11 → 1×/2×/3×
const R2 = "d7000000-0000-4000-8000-000000000002"; // TRIMESTRIELLE enc MUR 5000, 07-05 (OVERDUE) → 2e occ. en H90 seul
const R3 = "d7000000-0000-4000-8000-000000000003"; // MENSUELLE dec USD 100, 07-11, PAYEE → tête éteinte, série VIVANTE (D1)
const R4 = "d7000000-0000-4000-8000-000000000004"; // NON récurrente enc MUR 9999, PAYEE → exclue partout (non-régression)
const R5 = "d7000000-0000-4000-8000-000000000005"; // MENSUELLE dec MUR 7, 08-07 = AUJ+30 PILE → borne + débordement

// « Aujourd'hui » injecté (fuseau Maurice déjà posé en amont — déterminisme).
const AUJ = "2026-07-08";
// Bornes d'horizon dérivées de AUJ (rappel pour la lecture des attendus) :
//   H30 ≤ 2026-08-07 · H60 ≤ 2026-09-06 · H90 ≤ 2026-10-06.

const sessAdminA = { userId: ADMIN_A, activeWorkspaceId: WS_A };
const sessMgr = { userId: MGR_SUCRE, activeWorkspaceId: WS_A };
const sessViewer = { userId: VIEWER_A, activeWorkspaceId: WS_A };
const sessAdminC = { userId: ADMIN_C, activeWorkspaceId: WS_C };
const sessAdminD = { userId: ADMIN_D, activeWorkspaceId: WS_D };

beforeAll(async () => {
  // 1. Migrations réelles.
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  // 2. Garde-fou : la policy entity_scope existe, RESTRICTIVE + FOR ALL (USING +
  //    WITH CHECK) — sinon l'étage 2 (écriture) serait inopérant et les tests de
  //    périmètre seraient faux-verts.
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
  const es = pol.rows.find((r) => r.policyname === "entity_scope");
  if (
    !es ||
    es.permissive !== "RESTRICTIVE" ||
    es.cmd !== "ALL" ||
    es.qual == null ||
    es.with_check == null
  ) {
    throw new Error(
      `Policy entity_scope invalide sur echeances (RESTRICTIVE/FOR ALL/USING+CHECK) : ${JSON.stringify(pol.rows)}`,
    );
  }

  // 3. Seed sous l'owner (bypass RLS).
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS_A}','Groupe A','INTERNAL_BU','eu-a'),
      ('${WS_B}','Groupe B','INTERNAL_BU','eu-b'),
      ('${WS_C}','Groupe C','INTERNAL_BU','eu-c'),
      ('${WS_D}','Groupe D','INTERNAL_BU','eu-d');
    insert into users (id, email, full_name) values
      ('${ADMIN_A}','admin@a.mu','Admin A'),
      ('${MGR_SUCRE}','mgr@a.mu','Mgr Sucre'),
      ('${VIEWER_A}','viewer@a.mu','Viewer A'),
      ('${USER_B}','user@b.mu','User B'),
      ('${ADMIN_C}','admin@c.mu','Admin C'),
      ('${ADMIN_D}','admin@d.mu','Admin D');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ADMIN_A}','${WS_A}','ADMIN'),
      ('${MGR_SUCRE}','${WS_A}','MANAGER'),
      ('${VIEWER_A}','${WS_A}','VIEWER'),
      ('${USER_B}','${WS_B}','MANAGER'),
      ('${ADMIN_C}','${WS_C}','ADMIN'),
      ('${ADMIN_D}','${WS_D}','ADMIN');
    insert into entities (id, workspace_id, name, code, is_active) values
      ('${ENT_SUCRE}','${WS_A}','Sucrière','SUC',true),
      ('${ENT_ENERGIE}','${WS_A}','Énergie','ENE',true),
      ('${ENT_B}','${WS_B}','Entité B','XB',true);
    insert into categories (id, workspace_id, name) values
      ('${CAT_A}','${WS_A}','Ventes'),
      ('${CAT_B}','${WS_B}','Ventes B');
    -- Vision Entité : MGR_SUCRE borné à Sucrière. ADMIN_A/ADMIN_C : aucune ligne.
    insert into member_entity_scopes (workspace_id, user_id, entity_id) values
      ('${WS_A}','${MGR_SUCRE}','${ENT_SUCRE}');
    -- Échéances WS_A (modif/statut/suppr). ECH_A_MOD a un updated_at ANCIEN pour
    -- prouver le bump manuel (le schéma n'a pas de $onUpdate).
    insert into echeances
      (id, workspace_id, entity_id, direction, libelle, montant, devise, date_echeance, statut, created_by, created_at, updated_at) values
      ('${ECH_A_MOD}','${WS_A}','${ENT_SUCRE}','encaissement','À modifier','1000.00','MUR','2026-09-01','en_cours','${ADMIN_A}','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z'),
      ('${ECH_A_STAT}','${WS_A}','${ENT_SUCRE}','encaissement','Cycle de vie','1000.00','MUR','2026-09-01','en_cours','${ADMIN_A}',now(),now()),
      ('${ECH_A_STAT2}','${WS_A}','${ENT_SUCRE}','encaissement','Borne réglé','1000.00','MUR','2026-09-01','en_cours','${ADMIN_A}',now(),now()),
      ('${ECH_A_DEL}','${WS_A}','${ENT_SUCRE}','encaissement','À supprimer','1000.00','MUR','2026-09-01','en_cours','${ADMIN_A}',now(),now()),
      -- Paire de projection (C1) : montants REPÈRES distincts, une par entité. MGR_SUCRE
      -- (scopé Sucrière) ne doit JAMAIS voir la seconde dans sa zone prévisionnelle.
      ('${ECH_A_SUCRE_PROJ}','${WS_A}','${ENT_SUCRE}','decaissement','Projection Sucrière','111.00','MUR','2026-07-20','en_cours','${ADMIN_A}',now(),now()),
      ('${ECH_A_ENERGIE_PROJ}','${WS_A}','${ENT_ENERGIE}','decaissement','Projection Énergie','222.00','MUR','2026-07-21','en_cours','${ADMIN_A}',now(),now());
    -- Témoin cross-tenant.
    insert into echeances
      (id, workspace_id, entity_id, direction, libelle, montant, devise, date_echeance, statut, created_by) values
      ('${ECH_B}','${WS_B}','${ENT_B}','encaissement','Facture B','9999.00','MUR','2026-09-01','en_cours','${USER_B}');
    -- Échéances WS_C (synthèse). Toutes entity_id NULL (ADMIN_C = Vision Globale).
    insert into echeances
      (id, workspace_id, entity_id, direction, libelle, montant, devise, date_echeance, statut, montant_regle, created_by) values
      ('${C1}','${WS_C}',null,'encaissement','C1','1000.00','MUR','2026-07-01','en_cours',null,'${ADMIN_C}'),
      ('${C2}','${WS_C}',null,'encaissement','C2','1000.00','MUR','2026-07-20','partiel','250.00','${ADMIN_C}'),
      ('${C3}','${WS_C}',null,'decaissement','C3','400.00','MUR','2026-07-25','en_cours',null,'${ADMIN_C}'),
      ('${C4}','${WS_C}',null,'encaissement','C4','300.00','USD','2026-08-01','en_cours',null,'${ADMIN_C}'),
      ('${C5}','${WS_C}',null,'encaissement','C5','500.00','MUR','2026-08-20','en_cours',null,'${ADMIN_C}'),
      ('${C6}','${WS_C}',null,'decaissement','C6','200.00','MUR','2026-09-20','en_cours',null,'${ADMIN_C}'),
      ('${C7}','${WS_C}',null,'encaissement','C7','9999.00','MUR','2026-07-15','payee','9999.00','${ADMIN_C}'),
      ('${C8}','${WS_C}',null,'encaissement','C8','8888.00','MUR','2026-07-02','annulee',null,'${ADMIN_C}'),
      ('${C9}','${WS_C}',null,'encaissement','C9','7777.00','MUR','2026-12-01','en_cours',null,'${ADMIN_C}');
    -- Échéances WS_D — GABARITS récurrents (C0). La colonne recurrence n'était JAMAIS
    -- lue : chaque ligne ci-dessous était comptée UNE fois, à sa date stockée.
    insert into echeances
      (id, workspace_id, entity_id, direction, libelle, montant, devise, date_echeance, statut, recurrence, montant_regle, created_by) values
      ('${R1}','${WS_D}',null,'decaissement','R1 loyer','10000.00','MUR','2026-07-11','en_cours','mensuelle',null,'${ADMIN_D}'),
      ('${R2}','${WS_D}',null,'encaissement','R2 abonnement','5000.00','MUR','2026-07-05','en_cours','trimestrielle',null,'${ADMIN_D}'),
      ('${R3}','${WS_D}',null,'decaissement','R3 SaaS','100.00','USD','2026-07-11','payee','mensuelle','100.00','${ADMIN_D}'),
      ('${R4}','${WS_D}',null,'encaissement','R4 ponctuelle','9999.00','MUR','2026-07-20','payee',null,'9999.00','${ADMIN_D}'),
      ('${R5}','${WS_D}',null,'decaissement','R5 borne','7.00','MUR','2026-08-07','en_cours','mensuelle',null,'${ADMIN_D}');
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

/** Lit une ligne echeances sous l'owner (bypass RLS) pour vérifier l'effet réel. */
async function litOwner(id: string) {
  await client.exec(`reset role;`);
  const r = await client.query<{
    statut: string;
    montant_regle: string | null;
    libelle: string;
    updated_at: string;
    entity_id: string | null;
  }>(
    `select statut, montant_regle, libelle, updated_at, entity_id
     from echeances where id = '${id}'`,
  );
  await client.exec(`set role tygr_app;`);
  return r.rows[0] ?? null;
}

describe("préconditions", () => {
  it("0. requêtes sous tygr_app (sinon RLS ignorée)", async () => {
    const r = await client.query<{ who: string }>("select current_user as who");
    expect(r.rows[0].who).toBe("tygr_app");
  });
});

describe("garde de rôle (VIEWER refusé AVANT existence — anti-oracle)", () => {
  it("1. VIEWER · creerEcheance → EcheanceNonAutoriseeError", async () => {
    await expect(
      withWorkspace(sessViewer, (tx, ctx) =>
        creerEcheance(tx, ctx, {
          entityId: null,
          direction: "encaissement",
          libelle: "Interdit",
          montant: "10.00",
          devise: "MUR",
          dateEcheance: "2026-09-01",
        }),
      ),
    ).rejects.toBeInstanceOf(EcheanceNonAutoriseeError);
  });

  it("2. VIEWER · modifier/changerStatut/supprimer (id INEXISTANT) → refus sans oracle d'existence", async () => {
    const FANTOME = "a7ffffff-0000-4000-8000-000000000000";
    await expect(
      withWorkspace(sessViewer, (tx, ctx) =>
        modifierEcheance(tx, ctx, { echeanceId: FANTOME, libelle: "x" }),
      ),
    ).rejects.toBeInstanceOf(EcheanceNonAutoriseeError);
    await expect(
      withWorkspace(sessViewer, (tx, ctx) =>
        changerStatutEcheance(tx, ctx, { echeanceId: FANTOME, statut: "payee" }),
      ),
    ).rejects.toBeInstanceOf(EcheanceNonAutoriseeError);
    await expect(
      withWorkspace(sessViewer, (tx, ctx) =>
        supprimerEcheance(tx, ctx, FANTOME),
      ),
    ).rejects.toBeInstanceOf(EcheanceNonAutoriseeError);
  });
});

describe("création — FK composite tenant & périmètre entité", () => {
  it("3. ADMIN (Globale) · creerEcheance in-scope → OK, persistée", async () => {
    const { echeanceId } = await withWorkspace(sessAdminA, (tx, ctx) =>
      creerEcheance(tx, ctx, {
        entityId: ENT_SUCRE,
        direction: "encaissement",
        libelle: "Créée par admin",
        contrepartie: "Client X",
        montant: "1234.00",
        devise: "MUR",
        dateEcheance: "2026-09-15",
        categorieId: CAT_A,
      }),
    );
    expect(echeanceId).toMatch(/^[0-9a-f-]{36}$/);
    const row = await litOwner(echeanceId);
    expect(row?.libelle).toBe("Créée par admin");
    expect(row?.entity_id).toBe(ENT_SUCRE);
  });

  it("4. ADMIN (Globale) · creerEcheance entity_id NULL → OK (saisie non rattachée, non-régression)", async () => {
    const { echeanceId } = await withWorkspace(sessAdminA, (tx, ctx) =>
      creerEcheance(tx, ctx, {
        direction: "decaissement",
        libelle: "Non rattachée",
        montant: "42.00",
        devise: "EUR",
        dateEcheance: "2026-09-20",
      }),
    );
    const row = await litOwner(echeanceId);
    expect(row?.entity_id).toBeNull();
  });

  it("5. ADMIN · creerEcheance entité d'un AUTRE tenant (23503) → ReferenceEcheanceInvalideError", async () => {
    await expect(
      withWorkspace(sessAdminA, (tx, ctx) =>
        creerEcheance(tx, ctx, {
          entityId: ENT_B, // (ENT_B, WS_A) n'existe pas
          direction: "encaissement",
          libelle: "Forgée",
          montant: "1.00",
          devise: "MUR",
          dateEcheance: "2026-09-01",
        }),
      ),
    ).rejects.toBeInstanceOf(ReferenceEcheanceInvalideError);
  });

  it("6. ADMIN · creerEcheance catégorie d'un AUTRE tenant (23503) → ReferenceEcheanceInvalideError", async () => {
    await expect(
      withWorkspace(sessAdminA, (tx, ctx) =>
        creerEcheance(tx, ctx, {
          categorieId: CAT_B, // (CAT_B, WS_A) n'existe pas
          direction: "encaissement",
          libelle: "Forgée cat",
          montant: "1.00",
          devise: "MUR",
          dateEcheance: "2026-09-01",
        }),
      ),
    ).rejects.toBeInstanceOf(ReferenceEcheanceInvalideError);
  });

  it("7. MANAGER scopé Sucrière · creerEcheance vers Énergie (hors scope, 42501) → EcheanceHorsPerimetreError", async () => {
    await expect(
      withWorkspace(sessMgr, (tx, ctx) =>
        creerEcheance(tx, ctx, {
          entityId: ENT_ENERGIE,
          direction: "encaissement",
          libelle: "Hors périmètre",
          montant: "1.00",
          devise: "MUR",
          dateEcheance: "2026-09-01",
        }),
      ),
    ).rejects.toBeInstanceOf(EcheanceHorsPerimetreError);
  });

  it("8. MANAGER scopé · creerEcheance entity_id NULL (fail-closed, 42501) → EcheanceHorsPerimetreError", async () => {
    await expect(
      withWorkspace(sessMgr, (tx, ctx) =>
        creerEcheance(tx, ctx, {
          direction: "encaissement",
          libelle: "Non rattachée interdite",
          montant: "1.00",
          devise: "MUR",
          dateEcheance: "2026-09-01",
        }),
      ),
    ).rejects.toBeInstanceOf(EcheanceHorsPerimetreError);
  });

  it("9. MANAGER scopé · creerEcheance DANS son périmètre (Sucrière) → OK", async () => {
    const { echeanceId } = await withWorkspace(sessMgr, (tx, ctx) =>
      creerEcheance(tx, ctx, {
        entityId: ENT_SUCRE,
        direction: "encaissement",
        libelle: "In-scope MGR",
        montant: "77.00",
        devise: "MUR",
        dateEcheance: "2026-09-01",
      }),
    );
    const row = await litOwner(echeanceId);
    expect(row?.entity_id).toBe(ENT_SUCRE);
  });
});

describe("modification — tenant (USING) & bump updatedAt", () => {
  it("10. ADMIN · modifierEcheance change le libellé et BUMPE updatedAt", async () => {
    const avant = await litOwner(ECH_A_MOD);
    await withWorkspace(sessAdminA, (tx, ctx) =>
      modifierEcheance(tx, ctx, { echeanceId: ECH_A_MOD, libelle: "Libellé v2" }),
    );
    const apres = await litOwner(ECH_A_MOD);
    expect(apres?.libelle).toBe("Libellé v2");
    // updated_at ancien (2020) → bumpé (le repo pose set.updatedAt = new Date()).
    expect(new Date(apres!.updated_at).getTime()).toBeGreaterThan(
      new Date(avant!.updated_at).getTime(),
    );
  });

  it("11. ADMIN · modifierEcheance d'un AUTRE tenant (ECH_B) → EcheanceIntrouvableError (404, jamais 403)", async () => {
    await expect(
      withWorkspace(sessAdminA, (tx, ctx) =>
        modifierEcheance(tx, ctx, { echeanceId: ECH_B, libelle: "pirate" }),
      ),
    ).rejects.toBeInstanceOf(EcheanceIntrouvableError);
    // ECH_B intacte côté WS_B.
    const row = await litOwner(ECH_B);
    expect(row?.libelle).toBe("Facture B");
  });
});

describe("cycle de vie — changerStatut & CHECK montant_regle", () => {
  it("12. ADMIN · partiel(montantRegle) puis payee → montant_regle posé puis REMIS à NULL", async () => {
    await withWorkspace(sessAdminA, (tx, ctx) =>
      changerStatutEcheance(tx, ctx, {
        echeanceId: ECH_A_STAT,
        statut: "partiel",
        montantRegle: "300.00",
      }),
    );
    let row = await litOwner(ECH_A_STAT);
    expect(row?.statut).toBe("partiel");
    expect(row?.montant_regle).toBe("300.00");

    await withWorkspace(sessAdminA, (tx, ctx) =>
      changerStatutEcheance(tx, ctx, { echeanceId: ECH_A_STAT, statut: "payee" }),
    );
    row = await litOwner(ECH_A_STAT);
    expect(row?.statut).toBe("payee");
    expect(row?.montant_regle).toBeNull(); // réglé résiduel purgé
  });

  it("13. ADMIN · changerStatut partiel montantRegle > montant (23514) → MontantRegleInvalideError", async () => {
    await expect(
      withWorkspace(sessAdminA, (tx, ctx) =>
        changerStatutEcheance(tx, ctx, {
          echeanceId: ECH_A_STAT2, // montant 1000.00
          statut: "partiel",
          montantRegle: "2000.00",
        }),
      ),
    ).rejects.toBeInstanceOf(MontantRegleInvalideError);
    // Inchangée : le CHECK a rollbacké l'UPDATE.
    const row = await litOwner(ECH_A_STAT2);
    expect(row?.statut).toBe("en_cours");
    expect(row?.montant_regle).toBeNull();
  });
});

describe("suppression — éditable (ECH-D3) mais bornée au tenant", () => {
  it("14. ADMIN · supprimerEcheance puis re-supprimer → gone, 2ᵉ appel EcheanceIntrouvableError", async () => {
    await withWorkspace(sessAdminA, (tx, ctx) =>
      supprimerEcheance(tx, ctx, ECH_A_DEL),
    );
    expect(await litOwner(ECH_A_DEL)).toBeNull(); // supprimée physiquement
    await expect(
      withWorkspace(sessAdminA, (tx, ctx) => supprimerEcheance(tx, ctx, ECH_A_DEL)),
    ).rejects.toBeInstanceOf(EcheanceIntrouvableError);
  });

  it("15. ADMIN · supprimerEcheance d'un AUTRE tenant (ECH_B) → EcheanceIntrouvableError, ECH_B intacte", async () => {
    await expect(
      withWorkspace(sessAdminA, (tx, ctx) => supprimerEcheance(tx, ctx, ECH_B)),
    ).rejects.toBeInstanceOf(EcheanceIntrouvableError);
    expect(await litOwner(ECH_B)).not.toBeNull();
  });
});

describe("lecture — dérivation « en retard » (aujourd'hui injecté, fuseau Maurice)", () => {
  it("16. listerEcheances dérive en_retard sans le stocker ; terminal passé n'est PAS en retard", async () => {
    const liste = await withWorkspace(sessAdminC, (tx, ctx) =>
      listerEcheances(tx, ctx, { aujourdhui: AUJ }),
    );
    expect(liste).toHaveLength(9); // WS_C : 9 échéances, entity_id NULL, ADMIN globale
    // Tri par exigibilité asc : C1 (07-01) en tête, EN RETARD (date passée, en_cours).
    expect(liste[0].id).toBe(C1);
    expect(liste[0].enRetard).toBe(true);
    expect(liste[0].statutAffiche).toBe("en_retard");

    const c8 = liste.find((e) => e.id === C8)!; // annulee, date 07-02 (passée)
    expect(c8.enRetard).toBe(false); // terminal → jamais « en retard »
    expect(c8.statutAffiche).toBe("annulee");

    const c2 = liste.find((e) => e.id === C2)!; // partiel, date 07-20 (future)
    expect(c2.enRetard).toBe(false);
    expect(c2.statutAffiche).toBe("partiel");
  });
});

describe("synthèse par HORIZON × DEVISE (restant dû ; terminaux exclus ; overdue inclus ; borne haute)", () => {
  it("17. synthetiserHorizon renvoie les totaux EXACTS 30/60/90 j (MUR + USD)", async () => {
    const synthese: SyntheseEcheances = await withWorkspace(
      sessAdminC,
      (tx, ctx) => synthetiserHorizon(tx, ctx, { aujourdhui: AUJ }),
    );

    // Rappel du calcul (restant = montant − coalesce(montant_regle,0)) :
    //  H30 (≤ 08-07) : MUR C1(1000)+C2(750) enc, C3(400) dec ; USD C4(300) enc.
    //  H60 (≤ 09-06) : + C5(500) enc MUR.
    //  H90 (≤ 10-06) : + C6(200) dec MUR. C7 payee / C8 annulee exclus ; C9 hors borne.
    expect(synthese).toEqual([
      {
        jours: 30,
        lignes: [
          { devise: "MUR", encaissement: "1750.00", decaissement: "400.00", net: "1350.00" },
          { devise: "USD", encaissement: "300.00", decaissement: "0.00", net: "300.00" },
        ],
      },
      {
        jours: 60,
        lignes: [
          { devise: "MUR", encaissement: "2250.00", decaissement: "400.00", net: "1850.00" },
          { devise: "USD", encaissement: "300.00", decaissement: "0.00", net: "300.00" },
        ],
      },
      {
        jours: 90,
        lignes: [
          { devise: "MUR", encaissement: "2250.00", decaissement: "600.00", net: "1650.00" },
          { devise: "USD", encaissement: "300.00", decaissement: "0.00", net: "300.00" },
        ],
      },
    ]);
  });
});

/**
 * C0 — EXPANSION DES RÉCURRENCES (PLAN-conception-previsionnel-C.md).
 *
 * Le champ `recurrence` était STOCKÉ mais JAMAIS LU : `synthetiserHorizon` comptait
 * chaque échéance UNE fois, à sa date stockée. TOUS les cas de ce bloc échouaient
 * avant C0 — c'est la preuve du lot, et celle du chiffre faux qui était en production.
 *
 * Ces tests valident le CÂBLAGE sous RLS réelle (le repo lit bien `recurrence`, appelle
 * le moteur et agrège en centimes). La règle de récurrence elle-même (clamp de
 * quantième, bissextilité, rangs) est prouvée unitairement dans
 * `tests/unit/echeances-recurrence.test.ts`.
 */
describe("C0 — synthèse × RÉCURRENCE (gabarit + tête, D1)", () => {
  const synthese = () =>
    withWorkspace(sessAdminD, (tx, ctx) =>
      synthetiserHorizon(tx, ctx, { aujourdhui: AUJ }),
    );

  it("18. totaux EXACTS 30/60/90 j avec occurrences récurrentes (MUR + USD)", async () => {
    // Détail du calcul (AUJ = 07-08 → H30 ≤ 08-07, H60 ≤ 09-06, H90 ≤ 10-06) :
    //  R1 mensuelle dec MUR 10000 @07-11 : H30 {07-11} · H60 {+08-11} · H90 {+09-11}
    //     → 10000 / 20000 / 30000  ← LE bug : c'était 10000 à plat.
    //  R5 mensuelle dec MUR 7 @08-07 (= AUJ+30 PILE) : H30 {08-07}=7 (borne INCLUSIVE)
    //     · H60 {08-07} = 7 (09-07 déborde) · H90 {08-07, 09-07} = 14
    //  R2 trimestrielle enc MUR 5000 @07-05 (OVERDUE) : H30/H60 {07-05}=5000
    //     · H90 {07-05, 10-05} = 10000  ← la 2e occurrence n'entre QUE dans H90
    //  R3 mensuelle dec USD 100 @07-11 PAYEE : tête ÉTEINTE, série VIVANTE (D1)
    //     → H30 rien (USD ABSENT) · H60 {08-11} = 100 · H90 {08-11, 09-11} = 200
    //  R4 non récurrente PAYEE : exclue PARTOUT (comportement historique préservé).
    expect(await synthese()).toEqual([
      {
        jours: 30,
        lignes: [
          // dec = 10000 (R1) + 7 (R5, pile sur la borne). USD absent : R3 n'a que sa tête payée.
          { devise: "MUR", encaissement: "5000.00", decaissement: "10007.00", net: "-5007.00" },
        ],
      },
      {
        jours: 60,
        lignes: [
          // dec = 20000 (R1 ×2) + 7 (R5 ×1). enc = 5000 (R2 ×1).
          { devise: "MUR", encaissement: "5000.00", decaissement: "20007.00", net: "-15007.00" },
          // USD réapparaît : occurrence dérivée d'un gabarit dont la TÊTE est payée.
          { devise: "USD", encaissement: "0.00", decaissement: "100.00", net: "-100.00" },
        ],
      },
      {
        jours: 90,
        lignes: [
          // dec = 30000 (R1 ×3) + 14 (R5 ×2). enc = 10000 (R2 ×2).
          { devise: "MUR", encaissement: "10000.00", decaissement: "30014.00", net: "-20014.00" },
          { devise: "USD", encaissement: "0.00", decaissement: "200.00", net: "-200.00" },
        ],
      },
    ]);
  });

  it("19. une mensuelle pèse 1× / 2× / 3× sur 30 / 60 / 90 j (le constat)", async () => {
    const s = await synthese();
    const decMur = (i: number) => s[i].lignes.find((l) => l.devise === "MUR")!.decaissement;
    // R1 (10000) + R5 (7 / 7 / 14). Avant C0 : 10007 / 10007 / 10007 — plat.
    expect([decMur(0), decMur(1), decMur(2)]).toEqual(["10007.00", "20007.00", "30014.00"]);
  });

  it("20. D1 — une tête PAYEE n'éteint PLUS les occurrences futures (fin de l'optimisme silencieux)", async () => {
    const s = await synthese();
    // Avant C0, R3 (payee) était filtrée en SQL → USD absent des 3 horizons.
    expect(s[0].lignes.find((l) => l.devise === "USD")).toBeUndefined(); // tête seule → rien
    expect(s[1].lignes.find((l) => l.devise === "USD")!.decaissement).toBe("100.00");
    expect(s[2].lignes.find((l) => l.devise === "USD")!.decaissement).toBe("200.00");
  });

  it("21. une NON récurrente terminale reste exclue partout (non-régression)", async () => {
    const s = await synthese();
    // R4 = 9999 MUR enc payee. Si elle fuyait, l'encaissement MUR le montrerait.
    for (const h of s) {
      const mur = h.lignes.find((l) => l.devise === "MUR");
      expect(mur?.encaissement).not.toContain("9999");
    }
    expect(s[2].lignes.find((l) => l.devise === "MUR")!.encaissement).toBe("10000.00");
  });

  it("22. le RETARD reste compté (pas de borne basse) — R2 exigible avant AUJ", async () => {
    const s = await synthese();
    // R2 @07-05 < AUJ (07-08) : la tête en retard pèse dès H30.
    expect(s[0].lignes.find((l) => l.devise === "MUR")!.encaissement).toBe("5000.00");
  });

  it("23. AUCUNE addition cross-devise : MUR et USD restent des lignes distinctes", async () => {
    const s = await synthese();
    expect(s[2].lignes.map((l) => l.devise)).toEqual(["MUR", "USD"]); // triées, jamais fusionnées
    // Le net de chaque devise ne mélange que ses propres occurrences.
    expect(s[2].lignes.find((l) => l.devise === "USD")!.net).toBe("-200.00");
    expect(s[2].lignes.find((l) => l.devise === "MUR")!.net).toBe("-20014.00");
  });

  it("25. une échéance TRIMESTRIELLE est créable (migration 0023 — bug 500 en prod)", async () => {
    // `recurrence` était varchar(12) alors que 'trimestrielle' fait 13 caractères : la
    // valeur était PHYSIQUEMENT impossible à stocker (Postgres 22001), bien que le
    // formulaire la propose et que zod l'accepte. Le 22001 n'étant mappé nulle part,
    // l'utilisateur recevait une 500 brute. La branche 'trimestrielle' du CHECK était
    // MORTE. Ce test parcourt le chemin RÉEL (Server Action → repository).
    const { echeanceId } = await withWorkspace(sessAdminA, (tx, ctx) =>
      creerEcheance(tx, ctx, {
        entityId: ENT_SUCRE,
        direction: "encaissement",
        libelle: "Trimestrielle",
        montant: "100.00",
        devise: "MUR",
        dateEcheance: "2026-09-01",
        recurrence: "trimestrielle",
      }),
    );

    await client.exec(`reset role;`);
    const r = await client.query<{ recurrence: string | null }>(
      `select recurrence from echeances where id = '${echeanceId}'`,
    );
    await client.exec(`set role tygr_app;`);
    // Stockée ENTIÈRE : ni tronquée à 12, ni rejetée.
    expect(r.rows[0].recurrence).toBe("trimestrielle");
  });

  it("24. isolation tenant : la synthèse de WS_D ne voit RIEN de WS_C (et inversement)", async () => {
    // WS_C porte des montants repères (7777/9999/8888) et WS_D des gabarits : aucun
    // ne doit apparaître dans l'autre. L'expansion tourne sous la MÊME RLS.
    const d = await synthese();
    const totalD = d[2].lignes.map((l) => `${l.encaissement}/${l.decaissement}`).join("|");
    expect(totalD).toBe("10000.00/30014.00|0.00/200.00");

    const c = await withWorkspace(sessAdminC, (tx, ctx) =>
      synthetiserHorizon(tx, ctx, { aujourdhui: AUJ }),
    );
    // WS_C n'a aucune récurrente : ses totaux restent ceux du test 17.
    expect(c[2].lignes.find((l) => l.devise === "MUR")!.decaissement).toBe("600.00");
  });
});

/**
 * C1 — la source du PRÉVISIONNEL du dashboard. `occurrencesSurFenetre` tourne sous les
 * MÊMES deux étages RLS que le reste de l'écran (elle est lue dans le `Promise.all` de la
 * page, sous son `tx`) : ces cas le prouvent sous RLS réelle, rôle `tygr_app`.
 *
 * La projection est ensuite agrégée par `projeterEcheancesSurGrille` (module PUR, couvert
 * par `tests/unit/flux-previsionnel.test.ts`) : ici on prouve la LECTURE et ses bornes.
 */
describe("C1 — occurrences sur fenêtre (source du prévisionnel dashboard)", () => {
  // Fenêtre type du dashboard : d'AUJOURD'HUI au dernier jour du 3ᵉ mois projeté (D3).
  const FENETRE = { debut: AUJ, fin: "2026-09-30", aujourdhui: AUJ };

  it("25. WS_D : expanse les occurrences de la fenêtre, récurrences comprises", async () => {
    const occ = await withWorkspace(sessAdminD, (tx, ctx) =>
      occurrencesSurFenetre(tx, ctx, FENETRE),
    );
    const cle = (o: (typeof occ)[number]) => `${o.dateEcheance}:${o.devise}:${o.montant}`;
    expect(occ.map(cle).sort()).toEqual(
      [
        // R1 mensuelle dec MUR 10000 @07-11 : tête + 2 dérivées dans la fenêtre.
        "2026-07-11:MUR:10000.00",
        "2026-08-11:MUR:10000.00",
        "2026-09-11:MUR:10000.00",
        // R3 mensuelle dec USD 100 @07-11 PAYEE : tête ÉTEINTE, série VIVANTE (D1) —
        // c'est la fin de l'optimisme silencieux, ici sur le chemin du dashboard.
        "2026-08-11:USD:100.00",
        "2026-09-11:USD:100.00",
        // R5 mensuelle dec MUR 7 @08-07 : tête + 1 dérivée (10-07 déborde la fin).
        "2026-08-07:MUR:7.00",
        "2026-09-07:MUR:7.00",
      ].sort(),
    );
    // R4 (ponctuelle payée) n'apparaît nulle part : un terminal non récurrent reste éteint.
    expect(occ.some((o) => o.montant === "9999.00")).toBe(false);
  });

  it("26. la BORNE BASSE écarte une tête EN RETARD (≠ synthèse d'horizon, qui la compte)", async () => {
    // R2 (trimestrielle enc MUR 5000 @07-05) est OVERDUE à AUJ = 07-08.
    const occ = await withWorkspace(sessAdminD, (tx, ctx) =>
      occurrencesSurFenetre(tx, ctx, FENETRE),
    );
    expect(occ.some((o) => o.montant === "5000.00")).toBe(false);

    // …alors que la synthèse d'horizon, elle, la compte (« une dette exigible hier reste
    // due »). Les deux écrans divergent VOLONTAIREMENT : verser un arriéré dans un mois
    // PASSÉ des barres le mélangerait au réalisé d'une colonne rendue à 100 % d'opacité.
    const synth = await withWorkspace(sessAdminD, (tx, ctx) =>
      synthetiserHorizon(tx, ctx, { aujourdhui: AUJ }),
    );
    expect(synth[0].lignes.find((l) => l.devise === "MUR")!.encaissement).toBe("5000.00");
  });

  it("27. isolation TENANT : la fenêtre de WS_D ne voit RIEN de WS_C (et inversement)", async () => {
    const d = await withWorkspace(sessAdminD, (tx, ctx) =>
      occurrencesSurFenetre(tx, ctx, FENETRE),
    );
    // 7777/8888/9999 sont les montants repères de WS_C : aucun ne doit fuir.
    expect(d.some((o) => ["7777.00", "8888.00", "9999.00"].includes(o.montant))).toBe(false);

    const c = await withWorkspace(sessAdminC, (tx, ctx) =>
      occurrencesSurFenetre(tx, ctx, FENETRE),
    );
    // WS_C ne porte AUCUNE récurrente : ses gabarits de WS_D sont invisibles.
    expect(c.some((o) => o.montant === "10000.00")).toBe(false);
    // C7 (payee) et C8 (annulee) restent éteints ; C9 (12-01) déborde la fenêtre.
    expect(c.map((o) => o.dateEcheance).sort()).toEqual(["2026-07-20", "2026-07-25", "2026-08-01", "2026-08-20", "2026-09-20"]);
  });

  it("28. isolation ENTITÉ : un membre SCOPÉ ne projette QUE son périmètre", async () => {
    // ADMIN_A est en Vision Globale : il voit les DEUX entités.
    const vueGlobale = await withWorkspace(sessAdminA, (tx, ctx) =>
      occurrencesSurFenetre(tx, ctx, FENETRE),
    );
    const montantsGlobale = vueGlobale.map((o) => o.montant);
    expect(montantsGlobale).toContain("111.00"); // Sucrière
    expect(montantsGlobale).toContain("222.00"); // Énergie

    // MGR_SUCRE est scopé Sucrière : l'échéance d'Énergie doit DISPARAÎTRE de sa
    // projection — sinon la zone prévisionnelle fuirait entre BU du même groupe.
    const vueScopee = await withWorkspace(sessMgr, (tx, ctx) =>
      occurrencesSurFenetre(tx, ctx, FENETRE),
    );
    const montantsScopee = vueScopee.map((o) => o.montant);
    expect(montantsScopee).toContain("111.00");
    expect(montantsScopee).not.toContain("222.00");
  });
});
