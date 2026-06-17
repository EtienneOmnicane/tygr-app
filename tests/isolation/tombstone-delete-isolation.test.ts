/**
 * Suite tombstone — preuve que le rôle applicatif `tygr_app` ne peut JAMAIS
 * supprimer PHYSIQUEMENT une ligne des tables append-only (CLAUDE.md règle 8 :
 * `transactions_cache` et `balance_history` portent l'effacement via
 * `is_removed`/historique immuable, jamais de DELETE). Résolution dette #3bis.
 *
 * Pourquoi un test, et pas seulement le SQL : le privilège DELETE était
 * auparavant accordé en bloc (`GRANT … ON ALL TABLES`) puis rattrapé par un
 * `REVOKE` en migration 0003 — fragile à l'ordre provision/migrate ET non
 * propagé aux partitions. La garantie est désormais structurelle (liste blanche
 * deny-by-default dans `tygr_app.sql`) ; ce test la VERROUILLE contre toute
 * régression future du provisioning ou du roulement de partitions.
 *
 * Le setup applique le MÊME ordre que la suite d'isolation (migrate -> provision)
 * — historiquement le pire cas, celui qui ré-accordait DELETE. Les requêtes
 * tournent sous `tygr_app` NON-propriétaire (sinon les privilèges sont ignorés
 * pour l'owner et le test « prouverait » du vide — cf. test 0).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// On pilote PGlite en SQL brut (client.exec/query) plutôt que via Drizzle : la
// preuve porte sur les PRIVILÈGES (permission denied), au plus près du moteur,
// sans la couche ORM — même approche que le test 6 de workspace-isolation.
const client = new PGlite();

// Identifiants fixes (lisibilité). Une seule chaîne tenant suffit à la preuve.
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALICE = "11111111-1111-4111-8111-111111111111";
const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TXN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** Déplie la chaîne des `cause` (Drizzle enveloppe l'erreur driver). */
function flatten(e: unknown): string {
  let msg = "";
  let cur: unknown = e;
  while (cur instanceof Error) {
    msg += cur.message + " | ";
    cur = cur.cause;
  }
  return msg;
}

/** Exécute un statement SQL brut sous tygr_app et renvoie l'erreur éventuelle. */
async function tenter(statement: string): Promise<unknown> {
  try {
    await client.exec(statement);
    return null;
  } catch (e) {
    return e;
  }
}

beforeAll(async () => {
  // 1. Migrations RÉELLES (le DDL que la prod exécutera, REVOKE de 0003 inclus).
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error("Aucune migration dans drizzle/migrations — rien à tester.");
  }
  for (const file of files) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of raw.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await client.exec(statement);
    }
  }

  // 2. Seed minimal (owner, RLS contournée) : une transaction + un solde EOD
  //    rattachés à un workspace, pour avoir une ligne à tenter de supprimer.
  await client.exec(`
    insert into workspaces (id, name, kind, omnifi_client_user_id) values
      ('${WS}', 'BU Trésorerie', 'INTERNAL_BU', 'enduser-ws');
    insert into users (id, email, full_name) values
      ('${ALICE}', 'alice@groupe.mu', 'Alice Manager');
    insert into workspace_members (user_id, workspace_id, role) values
      ('${ALICE}', '${WS}', 'MANAGER');
    insert into bank_connections (id, workspace_id, omnifi_connection_id, institution_id, created_by) values
      ('${CONN}', '${WS}', 'omni-conn-1', 'inst-1', '${ALICE}');
    insert into bank_accounts (id, workspace_id, connection_id, omnifi_account_id, account_name, currency) values
      ('${ACCT}', '${WS}', '${CONN}', 'omni-acct-1', 'Compte courant', 'MUR');
    insert into transactions_cache
      (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw, is_removed)
      values
      ('${TXN}', '${WS}', '${ACCT}', 'omni-txn-1', '2026-03-15', '2026-03-15T08:00:00Z', '1000.00', 'MUR', 'Credit', 'VIR RECU', false);
    insert into balance_history (workspace_id, bank_account_id, balance_date, balance, currency) values
      ('${WS}', '${ACCT}', '2026-03-15', '5000.00', 'MUR');
  `);

  // 3. Provisioning RÉEL (source unique) APRÈS migrate — l'ordre qui, avant le
  //    fix #3bis, ré-accordait DELETE par le GRANT global. Si le provisioning
  //    régresse vers un GRANT large, ce test casse.
  const provisioning = readFileSync(
    path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
    "utf8",
  );
  await client.exec(provisioning);

  // 4. On pose le contexte tenant pour que les UPDATE/DELETE passent la RLS :
  //    on prouve le refus de DELETE par le PRIVILÈGE, pas par la RLS (sinon un
  //    DELETE bloqué « 0 ligne » par la policy masquerait l'absence de garantie
  //    de privilège). Contexte posé → la RLS laisse passer, seul le privilège
  //    tranche.
  await client.exec(`set role tygr_app;`);
  await client.exec(
    `select set_config('app.current_workspace_id', '${WS}', false);`,
  );
});

