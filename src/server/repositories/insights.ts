/**
 * Services de LECTURE des Insights financiers DÉRIVÉS (TECH-API-INSIGHTS, Voie A).
 *
 * Le module amont Omni-FI `/insights/*` n'est pas livré (501 NOT_IMPLEMENTED,
 * audit Staging 2026-06-24 — cf. PLAN-tech-api-insights.md + dette INSIGHTS-AMONT1).
 * On dérive donc cashflow & vendors de `transactions_cache`. Mêmes invariants que
 * `dashboard.ts` (le modèle de ce fichier) :
 *
 * - Tenant (règle 2) : tout s'exécute DANS `withWorkspace(session, fn)` ; `tx` porte
 *   `app.current_workspace_id` → chaque SELECT est filtré par la policy RLS
 *   `tenant_isolation`. Aucune fonction ne prend `workspace_id` en paramètre.
 * - Scope ENTITÉ (ENTITY-READ-JOIN1) : la policy RESTRICTIVE `entity_scope` vit sur
 *   `bank_accounts`. `transactions_cache` n'en hérite QUE par une JOINTURE sur
 *   `bank_accounts` (sûre : `bank_account_id` NOT NULL). En Vision Globale (GUC vide)
 *   la RESTRICTIVE laisse tout passer (agrégats inchangés) ; en Vision Entité, les
 *   comptes hors périmètre (et non assignés) sont masqués. Ne JAMAIS lire cette table
 *   fille sans cette jointure (sinon fuite intra-groupe — étage 2).
 * - Montants (règle 8) : agrégats EN SQL (numeric), sortie en CHAÎNES décimales — pas
 *   de float côté JS. `part` (ratio) calculé EN SQL avec `nullif` (anti-DIV/0).
 * - Multi-devises : GROUP BY currency, une ligne/point par devise, JAMAIS d'addition
 *   cross-devise, aucune conversion FX (DASH-FX1). Tombstones (is_removed) exclus.
 * - Fuseau Maurice (E20) : on groupe sur `transaction_date`, DÉJÀ la date comptable
 *   Maurice (dérivée à l'ingestion AT TIME ZONE Indian/Mauritius). Pas de re-conversion.
 *
 * Sécurité d'injection (Gate OWASP) : aucune valeur d'entrée n'est interpolée dans le
 * SQL. La granularité est mappée vers une CONSTANTE SQL figée (table `UNITE_TRUNC`),
 * jamais la chaîne reçue ; la direction pilote des `filter (where …)` à littéral fixe ;
 * les dates et `topN` transitent en paramètres liés. Les entrées sont en outre validées
 * en amont par les schémas zod de `insights/validation.ts`, et re-bornées défensivement
 * ici (défense en profondeur : un appelant interne ne doit pas pouvoir contourner).
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { bankAccounts, transactionsCache } from "@/server/db/schema";
import type { WorkspaceTx } from "@/server/db/tenancy";
// Bornes définies à la frontière (src/lib, source unique) — le repository les RÉUTILISE
// (dépendance server → lib autorisée). Cf. insights-schema.ts.
import { VENDORS_TOP_N_DEFAUT, VENDORS_TOP_N_MAX } from "@/lib/insights-schema";

import type {
  ConcentrationVendors,
  DirectionVendors,
  GranulariteCashflow,
  LigneVendor,
  PointCashflow,
  SerieCashflow,
} from "@/server/insights/types";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
type Tx = WorkspaceTx<AnyPgDatabase>;

/** Erreur nommée (règle 3) — paramètres d'insights hors bornes (défense en profondeur). */
export class InsightsParamsInvalidesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsightsParamsInvalidesError";
  }
}

/**
 * Unité de `date_trunc` par granularité. CONSTANTE figée (jamais la valeur d'entrée
 * interpolée) — c'est la garde anti-injection : on indexe par une enum déjà validée,
 * la valeur SQL est un littéral du code.
 */
const UNITE_TRUNC: Record<GranulariteCashflow, "day" | "week" | "month"> = {
  jour: "day",
  semaine: "week",
  mois: "month",
};

