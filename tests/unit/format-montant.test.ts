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

import {
  estNegatif,
  estZero,
  formatMontant,
  indicateurDevise,
  montantNu,
} from "@/lib/format-montant";

const NB = " "; // espace fine insécable

describe("formatMontant — devise en préfixe symbolique (audit 2026-06-22)", () => {
  it("MUR → préfixe « Rs » séparé par une espace fine insécable", () => {
    expect(formatMontant("7691000.00", "MUR")).toBe(
      `Rs${NB}7${NB}691${NB}000,00`,
    );
  });

  it("USD → préfixe « $ »", () => {
    expect(formatMontant("500", "USD")).toBe(`$${NB}500,00`);
  });

  it("EUR → préfixe « € »", () => {
    expect(formatMontant("12.5", "EUR")).toBe(`€${NB}12,50`);
  });

  it("code en minuscules est reconnu (insensible à la casse)", () => {
    expect(formatMontant("500", "mur")).toBe(`Rs${NB}500,00`);
  });

  it("REPLI : devise inconnue → code ISO en SUFFIXE", () => {
    expect(formatMontant("1200", "ZAR")).toBe(`1${NB}200,00${NB}ZAR`);
  });

  it("devise vide → montant NU (aucune espace parasite — saisie d'input)", () => {
    // split-allocation-modal s'appuie sur ce contrat (montantSaisi nu).
    expect(formatMontant("100", "")).toBe("100,00");
    expect(formatMontant("100", "  ")).toBe("100,00");
  });
});

describe("formatMontant — bornes financières (anti-float, signe, zéro)", () => {
  it("préserve les centimes EXACTS sur un gros montant (anti-float)", () => {
    // 9 007 199 254 740 993 dépasse Number.MAX_SAFE_INTEGER : un parseFloat
    // perdrait le dernier chiffre. Le formatage sur chaîne le garde intact.
    expect(formatMontant("9007199254740993.01", "MUR")).toBe(
      `Rs${NB}9${NB}007${NB}199${NB}254${NB}740${NB}993,01`,
    );
  });

  it("rend le signe moins typographique pour un négatif (préfixe AVANT le signe)", () => {
    expect(formatMontant("-384250.00", "MUR")).toBe(`Rs${NB}−384${NB}250,00`);
  });

  it("ajoute un + avec signeExplicite sur un positif non nul", () => {
    expect(formatMontant("1530000.00", "MUR", { signeExplicite: true })).toBe(
      `Rs${NB}+1${NB}530${NB}000,00`,
    );
  });

  it("n'ajoute PAS de + sur zéro même avec signeExplicite", () => {
    expect(formatMontant("0", "MUR", { signeExplicite: true })).toBe(
      `Rs${NB}0,00`,
    );
  });

  it("n'ajoute PAS de − sur un zéro SIGNÉ « -0.00 » (règle « zéro sans signe »)", () => {
    // Un zéro signé (sortie FX / arrondi) ne doit jamais afficher « −0,00 ».
    expect(formatMontant("-0.00", "MUR")).toBe(`Rs${NB}0,00`);
  });

  it("gère les petits montants sous 1000 sans séparateur", () => {
    expect(formatMontant("42.00", "MUR")).toBe(`Rs${NB}42,00`);
  });
});

describe("indicateurDevise — étiquette de gauche unifiée (UI-SOLDE-MULTIDEVISE-POLISH1)", () => {
  it("devise connue → SYMBOLE (Rs/$/€)", () => {
    expect(indicateurDevise("MUR")).toBe("Rs");
    expect(indicateurDevise("USD")).toBe("$");
    expect(indicateurDevise("EUR")).toBe("€");
  });

  it("devise SANS symbole → CODE ISO en majuscules (plus de suffixe inline)", () => {
    expect(indicateurDevise("GBP")).toBe("GBP");
    expect(indicateurDevise("ZAR")).toBe("ZAR");
  });

  it("normalise la casse et l'espace autour du code", () => {
    expect(indicateurDevise("mur")).toBe("Rs");
    expect(indicateurDevise("  gbp  ")).toBe("GBP");
  });

  it("devise vide → null (aucun indicateur, contexte de saisie)", () => {
    expect(indicateurDevise("")).toBeNull();
    expect(indicateurDevise("   ")).toBeNull();
  });
});

describe("montantNu — corps sans indicateur, décimales alignables", () => {
  it("montant nu, aucune espace parasite ni symbole", () => {
    expect(montantNu("7691000.00")).toBe(`7${NB}691${NB}000,00`);
  });

  it("cas ZÉRO → « 0,00 » sans signe", () => {
    expect(montantNu("0")).toBe("0,00");
    expect(montantNu("-0.00")).toBe("0,00");
  });

  it("préserve le signe typographique moins (négatif)", () => {
    expect(montantNu("-384250.00")).toBe(`−384${NB}250,00`);
  });

  it("relaie signeExplicite (+ sur positif non nul)", () => {
    expect(montantNu("25500.00", { signeExplicite: true })).toBe(
      `+25${NB}500,00`,
    );
    // ...mais jamais de + sur zéro.
    expect(montantNu("0", { signeExplicite: true })).toBe("0,00");
  });

  it("identique à formatMontant(_, \"\") — délégation, zéro divergence", () => {
    for (const v of ["7691000.00", "-384250.00", "0", "-0.00", "42.5"]) {
      expect(montantNu(v)).toBe(formatMontant(v, ""));
    }
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
