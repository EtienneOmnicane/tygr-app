/**
 * Repository d'ingestion Omni-FI (PR 2) — persistance scopée des données bancaires.
 * TOUTES les fonctions s'exécutent DANS withWorkspace(session, fn) : `tx` porte
 * déjà app.current_workspace_id, donc chaque INSERT/UPDATE passe la policy
 * tenant_isolation WITH CHECK (impossible d'écrire dans un autre tenant). Le
 * workspace_id n'est jamais un paramètre client : il vient de ctx (CLAUDE.md
 * règle 2).
 *
 * Montants : chaînes `numeric` déjà normalisées par src/server/ingestion/conversion
 * (règle 8, jamais de float). Idempotence : voir upsertTransactions (#2).
 */
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  bankAccounts,
  bankConnections,
  balanceHistory,
  transactionsCache,
} from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface ConnexionAUpserter {
  omnifiConnectionId: string;
  institutionId: string;
  status: string;
  nextSyncAvailableAt: Date | null;
}

export interface CompteAUpserter {
  omnifiAccountId: string;
  accountName: string;
  currency: string;
  currentBalance: string | null; // numeric en chaîne (règle 8)
  isSelected: boolean;
}

export interface TransactionAUpserter {
  omnifiTxnId: string;
  transactionDate: string; // YYYY-MM-DD Maurice (E20)
  bookingDateTime: Date;
  amount: string; // numeric en chaîne (règle 8)
  currency: string;
  creditDebit: "Credit" | "Debit";
  bankLabelRaw: string;
  cleanLabel: string | null;
  primaryCategory: string | null;
  subCategory: string | null;
  isRemoved: boolean;
}

export interface SoldeAUpserter {
  balanceDate: string; // YYYY-MM-DD
  balance: string; // numeric en chaîne
  currency: string;
}

/**
 * Upsert d'une connexion bancaire dans le workspace courant. Retourne l'id local.
 * Idempotent sur omnifi_connection_id (UNIQUE).
 */
export async function upsertConnexion<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  c: ConnexionAUpserter,
): Promise<{ connectionId: string }> {
  const lignes = await tx
    .insert(bankConnections)
    .values({
      workspaceId: ctx.workspaceId,
      omnifiConnectionId: c.omnifiConnectionId,
      institutionId: c.institutionId,
      status: c.status,
      nextSyncAvailableAt: c.nextSyncAvailableAt,
      createdBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: bankConnections.omnifiConnectionId,
      set: {
        status: c.status,
        nextSyncAvailableAt: c.nextSyncAvailableAt,
      },
    })
    .returning({ id: bankConnections.id });
  return { connectionId: lignes[0].id };
}

/**
 * Upsert d'un compte rattaché à une connexion du workspace courant.
 * Idempotent sur omnifi_account_id (UNIQUE). Retourne l'id local + le curseur
 * de sync existant (pour reprendre l'incrémental).
 */
export async function upsertCompte<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  connectionId: string,
  c: CompteAUpserter,
): Promise<{ bankAccountId: string; syncCursor: string | null }> {
  const lignes = await tx
    .insert(bankAccounts)
    .values({
      workspaceId: ctx.workspaceId,
      connectionId,
      omnifiAccountId: c.omnifiAccountId,
      accountName: c.accountName,
      currency: c.currency,
      currentBalance: c.currentBalance,
      isSelected: c.isSelected,
    })
    .onConflictDoUpdate({
      target: bankAccounts.omnifiAccountId,
      set: {
        accountName: c.accountName,
        currency: c.currency,
        currentBalance: c.currentBalance,
        isSelected: c.isSelected,
      },
    })
    .returning({ id: bankAccounts.id, syncCursor: bankAccounts.syncCursor });
  return { bankAccountId: lignes[0].id, syncCursor: lignes[0].syncCursor };
}