/** Format de l'étiquette de bucket par granularité (mois → "YYYY-MM", sinon "YYYY-MM-DD"). */
const FORMAT_BUCKET: Record<GranulariteCashflow, string> = {
  jour: "YYYY-MM-DD",
  semaine: "YYYY-MM-DD", // lundi de la semaine (date_trunc('week') en ISO)
  mois: "YYYY-MM",
};

/** Validation calendaire stricte d'une date "YYYY-MM-DD" (pièges F1/F2 : 2026-02-30 invalide). */
function estDateCalendaireValide(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, j] = s.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return (
    d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j
  );
}

/**
 * Série cashflow (entrées/sorties/net) par bucket temporel ET par devise, sur la
 * fenêtre [from, to] (bornes INCLUSIVES, dates comptables Maurice "YYYY-MM-DD").
 *
 * Borne haute rendue exclusive en SQL (`< to + 1 jour`) pour inclure tout le jour `to`.
 * Une ligne par (bucket, devise) ; mois/semaine via `date_trunc` sur une unité figée.
 * Bucket sans transaction → ABSENT (on ne fabrique pas de 0 : en multi-devise on ne
 * saurait pas dans quelle devise le mettre — l'UI comble l'axe si besoin, comme le
 * dashboard via grilleMois).
 */
export async function cashflowParDevise(
  tx: Tx,
  params: { granularite: GranulariteCashflow; from: string; to: string },
): Promise<SerieCashflow> {
  const { granularite, from, to } = params;
  if (!(granularite in UNITE_TRUNC)) {
    throw new InsightsParamsInvalidesError(`granularité invalide : ${granularite}`);
  }
  if (!estDateCalendaireValide(from) || !estDateCalendaireValide(to)) {
    throw new InsightsParamsInvalidesError("bornes de dates invalides (YYYY-MM-DD)");
  }
  if (from > to) {
    throw new InsightsParamsInvalidesError("from doit être ≤ to");
  }

  const unite = UNITE_TRUNC[granularite]; // littéral figé, pas l'entrée brute
  const fmt = FORMAT_BUCKET[granularite];
  // `unite`/`fmt` sont INLINÉS via sql.raw (pas des paramètres liés) — DÉLIBÉRÉ et SÛR :
  // ce sont des littéraux du code issus de tables figées indexées par une enum déjà
  // validée (UNITE_TRUNC/FORMAT_BUCKET), JAMAIS une valeur d'entrée. Les passer en
  // paramètres ($1) casse l'égalité d'expression SELECT↔GROUP BY (Postgres compare les
  // placeholders, pas leur valeur → 42803 "must appear in GROUP BY"). Inliner garantit
  // que l'expression du SELECT et celle du GROUP BY sont TEXTUELLEMENT identiques.
  const bucket = sql<string>`to_char(date_trunc(${sql.raw(`'${unite}'`)}, ${transactionsCache.transactionDate}), ${sql.raw(`'${fmt}'`)})`;

  const lignes = await tx
    .select({
      bucket,
      currency: transactionsCache.currency,
      // ::numeric(15,2)::text fige l'ÉCHELLE (2 décimales) même quand le coalesce
      // tombe sur le littéral 0 (aucune ligne du filtre) — sinon "0" vs "0.00" selon la
      // présence de données, ce qui casserait l'alignement des virgules à l'affichage
      // (contrat « chaîne décimale », règle 8). Précision alignée sur la colonne amount.
      entrees: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)::numeric(15,2)::text`,
      sorties: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)::numeric(15,2)::text`,
      net: sql<string>`(
        coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)
        - coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)
      )::numeric(15,2)::text`,
      nbTransactions: sql<number>`count(*)::int`,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage du scope entité par jointure sur bank_accounts.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(transactionsCache.isRemoved, false),
        gte(transactionsCache.transactionDate, from),
        // Borne haute INCLUSIVE sur `to` : < to + 1 jour (calcul SQL).
        lt(
          transactionsCache.transactionDate,
          sql`(${to}::date + interval '1 day')`,
        ),
      ),
    )
    .groupBy(bucket, transactionsCache.currency)
    .orderBy(bucket, transactionsCache.currency);

  return { granularite, points: lignes as PointCashflow[] };
}

