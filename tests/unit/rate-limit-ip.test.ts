/** Rate-limit IP fenêtre glissante (E7/#49) — règles pures. */
import { describe, expect, it } from "vitest";

import {
  debutFenetre,
  depasseLimiteIp,
  extraireIp,
  FENETRE_IP_MS,
  MAX_TENTATIVES_IP,
} from "@/lib/auth/rate-limit-ip";

const T0 = new Date("2026-06-12T10:00:00.000Z");

describe("debutFenetre", () => {
  it("recule exactement de la fenêtre", () => {
    expect(debutFenetre(T0)).toEqual(new Date(T0.getTime() - FENETRE_IP_MS));
  });
});

describe("depasseLimiteIp (bornes)", () => {
  it("sous la limite → autorisé", () => {
    expect(depasseLimiteIp(0)).toBe(false);
    expect(depasseLimiteIp(MAX_TENTATIVES_IP - 1)).toBe(false);
  });

  it("à la limite exacte → rejeté (la N-ième tentative est la dernière admise)", () => {
    expect(depasseLimiteIp(MAX_TENTATIVES_IP)).toBe(true);
  });

  it("au-delà → rejeté", () => {
    expect(depasseLimiteIp(MAX_TENTATIVES_IP + 100)).toBe(true);
  });
});

describe("extraireIp", () => {
  it("première IP d'une liste x-forwarded-for", () => {
    expect(extraireIp("203.0.113.7, 10.0.0.1, 10.0.0.2")).toBe("203.0.113.7");
  });

  it("header absent ou vide → bucket commun explicite", () => {
    expect(extraireIp(null)).toBe("ip-inconnue");
    expect(extraireIp("")).toBe("ip-inconnue");
    expect(extraireIp("  ,10.0.0.1")).toBe("ip-inconnue");
  });

  it("valeur hostile tronquée à 45 chars (taille colonne)", () => {
    expect(extraireIp("a".repeat(500)).length).toBe(45);
  });
});
