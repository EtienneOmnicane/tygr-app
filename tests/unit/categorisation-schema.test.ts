/**
 * Contrat Zod de la catégorisation (Pilier 1) — validation de FORME à la
 * frontière. Les invariants multi-lignes (somme ≤ montant) sont testés côté
 * isolation/repository (categorisation-isolation.test.ts), pas ici.
 */
import { describe, expect, it } from "vitest";

import {
  ajouterSplitSchema,
  archiverCategorieSchema,
  creerCategorieSchema,
  refTransactionSchema,
  remplacerSplitsSchema,
  renommerCategorieSchema,
  supprimerSplitSchema,
} from "@/lib/categorisation-schema";

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

// Contrat de la ref pour listerSplitsAction (TX-B3bis) : une ref malformée DOIT
// être rejetée — l'action lève alors plutôt que de renvoyer [] (anti-perte de
// données : un [] silencieux ferait dé-catégoriser au Valider).
describe("refTransactionSchema", () => {
  it("accepte une ref valide (uuid + date)", () => {
    expect(
      refTransactionSchema.safeParse({ transactionId: UUID, transactionDate: "2026-03-15" })
        .success,
    ).toBe(true);
  });
  it("REFUSE un transactionId non-uuid", () => {
    expect(
      refTransactionSchema.safeParse({ transactionId: "x", transactionDate: "2026-03-15" })
        .success,
    ).toBe(false);
  });
  it("REFUSE une date malformée", () => {
    expect(
      refTransactionSchema.safeParse({ transactionId: UUID, transactionDate: "15/03/2026" })
        .success,
    ).toBe(false);
  });
  it("REFUSE une clé inattendue (strict — pas de workspace_id injecté)", () => {
    expect(
      refTransactionSchema.safeParse({
        transactionId: UUID,
        transactionDate: "2026-03-15",
        workspaceId: UUID,
      } as Record<string, unknown>).success,
    ).toBe(false);
  });
});

describe("remplacerSplitsSchema", () => {
  const refOk = { transactionId: UUID, transactionDate: "2026-03-15" };
  it("accepte un état cible valide", () => {
    const r = remplacerSplitsSchema.safeParse({
      ...refOk,
      splits: [{ categoryId: UUID, amount: "100.00" }],
    });
    expect(r.success).toBe(true);
  });
  it("accepte une liste vide (tout dé-catégoriser)", () => {
    expect(remplacerSplitsSchema.safeParse({ ...refOk, splits: [] }).success).toBe(true);
  });
  it("REFUSE plus de 50 splits (borne)", () => {
    const splits = Array.from({ length: 51 }, () => ({ categoryId: UUID, amount: "1.00" }));
    expect(remplacerSplitsSchema.safeParse({ ...refOk, splits }).success).toBe(false);
  });
  it("REFUSE un montant invalide dans un split", () => {
    const r = remplacerSplitsSchema.safeParse({
      ...refOk,
      splits: [{ categoryId: UUID, amount: "-5" }],
    });
    expect(r.success).toBe(false);
  });
  it("REFUSE une clé inattendue dans un split (strict)", () => {
    const r = remplacerSplitsSchema.safeParse({
      ...refOk,
      splits: [{ categoryId: UUID, amount: "1.00", evil: 1 }],
    } as Record<string, unknown>);
    expect(r.success).toBe(false);
  });
});

describe("CRUD catégories — schémas", () => {
  it("creerCategorie : nom valide + parentId nul", () => {
    expect(creerCategorieSchema.safeParse({ name: "Ventes", parentId: null }).success).toBe(true);
  });
  it("creerCategorie : nom vide rejeté", () => {
    expect(creerCategorieSchema.safeParse({ name: "   ", parentId: null }).success).toBe(false);
  });
  it("creerCategorie : nom > 120 rejeté", () => {
    expect(
      creerCategorieSchema.safeParse({ name: "x".repeat(121), parentId: null }).success,
    ).toBe(false);
  });
  it("renommerCategorie : uuid + nom", () => {
    expect(
      renommerCategorieSchema.safeParse({ categoryId: UUID, name: "Nouveau" }).success,
    ).toBe(true);
  });
  it("archiverCategorie : uuid requis", () => {
    expect(archiverCategorieSchema.safeParse({ categoryId: UUID }).success).toBe(true);
    expect(archiverCategorieSchema.safeParse({ categoryId: "x" }).success).toBe(false);
  });
});