/**
 * Concentration des contreparties (vendors) par devise. `direction` choisit le sens
 * agrégé : `outflow` (Debit, défaut métier), `inflow` (Credit), `both` (tous sens, le
 * montant est alors la somme brute des montants, sans signe). `part` = montant de la
 * ligne / total de SA devise (0..1, chaîne décimale, `nullif` anti-DIV/0).
 *
 * Contrepartie = `clean_label` (libellé NETTOYÉ) ; repli `primary_category` puis
 * "(Sans libellé)". JAMAIS `bank_label_raw` (PII, règle 8). Les lignes au même libellé
 * normalisé (dans une même devise) sont agrégées. Tri : montant décroissant, puis
 * libellé (stable). `topN` borné [1, VENDORS_TOP_N_MAX].
 *
 * NB : le top N est appliqué APRÈS agrégation, sur l'ensemble multi-devise trié par
 * montant — c'est un classement des plus gros postes toutes devises confondues, pas un
 * top N par devise (cohérent avec « concentration des dépenses »). La `part` reste,
 * elle, relative à la devise de la ligne (jamais un ratio cross-devise).
 */
export async function vendorsParConcentration(
  tx: Tx,
  params: { direction: DirectionVendors; topN?: number },
): Promise<ConcentrationVendors> {
  const direction = params.direction;
  if (direction !== "inflow" && direction !== "outflow" && direction !== "both") {
    throw new InsightsParamsInvalidesError(`direction invalide : ${direction}`);
  }
  const topN = params.topN ?? VENDORS_TOP_N_DEFAUT;
  if (!Number.isInteger(topN) || topN < 1 || topN > VENDORS_TOP_N_MAX) {
    throw new InsightsParamsInvalidesError(
      `topN hors bornes [1, ${VENDORS_TOP_N_MAX}] : ${topN}`,
    );
  }

  // Filtre de sens : littéraux figés (pas d'entrée interpolée). `both` = pas de filtre.
  const filtreSens =
    direction === "outflow"
      ? sql`and ${transactionsCache.creditDebit} = 'Debit'`
      : direction === "inflow"
        ? sql`and ${transactionsCache.creditDebit} = 'Credit'`
        : sql``;

  // Libellé de contrepartie : clean_label, repli primary_category, puis "(Sans libellé)".
  const contrepartie = sql<string>`coalesce(nullif(${transactionsCache.cleanLabel}, ''), nullif(${transactionsCache.primaryCategory}, ''), '(Sans libellé)')`;

  // window sum(amount) over (partition by currency) = total de la devise pour la `part`.
  const lignes = await tx
    .select({
      contrepartie,
      currency: transactionsCache.currency,
      montant: sql<string>`sum(${transactionsCache.amount})::numeric(15,2)::text`,
      // part = montant ligne / total devise ; nullif anti-DIV/0 (total nul → NULL → "0").
      part: sql<string>`coalesce(
        (sum(${transactionsCache.amount})
          / nullif(sum(sum(${transactionsCache.amount})) over (partition by ${transactionsCache.currency}), 0)
        )::text, '0')`,
      nbTransactions: sql<number>`count(*)::int`,
    })
    .from(transactionsCache)
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(transactionsCache.isRemoved, false),
        // Filtre de sens injecté en littéral figé via raw fragment.
        sql`true ${filtreSens}`,
      ),
    )
    .groupBy(contrepartie, transactionsCache.currency)
    // Tri par montant décroissant (cast numeric pour ne pas trier en texte), puis libellé.
    .orderBy(sql`sum(${transactionsCache.amount}) desc`, contrepartie)
    .limit(topN);

  return { direction, lignes: lignes as LigneVendor[] };
}
