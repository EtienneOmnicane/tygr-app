/**
 * Formatage d'affichage des dates comptables (colonne Date de /transactions).
 * Vérifie : pas de décalage de fuseau (la date « nue » Maurice est restituée telle
 * quelle, indépendamment du fuseau de la machine de test), forme valide, défense.
 */
import { describe, expect, it } from "vitest";

import {
  estDateISO,
  formaterDateComptable,
  formaterDateComptableLongue,
  formaterDateCourteNumerique,
  formaterFraicheurRelative,
  formaterMoisAnnee,
} from "@/lib/format-date";

/** Maintenant fixe pour des tests de fraîcheur déterministes (injecté). */
const MAINTENANT = new Date("2026-06-22T12:00:00Z");
/** Décale `MAINTENANT` de `h` heures dans le passé. */
const ilYa = (h: number) => new Date(MAINTENANT.getTime() - h * 3_600_000);

describe("estDateISO", () => {
  it("accepte une date YYYY-MM-DD valide", () => {
    expect(estDateISO("2026-06-11")).toBe(true);
    expect(estDateISO("2026-01-01")).toBe(true);
    expect(estDateISO("2026-12-31")).toBe(true);
  });

  it("rejette les formes invalides", () => {
    expect(estDateISO("2026-6-11")).toBe(false); // pas de zéro-padding
    expect(estDateISO("11/06/2026")).toBe(false);
    expect(estDateISO("")).toBe(false);
    expect(estDateISO("2026-13-01")).toBe(false); // mois 13
    expect(estDateISO("2026-02-30")).toBe(false); // jour roulé (30 fév.)
  });
});

describe("formaterDateComptable", () => {
  it("formate jour + mois court en français", () => {
    expect(formaterDateComptable("2026-06-11")).toBe("11 juin");
    expect(formaterDateComptable("2026-01-01")).toBe("1 janv.");
  });

  it("ne décale PAS la date (pas d'interprétation fuseau local)", () => {
    // Le 1er du mois ne doit jamais retomber au dernier jour du mois précédent,
    // quel que soit le fuseau de la machine de test (le piège new Date('YYYY-MM-DD')
    // = UTC minuit interprété en local).
    expect(formaterDateComptable("2026-03-01")).toBe("1 mars");
    expect(formaterDateComptable("2026-12-31")).toBe("31 déc.");
  });

  it("rend l'entrée telle quelle si invalide (défense)", () => {
    expect(formaterDateComptable("pas-une-date")).toBe("pas-une-date");
  });
});

describe("formaterDateComptableLongue", () => {
  it("ajoute l'année", () => {
    expect(formaterDateComptableLongue("2026-06-11")).toBe("11 juin 2026");
  });
});

describe("formaterDateCourteNumerique", () => {
  it("formate en JJ/MM/AAAA zéro-paddé", () => {
    expect(formaterDateCourteNumerique("2026-06-12")).toBe("12/06/2026");
    expect(formaterDateCourteNumerique("2026-01-01")).toBe("01/01/2026");
  });

  it("ne décale PAS la date (pas d'interprétation fuseau local)", () => {
    // Même piège que formaterDateComptable : le 1er ne doit jamais retomber la veille.
    expect(formaterDateCourteNumerique("2026-03-01")).toBe("01/03/2026");
    expect(formaterDateCourteNumerique("2026-12-31")).toBe("31/12/2026");
  });

  it("rend l'entrée telle quelle si invalide (défense)", () => {
    expect(formaterDateCourteNumerique("pas-une-date")).toBe("pas-une-date");
  });
});

describe("formaterMoisAnnee", () => {
  it("formate YYYY-MM en « Mois Année » FR", () => {
    expect(formaterMoisAnnee("2026-06")).toBe("Juin 2026");
    expect(formaterMoisAnnee("2026-01")).toBe("Janvier 2026");
    expect(formaterMoisAnnee("2026-12")).toBe("Décembre 2026");
  });

  it("rend l'entrée telle quelle si forme ou mois invalides (défense)", () => {
    expect(formaterMoisAnnee("2026-13")).toBe("2026-13"); // mois 13
    expect(formaterMoisAnnee("2026-00")).toBe("2026-00"); // mois 00
    expect(formaterMoisAnnee("2026-06-11")).toBe("2026-06-11"); // pas un YYYY-MM
    expect(formaterMoisAnnee("juin")).toBe("juin");
  });
});

describe("formaterFraicheurRelative — seuils §3.7", () => {
  it("<6h → niveau « frais » (success)", () => {
    expect(formaterFraicheurRelative(ilYa(2), MAINTENANT).niveau).toBe("frais");
    // Borne haute exclusive : 5h59 est encore frais.
    expect(
      formaterFraicheurRelative(ilYa(5.98), MAINTENANT).niveau,
    ).toBe("frais");
  });

  it("[6h, 24h) → niveau « recent » (warning), bornes incluses/exclues", () => {
    // Pile 6h bascule en recent (seuil < 6h pour rester frais).
    expect(formaterFraicheurRelative(ilYa(6), MAINTENANT).niveau).toBe("recent");
    expect(formaterFraicheurRelative(ilYa(23), MAINTENANT).niveau).toBe("recent");
  });

  it("≥24h → niveau « perime » (danger, CTA Reconnecter)", () => {
    expect(formaterFraicheurRelative(ilYa(24), MAINTENANT).niveau).toBe("perime");
    expect(formaterFraicheurRelative(ilYa(72), MAINTENANT).niveau).toBe("perime");
  });

  it("libellé relatif FR : heures puis jours", () => {
    expect(formaterFraicheurRelative(ilYa(2), MAINTENANT).libelle).toBe(
      "il y a 2 heures",
    );
    expect(formaterFraicheurRelative(ilYa(48), MAINTENANT).libelle).toBe(
      "avant-hier",
    );
    expect(formaterFraicheurRelative(ilYa(72), MAINTENANT).libelle).toBe(
      "il y a 3 jours",
    );
  });

  it("moins d'une heure → « à l’instant » (jamais « il y a 0 h »)", () => {
    expect(formaterFraicheurRelative(ilYa(0.2), MAINTENANT).libelle).toBe(
      "à l’instant",
    );
  });

  it("delta NÉGATIF (horloge client en avance) borné à 0 → « à l’instant »", () => {
    const futur = new Date(MAINTENANT.getTime() + 3_600_000);
    const f = formaterFraicheurRelative(futur, MAINTENANT);
    expect(f.niveau).toBe("frais");
    expect(f.libelle).toBe("à l’instant");
  });

  it("horodatage absolu converti à Maurice (Indian/Mauritius, UTC+4)", () => {
    // 08:00 UTC = 12:00 à Maurice ; date numérique FR.
    const f = formaterFraicheurRelative(
      new Date("2026-06-12T08:00:00Z"),
      MAINTENANT,
    );
    expect(f.horodatageAbsolu).toContain("12/06/2026");
    expect(f.horodatageAbsolu).toContain("12:00");
  });
});
