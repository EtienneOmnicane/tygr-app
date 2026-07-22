/**
 * Projection PRÉVISIONNELLE du dashboard (C1 — PLAN-conception-previsionnel-C.md §5).
 * Les fonctions sont PURES : ces tests sont la preuve de l'agrégateur, indépendamment
 * du SVG.
 *
 * Couvre les exigences de sortie du lot : occurrences (récurrente → plusieurs mois,
 * ponctuelle → un seul) correctement agrégées, MONO-DEVISE de base (jamais d'addition
 * cross-devise), mois « autres devises » à 0 + drapeau, frontière réalisé/prévisionnel
 * (jamais fusionnés), échelle englobant l'empilement, et cas vide.
 *
 * Le moteur de récurrence lui-même (clamp de quantième, tête vs dérivée) est couvert par
 * `echeances-recurrence.test.ts` — on ne le re-teste pas ici : on teste ce qui est
 * BRANCHÉ dessus. Les cas ci-dessous partent donc d'occurrences déjà expansées, sauf le
 * cas d'intégration qui passe VOLONTAIREMENT par `expanserOccurrences` pour prouver que
 * la chaîne moteur → grille ne perd rien.
 */
import { describe, expect, it } from "vitest";

import { expanserOccurrences } from "@/lib/echeances-recurrence";
import type { OccurrenceProjetee } from "@/lib/echeances-recurrence";
import {
  composerColonnes,
  largeurRelative,
  maxFenetreColonnes,
  maxPrevision,
  moisPrevision,
  projeterEcheancesSurGrille,
  projeterSurGrille,
  type MoisAffiche,
} from "@/components/dashboard/flux-projection";

/** Occurrence projetée — surchargée par cas. Montants POSITIFS (le sens = `direction`). */
function occurrence(p: Partial<OccurrenceProjetee> = {}): OccurrenceProjetee {
  return {
    echeanceId: "e1",
    direction: "decaissement",
    montant: "10000.00",
    devise: "MUR",
    dateEcheance: "2026-08-11",
    mois: "2026-08",
    rang: 1,
    ...p,
  };
}

/** Cellule de réalisé — pour les cas de frontière/échelle. */
function realise(p: Partial<MoisAffiche> = {}): MoisAffiche {
  return {
    libelleMois: "2026-07",
    entrees: "0",
    sorties: "0",
    variation: "0",
    autresDevises: false,
    ...p,
  };
}

