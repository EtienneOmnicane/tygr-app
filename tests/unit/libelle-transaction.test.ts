/**
 * Cascade du libellé de transaction (`resoudreLibelle`, arbitrage produit 2026-06-23).
 * Fonction pure au cœur de la hiérarchie d'affichage : marchand → catégorie FR → brut
 * bancaire → repli générique. On couvre la priorité de chaque niveau, les cas limites
 * (vide / espaces / null), et le mode restreint `cascade=false` (dashboard) qui saute
 * directement au repli en IGNORANT catégorie et brut.
 *
 * Le `niveau` retourné PILOTE l'anti-doublon côté ligne (masquer le sous-texte
 * catégorie quand le libellé principal EST déjà la catégorie) — on l'asserte donc
 * explicitement, pas seulement le texte.
 */
import { describe, expect, it } from "vitest";

import {
  LIBELLE_REPLI,
  resoudreLibelle,
} from "@/components/transactions/libelle-transaction";

describe("resoudreLibelle — cascade marchand → catégorie → brut → repli", () => {
  it("niveau 1 : le marchand enrichi prime sur tout le reste", () => {
    const r = resoudreLibelle({
      cleanLabel: "Beachcomber Resorts",
      categorieFr: "Revenus",
      bankLabelRaw: "CRDT / TRF / BEACHCOMBER",
    });
    expect(r).toEqual({ niveau: "marchand", texte: "Beachcomber Resorts" });
  });

  it("niveau 2 : sans marchand, la catégorie FR devient le libellé principal", () => {
    const r = resoudreLibelle({
      cleanLabel: null,
      categorieFr: "Charges",
      bankLabelRaw: "DBIT / POS / BLUEMARBLE SUPERMARKET",
    });
    // C'est CE niveau qui déclenche l'anti-doublon du sous-texte catégorie.
    expect(r).toEqual({ niveau: "categorie", texte: "Charges" });
  });

  it("niveau 3 : sans marchand ni catégorie, le brut bancaire est l'ultime filet", () => {
    const r = resoudreLibelle({
      cleanLabel: null,
      categorieFr: null,
      bankLabelRaw: "DBIT / ATM / WDL PORT LOUIS",
    });
    expect(r).toEqual({ niveau: "brut", texte: "DBIT / ATM / WDL PORT LOUIS" });
  });

  it("niveau 4 : sans aucune source exploitable → repli générique", () => {
    const r = resoudreLibelle({
      cleanLabel: null,
      categorieFr: null,
      bankLabelRaw: null,
    });
    expect(r).toEqual({ niveau: "repli", texte: LIBELLE_REPLI });
  });

  it("traite les chaînes vides ou d'espaces comme absentes (chaque niveau)", () => {
    // cleanLabel vide → on descend à la catégorie.
    expect(
      resoudreLibelle({ cleanLabel: "   ", categorieFr: "Loyer" }).niveau,
    ).toBe("categorie");
    // catégorie vide aussi → on descend au brut.
    expect(
      resoudreLibelle({
        cleanLabel: "",
        categorieFr: "  ",
        bankLabelRaw: "DBIT / SO / RENT",
      }).niveau,
    ).toBe("brut");
    // tout en blanc → repli.
    expect(
      resoudreLibelle({ cleanLabel: " ", categorieFr: "", bankLabelRaw: "  " }),
    ).toEqual({ niveau: "repli", texte: LIBELLE_REPLI });
  });

  it("rogne les espaces de bord du texte retenu", () => {
    expect(resoudreLibelle({ cleanLabel: "  Stripe payout  " }).texte).toBe(
      "Stripe payout",
    );
  });

  it("champs absents (undefined) ⇒ repli, comme null", () => {
    expect(resoudreLibelle({}).niveau).toBe("repli");
  });
});

describe("resoudreLibelle — mode restreint cascade=false (dashboard)", () => {
  it("garde le marchand au niveau 1", () => {
    expect(
      resoudreLibelle({ cleanLabel: "Stripe payout", cascade: false }),
    ).toEqual({ niveau: "marchand", texte: "Stripe payout" });
  });

  it("IGNORE catégorie ET brut : sans marchand → repli générique direct", () => {
    // Même avec une catégorie et un brut disponibles, le mode restreint ne les
    // remonte PAS (le dashboard a une colonne Catégorie dédiée + DTO sans brut).
    const r = resoudreLibelle({
      cleanLabel: null,
      categorieFr: "Charges",
      bankLabelRaw: "DBIT / POS / BLUEMARBLE",
      cascade: false,
    });
    expect(r).toEqual({ niveau: "repli", texte: LIBELLE_REPLI });
  });
});
