/**
 * Contrat Zod du deep-link « Créer une règle » (FB0709-REGLES-LIEN1) — validation
 * de FORME des searchParams `?nouvelle=1&motif=<pattern>&categorie=<uuid>`.
 *
 * La résolution TENANT de la catégorie (appartenance au workspace) vit dans la
 * page (contre le référentiel chargé sous RLS), pas ici — ce schéma ne garde que
 * la forme. Objectif : STRICT sur le format, TOLÉRANT sur les valeurs mal formées
 * (safeParse.success reste true, champ absent), jamais d'erreur ni d'oracle.
 */
import { describe, expect, it } from "vitest";

import { deepLinkRegleSchema } from "@/lib/regles-schema";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("deepLinkRegleSchema (FB0709-REGLES-LIEN1)", () => {
  it("happy : nouvelle=1 + motif + categorie uuid → tous présents", () => {
    const r = deepLinkRegleSchema.safeParse({
      nouvelle: "1",
      motif: "NETFLIX",
      categorie: UUID,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nouvelle).toBe("1");
      expect(r.data.motif).toBe("NETFLIX");
      expect(r.data.categorie).toBe(UUID);
    }
  });

  it("trim du motif (les espaces de bord sont retirés)", () => {
    const r = deepLinkRegleSchema.safeParse({ nouvelle: "1", motif: "  ACME  " });
    expect(r.success && r.data.motif).toBe("ACME");
  });

  it("categorie NON-uuid → parse ÉCHOUE (la page ignore alors le deep-link)", () => {
    // Un uuid invalide fait échouer le safeParse ; la page traite l'échec comme
    // « pas de deep-link » (aucune pré-sélection, aucun oracle).
    const r = deepLinkRegleSchema.safeParse({ nouvelle: "1", categorie: "pas-un-uuid" });
    expect(r.success).toBe(false);
  });

  it("motif vide → parse échoue (min 1 après trim)", () => {
    expect(deepLinkRegleSchema.safeParse({ motif: "   " }).success).toBe(false);
  });

  it("motif trop long (>255) → parse échoue", () => {
    expect(deepLinkRegleSchema.safeParse({ motif: "x".repeat(256) }).success).toBe(false);
  });

  it("nouvelle ≠ '1' → échoue (littéral strict ; la page n'ouvrira pas le formulaire)", () => {
    expect(deepLinkRegleSchema.safeParse({ nouvelle: "true" }).success).toBe(false);
  });

  it("tableau (clé répétée) pour categorie → échoue (on n'accepte que string)", () => {
    const r = deepLinkRegleSchema.safeParse({ categorie: [UUID, UUID] });
    expect(r.success).toBe(false);
  });

  it("objet vide / params inconnus → succès, champs absents (tolérant, pas d'erreur)", () => {
    const r = deepLinkRegleSchema.safeParse({ autre: "x", page: "2" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nouvelle).toBeUndefined();
      expect(r.data.motif).toBeUndefined();
      expect(r.data.categorie).toBeUndefined();
    }
  });
});
