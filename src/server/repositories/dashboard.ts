/**
 * Services de LECTURE du dashboard (Epic 3 — FEAT-3.1). Toutes les fonctions
 * s'exécutent DANS withWorkspace(session, fn) : `tx` porte app.current_workspace_id,
 * donc chaque SELECT est filtré par la policy RLS tenant_isolation — l'isolation
 * inter-workspace est garantie par la base, pas par un WHERE applicatif (CLAUDE.md
 * règle 2). Aucun de ces services ne prend workspace_id en paramètre.
 *
 * Règle 8 (montants) : les colonnes sont `numeric` ; toute SOMME/agrégat est
 * calculé EN SQL (jamais d'addition de floats côté JS). Les montants ressortent
 * en CHAÎNES décimales — la couche UI les formate (tabular-nums) sans recalcul.
 * Les transactions tombstone (is_removed=true) sont exclues de toute lecture.
 *
 * Étage 2 — ENTITÉ (ENTITY-READ-JOIN1) : la policy RLS RESTRICTIVE `entity_scope`
 * vit sur `bank_accounts` (migration 0008). Les soldes/transactions n'héritent du
 * périmètre entité QUE par une JOINTURE sur `bank_accounts` (pas de policy dédiée sur
 * l'append-only/partitionné). Toute lecture de `transactions_cache`/`balance_history`
 * ici joint donc `bank_accounts` pour que le scope morde par héritage : en Vision
 * Globale (GUC vide) la RESTRICTIVE laisse tout passer (agrégats inchangés) ; en Vision
 * Entité, les comptes hors périmètre (et les non assignés) sont masqués. Ne JAMAIS
 * lire ces tables filles sans cette jointure (sinon fuite intra-groupe — étage 2).
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  bankAccounts,
  bankConnections,
  balanceHistory,
  transactionsCache,
} from "@/server/db/schema";
import type { WorkspaceTx } from "@/server/db/tenancy";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
type Tx = WorkspaceTx<AnyPgDatabase>;

/* ------------------------------------------------------------------ */
/* Types de sortie (montants = chaînes décimales, règle 8)             */
/* ------------------------------------------------------------------ */

export interface CompteConnecte {
  bankAccountId: string;
  accountName: string;
  /** Nom lisible de la banque (« Absa Internet Banking »), via la connexion ; null si absent. */
  institutionName: string | null;
  currency: string;
  currentBalance: string | null;
  lastSyncedAt: Date | null;
}

/**
 * Solde consolidé COURANT d'une devise (somme des `current_balance` des comptes de
 * cette devise). Multi-devises (CLAUDE.md) : on NE somme JAMAIS entre devises — on
 * expose une ligne PAR devise, l'UI les affiche côte à côte (« 7 074 400 MUR » +
 * « 179 200 USD »). La conversion vers la base_currency (FX annoté) est un chantier
 * séparé (TODOS DASH-FX1) ; tant qu'il n'existe pas, on n'invente aucun taux.
 */
export interface SoldeParDevise {
  currency: string;
  /** Somme des soldes courants de la devise, chaîne décimale (règle 8). */
  total: string;
}

export interface PointCourbe {
  date: string; // YYYY-MM-DD (jour comptable Maurice)
  soldeConsolide: string; // somme EOD multi-comptes, chaîne numeric
}

export interface SyntheseMois {
  libelleMois: string; // YYYY-MM
  entrees: string;
  sorties: string;
  variation: string; // entrees - sorties (calcul SQL)
}

/**
 * Synthèse entrées/sorties/variation d'un mois POUR UNE DEVISE. Multi-devises
 * (CLAUDE.md règle 8) : `syntheseMoisParDevise` renvoie UNE entrée PAR devise — on
 * n'additionne JAMAIS des MUR et des USD (ce que faisait `syntheseMois`, qui sommait
 * `amount` toutes devises confondues et affichait le total dans la base_currency :
 * faux dès qu'un workspace a des comptes en plusieurs devises). Aucune conversion FX
 * (chantier DASH-FX1) : on expose les flux côte à côte, par devise.
 */
export interface SyntheseMoisDevise {
  currency: string;
  entrees: string;
  sorties: string;
  variation: string; // entrees - sorties (calcul SQL), pour CETTE devise
}

export interface TransactionRecente {
  omnifiTxnId: string;
  transactionDate: string;
  amount: string;
  currency: string;
  creditDebit: "Credit" | "Debit";
  cleanLabel: string | null;
  primaryCategory: string | null;
  subCategory: string | null;
  bankAccountId: string;
}

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */

/** Comptes connectés (sélectionnés) du workspace — side-panel + en-tête courbe. */
export async function listerComptes(tx: Tx): Promise<CompteConnecte[]> {
  const lignes = await tx
    .select({
      bankAccountId: bankAccounts.id,
      accountName: bankAccounts.accountName,
      // Provenance bancaire (DASH-INST1) : le nom vit sur la connexion. innerJoin
      // sûr car bank_accounts.connection_id est NOT NULL (tout compte a une connexion).
      institutionName: bankConnections.institutionName,
      currency: bankAccounts.currency,
      currentBalance: bankAccounts.currentBalance,
      lastSyncedAt: bankAccounts.lastSyncedAt,
    })
    .from(bankAccounts)
    .innerJoin(bankConnections, eq(bankAccounts.connectionId, bankConnections.id))
    .where(eq(bankAccounts.isSelected, true))
    .orderBy(bankAccounts.accountName);
  return lignes;
}

