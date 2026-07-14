/**
 * Calcul des bornes de période (L8c + plage précise A1). Vérifie le mapping preset→bornes
 * PUR : presets connus, défaut de non-régression (valeur inconnue/absente → 6m), preset
 * « tout » (plancher 1re partition), invariants from ≤ to et nbMois ≥ 1, et le fuseau
 * Maurice (un instant UTC de fin de mois tombe le mois suivant à Maurice).
 *
 * ET la RÈGLE DU LOT A1 : une PLAGE EXPLICITE valide (?du/?au) PRIME sur le preset ; toute
 * plage inexploitable (incomplète, non calendaire, inversée, hors amplitude) REPLIE
 * silencieusement sur le preset. C'est cette bascule qui décide de ce que la page filtre
 * réellement — donc elle est testée aux bornes, pas seulement au cas nominal.
 *
 * `maintenant` est injecté → aucun mock de Date global.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_MOIS_PLAGE,
  PLANCHER_HISTORIQUE,
  PRESET_DEFAUT,
  aujourdhuiMaurice,
  dernierJourMois,
  lirePlage,
  nbMoisEntre,
  normaliserPreset,
  paramsPeriodeDepuisURL,
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

describe("resoudrePeriode — presets (non-régression L8c)", () => {
  it("ce-mois → 1 mois, from = 1er du mois courant", () => {
    const r = resoudrePeriode({ periode: "ce-mois" }, MAINTENANT);
    expect(r).toMatchObject({
      preset: "ce-mois",
      nbMois: 1,
      from: "2026-06-01",
      to: "2026-06-15",
      moisAncrage: "2026-06",
    });
  });

  it("3m / 6m / 12m → bornes basses correctes", () => {
    expect(resoudrePeriode({ periode: "3m" }, MAINTENANT).from).toBe("2026-04-01"); // -2 mois
    expect(resoudrePeriode({ periode: "6m" }, MAINTENANT).from).toBe("2026-01-01"); // -5 mois
    expect(resoudrePeriode({ periode: "12m" }, MAINTENANT).from).toBe("2025-07-01"); // -11 mois
  });

  it("défaut (absent/invalide) = 6m, identique au comportement historique", () => {
    const ref = resoudrePeriode({ periode: "6m" }, MAINTENANT);
    expect(resoudrePeriode({}, MAINTENANT)).toEqual(ref);
    expect(resoudrePeriode({ periode: "bidon" }, MAINTENANT)).toEqual(ref);
    expect(ref.nbMois).toBe(6);
  });

  it("tout → plancher 1re partition, nbMois = mois écoulés depuis le plancher", () => {
    const r = resoudrePeriode({ periode: "tout" }, MAINTENANT);
    expect(r.preset).toBe("tout");
    expect(r.from).toBe(PLANCHER_HISTORIQUE); // "2024-01-01"
    expect(r.to).toBe("2026-06-15");
    expect(r.nbMois).toBe(nbMoisEntre(PLANCHER_HISTORIQUE, "2026-06"));
    expect(r.nbMois).toBeGreaterThanOrEqual(1);
  });

  it("garantit toujours from ≤ to et nbMois ≥ 1 (contrats des repos)", () => {
    for (const p of ["ce-mois", "3m", "6m", "12m", "tout", "xxx"] as const) {
      const r = resoudrePeriode({ periode: p }, MAINTENANT);
      expect(r.from <= r.to).toBe(true);
      expect(r.nbMois).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("lirePlage — validation de ?du/?au (source unique, serveur ET UI)", () => {
  it("accepte une plage complète et calendaire", () => {
    expect(lirePlage({ du: "2026-03-03", au: "2026-04-17" })).toEqual({
      du: "2026-03-03",
      au: "2026-04-17",
    });
  });

  it("accepte une plage d'UN SEUL jour (du = au — bornes INCLUSIVES)", () => {
    expect(lirePlage({ du: "2026-03-03", au: "2026-03-03" })).toEqual({
      du: "2026-03-03",
      au: "2026-03-03",
    });
  });

  it("REJETTE une plage incomplète (un seul bord — on ne devine pas l'autre)", () => {
    expect(lirePlage({ du: "2026-03-03" })).toBeNull();
    expect(lirePlage({ au: "2026-04-17" })).toBeNull();
    expect(lirePlage({})).toBeNull();
    expect(lirePlage({ du: "", au: "" })).toBeNull();
  });

  it("REJETTE les bornes inversées (du > au)", () => {
    expect(lirePlage({ du: "2026-04-17", au: "2026-03-03" })).toBeNull();
  });

  it("REJETTE une date non calendaire (2026-02-30) ou hors format", () => {
    expect(lirePlage({ du: "2026-02-30", au: "2026-03-03" })).toBeNull();
    expect(lirePlage({ du: "2026-13-01", au: "2026-12-31" })).toBeNull();
    expect(lirePlage({ du: "03/03/2026", au: "17/04/2026" })).toBeNull();
    expect(lirePlage({ du: "hier", au: "aujourd'hui" })).toBeNull();
    expect(lirePlage({ du: "2026-3-3", au: "2026-4-17" })).toBeNull(); // non zéro-paddé
  });

  it("REJETTE un param dupliqué (tableau) — jamais « le premier gagne »", () => {
    expect(lirePlage({ du: ["2026-03-03"], au: "2026-04-17" })).toBeNull();
  });

  it("REJETTE une borne basse antérieure au plancher historique (1re partition)", () => {
    // Rien n'existe avant 2024-01-01 ; et une date « an 1 » forgée à la main produirait des
    // libellés de mois hors format dans la grille d'axe.
    expect(lirePlage({ du: "0001-01-01", au: "0010-12-31" })).toBeNull();
    expect(lirePlage({ du: "2023-12-31", au: "2026-06-15" })).toBeNull();
    expect(lirePlage({ du: PLANCHER_HISTORIQUE, au: "2026-06-15" })).not.toBeNull();
  });
});

describe("paramsPeriodeDepuisURL — l'UI lit l'URL COMME le serveur", () => {
  it("param simple → chaîne (donc plage valide des DEUX côtés)", () => {
    const sp = new URLSearchParams("periode=3m&du=2026-03-03&au=2026-04-17");
    expect(paramsPeriodeDepuisURL(sp)).toEqual({
      periode: "3m",
      du: "2026-03-03",
      au: "2026-04-17",
    });
    expect(lirePlage(paramsPeriodeDepuisURL(sp))).not.toBeNull();
  });

  it("param DUPLIQUÉ → tableau → REJETÉ, comme côté serveur (anti-divergence UI/serveur)", () => {
    // Le piège : `URLSearchParams.get()` rendrait « le premier » et l'UI se croirait sous
    // plage, pendant que Next livre un tableau au serveur → repli preset. Le contrôle se
    // serait allumé sur une plage que la page ignore. Un lien partagé suffisait.
    const sp = new URLSearchParams("du=2026-03-01&du=2026-04-01&au=2026-04-30");
    expect(paramsPeriodeDepuisURL(sp).du).toEqual(["2026-03-01", "2026-04-01"]);
    expect(lirePlage(paramsPeriodeDepuisURL(sp))).toBeNull();
  });

  it("param absent → undefined (et non chaîne vide)", () => {
    expect(paramsPeriodeDepuisURL(new URLSearchParams(""))).toEqual({
      periode: undefined,
      du: undefined,
      au: undefined,
    });
  });
});

describe("lirePlage — plafond d'amplitude (anti-abus, règle 3 : toute entrée est bornée)", () => {
  it("REJETTE une amplitude au-delà de MAX_MOIS_PLAGE", () => {
    // Le plafond borne la grille de tendance ET le GROUP BY côté SQL. Il ne peut être
    // franchi que « par le HAUT » (le plancher historique verrouille déjà la borne basse) :
    // un `?au` très lointain est le seul vecteur — c'est donc celui qu'on teste.
    // Bord EXACT : 120 mois inclusifs = janvier 2024 → décembre 2033 → accepté.
    expect(nbMoisEntre(PLANCHER_HISTORIQUE, "2033-12")).toBe(MAX_MOIS_PLAGE);
    expect(lirePlage({ du: PLANCHER_HISTORIQUE, au: "2033-12-31" })).not.toBeNull();
    // Un mois de plus → refusé.
    expect(lirePlage({ du: PLANCHER_HISTORIQUE, au: "2034-01-01" })).toBeNull();
  });
});

describe("dernierJourMois", () => {
  it("rend le dernier jour, y compris pour les mois courts et les années bissextiles", () => {
    expect(dernierJourMois("2026-06")).toBe("2026-06-30");
    expect(dernierJourMois("2026-01")).toBe("2026-01-31");
    expect(dernierJourMois("2026-02")).toBe("2026-02-28");
    expect(dernierJourMois("2024-02")).toBe("2024-02-29"); // bissextile
    expect(dernierJourMois("2026-12")).toBe("2026-12-31");
  });
});

describe("resoudrePeriode — la PLAGE EXPLICITE prime sur le preset (règle du lot A1)", () => {
  it("une plage valide devient from/to et NEUTRALISE le preset (preset: null)", () => {
    const r = resoudrePeriode(
      { periode: "12m", du: "2026-03-03", au: "2026-04-17" },
      MAINTENANT,
    );
    expect(r).toEqual({
      preset: null, // ← garde ANTI-MENSONGE : aucun preset ne s'applique
      from: "2026-03-03",
      to: "2026-04-17",
      moisAncrage: "2026-04", // mois de FIN de plage, pas le mois courant
      nbMois: 2, // mars + avril
    });
  });

  it("la plage prime même sur le preset le plus large (« tout »)", () => {
    const r = resoudrePeriode(
      { periode: "tout", du: "2026-06-01", au: "2026-06-30" },
      MAINTENANT,
    );
    expect(r.from).toBe("2026-06-01");
    expect(r.to).toBe("2026-06-30");
    expect(r.preset).toBeNull();
  });

  it("l'ancrage de tendance suit la FIN DE PLAGE, pas « aujourd'hui »", () => {
    // Plage entièrement dans le PASSÉ (MAINTENANT = 15 juin 2026) : la courbe doit
    // s'arrêter à la fin de la plage, sinon elle tracerait des mois hors période.
    const r = resoudrePeriode({ du: "2026-01-10", au: "2026-03-31" }, MAINTENANT);
    expect(r.moisAncrage).toBe("2026-03");
    expect(r.nbMois).toBe(3); // janvier, février, mars
    expect(r.to).toBe("2026-03-31"); // surtout PAS 2026-06-15
  });

  it("REPLI sur le preset dès que la plage est inexploitable", () => {
    const ref12m = resoudrePeriode({ periode: "12m" }, MAINTENANT);
    // Inversée, incomplète, non calendaire, dupliquée : dans TOUS les cas le preset reprend.
    expect(
      resoudrePeriode({ periode: "12m", du: "2026-04-17", au: "2026-03-03" }, MAINTENANT),
    ).toEqual(ref12m);
    expect(resoudrePeriode({ periode: "12m", du: "2026-03-03" }, MAINTENANT)).toEqual(ref12m);
    expect(
      resoudrePeriode({ periode: "12m", du: "2026-02-30", au: "2026-03-03" }, MAINTENANT),
    ).toEqual(ref12m);
    // Sans `?periode`, le repli est le DÉFAUT (6m) — jamais une plage inventée.
    const replisDefaut = resoudrePeriode({ du: "pas-une-date", au: "" }, MAINTENANT);
    expect(replisDefaut.preset).toBe(PRESET_DEFAUT);
    expect(replisDefaut).toEqual(resoudrePeriode({}, MAINTENANT));
  });

  it("garantit les MÊMES invariants de repo sur le chemin plage (from ≤ to, nbMois ≥ 1)", () => {
    const cas = [
      { du: "2026-06-15", au: "2026-06-15" }, // un seul jour
      { du: "2024-01-01", au: "2026-06-15" }, // large
      { du: "2026-04-17", au: "2026-03-03" }, // inversée → repli preset
    ];
    for (const c of cas) {
      const r = resoudrePeriode(c, MAINTENANT);
      expect(r.from <= r.to).toBe(true);
      expect(r.nbMois).toBeGreaterThanOrEqual(1);
    }
  });

  it("le chemin plage n'utilise AUCUNE horloge (mêmes bornes quel que soit `maintenant`)", () => {
    // Corollaire du fuseau : `du`/`au` sont des dates comptables Maurice données TELLES
    // QUELLES → aucun instant n'est converti, donc l'heure du serveur ne peut pas les
    // décaler d'un jour (le piège E20 ne s'applique qu'au chemin preset).
    const plage = { du: "2026-03-03", au: "2026-04-17" };
    const minuitMaurice = new Date("2026-06-30T20:00:00Z"); // = 1er juillet 00:00 à Maurice
    expect(resoudrePeriode(plage, MAINTENANT)).toEqual(
      resoudrePeriode(plage, minuitMaurice),
    );
  });
});
