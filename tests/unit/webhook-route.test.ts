/**
 * Frontière HTTP de la route (§10.3, constat cross-review W4 C3) — on passe de VRAIES
 * `Request` au handler exporté `traiterRequeteWebhook` et on asserte les CODES HTTP + le
 * corps VIDE. Couvre les chemins qui ne touchent PAS la DB (503/401/413/429) — donc
 * « zéro écrit en base avant signature valide » est prouvé par le fait qu'aucune dep DB
 * n'est atteignable (résolution = étape postérieure au HMAC). La logique métier (202 /
 * quarantaine / dédup) est couverte par webhook-traitement.test.ts (deps injectées).
 */
import { createHmac, randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { traiterRequeteWebhook } from "@/server/webhooks/omnifi/route-handler";

const SECRET = randomBytes(32).toString("hex");

function requete(body: Buffer | string, headers: Record<string, string> = {}) {
  const octets = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return new Request("http://tygr.test/api/webhooks/omnifi", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    // Buffer (Uint8Array) → Uint8Array pour satisfaire le type BodyInit (DOM lib).
    body: new Uint8Array(octets),
  });
}

beforeEach(() => {
  vi.stubEnv("OMNIFI_ENV", "sandbox");
  // Silence les logs structurés de la route (grep-ables mais bruyants en test).
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mapping HTTP + gardes de transport (aucun accès DB sur ces chemins)", () => {
  it("secret absent pour l'env → 503, corps vide", async () => {
    vi.stubEnv("OMNIFI_WEBHOOK_SECRET_SANDBOX", ""); // absent
    const r = await traiterRequeteWebhook(
      requete(JSON.stringify({ x: 1 }), { "x-forwarded-for": "10.0.0.1" }),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toBe("");
  });

  it("signature absente → 401, corps vide", async () => {
    vi.stubEnv("OMNIFI_WEBHOOK_SECRET_SANDBOX", SECRET);
    const r = await traiterRequeteWebhook(
      requete(JSON.stringify({ x: 1 }), { "x-forwarded-for": "10.0.0.2" }),
    );
    expect(r.status).toBe(401);
    expect(await r.text()).toBe("");
  });

  it("signature mal formée → 401", async () => {
    vi.stubEnv("OMNIFI_WEBHOOK_SECRET_SANDBOX", SECRET);
    const r = await traiterRequeteWebhook(
      requete(JSON.stringify({ x: 1 }), {
        "x-forwarded-for": "10.0.0.3",
        "x-omnifi-signature": "deadbeef",
      }),
    );
    expect(r.status).toBe(401);
  });

  it("corps > 64 Ko → 413", async () => {
    vi.stubEnv("OMNIFI_WEBHOOK_SECRET_SANDBOX", SECRET);
    const gros = Buffer.alloc(64 * 1024 + 1, 0x61);
    const r = await traiterRequeteWebhook(
      requete(gros, { "x-forwarded-for": "10.0.0.4" }),
    );
    expect(r.status).toBe(413);
  });

  it("borne : corps à 64 Ko EXACTEMENT accepté (pas 413) → rejeté plus loin au HMAC (401)", async () => {
    vi.stubEnv("OMNIFI_WEBHOOK_SECRET_SANDBOX", SECRET);
    const limite = Buffer.alloc(64 * 1024, 0x61);
    const r = await traiterRequeteWebhook(
      requete(limite, { "x-forwarded-for": "10.0.0.5" }),
    );
    expect(r.status).not.toBe(413);
    expect(r.status).toBe(401);
  });

  it("rate-limit dépassé → 429 + en-tête Retry-After (avant lecture du corps)", async () => {
    vi.stubEnv("OMNIFI_WEBHOOK_SECRET_SANDBOX", SECRET);
    const ip = "10.9.9.9";
    let derniere: Response | undefined;
    for (let i = 0; i < 61; i++) {
      derniere = await traiterRequeteWebhook(
        requete(JSON.stringify({ x: 1 }), { "x-forwarded-for": ip }),
      );
    }
    expect(derniere?.status).toBe(429);
    expect(derniere?.headers.get("Retry-After")).toBeTruthy();
  });

  it("signature VALIDE mais corps non-JSON → 400 (le HMAC passe, le zod échoue)", async () => {
    vi.stubEnv("OMNIFI_WEBHOOK_SECRET_SANDBOX", SECRET);
    const octets = Buffer.from("pas du json", "utf8");
    const signature = createHmac("sha256", SECRET).update(octets).digest("hex");
    const r = await traiterRequeteWebhook(
      requete(octets, { "x-forwarded-for": "10.0.0.6", "x-omnifi-signature": signature }),
    );
    expect(r.status).toBe(400);
  });
});
