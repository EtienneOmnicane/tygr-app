/**
 * Table de correspondance catégories OBIE → français (DR-F1, Lot 3).
 * Fonction pure : on vérifie le mapping connu, l'insensibilité à la casse / aux
 * espaces, et SURTOUT le filet anti-anglais — toute clé inconnue ou nulle retombe
 * sur « Non catégorisé », jamais une fuite de libellé anglais à l'écran.
 */
import { describe, expect, it } from "vitest";

import { categorieFr, CATEGORIE_FR_PAR_DEFAUT } from "@/lib/categories-fr";

describe("categorieFr — correspondance OBIE → français", () => {
  it("traduit les catégories OBIE connues du seed de démo", () => {
    expect(categorieFr("Income")).toBe("Revenus");
    expect(categorieFr("Rent")).toBe("Loyer");
    expect(categorieFr("Utilities")).toBe("Charges");
    expect(categorieFr("Insurance")).toBe("Assurances");
    expect(categorieFr("Taxes")).toBe("Taxes");
    expect(categorieFr("Payroll")).toBe("Salaires");
    expect(categorieFr("Banking & Finance")).toBe("Frais bancaires");
  });

  it("résout aussi une sous-catégorie fréquente (robustesse)", () => {
    expect(categorieFr("Bank Charges")).toBe("Frais bancaires");
  });

  it("est insensible à la casse et aux espaces parasites", () => {
    expect(categorieFr("income")).toBe("Revenus");
    expect(categorieFr("UTILITIES")).toBe("Charges");
    expect(categorieFr("  Rent  ")).toBe("Loyer");
    expect(categorieFr("banking & finance")).toBe("Frais bancaires");
  });

  it("retombe sur « Non catégorisé » pour null, undefined ou chaîne vide", () => {
    expect(categorieFr(null)).toBe(CATEGORIE_FR_PAR_DEFAUT);
    expect(categorieFr(undefined)).toBe(CATEGORIE_FR_PAR_DEFAUT);
    expect(categorieFr("")).toBe(CATEGORIE_FR_PAR_DEFAUT);
    expect(categorieFr("   ")).toBe(CATEGORIE_FR_PAR_DEFAUT);
  });

  it("ne laisse JAMAIS fuir un libellé anglais inconnu (filet anti-anglais)", () => {
    // Une catégorie OBIE non cartographiée ne doit pas s'afficher telle quelle.
    expect(categorieFr("Entertainment")).toBe(CATEGORIE_FR_PAR_DEFAUT);
    expect(categorieFr("Groceries")).toBe(CATEGORIE_FR_PAR_DEFAUT);
  });

  it("le défaut est bien un libellé français", () => {
    expect(CATEGORIE_FR_PAR_DEFAUT).toBe("Non catégorisé");
  });
});
