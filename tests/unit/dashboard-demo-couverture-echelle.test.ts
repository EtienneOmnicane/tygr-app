/**
 * GARDE DE COUVERTURE des fixtures de démo du prévisionnel (décision Etienne 2026-07-20,
 * lot 0 de PLAN-flux-previsionnel-lisibilite.md ; RE-CIBLÉE par FLUX-PREV-AXE1).
 *
 * ## Pourquoi ce test existe
 *
 * Le Visual QA (Gate 4) ne peut valider que ce que la fixture EXPOSE. Avant le lot 0,
 * toutes les fixtures prévisionnelles portaient un rapport réalisé/prévision de ~1:6 — des
 * barres de 17 à 72 px, parfaitement visibles. Le défaut réel de production (rapport
 * ~1:520, barre de 0,23 px, « la zone paraît vide ») n'était donc pas CAPTURABLE : la
 * Gate 4 du prévisionnel C1 (#226) est passée au vert sans que personne ne triche.
 *
 * ## Ce que FLUX-PREV-AXE1 change à sa cible
 *
 * L'option E a sorti la prévision de l'axe du réalisé : il n'existe plus d'axe partagé,
 * donc plus d'écrasement CONTRE LE RÉALISÉ à surveiller — ce que mesurait la version
 * précédente de ce fichier est devenu sans objet.
 *
 * Mais le défaut n'a pas disparu, il a CHANGÉ D'ÉCHELLE : dans l'encart « Échéances à
 * venir », les échéances se comparent entre elles, et leur écart interne peut lui aussi
 * écraser une barre sous le pixel (Rs 2 500 face à Rs 3 150 000 = 1:1260). La garde suit
 * donc le défaut là où il vit désormais, au lieu d'être supprimée avec l'axe partagé.
 *
 * ## Ce qu'il vérifie (les deux bornes, pas seulement une)
 *
 *  1. Il EXISTE au moins une fixture dont une barre d'encart passe SOUS le tick — sinon le
 *     pire cas redevient invisible au QA.
 *  2. Il EXISTE au moins une fixture au rapport SAIN (barre confortablement lisible) —
 *     sinon on ne pourrait plus détecter une régression du cas nominal, et « tout réduire
 *     au tick tout le temps » passerait le test 1 sans qu'on le voie.
 *
 * ⚠️ Géométrie uniquement (règle 8) : on raisonne en pourcentages SANS unité, dérivés des
 * MÊMES fonctions que le rendu (`maxPrevision` + `largeurRelative`). Recalculer autrement
 * ferait diverger la garde du comportement réel — le piège que ce test existe pour éviter.
 */
import { describe, expect, it } from "vitest";

import {
  DEMO_DASHBOARD,
  DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE,
  DEMO_DASHBOARD_PREVISION_CONTRASTEE,
  DEMO_DASHBOARD_PREVISION_FAIBLE,
  DEMO_DASHBOARD_PREVISION_SANS_REALISE,
  DEMO_DASHBOARD_PREVISION_ZERO,
} from "@/lib/dashboard-demo-fixtures";
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";
import {
  largeurRelative,
  maxPrevision,
  moisPrevision,
} from "@/components/dashboard/flux-projection";
import { SEUIL_BARRE_ENCART_POURCENT } from "@/components/dashboard/flux-etiquettes";

/** Toutes les fixtures qui portent une prévision, nommées pour le message d'échec. */
const FIXTURES_AVEC_PREVISION: Array<{ nom: string; donnees: DonneesDashboard }> = [
  { nom: "DEMO_DASHBOARD", donnees: DEMO_DASHBOARD },
  { nom: "DEMO_DASHBOARD_PREVISION_FAIBLE", donnees: DEMO_DASHBOARD_PREVISION_FAIBLE },
  {
    nom: "DEMO_DASHBOARD_PREVISION_CONTRASTEE",
    donnees: DEMO_DASHBOARD_PREVISION_CONTRASTEE,
  },
  { nom: "DEMO_DASHBOARD_PREVISION_ZERO", donnees: DEMO_DASHBOARD_PREVISION_ZERO },
  {
    nom: "DEMO_DASHBOARD_PREVISION_SANS_REALISE",
    donnees: DEMO_DASHBOARD_PREVISION_SANS_REALISE,
  },
  {
    nom: "DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE",
    donnees: DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE,
  },
];

