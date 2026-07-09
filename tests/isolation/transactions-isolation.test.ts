/**
 * Suite isolation — lecture paginée des transactions (B1-B3, page /transactions).
 * Prouve :
 * - RLS : un workspace ne voit JAMAIS les transactions d'un autre (tenant_isolation).
 * - Keyset STABLE & déterministe : tri (transaction_date DESC, id DESC), pagination
 *   par curseur exhaustive et sans doublon/trou, y compris pour deux transactions
 *   LE MÊME JOUR (départage par id) — aucune dépendance à OFFSET.
 * - Résumé de ventilation ANTI-N+1 : nbSplits / montantVentile / statut calculés
 *   en UNE requête (NON_CATEGORISE / PARTIEL / COMPLET).
 * - Tombstone : is_removed=true exclu de toute lecture.
 * - Filtres : compte, recherche (clean_label), bornes de date, statut.
 *
 * Tourne sous le rôle `tygr_app` non-owner (RLS active) avec migrations +
 * provisioning RÉELS (même socle que les autres suites d'isolation, bloquante CI).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import {
  CurseurInvalideError,
  listerTransactions,
} from "@/server/repositories/transactions";
import { listerTransactionsSchema } from "@/lib/transactions-schema";

const client = new PGlite();
const db = drizzle(client, { schema });
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const sessionA = { userId: ALICE, activeWorkspaceId: WS_A };
const sessionB = { userId: BOB, activeWorkspaceId: WS_B };

const ACC_A = "dddd0001-dddd-4ddd-8ddd-dddddddddddd";
const CAT_A = "aaaacccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// 5 transactions A sur 3 jours. T2/T3 partagent le 2026-03-14 (départage par id :
// T3 > T2 lexicographiquement → T3 d'abord en DESC). T5 est is_removed.
const T1 = "11110001-0000-4000-8000-000000000000"; // 2026-03-15, |500|, NON catégorisé
const T2 = "22220002-0000-4000-8000-000000000000"; // 2026-03-14, |300|, PARTIEL (100)
const T3 = "33330003-0000-4000-8000-000000000000"; // 2026-03-14, |200|, COMPLET (200)
const T4 = "44440004-0000-4000-8000-000000000000"; // 2026-03-13, |100|, "Salaire ACME"
const T5 = "55550005-0000-4000-8000-000000000000"; // 2026-03-12, is_removed=true

// Ordre attendu en (date DESC, id DESC), tombstone exclu : T1, T3, T2, T4.
const ORDRE_ATTENDU = [T1, T3, T2, T4];

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
      ('${WS_A}','BU A','INTERNAL_BU','eu-a'), ('${WS_B}','BU B','INTERNAL_BU','eu-b');
    insert into users (id,email,full_name) values
      ('${ALICE}','a@g.mu','Alice'), ('${BOB}','b@g.mu','Bob');
    insert into workspace_members (user_id,workspace_id,role) values
      ('${ALICE}','${WS_A}','MANAGER'), ('${BOB}','${WS_B}','MANAGER');
    insert into bank_connections (id,workspace_id,omnifi_connection_id,institution_id,institution_name,created_by) values
      ('cccc0001-cccc-4ccc-8ccc-cccccccccccc','${WS_A}','c-a','mcb','Mauritius Commercial Bank','${ALICE}'),
      ('cccc0002-cccc-4ccc-8ccc-cccccccccccc','${WS_B}','c-b','mcb','Bank One','${BOB}');
    insert into bank_accounts (id,workspace_id,connection_id,omnifi_account_id,account_name,currency) values
      ('${ACC_A}','${WS_A}','cccc0001-cccc-4ccc-8ccc-cccccccccccc','a-a','CC','MUR'),
      ('dddd0002-dddd-4ddd-8ddd-dddddddddddd','${WS_B}','cccc0002-cccc-4ccc-8ccc-cccccccccccc','a-b','CC','MUR');
    insert into categories (id,workspace_id,name) values
      ('${CAT_A}','${WS_A}','Fournisseurs');

    -- Transactions A (montants négatifs : ce sont des Debit ; l'invariant et le
    -- statut utilisent abs()).
    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label,is_removed) values
      ('${T1}','${WS_A}','${ACC_A}','x1','2026-03-15','2026-03-15T08:00:00Z','-500.00','MUR','Debit','raw1','Achat A',false),
      ('${T2}','${WS_A}','${ACC_A}','x2','2026-03-14','2026-03-14T08:00:00Z','-300.00','MUR','Debit','raw2','Achat B',false),
      ('${T3}','${WS_A}','${ACC_A}','x3','2026-03-14','2026-03-14T09:00:00Z','-200.00','MUR','Debit','raw3','Achat C',false),
      ('${T4}','${WS_A}','${ACC_A}','x4','2026-03-13','2026-03-13T08:00:00Z','-100.00','MUR','Debit','raw4','Salaire ACME',false),
      ('${T5}','${WS_A}','${ACC_A}','x5','2026-03-12','2026-03-12T08:00:00Z','-999.00','MUR','Debit','raw5','Supprimee',true);

    -- Transaction du workspace B (ne doit JAMAIS apparaître pour A).
    insert into transactions_cache
      (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label,is_removed) values
      ('eeee9999-eeee-4eee-8eee-eeeeeeeeeeee','${WS_B}','dddd0002-dddd-4ddd-8ddd-dddddddddddd','y1','2026-03-15','2026-03-15T08:00:00Z','-777.00','MUR','Debit','rawB','Secret B',false);

    -- Splits : T2 partiel (100/300) ; T3 complet (200/200). T1, T4 sans split.
    insert into transaction_categorizations
      (workspace_id,transaction_id,transaction_date,category_id,amount,source,created_by) values
      ('${WS_A}','${T2}','2026-03-14','${CAT_A}','100.00','MANUAL','${ALICE}'),
      ('${WS_A}','${T3}','2026-03-14','${CAT_A}','200.00','MANUAL','${ALICE}');
  `);

  await client.exec(
    readFileSync(path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"), "utf8"),
  );
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

describe("RLS / tombstone", () => {
  it("le workspace A ne voit QUE ses 4 transactions vivantes (B exclu, tombstone exclu)", async () => {
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 100 })),
    );
    expect(page.lignes.map((l) => l.id)).toEqual(ORDRE_ATTENDU);
    expect(page.hasMore).toBe(false);
    // Aucune ligne d'un autre workspace, aucun tombstone.
    expect(page.lignes.some((l) => l.cleanLabel === "Secret B")).toBe(false);
    expect(page.lignes.some((l) => l.id === T5)).toBe(false);
  });

  it("le workspace B ne voit QUE sa transaction", async () => {
    const page = await withWorkspace(sessionB, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 100 })),
    );
    expect(page.lignes).toHaveLength(1);
    expect(page.lignes[0].cleanLabel).toBe("Secret B");
  });
});

describe("pagination keyset (curseur, jamais OFFSET)", () => {
  it("parcourt toutes les pages sans doublon ni trou, ordre stable même à date égale", async () => {
    const vus: string[] = [];
    let curseur: string | undefined;
    let gardeFou = 0;
    do {
      const page = await withWorkspace(sessionA, (tx, ctx) =>
        listerTransactions(tx, ctx, parse({ limite: 2, curseur })),
      );
      vus.push(...page.lignes.map((l) => l.id));
      curseur = page.curseurSuivant ?? undefined;
      if (++gardeFou > 10) throw new Error("boucle de pagination non bornée");
    } while (curseur);

    // Exhaustif, ordonné, sans doublon — y compris T3 avant T2 (même jour, id>).
    expect(vus).toEqual(ORDRE_ATTENDU);
    expect(new Set(vus).size).toBe(vus.length);
  });

  it("hasMore=true et curseur non nul quand il reste des lignes", async () => {
    const p1 = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 2 })),
    );
    expect(p1.lignes.map((l) => l.id)).toEqual([T1, T3]);
    expect(p1.hasMore).toBe(true);
    expect(p1.curseurSuivant).not.toBeNull();

    const p2 = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 2, curseur: p1.curseurSuivant! })),
    );
    expect(p2.lignes.map((l) => l.id)).toEqual([T2, T4]);
    expect(p2.hasMore).toBe(false);
    expect(p2.curseurSuivant).toBeNull();
  });

  it("REJETTE un curseur falsifié (forme base64url valide, contenu absurde)", async () => {
    const faux = Buffer.from("pas-une-cle", "utf8").toString("base64url");
    await expect(
      withWorkspace(sessionA, (tx, ctx) =>
        listerTransactions(tx, ctx, parse({ curseur: faux })),
      ),
    ).rejects.toBeInstanceOf(CurseurInvalideError);
  });

  // Correctif cross-review F1 : une date au bon FORMAT mais calendairement
  // IMPOSSIBLE ne doit PAS atteindre Postgres (sinon '2026-13-99'::date → erreur
  // DB brute), mais redevenir une « page invalide » propre.
  const UUID_OK = "11110001-0000-4000-8000-000000000000";
  it.each(["2026-13-99", "9999-99-99", "2026-02-30", "2026-00-00"])(
    "REJETTE un curseur à date impossible %s (CurseurInvalideError, pas d'erreur SQL)",
    async (dateImpossible) => {
      const faux = Buffer.from(`${dateImpossible}|${UUID_OK}`, "utf8").toString(
        "base64url",
      );
      await expect(
        withWorkspace(sessionA, (tx, ctx) =>
          listerTransactions(tx, ctx, parse({ curseur: faux })),
        ),
      ).rejects.toBeInstanceOf(CurseurInvalideError);
    },
  );
});

describe("résumé de ventilation (anti-N+1, calculé en SQL)", () => {
  it("attribue le bon statut/nbSplits/montant à chaque ligne", async () => {
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 100 })),
    );
    const parId = Object.fromEntries(page.lignes.map((l) => [l.id, l]));

    expect(parId[T1].statut).toBe("NON_CATEGORISE");
    expect(parId[T1].nbSplits).toBe(0);
    expect(parId[T1].montantVentile).toBe("0");

    expect(parId[T2].statut).toBe("PARTIEL");
    expect(parId[T2].nbSplits).toBe(1);
    expect(Number(parId[T2].montantVentile)).toBe(100);

    expect(parId[T3].statut).toBe("COMPLET");
    expect(parId[T3].nbSplits).toBe(1);
    expect(Number(parId[T3].montantVentile)).toBe(200);
  });

  it("mono-split : la catégorie dominante = LA catégorie (id + nom, même requête)", async () => {
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 100 })),
    );
    const parId = Object.fromEntries(page.lignes.map((l) => [l.id, l]));
    // FB0709-TX-CATEGORIE-VISIBLE1 : le nom est joint en SQL (anti-N+1).
    expect(parId[T2].categorieDominanteId).toBe(CAT_A);
    expect(parId[T2].categorieDominanteNom).toBe("Fournisseurs");
    // Sans split : null (LEFT JOIN), jamais un nom fabriqué.
    expect(parId[T1].categorieDominanteId).toBeNull();
    expect(parId[T1].categorieDominanteNom).toBeNull();
  });
});

describe("filtres", () => {
  it("filtre par statut NON_CATEGORISE", async () => {
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ statut: "NON_CATEGORISE", limite: 100 })),
    );
    expect(page.lignes.map((l) => l.id).sort()).toEqual([T1, T4].sort());
  });

  it("filtre par statut COMPLET", async () => {
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ statut: "COMPLET", limite: 100 })),
    );
    expect(page.lignes.map((l) => l.id)).toEqual([T3]);
  });

  it("recherche sur clean_label (insensible à la casse)", async () => {
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ recherche: "salaire", limite: 100 })),
    );
    expect(page.lignes.map((l) => l.id)).toEqual([T4]);
  });

  it("bornes de date (incluses)", async () => {
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ dateDebut: "2026-03-14", dateFin: "2026-03-14", limite: 100 })),
    );
    expect(page.lignes.map((l) => l.id)).toEqual([T3, T2]);
  });

  // Demi-bornes : couvrent les branches if(dateDebut)/if(dateFin) prises
  // INDÉPENDAMMENT (chemins UI « depuis » et « jusqu'à », types-transactions §2.1) —
  // le cas from+to ci-dessus ne les exerce pas isolément.
  it("dateDebut seul → uniquement les transactions ≥ borne (borne basse)", async () => {
    // ≥ 2026-03-14 : T1 (03-15), T3/T2 (03-14) ; exclut T4 (03-13). T5 tombstone.
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ dateDebut: "2026-03-14", limite: 100 })),
    );
    expect(page.lignes.map((l) => l.id)).toEqual([T1, T3, T2]);
  });

  it("dateFin seul → uniquement les transactions ≤ borne (borne haute)", async () => {
    // ≤ 2026-03-14 : T3/T2 (03-14), T4 (03-13) ; exclut T1 (03-15). T5 tombstone.
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ dateFin: "2026-03-14", limite: 100 })),
    );
    expect(page.lignes.map((l) => l.id)).toEqual([T3, T2, T4]);
  });

  it("filtre par compte (un seul compte ici → toutes les lignes vivantes)", async () => {
    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ bankAccountId: ACC_A, limite: 100 })),
    );
    expect(page.lignes.map((l) => l.id)).toEqual(ORDRE_ATTENDU);
  });

  // Provenance bancaire par transaction (challenge mapping 2026-06-22) : la jointure
  // bank_accounts ⋈ bank_connections expose accountName + institutionName.
  describe("provenance : nom de compte + nom d'institution joints", () => {
    it("chaque ligne porte accountName (bank_accounts) et institutionName (bank_connections)", async () => {
      const page = await withWorkspace(sessionA, (tx, ctx) =>
        listerTransactions(tx, ctx, parse({ limite: 100 })),
      );
      expect(page.lignes.length).toBeGreaterThan(0);
      // WS_A : compte « CC » rattaché à la connexion « Mauritius Commercial Bank ».
      for (const l of page.lignes) {
        expect(l.accountName).toBe("CC");
        expect(l.institutionName).toBe("Mauritius Commercial Bank");
      }
    });

    it("l'institution suit le TENANT : depuis B, c'est « Bank One », jamais celle de A", async () => {
      const page = await withWorkspace(sessionB, (tx, ctx) =>
        listerTransactions(tx, ctx, parse({ limite: 100 })),
      );
      expect(page.lignes.length).toBeGreaterThan(0);
      for (const l of page.lignes) {
        expect(l.institutionName).toBe("Bank One");
        expect(l.institutionName).not.toBe("Mauritius Commercial Bank");
      }
    });
  });
});

// ── Garde-fou L7a : la suite tourne-t-elle vraiment sous tygr_app ? ───────────
// Sans cette précondition, un `set role tygr_app` régressé ferait tourner la suite
// sous l'owner (RLS ignorée) en passant au vert silencieusement (faux-vert). Le test
// pose lui-même le rôle (auto-suffisant, indépendant de l'ordre des autres cas).
describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app, pas sous l'owner (sinon la RLS est ignorée)", async () => {
    await client.exec(`set role tygr_app;`);
    const res = await client.query<{ who: string }>("select current_user as who");
    expect(res.rows[0].who).toBe("tygr_app");
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

// ── Catégorie dominante multi-splits (FB0709-TX-CATEGORIE-VISIBLE1) ──────────
// Déclaré EN DERNIER à dessein : ce bloc sème une transaction SUPPLÉMENTAIRE (T6)
// qui fausserait les énumérations exhaustives des describes précédents (l'ordre
// d'exécution vitest suit l'ordre de déclaration). Le semis passe par withWorkspace
// sous tygr_app (GUC posé → WITH CHECK tenant vérifié, même chemin que l'app).
describe("catégorie dominante multi-splits (FB0709-TX-CATEGORIE-VISIBLE1)", () => {
  const T6 = "66660006-0000-4000-8000-000000000000"; // 2026-03-11, 2 splits
  const CAT_A2 = "bbbbcccc-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // « Loyer »

  afterAll(async () => {
    // Hygiène : tombstone (jamais de DELETE, append-only) pour que toute
    // extension future de la suite retrouve le jeu de données initial.
    await withWorkspace(sessionA, (tx) =>
      tx.execute(
        sql`update transactions_cache set is_removed = true where id = ${T6}::uuid`,
      ),
    );
  });

  it("multi-splits : la dominante est la part au plus GROS montant", async () => {
    await withWorkspace(sessionA, async (tx) => {
      await tx.execute(
        sql`insert into categories (id, workspace_id, name) values (${CAT_A2}, ${WS_A}, 'Loyer')`,
      );
      await tx.execute(sql`
        insert into transactions_cache
          (id,workspace_id,bank_account_id,omnifi_txn_id,transaction_date,booking_date_time,amount,currency,credit_debit,bank_label_raw,clean_label,is_removed)
        values
          (${T6},${WS_A},${ACC_A},'x6','2026-03-11','2026-03-11T08:00:00Z','-300.00','MUR','Debit','raw6','Achat D',false)
      `);
      // 50 (Fournisseurs) + 250 (Loyer) = 300 = |montant| → COMPLET ; dominante = Loyer.
      await tx.execute(sql`
        insert into transaction_categorizations
          (workspace_id,transaction_id,transaction_date,category_id,amount,source,created_by)
        values
          (${WS_A},${T6},'2026-03-11',${CAT_A},'50.00','MANUAL',${ALICE}),
          (${WS_A},${T6},'2026-03-11',${CAT_A2},'250.00','MANUAL',${ALICE})
      `);
    });

    const page = await withWorkspace(sessionA, (tx, ctx) =>
      listerTransactions(tx, ctx, parse({ limite: 100 })),
    );
    const l = page.lignes.find((x) => x.id === T6);
    expect(l).toBeDefined();
    expect(l?.nbSplits).toBe(2);
    expect(l?.statut).toBe("COMPLET");
    expect(l?.categorieDominanteId).toBe(CAT_A2);
    expect(l?.categorieDominanteNom).toBe("Loyer");
  });
});
