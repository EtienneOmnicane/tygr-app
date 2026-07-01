/**
 * `projeterPointsCourbe` — projection de la série mensuelle sur la grille CONTINUE,
 * rendue en `PointCashflow[]` pour la vue COURBE. Ces cas verrouillent le FIX « courbe
 * effondrée » : sur une fenêtre où un SEUL mois est peuplé, la fonction doit renvoyer N
 * points (un par mois de la grille), pas 1 — les mois vides à `net="0"`, dans l'ordre
 * chronologique de la grille. Fonction PURE (aucune DB), donc testable directement.
 *
 * Invariants couverts : cardinalité (= longueur de grille), comblement des mois vides,
 * mapping fidèle (bucket←libelleMois, net←variation, entrées/sorties recopiées, devise
 * de base), réduction mono-devise (une autre devise le même mois n'est jamais sommée).
 */
import { describe, expect, it } from "vitest";

import { projeterPointsCourbe } from "@/components/dashboard/flux-projection";
import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

const GRILLE_6 = [
  "2025-08",
  "2025-09",
  "2025-10",
  "2025-11",
  "2025-12",
  "2026-01",
];

describe("projeterPointsCourbe", () => {
  it("un seul mois peuplé + grille de 6 → 6 points (pas 1), mois vides à net=0", () => {
    // Cœur du bug : une série d'UN mois ne doit pas s'effondrer à un point.
    const serie: SyntheseMensuelle[] = [
      { mois: "2025-08", currency: "MUR", entrees: "1000", sorties: "400", variation: "600" },
    ];

    const points = projeterPointsCourbe(serie, GRILLE_6, "MUR");

    // Cardinalité = longueur de grille (axe pleine largeur, plus d'effondrement).
    expect(points).toHaveLength(6);
    // Ordre chronologique de la grille, buckets = libellés de mois.
    expect(points.map((p) => p.bucket)).toEqual(GRILLE_6);

    // Le mois peuplé porte ses valeurs (net ← variation, entrées/sorties recopiées).
    const aout = points[0];
    expect(aout).toMatchObject({
      bucket: "2025-08",
      currency: "MUR",
      entrees: "1000",
      sorties: "400",
      net: "600",
      nbTransactions: 0,
    });

    // Tous les autres mois sont comblés à zéro (jamais absents).
    for (const p of points.slice(1)) {
      expect(p).toMatchObject({ entrees: "0", sorties: "0", net: "0" });
    }
  });

  it("série vide → N points tous à zéro (état vide géré en aval par la carte)", () => {
    const points = projeterPointsCourbe([], GRILLE_6, "MUR");
    expect(points).toHaveLength(6);
    expect(points.every((p) => p.net === "0" && p.entrees === "0" && p.sorties === "0")).toBe(
      true,
    );
  });

  it("réduit à la devise de base : une autre devise le même mois n'est jamais sommée", () => {
    const serie: SyntheseMensuelle[] = [
      { mois: "2025-08", currency: "MUR", entrees: "1000", sorties: "0", variation: "1000" },
      { mois: "2025-08", currency: "USD", entrees: "9999", sorties: "0", variation: "9999" },
    ];
    const points = projeterPointsCourbe(serie, ["2025-08"], "MUR");
    expect(points).toHaveLength(1);
    // Seule la ligne MUR est retenue ; l'USD n'est pas additionné.
    expect(points[0]).toMatchObject({ currency: "MUR", entrees: "1000", net: "1000" });
  });

  it("plusieurs mois peuplés → mapping fidèle sur toute la grille, ordre préservé", () => {
    const serie: SyntheseMensuelle[] = [
      { mois: "2025-09", currency: "MUR", entrees: "200", sorties: "500", variation: "-300" },
      { mois: "2026-01", currency: "MUR", entrees: "800", sorties: "100", variation: "700" },
    ];
    const points = projeterPointsCourbe(serie, GRILLE_6, "MUR");
    expect(points).toHaveLength(6);
    // Un net négatif est restitué tel quel (chaîne), un mois plein aussi.
    expect(points.find((p) => p.bucket === "2025-09")?.net).toBe("-300");
    expect(points.find((p) => p.bucket === "2026-01")?.net).toBe("700");
    // Les mois sans donnée restent à zéro.
    expect(points.find((p) => p.bucket === "2025-08")?.net).toBe("0");
  });
});
