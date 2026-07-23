/**
 * Rate-limit en mémoire (§10.1 cas 5). 60 req/IP/min ; 61ᵉ refusée ; la fenêtre se vide ;
 * IP absente → bucket commun (jamais une exemption).
 */
import { describe, expect, it } from "vitest";

import { WebhookTropDeRequetesError } from "@/server/webhooks/omnifi/erreurs";
import {
  creerSeaux,
  FENETRE_RL_MS,
  MAX_PAR_IP,
  verifierRateLimit,
} from "@/server/webhooks/omnifi/rate-limit";

const IP = "203.0.113.7";
const xff = (ip: string) => ip;

describe("verifierRateLimit", () => {
  it("60 requêtes passent, la 61ᵉ est refusée (429)", () => {
    const seaux = creerSeaux();
    const now = 1_000_000;
    for (let i = 0; i < MAX_PAR_IP; i++) {
      expect(() => verifierRateLimit(seaux, xff(IP), now)).not.toThrow();
    }
    expect(() => verifierRateLimit(seaux, xff(IP), now)).toThrow(
      WebhookTropDeRequetesError,
    );
  });

  it("après la fenêtre, le seau se vide", () => {
    const seaux = creerSeaux();
    const now = 1_000_000;
    for (let i = 0; i < MAX_PAR_IP; i++) verifierRateLimit(seaux, xff(IP), now);
    // Une seconde après l'expiration de la fenêtre : les anciens sortent.
    const apres = now + FENETRE_RL_MS + 1_000;
    expect(() => verifierRateLimit(seaux, xff(IP), apres)).not.toThrow();
  });

  it("l'erreur 429 porte un Retry-After positif", () => {
    const seaux = creerSeaux();
    const now = 1_000_000;
    for (let i = 0; i < MAX_PAR_IP; i++) verifierRateLimit(seaux, xff(IP), now);
    try {
      verifierRateLimit(seaux, xff(IP), now);
      throw new Error("aurait dû lever");
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookTropDeRequetesError);
      expect((e as WebhookTropDeRequetesError).retryApresSecondes).toBeGreaterThan(0);
    }
  });

  it("IP absente → bucket commun 'ip-inconnue' (pas d'exemption)", () => {
    const seaux = creerSeaux();
    const now = 1_000_000;
    for (let i = 0; i < MAX_PAR_IP; i++) verifierRateLimit(seaux, null, now);
    expect(() => verifierRateLimit(seaux, null, now)).toThrow(
      WebhookTropDeRequetesError,
    );
  });

  it("deux IP distinctes ne se partagent pas le seau", () => {
    const seaux = creerSeaux();
    const now = 1_000_000;
    for (let i = 0; i < MAX_PAR_IP; i++) verifierRateLimit(seaux, "1.1.1.1", now);
    // Une AUTRE IP n'est pas affectée par le seau plein de la première.
    expect(() => verifierRateLimit(seaux, "2.2.2.2", now)).not.toThrow();
  });
});
