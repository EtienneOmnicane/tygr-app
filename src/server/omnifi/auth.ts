/**
 * Stratégies d'authentification Omni-FI (PR-W1). Le flux Link Widget exige
 * QUATRE schémas, choisis PAR endpoint (docs § Authentification, CLAUDE.md
 * « Omni-FI auth multi-schéma ») — le client ne peut donc plus figer un seul
 * en-tête `Authorization`.
 *
 * Une stratégie = une fonction pure qui produit la valeur d'en-tête `Authorization`
 * pour une requête. Aucune ne logge ni n'expose le secret/token (règle 8) : la
 * valeur n'est lue qu'au moment de poser l'en-tête, jamais stockée ailleurs.
 */
import type { OmniFiConfig } from "./config";

/** Produit la valeur de l'en-tête Authorization, ou null si l'endpoint n'en exige pas. */
export type StrategieAuth = (config: OmniFiConfig) => string | null;

/**
 * ApiKeyAuth — appels SERVEUR (link-token, link-exchange, lecture/sync B2B).
 * « Authorization: ApiKey <client_id>:<secret> ».
 */
export function authApiKey(): StrategieAuth {
  return (config) => `ApiKey ${config.clientId}:${config.secret}`;
}

/**
 * SessionTokenAuth — appels WIDGET après l'échange (connect, polling, input,
 * resend, accounts, context, revoke). « Authorization: Bearer <SessionToken> ».
 * Le token est court (30 min / 10 min idle) et fourni par appel — jamais en config.
 */
export function authBearer(sessionToken: string): StrategieAuth {
  return () => `Bearer ${sessionToken}`;
}

/**
 * LinkTokenAuth — UNIQUEMENT pour widget/session/exchange. Le LinkToken
 * (usage unique) est porté en `Authorization: LinkToken <link_token>`.
 */
export function authLinkToken(linkToken: string): StrategieAuth {
  return () => `LinkToken ${linkToken}`;
}
