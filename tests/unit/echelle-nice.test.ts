/**
 * `echelleNice` — verrouille le contrat de l'arrondi « nice » (mantisse ∈
 * {1, 2, 2.5, 5} × 10^n, toujours ≥ à l'entrée) utilisé pour poser des bornes d'axe
 * lisibles sur le graphe de flux (barres + courbe). Fonction PURE (géométrie d'axe
 * uniquement, règle 8), donc testable directement sans DB ni rendu.
 *
 * Invariants couverts : chemin heureux (arrondi au palier supérieur), passage de
 * décade (mantisse proche de 10 → 1×10^(n+1)), fail-safe (0/NaN/négatif → plafond
 * sûr non nul), et la propriété générale « résultat ≥ entrée » sur un échantillon.
 */
import { describe, expect, it } from "vitest";

import { echelleNice } from "@/components/dashboard/echelle-nice";

describe("echelleNice", () => {
  it("1 135 000 → 2 000 000 (mantisse 1.135 → 2, 10^6)", () => {
    expect(echelleNice(1_135_000)).toBe(2_000_000);
  });

  it("400 → 500 (mantisse 4 → 5, une barre unique ne remplit pas toute la hauteur)", () => {
    expect(echelleNice(400)).toBe(500);
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

  it("6 000 000 → 10 000 000 (passage de décade : mantisse 6 → 10, soit 1×10^7)", () => {
    expect(echelleNice(6_000_000)).toBe(10_000_000);
  });

  it("le résultat est toujours ≥ l'entrée quand l'entrée est finie et > 0", () => {
    const echantillon = [1, 2, 9, 10, 99, 100, 250, 999, 1_000, 12_345, 999_999, 1_135_000, 6_000_000];
    for (const valeur of echantillon) {
      expect(echelleNice(valeur)).toBeGreaterThanOrEqual(valeur);
    }
  });
});