/**
 * Largeur (%) de la PLUS PETITE barre non nulle qu'une fixture rendra dans l'encart, à
 * l'échelle propre de celui-ci.
 *
 * `Infinity` si la fixture n'a aucune valeur prévisionnelle non nulle (zone à zéro, ou
 * échéances dans une autre devise) : il n'y a alors AUCUNE barre à rendre, donc rien à
 * écraser — ces fixtures couvrent un autre défaut (§5.4) et sont exclues du calcul.
 */
function plusPetiteBarre(donnees: DonneesDashboard): number {
  const { prevision } = donnees;
  if (!prevision) return Number.POSITIVE_INFINITY;

  const mois = moisPrevision(prevision);
  // MÊME plafond que le rendu : l'échelle PROPRE de l'encart, jamais celle du réalisé.
  const max = maxPrevision(mois);

  let min = Number.POSITIVE_INFINITY;
  for (const m of mois) {
    for (const valeur of [m.entrees, m.sorties]) {
      const largeur = largeurRelative(valeur, max);
      // 0 = valeur nulle (aucune barre à dessiner), pas une barre écrasée.
      if (largeur > 0) min = Math.min(min, largeur);
    }
  }
  return min;
}

describe("couverture d'échelle des fixtures de démo (garde Gate 4)", () => {
  it("expose au moins un cas où la barre de l'encart passe SOUS le tick", () => {
    const largeurs = FIXTURES_AVEC_PREVISION.map((f) => ({
      nom: f.nom,
      largeur: plusPetiteBarre(f.donnees),
    }));
    const extremes = largeurs.filter(
      (l) => Number.isFinite(l.largeur) && l.largeur < SEUIL_BARRE_ENCART_POURCENT,
    );

    expect(
      extremes.length,
      `Aucune fixture de démo ne rend une barre d'encart sous ${SEUIL_BARRE_ENCART_POURCENT}% ` +
        `(le tick). Le Visual QA ne peut donc PAS voir le cas « la valeur existe mais sa barre ` +
        `est irreprésentable » : la Gate 4 validerait un angle mort. Largeurs actuelles : ` +
        largeurs
          .map(
            (l) =>
              `${l.nom}=${Number.isFinite(l.largeur) ? `${l.largeur.toFixed(3)}%` : "aucune barre"}`,
          )
          .join(", ") +
        `. Ajoutez (ou restaurez) une fixture au fort écart interne plutôt que d'assouplir ce seuil.`,
    ).toBeGreaterThan(0);
  });

  it("DEMO_DASHBOARD_PREVISION_CONTRASTEE porte bien le cas sous-pixel", () => {
    // Rs 2 500 face à Rs 3 150 000 → ~0,08 % de la piste, soit moins d'un pixel.
    expect(plusPetiteBarre(DEMO_DASHBOARD_PREVISION_CONTRASTEE)).toBeLessThan(
      SEUIL_BARRE_ENCART_POURCENT,
    );
  });

  it("conserve un cas SAIN, où toutes les barres de l'encart sont lisibles", () => {
    // Contre-preuve : sans elle, « toutes les fixtures sont extrêmes » passerait le premier
    // test tout en supprimant la capacité à détecter une régression du cas nominal.
    expect(plusPetiteBarre(DEMO_DASHBOARD)).toBeGreaterThanOrEqual(
      SEUIL_BARRE_ENCART_POURCENT,
    );
  });

  it("distingue « aucune barre à rendre » d'un écrasement (zéro et autre devise)", () => {
    // Ces deux fixtures n'ont AUCUNE valeur prévisionnelle non nulle : elles couvrent le
    // défaut §5.4 (zone muette), pas le défaut d'échelle. Elles ne doivent donc jamais être
    // comptées comme « cas extrême » — sinon la garde se croirait satisfaite à tort.
    expect(plusPetiteBarre(DEMO_DASHBOARD_PREVISION_ZERO)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(plusPetiteBarre(DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
