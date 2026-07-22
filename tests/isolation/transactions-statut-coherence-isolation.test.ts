/**
 * Suite isolation — COHÉRENCE STRICTE entre le FILTRE de statut et la COLONNE de
 * statut affichée (PERF-VENTILATION-AGG1).
 *
 * Pourquoi une suite dédiée : `predicatStatut` (filtre, appliqué AVANT pagination) et
 * `statutExpr` (projection, calculée APRÈS) sont deux expressions SQL DISTINCTES qui
 * doivent rendre le même verdict sur chaque ligne. Rien dans les types ne le garantit —
 * seule une preuve d'exécution le fait. Un écart ne casse aucun gate : il affiche
 * simplement une ligne « Non catégorisé » dans une liste filtrée sur « Complet », sur
 * un écran financier, sans le moindre signal d'erreur.
 *
 * Le cas qui MORD : `transactions_cache.amount` est `numeric(15,2)` SANS contrainte de
 * positivité — un montant NUL est permis par le schéma. Pour une telle ligne SANS
 * split, `somme_splits >= abs(amount)` se réduit à `0 >= 0` = VRAI : l'ancien
 * `predicatStatut` la capturait donc sous « COMPLET » alors que `statutExpr`, qui teste
 * `nb_splits = 0` d'abord, l'affiche « NON_CATEGORISE ». Le garde `exists` ajouté à
 * COMPLET referme cet écart.
 *
 * Tourne sous le rôle `tygr_app` non-owner (RLS active), migrations + provisioning
 * RÉELS — même socle que les autres suites d'isolation (bloquante CI).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { listerTransactions } from "@/server/repositories/transactions";
import {
  listerTransactionsSchema,
  type StatutVentilation,
} from "@/lib/transactions-schema";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS = "c0fe0000-0000-4000-8000-000000000001";
const USER = "c0fe0000-0000-4000-8000-000000000002";
const CONN = "c0fe0000-0000-4000-8000-000000000003";
const ACC = "c0fe0000-0000-4000-8000-000000000004";
const CAT = "c0fe0000-0000-4000-8000-000000000005";
const session = { userId: USER, activeWorkspaceId: WS };

// Un représentant de chaque statut + le cas limite du montant NUL.
const T_VIDE = "c0fe1000-0000-4000-8000-000000000001"; // |400|, 0 split   → NON_CATEGORISE
const T_PART = "c0fe1000-0000-4000-8000-000000000002"; // |300|, 100      → PARTIEL
const T_COMP = "c0fe1000-0000-4000-8000-000000000003"; // |200|, 200      → COMPLET
const T_ZERO = "c0fe1000-0000-4000-8000-000000000004"; // |0|,   0 split  → cas limite

const parse = (f: Record<string, unknown>) => {
  const r = listerTransactionsSchema.safeParse(f);
  if (!r.success) throw new Error("filtre de test invalide: " + r.error.message);
  return r.data;
};

/** Ids rendus par le FILTRE `statut`. */
async function idsFiltres(statut: StatutVentilation): Promise<string[]> {
  const page = await withWorkspace(session, (tx, ctx) =>
    listerTransactions(tx, ctx, parse({ limite: 100, statut })),
  );
  return page.lignes.map((l) => l.id).sort();
}

