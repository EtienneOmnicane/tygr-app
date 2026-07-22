/**
 * Repository de LECTURE paginée des transactions (B1-B3, page /transactions).
 * Toutes les fonctions s'exécutent DANS withWorkspace(session, fn) : `tx` porte
 * app.current_workspace_id → chaque SELECT est filtré par la policy RLS
 * tenant_isolation. L'isolation inter-workspace est garantie par la base, pas par
 * un WHERE applicatif (CLAUDE.md règle 2). `workspace_id` n'est jamais un
 * paramètre client.
 *
 * transactions_cache reste READ-ONLY (règle 8) : on la LIT uniquement.
 *
 * DEUX exigences de conception :
 *
 * 1. PAGINATION PAR CURSEUR (keyset), JAMAIS OFFSET. Le tri total est
 *    `(transaction_date DESC, id DESC)` — `transaction_date` seul n'est PAS unique
 *    (plusieurs txns le même jour), donc on départage par `id` pour un ordre
 *    DÉTERMINISTE et un curseur STABLE même en cas d'insertion concurrente. Ce
 *    tuple s'aligne sur la PK partition (id, transaction_date) et sur l'index
 *    couvrant transactions_cache_workspace_date_idx (workspace_id, date DESC) →
 *    reprise en O(log n), pas de re-scan O(N) comme OFFSET.
 *
 * 2. RÉSUMÉ DE VENTILATION ANTI-N+1. L'état de catégorisation de CHAQUE ligne est
 *    agrégé en une SEULE requête via LEFT JOIN LATERAL sur
 *    transaction_categorizations (nb_splits, montant_ventile). Le Front-End sait
 *    d'un coup d'œil si la ligne est non-catégorisée / partielle / complète SANS
 *    déclencher une requête par transaction. Le statut est calculé EN SQL
 *    (comparaison numeric, jamais de float côté TS, règle 8).
 *
 * Montants en CHAÎNES décimales — la couche UI les formate sans recalcul.
 * Les tombstones (is_removed=true) sont exclus de toute lecture.
 */
import { and, eq, gte, ilike, lte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  bankAccounts,
  bankConnections,
  transactionsCache,
} from "@/server/db/schema";
import type { CategorySource } from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";
import {
  estDateComptableValide,
  type ListerTransactionsInput,
  type SommeNetteInput,
  type StatutVentilation,
} from "@/lib/transactions-schema";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Une ligne de transaction enrichie de son résumé de ventilation. Montants =
 * chaînes décimales (règle 8). `cleanLabel` peut être null (bank_label_raw, PII,
 * jamais exposé). `statut` est dérivé de l'agrégat (cf. requête).
 */
