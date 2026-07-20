/**
 * GARDE DE COUVERTURE des fixtures de démo du prévisionnel (décision Etienne 2026-07-20,
 * lot 0 de PLAN-flux-previsionnel-lisibilite.md).
 *
 * ## Pourquoi ce test existe
 *
 * Le Visual QA (Gate 4) ne peut valider que ce que la fixture EXPOSE. Avant ce lot, toutes
 * les fixtures prévisionnelles portaient un rapport réalisé/prévision de ~1:6 — des barres
 * de 17 à 72 px, parfaitement visibles. Le défaut réel de production (rapport ~1:520, barre
 * de 0,23 px, « la zone paraît vide ») n'était donc pas CAPTURABLE : la Gate 4 du
 * prévisionnel C1 (#226) est passée au vert sans que personne ne triche.
 *
 * Ce test ferme l'angle mort de façon permanente : il échoue si le corpus de fixtures cesse
 * de contenir un cas d'écrasement extrême. C'est une réparation d'INTÉGRITÉ DE TEST
 * (règle 9), pas un test de rendu — il ne monte aucun composant.
 *
 * ## Ce qu'il vérifie (les deux bornes, pas seulement une)
 *
 *  1. Il EXISTE au moins une fixture au-delà de `RAPPORT_BARRE_INVISIBLE` (barre < 1 px) —
 *     sinon le pire cas redevient invisible au QA.
 *  2. Il EXISTE au moins une fixture au rapport SAIN (barre confortablement lisible) —
 *     sinon on ne pourrait plus détecter une régression du cas nominal, et « tout étiqueter
 *     tout le temps » passerait le test 1 sans qu'on le voie.
 *
 * ⚠️ Géométrie uniquement (règle 8) : on raisonne en rapports SANS unité, dérivés des mêmes
 * fonctions que le rendu (`maxFenetreColonnes` + `echelleNice`). Aucun montant n'est
 * formaté ici, `parseFloat` reste cantonné à l'échelle — comme dans `flux-projection.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  DEMO_DASHBOARD,
  DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE,
  DEMO_DASHBOARD_PREVISION_FAIBLE,
  DEMO_DASHBOARD_PREVISION_SANS_REALISE,
  DEMO_DASHBOARD_PREVISION_ZERO,
} from "@/lib/dashboard-demo-fixtures";
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";
import {
  composerColonnes,
  maxFenetreColonnes,
  projeterSurGrille,
} from "@/components/dashboard/flux-projection";
import { echelleNice } from "@/components/dashboard/echelle-nice";
import {
  RAPPORT_BARRE_INVISIBLE,
  rapportEcrasement,
} from "@/components/dashboard/flux-etiquettes";

/** Toutes les fixtures qui portent une zone prévisionnelle, nommées pour le message d'échec. */
const FIXTURES_AVEC_PREVISION: Array<{ nom: string; donnees: DonneesDashboard }> = [
  { nom: "DEMO_DASHBOARD", donnees: DEMO_DASHBOARD },
  { nom: "DEMO_DASHBOARD_PREVISION_FAIBLE", donnees: DEMO_DASHBOARD_PREVISION_FAIBLE },
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
 * Rapport d'écrasement de la PLUS PETITE valeur prévisionnelle non nulle d'une fixture,
 * face au plafond d'axe que le rendu appliquera réellement.
 *
 * `Infinity` si la fixture n'a aucune valeur prévisionnelle non nulle (zone à zéro, ou
 * échéances dans une autre devise) : il n'y a alors AUCUNE barre à rendre, donc rien à
 * écraser — ces fixtures couvrent un autre défaut (§5.4) et sont exclues du calcul.
 */