/**
 * Upsert idempotent d'un lot de transactions (#2 — la clé DB inclut
 * transaction_date à cause du partitionnement ; un upsert ON CONFLICT keyé sur
 * (omnifi_txn_id, transaction_date) raterait un doublon si la date comptable
 * change entre deux syncs). On rend donc l'idempotence indépendante de la date :
 * pour chaque transaction, on SUPPRIME LOGIQUEMENT toute ligne existante de même
 * omnifi_txn_id dont la date diffère (réaffectation de jour comptable), puis on
 * upsert sur la clé naturelle. Tout dans la transaction withWorkspace courante.
 *
 * NB : transactions_cache n'autorise pas le DELETE (tombstone, #3) ; la
 * « suppression » d'un doublon de date obsolète passe par is_removed=true.
 */
export async function upsertTransactions<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  bankAccountId: string,
  lot: TransactionAUpserter[],
): Promise<{ insérées: number }> {
  let compteur = 0;
  for (const t of lot) {
    // #2 : neutralise toute version antérieure de CETTE transaction posée sur un
    // AUTRE jour comptable (BookingDateTime ré-affiné par l'amont). RLS scope la
    // mise à jour au workspace courant ; on ne touche jamais un autre tenant.
    await tx
      .update(transactionsCache)
      .set({ isRemoved: true })
      .where(
        and(
          eq(transactionsCache.omnifiTxnId, t.omnifiTxnId),
          sql`${transactionsCache.transactionDate} <> ${t.transactionDate}`,
        ),
      );

    await tx
      .insert(transactionsCache)
      .values({
        workspaceId: ctx.workspaceId,
        bankAccountId,
        omnifiTxnId: t.omnifiTxnId,
        transactionDate: t.transactionDate,
        bookingDateTime: t.bookingDateTime,
        amount: t.amount,
        currency: t.currency,
        creditDebit: t.creditDebit,
        bankLabelRaw: t.bankLabelRaw,
        cleanLabel: t.cleanLabel,
        primaryCategory: t.primaryCategory,
        subCategory: t.subCategory,
        isRemoved: t.isRemoved,
      })
      .onConflictDoUpdate({
        target: [transactionsCache.omnifiTxnId, transactionsCache.transactionDate],
        set: {
          amount: t.amount,
          currency: t.currency,
          creditDebit: t.creditDebit,
          bankLabelRaw: t.bankLabelRaw,
          cleanLabel: t.cleanLabel,
          primaryCategory: t.primaryCategory,
          subCategory: t.subCategory,
          isRemoved: t.isRemoved,
        },
      });
    compteur += 1;
  }
  return { insérées: compteur };
}

/** Upsert d'un lot de soldes EOD d'un compte. Idempotent sur (bank_account_id, balance_date). */
export async function upsertSoldes<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  bankAccountId: string,
  lot: SoldeAUpserter[],
): Promise<void> {
  for (const s of lot) {
    await tx
      .insert(balanceHistory)
      .values({
        workspaceId: ctx.workspaceId,
        bankAccountId,
        balanceDate: s.balanceDate,
        balance: s.balance,
        currency: s.currency,
      })
      .onConflictDoUpdate({
        target: [balanceHistory.bankAccountId, balanceHistory.balanceDate],
        set: { balance: s.balance, currency: s.currency },
      });
  }
}

/**
 * Marque la dernière synchronisation d'un compte (`last_synced_at`). Le modèle
 * d'ingestion est par PAGE (on relit toujours depuis la page 1) : il n'y a plus de
 * curseur à persister — la colonne `sync_cursor` reste orpheline (dette TODOS,
 * retrait différé pour ne pas coupler ce changement à une migration).
 */
export async function marquerSynchronise<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  bankAccountId: string,
  maintenant: Date,
): Promise<void> {
  await tx
    .update(bankAccounts)
    .set({ lastSyncedAt: maintenant })
    .where(eq(bankAccounts.id, bankAccountId));
}