export interface TransactionLigne {
  id: string;
  transactionDate: string;
  bankAccountId: string;
  /** Nom OBIE du compte porteur (ex. « Main Operating Account »), via bank_accounts. */
  accountName: string;
  /** Nom lisible de la banque (ex. « Bank One », « SBM »), via bank_connections ;
   *  null si l'institution n'a pas encore été renseignée (DASH-INST1, expand-safe). */
  institutionName: string | null;
  amount: string;
  currency: string;
  creditDebit: "Credit" | "Debit";
  cleanLabel: string | null;
  /**
   * Libellé brut bancaire (OBIE TransactionInformation), null si absent. Sert de
   * REPLI d'affichage quand `cleanLabel` (marchand enrichi) est vide — décision
   * produit assumée 2026-06-23 : on préfère montrer le narratif brut (« DBIT / POS
   * / … ») plutôt qu'un « Opération bancaire » générique. Narratif de relevé, pas
   * de PII nominative ; la recherche (ILIKE) porte sur la même cascade que
   * l'affichage — marchand nettoyé SINON brut (cf. `conditionsFiltres`).
   */
  bankLabelRaw: string | null;
  primaryCategory: string | null;
  subCategory: string | null;
  /** Provenance auto de la catégorie OBIE (true = pré-catégorisée par Omni-FI). */
  isAutoCategorized: boolean;
  /** Source de la catégorie auto (NULL si non auto). */
  categorySource: CategorySource | null;
  /**
   * Fiabilité AMONT de la classification Omni-FI (TECH-API-TRACE, bloc Enrichment).
   * Libellé ordinal BRUT tel que persisté (`High`/`Medium`/`Low`, ou autre valeur
   * future — la colonne est sans CHECK, résilience API). NULL si non remontée (ligne
   * antérieure à la migration 0012, ou payload muet). ⚠️ `"Low"` est le DÉFAUT du
   * serializer amont : il ne signifie pas « douteux » en soi — la décision d'affichage
   * (badge « À vérifier ») croise ce niveau avec la présence d'une catégorie, côté UI.
   * La NORMALISATION en union typée se fait dans l'adaptateur (frontière UI), pas ici :
   * le repository reste fidèle à la source.
   */
  confidenceLevel: string | null;
  /**
   * Sous-source amont de la classification (`USER_RULE`/`SYSTEM_RULE`/`ML_FALLBACK`,
   * doc API « Priorité de classification »). BRUT, NULL si non remontée. À DISTINGUER
   * de `categorySource` ('OMNIFI', système TYGR) : granularité différente. ⚠️
   * `USER_RULE` = règle définie DANS Omni-FI, JAMAIS la ventilation manuelle TYGR.
   */
  classificationSource: string | null;
  /** Nombre de splits de catégorisation rattachés. */
  nbSplits: number;
  /** Somme des montants de splits (chaîne numeric ; "0" si aucun). */
  montantVentile: string;
  /** Dérivé en SQL : 0 split → NON_CATEGORISE ; somme = |montant| → COMPLET ;
   *  0 < somme < |montant| → PARTIEL. */
  statut: StatutVentilation;
  /**
   * Catégorie DOMINANTE de la ventilation (FB0709-TX-CATEGORIE-VISIBLE1) : la part
   * au plus GROS montant (départage déterministe par nom puis id à montant égal).
   * Mono-split → LA catégorie. `null` si aucun split. Sert au badge NOMMÉ de la
   * liste /transactions (« Loyer », « Fournisseurs +1 ») au lieu du compteur
   * générique « N catégories ». Résolue dans la MÊME requête (anti-N+1).
   */
  categorieDominanteId: string | null;
  categorieDominanteNom: string | null;
}

/** Page de résultats. Curseur opaque pour la page suivante (null = fin). */
export interface PageTransactions {
  lignes: TransactionLigne[];
  curseurSuivant: string | null;
  hasMore: boolean;
}

/**
 * Total des résultats FILTRÉS, pour UNE devise (TX-RECHERCHE-SOMME-NETTE1).
 *
 * Multi-devises (règle 8) : une entrée PAR devise, JAMAIS d'addition cross-devise et
 * aucune conversion FX (chantier DASH-FX1). Montants = chaînes décimales à 2
 * décimales (l'échelle est figée en SQL — cf. `sommeNetteParDevise`).
 *
 * ⚠️ CONVENTION DE SIGNE (identique à `cashflowParDevise`/`synthesePeriodeParDevise` —
 * une seule convention dans toute l'app) :
 *  - `entrees` et `sorties` sont des MAGNITUDES POSITIVES (des montants, pas des
 *    flux signés) ;
 *  - `net` = `entrees − sorties`, SIGNÉ (négatif si le filtre sort plus qu'il n'entre).
 * Le SENS d'une transaction vient de `credit_debit` (colonne sous CHECK), JAMAIS du
 * signe de `amount` : l'ingestion (`normaliserMontant`) persiste une valeur ABSOLUE.
 */
export interface SommeNetteDevise {
  currency: string;
  /** Somme des Credit, magnitude ≥ 0 (chaîne décimale). */
  entrees: string;
  /** Somme des Debit, magnitude ≥ 0 (chaîne décimale). */
  sorties: string;
  /** `entrees − sorties`, SIGNÉ (chaîne décimale) — calculé en SQL, jamais en TS. */
  net: string;
  /** Nombre de transactions agrégées dans cette devise. */
  nbTransactions: number;
}

/** Curseur mal formé / falsifié (forme valide mais contenu indécodable). */
export class CurseurInvalideError extends Error {
  readonly code = "INVALID_CURSOR";
  constructor() {
    super("Curseur de pagination invalide.");
    this.name = "CurseurInvalideError";
  }
}

/* ------------------------------------------------------------------ */
/* Curseur opaque : (transaction_date, id) ⇄ base64url("date|id")      */
/* ------------------------------------------------------------------ */

