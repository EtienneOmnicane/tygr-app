/**
 * Point d'entrée du client Omni-FI (PR 1). Les consommateurs (ingestion PR 2,
 * routes) importent depuis "@/server/omnifi" — jamais les modules internes.
 */
export { creerClientOmniFi, OmniFiClient, TIMEOUT_DEFAUT_MS } from "./client";
export type { DepsClient } from "./client";
export {
  authApiKey,
  authBearer,
  authLinkToken,
  type StrategieAuth,
} from "./auth";
export { obtenirConfigOmniFi, type OmniFiConfig } from "./config";
export {
  OmniFiApiError,
  OmniFiConfigError,
  OmniFiError,
  OmniFiInvalidResponseError,
  OmniFiNetworkError,
  OmniFiTimeoutError,
  type OmniFiErreurDetail,
} from "./erreurs";
export type {
  OmniFiAmount,
  OmniFiBalanceHistoryData,
  OmniFiConnection,
  OmniFiConnectionsData,
  OmniFiHistoricalBalance,
  OmniFiTransaction,
  OmniFiTransactionsSummaryData,
  OmniFiTransactionsSyncData,
  // Flux Link Widget (PR-W1)
  CreerLinkTokenParams,
  BankCredentials,
  OmniFiLinkTokenData,
  OmniFiSessionTokenData,
  OmniFiLinkTokenContext,
  OmniFiConnectData,
  OmniFiPublicTokenExchangeData,
  OmniFiSyncJob,
  OmniFiSyncStatus,
  OmniFiMfaInputData,
  OmniFiMfaResendData,
  OmniFiSyncJobAccountsData,
  OmniFiAccount,
  OmniFiBalance,
} from "./types";
