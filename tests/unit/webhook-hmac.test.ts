/**
 * HMAC-SHA256 du webhook (§10.1 cas 1-2). Fonctions PURES : octets bruts, constant-time,
 * sélection du secret par env. Un secret de test est généré localement (jamais commité).
 */
import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WebhookSignatureInvalideError } from "@/server/webhooks/omnifi/erreurs";
import {
  normaliserSignature,
  selectionnerSecretWebhook,
  tronquerSignature,
  verifierHmac,
} from "@/server/webhooks/omnifi/hmac";

const SECRET = randomBytes(32).toString("hex");
const CORPS = Buffer.from(
  JSON.stringify({ EventId: "x", EventType: "sync.completed" }),
  "utf8",
);
const signer = (octets: Buffer, secret = SECRET) =>
  createHmac("sha256", secret).update(octets).digest("hex");

describe("verifierHmac — chemin heureux", () => {
  it("1. signature valide sur les octets bruts → rend la signature normalisée", () => {
    const sig = signer(CORPS);
    expect(verifierHmac(CORPS, sig, SECRET)).toBe(sig);
  });
});

describe("verifierHmac — signature invalide (401), sans crash", () => {
  it("2a. en-tête absent → WebhookSignatureInvalideError (jamais timingSafeEqual)", () => {
    expect(() => verifierHmac(CORPS, null, SECRET)).toThrow(
      WebhookSignatureInvalideError,
    );
  });

  it("2b. hex de bonne longueur mais faux → rejet", () => {
    const faux = "0".repeat(64);
    expect(() => verifierHmac(CORPS, faux, SECRET)).toThrow(
      WebhookSignatureInvalideError,
    );
  });

  it("2c. mauvaise longueur (49 caractères) → rejet SANS passer par timingSafeEqual", () => {
    // timingSafeEqual lève sur longueurs inégales ; on doit rejeter AVANT (401 propre,
    // pas un 500). 49 hex ne matche pas /^[0-9a-fA-F]{64}$/ → normaliserSignature = null.
    expect(normaliserSignature("a".repeat(49))).toBeNull();
    expect(() => verifierHmac(CORPS, "a".repeat(49), SECRET)).toThrow(
      WebhookSignatureInvalideError,
    );
  });

  it("2d. signature valide pour un AUTRE corps (mutation d'un octet) → rejet", () => {
    const sig = signer(CORPS);
    const corpsMute = Buffer.from(CORPS);
    corpsMute[0] = corpsMute[0] ^ 0xff; // un octet changé
    expect(() => verifierHmac(corpsMute, sig, SECRET)).toThrow(
      WebhookSignatureInvalideError,
    );
  });

  it("2e. préfixe `sha256=` toléré et retiré", () => {
    const sig = signer(CORPS);
    expect(verifierHmac(CORPS, `sha256=${sig}`, SECRET)).toBe(sig);
  });

  it("2f. casse hexadécimale mixte acceptée (normalisée en minuscules)", () => {
    const sig = signer(CORPS);
    const mixte = sig
      .split("")
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join("");
    expect(verifierHmac(CORPS, mixte, SECRET)).toBe(sig);
  });

  it("2g. signature d'un AUTRE secret → rejet (l'événement de l'autre env échoue au 401)", () => {
    const autreSecret = randomBytes(32).toString("hex");
    const sig = signer(CORPS, autreSecret);
    expect(() => verifierHmac(CORPS, sig, SECRET)).toThrow(
      WebhookSignatureInvalideError,
    );
  });
});

describe("selectionnerSecretWebhook — un seul secret par déploiement (§3.3)", () => {
  it("sélectionne le secret de l'env courant", () => {
    expect(
      selectionnerSecretWebhook("sandbox", { sandbox: "s", production: "p" }),
    ).toBe("s");
    expect(
      selectionnerSecretWebhook("production", { sandbox: "s", production: "p" }),
    ).toBe("p");
  });

  it("secret absent / vide → null (→ 503, jamais « on accepte sans vérifier »)", () => {
    expect(selectionnerSecretWebhook("sandbox", { sandbox: undefined })).toBeNull();
    expect(selectionnerSecretWebhook("sandbox", { sandbox: "   " })).toBeNull();
    expect(selectionnerSecretWebhook("production", { production: null })).toBeNull();
  });
});

describe("tronquerSignature", () => {
  it("rend les 8 premiers hexa (trace non rejouable)", () => {
    const sig = signer(CORPS);
    expect(tronquerSignature(sig)).toBe(sig.slice(0, 8));
    expect(tronquerSignature(sig)).toHaveLength(8);
  });
});