interface CleCurseur {
  transactionDate: string; // YYYY-MM-DD
  id: string; // uuid
}

const RE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encoderCurseur(cle: CleCurseur): string {
  return Buffer.from(`${cle.transactionDate}|${cle.id}`, "utf8").toString(
    "base64url",
  );
}

/**
 * Décode un curseur opaque. Défensif : toute forme inattendue (base64 cassé,
 * séparateur manquant, uuid non conforme, ou date calendairement IMPOSSIBLE comme
 * 2026-13-99) lève CurseurInvalideError plutôt que de risquer un prédicat SQL
 * malformé. On valide la date par `estDateComptableValide` (validité réelle, pas
 * juste la forme) — sinon `'2026-13-99'::date` casserait Postgres en
 * DrizzleQueryError brut (correctif cross-review F1). Le curseur ne porte JAMAIS le
 * workspace (qui vient de ctx) — un curseur forgé ne peut pas franchir un tenant.
 */
function decoderCurseur(opaque: string): CleCurseur {
  let brut: string;
  try {
    brut = Buffer.from(opaque, "base64url").toString("utf8");
  } catch {
    throw new CurseurInvalideError();
  }
  const sep = brut.indexOf("|");
  if (sep === -1) throw new CurseurInvalideError();
  const transactionDate = brut.slice(0, sep);
  const id = brut.slice(sep + 1);
  if (!estDateComptableValide(transactionDate) || !RE_UUID.test(id)) {
    throw new CurseurInvalideError();
  }
  return { transactionDate, id };
}

/* ------------------------------------------------------------------ */
/* Lecture paginée                                                     */
/* ------------------------------------------------------------------ */

/**
 * Liste paginée (keyset) des transactions du workspace courant, avec résumé de
 * ventilation par ligne (anti-N+1). Renvoie au plus `params.limite` lignes + un
 * curseur opaque pour la page suivante.
 *
 * On demande `limite + 1` lignes : si la base en renvoie une de plus, c'est qu'il
 * existe une page suivante (hasMore=true). On tronque alors la dernière et le
 * curseur suivant pointe sur la dernière ligne CONSERVÉE — pas besoin d'un
 * COUNT(*) coûteux.
 */
