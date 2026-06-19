/**
 * Conversions d'ingestion (règle 8 montants sans float, E20 date Maurice).
 */
import { describe, expect, it } from "vitest";

import {
  deriverDateComptableMaurice,
  INSTITUTION_NAME_MAX,
  normaliserMontant,
  normaliserNomInstitution,
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

  it("rejette les formes non conformes (pas de coercition silencieuse)", () => {
    for (const mauvais of ["", "-5.00", "1.234", "abc", "1,50", "1e3", " "]) {
      expect(() => normaliserMontant(mauvais)).toThrow(OmniFiInvalidResponseError);
    }
  });
});

describe("deriverDateComptableMaurice (E20 — Asia/Port_Louis, UTC+4)", () => {
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

  it("rejette un horodatage illisible", () => {
    expect(() => deriverDateComptableMaurice("pas-une-date")).toThrow(
      OmniFiInvalidResponseError,
    );
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
