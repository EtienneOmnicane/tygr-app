/**
 * `variation-part` — étiquette de variation d'une part de camembert vs la période
 * précédente. Fonction PURE (ratio d'affichage uniquement, cul-de-sac float documenté
 * règle 8) : testable sans rendu ni DB.
 *
 * Invariant central couvert : le delta est BORNÉ. Le défaut d'origine ne gardait que
 * `prev <= 0` → « nouveau » ; une base précédente minuscule mais POSITIVE (0,47 vs
 * 9 005, catégorie « Loyer » USD observée en prod) faisait exploser le ratio à
 * ~1 915 977 % — un chiffre qui mesure la petitesse du dénominateur, pas l'évolution
 * de la catégorie, et qui déborde la colonne dimensionnée du badge.
 */
import { describe, expect, it } from "vitest";

import { PLAFOND_POURCENT, variationPart } from "@/components/graphiques/variation-part";

/**
 * U+202F, espace fine insécable — séparateur FR avant le « % ». Construit par code
 * point plutôt qu'écrit littéralement : ce caractère est INVISIBLE à la relecture d'un
 * diff, et une espace ordinaire glissée par un copier-coller ferait passer les
 * assertions au vert contre le mauvais libellé.
 */
const ESPACE_FINE = String.fromCharCode(0x202f);

/** Extrait la magnitude numérique d'un libellé (« >999 % » → 999, « 12 % » → 12). */
function magnitudeAffichee(pourcent: string | null): number {
  expect(pourcent).not.toBeNull();
  const chiffres = (pourcent ?? "").replace(/[^0-9]/g, "");
  expect(chiffres).not.toBe("");
  return Number(chiffres);
}

describe("variationPart — base précédente minuscule (défaut de prod)", () => {
  it("n'affiche JAMAIS un pourcentage aberrant quand le précédent est minuscule mais positif", () => {
    // Cas réel : « Loyer » USD, 0,47 la période précédente contre 9 005 la période
    // courante. Le calcul brut donnait ((9005 − 0.47) / 0.47) × 100 ≈ 1 915 977 %.
    const v = variationPart("9005", "0.47");

    expect(v.sens).toBe("hausse"); // le SENS reste vrai : la part a bien explosé
    expect(v.pourcent).toBe(`>${PLAFOND_POURCENT}${ESPACE_FINE}%`);
    expect(magnitudeAffichee(v.pourcent)).toBeLessThanOrEqual(PLAFOND_POURCENT);
  });

  it("ne requalifie PAS la part en « nouveau » — elle existait à la période précédente", () => {
    // « nouveau » porte un sens exact dans la légende (infobulle « Nouveau sur cette
    // période ») : l'employer ici serait factuellement faux.
    expect(variationPart("9005", "0.47").sens).not.toBe("nouveau");
  });

  it("borne la magnitude quelle que soit la petitesse du précédent", () => {
    for (const prev of ["0.01", "0.47", "1", "9.99"]) {
      const v = variationPart("1000000", prev);
      expect(magnitudeAffichee(v.pourcent)).toBeLessThanOrEqual(PLAFOND_POURCENT);
    }
  });
});

describe("variationPart — bornes du plafond", () => {
  it("affiche le chiffre EXACT jusqu'au plafond inclus (999 % n'est pas plafonné)", () => {
    // (1099 − 100) / 100 × 100 = 999 % pile : dernier delta chiffrable.
    const v = variationPart("1099", "100");
    expect(v.sens).toBe("hausse");
    expect(v.pourcent).toBe(`${PLAFOND_POURCENT}${ESPACE_FINE}%`);
  });

  it("bascule sur « >999 % » dès le premier point au-dessus du plafond", () => {
    const v = variationPart("1100", "100"); // 1000 %
    expect(v.sens).toBe("hausse");
    expect(v.pourcent).toBe(`>${PLAFOND_POURCENT}${ESPACE_FINE}%`);
  });
});

describe("variationPart — cas nominaux inchangés (non-régression)", () => {
  it("hausse normale : chiffre exact, séparateur FR", () => {
    expect(variationPart("112", "100")).toEqual({
      sens: "hausse",
      pourcent: `12${ESPACE_FINE}%`,
    });
  });

  it("baisse normale : magnitude ABSOLUE (le sens est porté par `sens`, pas par un signe)", () => {
    expect(variationPart("88", "100")).toEqual({
      sens: "baisse",
      pourcent: `12${ESPACE_FINE}%`,
    });
  });

  it("disparition complète : baisse de 100 %, jamais plafonnée", () => {
    // Une baisse est bornée à −100 % par construction : le plafond ne doit pas mordre.
    expect(variationPart("0", "100")).toEqual({
      sens: "baisse",
      pourcent: `100${ESPACE_FINE}%`,
    });
  });

  it("précédent ≤ 0 : « nouveau », sans pourcentage (pas de +∞ fabriqué)", () => {
    expect(variationPart("100", "0")).toEqual({ sens: "nouveau", pourcent: null });
    expect(variationPart("100", "-5")).toEqual({ sens: "nouveau", pourcent: null });
    expect(variationPart("100", "pas-un-nombre")).toEqual({
      sens: "nouveau",
      pourcent: null,
    });
  });

  it("delta arrondi à 0 : « stable », sans flèche trompeuse", () => {
    expect(variationPart("100.4", "100")).toEqual({ sens: "stable", pourcent: null });
    expect(variationPart("100", "100")).toEqual({ sens: "stable", pourcent: null });
    expect(variationPart("99.6", "100")).toEqual({ sens: "stable", pourcent: null });
  });

  it("montant courant illisible en nombre : repli « stable » (jamais de NaN affiché)", () => {
    expect(variationPart("pas-un-nombre", "100")).toEqual({
      sens: "stable",
      pourcent: null,
    });
  });
});