export async function listerTransactions<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  _ctx: WorkspaceContext,
  params: ListerTransactionsInput,
): Promise<PageTransactions> {
  const { statut, curseur, limite } = params;

  // Prédicats de filtre MÉTIER — helper PARTAGÉ avec `sommeNetteParDevise` : le total
  // affiché DOIT porter exactement les mêmes lignes que la liste affichée. La RLS
  // scope déjà au workspace ; ces conditions ne touchent jamais workspace_id (qui
  // n'est pas un paramètre client).
  const conditions = conditionsFiltres(params);

  // Reprise keyset : strictement APRÈS la dernière ligne de la page précédente,
  // dans l'ordre (date DESC, id DESC). Comparateur de TUPLE en SQL.
  //
  // Plan (vérifié EXPLAIN) : l'index couvrant (workspace_id, transaction_date DESC)
  // borne via `transaction_date <= curseur.date` (Index Cond) ; le départage fin
  // par `id` à date égale reste un Filter résiduel (id n'est pas dans la tête de
  // l'index). C'est le comportement standard d'un keyset sur colonne de tête
  // non-unique : O(log n) vs OFFSET en O(N), et le tuple garantit zéro doublon /
  // zéro trou (prouvé en isolation). Une réécriture (date < d) OR (date = d AND
  // id < i) ne changerait pas le plan sur cet index.
  if (curseur) {
    const cle = decoderCurseur(curseur);
    conditions.push(
      sql`(${transactionsCache.transactionDate}, ${transactionsCache.id}) < (${cle.transactionDate}::date, ${cle.id}::uuid)`,
    );
  }

  // Filtre de statut : prédicats CORRÉLÉS sur transaction_categorizations (cf.
  // `predicatStatut`). Il porte sur le jeu AVANT pagination — un statut ne peut donc
  // pas se borner à la page, contrairement à l'agrégat de projection ci-dessous.
  if (statut) {
    conditions.push(predicatStatut(statut));
  }

  // ┌─ ÉTAGE 1 — la PAGE ────────────────────────────────────────────────────────┐
  // Résout d'abord QUELLES lignes composent la page (≤ limite+1), sans toucher à la
  // ventilation. Le `LIMIT` de cette sous-requête est aussi une BARRIÈRE
  // d'optimisation : PostgreSQL n'aplatit jamais une sous-requête portant un LIMIT,
  // donc l'étage 2 ne peut pas être ré-inliné et ré-exploser (cf. PLAN §3.1).
  const sousRequetePage = tx
    .select({
      id: transactionsCache.id,
      transactionDate: transactionsCache.transactionDate,
      bankAccountId: transactionsCache.bankAccountId,
      // Provenance bancaire par transaction (challenge mapping 2026-06-22) : nom du
      // compte (bank_accounts) + nom de l'institution (bank_connections). Exposés ICI
      // pour que l'UI affiche « Bank One » sans reconstruire une map fragile côté Front.
      accountName: bankAccounts.accountName,
      institutionName: bankConnections.institutionName,
      amount: transactionsCache.amount,
      currency: transactionsCache.currency,
      creditDebit: transactionsCache.creditDebit,
      cleanLabel: transactionsCache.cleanLabel,
      bankLabelRaw: transactionsCache.bankLabelRaw,
      primaryCategory: transactionsCache.primaryCategory,
      subCategory: transactionsCache.subCategory,
      isAutoCategorized: transactionsCache.isAutoCategorized,
      categorySource: transactionsCache.categorySource,
      // Métadonnées de fiabilité AMONT (TECH-API-TRACE) — brutes ; la normalisation
      // en union + la règle d'affichage vivent côté UI. `rule_id_match` NON projeté :
      // identifiant opaque sans usage d'affichage (décision plan §3, dette P2 si besoin).
      confidenceLevel: transactionsCache.confidenceLevel,
      classificationSource: transactionsCache.classificationSource,
    })
    .from(transactionsCache)
    // Jointures de provenance. innerJoin SÛR : transactions_cache.bank_account_id est
    // NOT NULL et bank_accounts.connection_id est NOT NULL → 1 transaction = 1 compte =
    // 1 connexion (cardinalité inchangée, aucune ligne perdue). BONUS sécurité
    // (ENTITY-READ-JOIN1) : joindre bank_accounts fait HÉRITER la policy RLS
    // entity_scope (étage 2) → en Vision Entité, les transactions des comptes hors
    // périmètre sont masquées ; en Vision Globale (GUC vide), liste inchangée.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .innerJoin(
      bankConnections,
      eq(bankAccounts.connectionId, bankConnections.id),
    )
    .where(and(...conditions))
    // Tri total déterministe (cf. en-tête).
    .orderBy(
      sql`${transactionsCache.transactionDate} desc`,
      sql`${transactionsCache.id} desc`,
    )
    // +1 pour détecter la page suivante sans COUNT.
    .limit(limite + 1)
    .as("page");

  // Agrégat « aplati » : COALESCE pour les transactions sans aucun split (le LATERAL
  // ne rend alors aucune ligne → NULL → 0). `statutExpr` et `predicatStatut` restent
  // deux vues du MÊME agrégat (cf. `predicatStatut`).
  const nbSplitsExpr = sql<number>`coalesce(agg.nb_splits, 0)`;
  const montantVentileExpr = sql<string>`coalesce(agg.montant_ventile, 0)::text`;
  const statutExpr = sql<StatutVentilation>`
    case
      when coalesce(agg.nb_splits, 0) = 0 then 'NON_CATEGORISE'
      when coalesce(agg.montant_ventile, 0) >= abs(${sousRequetePage.amount}) then 'COMPLET'
      else 'PARTIEL'
    end
  `;

  // ┌─ ÉTAGE 2 — l'agrégat BORNÉ à la page ──────────────────────────────────────┐
  // Le LATERAL est corrélé à CHAQUE ligne de `page` : il s'exécute au plus
  // limite+1 fois, par index (txn_categorizations_workspace_txn_idx), au lieu d'être
  // rescanné par ligne de TOUT le jeu. C'est le correctif PERF-VENTILATION-AGG1 :
  // 1970 ms → 8 ms sur 9 440 transactions / 480 splits (plans dans la PR).
  const lignes = await tx
    .select({
      id: sousRequetePage.id,
      transactionDate: sousRequetePage.transactionDate,
      bankAccountId: sousRequetePage.bankAccountId,
      accountName: sousRequetePage.accountName,
      institutionName: sousRequetePage.institutionName,
      amount: sousRequetePage.amount,
      currency: sousRequetePage.currency,
      creditDebit: sousRequetePage.creditDebit,
      cleanLabel: sousRequetePage.cleanLabel,
      bankLabelRaw: sousRequetePage.bankLabelRaw,
      primaryCategory: sousRequetePage.primaryCategory,
      subCategory: sousRequetePage.subCategory,
      isAutoCategorized: sousRequetePage.isAutoCategorized,
      categorySource: sousRequetePage.categorySource,
      confidenceLevel: sousRequetePage.confidenceLevel,
      classificationSource: sousRequetePage.classificationSource,
      nbSplits: nbSplitsExpr,
      montantVentile: montantVentileExpr,
      statut: statutExpr,
      // Colonnes NOMMÉES du LATERAL (jamais de sous-requête scalaire PROJETÉE ici :
      // en rowMode "array", Drizzle mappe par POSITION et une scalaire de tête
      // désaligne le mapping — symptôme observé en test). NULL si aucun split.
      categorieDominanteId: sql<string | null>`agg.cat_dominante_id`,
      categorieDominanteNom: sql<string | null>`agg.cat_dominante_nom`,
    })
    .from(sousRequetePage)
    .leftJoinLateral(aggregatVentilationLateral(sousRequetePage), sql`true`)
    // Une sous-requête ne garantit PAS de propager son ordre : on le re-pose ici.
    .orderBy(sql`${sousRequetePage.transactionDate} desc`, sql`${sousRequetePage.id} desc`);

  const hasMore = lignes.length > limite;
  const page = hasMore ? lignes.slice(0, limite) : lignes;
  const derniere = page[page.length - 1];
  const curseurSuivant =
    hasMore && derniere
      ? encoderCurseur({
          transactionDate: derniere.transactionDate,
          id: derniere.id,
        })
      : null;

  return {
    lignes: page as TransactionLigne[],
    curseurSuivant,
    hasMore,
  };
}