afterAll(async () => {
  await client.close();
});

describe("préconditions", () => {
  it("0. les requêtes tournent sous tygr_app (sinon les privilèges sont ignorés)", async () => {
    const res = await client.query<{ who: string }>(
      "select current_user as who",
    );
    expect(res.rows[0].who).toBe("tygr_app");
  });

  it("0bis. le contexte workspace est posé (la RLS ne masquera pas la ligne)", async () => {
    const visible = await client.query(
      `select 1 from transactions_cache where id = '${TXN}'`,
    );
    expect(visible.rows).toHaveLength(1);
  });
});

describe("tombstone : DELETE physique interdit sur les tables append-only (#3bis)", () => {
  it("1. DELETE sur transactions_cache (table mère) → permission denied", async () => {
    const err = await tenter(
      `delete from transactions_cache where id = '${TXN}'`,
    );
    expect(err, "le DELETE doit être refusé").not.toBeNull();
    expect(flatten(err)).toMatch(/permission denied/i);
  });

  it("2. DELETE sur une PARTITION en direct (transactions_cache_2026) → permission denied", async () => {
    // Sous tygr_app, c'est le PRIVILÈGE qui tranche : la liste blanche n'accorde
    // DELETE à AUCUNE partition (ni à la mère). Le trigger (filet append-only
    // indépendant du privilège) est prouvé séparément sous l'owner, plus bas.
    const err = await tenter(
      `delete from transactions_cache_2026 where id = '${TXN}'`,
    );
    expect(err, "le DELETE direct sur la partition doit être refusé").not.toBeNull();
    expect(flatten(err)).toMatch(/permission denied/i);
  });

  it("3. DELETE sur la partition DEFAULT → permission denied", async () => {
    const err = await tenter(`delete from transactions_cache_default where false`);
    expect(err).not.toBeNull();
    expect(flatten(err)).toMatch(/permission denied/i);
  });

  it("4. DELETE sur balance_history → permission denied", async () => {
    const err = await tenter(
      `delete from balance_history where bank_account_id = '${ACCT}'`,
    );
    expect(err, "le DELETE doit être refusé").not.toBeNull();
    expect(flatten(err)).toMatch(/permission denied/i);
  });
});

describe("l'effacement LOGIQUE reste autorisé (le tombstone n'est pas un gel)", () => {
  it("5. UPDATE is_removed=true sur transactions_cache → autorisé", async () => {
    const err = await tenter(
      `update transactions_cache set is_removed = true where id = '${TXN}'`,
    );
    expect(err, "l'effacement logique (UPDATE) doit rester possible").toBeNull();

    const r = await client.query<{ is_removed: boolean }>(
      `select is_removed from transactions_cache where id = '${TXN}'`,
    );
    expect(r.rows[0].is_removed).toBe(true);
  });

  it("6. la ligne tombstone existe TOUJOURS physiquement (pas de suppression)", async () => {
    const r = await client.query(
      `select 1 from transactions_cache where id = '${TXN}'`,
    );
    expect(r.rows).toHaveLength(1);
  });
});

