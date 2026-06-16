/**
 * Client Omni-FI — flux Link Widget (PR-W1). Vérifie, avec un fetch factice :
 * le SCHÉMA D'AUTH émis par endpoint (ApiKey / LinkToken / Bearer), le verbe,
 * le body, et les invariants de sécurité (token jamais dans l'URL, secret/Bearer
 * jamais fuités, watermark MFA, content-type sur POST).
 */
import { describe, expect, it, vi } from "vitest";

import { OmniFiClient } from "@/server/omnifi/client";
import { OmniFiApiError } from "@/server/omnifi/erreurs";

// Vérité serveur Staging (dump tuteur 2026-06-16) : hôte api-stage.omni-fi.co,
// routes À LA RACINE (PAS de préfixe /v1 — la doc OpenAPI ment).
const CONFIG = {
  baseUrl: "https://api-stage.omni-fi.co",
  environment: "sandbox" as const,
  clientId: "client_test",
  secret: "sand_sk_secret",
};

function rep(corps: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(corps), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function client(fetchMock: typeof fetch) {
  return new OmniFiClient({
    fetch: fetchMock,
    config: CONFIG,
    genererInteractionId: () => "fixed-id",
  });
}

/** Récupère [url, init] du dernier appel fetch. */
function dernierAppel(m: ReturnType<typeof vi.fn>) {
  const [url, init] = m.mock.calls.at(-1)!;
  const headers = (init as RequestInit).headers as Record<string, string>;
  return { url: url as string, init: init as RequestInit, headers };
}

describe("link-token (ApiKey, serveur)", () => {
  it("POST avec auth ApiKey + body, retourne Data", async () => {
    const f = vi.fn().mockResolvedValue(
      rep({ Data: { LinkToken: "lt_x", Expiration: "2026-06-15T00:15:00Z" } }, { status: 201 }),
    );
    const c = client(f as unknown as typeof fetch);
    const r = await c.creerLinkToken({
      ClientUserId: "ws-user-1",
      RedirectOrigin: "https://app.tygr.mu",
      RequestedScopes: ["accounts", "data"],
    });
    expect(r.LinkToken).toBe("lt_x");
    const { url, init, headers } = dernierAppel(f);
    expect(url).toBe("https://api-stage.omni-fi.co/connections/link-token");
    expect(init.method).toBe("POST");
    expect(headers.Authorization).toBe("ApiKey client_test:sand_sk_secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string).ClientUserId).toBe("ws-user-1");
  });
});

describe("session/exchange (LinkToken)", () => {
  it("émet Authorization: LinkToken <token>, body vide, token jamais dans l'URL", async () => {
    const f = vi.fn().mockResolvedValue(
      rep({ Data: { SessionToken: "st_x", ExpiresAt: "x", ExpiresIn: 1800, AccountSelectionEnabled: true } }),
    );
    const c = client(f as unknown as typeof fetch);
    const r = await c.echangerSessionToken("lt_secret_123");
    expect(r.SessionToken).toBe("st_x");
    const { url, headers } = dernierAppel(f);
    expect(headers.Authorization).toBe("LinkToken lt_secret_123");
    expect(url).not.toContain("lt_secret_123"); // jamais en query/path
  });

  it("429 rate-limit → OmniFiApiError réessayable", async () => {
    const f = vi.fn().mockResolvedValue(rep({ Code: "429" }, { status: 429 }));
    const c = client(f as unknown as typeof fetch);
    const e: OmniFiApiError = await c.echangerSessionToken("lt").catch((x) => x);
    expect(e).toBeInstanceOf(OmniFiApiError);
    expect(e.estRateLimit).toBe(true);
  });
});

describe("link-connect (SessionToken/Bearer)", () => {
  it("émet Bearer + Credentials dans le body ; token absent de l'URL", async () => {
    const f = vi.fn().mockResolvedValue(
      rep({ Data: { PublicToken: "pt_x", JobId: "j1", ConnectionId: null, CustomerType: "business" } }, { status: 201 }),
    );
    const c = client(f as unknown as typeof fetch);
    const r = await c.connecter("st_session_456", { Email: "u@bank.mu", Password: "p" }, "mcb");
    expect(r.JobId).toBe("j1");
    const { url, init, headers } = dernierAppel(f);
    expect(headers.Authorization).toBe("Bearer st_session_456");
    expect(url).not.toContain("st_session_456");
    const body = JSON.parse(init.body as string);
    expect(body.Credentials.Email).toBe("u@bank.mu");
    expect(body.InstitutionId).toBe("mcb");
  });
});

describe("polling sync job", () => {
  it("getSyncJob (Bearer) sans clientUserId", async () => {
    const f = vi.fn().mockResolvedValue(rep({ Data: { JobId: "j1", InstitutionId: "mcb", Status: "OTP_REQUESTED" } }));
    const c = client(f as unknown as typeof fetch);
    const r = await c.getSyncJob("st_x", "j1");
    expect(r.Status).toBe("OTP_REQUESTED");
    const { url, headers } = dernierAppel(f);
    expect(headers.Authorization).toBe("Bearer st_x");
    expect(url).toBe("https://api-stage.omni-fi.co/sync/job/j1");
    expect(url).not.toContain("clientUserId");
  });

  it("getSyncJobServeur (ApiKey) AVEC clientUserId en query", async () => {
    const f = vi.fn().mockResolvedValue(rep({ Data: { JobId: "j1", InstitutionId: "mcb", Status: "COMPLETED" } }));
    const c = client(f as unknown as typeof fetch);
    await c.getSyncJobServeur("j1", "ws-user-1");
    const { url, headers } = dernierAppel(f);
    expect(headers.Authorization).toBe("ApiKey client_test:sand_sk_secret");
    expect(url).toContain("clientUserId=ws-user-1");
  });
});

describe("MFA input (watermark)", () => {
  it("sans watermark : MfaResendRequestedAt absent du body", async () => {
    const f = vi.fn().mockResolvedValue(rep({ Data: { Status: "OTP_ACCEPTED", JobId: "j1" } }, { status: 202 }));
    const c = client(f as unknown as typeof fetch);
    await c.soumettreMfa("st_x", "j1", "123456");
    const body = JSON.parse(dernierAppel(f).init.body as string);
    expect(body.UserInput).toBe("123456");
    expect("MfaResendRequestedAt" in body).toBe(false);
  });

  it("avec watermark : ré-émis verbatim", async () => {
    const f = vi.fn().mockResolvedValue(rep({ Data: { Status: "OTP_ACCEPTED", JobId: "j1" } }, { status: 202 }));
    const c = client(f as unknown as typeof fetch);
    await c.soumettreMfa("st_x", "j1", "123456", "2026-06-15T10:00:05Z");
    const body = JSON.parse(dernierAppel(f).init.body as string);
    expect(body.MfaResendRequestedAt).toBe("2026-06-15T10:00:05Z");
  });

  it("409 STALE_INPUT → OmniFiApiError non réessayable", async () => {
    const f = vi.fn().mockResolvedValue(
      rep({ Code: "409", Errors: [{ ErrorCode: "STALE_INPUT", Message: "x" }] }, { status: 409 }),
    );
    const c = client(f as unknown as typeof fetch);
    const e: OmniFiApiError = await c.soumettreMfa("st_x", "j1", "0").catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details[0].errorCode).toBe("STALE_INPUT");
    expect(e.estReessayable).toBe(false);
  });
});

describe("resend MFA + accounts + link-exchange", () => {
  it("resendMfa (Bearer, POST)", async () => {
    const f = vi.fn().mockResolvedValue(
      rep({ Data: { JobId: "j1", MfaResendRequestedAt: "2026-06-15T10:00:05Z", MfaResendCount: 1 } }, { status: 202 }),
    );
    const c = client(f as unknown as typeof fetch);
    const r = await c.resendMfa("st_x", "j1");
    expect(r.MfaResendCount).toBe(1);
    expect(dernierAppel(f).headers.Authorization).toBe("Bearer st_x");
    expect(dernierAppel(f).init.method).toBe("POST");
  });

  it("getSyncJobAccounts (Bearer) → liste de comptes", async () => {
    const f = vi.fn().mockResolvedValue(
      rep({ Data: { Account: [{ AccountId: "a1", Status: "Enabled", Currency: "MUR" }] } }),
    );
    const c = client(f as unknown as typeof fetch);
    const r = await c.getSyncJobAccounts("st_x", "j1");
    expect(r.Account[0].AccountId).toBe("a1");
    expect(dernierAppel(f).url).toBe("https://api-stage.omni-fi.co/sync/job/j1/accounts");
  });

  it("echangerPublicToken (ApiKey) re-transmet ClientUserId (frontière tenant)", async () => {
    const f = vi.fn().mockResolvedValue(
      rep({ Data: { ConnectionId: "c1", InstitutionId: "mcb", CustomerType: "business" } }),
    );
    const c = client(f as unknown as typeof fetch);
    const r = await c.echangerPublicToken("pt_x", "ws-user-1");
    expect(r.ConnectionId).toBe("c1");
    const { init, headers } = dernierAppel(f);
    expect(headers.Authorization).toBe("ApiKey client_test:sand_sk_secret");
    const body = JSON.parse(init.body as string);
    expect(body.PublicToken).toBe("pt_x");
    expect(body.ClientUserId).toBe("ws-user-1");
  });

  it("403 PUBLIC_TOKEN_CLIENT_MISMATCH → OmniFiApiError non réessayable", async () => {
    const f = vi.fn().mockResolvedValue(
      rep({ Code: "403", Errors: [{ ErrorCode: "PUBLIC_TOKEN_CLIENT_MISMATCH", Message: "x" }] }, { status: 403 }),
    );
    const c = client(f as unknown as typeof fetch);
    const e: OmniFiApiError = await c.echangerPublicToken("pt_x", "ws-user-1").catch((x) => x);
    expect(e.status).toBe(403);
    expect(e.estReessayable).toBe(false);
  });
});

describe("sécurité transverse — aucun secret/token dans une erreur réseau", () => {
  it("échec réseau sur un appel Bearer ne fuite pas le SessionToken", async () => {
    const cause = Object.assign(new TypeError("fetch failed"), {
      request: { headers: { Authorization: "Bearer st_session_456" } },
    });
    const f = vi.fn().mockRejectedValue(cause);
    const c = client(f as unknown as typeof fetch);
    const e = await c.getSyncJob("st_session_456", "j1").catch((x) => x);
    expect(JSON.stringify(e)).not.toContain("st_session_456");
  });
});
