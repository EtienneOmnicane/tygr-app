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
  formaterMoisAnnee,
} from "@/lib/format-date";

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
