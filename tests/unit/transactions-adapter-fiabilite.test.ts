/**
 * Tests de l'adaptateur Backend → UI, ciblés sur la NORMALISATION des métadonnées de
 * fiabilité amont (TECH-API-TRACE). On teste via `versLigneUI` (fonction publique) :
 * c'est la frontière qui protège l'UI des chaînes brutes (colonnes sans CHECK côté DB).
 * Invariant clé : toute valeur inattendue → `null` (l'UI ne voit jamais de chaîne libre).
 */
import { describe, expect, it } from "vitest";

import { versLigneUI } from "@/app/(workspace)/transactions/adapter";
import type { TransactionLigne } from "@/server/repositories/transactions";

/** Ligne Backend minimale, surchargée au cas par cas. */
function ligne(over: Partial<TransactionLigne> = {}): TransactionLigne {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    transactionDate: "2026-06-11",
    bankAccountId: "acc-1",
    accountName: "Compte courant MUR",
    institutionName: "Bank One",
    amount: "1500.00",
    currency: "MUR",
    creditDebit: "Debit",
    cleanLabel: "Beachcomber",
    bankLabelRaw: "DBIT / POS / X",
    primaryCategory: "Groceries",
    subCategory: null,
    isAutoCategorized: true,
    categorySource: "OMNIFI",
    confidenceLevel: null,
    classificationSource: null,
    nbSplits: 1,
    montantVentile: "1500.00",
    statut: "COMPLET",
    categorieDominanteId: null,
    categorieDominanteNom: null,
    ...over,
  };
}

const nomParCompte = new Map([["acc-1", "Compte courant MUR"]]);

describe("versLigneUI — normalisation niveauFiabilite", () => {
  it("mappe les libellés canoniques (High/Medium/Low)", () => {
    expect(
      versLigneUI(ligne({ confidenceLevel: "High" }), nomParCompte).niveauFiabilite,
    ).toBe("High");
    expect(
      versLigneUI(ligne({ confidenceLevel: "Medium" }), nomParCompte)
        .niveauFiabilite,
    ).toBe("Medium");
    expect(
      versLigneUI(ligne({ confidenceLevel: "Low" }), nomParCompte).niveauFiabilite,
    ).toBe("Low");
  });

  it("est robuste à la casse et aux espaces", () => {
    expect(
      versLigneUI(ligne({ confidenceLevel: "  low  " }), nomParCompte)
        .niveauFiabilite,
    ).toBe("Low");
    expect(
      versLigneUI(ligne({ confidenceLevel: "HIGH" }), nomParCompte).niveauFiabilite,
    ).toBe("High");
  });

  it("retombe sur null pour null, vide ou valeur inconnue (résilience API)", () => {
    expect(
      versLigneUI(ligne({ confidenceLevel: null }), nomParCompte).niveauFiabilite,
    ).toBeNull();
    expect(
      versLigneUI(ligne({ confidenceLevel: "" }), nomParCompte).niveauFiabilite,
    ).toBeNull();
    expect(
      versLigneUI(ligne({ confidenceLevel: "VeryHigh" }), nomParCompte)
        .niveauFiabilite,
    ).toBeNull();
  });
});

describe("versLigneUI — normalisation sourceClassification", () => {
  it("mappe les trois sources connues", () => {
    expect(
      versLigneUI(ligne({ classificationSource: "USER_RULE" }), nomParCompte)
        .sourceClassification,
    ).toBe("USER_RULE");
    expect(
      versLigneUI(ligne({ classificationSource: "system_rule" }), nomParCompte)
        .sourceClassification,
    ).toBe("SYSTEM_RULE");
    expect(
      versLigneUI(ligne({ classificationSource: "ML_FALLBACK" }), nomParCompte)
        .sourceClassification,
    ).toBe("ML_FALLBACK");
  });

  it("retombe sur null pour null ou valeur inconnue", () => {
    expect(
      versLigneUI(ligne({ classificationSource: null }), nomParCompte)
        .sourceClassification,
    ).toBeNull();
    expect(
      versLigneUI(ligne({ classificationSource: "OVERRIDE" }), nomParCompte)
        .sourceClassification,
    ).toBeNull();
  });
});

describe("versLigneUI — catégorie dominante (FB0709-TX-CATEGORIE-VISIBLE1)", () => {
  it("construit `categorie {id,name}` quand la dominante est connue", () => {
    const l = versLigneUI(
      ligne({
        categorieDominanteId: "cccc1111-cccc-4ccc-8ccc-cccccccccccc",
        categorieDominanteNom: "Loyer",
        nbSplits: 2,
      }),
      nomParCompte,
    );
    expect(l.categorie).toEqual({
      id: "cccc1111-cccc-4ccc-8ccc-cccccccccccc",
      name: "Loyer",
    });
    expect(l.nbCategories).toBe(2);
  });

  it("retombe sur null (comptage générique) si la dominante est absente ou partielle", () => {
    expect(versLigneUI(ligne(), nomParCompte).categorie).toBeNull();
    // Paire incohérente (id sans nom) → repli défensif, jamais un badge sans nom.
    expect(
      versLigneUI(
        ligne({ categorieDominanteId: "cccc1111-cccc-4ccc-8ccc-cccccccccccc" }),
        nomParCompte,
      ).categorie,
    ).toBeNull();
  });
});
