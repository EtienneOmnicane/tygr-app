/**
 * Client serveur Omni-FI Core API (OBIE v4.0.1) — couche d'accès réseau pure,
 * SANS état d'UI ni accès DB. Surface : lecture B2B (connexions, soldes, sync,
 * résumé) + flux Link Widget (PR-W1 : link-token, session, connect, polling,
 * MFA input/resend, accounts, exchange).
 *
 * Conformité docs/documentation_api.md & CLAUDE.md « Omni-FI auth multi-schéma » :
 * - QUATRE schémas d'auth choisis PAR endpoint via une StrategieAuth (auth.ts) :
 *   ApiKey (serveur), LinkToken (session/exchange), Bearer/SessionToken (widget).
 * - Enveloppe { Data, Links, Meta } décodée ; erreurs { Id, Code, Message,
 *   Errors[] } mappées vers des erreurs nommées (erreurs.ts, règle 3).
 * - 429 → Retry-After remonté ; appels B2B porteurs de clientUserId.
 * - x-fapi-interaction-id de corrélation sur chaque requête.
 *
 * Règle 8 : NI le secret ApiKey NI les tokens (LinkToken/SessionToken) NI les
 * identifiants bancaires de l'EndUser ne sont jamais loggés ni mis en message
 * d'erreur / cause brute. Aucun montant converti ici (chaînes OBIE telles quelles).
 *
 * `fetch` est injectable (DepsClient) pour des tests sans réseau réel.
 */
import {
  authApiKey,
  authBearer,
  authLinkToken,
  type StrategieAuth,
} from "./auth";
import { obtenirConfigOmniFi, type OmniFiConfig } from "./config";
import {
  OmniFiApiError,
  OmniFiInvalidResponseError,
  OmniFiNetworkError,
  OmniFiTimeoutError,
  type CauseReseauResumee,
  type OmniFiErreurDetail,
} from "./erreurs";
import type {
  CreerLinkTokenParams,
  OmniFiBalanceHistoryData,
  OmniFiConnectionsData,
  OmniFiConnectData,
  OmniFiEnveloppe,
  OmniFiEnveloppeErreur,
  OmniFiLinkTokenContext,
  OmniFiLinkTokenData,
  OmniFiPublicTokenExchangeData,
  OmniFiSessionTokenData,
  OmniFiSyncJob,
  OmniFiSyncJobAccountsData,
  OmniFiAccountsData,
  OmniFiTransactionsSummaryData,
  OmniFiTransactionsSyncData,
  OmniFiMfaResendData,
  OmniFiMfaInputData,
  BankCredentials,
} from "./types";

/** Timeout par défaut d'une requête (le scraping amont peut être lent, mais une
 *  requête de LECTURE ne doit pas pendre indéfiniment). */
export const TIMEOUT_DEFAUT_MS = 15_000;

export interface DepsClient {
  /** Injectable pour les tests. Par défaut : le fetch global de la plateforme. */
  fetch?: typeof fetch;
  /** Source d'UUID de corrélation — injectable pour des tests déterministes. */
  genererInteractionId?: () => string;
  config?: OmniFiConfig;
  timeoutMs?: number;
}

interface OptionsRequete {
  /** Query params ; les valeurs nullish sont omises. */
  query?: Record<string, string | number | undefined>;
  /** Méthode HTTP (défaut GET). */
  method?: "GET" | "POST";
  /** Stratégie d'auth de CET appel (défaut : ApiKey serveur). */
  auth?: StrategieAuth;
  /** Corps JSON pour les POST. */
  body?: unknown;
}

function construireUrl(
  base: string,
  chemin: string,
  query?: OptionsRequete["query"],
): string {
  const url = new URL(`${base}${chemin}`);
  if (query) {
    for (const [cle, valeur] of Object.entries(query)) {
      if (valeur !== undefined) url.searchParams.set(cle, String(valeur));
    }
  }
  return url.toString();
}

