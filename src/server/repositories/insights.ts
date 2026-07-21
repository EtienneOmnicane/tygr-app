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
import {
  caseCategorieFr,
  estLibelleNonCategorise,
} from "@/server/insights/categorie-fr-sql";
import type { WorkspaceTx } from "@/server/db/tenancy";
// Bornes définies à la frontière (src/lib, source unique) — le repository les RÉUTILISE
// (dépendance server → lib autorisée). Cf. insights-schema.ts.
import { VENDORS_TOP_N_DEFAUT, VENDORS_TOP_N_MAX } from "@/lib/insights-schema";

import type {
  ConcentrationVendors,
  DirectionVendors,
  GranulariteCashflow,
  LigneVendor,
  PartCategorie,
  PointCashflow,
  RepartitionCategories,
  RepartitionDevise,
  SensFlux,
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
 * Fenêtre `[from, to]` OPTIONNELLE (bornes INCLUSIVES, dates comptables Maurice
 * "YYYY-MM-DD", mêmes conventions que `cashflowParDevise` : borne haute rendue
 * exclusive en SQL via `< to + 1 jour`, paramètres liés, re-validation calendaire
 * défensive). Les deux bornes vont ensemble (XOR interdit) ; sans fenêtre, on agrège
 * tout l'historique (comportement historique conservé pour les appelants existants).
 *
 * NB : le top N est appliqué APRÈS agrégation, sur l'ensemble multi-devise trié par
 * montant — c'est un classement des plus gros postes toutes devises confondues, pas un
 * top N par devise (cohérent avec « concentration des dépenses »). La `part` reste,
 * elle, relative à la devise de la ligne (jamais un ratio cross-devise) et au total de
 * la FENÊTRE (le dénominateur est lui aussi filtré par [from, to]).
 */
export async function vendorsParConcentration(
  tx: Tx,
  params: { direction: DirectionVendors; topN?: number; from?: string; to?: string },
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
  // Fenêtre optionnelle : les deux bornes ensemble ou aucune (XOR interdit), mêmes
  // règles calendaires que cashflowParDevise (défense en profondeur, pièges F1/F2).
  const { from, to } = params;
  if ((from === undefined) !== (to === undefined)) {
    throw new InsightsParamsInvalidesError(
      "from et to doivent être fournis ensemble",
    );
  }
  if (from !== undefined && to !== undefined) {
    if (!estDateCalendaireValide(from) || !estDateCalendaireValide(to)) {
      throw new InsightsParamsInvalidesError("bornes de dates invalides (YYYY-MM-DD)");
    }
    if (from > to) {
      throw new InsightsParamsInvalidesError("from doit être ≤ to");
    }
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
        // Fenêtre [from, to] inclusive : paramètres liés, borne haute exclusive en SQL
        // (< to + 1 jour), comme cashflowParDevise. Absente → tout l'historique.
        ...(from !== undefined && to !== undefined
          ? [
              gte(transactionsCache.transactionDate, from),
              lt(
                transactionsCache.transactionDate,
                sql`(${to}::date + interval '1 day')`,
              ),
            ]
          : []),
      ),
    )
    .groupBy(contrepartie, transactionsCache.currency)
    // Tri par montant décroissant (cast numeric pour ne pas trier en texte), puis libellé.
    .orderBy(sql`sum(${transactionsCache.amount}) desc`, contrepartie)
    .limit(topN);

  return { direction, lignes: lignes as LigneVendor[] };
}