function pireEcrasement(donnees: DonneesDashboard): number {
  const { serieMensuelle, grilleMensuelle, prevision } = donnees;
  const realises = projeterSurGrille(serieMensuelle, grilleMensuelle, "MUR");
  const colonnes = composerColonnes(
    realises,
    prevision?.moisFuturs ?? [],
    prevision?.moisCourant ?? null,
  );
  // MÊME plafond que le rendu : `maxFenetreColonnes` puis `echelleNice`. Recalculer
  // autrement ferait diverger la garde du comportement réel (le piège que ce test existe
  // précisément pour éviter).
  const plafond = echelleNice(maxFenetreColonnes(colonnes));

  // La valeur la plus ÉCRASÉE est celle au plus grand rapport `plafond / valeur`. Les
  // valeurs nulles rendent `Infinity` (aucune barre à dessiner) et sont écartées par le
  // filtre de finitude — sans elles, `pire` reste à 0 et la fixture est déclarée « aucune
  // barre à rendre » plutôt que « écrasée ».
  let pire = 0;
  for (const colonne of colonnes) {
    for (const valeur of [colonne.prevision?.entrees, colonne.prevision?.sorties]) {
      if (valeur === undefined) continue;
      const rapport = rapportEcrasement(Math.abs(parseFloat(valeur)), plafond);
      if (Number.isFinite(rapport)) pire = Math.max(pire, rapport);
    }
  }
  return pire === 0 ? Number.POSITIVE_INFINITY : pire;
}

describe("couverture d'échelle des fixtures de démo (garde Gate 4)", () => {
  it("expose au moins un cas où la barre prévisionnelle rend MOINS d'1 px", () => {
    const ecrasements = FIXTURES_AVEC_PREVISION.map((f) => ({
      nom: f.nom,
      ecrasement: pireEcrasement(f.donnees),
    }));
    const extremes = ecrasements.filter(
      (e) => Number.isFinite(e.ecrasement) && e.ecrasement >= RAPPORT_BARRE_INVISIBLE,
    );

    expect(
      extremes.length,
      `Aucune fixture de démo n'atteint un rapport d'écrasement ≥ 1:${RAPPORT_BARRE_INVISIBLE}. ` +
        `Le Visual QA ne peut donc PAS voir le défaut « la zone prévisionnelle paraît vide » : ` +
        `la Gate 4 validerait un angle mort. Rapports actuels : ` +
        ecrasements
          .map(
            (e) =>
              `${e.nom}=${Number.isFinite(e.ecrasement) ? `1:${Math.round(e.ecrasement)}` : "aucune barre"}`,
          )
          .join(", ") +
        `. Ajoutez (ou restaurez) une fixture à faible montant plutôt que d'assouplir ce seuil.`,
    ).toBeGreaterThan(0);
  });

  it("DEMO_DASHBOARD_PREVISION_FAIBLE reproduit bien le rapport observé en production", () => {
    const ecrasement = pireEcrasement(DEMO_DASHBOARD_PREVISION_FAIBLE);
    // Réalisé 5,2 M → echelleNice = 6 M (paliers fins) ou 10 M (paliers d'origine) ;
    // prévision minimale 4 000 → rapport de l'ordre de 1:1500 à 1:2500. On borne LARGEMENT
    // par le bas : le test garde l'ORDRE DE GRANDEUR, il ne fige pas la table de paliers
    // (qui évolue en #222) — sinon il casserait pour une raison sans rapport avec son objet.
    expect(ecrasement).toBeGreaterThanOrEqual(RAPPORT_BARRE_INVISIBLE);
  });

  it("conserve un cas SAIN, où la barre prévisionnelle est confortablement lisible", () => {
    // Contre-preuve : sans elle, « toutes les fixtures sont extrêmes » passerait le premier
    // test tout en supprimant la capacité à détecter une régression du cas nominal.
    const ecrasement = pireEcrasement(DEMO_DASHBOARD);
    expect(ecrasement).toBeLessThan(RAPPORT_BARRE_INVISIBLE);
  });

  it("distingue « aucune barre à rendre » d'un écrasement (zéro et autre devise)", () => {
    // Ces deux fixtures n'ont AUCUNE valeur prévisionnelle non nulle : elles couvrent le
    // défaut §5.4 (aplat muet), pas le défaut d'échelle. Elles ne doivent donc jamais être
    // comptées comme « cas extrême » — sinon la garde se croirait satisfaite à tort.
    expect(pireEcrasement(DEMO_DASHBOARD_PREVISION_ZERO)).toBe(Number.POSITIVE_INFINITY);
    expect(pireEcrasement(DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