/* ------------------------------------------------------------------ */
/* Agrégat — somme nette des résultats FILTRÉS, par devise             */
/* ------------------------------------------------------------------ */

/**
 * Somme nette du jeu FILTRÉ (TX-RECHERCHE-SOMME-NETTE1), groupée PAR DEVISE.
 *
 * POURQUOI un agrégat SERVEUR (piège TX-FILTRE1) : la pagination est en KEYSET → le
 * client ne détient qu'UNE page. Sommer côté client ne totaliserait que le VISIBLE,
 * pas l'ensemble filtré. Le total est donc calculé EN SQL, dans la même transaction
 * `withWorkspace` (RLS), avec les MÊMES prédicats que `listerTransactions`
 * (`conditionsFiltres` + `predicatStatut`, partagés) mais SANS curseur ni LIMIT :
 * une somme porte sur TOUT le jeu filtré.
 *
 * ⚠️ SIGNE — le piège de cet agrégat. Le sens d'une transaction vient de
 * `credit_debit` (colonne sous CHECK `IN ('Credit','Debit')`), JAMAIS du signe de
 * `amount` : l'ingestion (`normaliserMontant`, regex `^\d{1,13}(\.\d+)?$` — aucun
 * signe accepté) persiste une valeur ABSOLUE, et `amount` n'a aucun CHECK de signe.
 * Un `sum(amount)` nu ADDITIONNERAIT donc les sorties aux entrées (total faux,
 * toujours positif). On somme par `filter (where credit_debit = …)`, comme
 * `cashflowParDevise` et `synthesePeriodeParDevise` — une seule convention dans l'app :
 * `entrees`/`sorties` = magnitudes positives, `net = entrees − sorties` = signé.
 *
 * `round(…, 2)::text` (et non `::text` nu) fige l'ÉCHELLE à 2 décimales même quand le
 * `coalesce` retombe sur le littéral 0 (devise sans aucune entrée, p. ex.) — sinon "0"
 * vs "0.00" selon la présence de données, ce qui casserait l'alignement des virgules
 * décimales à l'affichage (contrat « chaîne décimale », règle 8). Zéro float, de la
 * base à l'écran.
 *
 * ⚠️ `round(…, 2)` et NON `::numeric(15,2)` (le cast qu'emploient `cashflowParDevise` /
 * `synthesePeriodeParDevise`) : ce cast fige l'échelle MAIS impose aussi un PLAFOND de
 * précision (|x| < 10^13) — inoffensif sur une colonne, atteignable sur une SOMME. Un
 * cumul qui le dépasse lève `numeric field overflow` au lieu de renvoyer un total. Cet
 * agrégat y est plus exposé que ses deux modèles : eux sont bornés par une fenêtre de
 * dates, lui peut porter sur TOUT l'historique d'une devise. `round` donne la même
 * garantie d'échelle sans le plafond. (Les deux sites existants gardent le leur : dette
 * TODOS AGREGATS-NUMERIC-PLAFOND1, hors périmètre de cette PR.)
 *
 * Multi-devises (règle 8) : GROUP BY devise, JAMAIS d'addition cross-devise, aucune
 * conversion FX (chantier DASH-FX1). Ordonné par devise (affichage stable). Jeu
 * filtré vide → tableau vide.
 */
