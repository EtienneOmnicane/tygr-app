/**
 * Tests du module PUR `regle-fiabilite` — la décision d'affichage des indices de
 * fiabilité amont (badge « À vérifier » + libellés de source). Couvre la matrice
 * complète : la règle Low+catégorie, le rejet du défaut « Low » non catégorisé, et le
 * mapping des sources (libellés « Omni-FI », jamais « utilisateur »).
 */
import { describe, expect, it } from "vitest";

import {
  afficherAVerifier,
  descriptionSource,
  EXIGE_CATEGORIE,
  NIVEAUX_A_VERIFIER,
} from "@/components/transactions/regle-fiabilite";

describe("afficherAVerifier — badge « À vérifier »", () => {
  it("affiche le badge quand Low ET catégorie posée (cas cible)", () => {
    expect(
      afficherAVerifier({ niveauFiabilite: "Low", categorieBanque: "Charges" }),
    ).toBe(true);
  });

  it("NE l'affiche PAS quand Low SANS catégorie (défaut serializer, anti-bruit)", () => {
    // C'est LE piège : le serializer Omni-FI met « Low » par défaut sur les lignes
    // non enrichies. Sans catégorie, la ligne relève de « Non catégorisé », pas d'alerte.
    expect(
      afficherAVerifier({ niveauFiabilite: "Low", categorieBanque: null }),
    ).toBe(false);
  });

  it("NE l'affiche PAS pour Medium ou High (classification jugée sûre)", () => {
    expect(
      afficherAVerifier({ niveauFiabilite: "Medium", categorieBanque: "Charges" }),
    ).toBe(false);
    expect(
      afficherAVerifier({ niveauFiabilite: "High", categorieBanque: "Charges" }),
    ).toBe(false);
  });

  it("NE l'affiche PAS quand la fiabilité est absente (null) — jamais d'alarme sur une absence", () => {
    expect(
      afficherAVerifier({ niveauFiabilite: null, categorieBanque: "Charges" }),
    ).toBe(false);
    expect(
      afficherAVerifier({ niveauFiabilite: null, categorieBanque: null }),
    ).toBe(false);
  });

  it("garde des constantes de seuil cohérentes (Low seul, catégorie exigée)", () => {
    // Garde-fou de régression : si quelqu'un élargit le seuil, ce test le signale —
    // l'ajustement est une décision tracée (dette P2), pas un effet de bord silencieux.
    expect(NIVEAUX_A_VERIFIER.has("Low")).toBe(true);
    expect(NIVEAUX_A_VERIFIER.has("Medium")).toBe(false);
    expect(NIVEAUX_A_VERIFIER.has("High")).toBe(false);
    expect(EXIGE_CATEGORIE).toBe(true);
  });
});

describe("descriptionSource — icône + infobulle de source", () => {
  it("USER_RULE et SYSTEM_RULE → glyphe « règle », libellé « Omni-FI » (JAMAIS « utilisateur »)", () => {
    const u = descriptionSource("USER_RULE");
    const s = descriptionSource("SYSTEM_RULE");
    expect(u).toEqual({ glyphe: "regle", libelle: "Classé par règle Omni-FI" });
    expect(s).toEqual({
      glyphe: "regle",
      libelle: "Classé par règle système Omni-FI",
    });
    // Anti-contresens produit : USER_RULE n'est pas la ventilation manuelle TYGR.
    expect(u?.libelle.toLowerCase()).not.toContain("utilisateur");
  });

  it("ML_FALLBACK → glyphe « modèle » distinct", () => {
    expect(descriptionSource("ML_FALLBACK")).toEqual({
      glyphe: "modele",
      libelle: "Classé par modèle (ML) Omni-FI",
    });
  });

  it("source absente (null) → null (aucune icône)", () => {
    expect(descriptionSource(null)).toBeNull();
  });
});
