/**
 * Formatage monétaire (Epic 3) — fonctions pures, anti-float (CLAUDE.md règle 8).
 * On vérifie surtout : aucune perte de précision sur de gros montants (un
 * parseFloat les arrondirait), groupement FR, signe, et les helpers de test.
 *
 * NB = espace fine insécable U+202F (séparateur de milliers FR utilisé par
 * `formatMontant`). On la nomme explicitement pour des assertions lisibles —
 * un espace ASCII normal ferait échouer la comparaison (c'est un caractère
 * différent, pas un détail d'affichage).
 */
import { describe, expect, it } from "vitest";

import { estNegatif, estZero, formatMontant } from "@/lib/format-montant";

const NB = " "; // espace fine insécable

describe("formatMontant", () => {
  it("groupe les milliers et met la virgule décimale FR", () => {
    expect(formatMontant("7691000.00", "MUR")).toBe(
      `7${NB}691${NB}000,00${NB}MUR`,
    );
  });

  it("préserve les centimes EXACTS sur un gros montant (anti-float)", () => {
    // 9 007 199 254 740 993 dépasse Number.MAX_SAFE_INTEGER : un parseFloat
    // perdrait le dernier chiffre. Le formatage sur chaîne le garde intact.
    expect(formatMontant("9007199254740993.01", "MUR")).toBe(
      `9${NB}007${NB}199${NB}254${NB}740${NB}993,01${NB}MUR`,
    );
  });

  it("rend le signe moins typographique pour un négatif", () => {
    expect(formatMontant("-384250.00", "MUR")).toBe(`−384${NB}250,00${NB}MUR`);
  });

  it("ajoute un + avec signeExplicite sur un positif non nul", () => {
    expect(formatMontant("1530000.00", "MUR", { signeExplicite: true })).toBe(
      `+1${NB}530${NB}000,00${NB}MUR`,
    );
  });

  it("n'ajoute PAS de + sur zéro même avec signeExplicite", () => {
    expect(formatMontant("0", "MUR", { signeExplicite: true })).toBe(
      `0,00${NB}MUR`,
    );
  });

  it("normalise une valeur sans décimales à 2 décimales", () => {
    expect(formatMontant("500", "USD")).toBe(`500,00${NB}USD`);
  });

  it("normalise une décimale à un seul chiffre", () => {
    expect(formatMontant("12.5", "EUR")).toBe(`12,50${NB}EUR`);
  });

  it("gère les petits montants sous 1000 sans séparateur", () => {
    expect(formatMontant("42.00", "MUR")).toBe(`42,00${NB}MUR`);
  });
});

describe("estNegatif", () => {
  it("détecte le signe sur la chaîne", () => {
    expect(estNegatif("-1.00")).toBe(true);
    expect(estNegatif("1.00")).toBe(false);
    expect(estNegatif("0")).toBe(false);
  });
});

describe("estZero", () => {
  it("reconnaît les formes de zéro", () => {
    expect(estZero("0")).toBe(true);
    expect(estZero("0.00")).toBe(true);
    expect(estZero("-0.00")).toBe(true);
  });
  it("ne confond pas un petit montant avec zéro", () => {
    expect(estZero("0.01")).toBe(false);
  });
});
