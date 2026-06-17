/**
 * Contrat Zod de la catégorisation (Pilier 1) — validation de FORME à la
 * frontière. Les invariants multi-lignes (somme ≤ montant) sont testés côté
 * isolation/repository (categorisation-isolation.test.ts), pas ici.
 */
import { describe, expect, it } from "vitest";

import {
  ajouterSplitSchema,
  supprimerSplitSchema,
} from "@/server/repositories/categorisation-schema";

const UUID = "11111111-1111-4111-8111-111111111111";
const base = {
  transactionId: UUID,
  transactionDate: "2026-03-15",
  categoryId: UUID,
  amount: "100.00",
  source: "MANUAL" as const,
  ruleId: null,
};

describe("ajouterSplitSchema", () => {
  it("accepte un split MANUAL valide", () => {
    expect(ajouterSplitSchema.safeParse(base).success).toBe(true);
  });

  it("accepte un split RULE avec rule_id", () => {
    const r = ajouterSplitSchema.safeParse({ ...base, source: "RULE", ruleId: UUID });
    expect(r.success).toBe(true);
  });

  it("REFUSE MANUAL avec rule_id (double verrou Zod)", () => {
    const r = ajouterSplitSchema.safeParse({ ...base, source: "MANUAL", ruleId: UUID });
    expect(r.success).toBe(false);
  });

  it("REFUSE RULE sans rule_id", () => {
    const r = ajouterSplitSchema.safeParse({ ...base, source: "RULE", ruleId: null });
    expect(r.success).toBe(false);
  });

  it.each(["0", "-5", "0.00", "abc", "10.999", "1e3", ""])(
    "REFUSE le montant invalide %s",
    (amount) => {
      expect(ajouterSplitSchema.safeParse({ ...base, amount }).success).toBe(false);
    },
  );

  it("accepte 2 décimales et de grands montants entiers", () => {
    expect(ajouterSplitSchema.safeParse({ ...base, amount: "1234567890123.99" }).success).toBe(true);
  });

  it("REFUSE une clé inattendue (strict)", () => {
    expect(
      ajouterSplitSchema.safeParse({ ...base, evil: 1 } as Record<string, unknown>).success,
    ).toBe(false);
  });

  it("REFUSE une date malformée", () => {
    expect(ajouterSplitSchema.safeParse({ ...base, transactionDate: "15/03/2026" }).success).toBe(false);
  });
});

describe("supprimerSplitSchema", () => {
  it("accepte un uuid", () => {
    expect(supprimerSplitSchema.safeParse({ splitId: UUID }).success).toBe(true);
  });
  it("REFUSE un non-uuid", () => {
    expect(supprimerSplitSchema.safeParse({ splitId: "x" }).success).toBe(false);
  });
});