/**
 * Parse l'en-tête Retry-After (Q5). RFC 7231 autorise DEUX formes — la doc
 * Omni-FI ne spécifie pas laquelle, donc on gère les deux :
 *  - delta-seconds : entier ("12")
 *  - HTTP-date : "Wed, 21 Oct 2025 07:28:00 GMT" → secondes restantes (>= 0)
 * Retourne null si illisible ou date passée.
 */
function parseRetryAfter(valeur: string | null, maintenant: number): number | null {
  if (!valeur) return null;
  const trim = valeur.trim();
  if (/^\d+$/.test(trim)) {
    const secondes = Number.parseInt(trim, 10);
    return Number.isFinite(secondes) && secondes >= 0 ? secondes : null;
  }
  const dateMs = Date.parse(trim);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, Math.round((dateMs - maintenant) / 1000));
}

/** Résumé non sensible d'une cause d'erreur réseau (S2) — voir erreurs.ts. */
function resumeCauseSure(cause: unknown): CauseReseauResumee | undefined {
  if (cause == null || typeof cause !== "object") return undefined;
  const c = cause as { name?: unknown; code?: unknown };
  return {
    name: typeof c.name === "string" ? c.name : undefined,
    code: typeof c.code === "string" ? c.code : undefined,
  };
}

function extraireDetails(
  erreur: OmniFiEnveloppeErreur | null,
): { obieCode: string | null; details: OmniFiErreurDetail[] } {
  if (!erreur) return { obieCode: null, details: [] };
  const details = (erreur.Errors ?? []).map((e) => ({
    errorCode: e.ErrorCode,
    path: e.Path,
  }));
  return { obieCode: erreur.Code ?? null, details };
}

export class OmniFiClient {
  private readonly fetch: typeof fetch;
  private readonly genererInteractionId: () => string;
  private readonly config: OmniFiConfig;
  private readonly timeoutMs: number;

  constructor(deps: DepsClient = {}) {
    // On lie le fetch global à globalThis : un fetch détaché perd son contexte.
    this.fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.genererInteractionId =
      deps.genererInteractionId ?? (() => crypto.randomUUID());
    this.config = deps.config ?? obtenirConfigOmniFi();
    this.timeoutMs = deps.timeoutMs ?? TIMEOUT_DEFAUT_MS;
  }

