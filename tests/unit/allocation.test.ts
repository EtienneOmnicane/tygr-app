/**
 * Logique PURE d'allocation de la ventilation (SplitAllocationModal, Pilier 1).
 * Couvre les bornes financières (règle 8) : précision décimale (pas de float),
 * partiel valide (somme < total OK), dépassement, lignes incomplètes, payload.
 */
import { describe, expect, it } from "vitest";

import {
  calculerAllocation,
  enCentimes,
  depuisCentimes,
  ligneEnDepassement,
  lignesEnDoublon,
  montantValide,
  peutValider,
  versPayload,
  type LigneAllocation,
} from "@/components/ui/category/allocation";

function ligne(cle: string, categoryId: string | null, montantSaisi: string): LigneAllocation {
  return { cle, categoryId, montantSaisi };
}

const CAT = "11111111-1111-4111-8111-111111111111";
const CAT2 = "22222222-2222-4222-8222-222222222222";

describe("enCentimes / depuisCentimes", () => {
  it("convertit sans perte de précision (pas de float)", () => {
    expect(enCentimes("0.1")).toBe(BigInt(10));
    expect(enCentimes("0.2")).toBe(BigInt(20));
    // Le float trap : 0.1 + 0.2 = 30 centimes EXACTEMENT en BigInt.
    expect(enCentimes("0.1")! + enCentimes("0.2")!).toBe(BigInt(30));
    expect(depuisCentimes(BigInt(30))).toBe("0.30");
  });

  it("gère les gros montants (millions, numeric 15,2)", () => {
    expect(enCentimes("6000000.50")).toBe(BigInt(600000050));
    expect(depuisCentimes(BigInt(600000050))).toBe("6000000.50");
  });

  it("rejette les formats invalides", () => {
    expect(enCentimes("abc")).toBeNull();
    expect(enCentimes("12.345")).toBeNull(); // 3 décimales
    expect(enCentimes("")).toBeNull();
    expect(enCentimes("-5")).toBeNull(); // signe interdit (toujours > 0)
  });
});

describe("calculerAllocation", () => {
  it("partiel : somme < total → reste positif, pas de dépassement", () => {
    const etat = calculerAllocation("10000.00", [
      ligne("a", CAT, "6000.00"),
      ligne("b", CAT, "2000.00"),
    ]);
    expect(etat.alloue).toBe("8000.00");
    expect(etat.reste).toBe("2000.00");
    expect(etat.depasse).toBe(false);
    expect(etat.aAuMoinsUneLigne).toBe(true);
  });

  it("exact : somme = total → reste zéro, valide", () => {
    const etat = calculerAllocation("100.00", [ligne("a", CAT, "100.00")]);
    expect(etat.reste).toBe("0.00");
    expect(etat.depasse).toBe(false);
  });

  it("dépassement : somme > total → depasse=true, reste négatif", () => {
    const etat = calculerAllocation("100.00", [
      ligne("a", CAT, "60.00"),
      ligne("b", CAT, "60.00"),
    ]);
    expect(etat.alloue).toBe("120.00");
    expect(etat.reste).toBe("-20.00");
    expect(etat.depasse).toBe(true);
  });

  it("ignore les lignes vides ou invalides dans le total", () => {
    const etat = calculerAllocation("100.00", [
      ligne("a", CAT, "30.00"),
      ligne("b", null, ""), // vide
      ligne("c", CAT, "abc"), // invalide
    ]);
    expect(etat.alloue).toBe("30.00");
    expect(etat.aAuMoinsUneLigne).toBe(true);
  });

  it("précision : trois tiers de 100 ne créent pas de dérive float", () => {
    const etat = calculerAllocation("100.00", [
      ligne("a", CAT, "33.33"),
      ligne("b", CAT, "33.33"),
      ligne("c", CAT, "33.34"),
    ]);
    expect(etat.alloue).toBe("100.00");
    expect(etat.depasse).toBe(false);
  });
});

