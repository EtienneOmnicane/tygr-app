/**
 * `flux-etiquettes` — décision « cette part projetée est-elle représentable par une
 * barre ? », et orientation de son étiquette de substitution. Fonctions PURES (géométrie
 * uniquement, règle 8) : testables sans rendu ni DB.
 *
 * Invariants couverts : le seuil de bascule barre → étiquette, le cas « valeur nulle »
 * (absence ≠ illisibilité — la confusion écrirait « Rs 0 » sur chaque mois sans échéance),
 * la bascule horizontale/verticale qui garantit une étiquette lisible sur TOUTES les
 * fenêtres, et les bornes de `rapportEcrasement` dont dépend la garde de couverture Gate 4.
 */
import { describe, expect, it } from "vitest";

import {
  MARGE_ETIQUETTE_PX,
  RAPPORT_BARRE_INVISIBLE,
  SEUIL_LISIBILITE_PX,
  estIllisible,
  etiquetteVerticale,
  largeurEtiquette,
  rapportEcrasement,
} from "@/components/dashboard/flux-etiquettes";

describe("estIllisible", () => {
  it("une valeur NULLE n'est jamais illisible — elle est absente", () => {
    // Le distinguo porte tout le comportement : sans lui, chaque mois sans échéance
    // afficherait « Rs 0 », et un mois dont les échéances sont dans une AUTRE devise
    // afficherait « Rs 0 » alors que la donnée existe (faux constat, DASH-FX1).
    expect(estIllisible(0, true)).toBe(false);
    expect(estIllisible(0.23, true)).toBe(false);
  });

  it("une valeur non nulle sous le seuil bascule sur l'étiquette", () => {
    expect(estIllisible(0.23, false)).toBe(true); // le cas mesuré en production
    expect(estIllisible(SEUIL_LISIBILITE_PX - 0.01, false)).toBe(true);
  });

  it("une barre lisible reste une barre (aucune étiquette parasite sur le cas sain)", () => {
    expect(estIllisible(SEUIL_LISIBILITE_PX, false)).toBe(false);
    expect(estIllisible(19.4, false)).toBe(false); // fixture DEMO_DASHBOARD
    expect(estIllisible(72, false)).toBe(false);
  });
});

describe("etiquetteVerticale", () => {
  it("reste horizontale quand la colonne est large (6 ou 12 mois)", () => {
    // 15 colonnes sur ~1100 px → pas ≈ 73 px : « Rs 10 k » (~45 px) tient largement.
    expect(etiquetteVerticale("Rs 10 k", 73)).toBe(false);
  });

  it("bascule à la verticale sur une colonne étroite (preset « tout »)", () => {
    // ~39 colonnes sur 1100 px → pas ≈ 28 px : à l'horizontale, l'étiquette mordrait sur
    // ses voisines. La rotation garantit « lisible sur toutes les fenêtres ».
    expect(etiquetteVerticale("Rs 10 k", 28)).toBe(true);
  });

  it("décide sur la largeur RÉELLE du texte, pas sur une longueur forfaitaire", () => {
    const court = "Rs 10 k";
    const long = "Rs 999,9 k ZAR";
    expect(largeurEtiquette(long)).toBeGreaterThan(largeurEtiquette(court));
    // Une colonne qui accueille le court peut refuser le long.
    const colonne = largeurEtiquette(court) + MARGE_ETIQUETTE_PX * 2 + 1;
    expect(etiquetteVerticale(court, colonne)).toBe(false);
    expect(etiquetteVerticale(long, colonne)).toBe(true);
  });
});

describe("rapportEcrasement", () => {
  it("mesure le rapport plafond/valeur", () => {
    expect(rapportEcrasement(10_000, 10_000_000)).toBe(1000);
    expect(rapportEcrasement(5_000_000, 10_000_000)).toBe(2);
  });

  it("reproduit le cas de production au-delà du seuil d'invisibilité", () => {
    // Rs 10 000 contre un plafond de 10 M : très au-delà de 1:229, donc barre < 1 px.
    expect(rapportEcrasement(10_000, 10_000_000)).toBeGreaterThan(
      RAPPORT_BARRE_INVISIBLE,
    );
    // Fixture saine (850 k) : en deçà, la barre se voit.
    expect(rapportEcrasement(850_000, 10_000_000)).toBeLessThan(
      RAPPORT_BARRE_INVISIBLE,
    );
  });

  it("valeur nulle → Infinity (aucune barre à rendre, pas un écrasement)", () => {
    expect(rapportEcrasement(0, 10_000_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("fail-safe sur un plafond non exploitable (jamais NaN ni division par zéro)", () => {
    expect(rapportEcrasement(10_000, 0)).toBe(0);
    expect(rapportEcrasement(10_000, NaN)).toBe(0);
    expect(rapportEcrasement(NaN, 10_000_000)).toBe(0);
  });
});
