/**
 * Point d'entrée du client Omni-FI (PR 1). Les consommateurs (ingestion PR 2,
 * routes) importent depuis "@/server/omnifi" — jamais les modules internes.
 */
export { creerClientOmniFi, OmniFiClient, TIMEOUT_DEFAUT_MS } from "./client";
export type { DepsClient } from "./client";
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
} from "./types";