describe("ligneEnDepassement", () => {
  it("marque la ligne qui fait basculer au-delà du total", () => {
    const lignes = [ligne("a", CAT, "80.00"), ligne("b", CAT, "30.00")];
    // somme 110 > 100 ; retirer b (30) → 80 ≤ 100 → b est fautive.
    expect(ligneEnDepassement("100.00", lignes, "b")).toBe(true);
  });

  it("ne marque rien si pas de dépassement", () => {
    const lignes = [ligne("a", CAT, "50.00")];
    expect(ligneEnDepassement("100.00", lignes, "a")).toBe(false);
  });
});

describe("peutValider", () => {
  it("autorise le partiel complet", () => {
    expect(peutValider("100.00", [ligne("a", CAT, "50.00")])).toBe(true);
  });

  it("refuse le dépassement", () => {
    expect(peutValider("100.00", [ligne("a", CAT, "150.00")])).toBe(false);
  });

  it("refuse une ligne sans catégorie", () => {
    expect(peutValider("100.00", [ligne("a", null, "50.00")])).toBe(false);
  });

  it("refuse une catégorie sans montant", () => {
    expect(peutValider("100.00", [ligne("a", CAT, "")])).toBe(false);
  });

  it("refuse s'il n'y a aucune ligne valide", () => {
    expect(peutValider("100.00", [ligne("a", null, "")])).toBe(false);
  });

  it("refuse deux lignes sur la MÊME catégorie (doublon interdit — TX-QA-SPLIT-DOUBLON1)", () => {
    expect(
      peutValider("100.00", [ligne("a", CAT, "40.00"), ligne("b", CAT, "30.00")]),
    ).toBe(false);
  });

  it("autorise deux lignes sur des catégories DISTINCTES", () => {
    expect(
      peutValider("100.00", [ligne("a", CAT, "40.00"), ligne("b", CAT2, "30.00")]),
    ).toBe(true);
  });
});

describe("lignesEnDoublon", () => {
  it("marque TOUTES les lignes d'une catégorie utilisée ≥ 2 fois", () => {
    const lignes = [
      ligne("a", CAT, "40.00"),
      ligne("b", CAT, "30.00"),
      ligne("c", CAT2, "10.00"),
    ];
    const doublons = lignesEnDoublon(lignes);
    expect(doublons.has("a")).toBe(true);
    expect(doublons.has("b")).toBe(true);
    expect(doublons.has("c")).toBe(false); // CAT2 unique
  });

  it("ne marque rien quand toutes les catégories sont distinctes", () => {
    expect(
      lignesEnDoublon([ligne("a", CAT, "40.00"), ligne("b", CAT2, "30.00")]).size,
    ).toBe(0);
  });

  it("ignore les lignes SANS catégorie (null n'est jamais un doublon)", () => {
    // Deux lignes sans catégorie ne se rejettent pas entre elles (elles n'atteignent
    // pas le serveur — versPayload les écarte).
    expect(
      lignesEnDoublon([ligne("a", null, "40.00"), ligne("b", null, "30.00")]).size,
    ).toBe(0);
  });
});

describe("versPayload", () => {
  it("ne garde que les lignes complètes, montant normalisé 2 décimales", () => {
    const payload = versPayload([
      ligne("a", CAT, "50"),
      ligne("b", null, "10"), // sans catégorie → écartée
      ligne("c", CAT, ""), // sans montant → écartée
    ]);
    expect(payload).toEqual([{ categoryId: CAT, amount: "50.00" }]);
  });
});

describe("montantValide", () => {
  it("vrai pour un décimal positif ≤ 2 décimales", () => {
    expect(montantValide("12.50")).toBe(true);
    expect(montantValide("0.01")).toBe(true);
  });
  it("faux pour zéro, négatif, ou 3 décimales", () => {
    expect(montantValide("0")).toBe(false);
    expect(montantValide("0.00")).toBe(false);
    expect(montantValide("12.345")).toBe(false);
  });
});