/**
 * Solde consolidé courant : somme du DERNIER solde EOD connu de chaque compte.
 * On prend, par compte, la ligne balance_history de date max, puis on somme.
 * Calcul d'agrégat EN SQL (numeric), retour en chaîne. NULL → "0.00".
 */
export async function soldeConsolideCourant(tx: Tx): Promise<string> {
  // Sous-requête : dernier solde par compte (date max).
  const dernier = tx
    .select({
      bankAccountId: balanceHistory.bankAccountId,
      maxDate: sql<string>`max(${balanceHistory.balanceDate})`.as("max_date"),
    })
    .from(balanceHistory)
    .groupBy(balanceHistory.bankAccountId)
    .as("dernier");

  const res = await tx
    .select({
      total: sql<string>`coalesce(sum(${balanceHistory.balance}), 0)::text`,
    })
    .from(balanceHistory)
    .innerJoin(
      dernier,
      and(
        eq(balanceHistory.bankAccountId, dernier.bankAccountId),
        eq(balanceHistory.balanceDate, dernier.maxDate),
      ),
    )
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope par jointure sur
    // bank_accounts. La sous-requête `dernier` peut calculer des dates max pour des
    // comptes hors scope, mais ce join les ÉLIMINE (la policy masque ces bank_accounts
    // → pas de correspondance), donc la somme ne porte que sur le périmètre. NOT NULL
    // garanti sur bank_account_id. (Fonction sans appelant applicatif vivant à ce jour,
    // mais corrigée pour ne pas laisser une fuite balance_history par une autre porte.)
    .innerJoin(bankAccounts, eq(balanceHistory.bankAccountId, bankAccounts.id));
  return res[0]?.total ?? "0";
}

/**
 * Soldes consolidés COURANTS par devise — somme de `bank_accounts.current_balance`
 * des comptes sélectionnés, GROUP BY devise. C'est la source du « Solde Total » du
 * dashboard : elle ne dépend PAS de `balance_history` (vide tant qu'Omni-FI n'expose
 * pas `/balances/history`, cf. OMNIFI_API_FEEDBACK.md §10), contrairement à
 * `soldeConsolideCourant` (réservé aux usages EOD historiques).
 *
 * Multi-devises (CLAUDE.md, règle 8) : agrégat EN SQL (numeric), une ligne par
 * devise, jamais d'addition cross-devise. Les comptes à `current_balance` NULL sont
 * ignorés par `sum`. Ordonné par devise pour un affichage stable.
 */
export async function soldesCourantsParDevise(tx: Tx): Promise<SoldeParDevise[]> {
  const lignes = await tx
    .select({
      currency: bankAccounts.currency,
      total: sql<string>`coalesce(sum(${bankAccounts.currentBalance}), 0)::text`,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.isSelected, true))
    .groupBy(bankAccounts.currency)
    .orderBy(bankAccounts.currency);
  return lignes;
}

/**
 * Courbe de trésorerie : solde EOD CONSOLIDÉ (somme multi-comptes) par jour, sur
 * [from, to]. Agrégation SQL ; une ligne par jour ayant au moins un solde.
 */
export async function courbeTresorerie(
  tx: Tx,
  fenetre: { from: string; to: string },
): Promise<PointCourbe[]> {
  const lignes = await tx
    .select({
      date: balanceHistory.balanceDate,
      soldeConsolide: sql<string>`sum(${balanceHistory.balance})::text`,
    })
    .from(balanceHistory)
    // ENTITY-READ-JOIN1 : la policy RLS entity_scope vit sur bank_accounts. Cette
    // jointure (sûre : balance_history.bank_account_id est NOT NULL) la fait HÉRITER
    // sur les soldes EOD → en Vision Entité, seuls les comptes du périmètre comptent
    // dans la courbe ; en Vision Globale (GUC vide) la RESTRICTIVE laisse tout passer
    // → agrégat inchangé. Sans elle, la lecture directe fuit les autres entités.
    .innerJoin(bankAccounts, eq(balanceHistory.bankAccountId, bankAccounts.id))
    .where(
      and(
        gte(balanceHistory.balanceDate, fenetre.from),
        lte(balanceHistory.balanceDate, fenetre.to),
      ),
    )
    .groupBy(balanceHistory.balanceDate)
    .orderBy(balanceHistory.balanceDate);
  return lignes;
}