/**
 * Répartition par catégorie (camembert), par devise, sur la fenêtre [from, to] (bornes
 * INCLUSIVES, dates comptables Maurice "YYYY-MM-DD"). `sens` fige le côté agrégé :
 * `inflow` (Credit) ou `outflow` (Debit, défaut métier « analyse des dépenses »). PAS de
 * `both` (≠ vendors) : un donut mélangeant crédits et débits n'a pas de sens (types.ts).
 *
 * Une entrée `RepartitionDevise` par devise (JAMAIS d'addition cross-devise, règle 8) :
 *   - `total` / `nbTransactions` / `montantMoyen` (total/nb, L2) de la devise viennent de
 *     windows `over (partition by currency)` — pas d'addition JS (le JS ne fait QUE
 *     regrouper des chaînes déjà SQL).
 *   - `parts[]` = une catégorie chacune ; `montant` = `sum(amount)` (magnitude positive,
 *     le signe est porté par `credit_debit`, filtré). `part` = montant / total de SA
 *     devise (0..1, `nullif` anti-DIV/0). `montantPrecedent` = somme de la MÊME catégorie
 *     sur la fenêtre précédente (L4, « 0.00 » si absente).
 *
 * Catégorie = `primary_category` Omni-FI **TRADUITE EN FRANÇAIS DANS LE GROUP BY**
 * (Lot 0, `caseCategorieFr`) : le donut n'affiche jamais d'anglais OBIE. La traduction
 * étant MANY-TO-ONE (`income` + `revenue` → « Revenus »), elle DOIT rester dans la clé de
 * groupe — sinon deux secteurs homonymes, refusionnables seulement par une addition JS
 * (interdite, règle 8). NULL/''/sentinelles Omni-FI (`UNCLASSIFIED`, `Uncategorized`) et
 * clés non cartographiées collapsent en un seul poste « Non catégorisé »
 * (`estNonCategorise=true`), TOUJOURS trié en dernier (rendu neutre).
 * Tri : devises par code croissant ; au sein d'une devise, catégorisées d'abord (montant
 * décroissant), « Non catégorisé » repoussé en fin.
 *
 * L4 (variation) : si `fromPrecedent`/`toPrecedent` sont fournis, une 2e requête SÉPARÉE
 * (jamais un FILTER sur la principale — la requête du donut reste inchangée) agrège la
 * fenêtre précédente ; le merge par clé (devise, catégorie) est une simple recopie de
 * chaîne SQL côté JS (aucune addition de montant, règle 8).
 *
 * Sécurité : `sens` pilote un `filter (where …)` à littéral FIGÉ (jamais l'entrée
 * interpolée) ; dates en paramètres liés + re-validées ici (défense en profondeur).
 * ENTITY-READ-JOIN1 : jointure `bank_accounts` obligatoire (héritage scope entité) — sur
 * les DEUX requêtes (courante + précédente).
 */
