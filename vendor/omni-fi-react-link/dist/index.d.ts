declare const OMNIFI_EVENTS: {
    readonly SUCCESS: "omni-fi:success";
    readonly ERROR: "omni-fi:error";
    readonly EXIT: "omni-fi:exit";
    readonly READY: "omni-fi:ready";
    readonly SET_THEME: "omni-fi:set-theme";
    readonly SET_LANGUAGE: "omni-fi:set-language";
    readonly CONNECTION_LINKED: "omni-fi:connection-linked";
};
type OmniFIEventType = (typeof OMNIFI_EVENTS)[keyof typeof OMNIFI_EVENTS];
type OmniFITheme = "light" | "dark" | "system";
type OmniFILanguage = "en-GB" | "fr";
/**
 * Deployment environment the SDK should target. Switches the CDN URL the
 * loader script is fetched from, so host integrations don't have to
 * hardcode the staging URL.
 *
 * - `"production"` (default) — `cdn.omni-fi.co/v1/omni-fi-connect.js`
 * - `"staging"` — `staging-cdn.omni-fi.co/v1/omni-fi-connect.js`
 * - `"development"` — `http://localhost:5173/omni-fi-connect.js` (expects a
 *   local Vite dev server serving the widget bundle)
 *
 * For advanced version-pinning (e.g. `/v2/`) or self-hosting, the
 * `scriptUrl` override on {@link OmniFIConfig} takes precedence.
 */
type OmniFIEnv = "development" | "staging" | "production";
type OmniFIErrorCode = "LINK_TOKEN_INVALID" | "LINK_TOKEN_EXPIRED" | "LINK_TOKEN_USED" | "SESSION_TOKEN_INVALID" | "SESSION_TOKEN_REVOKED" | "SESSION_TOKEN_EXPIRED" | "SESSION_TOKEN_IDLE_EXPIRED" | "PUBLIC_TOKEN_INVALID" | "PUBLIC_TOKEN_USED" | "PUBLIC_TOKEN_EXPIRED" | "PUBLIC_TOKEN_CLIENT_MISMATCH" | "INSTITUTION_LOCKED" | "INSTITUTION_NOT_FOUND" | "INSTITUTION_REQUIRED" | "INSTITUTION_SANDBOX_ONLY" | "SANDBOX_CREDENTIALS_REQUIRED" | "ORIGIN_NOT_ALLOWED" | "VALIDATION_ERROR";
interface OmniFIError {
    code: OmniFIErrorCode;
    message: string;
}
interface OmniFIConnection {
    publicToken: string;
    /**
     * UUID of the persisted Connection record on the Omni-FI backend.
     *
     * Use this to call connection-scoped endpoints
     * (`PUT /connections/{id}/accounts`, `GET /connections/{id}/accounts`,
     * `DELETE /connections/{id}`) without needing to exchange the
     * `publicToken` first.
     *
     * Surfaced on every connection record — both the per-bank
     * `omni-fi:connection-linked` event and the final `onSuccess` payload —
     * so a host backend that loses the user mid-flow (e.g. browser closed
     * after link-connect but before Account-Select Continue) can still
     * address the persisted connection.
     */
    connectionId: string;
    institutionId: string;
    /**
     * Optional — the widget can emit the `connection-linked` event before
     * `customerType` is resolved. Matches `OmniFILinkedConnection.customerType`
     * in `omni-fi-link/packages/shared`.
     */
    customerType?: "personal" | "business";
    /**
     * Account IDs the end-user explicitly permitted the client to access.
     * Present for B2C flows where the user selects accounts in the widget.
     * Undefined for B2B flows where all accounts are auto-confirmed.
     */
    permittedAccountIds?: string[];
}
interface OmniFISuccessPayload {
    connections: OmniFIConnection[];
}
type OmniFIConnectionLinkedPayload = OmniFIConnection;
/**
 * Canonical lowercase MFA challenge types returned by the connect/sync engine.
 * Mirrors `OmniFIMfaType` in `omni-fi-link/packages/shared`.
 *
 * The hosted widget handles the MFA challenge internally today and does **not**
 * surface a typed `mfa-challenge` event to SDK consumers. This union is
 * re-exported for forward compatibility and for consumers that read the
 * institution-level field directly from the API.
 *
 * @beta This union is in beta and may gain additional variants in future releases.
 */