export async function sommeNetteParDevise<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  _ctx: WorkspaceContext,
  params: SommeNetteInput,
): Promise<SommeNetteDevise[]> {
  const conditions = conditionsFiltres(params);
  if (params.statut) {
    conditions.push(predicatStatut(params.statut));
  }

  // Flux par SENS — `credit_debit` (sous CHECK) fait autorité, jamais le signe de
  // `amount` (cf. avertissement ci-dessus). Fragments réutilisés dans les trois
  // projections → `net` ne peut pas dériver de `entrees`/`sorties`.
  const entrees = sql`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)`;
  const sorties = sql`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)`;

  const lignes = await tx
    .select({
      currency: transactionsCache.currency,
      entrees: sql<string>`round(${entrees}, 2)::text`,
      sorties: sql<string>`round(${sorties}, 2)::text`,
      // net = entrées − sorties, calculé EN SQL (numeric exact), jamais en TS.
      net: sql<string>`round(${entrees} - ${sorties}, 2)::text`,
      nbTransactions: sql<number>`count(*)::int`,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage de la policy `entity_scope` (étage 2), qui vit sur
    // bank_accounts. Jointure SÛRE en cardinalité (bank_account_id NOT NULL → 1:1) :
    // elle ne duplique aucune ligne, donc ne fausse aucun montant.
    //
    // ⚠️ Ce n'est PAS la seule garde du périmètre, et pas la principale : depuis 0017,
    // `transactions_cache` (mère + partitions) porte elle-même `account_scope`
    // RESTRICTIVE, et `withWorkspace` TRADUIT le scope entité d'un membre en liste de
    // comptes (GUC account_scope). Le total d'un membre scopé est donc déjà borné sans
    // cette jointure — elle reste de la DÉFENSE EN PROFONDEUR (axe entité) et l'alignement
    // strict sur le jeu de lignes de la liste. Ne pas la retirer pour autant : c'est
    // l'invariant de lecture du dépôt (jamais de lecture des tables filles sans joindre
    // bank_accounts).
    //
    // `bank_connections` n'est délibérément PAS joint (la liste ne le joint que pour
    // PROJETER institution_name) : cette table ne porte QUE `tenant_isolation` (0003) —
    // aucune policy entity/account — et `bank_accounts.connection_id` est NOT NULL vers
    // le même workspace ⇒ la jointure de la liste ne peut écarter aucune ligne.
    // L'omettre est donc NEUTRE sur le jeu de lignes : la somme reste exactement celle
    // des lignes listées.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    // PLUS d'agrégat joint ici (PERF-VENTILATION-AGG1) : depuis que `predicatStatut`
    // est CORRÉLÉ, le filtre de statut se suffit à lui-même et cette somme n'a jamais
    // projeté les colonnes de l'agrégat (elle ne rend que des sommes par devise). La
    // jointure était donc devenue du poids mort — et un agrégat global joint est
    // exactement ce qui coûtait 1970 ms à la liste. Le fragment `predicatStatut`
    // restant PARTAGÉ avec `listerTransactions`, le total continue de porter
    // exactement les lignes listées.
    .where(and(...conditions))
    .groupBy(transactionsCache.currency)
    .orderBy(transactionsCache.currency);

  return lignes;
}

/**
 * Prédicat SQL du filtre de statut — sous-requêtes CORRÉLÉES sur
 * transaction_categorizations (mêmes règles que `statutExpr` → cohérence stricte
 * filtre/affichage).
 *  - NON_CATEGORISE : aucun split rattaché.
 *  - COMPLET : au moins un split ET somme ≥ |montant| (l'invariant repository
 *    garantit qu'elle ne le dépasse jamais ; ≥ couvre l'égalité exacte).
 *  - PARTIEL : au moins un split mais somme < |montant|.
 *
 * POURQUOI CORRÉLÉ et non un agrégat global joint (PERF-VENTILATION-AGG1) : sous
 * RLS, tous les prédicats passent par `current_setting(…)`, OPAQUE à l'estimateur,
 * qui table sur `rows=1` là où il y en a des milliers. Un agrégat joint — table
 * dérivée OU CTE, même `MATERIALIZED` — laisse alors le planificateur choisir un
 * Nested Loop qui le RESCANNE par ligne externe : 1970 ms mesurés, et 324 ms même
 * en CTE `MATERIALIZED` (la matérialisation empêche le RECALCUL, pas le RESCAN —
 * elle ne choisit pas la méthode de jointure). Une sous-requête corrélée, elle,
 * n'est PAS réordonnable par le planificateur : elle s'évalue par ligne, par index
 * (txn_categorizations_workspace_txn_idx). Le plan devient robuste par CONSTRUCTION
 * au lieu de dépendre d'une estimation que la RLS rend impossible. Coût
 * O(N × log M) au lieu de O(N × M) : ~16-22 ms (cf. PLAN §3.2). Ne pas « simplifier »
 * en re-joignant un agrégat global — ce serait rouvrir la dette.
 *
 * ⚠️ `exists` est REQUIS sur COMPLET, il n'est pas décoratif : `amount` est
 * `numeric(15,2)` SANS contrainte de positivité (0 est permis par le schéma). Sans
 * ce garde, une transaction à montant nul et SANS split satisferait `0 >= abs(0)` et
 * serait capturée par le filtre COMPLET, alors que `statutExpr` la classe
 * NON_CATEGORISE (il teste nb_splits=0 d'abord) — le filtre contredirait la colonne
 * affichée. L'ancienne version portait cette divergence (latente : aucune ligne à
 * montant nul en base, vérifié) tout en documentant l'inverse.
 */
function predicatStatut(statut: StatutVentilation) {
  const existeSplit = sql`exists (
    select 1 from transaction_categorizations z
    where z.transaction_id = ${transactionsCache.id}
      and z.transaction_date = ${transactionsCache.transactionDate}
  )`;
  const sommeSplits = sql`(
    select coalesce(sum(z.amount), 0) from transaction_categorizations z
    where z.transaction_id = ${transactionsCache.id}
      and z.transaction_date = ${transactionsCache.transactionDate}
  )`;
  switch (statut) {
    case "NON_CATEGORISE":
      return sql`not ${existeSplit}`;
    case "COMPLET":
      return sql`${existeSplit} and ${sommeSplits} >= abs(${transactionsCache.amount})`;
    case "PARTIEL":
      return sql`${existeSplit} and ${sommeSplits} < abs(${transactionsCache.amount})`;
  }
}

/* ------------------------------------------------------------------ */
/* Prédicats & fragments SQL PARTAGÉS (liste ↔ somme nette)            */
/* ------------------------------------------------------------------ */

/**
 * Prédicats de filtre MÉTIER communs à `listerTransactions` et à
 * `sommeNetteParDevise`. Partagés VOLONTAIREMENT (et non recopiés) : si la somme
 * filtrait autrement que la liste, le total affiché ne correspondrait plus aux lignes
 * affichées — un faux chiffre sur un écran financier, sans le moindre signal d'erreur.
 * Les deux appelants ajoutent ensuite ce qui leur est propre : le curseur keyset (la
 * liste seule) et le statut de ventilation (qui dépend de l'agrégat joint).
 *
 * Ne contient JAMAIS `workspace_id` : l'isolation tenant est portée par la RLS, pas
 * par un WHERE applicatif (règle 2).
 */
function conditionsFiltres(params: {
  recherche?: string;
  bankAccountId?: string;
  dateDebut?: string;
  dateFin?: string;
}) {
  const { recherche, bankAccountId, dateDebut, dateFin } = params;

  const conditions = [eq(transactionsCache.isRemoved, false)];
  if (bankAccountId) {
    conditions.push(eq(transactionsCache.bankAccountId, bankAccountId));
  }
  if (recherche) {
    // Échappe les méta-caractères LIKE pour traiter la saisie comme littérale.
    const motif = `%${recherche.replace(/[\\%_]/g, "\\$&")}%`;
    // ILIKE sur le libellé CHERCHABLE : le marchand nettoyé s'il est non vide
    // (même `trim` que `resoudreLibelle`), SINON le brut bancaire — c'est-à-dire
    // ce que la colonne Libellé AFFICHE. Avant ce correctif, seul `clean_label`
    // était interrogé : ~1 tx sur 3 (clean_label NULL) restait INTROUVABLE alors
    // que son libellé brut était à l'écran ET que le moteur de règles, lui, le
    // matche (incohérence chercher/afficher/règles). Le niveau intermédiaire de
    // la cascade (« catégorie FR ») est un mapping applicatif TS, non transposable
    // ici — compromis assumé : la recherche couvre marchand + brut.
    // Règle 8 : elle interdit le brut dans les LOGS/télémétrie, pas dans un WHERE
    // (le motif reste un paramètre lié ; rien n'est journalisé) — le brut est
    // d'ailleurs AFFICHÉ en repli depuis la décision produit du 2026-06-23.
    conditions.push(
      ilike(
        sql`coalesce(nullif(trim(${transactionsCache.cleanLabel}), ''), ${transactionsCache.bankLabelRaw})`,
        motif,
      ),
    );
  }
  if (dateDebut) {
    conditions.push(gte(transactionsCache.transactionDate, dateDebut));
  }
  if (dateFin) {
    conditions.push(lte(transactionsCache.transactionDate, dateFin));
  }
  return conditions;
}

/**
 * Agrégat de ventilation d'UNE ligne de page, en LATERAL corrélé (anti-N+1 SANS
 * agrégat global — cf. le POURQUOI détaillé dans `predicatStatut`).
 *
 * Corrélé sur la clé COMPOSITE `(transaction_id, transaction_date)` : la table est
 * partitionnée par date, qui fait donc partie de la clé — corréler sur le seul id
 * scannerait toutes les partitions.
 *
 * La RLS s'applique PLEINEMENT ici : `transaction_categorizations` porte
 * `tenant_isolation` (étage 1) ET `account_scope` RESTRICTIVE (étage 2, migration
 * 0017) — l'agrégat borné à la page ne peut donc pas voir un split hors workspace ni
 * hors périmètre, quelle que soit la forme de la requête.
 *
 * Catégorie DOMINANTE (FB0709-TX-CATEGORIE-VISIBLE1) : jointure INTERNE sur
 * `categories` — sûre en cardinalité (category_id NOT NULL + FK composite
 * (category_id, workspace_id) → même workspace, PK unique → 1:1, la RLS de categories
 * ne peut donc rien filtrer de plus que celle des splits). `array_agg(… order by
 * z.amount desc, …)` élit la part au plus gros montant ; départage déterministe par
 * nom puis category_id à montants égaux.
 *
 * Renvoyée par une FONCTION (et non exposée en const de module) pour ne jamais partager
 * une instance de fragment SQL entre deux requêtes.
 */
function aggregatVentilationLateral(page: {
  id: unknown;
  transactionDate: unknown;
}) {
  return sql`(
    select
      count(*)::int as nb_splits,
      coalesce(sum(z.amount), 0)::numeric as montant_ventile,
      (array_agg(z.category_id order by z.amount desc, cat.name asc, z.category_id asc))[1] as cat_dominante_id,
      (array_agg(cat.name      order by z.amount desc, cat.name asc, z.category_id asc))[1] as cat_dominante_nom
    from transaction_categorizations z
    join categories cat on cat.id = z.category_id
    where z.transaction_id = ${page.id}
      and z.transaction_date = ${page.transactionDate}
  ) agg`;
}