export async function repartitionParCategorie(
  tx: Tx,
  params: {
    sens: SensFlux;
    from: string;
    to: string;
    /** Fenêtre précédente (L4, optionnelle) — active le calcul de `montantPrecedent`. */
    fromPrecedent?: string;
    toPrecedent?: string;
  },
): Promise<RepartitionCategories> {
  const { sens, from, to, fromPrecedent, toPrecedent } = params;
  if (sens !== "inflow" && sens !== "outflow") {
    throw new InsightsParamsInvalidesError(`sens invalide : ${sens}`);
  }
  if (!estDateCalendaireValide(from) || !estDateCalendaireValide(to)) {
    throw new InsightsParamsInvalidesError("bornes de dates invalides (YYYY-MM-DD)");
  }
  if (from > to) {
    throw new InsightsParamsInvalidesError("from doit être ≤ to");
  }
  // Fenêtre précédente : les deux bornes ensemble ou aucune (XOR interdit) ; mêmes
  // règles calendaires que la fenêtre courante (défense en profondeur).
  if ((fromPrecedent === undefined) !== (toPrecedent === undefined)) {
    throw new InsightsParamsInvalidesError(
      "fromPrecedent et toPrecedent doivent être fournis ensemble",
    );
  }
  if (fromPrecedent !== undefined && toPrecedent !== undefined) {
    if (
      !estDateCalendaireValide(fromPrecedent) ||
      !estDateCalendaireValide(toPrecedent)
    ) {
      throw new InsightsParamsInvalidesError(
        "bornes précédentes invalides (YYYY-MM-DD)",
      );
    }
    if (fromPrecedent > toPrecedent) {
      throw new InsightsParamsInvalidesError(
        "fromPrecedent doit être ≤ toPrecedent",
      );
    }
  }

  // Filtre de sens : littéral FIGÉ (Credit pour inflow, Debit pour outflow) — jamais
  // l'entrée brute interpolée dans le SQL.
  const filtreSens =
    sens === "inflow"
      ? sql`${transactionsCache.creditDebit} = 'Credit'`
      : sql`${transactionsCache.creditDebit} = 'Debit'`;

  // Clé de regroupement ET label d'affichage : le LIBELLÉ FRANÇAIS (Lot 0, D-d du plan).
  //
  // Le donut groupait sur `primary_category` brute et affichait donc l'anglais OBIE
  // (« Utilities », « Housing ») — seul écran de l'app à le faire, alors que le
  // dictionnaire FR existe et sert partout ailleurs (`categorieFr`, cf. /transactions et
  // le dashboard). La traduction entre ICI, dans le GROUP BY, et NON au rendu :
  // `CORRESPONDANCE_FR` est MANY-TO-ONE (`income` + `revenue` → « Revenus »), donc
  // grouper sur la clé OBIE puis traduire à l'affichage produirait deux secteurs
  // homonymes, refusionnables seulement par une addition JS de montants (interdite,
  // règle 8). En groupant sur le libellé FR, la fusion se fait dans le `sum()`.
  //
  // Le CASE est GÉNÉRÉ depuis `CORRESPONDANCE_FR` (source unique, cf. `caseCategorieFr`).
  // Il ABSORBE l'ancien prédicat `estNonCat` : NULL, chaîne vide et sentinelles Omni-FI
  // (« UNCLASSIFIED »/« Uncategorized ») ne sont pas au dictionnaire → branche `else` →
  // « Non catégorisé ». Comportement identique à l'existant (retour Etienne 2026-07-08 :
  // aucune sentinelle anglaise ne doit fuir dans l'UI), sans second prédicat à maintenir.
  //
  // ⚠️ Écart ASSUMÉ avec l'invariant I8 du plan (qui prévoyait de conserver distincte une
  // clé OBIE hors catalogue) : le brief d'implémentation tranche pour le repli
  // « Non catégorisé », aligné sur `categorieFr` et sur le reste de l'app — sans quoi de
  // l'anglais non cartographié resterait à l'écran, précisément le défaut corrigé ici.
  // Conséquence à connaître (dette OBIE-CATALOG1, TODOS) : le catalogue est figé à la
  // main et l'amont émet librement — une catégorie amont NOUVELLE grossira le poste
  // « Non catégorisé » au lieu d'apparaître, silencieusement.
  //
  // ⚠️ POURQUOI UNE SOUS-REQUÊTE et pas le CASE inline (piège 42803, mesuré) : Drizzle
  // réémet une expression `sql` À CHAQUE emplacement où elle apparaît, en RENUMÉROTANT
  // ses paramètres liés. Le même CASE sortait donc `$1..$37` dans le SELECT et
  // `$79..$115` dans le GROUP BY — deux textes différents pour Postgres, qui refusait la
  // requête : « column primary_category must appear in the GROUP BY clause » (42803).
  // Ce n'est PAS l'usage de `sql.raw` qui déclenche le piège (l'hypothèse du plan), mais
  // la répétition d'une expression PARAMÉTRÉE entre SELECT / GROUP BY / ORDER BY.
  // La sous-requête calcule le libellé UNE fois ; l'agrégat externe ne manipule plus
  // qu'un identifiant de colonne (`t.label_fr`), donc plus rien à faire coïncider.
  //
  // La jointure `bank_accounts` (ENTITY-READ-JOIN1) reste À L'INTÉRIEUR : le périmètre
  // entité est hérité là où les lignes sont lues, et les policies RLS s'appliquent aux
  // tables de la sous-requête exactement comme avant — aucun nouveau chemin de lecture.
  const sousRequeteCourante = tx
    .select({
      labelFr: caseCategorieFr(transactionsCache.primaryCategory).as("label_fr"),
      currency: transactionsCache.currency,
      amount: transactionsCache.amount,
    })
    .from(transactionsCache)
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(transactionsCache.isRemoved, false),
        filtreSens,
        gte(transactionsCache.transactionDate, from),
        // Borne haute INCLUSIVE sur `to` : < to + 1 jour (calcul SQL).
        lt(transactionsCache.transactionDate, sql`(${to}::date + interval '1 day')`),
      ),
    )
    .as("t");

  // Drapeau/tri « Non catégorisé » : dérivé de la MÊME constante que la branche `else`
  // du CASE (cf. `estLibelleNonCategorise`), appliqué à la colonne déjà calculée.
  const estNonCategoriseSql = estLibelleNonCategorise(sousRequeteCourante.labelFr);

  // ── L4 : période précédente (2e requête SÉPARÉE, jamais un FILTER sur la requête
  // principale) ────────────────────────────────────────────────────────────────────
  // La requête courante (qui pilote tout le donut) reste INCHANGÉE : la « variation » ne
  // peut donc pas casser les montants du camembert. On agrège ici (devise, catégorie,
  // somme) sur la fenêtre précédente et on recopie la CHAÎNE SQL dans une Map — aucune
  // addition de montant côté JS (règle 8). Catégorie absente avant → « 0.00 » (défaut).
  let montantsPrecedents: Map<string, string> | null = null;
  if (fromPrecedent !== undefined && toPrecedent !== undefined) {
    // Même forme que la requête courante (sous-requête + agrégat externe) : le libellé FR
    // est produit par le MÊME `caseCategorieFr`, donc les clés de merge `devise|label`
    // coïncident exactement — condition de la variation L4.
    const sousRequetePrec = tx
      .select({
        labelFr: caseCategorieFr(transactionsCache.primaryCategory).as("label_fr"),
        currency: transactionsCache.currency,
        amount: transactionsCache.amount,
      })
      .from(transactionsCache)
      // ENTITY-READ-JOIN1 : même jointure que la requête courante (héritage scope entité).
      .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
      .where(
        and(
          eq(transactionsCache.isRemoved, false),
          filtreSens,
          gte(transactionsCache.transactionDate, fromPrecedent),
          lt(
            transactionsCache.transactionDate,
            sql`(${toPrecedent}::date + interval '1 day')`,
          ),
        ),
      )
      .as("tp");

    const lignesPrec = await tx
      .select({
        categorie: sousRequetePrec.labelFr,
        currency: sousRequetePrec.currency,
        montant: sql<string>`sum(${sousRequetePrec.amount})::numeric(15,2)::text`,
      })
      .from(sousRequetePrec)
      // Fusion many-to-one EN SQL : deux clés OBIE synonymes tombent dans le même `sum()`.
      .groupBy(sousRequetePrec.labelFr, sousRequetePrec.currency);
    montantsPrecedents = new Map(
      lignesPrec.map((r) => [`${r.currency}|${r.categorie}`, r.montant]),
    );
  }

  // Agrégat externe : ne manipule plus que les colonnes de la sous-requête (`t.label_fr`,
  // `t.currency`, `t.amount`). Le filtrage, la jointure de périmètre et la traduction ont
  // déjà eu lieu à l'intérieur — les windows et le GROUP BY sont inchangés par ailleurs.
  const lignes = await tx
    .select({
      // Label domaine : catégorie Omni-FI TRADUITE en FR, repli "Non catégorisé".
      categorie: sousRequeteCourante.labelFr,
      estNonCategorise: estNonCategoriseSql,
      currency: sousRequeteCourante.currency,
      montant: sql<string>`sum(${sousRequeteCourante.amount})::numeric(15,2)::text`,
      // part = montant catégorie / total devise ; nullif anti-DIV/0 (total nul → "0").
      part: sql<string>`coalesce(
        (sum(${sousRequeteCourante.amount})
          / nullif(sum(sum(${sousRequeteCourante.amount})) over (partition by ${sousRequeteCourante.currency}), 0)
        )::text, '0')`,
      nbTransactions: sql<number>`count(*)::int`,
      // Total & nb de LA devise via window — récupérés tels quels côté JS (aucune
      // addition JS de montants, règle 8). ::numeric(15,2) fige l'échelle (2 décimales).
      totalDevise: sql<string>`(sum(sum(${sousRequeteCourante.amount})) over (partition by ${sousRequeteCourante.currency}))::numeric(15,2)::text`,
      nbTransactionsDevise: sql<number>`(sum(count(*)) over (partition by ${sousRequeteCourante.currency}))::int`,
      // L2 — montant moyen par opération de LA devise : total / nb (EN SQL, règle 8).
      // nullif anti-DIV/0 (nb nul impossible ici mais défensif) ; coalesce fige "0.00".
      montantMoyenDevise: sql<string>`coalesce(
        (sum(sum(${sousRequeteCourante.amount})) over (partition by ${sousRequeteCourante.currency})
          / nullif(sum(count(*)) over (partition by ${sousRequeteCourante.currency}), 0)
        )::numeric(15,2), 0)::numeric(15,2)::text`,
    })
    .from(sousRequeteCourante)
    // Groupement sur le LIBELLÉ FR : deux clés OBIE synonymes (`income`/`revenue`)
    // fusionnent ici, dans le `sum()`, et ressortent en UN seul secteur.
    .groupBy(sousRequeteCourante.labelFr, sousRequeteCourante.currency)
    // Devise croissante (regroupement JS contigu), puis « Non catégorisé » en fin
    // (false trié avant true), puis montant décroissant, puis label (stable).
    .orderBy(
      sousRequeteCourante.currency,
      sql`${estNonCategoriseSql} asc`,
      sql`sum(${sousRequeteCourante.amount}) desc`,
      sousRequeteCourante.labelFr,
    );

  // Regroupement PAR DEVISE : les lignes sont déjà triées par currency (contiguës) — on
  // ne fait qu'assembler des chaînes SQL, jamais additionner un montant côté JS.
  const devises: RepartitionDevise[] = [];
  let courante: RepartitionDevise | undefined;
  for (const r of lignes) {
    if (!courante || courante.currency !== r.currency) {
      courante = {
        currency: r.currency,
        total: r.totalDevise,
        nbTransactions: r.nbTransactionsDevise,
        montantMoyen: r.montantMoyenDevise,
        parts: [],
      };
      devises.push(courante);
    }
    const part: PartCategorie = {
      categorie: r.categorie,
      estNonCategorise: r.estNonCategorise,
      montant: r.montant,
      part: r.part,
      nbTransactions: r.nbTransactions,
      // L4 — recopie de la CHAÎNE agrégée de la fenêtre précédente (merge par clé
      // devise|catégorie) ; « 0.00 » si la catégorie n'existait pas avant (ou pas de
      // fenêtre précédente demandée).
      montantPrecedent:
        montantsPrecedents?.get(`${r.currency}|${r.categorie}`) ?? "0.00",
    };
    courante.parts.push(part);
  }

  return {
    sens,
    from,
    to,
    fromPrecedent: fromPrecedent ?? "",
    toPrecedent: toPrecedent ?? "",
    devises,
  };
}