/** Ids dont la COLONNE de statut vaut `statut`, sans aucun filtre. */
async function idsProjetes(statut: StatutVentilation): Promise<string[]> {
  const page = await withWorkspace(session, (tx, ctx) =>
    listerTransactions(tx, ctx, parse({ limite: 100 })),
  );
  return page.lignes
    .filter((l) => l.statut === statut)
    .map((l) => l.id)
    .sort();
}

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
      ('${WS}','BU Cohérence','INTERNAL_BU','eu-coh');
    insert into users (id,email,full_name) values ('${USER}','coh@g.mu','Coh');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${USER}','${WS}','MANAGER');
    insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,institution_name,created_by) values
      ('${CONN}','${WS}','c-coh','mcb','Mauritius Commercial Bank','${USER}');
    insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
      ('${ACC}','${WS}','${CONN}','a-coh','CC','MUR');
    insert into categories (id,workspace_id,name) values ('${CAT}','${WS}','Fournisseurs');

    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label,is_removed) values
      ('${T_VIDE}','${WS}','${ACC}','z1','2026-04-04','2026-04-04T08:00:00Z','-400.00','MUR','Debit','raw1','Sans split',false),
      ('${T_PART}','${WS}','${ACC}','z2','2026-04-03','2026-04-03T08:00:00Z','-300.00','MUR','Debit','raw2','Partiel',false),
      ('${T_COMP}','${WS}','${ACC}','z3','2026-04-02','2026-04-02T08:00:00Z','-200.00','MUR','Debit','raw3','Complet',false),
      -- Montant NUL sans split : le cas qui faisait diverger filtre et projection.
      ('${T_ZERO}','${WS}','${ACC}','z4','2026-04-01','2026-04-01T08:00:00Z','0.00','MUR','Debit','raw4','Montant nul',false);

    insert into transaction_categorizations
      (workspace_id,transaction_id,transaction_date,category_id,amount,source,created_by) values
      ('${WS}','${T_PART}','2026-04-03','${CAT}','100.00','MANUAL','${USER}'),
      ('${WS}','${T_COMP}','2026-04-02','${CAT}','200.00','MANUAL','${USER}');
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

describe("cohérence filtre ↔ projection (les deux vues du même agrégat)", () => {
  for (const statut of [
    "NON_CATEGORISE",
    "PARTIEL",
    "COMPLET",
  ] as StatutVentilation[]) {
    it(`filtre ${statut} = exactement les lignes dont la colonne affiche ${statut}`, async () => {
      const [filtres, projetes] = await Promise.all([
        idsFiltres(statut),
        idsProjetes(statut),
      ]);
      expect(filtres).toEqual(projetes);
    });
  }

  it("partitionne le jeu : chaque ligne tombe dans un statut et UN SEUL", async () => {
    const [nonCat, partiel, complet] = await Promise.all([
      idsFiltres("NON_CATEGORISE"),
      idsFiltres("PARTIEL"),
      idsFiltres("COMPLET"),
    ]);
    const tous = [...nonCat, ...partiel, ...complet];
    expect(new Set(tous).size).toBe(tous.length); // aucun recouvrement
    expect(tous.sort()).toEqual([T_VIDE, T_PART, T_COMP, T_ZERO].sort()); // aucun trou
  });
});

describe("cas limite — montant NUL sans split (amount = 0 est permis par le schéma)", () => {
  it("est affiché NON_CATEGORISE (nb_splits = 0 prime sur la comparaison de montants)", async () => {
    const page = await withWorkspace(session, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 100 })),
    );
    const zero = page.lignes.find((l) => l.id === T_ZERO);
    expect(zero).toBeDefined();
    expect(zero!.statut).toBe("NON_CATEGORISE");
    expect(zero!.nbSplits).toBe(0);
  });

  it("n'est PAS capturé par le filtre COMPLET (garde `exists` — sinon 0 >= abs(0))", async () => {
    expect(await idsFiltres("COMPLET")).not.toContain(T_ZERO);
  });

  it("EST capturé par le filtre NON_CATEGORISE", async () => {
    expect(await idsFiltres("NON_CATEGORISE")).toContain(T_ZERO);
  });
});

describe("agrégat borné à la page — il reste correct sous pagination", () => {
  it("chaque page porte le MÊME agrégat que la lecture non paginée", async () => {
    const complet = await withWorkspace(session, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 100 })),
    );
    const attendu = new Map(
      complet.lignes.map((l) => [
        l.id,
        { n: l.nbSplits, m: l.montantVentile, s: l.statut },
      ]),
    );

    // Rejoue le même jeu page par page (limite=1 → l'agrégat est borné à UNE ligne).
    const vus: string[] = [];
    let curseur: string | undefined;
    let gardeFou = 0;
    do {
      const page = await withWorkspace(session, (tx, ctx) =>
        listerTransactions(tx, ctx, parse({ limite: 1, curseur })),
      );
      for (const l of page.lignes) {
        vus.push(l.id);
        expect({ n: l.nbSplits, m: l.montantVentile, s: l.statut }).toEqual(
          attendu.get(l.id),
        );
      }
      curseur = page.curseurSuivant ?? undefined;
    } while (curseur && ++gardeFou < 20);

    // Zéro doublon, zéro trou : le keyset survit à la mise en sous-requête.
    expect(vus).toEqual(complet.lignes.map((l) => l.id));
  });
});