type OmniFIMfaType = "sms" | "email" | "totp" | "none";
interface OmniFIConfig {
    token: string;
    containerId?: string;
    displayMode?: "iframe" | "popup";
    theme?: OmniFITheme;
    language?: OmniFILanguage;
    /**
     * Deployment environment the SDK should target. Single source of truth
     * for env signalling — drives both the CDN URL the loader script is
     * fetched from AND the `environment` value the widget iframe runtime
     * receives via `window.OmniFI.connect()`. Defaults to `"production"`.
     *
     * Use this in preference to `scriptUrl` — host integrations targeting
     * staging only need to set `env: "staging"` rather than hardcoding the URL.
     *
     * **Locked at mount.** The loader script URL is resolved once on first
     * mount; subsequent rerenders that change `env` are ignored (with a
     * `console.warn` in development builds). Mount the hook on a new key if
     * you need to switch environments at runtime — this guarantees the
     * loaded script and the iframe runtime env can't disagree.
     *
     * **Precedence with `scriptUrl`.** When both are set, `scriptUrl` wins
     * for the loader script URL only. `env` still drives the iframe's
     * `environment` runtime signal — see the `scriptUrl` docs.
     */
    env?: OmniFIEnv;
    /**
     * Override the CDN URL for the Omni-FI Connect script.
     * Advanced usage: for pinning to a specific hosted version (e.g.
     * `/v2/omni-fi-connect.js` once v2 ships) or for self-hosting under
     * exceptional circumstances. Prefer the `env` field for normal
     * production / staging / development switching.
     *
     * **URL-only precedence.** When both `env` and `scriptUrl` are set,
     * `scriptUrl` wins for the **loader script URL only** — the
     * `environment` value passed to `window.OmniFI.connect()` is still
     * derived from `env` and defaults to `"production"`. A consumer who
     * sets a custom staging / development `scriptUrl` MUST also set the
     * matching `env`; otherwise the loaded script and the widget iframe
     * origin can diverge (e.g. staging script loaded but the iframe still
     * runs in production mode).
     *
     * **Widget / SDK version coupling.** This SDK's TypeScript types describe
     * the contract emitted by the **current** widget release. Pinning
     * `scriptUrl` to an older widget version may cause runtime payloads to
     * omit fields the types declare as required. Pin the SDK to a matching
     * version when pinning the widget — or stay on `latest` for both.
     */
    scriptUrl?: string;
    onSuccess: (payload: OmniFISuccessPayload) => void;
    onError?: (error: OmniFIError) => void;
    onExit?: () => void;
    onEvent?: (eventName: OmniFIEventType | (string & {}), metadata?: Record<string, unknown>) => void;
}
interface OmniFIInstance {
    destroy: () => void;
    setTheme: (theme: OmniFITheme) => void;
    setLanguage: (lang: OmniFILanguage) => void;
}
/**
 * Shape of the config payload the widget loader
 * (`omni-fi-link/packages/link-loader`) actually consumes. The loader reads
 * `environment` (values: `"local" | "staging" | "production"`) to pick its
 * iframe origin. `useOmniFILink` derives this from the SDK's public `env`
 * field via `getLoaderEnvironment` and passes the augmented object to
 * `window.OmniFI.connect()`.
 *
 * Module-local — not part of the SDK's public consumer-facing surface.
 */
interface WidgetLoaderConfig extends OmniFIConfig {
    environment: "local" | "staging" | "production";
}
declare global {
    interface Window {
        OmniFI?: {
            connect: (options: WidgetLoaderConfig) => OmniFIInstance;
        };
    }
}

interface UseOmniFILinkResult {
    /**
     * Opens the OmniFI Link widget.
     *
     * Wait for `isReady` to be `true` before calling this — `isReady` signals
     * that the loader script has finished loading and executing and that
     * `window.OmniFI` is available.
     *
     * @throws {Error} If called before `isReady` is `true` (i.e. `window.OmniFI`
     * is not yet set). Thrown rather than reflected in the `error` state because
     * this is a programming error, not a runtime failure.
     */
    open: () => void;
    destroy: () => void;
    isReady: boolean;
    error: Error | null;
    setTheme: (theme: OmniFITheme) => void;
    setLanguage: (lang: OmniFILanguage) => void;
}
declare function useOmniFILink(config: OmniFIConfig): UseOmniFILinkResult;

/**
 * Map an {@link OmniFIEnv} value to the CDN URL the SDK should fetch the
 * loader script from. Pure function — no side effects, no caching.
 *
 * The hosted environments use a `/v1/` versioning prefix so a future v2 can
 * ship at `/v2/omni-fi-connect.js` without breaking integrations pinned to
 * v1. The development URL targets a local Vite dev server on port 5173.
 *
 * Consumers normally don't need to call this directly — `useOmniFILink`
 * resolves the URL internally from `OmniFIConfig.env`. It's exported for
 * debugging and for tests that need to assert on the URL shape.
 */
declare const getScriptUrl: (env?: OmniFIEnv) => string;

export { OMNIFI_EVENTS, type OmniFIConfig, type OmniFIConnection, type OmniFIConnectionLinkedPayload, type OmniFIEnv, type OmniFIError, type OmniFIErrorCode, type OmniFIEventType, type OmniFIInstance, type OmniFILanguage, type OmniFIMfaType, type OmniFISuccessPayload, type OmniFITheme, getScriptUrl, useOmniFILink };
