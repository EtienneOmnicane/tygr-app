/**
 * Client Omni-FI (PR 1) — invariants testés avec un fetch factice (aucun réseau) :
 * en-tête ApiKey correct, corrélation FAPI, décodage d'enveloppe, mapping des
 * erreurs nommées, 429/Retry-After, timeout/abort, réseau, réponses malformées,
 * et lecture de configuration. Modèle : tests/unit/verifier-identifiants.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { OmniFiClient } from "@/server/omnifi/client";
import { obtenirConfigOmniFi, _reinitialiserConfigOmniFi } from "@/server/omnifi/config";
import {
  OmniFiApiError,
  OmniFiConfigError,
  OmniFiInvalidResponseError,
  OmniFiNetworkError,
  OmniFiTimeoutError,
} from "@/server/omnifi/erreurs";

// Vérité serveur Staging (dump tuteur 2026-06-16) : hôte api-stage.omni-fi.co,
// routes À LA RACINE (PAS de préfixe /v1 — la doc OpenAPI ment).
const CONFIG = {
  baseUrl: "https://api-stage.omni-fi.co",
  environment: "sandbox" as const,
  clientId: "client_test",
  secret: "sand_sk_secret",
};

const CLIENT_USER_ID = "user-123";

/** Construit une Response factice JSON. */
function reponseJson(
  corps: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(corps), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function creerClient(fetchMock: typeof fetch, options: { timeoutMs?: number } = {}) {
  return new OmniFiClient({
    fetch: fetchMock,
    config: CONFIG,
    genererInteractionId: () => "fixed-interaction-id",
    timeoutMs: options.timeoutMs,
  });
}

afterEach(() => {
  _reinitialiserConfigOmniFi();
  vi.unstubAllEnvs();
});

describe("chemin heureux — décodage d'enveloppe", () => {
  it("listerConnexions retourne Data et envoie les bons en-têtes + query", async () => {
    const data = { Connections: [{ ConnectionId: "c1" }] };
    const fetchMock = vi.fn().mockResolvedValue(reponseJson({ Data: data }));
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const r = await client.listerConnexions(CLIENT_USER_ID, { pageSize: 50 });

    expect(r.Data).toEqual(data); // Q2 : enveloppe complète (Data + Links/Meta)
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/connections");
    // Omni-FI lit le param en snake_case (ResolveEndUser → query_params.get("client_user_id")).
    // En camelCase il renvoie 403 (param ignoré). Vérifié runtime 2026-06-18.
    expect(url).toContain("client_user_id=user-123");
    expect(url).toContain("pageSize=50");
    expect(url).not.toContain("page="); // valeur undefined omise
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("ApiKey client_test:sand_sk_secret");
    expect(headers["x-fapi-interaction-id"]).toBe("fixed-interaction-id");
  });

  it("syncTransactions transmet cursor + count et encode l'accountId", async () => {
    const data = { Added: [], Modified: [], Removed: [], NextCursor: "n", HasMore: false };
    const fetchMock = vi.fn().mockResolvedValue(reponseJson({ Data: data }));
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const r = await client.syncTransactions("acc/42", CLIENT_USER_ID, {
      cursor: "cur",
      count: 200,
    });

    expect(r.HasMore).toBe(false);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/accounts/acc%2F42/transactions/sync");
    expect(url).toContain("cursor=cur");
    expect(url).toContain("count=200");
  });
});

describe("mapping des erreurs API (règle 3)", () => {
  it("4xx OBIE → OmniFiApiError avec code + détails, non réessayable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson(
        {
          Code: "400 BadRequest",
          Message: "Validation",
          Errors: [{ ErrorCode: "INSTITUTION_REQUIRED", Message: "x", Path: "$.InstitutionId" }],
        },
        { status: 400 },
      ),
    );
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur = await client
      .listerConnexions(CLIENT_USER_ID)
      .catch((e) => e);

    expect(erreur).toBeInstanceOf(OmniFiApiError);
    expect(erreur.status).toBe(400);
    expect(erreur.obieCode).toBe("400 BadRequest");
    expect(erreur.details).toEqual([
      { errorCode: "INSTITUTION_REQUIRED", path: "$.InstitutionId" },
    ]);
    expect(erreur.estReessayable).toBe(false);
  });

  it("429 → estRateLimit + Retry-After remonté, réessayable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ Code: "429 TooManyRequests", Message: "slow down" }, {
        status: 429,
        headers: { "Retry-After": "12" },
      }),
    );
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur: OmniFiApiError = await client
      .syncTransactions("acc", CLIENT_USER_ID)
      .catch((e) => e);

    expect(erreur).toBeInstanceOf(OmniFiApiError);
    expect(erreur.estRateLimit).toBe(true);
    expect(erreur.retryAfterSeconds).toBe(12);
    expect(erreur.estReessayable).toBe(true);
  });

  it("5xx → réessayable, sans enveloppe OBIE (corps vide géré)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("oops", { status: 503 }),
    );
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur: OmniFiApiError = await client
      .listerConnexions(CLIENT_USER_ID)
      .catch((e) => e);

    expect(erreur).toBeInstanceOf(OmniFiApiError);
    expect(erreur.status).toBe(503);
    expect(erreur.obieCode).toBeNull();
    expect(erreur.estReessayable).toBe(true);
  });
});

