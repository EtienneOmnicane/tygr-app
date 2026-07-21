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
import { and, eq, gt, gte, lt, sql } from "drizzle-orm";
import {
  alias as aliasTable,
  unionAll,
  type PgDatabase,
  type PgQueryResultHKT,
} from "drizzle-orm/pg-core";

import {
  bankAccounts,
  categories,
  transactionCategorizations,
  transactionsCache,
} from "@/server/db/schema";
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
  OrigineCategorie,
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
 * Niveau de la hiérarchie TYGR (`categories.parent_id`) porté par l'axe (décision D-e).
 * `feuille` = la catégorie telle que saisie sur le split ; `nature` = sa racine
 * (« Loyer » remonte sous « Charges d'exploitation »).
 *
 * ⚠️ Le paramètre existe DÈS MAINTENANT et n'est PAS exposé à l'UI (Q3 tranché : pas de
 * sélecteur en v1) — il est là pour que la matrice catégorie × mois consomme le MÊME
 * fragment sans le forker (D-a). Les deux valeurs sont testées : un paramètre non prouvé
 * serait du code mort qui casserait au premier usage réel.
 */
export type NiveauAxeCategorie = "feuille" | "nature";

/**
 * ═══ AXE « CATÉGORIE EFFECTIVE » — définition SQL UNIQUE et PARTAGÉE (décision D-a) ═══
 *
 * Renvoie une SOUS-REQUÊTE (aliasée `axe`) où **une ligne = une part de flux imputée à
 * une catégorie**, prête à être agrégée par n'importe quel appelant : le donut groupe
 * par (devise, catégorie), la future matrice groupera par (catégorie, mois). Il ne doit
 * JAMAIS exister deux définitions de « catégorie effective » — deux écrans se
 * contrediraient sur la même donnée, le pire défaut possible sur un outil de trésorerie.
 *
 * ── Pourquoi un UNION ALL à deux branches (décision D-b, Q5) ─────────────────────────
 * `transaction_categorizations` est une table de SPLITS AVEC MONTANTS et son invariant
 * est une INÉGALITÉ : `Σ splits ≤ |montant transaction|` (schema.ts:598-602). L'état
 * PARTIEL est donc LÉGAL (une sortie de 1 200 ventilée à 500 laisse 700 non imputés).
 * Sommer les seuls splits afficherait 500 pour une période où 1 200 sont réellement
 * sortis — un donut dont les parts ne somment pas au flux réel est un défaut de
 * CORRECTION, pas d'ergonomie (il divergerait du KPI « Sorties » du dashboard, sur le
 * même écran, sans aucun message). D'où :
 *
 *   branche 1 « splits » — chaque split par sa catégorie TYGR        → origine TYGR
 *   branche 2 « reste »  — `|montant| − Σ splits`, imputé EXPLICITEMENT à la catégorie
 *                          bancaire (`caseCategorieFr(primary_category)`)
 *                                                        → origine AMONT (ou AUCUNE)
 *
 * Le reliquat n'est JAMAIS abandonné, et JAMAIS versé d'office à « Non catégorisé » : il
 * garde l'étiquette de la banque (Q5). L'exhaustivité `Σ parts(devise) = Σ |montant|
 * (devise) = KPI Sorties(devise)` devient un invariant TESTÉ (I1), pas un espoir.
 *
 * ── Cascade binaire, pas ternaire (décision D-c) ─────────────────────────────────────
 * « manuel > règle > banque » décrit une priorité qui n'existe pas À LA LECTURE : le
 * modèle garantit à l'ÉCRITURE qu'une transaction ne porte jamais MANUAL et RULE
 * simultanément (le moteur de règles skippe sous verrou toute transaction déjà ventilée,
 * `regles-categorisation.ts:514-524` ; l'édition manuelle purge puis réinsère,
 * `categorisation.ts:379-414`). La cascade réelle est donc `splits > primary_category`
 * — un CASE à trois niveaux serait du code mort. La garantie restant CONVENTIONNELLE
 * (`ajouterSplit` accepte `source` en paramètre libre), le tri de départage
 * `(source='MANUAL') desc` est posé PAR PRUDENCE, sans que le résultat en dépende.
 *
 * ── Isolation (§6 du plan) — ne RIEN retirer ici ─────────────────────────────────────
 * La branche splits est DOUBLEMENT bornée, délibérément :
 *   1. sa propre policy RLS `account_scope` (migration 0017), un prédicat EXISTS vers
 *      `transactions_cache` qui hérite récursivement du scope entité ET du view_filter ;
 *   2. le `innerJoin(bankAccounts)` exigé par ENTITY-READ-JOIN1.
 * Ne PAS supprimer la jointure sous prétexte que la policy existe : elle porte aussi la
 * CORRECTION de l'agrégat (une transaction hors périmètre ne doit pas peser dans le
 * total), pas seulement l'isolation. `categories` n'a que `tenant_isolation`, sans risque
 * ici : la jointure est en cardinalité 1:1 garantie (`category_id` NOT NULL + FK
 * composite `(category_id, workspace_id)` sur une PK unique) — elle ne peut ni filtrer ni
 * dupliquer de lignes.
 *
 * ── Tombstones (invariant I5) ────────────────────────────────────────────────────────
 * Les splits ne sont PAS supprimés quand leur transaction est tombstonée (append-only,
 * aucune cascade) : un split SURVIT à son tombstone. `is_removed = false` est donc posé
 * sur les DEUX branches — un oubli sur une seule ferait RÉAPPARAÎTRE une transaction
 * effacée par sa ventilation, et serait invisible au lint, au typecheck et au build.
 *
 * @param params.sens   `inflow` (Credit) / `outflow` (Debit) — littéral figé, jamais interpolé.
 * @param params.from   borne basse INCLUSIVE (date comptable Maurice « YYYY-MM-DD »).
 * @param params.to     borne haute INCLUSIVE (rendue `< to + 1 jour` en SQL).
 * @param params.niveau cf. {@link NiveauAxeCategorie} — défaut `feuille`.
 * @param alias         alias SQL de la sous-requête (unique par requête).
 */
export function axeCategorieEffective(
  tx: Tx,
  params: {
    sens: SensFlux;
    from: string;
    to: string;
    niveau?: NiveauAxeCategorie;
  },
  alias = "axe",
) {
  const { sens, from, to } = params;
  const niveau: NiveauAxeCategorie = params.niveau ?? "feuille";

  // Filtre de sens : littéral FIGÉ (jamais l'entrée brute interpolée dans le SQL).
  const filtreSens =
    sens === "inflow"
      ? eq(transactionsCache.creditDebit, "Credit")
      : eq(transactionsCache.creditDebit, "Debit");

  // Bornes de la fenêtre, communes aux deux branches (paramètres LIÉS ; borne haute
  // inclusive rendue `< to + 1 jour` en SQL, convention de tout ce repository).
  const dansLaFenetre = [
    gte(transactionsCache.transactionDate, from),
    lt(transactionsCache.transactionDate, sql`(${to}::date + interval '1 day')`),
  ];

  // Parent de la catégorie du split (hiérarchie à 2 niveaux `categories.parent_id`).
  // LEFT JOIN systématique et SÛR : la FK est COMPOSITE `(parent_id, workspace_id) →
  // categories(id, workspace_id)` sur une PK unique — au plus une ligne, donc il ne peut
  // ni filtrer ni dupliquer, quel que soit le `niveau` demandé.
  const parent = aliasTable(categories, "cat_parent");

  // Au niveau `nature`, une catégorie RACINE (parent_id NULL) est sa propre nature —
  // d'où le coalesce, qui évite de perdre les splits posés directement sur une racine.
  const cleCategorie =
    niveau === "nature"
      ? sql`coalesce(${parent.id}, ${categories.id})`
      : sql`${categories.id}`;
  const libelleCategorie =
    niveau === "nature"
      ? sql`coalesce(${parent.name}, ${categories.name})`
      : sql`${categories.name}`;

  // ── Branche 1 : la part VENTILÉE (splits TYGR) ──────────────────────────────────
  const brancheSplits = tx
    .select({
      currency: sql<string>`${transactionsCache.currency}`.as("currency"),
      origine: sql<OrigineCategorie>`'TYGR'::text`.as("origine"),
      categorieId: sql<string | null>`${cleCategorie}`.as("categorie_id"),
      categorie: sql<string>`${libelleCategorie}`.as("categorie"),
      montant: sql<string>`${transactionCategorizations.amount}`.as("montant"),
      txnId: sql<string>`${transactionsCache.id}`.as("txn_id"),
      transactionDate: sql<string>`${transactionsCache.transactionDate}`.as(
        "transaction_date",
      ),
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 — ceinture, EN PLUS de la policy account_scope (cf. en-tête).
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    // Jointure sur la PK COMPOSITE de la table partitionnée : (id, transaction_date).
    .innerJoin(
      transactionCategorizations,
      and(
        eq(transactionCategorizations.transactionId, transactionsCache.id),
        eq(
          transactionCategorizations.transactionDate,
          transactionsCache.transactionDate,
        ),
      )!,
    )
    // FK composite scopée workspace : la catégorie appartient FORCÉMENT au même tenant.
    .innerJoin(
      categories,
      and(
        eq(categories.id, transactionCategorizations.categoryId),
        eq(categories.workspaceId, transactionCategorizations.workspaceId),
      )!,
    )
    .leftJoin(
      parent,
      and(
        eq(parent.id, categories.parentId),
        eq(parent.workspaceId, categories.workspaceId),
      )!,
    )
    .where(and(eq(transactionsCache.isRemoved, false), filtreSens, ...dansLaFenetre))
    // D-c : départage défensif MANUAL > RULE. Le résultat n'en dépend PAS (les deux
    // sources ne coexistent jamais sur une transaction) — c'est une ceinture à coût nul
    // contre un futur appelant d'`ajouterSplit` qui les mélangerait.
    .orderBy(sql`(${transactionCategorizations.source} = 'MANUAL') desc`);

  // ── Branche 2 : le RESTE non ventilé, imputé à la catégorie bancaire ────────────
  // Table dérivée BORNÉE PAR LA PÉRIODE : sans le `where`, on scannerait tous les splits
  // du workspace pour une fenêtre de 12 mois. Le bornage est SÛR (et non destructif) car
  // la FK composite impose `split.transaction_date = transaction.transaction_date` — un
  // split d'une transaction de la fenêtre est forcément dans la fenêtre.
  const ventile = tx
    .select({
      transactionId: transactionCategorizations.transactionId,
      transactionDate: transactionCategorizations.transactionDate,
      montantVentile: sql<string>`sum(${transactionCategorizations.amount})`.as(
        "montant_ventile",
      ),
    })
    .from(transactionCategorizations)
    .where(
      and(
        gte(transactionCategorizations.transactionDate, from),
        lt(
          transactionCategorizations.transactionDate,
          sql`(${to}::date + interval '1 day')`,
        ),
      ),
    )
    .groupBy(
      transactionCategorizations.transactionId,
      transactionCategorizations.transactionDate,
    )
    .as("ventile");

  // Sous-requête intermédiaire : matérialise le libellé FR **une seule fois**. Réémettre
  // `caseCategorieFr` (37 paramètres liés) à deux endroits du même SELECT le ferait
  // renuméroter par Drizzle — le piège 42803 mesuré au Lot 0. Ici le CASE est calculé
  // dans `r`, et la couche au-dessus ne manipule plus qu'un identifiant de colonne.
  const resteBrut = tx
    .select({
      currency: sql<string>`${transactionsCache.currency}`.as("currency"),
      labelFr: caseCategorieFr(transactionsCache.primaryCategory).as("label_fr"),
      // `|montant| − Σ splits` : le reliquat NON imputé de cette transaction. `abs` est
      // défensif (l'ingestion stocke des montants positifs, le sens vit sur
      // `credit_debit`) — il garantit que le reliquat reste une magnitude positive même
      // si un jour un montant signé entrait en base.
      montant:
        sql<string>`(abs(${transactionsCache.amount}) - coalesce(${ventile.montantVentile}, 0))`.as(
          "montant",
        ),
      txnId: sql<string>`${transactionsCache.id}`.as("txn_id"),
      transactionDate: sql<string>`${transactionsCache.transactionDate}`.as(
        "transaction_date",
      ),
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 — identique à la branche 1 (aucune des deux ne s'en dispense).
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .leftJoin(
      ventile,
      and(
        eq(ventile.transactionId, transactionsCache.id),
        eq(ventile.transactionDate, transactionsCache.transactionDate),
      )!,
    )
    .where(and(eq(transactionsCache.isRemoved, false), filtreSens, ...dansLaFenetre))
    .as("r");

  const brancheReste = tx
    .select({
      currency: sql<string>`${resteBrut.currency}`.as("currency"),
      // AUCUNE (poste « Non catégorisé ») ⟺ la banque n'étiquette pas cette transaction.
      // Le prédicat dérive de la MÊME constante que la branche `else` du CASE FR, pour
      // que le drapeau et le tri ne puissent pas diverger du libellé.
      origine: sql<OrigineCategorie>`(case when ${estLibelleNonCategorise(resteBrut.labelFr)} then 'AUCUNE' else 'AMONT' end)::text`.as(
        "origine",
      ),
      // Pas d'id TYGR pour une catégorie bancaire — le type doit rester uuid pour que
      // l'UNION ALL apparie la colonne de la branche 1.
      categorieId: sql<string | null>`null::uuid`.as("categorie_id"),
      categorie: sql<string>`${resteBrut.labelFr}`.as("categorie"),
      montant: sql<string>`${resteBrut.montant}`.as("montant"),
      txnId: sql<string>`${resteBrut.txnId}`.as("txn_id"),
      transactionDate: sql<string>`${resteBrut.transactionDate}`.as("transaction_date"),
    })
    .from(resteBrut)
    // Invariant I6 : `> 0` STRICT. Une transaction intégralement ventilée (COMPLET) ne
    // produit AUCUNE ligne de reste — sinon le donut porterait des parts fantômes à 0,00.
    .where(gt(resteBrut.montant, sql`0`));

  // ⚠️ L'ORDRE des colonnes doit être IDENTIQUE dans les deux branches : un UNION ALL
  // apparie PAR POSITION, pas par nom. Inverser `origine` et `categorie` (deux `text`)
  // produirait un SQL parfaitement valide et des résultats FAUX — d'où le test qui
  // asserte l'origine de chaque branche séparément.
  return unionAll(brancheSplits, brancheReste).as(alias);
}

/**
 * Répartition par catégorie (camembert), par devise, sur la fenêtre [from, to] (bornes
 * INCLUSIVES, dates comptables Maurice "YYYY-MM-DD"). `sens` fige le côté agrégé :
 * `inflow` (Credit) ou `outflow` (Debit, défaut métier « analyse des dépenses »). PAS de
 * `both` (≠ vendors) : un donut mélangeant crédits et débits n'a pas de sens (types.ts).
 *
 * L'axe de groupement est la **catégorie EFFECTIVE** ({@link axeCategorieEffective},
 * décisions D-a/D-b/D-c) : la ventilation de l'utilisateur (splits TYGR — règles ET
 * saisie manuelle) prime sur l'étiquette de la banque, et le reliquat NON ventilé d'une
 * transaction PARTIELLE reste imputé à la catégorie bancaire. Le donut montre donc enfin
 * les catégories que l'utilisateur a créées, SANS jamais perdre un franc de flux :
 * `Σ parts(devise) = Σ |montant|(devise) = KPI « Sorties »(devise)` (invariant I1).
 *
 * Une entrée `RepartitionDevise` par devise (JAMAIS d'addition cross-devise, règle 8) :
 *   - `total` de la devise vient d'une window `over (partition by currency)` ;
 *     `nbTransactions`/`montantMoyen` d'une 2e requête (cf. plus bas, `count(distinct)`).
 *     Aucune addition JS (le JS ne fait QUE regrouper des chaînes déjà SQL).
 *   - `parts[]` = une (origine, catégorie) chacune ; `montant` = `sum(montant)` de l'axe
 *     (magnitude positive). `part` = montant / total de SA devise (0..1, `nullif`
 *     anti-DIV/0). `montantPrecedent` = somme de la MÊME clé sur la fenêtre précédente
 *     (L4, « 0.00 » si absente).
 *
 * Les libellés bancaires sont TRADUITS EN FRANÇAIS DANS LA CLÉ DE GROUPE (Lot 0,
 * `caseCategorieFr`, appliqué dans l'axe) : le donut n'affiche jamais d'anglais OBIE. La
 * traduction étant MANY-TO-ONE (`income` + `revenue` → « Revenus »), elle DOIT rester
 * dans la clé — sinon deux secteurs homonymes, refusionnables seulement par une addition
 * JS (interdite, règle 8). NULL/''/sentinelles Omni-FI et clés hors catalogue collapsent
 * en un poste « Non catégorisé » (`origine="AUCUNE"`, `estNonCategorise=true`).
 *
 * ⚠️ La clé de groupe est `(devise, origine, categorieId, libellé)`, JAMAIS le libellé
 * seul : une catégorie TYGR « Loyer » et une catégorie bancaire « Loyer » sont deux
 * espaces de noms distincts et doivent rester deux parts. `categorieId` y entre en plus
 * du libellé pour départager deux catégories TYGR homonymes de branches différentes.
 *
 * Tri : devises par code croissant ; au sein d'une devise, catégorisées d'abord (montant
 * décroissant), « Non catégorisé » repoussé en fin.
 *
 * L4 (variation) : si `fromPrecedent`/`toPrecedent` sont fournis, une requête SÉPARÉE
 * (jamais un FILTER sur la principale — la requête du donut reste inchangée) agrège la
 * fenêtre précédente SUR LE MÊME AXE ; le merge par clé est une simple recopie de chaîne
 * SQL côté JS (aucune addition de montant, règle 8). L'axe identique est la CONDITION de
 * la variation : deux clés de groupe différentes feraient retomber tout `montantPrecedent`
 * à « 0.00 » (faux « nouveau » sur chaque part).
 *
 * Sécurité : `sens` pilote des littéraux FIGÉS (jamais l'entrée interpolée) ; dates en
 * paramètres liés + re-validées ici (défense en profondeur). ENTITY-READ-JOIN1 : jointure
 * `bank_accounts` obligatoire sur CHAQUE branche de CHAQUE requête (héritage scope
 * entité) — portée par l'axe partagé.
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

  // Q3 tranché : le niveau hiérarchique est FIGÉ à la feuille et n'est PAS exposé à
  // l'UI en v1 (« Loyer » ne doit pas être écrasé sous « Charges d'exploitation » —
  // c'est précisément la granularité que l'utilisateur cherche à voir). Le paramètre
  // existe sur l'axe pour la matrice catégorie × mois, pas pour ce donut.
  const niveau: NiveauAxeCategorie = "feuille";

  // Clé de merge L4 / d'identité d'une part : (devise, origine, catégorie). On préfère
  // `categorieId` au libellé quand il existe — deux catégories TYGR homonymes de
  // branches différentes restent alors distinctes, exactement comme dans le GROUP BY.
  const cleMerge = (r: {
    currency: string;
    origine: OrigineCategorie;
    categorieId: string | null;
    categorie: string;
  }) => `${r.currency}|${r.origine}|${r.categorieId ?? r.categorie}`;

  // ── Axe partagé : la catégorie EFFECTIVE (splits TYGR > catégorie bancaire) ──────
  // Toute la logique de cascade, de reste non ventilé, de traduction FR et d'isolation
  // vit dans `axeCategorieEffective` — ce donut n'est plus qu'un AGRÉGAT par-dessus.
  // Une instance d'axe par requête (alias SQL distincts) : les trois requêtes ci-dessous
  // sont indépendantes, mais partagent EXACTEMENT la même définition d'axe.
  const axe = axeCategorieEffective(tx, { sens, from, to, niveau }, "axe");

  // ── L4 : période précédente (requête SÉPARÉE, jamais un FILTER sur la principale) ──
  // La requête courante (qui pilote tout le donut) reste INCHANGÉE : la « variation » ne
  // peut donc pas casser les montants du camembert. On agrège ici (devise, origine,
  // catégorie, somme) sur la fenêtre précédente et on recopie la CHAÎNE SQL dans une Map
  // — aucune addition de montant côté JS (règle 8). Clé absente avant → « 0.00 ».
  let montantsPrecedents: Map<string, string> | null = null;
  if (fromPrecedent !== undefined && toPrecedent !== undefined) {
    // MÊME axe, MÊME niveau : c'est la condition de la variation. Un axe qui divergerait
    // (ne serait-ce que par le niveau hiérarchique) ferait retomber tous les
    // `montantPrecedent` à « 0.00 », affichant un faux « nouveau » sur chaque part.
    const axePrec = axeCategorieEffective(
      tx,
      { sens, from: fromPrecedent, to: toPrecedent, niveau },
      "axe_prec",
    );

    const lignesPrec = await tx
      .select({
        currency: axePrec.currency,
        origine: axePrec.origine,
        categorieId: axePrec.categorieId,
        categorie: axePrec.categorie,
        montant: sql<string>`sum(${axePrec.montant})::numeric(15,2)::text`,
      })
      .from(axePrec)
      .groupBy(
        axePrec.currency,
        axePrec.origine,
        axePrec.categorieId,
        axePrec.categorie,
      );
    montantsPrecedents = new Map(
      lignesPrec.map((r) => [cleMerge(r), r.montant]),
    );
  }

  // ── Les parts du donut : un agrégat par (devise, origine, catégorie) ──────────────
  const lignes = await tx
    .select({
      categorie: axe.categorie,
      origine: axe.origine,
      categorieId: axe.categorieId,
      currency: axe.currency,
      montant: sql<string>`sum(${axe.montant})::numeric(15,2)::text`,
      // part = montant de la part / total devise ; nullif anti-DIV/0 (total nul → "0").
      part: sql<string>`coalesce(
        (sum(${axe.montant})
          / nullif(sum(sum(${axe.montant})) over (partition by ${axe.currency}), 0)
        )::text, '0')`,
      // D-f : transactions DISTINCTES, pas les lignes agrégées. Une transaction ventilée
      // sur 3 catégories compte 1 dans chacune, jamais 3 — sinon le nombre d'opérations
      // enflerait avec le niveau de détail de la ventilation.
      nbTransactions: sql<number>`count(distinct ${axe.txnId})::int`,
      // Total de LA devise via window — récupéré tel quel côté JS (aucune addition JS de
      // montants, règle 8). ::numeric(15,2) fige l'échelle (2 décimales).
      totalDevise: sql<string>`(sum(sum(${axe.montant})) over (partition by ${axe.currency}))::numeric(15,2)::text`,
    })
    .from(axe)
    // Clé de groupe COMPLÈTE (cf. `cleMerge`) : l'origine en fait partie — une catégorie
    // TYGR « Loyer » et une catégorie bancaire « Loyer » restent DEUX parts distinctes.
    .groupBy(axe.currency, axe.origine, axe.categorieId, axe.categorie)
    // Devise croissante (regroupement JS contigu), puis « Non catégorisé » en fin
    // (false trié avant true), puis montant décroissant, puis label (stable).
    .orderBy(
      axe.currency,
      sql`(${axe.origine} = 'AUCUNE') asc`,
      sql`sum(${axe.montant}) desc`,
      axe.categorie,
    );

  // ── Cardinalité et moyenne PAR DEVISE (requête séparée — et pourquoi) ─────────────
  // `count(distinct …)` est INTERDIT en fonction fenêtre par Postgres, et le raccourci
  // `sum(count(distinct …)) over (partition by …)` serait FAUX : une transaction PARTIELLE
  // apparaît dans deux groupes (sa ventilation TYGR + son reliquat bancaire) et serait
  // comptée deux fois, gonflant `nbTransactions` et écrasant `montantMoyen`. On agrège
  // donc la devise à part, où le `distinct` porte sur l'ENSEMBLE de ses lignes.
  const axeTotaux = axeCategorieEffective(tx, { sens, from, to, niveau }, "axe_tot");
  const totaux = await tx
    .select({
      currency: axeTotaux.currency,
      nbTransactions: sql<number>`count(distinct ${axeTotaux.txnId})::int`,
      // L2 — montant moyen par opération de LA devise : flux / nb transactions distinctes
      // (EN SQL, règle 8). nullif anti-DIV/0 ; coalesce fige l'échelle à « 0.00 ».
      montantMoyen: sql<string>`coalesce(
        (sum(${axeTotaux.montant})
          / nullif(count(distinct ${axeTotaux.txnId}), 0)
        )::numeric(15,2), 0)::numeric(15,2)::text`,
    })
    .from(axeTotaux)
    .groupBy(axeTotaux.currency);
  const totauxParDevise = new Map(totaux.map((t) => [t.currency, t]));

  // Regroupement PAR DEVISE : les lignes sont déjà triées par currency (contiguës) — on
  // ne fait qu'assembler des chaînes SQL, jamais additionner un montant côté JS.
  const devises: RepartitionDevise[] = [];
  let courante: RepartitionDevise | undefined;
  for (const r of lignes) {
    if (!courante || courante.currency !== r.currency) {
      const total = totauxParDevise.get(r.currency);
      courante = {
        currency: r.currency,
        total: r.totalDevise,
        // Défensif : les deux requêtes portent le MÊME filtre, donc la devise est
        // toujours présente des deux côtés — on ne fabrique pas de donnée si elle manque.
        nbTransactions: total?.nbTransactions ?? 0,
        montantMoyen: total?.montantMoyen ?? "0.00",
        parts: [],
      };
      devises.push(courante);
    }
    const part: PartCategorie = {
      categorie: r.categorie,
      // Le drapeau et le tri dérivent de la MÊME source (`origine`) : ils ne peuvent
      // pas diverger. AUCUNE ⟺ la banque n'étiquette pas, et rien n'a été ventilé.
      estNonCategorise: r.origine === "AUCUNE",
      montant: r.montant,
      part: r.part,
      nbTransactions: r.nbTransactions,
      origine: r.origine,
      categorieId: r.categorieId,
      // L4 — recopie de la CHAÎNE agrégée de la fenêtre précédente (merge par la MÊME
      // clé que le GROUP BY) ; « 0.00 » si la clé n'existait pas avant (ou pas de
      // fenêtre précédente demandée).
      montantPrecedent: montantsPrecedents?.get(cleMerge(r)) ?? "0.00",
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