/**
 * @deprecated MULTI-DEVISE CASSÉ : cette fonction somme `amount` SANS GROUP BY devise
 * → pour un workspace avec des comptes MUR + USD, elle additionne des roupies et des
 * dollars et l'UI affiche le total dans la base_currency (faux). Conservée le temps que
 * le Front migre les cartes (SidePanelKpi « Détails » + CashFlowSummary) vers
 * `syntheseMoisParDevise` (une ligne par devise). NE PAS l'utiliser dans du code neuf.
 *
 * Synthèse entrées/sorties/variation d'un mois (YYYY-MM). Somme conditionnelle
 * EN SQL sur le sens ; exclut les tombstones. Montants en chaînes.
 */
export async function syntheseMois(
  tx: Tx,
  mois: string, // "YYYY-MM"
): Promise<SyntheseMois> {
  const debut = `${mois}-01`;
  // Borne haute exclusive = 1er du mois suivant (calcul SQL pour rester correct).
  const res = await tx
    .select({
      entrees: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)::text`,
      sorties: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)::text`,
      variation: sql<string>`(
        coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)
        - coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)
      )::text`,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope (sur bank_accounts) par
    // jointure (sûre : transactions_cache.bank_account_id est NOT NULL). En Vision
    // Entité, la synthèse entrées/sorties ne compte que les transactions du périmètre ;
    // en Vision Globale la RESTRICTIVE n'exclut rien → totaux inchangés.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(transactionsCache.isRemoved, false),
        gte(transactionsCache.transactionDate, debut),
        sql`${transactionsCache.transactionDate} < (${debut}::date + interval '1 month')`,
      ),
    );
  return {
    libelleMois: mois,
    entrees: res[0]?.entrees ?? "0",
    sorties: res[0]?.sorties ?? "0",
    variation: res[0]?.variation ?? "0",
  };
}

/**
 * Synthèse entrées/sorties/variation d'un mois (YYYY-MM) VENTILÉE PAR DEVISE —
 * remplace `syntheseMois` pour le multi-devise (challenge mapping 2026-06-22). GROUP BY
 * devise : une ligne par devise présente sur le mois, JAMAIS d'addition cross-devise
 * (CLAUDE.md règle 8). Mêmes règles que `syntheseMois` (somme conditionnelle EN SQL sur
 * le sens, exclusion des tombstones, montants en chaînes) + héritage du scope entité
 * par jointure sur bank_accounts (ENTITY-READ-JOIN1). Ordonné par devise (affichage
 * stable). Mois sans transaction → tableau vide (l'UI affiche 0 dans la devise de base).
 */
export async function syntheseMoisParDevise(
  tx: Tx,
  mois: string, // "YYYY-MM"
): Promise<SyntheseMoisDevise[]> {
  const debut = `${mois}-01`;
  const lignes = await tx
    .select({
      currency: transactionsCache.currency,
      entrees: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)::text`,
      sorties: sql<string>`coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)::text`,
      variation: sql<string>`(
        coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Credit'), 0)
        - coalesce(sum(${transactionsCache.amount}) filter (where ${transactionsCache.creditDebit} = 'Debit'), 0)
      )::text`,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope (sur bank_accounts) par
    // jointure (sûre : bank_account_id NOT NULL). Même garantie que syntheseMois.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(transactionsCache.isRemoved, false),
        gte(transactionsCache.transactionDate, debut),
        sql`${transactionsCache.transactionDate} < (${debut}::date + interval '1 month')`,
      ),
    )
    .groupBy(transactionsCache.currency)
    .orderBy(transactionsCache.currency);
  return lignes;
}

/**
 * N transactions les plus récentes (hors tombstone), triées date desc puis
 * booking desc. Pas de bank_label_raw exposé (PII, règle 8) — on renvoie le
 * libellé nettoyé.
 */
export async function transactionsRecentes(
  tx: Tx,
  limite = 8,
): Promise<TransactionRecente[]> {
  const lignes = await tx
    .select({
      omnifiTxnId: transactionsCache.omnifiTxnId,
      transactionDate: transactionsCache.transactionDate,
      amount: transactionsCache.amount,
      currency: transactionsCache.currency,
      creditDebit: transactionsCache.creditDebit,
      cleanLabel: transactionsCache.cleanLabel,
      primaryCategory: transactionsCache.primaryCategory,
      subCategory: transactionsCache.subCategory,
      bankAccountId: transactionsCache.bankAccountId,
    })
    .from(transactionsCache)
    // ENTITY-READ-JOIN1 : héritage de la policy entity_scope (sur bank_accounts) par
    // jointure (sûre : transactions_cache.bank_account_id est NOT NULL). En Vision
    // Entité, seules les transactions des comptes du périmètre remontent ; en Vision
    // Globale la RESTRICTIVE laisse tout passer → liste inchangée. La jointure ne
    // change ni les colonnes sélectionnées (toutes issues de transactions_cache) ni la
    // cardinalité (1 compte par transaction), donc le contrat TransactionRecente tient.
    .innerJoin(bankAccounts, eq(transactionsCache.bankAccountId, bankAccounts.id))
    .where(eq(transactionsCache.isRemoved, false))
    .orderBy(desc(transactionsCache.transactionDate), desc(transactionsCache.bookingDateTime))
    .limit(limite);
  return lignes as TransactionRecente[];
}