describe("réseau & timeout", () => {
  it("abort (timeout) → OmniFiTimeoutError", async () => {
    // fetch qui rejette comme un AbortController déclenché.
    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }
      });
    });
    const client = creerClient(fetchMock as unknown as typeof fetch, {
      timeoutMs: 5,
    });

    const erreur = await client.listerConnexions(CLIENT_USER_ID).catch((e) => e);
    expect(erreur).toBeInstanceOf(OmniFiTimeoutError);
    expect((erreur as OmniFiTimeoutError).timeoutMs).toBe(5);
  });

  it("échec réseau brut → OmniFiNetworkError (cause réduite au résumé sûr, S2)", async () => {
    const cause = new TypeError("fetch failed");
    const fetchMock = vi.fn().mockRejectedValue(cause);
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur = await client.listerConnexions(CLIENT_USER_ID).catch((e) => e);
    expect(erreur).toBeInstanceOf(OmniFiNetworkError);
    // S2 : on ne conserve PAS l'objet brut (risque de fuite via un fetch wrappé),
    // seulement un résumé { name, code }.
    expect((erreur as OmniFiNetworkError).cause).toEqual({
      name: "TypeError",
      code: undefined,
    });
  });
});

describe("réponses malformées", () => {
  it("corps non-JSON sur 200 → OmniFiInvalidResponseError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur = await client.listerConnexions(CLIENT_USER_ID).catch((e) => e);
    expect(erreur).toBeInstanceOf(OmniFiInvalidResponseError);
  });

  it("enveloppe sans Data → OmniFiInvalidResponseError", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reponseJson({ pasDeData: true }));
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur = await client.listerConnexions(CLIENT_USER_ID).catch((e) => e);
    expect(erreur).toBeInstanceOf(OmniFiInvalidResponseError);
  });

  it("Q1 — { Data: null } rejeté bruyamment (pas de retour null silencieux)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reponseJson({ Data: null }));
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur = await client.listerConnexions(CLIENT_USER_ID).catch((e) => e);
    expect(erreur).toBeInstanceOf(OmniFiInvalidResponseError);
  });
});

describe("Q2 — pagination page-based : Links/Meta exposés", () => {
  it("listerConnexions remonte Links.Next et Meta.TotalPages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({
        Data: { Connections: [] },
        Links: { Self: "...", Next: "...&page=2" },
        Meta: { TotalPages: 3, TotalRecords: 55 },
      }),
    );
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const r = await client.listerConnexions(CLIENT_USER_ID);
    expect(r.Links?.Next).toContain("page=2");
    expect(r.Meta?.TotalPages).toBe(3);
  });
});

describe("Q5 — Retry-After au format date HTTP", () => {
  it("429 avec HTTP-date → secondes restantes calculées (≥ 0)", async () => {
    // Date dans ~30 s : on fige l'horloge pour un calcul déterministe.
    const maintenant = new Date("2026-06-15T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(maintenant);
    const dans30s = "Mon, 15 Jun 2026 10:00:30 GMT";
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ Code: "429" }, { status: 429, headers: { "Retry-After": dans30s } }),
    );
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur: OmniFiApiError = await client
      .listerConnexions(CLIENT_USER_ID)
      .catch((e) => e);
    expect(erreur.retryAfterSeconds).toBe(30);
    vi.useRealTimers();
  });
});

describe("S2 — la cause réseau ne porte qu'un résumé sûr (pas de requête/secret)", () => {
  it("OmniFiNetworkError.cause = { name, code } uniquement", async () => {
    // Cause hostile : un faux objet d'erreur qui embarquerait la requête.
    const causeHostile = Object.assign(new TypeError("fetch failed"), {
      code: "ECONNREFUSED",
      request: { headers: { Authorization: "ApiKey leak:SECRET" } },
    });
    const fetchMock = vi.fn().mockRejectedValue(causeHostile);
    const client = creerClient(fetchMock as unknown as typeof fetch);

    const erreur: OmniFiNetworkError = await client
      .listerConnexions(CLIENT_USER_ID)
      .catch((e) => e);
    expect(erreur).toBeInstanceOf(OmniFiNetworkError);
    expect(erreur.cause).toEqual({ name: "TypeError", code: "ECONNREFUSED" });
    // Sérialisée, l'erreur ne doit JAMAIS contenir le secret.
    expect(JSON.stringify(erreur.cause)).not.toContain("SECRET");
  });
});