  /**
   * Construit les en-têtes d'une requête selon la stratégie d'auth choisie.
   * La valeur Authorization n'est produite qu'ici, au moment de l'envoi, et
   * n'est jamais conservée ni loggée (règle 8).
   */
  private enTetes(auth: StrategieAuth, avecBody: boolean): HeadersInit {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-fapi-interaction-id": this.genererInteractionId(),
    };
    const valeur = auth(this.config);
    if (valeur !== null) headers.Authorization = valeur;
    if (avecBody) headers["Content-Type"] = "application/json";
    return headers;
  }

  /**
   * Moteur HTTP générique : méthode + stratégie d'auth + body, retourne
   * l'enveloppe OBIE complète ({ Data, Links, Meta }). Q2 : Links/Meta conservés
   * pour la pagination. Lève une erreur nommée sur tout échec — jamais de retour
   * null silencieux (règle 3).
   */
  private async requete<TData>(
    chemin: string,
    options: OptionsRequete = {},
  ): Promise<OmniFiEnveloppe<TData>> {
    const url = construireUrl(this.config.baseUrl, chemin, options.query);
    const method = options.method ?? "GET";
    const auth = options.auth ?? authApiKey();
    const aBody = options.body !== undefined;
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.timeoutMs);

    let reponse: Response;
    try {
      reponse = await this.fetch(url, {
        method,
        headers: this.enTetes(auth, aBody),
        body: aBody ? JSON.stringify(options.body) : undefined,
        signal: controleur.signal,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new OmniFiTimeoutError(this.timeoutMs);
      }
      // Réseau/DNS/TLS : on n'inclut jamais l'URL complète (peut porter des ids).
      // S2 : on n'attache PAS l'objet `cause` brut (un fetch injecté pourrait y
      // accrocher la requête, donc l'en-tête Authorization). On ne garde qu'un
      // résumé sûr (name/code) — jamais de quoi reconstituer le secret.
      throw new OmniFiNetworkError(
        "Appel Omni-FI en échec réseau",
        resumeCauseSure(cause),
      );
    } finally {
      clearTimeout(minuteur);
    }

    if (!reponse.ok) {
      const enveloppeErreur = await this.lireEnveloppeErreur(reponse);
      const { obieCode, details } = extraireDetails(enveloppeErreur);
      const retryAfter =
        reponse.status === 429
          ? parseRetryAfter(reponse.headers.get("Retry-After"), Date.now())
          : null;
      throw new OmniFiApiError(reponse.status, obieCode, details, retryAfter);
    }

    let enveloppe: OmniFiEnveloppe<TData>;
    try {
      enveloppe = (await reponse.json()) as OmniFiEnveloppe<TData>;
    } catch {
      throw new OmniFiInvalidResponseError("corps JSON illisible");
    }
    // Q1 : `Data: null` doit échouer bruyamment (règle 3), pas être renvoyé tel
    // quel — sinon l'appelant fait `data.X` sur null → TypeError anonyme.
    if (
      enveloppe == null ||
      typeof enveloppe !== "object" ||
      enveloppe.Data == null
    ) {
      throw new OmniFiInvalidResponseError("enveloppe { Data } absente ou nulle");
    }
    return enveloppe;
  }

  /** Décode l'enveloppe d'erreur OBIE si présente (best-effort, jamais throw). */
  private async lireEnveloppeErreur(
    reponse: Response,
  ): Promise<OmniFiEnveloppeErreur | null> {
    try {
      const corps = (await reponse.json()) as OmniFiEnveloppeErreur;
      return corps && typeof corps === "object" ? corps : null;
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Endpoints de lecture (docs § Connections / Transactions)         */
  /* ---------------------------------------------------------------- */

  /**
   * GET /connections — connexions bancaires actives d'un EndUser.
   * `clientUserId` est requis pour les appels B2B (docs § Architecture multi-tenant).
   * Q2 : renvoie l'enveloppe complète (Links/Meta) — endpoint paginé par
   * page/pageSize ; l'appelant DOIT regarder Links.Next / Meta.TotalPages pour
   * ne pas tronquer au-delà de la 1re page (pageSize défaut = 20).
   */
  listerConnexions(
    clientUserId: string,
    pagination: { page?: number; pageSize?: number } = {},
  ): Promise<OmniFiEnveloppe<OmniFiConnectionsData>> {
    return this.requete<OmniFiConnectionsData>("/connections", {
      query: { clientUserId, page: pagination.page, pageSize: pagination.pageSize },
    });
  }

  /**
   * GET /accounts/{AccountId}/balances/history — soldes end-of-day (série temporelle).
   * Bornes ISO 8601 (docs : fromStatementDateTime / toStatementDateTime).
   * Q2 : enveloppe complète (endpoint paginé) — voir listerConnexions.
   */
  historiqueSoldes(
    accountId: string,
    bornes: {
      fromStatementDateTime?: string;
      toStatementDateTime?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<OmniFiEnveloppe<OmniFiBalanceHistoryData>> {
    return this.requete<OmniFiBalanceHistoryData>(
      `/accounts/${encodeURIComponent(accountId)}/balances/history`,
      { query: { ...bornes } },
    );
  }

  /**
   * GET /accounts/{AccountId}/transactions/sync — sync incrémental par curseur.
   * Omettre `cursor` pour l'historique complet ; relancer tant que HasMore=true
   * avec le NextCursor renvoyé (docs § Transactions). La boucle d'itération vit
   * côté ingestion (PR 2) : ce client expose une page à la fois.
   * Pagination par curseur (≠ Links/Meta) → on renvoie directement le Data.
   */
  async syncTransactions(
    accountId: string,
    clientUserId: string,
    options: { cursor?: string; count?: number } = {},
  ): Promise<OmniFiTransactionsSyncData> {
    const enveloppe = await this.requete<OmniFiTransactionsSyncData>(
      `/accounts/${encodeURIComponent(accountId)}/transactions/sync`,
      { query: { clientUserId, cursor: options.cursor, count: options.count } },
    );
    return enveloppe.Data;
  }

  /**
   * GET /accounts/{AccountId}/transactions/summary — totaux crédits/débits/net.
   */
  async resumeTransactions(
    accountId: string,
    clientUserId: string,
    bornes: { fromDate?: string; toDate?: string } = {},
  ): Promise<OmniFiTransactionsSummaryData> {
    const enveloppe = await this.requete<OmniFiTransactionsSummaryData>(
      `/accounts/${encodeURIComponent(accountId)}/transactions/summary`,
      { query: { clientUserId, ...bornes } },
    );
    return enveloppe.Data;
  }

  /* ---------------------------------------------------------------- */
  /* Flux Link Widget (PR-W1) — docs § Link Widget / Sync Engine      */
  /* ---------------------------------------------------------------- */

  /**
   * [SERVEUR/ApiKey] POST /connections/link-token — crée le LinkToken qui
   * initialise le widget. `ClientUserId` = frontière tenant ; `RedirectOrigin`
   * HTTPS obligatoire. NE PAS passer un RequestedScopes vide (400).
   */
  async creerLinkToken(
    params: CreerLinkTokenParams,
  ): Promise<OmniFiLinkTokenData> {
    const env = await this.requete<OmniFiLinkTokenData>("/connections/link-token", {
      method: "POST",
      auth: authApiKey(),
      body: params,
    });
    return env.Data;
  }

  /**
   * [LinkToken] POST /widget/session/exchange — consomme le LinkToken (usage
   * unique) et retourne le SessionToken (Bearer) des appels widget. Body vide :
   * l'identité vient du LinkToken. Rate-limit 10/IP/60s (429).
   */
  async echangerSessionToken(
    linkToken: string,
  ): Promise<OmniFiSessionTokenData> {
    const env = await this.requete<OmniFiSessionTokenData>("/widget/session/exchange", {
      method: "POST",
      auth: authLinkToken(linkToken),
      body: {},
    });
    return env.Data;
  }

  /**
   * [SessionToken] GET /connections/link-token/context — métadonnées du
   * LinkToken (nom client, banque verrouillée, mode, scopes) pour le rendu widget.
   */
  async contexteLinkToken(
    sessionToken: string,
  ): Promise<OmniFiLinkTokenContext> {
    const env = await this.requete<OmniFiLinkTokenContext>("/connections/link-token/context", {
      auth: authBearer(sessionToken),
    });
    return env.Data;
  }

  /**
   * [SessionToken] POST /connections/link-connect — soumet les identifiants
   * bancaires de l'EndUser. ⚠️ `credentials` contient un mot de passe bancaire
   * (PII) : transmis à Omni-FI, JAMAIS stocké ni loggé côté TYGR (règle 8).
   * Retourne PublicToken + JobId pour le polling.
   */
  async connecter(
    sessionToken: string,
    credentials: BankCredentials,
    institutionId?: string,
  ): Promise<OmniFiConnectData> {
    const env = await this.requete<OmniFiConnectData>("/connections/link-connect", {
      method: "POST",
      auth: authBearer(sessionToken),
      body: { Credentials: credentials, InstitutionId: institutionId },
    });
    return env.Data;
  }

  /**
   * [SessionToken] GET /sync/job/{JobId} — état du job (polling de la machine
   * MFA). Variante Bearer (widget). Pour le polling serveur (ApiKey), passer
   * clientUserId via getSyncJobServeur.
   */
  async getSyncJob(
    sessionToken: string,
    jobId: string,
  ): Promise<OmniFiSyncJob> {
    const env = await this.requete<OmniFiSyncJob>(
      `/sync/job/${encodeURIComponent(jobId)}`,
      { auth: authBearer(sessionToken) },
    );
    return env.Data;
  }

  /**
   * [ApiKey] GET /sync/job/{JobId} — variante serveur du polling (clientUserId
   * requis pour la frontière B2B).
   */
  async getSyncJobServeur(
    jobId: string,
    clientUserId: string,
  ): Promise<OmniFiSyncJob> {
    const env = await this.requete<OmniFiSyncJob>(
      `/sync/job/${encodeURIComponent(jobId)}`,
      { auth: authApiKey(), query: { clientUserId } },
    );
    return env.Data;
  }

  /**
   * [SessionToken] POST /sync/{JobId}/input — soumet l'OTP. `mfaResendRequestedAt`
   * DOIT être ré-émis verbatim après un resend (watermark strict, sinon 409
   * STALE_INPUT). 3 mauvais codes → job FAILED.
   */
  async soumettreMfa(
    sessionToken: string,
    jobId: string,
    userInput: string,
    mfaResendRequestedAt?: string | null,
  ): Promise<OmniFiMfaInputData> {
    const env = await this.requete<OmniFiMfaInputData>(
      `/sync/${encodeURIComponent(jobId)}/input`,
      {
        method: "POST",
        auth: authBearer(sessionToken),
        body: {
          UserInput: userInput,
          ...(mfaResendRequestedAt !== undefined
            ? { MfaResendRequestedAt: mfaResendRequestedAt }
            : {}),
        },
      },
    );
    return env.Data;
  }

  /**
   * [SessionToken] POST /sync/{JobId}/resend — demande un renvoi d'OTP. Cooldown
   * (429/409 MFA_RESEND_COOLDOWN_ACTIVE + RetryAfterSeconds), max 3.
   */
  async resendMfa(
    sessionToken: string,
    jobId: string,
  ): Promise<OmniFiMfaResendData> {
    const env = await this.requete<OmniFiMfaResendData>(
      `/sync/${encodeURIComponent(jobId)}/resend`,
      { method: "POST", auth: authBearer(sessionToken), body: {} },
    );
    return env.Data;
  }

  /**
   * [SessionToken] GET /sync/job/{JobId}/accounts — comptes découverts (résout
   * connexion → comptes). Utilisé pour l'écran Account Selection.
   */
  async getSyncJobAccounts(
    sessionToken: string,
    jobId: string,
  ): Promise<OmniFiSyncJobAccountsData> {
    const env = await this.requete<OmniFiSyncJobAccountsData>(
      `/sync/job/${encodeURIComponent(jobId)}/accounts`,
      { auth: authBearer(sessionToken) },
    );
    return env.Data;
  }

  /**
   * [SERVEUR/ApiKey] POST /connections/link-exchange — échange le PublicToken
   * contre un ConnectionId permanent. `clientUserId` re-transmis pour la
   * frontière tenant (mismatch → 403 PUBLIC_TOKEN_CLIENT_MISMATCH).
   */
  async echangerPublicToken(
    publicToken: string,
    clientUserId: string,
  ): Promise<OmniFiPublicTokenExchangeData> {
    const env = await this.requete<OmniFiPublicTokenExchangeData>("/connections/link-exchange", {
      method: "POST",
      auth: authApiKey(),
      body: { PublicToken: publicToken, ClientUserId: clientUserId },
    });
    return env.Data;
  }

  /**
   * [SERVEUR/ApiKey] GET /accounts?connectionId= — liste les comptes d'une
   * connexion SANS SessionToken widget. Chemin du flux drop-in (@omni-fi/react-link) :
   * le widget gère la MFA en interne et ne nous rend que le PublicToken ; après
   * link-exchange on découvre les comptes côté serveur par ce listing.
   * `clientUserId` = frontière tenant B2B.
   */
  async listerComptesConnexion(
    connectionId: string,
    clientUserId: string,
    pagination: { page?: number; pageSize?: number } = {},
  ): Promise<OmniFiEnveloppe<OmniFiAccountsData>> {
    return this.requete<OmniFiAccountsData>("/accounts", {
      auth: authApiKey(),
      query: {
        connectionId,
        clientUserId,
        page: pagination.page,
        pageSize: pagination.pageSize,
      },
    });
  }
}

/** Fabrique un client avec la config résolue depuis l'environnement. */
export function creerClientOmniFi(deps: DepsClient = {}): OmniFiClient {
  return new OmniFiClient(deps);
}
