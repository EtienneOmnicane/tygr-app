/**
 * Client serveur Omni-FI Core API (OBIE v4.0.1) — PR 1 : couche d'accès réseau
 * pure, SANS état d'UI ni accès DB. Surface couverte : lecture (connexions,
 * historique de soldes, sync de transactions par curseur, résumé). Le flux
 * widget, l'ingestion (écriture DB) et l'UI arrivent dans des PRs dédiées.
 *
 * Conformité docs/documentation_api.md :
 * - Auth ApiKeyAuth serveur-à-serveur : « Authorization: ApiKey <client_id>:<secret> ».
 * - Enveloppe { Data, Links, Meta } décodée ; erreurs { Code, Message, Errors[] }
 *   mappées vers des erreurs nommées (erreurs.ts, règle 3).
 * - 429 → Retry-After remonté ; tous les appels B2B portent clientUserId.
 * - x-fapi-interaction-id de corrélation sur chaque requête (traçage).
 *
 * Règle 8 : le secret n'est jamais loggé ; aucun montant n'est converti ici
 * (chaînes OBIE conservées telles quelles, parsing en centimes côté ingestion).
 *
 * `fetch` est injectable (DepsClient) pour des tests sans réseau réel, sur le
 * modèle de src/server/auth/verifier-identifiants.ts.
 */
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
  OmniFiBalanceHistoryData,
  OmniFiConnectionsData,
  OmniFiEnveloppe,
  OmniFiEnveloppeErreur,
  OmniFiTransactionsSummaryData,
  OmniFiTransactionsSyncData,
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

  /** En-tête Authorization ApiKey (docs § Authentification.1). */
  private enteteAuth(): string {
    return `ApiKey ${this.config.clientId}:${this.config.secret}`;
  }

  /**
   * Exécute une requête GET et retourne l'enveloppe OBIE complète ({ Data, Links,
   * Meta }). Q2 : on conserve Links/Meta pour que l'appelant puisse paginer (la
   * troncature silencieuse au-delà d'une page est interdite sur des données
   * financières). Lève une erreur nommée (erreurs.ts) sur tout échec — jamais de
   * retour null silencieux (règle 3).
   */
  private async getEnveloppe<TData>(
    chemin: string,
    options: OptionsRequete = {},
  ): Promise<OmniFiEnveloppe<TData>> {
    const url = construireUrl(this.config.baseUrl, chemin, options.query);
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.timeoutMs);

    let reponse: Response;
    try {
      reponse = await this.fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.enteteAuth(),
          Accept: "application/json",
          "x-fapi-interaction-id": this.genererInteractionId(),
        },
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
    return this.getEnveloppe<OmniFiConnectionsData>("/connections", {
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
    return this.getEnveloppe<OmniFiBalanceHistoryData>(
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
    const enveloppe = await this.getEnveloppe<OmniFiTransactionsSyncData>(
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
    const enveloppe = await this.getEnveloppe<OmniFiTransactionsSummaryData>(
      `/accounts/${encodeURIComponent(accountId)}/transactions/summary`,
      { query: { clientUserId, ...bornes } },
    );
    return enveloppe.Data;
  }
}

/** Fabrique un client avec la config résolue depuis l'environnement. */
export function creerClientOmniFi(deps: DepsClient = {}): OmniFiClient {
  return new OmniFiClient(deps);
}
