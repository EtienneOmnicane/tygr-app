/**
 * `grilleMois` — génération de l'axe temporel (N derniers mois) de l'historique
 * mensuel du dashboard. Fonction PURE (pas de DB, pas de `Date` locale) : c'est la
 * garantie d'un axe CONTINU même pour les mois sans transaction. On couvre le cas
 * nominal, le passage d'année (déc → jan), le mono-mois et une fenêtre longue.
 */
import { describe, expect, it } from "vitest";

import { grilleMois } from "@/server/repositories/dashboard";

describe("grilleMois", () => {
  it("rend N mois du plus ANCIEN au plus RÉCENT (ordre chronologique)", () => {
    expect(grilleMois(6, "2026-06")).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
  });

  it("traverse correctement la frontière d'année (déc → jan)", () => {
    expect(grilleMois(3, "2026-01")).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("gère une fenêtre d'un seul mois", () => {
    expect(grilleMois(1, "2026-06")).toEqual(["2026-06"]);
  });

  it("padde les mois sur 2 chiffres", () => {
    // L'ancre de septembre recule sur des mois à 1 chiffre → toujours « 0X ».
    expect(grilleMois(4, "2026-09")).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
  });

  it("recule sur plus de 12 mois (deux passages d'année)", () => {
    const g = grilleMois(13, "2026-06");
    expect(g).toHaveLength(13);
    expect(g[0]).toBe("2025-06"); // 12 mois avant juin 2026
    expect(g[12]).toBe("2026-06");
  });
});