describe("projeterEcheancesSurGrille — agrégation mensuelle", () => {
  it("ventile encaissement et décaissement selon `direction`, jamais le signe du montant", () => {
    // Tous les montants du modèle sont POSITIFS : lire leur signe rendrait « sorties = 0 ».
    const mois = projeterEcheancesSurGrille(
      [
        occurrence({ direction: "encaissement", montant: "500.00" }),
        occurrence({ direction: "decaissement", montant: "200.00" }),
      ],
      ["2026-08"],
      "MUR",
    );

    expect(mois[0].entrees).toBe("500.00");
    expect(mois[0].sorties).toBe("200.00");
    expect(mois[0].variation).toBe("300.00");
  });

  it("somme plusieurs occurrences d'un même mois sans perdre de centimes", () => {
    // 0.1 + 0.2 en float ferait 0.30000000000000004 (règle 8 : centimes BigInt).
    const mois = projeterEcheancesSurGrille(
      [
        occurrence({ montant: "0.10" }),
        occurrence({ montant: "0.20" }),
        occurrence({ montant: "1234.56" }),
      ],
      ["2026-08"],
      "MUR",
    );

    expect(mois[0].sorties).toBe("1234.86");
  });

  it("rend un mois SANS occurrence à 0 (la grille fait l'axe, pas la donnée)", () => {
    const mois = projeterEcheancesSurGrille(
      [occurrence({ mois: "2026-09", dateEcheance: "2026-09-11" })],
      ["2026-08", "2026-09", "2026-10"],
      "MUR",
    );

    expect(mois.map((m) => m.libelleMois)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(mois[0]).toMatchObject({
      entrees: "0.00",
      sorties: "0.00",
      autresDevises: false,
    });
    expect(mois[1].sorties).toBe("10000.00");
    expect(mois[2].sorties).toBe("0.00");
  });

  it("cas VIDE : aucune occurrence → grille entière à 0, aucun drapeau", () => {
    const mois = projeterEcheancesSurGrille([], ["2026-08", "2026-09"], "MUR");

    expect(mois).toHaveLength(2);
    // Écriture UNIFORME du zéro : toute valeur sort des centimes (« 0.00 »), qu'un mois
    // porte des occurrences ou non — jamais un « 0 » littéral selon le chemin de code.
    expect(mois.every((m) => m.entrees === "0.00" && m.sorties === "0.00")).toBe(true);
    expect(mois.some((m) => m.autresDevises)).toBe(false);
  });
});

describe("projeterEcheancesSurGrille — mono-devise (règle 8 / DASH-FX1)", () => {
  it("ne somme QUE la devise de base et lève le drapeau sur les autres", () => {
    const mois = projeterEcheancesSurGrille(
      [
        occurrence({ montant: "100.00", devise: "MUR" }),
        occurrence({ montant: "999.00", devise: "USD" }),
      ],
      ["2026-08"],
      "MUR",
    );

    expect(mois[0].sorties).toBe("100.00"); // 999 USD JAMAIS additionnés
    expect(mois[0].autresDevises).toBe(true);
  });

  it("mois qui n'a QUE d'autres devises → 0 + drapeau (jamais le montant étranger)", () => {
    const mois = projeterEcheancesSurGrille(
      [occurrence({ montant: "999.00", devise: "EUR" })],
      ["2026-08"],
      "MUR",
    );

    expect(mois[0]).toMatchObject({
      entrees: "0.00",
      sorties: "0.00",
      variation: "0.00",
      autresDevises: true,
    });
  });

  it("compare la devise sans tenir compte de la casse ni des espaces", () => {
    const mois = projeterEcheancesSurGrille(
      [occurrence({ montant: "100.00", devise: " mur " })],
      ["2026-08"],
      "MUR",
    );

    expect(mois[0].sorties).toBe("100.00");
    expect(mois[0].autresDevises).toBe(false);
  });
});

describe("chaîne moteur → grille (intégration)", () => {
  it("une RÉCURRENTE mensuelle alimente CHAQUE mois futur, une PONCTUELLE un seul", () => {
    // Le constat d'origine : une mensuelle était comptée UNE fois. Ici elle doit peser
    // sur août, septembre ET octobre.
    const recurrente = expanserOccurrences(
      {
        id: "loyer",
        direction: "decaissement",
        montant: "10000.00",
        montantRegle: null,
        devise: "MUR",
        dateEcheance: "2026-06-11",
        statut: "en_cours",
        recurrence: "mensuelle",
      },
      { debut: "2026-08-01", fin: "2026-10-31", deriveesDepuis: "2026-07-17" },
    );
    const ponctuelle = expanserOccurrences(
      {
        id: "facture",
        direction: "encaissement",
        montant: "5000.00",
        montantRegle: null,
        devise: "MUR",
        dateEcheance: "2026-09-20",
        statut: "en_cours",
        recurrence: null,
      },
      { debut: "2026-08-01", fin: "2026-10-31", deriveesDepuis: "2026-07-17" },
    );

    const mois = projeterEcheancesSurGrille(
      [...recurrente, ...ponctuelle],
      ["2026-08", "2026-09", "2026-10"],
      "MUR",
    );

    expect(mois.map((m) => m.sorties)).toEqual(["10000.00", "10000.00", "10000.00"]);
    expect(mois.map((m) => m.entrees)).toEqual(["0.00", "5000.00", "0.00"]);
  });
});

describe("composerColonnes — frontière réalisé / prévisionnel", () => {
  const realises = [realise({ libelleMois: "2026-06" }), realise({ libelleMois: "2026-07" })];
  const futurs = [
    { ...realise({ libelleMois: "2026-08" }), sorties: "10000.00" },
    { ...realise({ libelleMois: "2026-09" }), sorties: "10000.00" },
  ];

  it("un mois PASSÉ ne porte JAMAIS de prévision", () => {
    const colonnes = composerColonnes(realises, futurs, realise({ libelleMois: "2026-07" }));

    expect(colonnes[0].realise).not.toBeNull();
    expect(colonnes[0].prevision).toBeNull();
  });

  it("un mois FUTUR ne porte JAMAIS de réalisé", () => {
    const colonnes = composerColonnes(realises, futurs);

    const aout = colonnes.find((c) => c.libelleMois === "2026-08");
    expect(aout?.realise).toBeNull();
    expect(aout?.prevision?.sorties).toBe("10000.00");
  });

  it("le mois PIVOT porte les DEUX, séparés — jamais fusionnés en un chiffre (D2)", () => {
    const colonnes = composerColonnes(
      [realise({ libelleMois: "2026-06" }), realise({ libelleMois: "2026-07", sorties: "300.00" })],
      futurs,
      realise({ libelleMois: "2026-07", sorties: "700.00" }),
    );

    const pivot = colonnes.find((c) => c.libelleMois === "2026-07");
    expect(pivot?.realise?.sorties).toBe("300.00");
    expect(pivot?.prevision?.sorties).toBe("700.00");
    // Le mois d'ancrage n'est PAS dupliqué en tête de la zone future.
    expect(colonnes.filter((c) => c.libelleMois === "2026-07")).toHaveLength(1);
  });

  it("sans prévision (fenêtre passée, D4) : l'axe reste EXACTEMENT celui du réalisé", () => {
    const colonnes = composerColonnes(realises, []);

    expect(colonnes.map((c) => c.libelleMois)).toEqual(["2026-06", "2026-07"]);
    // Pas de colonnes fantômes à zéro : une prévision vide ≠ une prévision nulle (§5.3).
    expect(colonnes.every((c) => c.prevision === null)).toBe(true);
  });
});

describe("maxFenetreColonnes — échelle", () => {
  it("englobe la PRÉVISION : une grosse échéance future ne déborde pas de la zone", () => {
    const colonnes = composerColonnes(
      [realise({ libelleMois: "2026-07", sorties: "100.00" })],
      [{ ...realise({ libelleMois: "2026-08" }), sorties: "50000.00" }],
    );

    expect(maxFenetreColonnes(colonnes)).toBe(50000);
  });

  it("SOMME les segments EMPILÉS du mois pivot (sinon la barre déborde, D2)", () => {
    const colonnes = composerColonnes(
      [realise({ libelleMois: "2026-07", sorties: "300.00" })],
      [],
      realise({ libelleMois: "2026-07", sorties: "700.00" }),
    );

    // 300 (réalisé) + 700 (prévision) empilés = 1000 : c'est le TOTAL qui doit tenir.
    expect(maxFenetreColonnes(colonnes)).toBe(1000);
  });

  it("axe entièrement vide → 0 (le déclencheur de l'état « aucun mouvement »)", () => {
    expect(maxFenetreColonnes(composerColonnes([realise()], []))).toBe(0);
  });

  it("réalisé vide MAIS prévision présente → max > 0 (l'écran ne doit pas se dire vide)", () => {
    // Défaut n°1 du plan §5.2 : un workspace neuf sans transactions mais AVEC des
    // échéances saisies n'afficherait rien si l'échelle ignorait la prévision.
    const colonnes = composerColonnes(
      [realise({ libelleMois: "2026-07" })],
      [{ ...realise({ libelleMois: "2026-08" }), sorties: "10000.00" }],
    );

    expect(maxFenetreColonnes(colonnes)).toBe(10000);
  });
});

describe("cohérence avec le réalisé (projeterSurGrille)", () => {
  it("les deux projections rendent le MÊME axe pour la même grille", () => {
    // Garantit que réalisé et prévision se superposent colonne par colonne dans le SVG.
    const grille = ["2026-08", "2026-09"];
    const reel = projeterSurGrille([], grille, "MUR");
    const prevu = projeterEcheancesSurGrille([], grille, "MUR");

    expect(reel.map((m) => m.libelleMois)).toEqual(prevu.map((m) => m.libelleMois));
  });
});

/* ------------------------------------------------------------------ */
/* ENCART « Échéances à venir » (FLUX-PREV-AXE1, option E)             */
/* ------------------------------------------------------------------ */

describe("moisPrevision — ordre d'affichage de l'encart", () => {
  it("place le mois d'ANCRAGE en tête, puis les mois futurs", () => {
    const mois = moisPrevision({
      moisCourant: realise({ libelleMois: "2026-06" }),
      moisFuturs: [
        realise({ libelleMois: "2026-07" }),
        realise({ libelleMois: "2026-08" }),
      ],
    });

    expect(mois.map((m) => m.libelleMois)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("rend le seul mois d'ancrage quand il n'y a aucun mois futur", () => {
    const mois = moisPrevision({
      moisCourant: realise({ libelleMois: "2026-06" }),
      moisFuturs: [],
    });

    expect(mois).toHaveLength(1);
  });
});

describe("maxPrevision — échelle PROPRE de l'encart", () => {
  it("ignore totalement le réalisé : seules les échéances fixent le plafond", () => {
    // C'est l'invariant du lot. Sur l'axe partagé, ces mêmes valeurs étaient rapportées à
    // un réalisé de plusieurs millions et rendaient moins d'un pixel.
    const max = maxPrevision([
      realise({ libelleMois: "2026-07", sorties: "10000.00" }),
      realise({ libelleMois: "2026-08", entrees: "25000.00" }),
    ]);

    expect(max).toBe(25000);
  });

  it("prend la plus grande valeur tous SENS confondus", () => {
    const max = maxPrevision([
      realise({ entrees: "3000.00", sorties: "9000.00" }),
      realise({ entrees: "4000.00", sorties: "1000.00" }),
    ]);

    expect(max).toBe(9000);
  });

  it("rend 0 quand aucune échéance ne tombe (zone muette)", () => {
    expect(maxPrevision([realise(), realise()])).toBe(0);
    expect(maxPrevision([])).toBe(0);
  });
});

describe("largeurRelative — géométrie de la barre d'encart", () => {
  it("donne 100 % à la valeur qui fixe l'échelle", () => {
    expect(largeurRelative("25000.00", 25000)).toBe(100);
  });

  it("reste proportionnelle en dessous", () => {
    expect(largeurRelative("5000.00", 25000)).toBe(20);
  });

  it("rend une part MINUSCULE mais non nulle sur un fort écart interne", () => {
    // Rs 2 500 face à Rs 3 150 000 : la barre est irreprésentable (le tick prend le relais)
    // MAIS elle n'est pas nulle — la valeur existe, et son montant reste écrit.
    const largeur = largeurRelative("2500.00", 3150000);

    expect(largeur).toBeGreaterThan(0);
    expect(largeur).toBeLessThan(0.1);
  });

  it("rend 0 sur une valeur nulle (aucune barre à dessiner, pas une barre écrasée)", () => {
    expect(largeurRelative("0.00", 25000)).toBe(0);
  });

  it("rend 0 sur un plafond inexploitable plutôt qu'Infinity ou NaN", () => {
    expect(largeurRelative("1000.00", 0)).toBe(0);
    expect(largeurRelative("1000.00", Number.NaN)).toBe(0);
  });

  it("borne à 100 % une valeur qui dépasserait son plafond", () => {
    // Défense en profondeur : le plafond vient de `maxPrevision` sur les mêmes cellules,
    // donc ce cas ne peut pas arriver — mais une barre à 300 % déborderait sa carte.
    expect(largeurRelative("50000.00", 25000)).toBe(100);
  });
});
