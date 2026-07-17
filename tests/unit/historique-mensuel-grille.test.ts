/**
 * `grilleMois` — génération de l'axe temporel (N derniers mois) de l'historique
 * mensuel du dashboard. Fonction PURE (pas de DB, pas de `Date` locale) : c'est la
 * garantie d'un axe CONTINU même pour les mois sans transaction. On couvre le cas
 * nominal, le passage d'année (déc → jan), le mono-mois et une fenêtre longue.
 */
import { describe, expect, it } from "vitest";

import { grilleMois, grilleMoisSuivants } from "@/server/repositories/dashboard";

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

/**
 * `grilleMoisSuivants` — l'axe PRÉVISIONNEL (C1) : le pendant de `grilleMois`, qui
 * AVANCE. L'ancrage est EXCLU (il appartient déjà à la grille du réalisé, où il est la
 * colonne pivot mixte réalisé+prévision — D2).
 */
describe("grilleMoisSuivants", () => {
  it("rend les N mois qui SUIVENT l'ancrage, du plus proche au plus lointain", () => {
    expect(grilleMoisSuivants(3, "2026-07")).toEqual(["2026-08", "2026-09", "2026-10"]);
  });

  it("EXCLUT le mois d'ancrage (jamais dupliqué : il est la colonne pivot)", () => {
    expect(grilleMoisSuivants(3, "2026-07")).not.toContain("2026-07");
  });

  it("traverse correctement la frontière d'année (déc → jan)", () => {
    expect(grilleMoisSuivants(3, "2026-11")).toEqual(["2026-12", "2027-01", "2027-02"]);
  });

  it("padde les mois sur 2 chiffres", () => {
    expect(grilleMoisSuivants(3, "2026-06")).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("rend un tableau VIDE pour nbMois = 0 (prévision désactivée, D4)", () => {
    expect(grilleMoisSuivants(0, "2026-07")).toEqual([]);
  });

  it("avance sur plus de 12 mois (passage d'année)", () => {
    const g = grilleMoisSuivants(13, "2026-06");
    expect(g).toHaveLength(13);
    expect(g[0]).toBe("2026-07");
    expect(g[12]).toBe("2027-07");
  });

  it("s'aboute EXACTEMENT à grilleMois (axe continu, sans trou ni doublon)", () => {
    // La garantie que le SVG rend un axe temporel continu du passé au futur.
    const axe = [...grilleMois(3, "2026-12"), ...grilleMoisSuivants(3, "2026-12")];
    expect(axe).toEqual([
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
    ]);
  });
});