describe("vecteur CASCADE : la suppression d'un parent ne détruit PAS l'append-only (#3bis, trigger 0004)", () => {
  // Le privilège DELETE est légitimement accordé sur bank_accounts /
  // bank_connections (déconnexion d'une banque). Sans le trigger BEFORE DELETE,
  // la cascade FK (ON DELETE cascade) supprimerait PHYSIQUEMENT les
  // transactions_cache / balance_history rattachées SANS re-vérifier leur
  // privilège — trou MAJEUR trouvé en cross-review (1 ligne -> 0). Le trigger
  // annule toute la transaction. Ces cas seraient ROUGES sans 0004.

  it("8. DELETE bank_accounts (cascade) → rejeté par le trigger append-only", async () => {
    const err = await tenter(`delete from bank_accounts where id = '${ACCT}'`);
    expect(err, "la cascade vers l'append-only doit être rejetée").not.toBeNull();
    expect(flatten(err)).toMatch(/append_only_no_delete|append-only/i);
  });

  it("9. après la tentative, les lignes append-only sont TOUJOURS là (transaction annulée)", async () => {
    const txn = await client.query(
      `select 1 from transactions_cache where id = '${TXN}'`,
    );
    const bal = await client.query(
      `select 1 from balance_history where bank_account_id = '${ACCT}'`,
    );
    expect(txn.rows, "transaction préservée").toHaveLength(1);
    expect(bal.rows, "solde EOD préservé").toHaveLength(1);
  });

  it("10. DELETE bank_connections (cascade 2 sauts) → rejeté, append-only intact", async () => {
    const err = await tenter(
      `delete from bank_connections where id = '${CONN}'`,
    );
    expect(err, "la cascade 2 sauts doit être rejetée").not.toBeNull();
    expect(flatten(err)).toMatch(/append_only_no_delete|append-only/i);

    const txn = await client.query(
      `select 1 from transactions_cache where id = '${TXN}'`,
    );
    expect(txn.rows, "transaction toujours présente").toHaveLength(1);
  });
});

describe("contre-preuve : DELETE reste autorisé sur les tables NORMALES", () => {
  it("7. DELETE sur workspace_members (table normale) → autorisé (on n'a pas tout cassé)", async () => {
    // Sinon le test « tout est refusé » serait satisfait par un rôle sans aucun
    // privilège DELETE — la liste blanche doit accorder les tables légitimes.
    const err = await tenter(
      `delete from workspace_members where user_id = '${ALICE}' and workspace_id = '${WS}'`,
    );
    expect(err, "le DELETE sur une table normale doit réussir").toBeNull();
  });
});

describe("le TRIGGER (filet append-only, indépendant du privilège) couvre les partitions — sous OWNER", () => {
  // Sous tygr_app, le privilège masque le trigger (permission denied avant lui).
  // On bascule sur l'OWNER (qui n'est PAS bloqué par le privilège) pour prouver
  // que c'est bien le TRIGGER qui interdit le DELETE physique — y compris sur
  // une partition visée en direct et sur une partition FUTURE (héritage du
  // trigger de la mère, contraste avec la RLS qui, elle, n'est pas héritée).
  beforeAll(async () => {
    await client.exec(`reset role;`); // -> owner
  });
  afterAll(async () => {
    await client.exec(`set role tygr_app;`); // on rend l'état au reste de la suite
  });

  it("11. owner : DELETE sur la mère (routé en partition) → rejeté par le trigger", async () => {
    const err = await tenter(
      `delete from transactions_cache where id = '${TXN}'`,
    );
    expect(err).not.toBeNull();
    expect(flatten(err)).toMatch(/append_only_no_delete/i);
  });

  it("12. owner : DELETE sur une partition EN DIRECT → rejeté par le trigger hérité", async () => {
    const err = await tenter(
      `delete from transactions_cache_2026 where id = '${TXN}'`,
    );
    expect(err).not.toBeNull();
    expect(flatten(err)).toMatch(/append_only_no_delete/i);
  });

  it("13. owner : une partition FUTURE (créée après 0004) hérite le trigger → DELETE rejeté", async () => {
    // Prouve que le roulement annuel n'a PAS à re-poser le trigger : il est
    // cloné automatiquement à toute nouvelle partition (PostgreSQL >= 11).
    await client.exec(
      `create table transactions_cache_2099 partition of transactions_cache for values from ('2099-01-01') to ('2100-01-01');`,
    );
    await client.exec(
      `insert into transactions_cache
        (id, workspace_id, bank_account_id, omnifi_txn_id, transaction_date, booking_date_time, amount, currency, credit_debit, bank_label_raw)
        values
        ('ffffffff-ffff-4fff-8fff-ffffffffffff', '${WS}', '${ACCT}', 'omni-txn-future', '2099-06-01', '2099-06-01T08:00:00Z', '1.00', 'MUR', 'Credit', 'x');`,
    );
    const err = await tenter(
      `delete from transactions_cache_2099 where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'`,
    );
    expect(err, "la partition future doit hériter le trigger").not.toBeNull();
    expect(flatten(err)).toMatch(/append_only_no_delete/i);

    const survie = await client.query(
      `select 1 from transactions_cache_2099 where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'`,
    );
    expect(survie.rows, "ligne préservée").toHaveLength(1);
  });
});
