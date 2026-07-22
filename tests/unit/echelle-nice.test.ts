/**
 * `echelleNice` — verrouille le contrat de l'arrondi « nice » (mantisse ∈
 * {1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10} × 10^n, toujours ≥ à l'entrée) utilisé pour
 * poser des bornes d'axe lisibles sur le graphe de flux (barres). Fonction PURE
 * (géométrie d'axe uniquement, règle 8), donc testable directement sans DB ni rendu.
 *
 * Invariants couverts : chemin heureux (arrondi au palier supérieur), paliers
 * intermédiaires (1.5 / 3 / 4 / 6 / 8 — ajoutés pour que l'axe ne double plus le max
 * et que la plus haute barre remplisse la carte), passage de décade, fail-safe
 * (0/NaN/négatif/Infinity → plafond sûr non nul), propriété « résultat ≥ entrée » et
 * propriété anti-vide « résultat ≤ 1,5 × entrée » (⇒ barre la plus haute ≥ 2/3 de la
 * hauteur, jamais un graphe à moitié vide).
 */
import { describe, expect, it } from "vitest";

import { echelleNice } from "@/components/dashboard/echelle-nice";

describe("echelleNice", () => {
  it("1 135 000 → 1 500 000 (mantisse 1.135 → 1.5, palier intermédiaire)", () => {
    expect(echelleNice(1_135_000)).toBe(1_500_000);
  });

  it("400 → 400 (mantisse 4 : palier désormais exact, la barre remplit la hauteur)", () => {
    expect(echelleNice(400)).toBe(400);
  });

  it("5 200 000 → 6 000 000 (mantisse 5.2 → 6 : ne saute plus à 10, ~87 % de fill)", () => {
    expect(echelleNice(5_200_000)).toBe(6_000_000);
  });

  it("3 100 → 4 000 (mantisse 3.1 → 4, palier intermédiaire)", () => {
    expect(echelleNice(3_100)).toBe(4_000);
  });

  it("7 000 → 8 000 (mantisse 7 → 8, palier intermédiaire)", () => {
    expect(echelleNice(7_000)).toBe(8_000);
  });

  it("0 → 1 (plafond sûr non nul, pas de division par zéro en aval)", () => {
    expect(echelleNice(0)).toBe(1);
  });

  it("NaN → 1 (fenêtre vide / valeur non exploitable, fail-safe)", () => {
    expect(echelleNice(NaN)).toBe(1);
  });

  it("valeur négative → 1 (fail-safe, jamais de plafond négatif)", () => {
    expect(echelleNice(-5)).toBe(1);
  });

  it("Infinity → 1 (fail-safe, entrée non finie)", () => {
    expect(echelleNice(Infinity)).toBe(1);
  });

  it("1 → 1 (déjà un palier nice)", () => {
    expect(echelleNice(1)).toBe(1);
  });

  it("50 → 50 (déjà un palier nice, cas « pile » sans dérive flottante)", () => {
    expect(echelleNice(50)).toBe(50);
  });

  it("230 → 250 (mantisse 2.3 → 2.5)", () => {
    expect(echelleNice(230)).toBe(250);
  });

  it("8 100 000 → 10 000 000 (passage de décade : mantisse 8.1 → 10, soit 1×10^7)", () => {
    expect(echelleNice(8_100_000)).toBe(10_000_000);
  });

  it("le résultat est toujours ≥ l'entrée quand l'entrée est finie et > 0", () => {
    const echantillon = [1, 2, 9, 10, 99, 100, 250, 999, 1_000, 12_345, 999_999, 1_135_000, 6_000_000];
    for (const valeur of echantillon) {
      expect(echelleNice(valeur)).toBeGreaterThanOrEqual(valeur);
    }
  });

  it("anti-vide : le plafond ne dépasse jamais 1,5 × l'entrée (barre haute ≥ 2/3)", () => {
    const echantillon = [
      1.0001, 1.49, 1.51, 2.01, 2.6, 3.01, 4.01, 5.01, 6.01, 8.01, 9.9,
      1_050, 5_200_000, 999_999,
    ];
    for (const valeur of echantillon) {
      expect(echelleNice(valeur)).toBeLessThanOrEqual(valeur * 1.5);
    }
  });
});
