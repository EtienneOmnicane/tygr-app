/**
 * Calcul des bornes de période (L8c). Vérifie le mapping preset→bornes PUR : presets
 * connus, défaut de non-régression (valeur inconnue/absente → 6m), preset « tout »
 * (plancher 1re partition), invariants from ≤ to et nbMois ≥ 1, et le fuseau Maurice
 * (un instant UTC de fin de mois tombe le mois suivant à Maurice). `maintenant` est
 * injecté → aucun mock de Date global.
 */
import { describe, expect, it } from "vitest";

import {
  PLANCHER_HISTORIQUE,
  PRESET_DEFAUT,
  aujourdhuiMaurice,
  nbMoisEntre,
  normaliserPreset,
  premierJourMoisRecul,
  resoudrePeriode,
} from "@/lib/periode";

/** Mi-journée le 15 juin 2026 UTC → 16:00 à Maurice, toujours le 15. */
const MAINTENANT = new Date("2026-06-15T12:00:00Z");

describe("aujourdhuiMaurice", () => {
  it("retourne la date Maurice YYYY-MM-DD", () => {
    expect(aujourdhuiMaurice(MAINTENANT)).toBe("2026-06-15");
  });

  it("bascule au jour suivant pour un instant UTC tardif (UTC+4)", () => {
    // 30 juin 22:00 UTC = 1er juillet 02:00 à Maurice → date comptable = 2026-07-01.
    expect(aujourdhuiMaurice(new Date("2026-06-30T22:00:00Z"))).toBe("2026-07-01");
  });
});

describe("premierJourMoisRecul", () => {
  it("recule de N mois et renvoie le 1er du mois", () => {
    expect(premierJourMoisRecul("2026-06", 5)).toBe("2026-01-01");
    expect(premierJourMoisRecul("2026-06", 0)).toBe("2026-06-01");
  });

  it("franchit l'année (débordement normalisé)", () => {
    expect(premierJourMoisRecul("2026-02", 3)).toBe("2025-11-01");
    expect(premierJourMoisRecul("2026-01", 1)).toBe("2025-12-01");
  });
});

describe("nbMoisEntre", () => {
  it("compte les mois inclusivement", () => {
    expect(nbMoisEntre("2024-01-01", "2026-06")).toBe(30); // 2024(12)+2025(12)+jan..juin(6)
    expect(nbMoisEntre("2026-06-01", "2026-06")).toBe(1); // même mois
  });

  it("borne à au moins 1 (jamais 0/négatif pour syntheseParMois)", () => {
    expect(nbMoisEntre("2026-12-01", "2026-06")).toBe(1);
  });
});

describe("normaliserPreset", () => {
  it("accepte les presets de la liste blanche", () => {
    for (const p of ["ce-mois", "3m", "6m", "12m", "tout"] as const) {
      expect(normaliserPreset(p)).toBe(p);
    }
  });

  it("retombe sur le défaut 6m pour toute valeur hors liste", () => {
    expect(normaliserPreset(undefined)).toBe(PRESET_DEFAUT);
    expect(normaliserPreset("")).toBe(PRESET_DEFAUT);
    expect(normaliserPreset("annee")).toBe(PRESET_DEFAUT);
    expect(normaliserPreset(["3m", "6m"])).toBe(PRESET_DEFAUT); // tableau → défaut
  });

  it("est STRICT sur la casse/les espaces (URL forgée par notre UI)", () => {
    expect(normaliserPreset("6M")).toBe(PRESET_DEFAUT);
    expect(normaliserPreset(" 6m ")).toBe(PRESET_DEFAUT);
    expect(normaliserPreset("CE-MOIS")).toBe(PRESET_DEFAUT);
  });
});

describe("resoudrePeriode", () => {
  it("ce-mois → 1 mois, from = 1er du mois courant", () => {
    const r = resoudrePeriode("ce-mois", MAINTENANT);
    expect(r).toMatchObject({
      preset: "ce-mois",
      nbMois: 1,
      from: "2026-06-01",
      to: "2026-06-15",
      moisAncrage: "2026-06",
    });
  });

  it("3m / 6m / 12m → bornes basses correctes", () => {
    expect(resoudrePeriode("3m", MAINTENANT).from).toBe("2026-04-01"); // -2 mois
    expect(resoudrePeriode("6m", MAINTENANT).from).toBe("2026-01-01"); // -5 mois
    expect(resoudrePeriode("12m", MAINTENANT).from).toBe("2025-07-01"); // -11 mois
  });

  it("défaut (absent/invalide) = 6m, identique au comportement historique", () => {
    const ref = resoudrePeriode("6m", MAINTENANT);
    expect(resoudrePeriode(undefined, MAINTENANT)).toEqual(ref);
    expect(resoudrePeriode("bidon", MAINTENANT)).toEqual(ref);
    expect(ref.nbMois).toBe(6);
  });

  it("tout → plancher 1re partition, nbMois = mois écoulés depuis le plancher", () => {
    const r = resoudrePeriode("tout", MAINTENANT);
    expect(r.preset).toBe("tout");
    expect(r.from).toBe(PLANCHER_HISTORIQUE); // "2024-01-01"
    expect(r.to).toBe("2026-06-15");
    expect(r.nbMois).toBe(nbMoisEntre(PLANCHER_HISTORIQUE, "2026-06"));
    expect(r.nbMois).toBeGreaterThanOrEqual(1);
  });

  it("garantit toujours from ≤ to et nbMois ≥ 1 (contrats des repos)", () => {
    for (const p of ["ce-mois", "3m", "6m", "12m", "tout", "xxx"] as const) {
      const r = resoudrePeriode(p, MAINTENANT);
      expect(r.from <= r.to).toBe(true);
      expect(r.nbMois).toBeGreaterThanOrEqual(1);
    }
  });
});
