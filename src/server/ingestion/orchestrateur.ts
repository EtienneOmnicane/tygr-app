/**
 * Orchestrateur d'ingestion Omni-FI (PR 2) — boucle de synchronisation d'un
 * compte : appelle le client (PR 1), convertit (règle 8 / E20), persiste via les
 * repositories scopés (withWorkspace). Pur de toute I/O DB directe : il reçoit un
 * `executer` = withWorkspace lié à la session, et délègue la persistance.
 *
 * Modèle = pagination par PAGE (contrat réel déployé, aligné OBIE ; confirmé
 * Omni-FI 2026-06-19) : on relit la liste complète des transactions du compte,
 * page après page, en suivant `Links.Next` / `Meta.TotalPages`. L'ancien modèle
 * par curseur (`/transactions/sync`, delta Added/Modified/Removed) est une
 * extension future NON déployée (cf. OMNIFI_API_FEEDBACK.md §10) ; on ne s'y fige
 * pas. Pas de delta incrémental : l'`upsert` idempotent (clé `omnifi_account_id`
 * UNIQUE) absorbe les doublons d'un re-téléchargement complet.
 *
 * Gardes conservées :
 * - `bornerPageSize` : `pageSize` borné [1, PAGE_SIZE_MAX] avant tout appel réseau.
 * - `MAX_PAGES` : filet anti-boucle-infinie si l'amont ment sur `Links.Next` /
 *   `Meta.TotalPages` (jamais de boucle non bornée).
 */
import type { OmniFiClient, OmniFiTransaction } from "@/server/omnifi";
import type { ExecuterWorkspace } from "@/server/db/tenancy";

import {
  deriverDateComptableMaurice,
  normaliserMontant,
  validerCreditDebit,
} from "./conversion";
import {
  marquerSynchronise,
  upsertTransactions,
  type TransactionAUpserter,
} from "@/server/repositories/ingestion";

/** Borne dure du `pageSize` (défaut amont = 20 ; on plafonne pour ne pas demander
 *  des pages déraisonnables). */
export const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAUT = 100;

/** Plafond de sécurité d'itérations — filet si l'amont ment sur Links.Next/TotalPages. */
export const MAX_PAGES = 1000;

export class IngestionBoucleError extends Error {
  readonly code = "INGESTION_BOUCLE";
  constructor(message: string) {
    super(message);
    this.name = "IngestionBoucleError";
  }
}

/** Borne le pageSize dans [1, PAGE_SIZE_MAX]. */
export function bornerPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return PAGE_SIZE_DEFAUT;
  if (!Number.isInteger(pageSize) || pageSize < 1) return 1;
  return Math.min(pageSize, PAGE_SIZE_MAX);
}

/** Mappe une transaction OBIE → ligne à persister (conversions règle 8 / E20). */
export function versLignePersistee(t: OmniFiTransaction): TransactionAUpserter {
  return {
    omnifiTxnId: t.TransactionId,
    transactionDate: deriverDateComptableMaurice(t.BookingDateTime),
    bookingDateTime: new Date(t.BookingDateTime),
    amount: normaliserMontant(t.Amount.Amount),
    currency: t.Amount.Currency,
    creditDebit: validerCreditDebit(t.CreditDebitIndicator),
    bankLabelRaw: t.Description,
    cleanLabel: t.CleanMerchantName ?? null,
    primaryCategory: t.PrimaryCategory ?? null,
    subCategory: t.SubCategory ?? null,
    isRemoved: false,
  };
}

export interface ResultatSync {
  pages: number;
  transactionsTraitees: number;
}

/**
 * Synchronise les transactions d'UN compte par PAGE, jusqu'à épuisement. Chaque
 * page : appel client → conversion → upsert dans une transaction withWorkspace.
 * On relit toujours depuis la page 1 (pas de delta côté API) ; `lastSyncedAt` est
 * marqué en fin de parcours.
 */
export async function synchroniserCompte(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: {
    omnifiAccountId: string;
    bankAccountId: string;
    clientUserId: string;
    pageSize?: number;
    maintenant?: () => Date;
  },
): Promise<ResultatSync> {
  const pageSize = bornerPageSize(params.pageSize);
  const maintenant = params.maintenant ?? (() => new Date());
  let page = 1;
  let total = 0;

  for (;;) {
    const env = await client.listerTransactionsPage(
      params.omnifiAccountId,
      params.clientUserId,
      { page, pageSize },
    );

    const lignes = env.Data.Transaction.map(versLignePersistee);
    if (lignes.length > 0) {
      await executer((tx, ctx) =>
        upsertTransactions(tx, ctx, params.bankAccountId, lignes),
      );
    }
    total += lignes.length;

    const totalPages = env.Meta?.TotalPages ?? 1;
    // Fin : plus de lien suivant OU on a atteint la dernière page annoncée.
    if (!env.Links?.Next || page >= totalPages) break;

    // Filet anti-boucle-infinie : l'amont prétend qu'il reste des pages au-delà du
    // plafond → on s'arrête plutôt que d'itérer sans borne (Links.Next peut mentir).
    if (page >= MAX_PAGES) {
      throw new IngestionBoucleError(
        `MAX_PAGES (${MAX_PAGES}) atteint — arrêt de sécurité (pagination amont incohérente)`,
      );
    }
    page += 1;
  }

  // Trace de dernière synchro (sans curseur : le modèle par page repart de 1).
  await executer((tx) =>
    marquerSynchronise(tx, params.bankAccountId, maintenant()),
  );

  return { pages: page, transactionsTraitees: total };
}
