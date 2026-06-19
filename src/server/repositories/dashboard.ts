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
    );
  return res[0]?.total ?? "0";
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
    .where(eq(transactionsCache.isRemoved, false))
    .orderBy(desc(transactionsCache.transactionDate), desc(transactionsCache.bookingDateTime))
    .limit(limite);
  return lignes as TransactionRecente[];
}
