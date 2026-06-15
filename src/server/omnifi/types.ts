/**
 * Types Omni-FI (OBIE v4.0.1, PascalCase JSON) — décalqués EXCLUSIVEMENT de
 * docs/documentation_api.md. Si la doc bouge, ce fichier suit, jamais l'inverse.
 * Sous-ensemble couvert par la PR 1 (lecture) : enveloppe, erreurs, connexions,
 * historique de soldes, sync de transactions, résumé. Le reste (widget, debt,
 * insights, webhooks) viendra avec les PRs qui en ont besoin.
 *
 * Règle 8 : tout montant est une CHAÎNE décimale OBIE ("1500.00"), jamais un
 * number — le parsing en centimes entiers se fait côté ingestion (PR 2).
 */

/* --- Enveloppe commune (docs § Pagination / Format des erreurs) --- */

export interface OmniFiLinks {
  Self?: string;
  Next?: string;
  Prev?: string;
}

export interface OmniFiMeta {
  TotalPages?: number;
  TotalRecords?: number;
}

/** Enveloppe de succès OBIE : { Data, Links?, Meta? }. */
export interface OmniFiEnveloppe<TData> {
  Data: TData;
  Links?: OmniFiLinks;
  Meta?: OmniFiMeta;
}

/** Enveloppe d'erreur OBIE (docs § Format des erreurs). */
export interface OmniFiEnveloppeErreur {
  Code: string;
  Message: string;
  Errors?: Array<{
    ErrorCode: string;
    Message: string;
    Path?: string;
  }>;
}

/* --- Montant OBIE (docs, partout) --- */

export interface OmniFiAmount {
  /** Chaîne décimale toujours positive, ex. "1500.00". */
  Amount: string;
  Currency: string;
}

/* --- Connections (docs § Connections → GET /connections) --- */

export interface OmniFiConnection {
  ConnectionId: string;
  InstitutionId: string;
  InstitutionName: string;
  CustomerType: string;
  Status: string;
  CreatedAt: string;
  NextSyncAvailableAt?: string | null;
}

export interface OmniFiConnectionsData {
  Connections: OmniFiConnection[];
}

/* --- Balances history (docs § GET /accounts/{id}/balances/history) --- */

export interface OmniFiHistoricalBalance {
  Date: string;
  Balance: {
    Amount: OmniFiAmount;
    Type?: string;
  };
}

export interface OmniFiBalanceHistoryData {
  HistoricalBalances: OmniFiHistoricalBalance[];
}

/* --- Transaction OBIE (docs § GET /transactions/{id} — objet complet) --- */

export type OmniFiCreditDebit = "Credit" | "Debit";

export interface OmniFiTransaction {
  TransactionId: string;
  AccountId: string;
  PartyId?: string;
  TransactionReference?: string;
  Description: string;
  NormalizedDescription?: string;
  Amount: OmniFiAmount;
  CreditDebitIndicator: OmniFiCreditDebit;
  Status: string;
  BookingDateTime: string;
  ValueDateTime?: string;
  PrimaryCategory?: string;
  SubCategory?: string;
  CleanMerchantName?: string;
  IsDuplicate?: boolean;
  ManuallyOverridden?: boolean;
  IsActive?: boolean;
}

/* --- Transactions sync par curseur (docs § GET /accounts/{id}/transactions/sync) --- */

export interface OmniFiTransactionsSyncData {
  Added: OmniFiTransaction[];
  Modified: OmniFiTransaction[];
  Removed: Array<{ TransactionId: string }>;
  NextCursor: string;
  HasMore: boolean;
}

/* --- Résumé agrégé (docs § GET /accounts/{id}/transactions/summary) --- */

export interface OmniFiTransactionsSummaryData {
  Summary: {
    TotalCredits: string;
    TotalDebits: string;
    NetAmount: string;
    TransactionCount: number;
  };
}
