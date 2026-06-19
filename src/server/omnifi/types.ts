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

/* --- Transactions paginées par PAGE (GET /accounts/{id}/transactions) ---
 * Contrat réel déployé (aligné OBIE — confirmé Omni-FI 2026-06-19) : liste plate
 * `Data.Transaction[]` + pagination via l'enveloppe `Links.Next` / `Meta.TotalPages`.
 * (L'ancien `/transactions/sync` par curseur — Added/Modified/Removed/NextCursor —
 * est une extension future NON déployée ; cf. OMNIFI_API_FEEDBACK.md §10.) */

export interface OmniFiTransactionsData {
  Transaction: OmniFiTransaction[];
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

/* ================================================================== */
/* Flux Link Widget (PR-W1) — docs § Link Widget / Sync Engine        */
/* ================================================================== */

/* --- POST /connections/link-token (ApiKey) --- */

export interface CreerLinkTokenParams {
  /** Notre id interne d'EndUser (= workspaces.omnifi_client_user_id). Requis. */
  ClientUserId: string;
  /** Origine HTTPS (scheme+host, sans path) autorisée à recevoir le PublicToken. Requis. */
  RedirectOrigin: string;
  InstitutionId?: string;
  /** accounts|insights|alerts|data — un tableau VIDE déclenche 400 (ne pas passer []). */
  RequestedScopes?: Array<"accounts" | "insights" | "alerts" | "data">;
  AppName?: string;
  AppLogoUrl?: string;
  AccountSelectionEnabled?: boolean;
  WebhookUrl?: string;
}

export interface OmniFiLinkTokenData {
  LinkToken: string;
  Expiration: string;
}

/* --- POST /widget/session/exchange (LinkToken) --- */

export interface OmniFiSessionTokenData {
  SessionToken: string;
  ExpiresAt: string;
  ExpiresIn: number;
  AccountSelectionEnabled: boolean;
}

/* --- GET /connections/link-token/context (SessionToken) --- */

export interface OmniFiLinkTokenContext {
  ClientName?: string;
  Environment?: string;
  Mode?: string;
  AccountSelectionEnabled?: boolean;
  LockedInstitutionId?: string | null;
  AppLogoUrl?: string | null;
  RequestedScopes?: string[];
  ResumeStep?: string | null;
  ConnectionId?: string | null;
}

/* --- POST /connections/link-connect (SessionToken) --- */

/** oneOf : email / username / corporateId — le mot de passe bancaire est PII. */
export type BankCredentials =
  | { Email: string; Password: string }
  | { Username: string; Password: string }
  | { CorporateId: string; Password: string };

export interface OmniFiConnectData {
  PublicToken: string;
  JobId: string;
  ConnectionId: string | null;
  CustomerType: "personal" | "business";
}

/* --- POST /connections/link-exchange (ApiKey) --- */

export interface OmniFiPublicTokenExchangeData {
  ConnectionId: string;
  InstitutionId: string;
  CustomerType: "personal" | "business";
}

/* --- GET /sync/job/{JobId} (ApiKey | SessionToken) — machine d'états MFA --- */

export type OmniFiSyncStatus =
  | "PENDING"
  | "STARTED"
  | "LOGGING_IN"
  | "OTP_REQUESTED"
  | "OTP_WAITING"
  | "RETRIEVING"
  | "PARSING"
  | "ENRICHING"
  | "COMPLETED"
  | "FAILED";

export interface OmniFiMfaDeliveryTarget {
  Kind: "email" | "phone";
  Target: string; // masqué
}

export interface OmniFiSyncJob {
  JobId: string;
  InstitutionId: string;
  Status: OmniFiSyncStatus;
  Source?: "SCRAPE" | "DOCUMENT_UPLOAD";
  IsManual?: boolean;
  Attempts?: number;
  StartedAt?: string;
  FinishedAt?: string | null;
  NextSyncAvailableAt?: string | null;
  Error?: { Type: string; Message: string; Payload?: unknown } | null;
  MfaType?: "sms" | "email" | "totp" | null;
  MfaLength?: number | null;
  MfaCharset?: "numeric" | "alphanumeric" | null;
  DeliveryTargets?: OmniFiMfaDeliveryTarget[] | null;
  MfaResendCooldownSeconds?: number | null;
  MfaResendRequestedAt?: string | null;
  MfaResendCount?: number;
  UserInput?: string | null;
  PersistenceStats?: {
    TransactionsCreated: number;
    TransactionsUpdated: number;
    TransactionsDuplicated: number;
    AccountsUpdated: number;
  } | null;
}

/* --- POST /sync/{JobId}/input (ApiKey | SessionToken) --- */

export interface OmniFiMfaInputData {
  Status: string; // "OTP_ACCEPTED"
  JobId: string;
}

/* --- POST /sync/{JobId}/resend (ApiKey | SessionToken) --- */

export interface OmniFiMfaResendData {
  JobId: string;
  MfaResendRequestedAt: string;
  MfaResendCount: number;
}

/* --- GET /sync/job/{JobId}/accounts (SessionToken) — découverte de comptes --- */

export interface OmniFiBalance {
  Type: string;
  Amount: OmniFiAmount;
  DateTime?: string;
  CreditDebitIndicator?: OmniFiCreditDebit;
}

export interface OmniFiAccount {
  AccountId: string;
  Status: "Enabled" | "Disabled" | "Deleted" | "Pending" | "ProForma";
  Currency: string;
  AccountCategory?: "Personal" | "Business";
  AccountTypeCode?: string;
  Balances?: OmniFiBalance[];
  PartyId?: string | null;
  PartyName?: string | null;
  InstitutionId?: string | null;
  OwnershipType?: string;
  IsAsset?: boolean | null;
  /** Présent sur GET /accounts (préférence d'affichage). */
  Nickname?: string | null;
}

export interface OmniFiSyncJobAccountsData {
  Account: OmniFiAccount[];
}

/* --- GET /accounts?connectionId= (ApiKey) — listing serveur des comptes --- */
/* Utilisé par le flux drop-in : après link-exchange (ApiKey), on découvre les   */
/* comptes d'une connexion SANS SessionToken widget (OBReadAccount6 envelope).   */
export interface OmniFiAccountsData {
  Account: OmniFiAccount[];
}
