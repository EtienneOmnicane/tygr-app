/**
 * Visibilité des séries de flux (légende interactive, L1) + échelle filtrée.
 *
 * Deux invariants prouvés ici, qu'aucun gate (lint/tsc) ne voit :
 *  1. on ne peut JAMAIS masquer la dernière série visible (le graphe ne devient pas un
 *     cadre vide) — `basculerVisibilite` refuse et rend l'ensemble INCHANGÉ ;
 *  2. une série masquée SORT de l'échelle (`maxFenetreVisible`) — sinon une série cachée
 *     mais grande écraserait la série restante (PLAN-graphs-fygr §9.1).
 */
import { describe, expect, it } from "vitest";

import {
  basculerVisibilite,
  estDerniereVisible,
  TOUTES_SERIES_VISIBLES,
  type VisibiliteSeries,
} from "@/components/charts/series-types";
import {
  maxFenetreVisible,
  type MoisAffiche,
} from "@/components/dashboard/flux-projection";

function ens(...ids: Array<"entrees" | "sorties">): VisibiliteSeries {
  return new Set(ids);
}

describe("basculerVisibilite", () => {
  it("masque une série quand une autre reste visible", () => {
    const apres = basculerVisibilite(TOUTES_SERIES_VISIBLES, "entrees");
    expect([...apres].sort()).toEqual(["sorties"]);
  });

  it("réaffiche une série masquée", () => {
    const apres = basculerVisibilite(ens("sorties"), "entrees");
    expect([...apres].sort()).toEqual(["entrees", "sorties"]);
  });

  it("REFUSE de masquer la dernière série visible (cadre vide interdit)", () => {
    const seule = ens("sorties");
    const apres = basculerVisibilite(seule, "sorties");
    // Ensemble inchangé (même contenu) : la bascule est un no-op.
    expect([...apres]).toEqual(["sorties"]);
    // Et c'est bien la MÊME référence (aucune copie inutile quand c'est refusé).
    expect(apres).toBe(seule);
  });
});

describe("estDerniereVisible", () => {
  it("vrai uniquement pour l'unique série visible", () => {
    expect(estDerniereVisible(ens("sorties"), "sorties")).toBe(true);
    expect(estDerniereVisible(ens("sorties"), "entrees")).toBe(false);
    expect(estDerniereVisible(ens("entrees", "sorties"), "sorties")).toBe(false);
  });
});

describe("maxFenetreVisible — une série masquée sort de l'échelle", () => {
  const mois: MoisAffiche[] = [
    {
      libelleMois: "2026-01",
      entrees: "1000.00",
      sorties: "50.00",
      variation: "950.00",
      autresDevises: false,
    },
    {
      libelleMois: "2026-02",
      entrees: "200.00",
      sorties: "80.00",
      variation: "120.00",
      autresDevises: false,
    },
  ];

  it("les deux séries → max global (entrées, 1000)", () => {
    expect(maxFenetreVisible(mois, true, true)).toBe(1000);
  });

  it("entrées MASQUÉES → l'échelle ne retient que les sorties (80), pas 1000", () => {
    expect(maxFenetreVisible(mois, false, true)).toBe(80);
  });

  it("sorties masquées → max des entrées (1000)", () => {
    expect(maxFenetreVisible(mois, true, false)).toBe(1000);
  });

  it("aucune série (cas défensif) → 0", () => {
    expect(maxFenetreVisible(mois, false, false)).toBe(0);
  });
});
