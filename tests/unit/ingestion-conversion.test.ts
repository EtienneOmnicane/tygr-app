/**
 * Conversions d'ingestion (règle 8 montants sans float, E20 date Maurice).
 */
import { describe, expect, it } from "vitest";

import {
  deriverDateComptableMaurice,
  INSTITUTION_NAME_MAX,
  normaliserMontant,
  normaliserNomInstitution,
  normaliserSoldeCourant,
  validerCreditDebit,
} from "@/server/ingestion/conversion";
import { OmniFiInvalidResponseError } from "@/server/omnifi";

describe("normaliserMontant (règle 8 — sans float)", () => {
  it("normalise les formes valides en numeric(15,2)", () => {
    expect(normaliserMontant("1500.00")).toBe("1500.00");
    expect(normaliserMontant("1500")).toBe("1500.00");
    expect(normaliserMontant("0.5")).toBe("0.50");
    expect(normaliserMontant("007.10")).toBe("7.10");
    expect(normaliserMontant("9999999999999.99")).toBe("9999999999999.99");
  });

  it("accepte les décimales >2 SI elles sont nulles (format API 4 décimales)", () => {
    // L'API Omni-FI renvoie « 750.0000 » : décimales 3-4 nulles → zéro perte.
    expect(normaliserMontant("750.0000")).toBe("750.00");
    expect(normaliserMontant("65000.0000")).toBe("65000.00");
    expect(normaliserMontant("0.5000")).toBe("0.50");
    expect(normaliserMontant("12.340")).toBe("12.34");
  });

  it("rejette >2 décimales SIGNIFICATIVES (pas d'arrondi caché, règle 8)", () => {
    for (const perte of ["1.234", "12.3456", "0.001", "5.005"]) {
      expect(() => normaliserMontant(perte)).toThrow(OmniFiInvalidResponseError);
    }
  });

  it("rejette les formes non conformes (pas de coercition silencieuse)", () => {
    for (const mauvais of ["", "-5.00", "abc", "1,50", "1e3", " "]) {
      expect(() => normaliserMontant(mauvais)).toThrow(OmniFiInvalidResponseError);
    }
  });
});

describe("deriverDateComptableMaurice (E20 — Indian/Mauritius, UTC+4)", () => {
  it("une transaction à 22h UTC tombe le LENDEMAIN à Maurice", () => {
    // 2026-06-10T22:00:00Z + 4h = 2026-06-11T02:00 Maurice
    expect(deriverDateComptableMaurice("2026-06-10T22:00:00Z")).toBe("2026-06-11");
  });

  it("une transaction le matin UTC reste le même jour à Maurice", () => {
    expect(deriverDateComptableMaurice("2026-06-10T05:30:00Z")).toBe("2026-06-10");
  });

  it("gère un offset explicite dans l'ISO", () => {
    // 2026-06-10T23:00:00+00:00 → 03:00 Maurice le 11
    expect(deriverDateComptableMaurice("2026-06-10T23:00:00+00:00")).toBe("2026-06-11");
  });

  // Bornes de fuseau EOD (PLAN-treso-eod.md §7-A) : minuit Maurice = 20:00:00 UTC.
  // La bascule EXACTE est le cas décisif — 22 h la franchit déjà largement.
  it("bascule −1 s : 19:59:59Z reste le jour J", () => {
    expect(deriverDateComptableMaurice("2026-07-22T19:59:59Z")).toBe("2026-07-22");
  });

  it("bascule EXACTE : 20:00:00Z bascule au jour J+1 (minuit Maurice)", () => {
    expect(deriverDateComptableMaurice("2026-07-22T20:00:00Z")).toBe("2026-07-23");
  });

  it("franchissement d'ANNÉE : 2026-12-31T20:00:00Z → 2027-01-01", () => {
    expect(deriverDateComptableMaurice("2026-12-31T20:00:00Z")).toBe("2027-01-01");
  });

  it("offset non-UTC équivalent : 23:00:00+02:00 (= 21:00Z) → lendemain Maurice", () => {
    expect(deriverDateComptableMaurice("2026-07-22T23:00:00+02:00")).toBe("2026-07-23");
  });

  it("rejette un horodatage illisible", () => {
    expect(() => deriverDateComptableMaurice("pas-une-date")).toThrow(
      OmniFiInvalidResponseError,
    );
  });
});

describe("normaliserSoldeCourant (RunningBalance — NON-levant, §5.4)", () => {
  it("normalise un solde positif", () => {
    expect(normaliserSoldeCourant("1500.00")).toBe("1500.00");
    expect(normaliserSoldeCourant("750.0000")).toBe("750.00"); // 4 déc. nulles OK
    expect(normaliserSoldeCourant("007.5")).toBe("7.50"); // zéros de tête + padding
  });

  it("accepte un solde NÉGATIF (découvert) — contrairement à normaliserMontant", () => {
    expect(normaliserSoldeCourant("-2500.50")).toBe("-2500.50");
    expect(normaliserSoldeCourant("-0.0000")).toBe("0.00"); // pas de « -0.00 »
  });

  it("zéro et bornes de décimales", () => {
    expect(normaliserSoldeCourant("0")).toBe("0.00");
    expect(normaliserSoldeCourant("42")).toBe("42.00");
  });

  it("NE LÈVE JAMAIS : >2 décimales significatives → null (pas une exception)", () => {
    // normaliserMontant LÈVE ici ; ce champ accessoire ne doit pas faire perdre la page.
    expect(normaliserSoldeCourant("12.3456")).toBeNull();
    expect(() => normaliserMontant("12.3456")).toThrow(OmniFiInvalidResponseError);
  });

  it("forme inattendue / vide / non-string → null", () => {
    expect(normaliserSoldeCourant("abc")).toBeNull();
    expect(normaliserSoldeCourant("")).toBeNull();
    expect(normaliserSoldeCourant("1,500.00")).toBeNull();
    expect(normaliserSoldeCourant(null)).toBeNull();
    expect(normaliserSoldeCourant(undefined)).toBeNull();
  });
});

describe("validerCreditDebit", () => {
  it("accepte Credit/Debit, rejette le reste", () => {
    expect(validerCreditDebit("Credit")).toBe("Credit");
    expect(validerCreditDebit("Debit")).toBe("Debit");
    expect(() => validerCreditDebit("Other")).toThrow(OmniFiInvalidResponseError);
  });
});

describe("normaliserNomInstitution (DASH-INST1 — string libre amont, défensif)", () => {
  it("conserve un nom normal", () => {
    expect(normaliserNomInstitution("Absa Internet Banking")).toBe("Absa Internet Banking");
  });

  it("trim les espaces de bord", () => {
    expect(normaliserNomInstitution("  MCB  ")).toBe("MCB");
  });

  it("absent / vide / blanc → null (colonne nullable, l'UI dégrade)", () => {
    expect(normaliserNomInstitution(null)).toBeNull();
    expect(normaliserNomInstitution(undefined)).toBeNull();
    expect(normaliserNomInstitution("")).toBeNull();
    expect(normaliserNomInstitution("   ")).toBeNull();
  });

  it("non-string (réponse amont inattendue) → null sans throw", () => {
    expect(normaliserNomInstitution(42 as never)).toBeNull();
    expect(normaliserNomInstitution({} as never)).toBeNull();
  });

  it("tronque au-delà de la longueur de colonne (jamais d'insert qui dépasse)", () => {
    const long = "X".repeat(INSTITUTION_NAME_MAX + 50);
    const out = normaliserNomInstitution(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(INSTITUTION_NAME_MAX);
  });
});
