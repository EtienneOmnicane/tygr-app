/**
 * Bascule plein → compact au centre du donut (`DONUT-CENTRE-DEBORDE1`).
 *
 * Ces tests existent pour une raison précise : les seuils sont issus d'une MESURE de
 * largeur en pixels, et rien dans `lint`/`tsc`/le build ne les protège. Décaler un seuil
 * d'un rang produit soit un montant qui déborde de l'anneau, soit un montant résumé
 * alors qu'il tenait — deux régressions muettes. On teste donc les DEUX rangs qui
 * encadrent chaque seuil, pas seulement un cas nominal : un test qui ne vérifierait que
 * « 12 chiffres → résumé » resterait vert avec n'importe quel seuil ≤ 12.
 */
import { describe, expect, it } from "vitest";

import {
  SEUIL_CHIFFRES_PREFIXE,
  SEUIL_CHIFFRES_SUFFIXE,
  doitResumerAuCentre,
} from "@/components/graphiques/format-centre";

describe("doitResumerAuCentre — devise à symbole en préfixe", () => {
  it("garde le PLEIN jusqu'à 8 chiffres (mesuré : 128,6 px pour 135,3 de corde)", () => {
    expect(doitResumerAuCentre("4500000.00", "MUR")).toBe(false); // 7 ch
    expect(doitResumerAuCentre("12345678.90", "MUR")).toBe(false); // 8 ch
    expect(doitResumerAuCentre("99999999.99", "MUR")).toBe(false); // 8 ch, borne haute
  });

  it("RÉSUME à partir de 9 chiffres (mesuré : 138,2 px — déborde)", () => {
    expect(doitResumerAuCentre("100000000.00", "MUR")).toBe(true); // 9 ch, borne basse
    expect(doitResumerAuCentre("12188030422.92", "MUR")).toBe(true); // le cas de prod
  });

  it("vaut pour les trois devises à symbole, pas seulement la roupie", () => {
    for (const devise of ["MUR", "USD", "EUR"]) {
      expect(doitResumerAuCentre("12345678.90", devise)).toBe(false);
      expect(doitResumerAuCentre("123456789.01", devise)).toBe(true);
    }
  });

  it("est insensible à la casse du code devise (le gabarit ne change pas)", () => {
    expect(doitResumerAuCentre("12345678.90", "mur")).toBe(false);
    expect(doitResumerAuCentre("123456789.01", "usd")).toBe(true);
  });
});

describe("doitResumerAuCentre — devise inconnue (repli code ISO en suffixe)", () => {
  it("RÉSUME dès 8 chiffres : le suffixe coûte ~16 px de plus que le préfixe", () => {
    expect(doitResumerAuCentre("12345678.90", "GBP")).toBe(true); // 8 ch
    expect(doitResumerAuCentre("999888777666.55", "GBP")).toBe(true);
  });

  it("garde le PLEIN jusqu'à 7 chiffres (mesuré : 135,0 px, ça passe de justesse)", () => {
    expect(doitResumerAuCentre("1234567.89", "GBP")).toBe(false);
    expect(doitResumerAuCentre("9999999.99", "ZAR")).toBe(false);
  });
});

describe("doitResumerAuCentre — invariants", () => {
  it("DISCRIMINE les deux gabarits : à 8 chiffres, préfixe et suffixe divergent", () => {
    // Le test qui compte. Un seuil unique (quelle que soit sa valeur) rendrait ces deux
    // assertions égales et échouerait ici — c'est ce qui prouve qu'il y a bien DEUX
    // seuils, et c'est le cas rendu par la section `#seuil` de la démo.
    const montant = "12345678.90";
    expect(doitResumerAuCentre(montant, "MUR")).toBe(false);
    expect(doitResumerAuCentre(montant, "GBP")).toBe(true);
  });

  it("ignore le SIGNE : la décision porte sur une largeur de chiffres", () => {
    expect(doitResumerAuCentre("-12345678.90", "MUR")).toBe(false);
    expect(doitResumerAuCentre("-123456789.01", "MUR")).toBe(true);
  });

  it("ne résume jamais un petit montant, quel que soit le gabarit", () => {
    for (const devise of ["MUR", "USD", "EUR", "GBP", "ZAR"]) {
      expect(doitResumerAuCentre("0.00", devise)).toBe(false);
      expect(doitResumerAuCentre("999.99", devise)).toBe(false);
    }
  });

  it("épingle les seuils : les faire bouger doit casser un test, pas passer inaperçu", () => {
    expect(SEUIL_CHIFFRES_PREFIXE).toBe(9);
    expect(SEUIL_CHIFFRES_SUFFIXE).toBe(8);
    // Le suffixe bascule toujours AVANT le préfixe : il est plus large à montant égal.
    expect(SEUIL_CHIFFRES_SUFFIXE).toBeLessThan(SEUIL_CHIFFRES_PREFIXE);
  });
});