describe("configuration (lecture d'env, règle 8)", () => {
  it("OMNIFI_SECRET manquant → OmniFiConfigError", () => {
    // Hôte VALIDE (allow-list) pour que l'erreur vienne bien du secret vide, pas
    // de la baseUrl (validée en premier). sandbox n'est plus dans l'allow-list.
    vi.stubEnv("OMNIFI_ENV", "sandbox");
    vi.stubEnv("OMNIFI_BASE_URL", "https://api-stage.omni-fi.co");
    vi.stubEnv("OMNIFI_CLIENT_ID", "client_test");
    vi.stubEnv("OMNIFI_SECRET", "");
    _reinitialiserConfigOmniFi();
    expect(() => obtenirConfigOmniFi()).toThrow(OmniFiConfigError);
  });

  it("base URL non-https → OmniFiConfigError (anti-fuite de clé)", () => {
    vi.stubEnv("OMNIFI_ENV", "sandbox");
    vi.stubEnv("OMNIFI_BASE_URL", "http://sandbox.omni-fi.co/v1");
    vi.stubEnv("OMNIFI_CLIENT_ID", "client_test");
    vi.stubEnv("OMNIFI_SECRET", "s");
    _reinitialiserConfigOmniFi();
    expect(() => obtenirConfigOmniFi()).toThrow(OmniFiConfigError);
  });

  it("OMNIFI_ENV inattendu → OmniFiConfigError", () => {
    vi.stubEnv("OMNIFI_ENV", "prod");
    vi.stubEnv("OMNIFI_BASE_URL", "https://x/v1");
    vi.stubEnv("OMNIFI_CLIENT_ID", "c");
    vi.stubEnv("OMNIFI_SECRET", "s");
    _reinitialiserConfigOmniFi();
    expect(() => obtenirConfigOmniFi()).toThrow(OmniFiConfigError);
  });

  it("S1 — base URL avec userinfo (user:pass@) → OmniFiConfigError", () => {
    // Contournement classique de startsWith('https://') : le host réel est evil.com.
    vi.stubEnv("OMNIFI_ENV", "sandbox");
    vi.stubEnv("OMNIFI_BASE_URL", "https://sandbox.omni-fi.co@evil.com/v1");
    vi.stubEnv("OMNIFI_CLIENT_ID", "c");
    vi.stubEnv("OMNIFI_SECRET", "s");
    _reinitialiserConfigOmniFi();
    expect(() => obtenirConfigOmniFi()).toThrow(OmniFiConfigError);
  });

  it("S1 — host hors allow-list → OmniFiConfigError (la clé n'y part jamais)", () => {
    vi.stubEnv("OMNIFI_ENV", "sandbox");
    vi.stubEnv("OMNIFI_BASE_URL", "https://169.254.169.254/v1");
    vi.stubEnv("OMNIFI_CLIENT_ID", "c");
    vi.stubEnv("OMNIFI_SECRET", "s");
    _reinitialiserConfigOmniFi();
    expect(() => obtenirConfigOmniFi()).toThrow(OmniFiConfigError);
  });

  it("S1 — les 3 hôtes documentés sont acceptés", () => {
    // NOTE (2026-06-16) : "sandbox.omni-fi.co" (coquille doc, NXDOMAIN) retiré de
    // l'allow-list. Hôtes valides : api (prod), api-stage (API pré-prod, dump
    // tuteur), stage (CDN widget). Base SANS /v1 : routes à la racine.
    for (const hote of [
      "api.omni-fi.co",
      "api-stage.omni-fi.co",
      "stage.omni-fi.co",
    ]) {
      vi.stubEnv("OMNIFI_ENV", "sandbox");
      vi.stubEnv("OMNIFI_BASE_URL", `https://${hote}`);
      vi.stubEnv("OMNIFI_CLIENT_ID", "c");
      vi.stubEnv("OMNIFI_SECRET", "s");
      _reinitialiserConfigOmniFi();
      expect(obtenirConfigOmniFi().baseUrl).toBe(`https://${hote}`);
    }
  });

  it("base URL avec slash final → normalisée (pas de // dans l'URL finale)", async () => {
    vi.stubEnv("OMNIFI_ENV", "sandbox");
    // Slash final → normalisé ; routes à la racine (PAS de /v1, dump tuteur 2026-06-16).
    vi.stubEnv("OMNIFI_BASE_URL", "https://api-stage.omni-fi.co/");
    vi.stubEnv("OMNIFI_CLIENT_ID", "c");
    vi.stubEnv("OMNIFI_SECRET", "s");
    _reinitialiserConfigOmniFi();

    const fetchMock = vi
      .fn()
      .mockResolvedValue(reponseJson({ Data: { Connections: [] } }));
    // Pas de config injectée → lecture depuis l'env stubé.
    const client = new OmniFiClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.listerConnexions(CLIENT_USER_ID);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api-stage.omni-fi.co/connections?client_user_id=user-123",
    );
  });
});
