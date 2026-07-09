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
   * de PII nominative ; la recherche (ILIKE) reste sur cleanLabel uniquement.
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
  const { recherche, bankAccountId, statut, dateDebut, dateFin, curseur, limite } =
    params;

  // Prédicats de filtre. La RLS scope déjà au workspace ; ces conditions sont
  // métier (jamais workspace_id, qui n'est pas un paramètre).
  const conditions = [eq(transactionsCache.isRemoved, false)];
  if (bankAccountId) {
    conditions.push(eq(transactionsCache.bankAccountId, bankAccountId));
  }
  if (recherche) {
    // ILIKE sur le libellé NETTOYÉ uniquement (bank_label_raw = PII, règle 8).
    // Échappe les méta-caractères LIKE pour traiter la saisie comme littérale.
    const motif = `%${recherche.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(ilike(transactionsCache.cleanLabel, motif));
  }
  if (dateDebut) {
    conditions.push(gte(transactionsCache.transactionDate, dateDebut));
  }
  if (dateFin) {
    conditions.push(lte(transactionsCache.transactionDate, dateFin));
  }

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

  // Résumé de ventilation ANTI-N+1 — table dérivée PRÉ-AGRÉGÉE jointe en LEFT
  // JOIN. On groupe les splits par (transaction_id, transaction_date) UNE fois,
  // puis on joint : un seul scan groupé de transaction_categorizations pour toute
  // la page, jamais une requête par ligne. La RLS s'applique aussi à
  // transaction_categorizations → l'agrégat reste scopé au workspace courant.
  //
  // Pourquoi une table dérivée et pas des sous-requêtes scalaires projetées : en
  // rowMode "array", Drizzle mappe les colonnes par POSITION ; une sous-requête
  // scalaire `(select …)` de tête désaligne ce mapping (le résumé ressortait à 0
  // alors que le CASE, lui, voyait le bon agrégat — symptôme observé en test).
  // Une table dérivée expose des colonnes nommées sans ambiguïté. (LATERAL écarté :
  // Drizzle préfixe un `left join` redondant via .leftJoin().)
  // Catégorie DOMINANTE (FB0709-TX-CATEGORIE-VISIBLE1) : jointure INTERNE sur
  // categories DANS l'agrégat — sûre en cardinalité (category_id NOT NULL + FK
  // composite (category_id, workspace_id) → même workspace, PK unique → 1:1, la
  // RLS de categories ne peut donc rien filtrer de plus que celle des splits).
  // `array_agg(… order by tc.amount desc, …)` élit la part au plus gros montant ;
  // départage déterministe par nom puis category_id à montants égaux.
  const agg = sql`(
    select
      tc.transaction_id  as txn_id,
      tc.transaction_date as txn_date,
      count(*)::int       as nb_splits,
      coalesce(sum(tc.amount), 0)::numeric as montant_ventile,
      (array_agg(tc.category_id order by tc.amount desc, cat.name asc, tc.category_id asc))[1] as cat_dominante_id,
      (array_agg(cat.name        order by tc.amount desc, cat.name asc, tc.category_id asc))[1] as cat_dominante_nom
    from transaction_categorizations tc
    join categories cat on cat.id = tc.category_id
    group by tc.transaction_id, tc.transaction_date
  ) agg`;

  // Agrégat « aplati » : COALESCE pour les transactions sans aucun split (la
  // jointure LEFT laisse NULL → 0). Réutilisé en projection ET dans le filtre de
  // statut pour garantir leur cohérence stricte.
  const nbSplitsExpr = sql<number>`coalesce(agg.nb_splits, 0)`;
  const montantVentileExpr = sql<string>`coalesce(agg.montant_ventile, 0)::text`;
  const statutExpr = sql<StatutVentilation>`
    case
      when coalesce(agg.nb_splits, 0) = 0 then 'NON_CATEGORISE'
      when coalesce(agg.montant_ventile, 0) >= abs(${transactionsCache.amount}) then 'COMPLET'
      else 'PARTIEL'
    end
  `;

  // Filtre de statut : porte sur l'agrégat joint (même expression que ci-dessus →
  // cohérence projection/filtre garantie). Reste dans la même passe que la lecture.
  if (statut) {
    conditions.push(predicatStatut(statut));
  }

  const lignes = await tx
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
      nbSplits: nbSplitsExpr,
      montantVentile: montantVentileExpr,
      statut: statutExpr,
      // Colonnes NOMMÉES de la table dérivée (jamais de sous-requête scalaire ici,
      // cf. avertissement rowMode "array" ci-dessus). NULL si aucun split (LEFT JOIN).
      categorieDominanteId: sql<string | null>`agg.cat_dominante_id`,
      categorieDominanteNom: sql<string | null>`agg.cat_dominante_nom`,
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
    .leftJoin(
      agg,
      sql`agg.txn_id = ${transactionsCache.id} and agg.txn_date = ${transactionsCache.transactionDate}`,
    )
    .where(and(...conditions))
    // Tri total déterministe (cf. en-tête) — aligné sur l'index couvrant.
    .orderBy(
      sql`${transactionsCache.transactionDate} desc`,
      sql`${transactionsCache.id} desc`,
    )
    // +1 pour détecter la page suivante sans COUNT.
    .limit(limite + 1);

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

/**
 * Prédicat SQL du filtre de statut, basé sur l'agrégat JOINT `agg` (mêmes
 * colonnes que la projection → cohérence stricte filtre/affichage). On passe par
 * COALESCE car la jointure LEFT laisse NULL pour une transaction sans split.
 *  - NON_CATEGORISE : aucun split rattaché.
 *  - COMPLET : somme des splits ≥ |montant| (l'invariant repository garantit
 *    qu'elle ne le dépasse jamais ; ≥ couvre l'égalité exacte).
 *  - PARTIEL : au moins un split mais somme < |montant|.
 */
function predicatStatut(statut: StatutVentilation) {
  const nb = sql`coalesce(agg.nb_splits, 0)`;
  const somme = sql`coalesce(agg.montant_ventile, 0)`;
  switch (statut) {
    case "NON_CATEGORISE":
      return sql`${nb} = 0`;
    case "COMPLET":
      return sql`${somme} >= abs(${transactionsCache.amount})`;
    case "PARTIEL":
      return sql`${nb} > 0 and ${somme} < abs(${transactionsCache.amount})`;
  }
}
