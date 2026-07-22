/**
 * Moteur d'expansion des échéances récurrentes (C0 — PLAN-conception-previsionnel-C.md
 * §4.4). La fonction étant PURE, les tests SONT la preuve du lot : il n'y a pas d'UI.
 *
 * Couvre : nominal, expansion mensuelle/trimestrielle, sémantique « gabarit + tête »
 * (D1 — une tête terminale n'éteint PAS la série), clamp de quantième NON CUMULATIF,
 * bissextilité, bornes, garde-fous.
 */
import { describe, expect, it } from "vitest";

import {
  ajouterJours,
  expanserOccurrences,
  type EcheanceProjetable,
} from "@/lib/echeances-recurrence";

/** Gabarit d'échéance — surchargé par cas. Montants POSITIFS (règle 8). */
function echeance(p: Partial<EcheanceProjetable> = {}): EcheanceProjetable {
  return {
    id: "e1",
    direction: "decaissement",
    montant: "10000.00",
    montantRegle: null,
    devise: "MUR",
    dateEcheance: "2026-06-11",
    statut: "en_cours",
    recurrence: null,
    ...p,
  };
}

const dates = (o: { dateEcheance: string }[]) => o.map((x) => x.dateEcheance);

/**
 * Borne des DÉRIVÉES par défaut de cette suite. Antérieure à TOUTES les têtes de fixture
 * (la plus ancienne est 2024-01-31) → volontairement NEUTRE : chaque cas isole ce qu'il
 * teste (récurrence, clamp, bornes) sans que la borne des dérivées n'interfère.
 * Les cas qui testent la borne elle-même la surchargent explicitement (bloc dédié).
 */
const DEPUIS_DEFAUT = "2000-01-01";

describe("ajouterJours (arithmétique pure, sans Date — E20)", () => {
  it("ajoute des jours en franchissant les mois", () => {
    expect(ajouterJours("2026-06-11", 30)).toBe("2026-07-11");
    expect(ajouterJours("2026-06-11", 90)).toBe("2026-09-09");
  });

  it("franchit une année", () => {
    expect(ajouterJours("2026-12-25", 10)).toBe("2027-01-04");
  });

  it("tient compte de la bissextilité", () => {
    expect(ajouterJours("2024-02-28", 1)).toBe("2024-02-29"); // 2024 bissextile
    expect(ajouterJours("2026-02-28", 1)).toBe("2026-03-01"); // 2026 non bissextile
  });

  it("refuse une entrée invalide plutôt que d'inventer une date", () => {
    expect(ajouterJours("2026-02-30", 1)).toBeNull(); // n'existe pas
    expect(ajouterJours("pas-une-date", 1)).toBeNull();
    expect(ajouterJours("2026-06-11", -1)).toBeNull();
  });
});

describe("expanserOccurrences — échéance NON récurrente (comportement inchangé)", () => {
  it("projette une occurrence unique à sa date (rang 0)", () => {
    const o = expanserOccurrences(echeance(), { fin: "2026-09-09", deriveesDepuis: DEPUIS_DEFAUT });
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({
      dateEcheance: "2026-06-11",
      mois: "2026-06",
      montant: "10000.00",
      rang: 0,
      devise: "MUR",
      direction: "decaissement",
    });
  });

  it("ne projette rien hors de la borne haute", () => {
    expect(expanserOccurrences(echeance(), { fin: "2026-06-10", deriveesDepuis: DEPUIS_DEFAUT })).toEqual([]);
  });

  it("ne projette rien si le statut est terminal", () => {
    for (const statut of ["payee", "annulee"] as const) {
      expect(expanserOccurrences(echeance({ statut }), { fin: "2026-12-31", deriveesDepuis: DEPUIS_DEFAUT })).toEqual([]);
    }
  });

  it("projette le RESTANT dû, pas le montant plein (règlement partiel)", () => {
    const o = expanserOccurrences(
      echeance({ statut: "partiel", montantRegle: "2500.50" }),
      { fin: "2026-09-09", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(o).toHaveLength(1);
    expect(o[0].montant).toBe("7499.50");
  });

  it("ne projette pas une tête intégralement soldée (restant nul)", () => {
    const o = expanserOccurrences(
      echeance({ statut: "partiel", montantRegle: "10000.00" }),
      { fin: "2026-09-09", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(o).toEqual([]);
  });
});

describe("expanserOccurrences — expansion MENSUELLE (le bug corrigé)", () => {
  // Le cas EXACT du constat : mensuelle de 10 000 au 11 juin, vue le 1er juin.
  // Avant C0 : 10 000 à plat sur 30/60/90 j. Attendu : 1 / 2 / 3 occurrences.
  const mensuelle = echeance({ recurrence: "mensuelle" });

  it("horizon 30 j → 1 occurrence (10 000)", () => {
    const o = expanserOccurrences(mensuelle, { fin: ajouterJours("2026-06-01", 30)!, deriveesDepuis: DEPUIS_DEFAUT });
    expect(dates(o)).toEqual(["2026-06-11"]);
  });

  it("horizon 60 j → 2 occurrences (20 000)", () => {
    const o = expanserOccurrences(mensuelle, { fin: ajouterJours("2026-06-01", 60)!, deriveesDepuis: DEPUIS_DEFAUT });
    expect(dates(o)).toEqual(["2026-06-11", "2026-07-11"]);
  });

  it("horizon 90 j → 3 occurrences (30 000)", () => {
    const o = expanserOccurrences(mensuelle, { fin: ajouterJours("2026-06-01", 90)!, deriveesDepuis: DEPUIS_DEFAUT });
    expect(dates(o)).toEqual(["2026-06-11", "2026-07-11", "2026-08-11"]);
    expect(o.map((x) => x.rang)).toEqual([0, 1, 2]);
    // Toutes au montant plein : aucun règlement partiel ici.
    expect(o.map((x) => x.montant)).toEqual(["10000.00", "10000.00", "10000.00"]);
  });

  it("porte le mois YYYY-MM de CHAQUE occurrence (clé de la grille)", () => {
    const o = expanserOccurrences(mensuelle, { fin: "2026-08-31", deriveesDepuis: DEPUIS_DEFAUT });
    expect(o.map((x) => x.mois)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });
});

describe("expanserOccurrences — expansion TRIMESTRIELLE", () => {
  it("avance de 3 mois en 3 mois", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2026-01-15", recurrence: "trimestrielle" }),
      { fin: "2026-12-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(dates(o)).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  });

  it("n'apparaît dans l'horizon 90 j que si elle y tombe", () => {
    const t = echeance({ dateEcheance: "2026-06-11", recurrence: "trimestrielle" });
    // 90 j depuis le 1er juin = 30 août : la 2e occurrence (11 sept) est HORS fenêtre.
    expect(dates(expanserOccurrences(t, { fin: ajouterJours("2026-06-01", 90)!, deriveesDepuis: DEPUIS_DEFAUT }))).toEqual([
      "2026-06-11",
    ]);
    // 120 j = 29 sept : la 2e entre dans la fenêtre.
    expect(dates(expanserOccurrences(t, { fin: ajouterJours("2026-06-01", 120)!, deriveesDepuis: DEPUIS_DEFAUT }))).toEqual([
      "2026-06-11",
      "2026-09-11",
    ]);
  });
});

describe("expanserOccurrences — D1 « gabarit + tête » (fin de l'optimisme silencieux)", () => {
  it("une tête PAYEE n'éteint PAS les occurrences futures", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "payee" }),
      { fin: "2026-08-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    // La tête (11 juin) est payée → absente. Juillet/août restent dus.
    expect(dates(o)).toEqual(["2026-07-11", "2026-08-11"]);
    expect(o.map((x) => x.rang)).toEqual([1, 2]);
    expect(o.map((x) => x.montant)).toEqual(["10000.00", "10000.00"]);
  });

  it("une tête ANNULEE n'éteint PAS les occurrences futures", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "annulee" }),
      { fin: "2026-08-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(dates(o)).toEqual(["2026-07-11", "2026-08-11"]);
  });

  it("un règlement partiel ne concerne QUE la tête (jamais les dérivées)", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "partiel", montantRegle: "4000.00" }),
      { fin: "2026-08-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    // Tête = restant (6 000) ; dérivées = montant PLEIN (10 000). Un acompte de juin
    // ne doit PAS raboter juillet/août.
    expect(o.map((x) => x.montant)).toEqual(["6000.00", "10000.00", "10000.00"]);
  });

  it("une tête soldée à 100 % n'éteint pas la série", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "partiel", montantRegle: "10000.00" }),
      { fin: "2026-08-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(dates(o)).toEqual(["2026-07-11", "2026-08-11"]);
  });
});

describe("expanserOccurrences — clamp de quantième (piège n°1)", () => {
  it("clampe au dernier jour du mois court", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2026-01-31", recurrence: "mensuelle" }),
      { fin: "2026-04-30", deriveesDepuis: DEPUIS_DEFAUT },
    );
    // ⚠️ LE test du lot : le clamp ne doit PAS être cumulatif. Un décalage naïf
    // depuis l'occurrence précédente donnerait 28 mars / 28 avril — la série
    // dériverait DÉFINITIVEMENT après février.
    expect(dates(o)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("respecte le 29 février d'une année bissextile", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2024-01-31", recurrence: "mensuelle" }),
      { fin: "2024-03-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(dates(o)).toEqual(["2024-01-31", "2024-02-29", "2024-03-31"]);
  });

  it("clampe une trimestrielle du 30 novembre sur février", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2025-11-30", recurrence: "trimestrielle" }),
      { fin: "2026-03-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(dates(o)).toEqual(["2025-11-30", "2026-02-28"]);
  });

  it("franchit l'année sans dériver", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2026-11-15", recurrence: "mensuelle" }),
      { fin: "2027-02-28", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(dates(o)).toEqual(["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15"]);
  });
});

describe("expanserOccurrences — bornes", () => {
  it("inclut une occurrence tombant PILE sur la borne haute", () => {
    const o = expanserOccurrences(echeance({ recurrence: "mensuelle" }), {
      fin: "2026-07-11",
      deriveesDepuis: DEPUIS_DEFAUT,
    });
    expect(dates(o)).toEqual(["2026-06-11", "2026-07-11"]);
  });

  it("exclut une occurrence tombant un jour APRÈS la borne haute", () => {
    const o = expanserOccurrences(echeance({ recurrence: "mensuelle" }), {
      fin: "2026-07-10",
      deriveesDepuis: DEPUIS_DEFAUT,
    });
    expect(dates(o)).toEqual(["2026-06-11"]);
  });

  it("sans borne basse : le RETARD reste compté (une dette exigible hier reste due)", () => {
    // Tête très antérieure à la fenêtre, non récurrente : toujours projetée.
    const o = expanserOccurrences(echeance({ dateEcheance: "2026-01-05" }), {
      fin: "2026-09-09",
      deriveesDepuis: DEPUIS_DEFAUT,
    });
    expect(dates(o)).toEqual(["2026-01-05"]);
  });

  it("avec borne basse : filtre les occurrences antérieures en gardant les rangs RÉELS", () => {
    // Série mensuelle du 11 janvier, fenêtre juin→août (usage dashboard, lot suivant).
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2026-01-11", recurrence: "mensuelle" }),
      { debut: "2026-06-01", fin: "2026-08-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(dates(o)).toEqual(["2026-06-11", "2026-07-11", "2026-08-11"]);
    // Rangs 5/6/7 : comptés depuis la tête, pas depuis la fenêtre. Aucune ne porte
    // le restant dû (la tête est hors fenêtre).
    expect(o.map((x) => x.rang)).toEqual([5, 6, 7]);
  });

  it("bornes inversées → aucune occurrence (jamais de boucle infinie)", () => {
    expect(
      expanserOccurrences(echeance({ recurrence: "mensuelle" }), {
        debut: "2026-09-01",
        fin: "2026-06-01",
        deriveesDepuis: DEPUIS_DEFAUT,
      }),
    ).toEqual([]);
  });
});

/**
 * Borne des DÉRIVÉES (décision Etienne 2026-07-17, sur constat de cross-review).
 *
 * La TÊTE porte un `statut` EXPLICITE → son retard est fiable, il reste compté. Une
 * occurrence DÉRIVÉE passée n'a AUCUN statut : rien ne dit si elle a été réglée. Sans
 * cette borne, la synthèse remplaçait une sous-estimation bornée par une SUR-estimation
 * croissante — sur un montant affiché (règle 9 : dette sur les montants interdite).
 */
describe("expanserOccurrences — borne des DÉRIVÉES (arriéré fantôme)", () => {
  const AUJ = "2026-07-08";

  it("ne projette PAS les dérivées passées, mais garde la tête en retard", () => {
    // Gabarit mensuel vieux d'un an, jamais pointé, tête en retard.
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2025-07-11", recurrence: "mensuelle" }),
      { fin: ajouterJours(AUJ, 30)!, deriveesDepuis: AUJ },
    );
    // Tête (retard, statut explicite) + la seule dérivée à venir dans les 30 j.
    // SANS la borne : 13 occurrences — 130 000 au lieu de 20 000 — et +1 chaque mois.
    expect(dates(o)).toEqual(["2025-07-11", "2026-07-11"]);
    expect(o.map((x) => x.rang)).toEqual([0, 12]); // rang réel, jamais renuméroté
  });

  it("un gabarit ANCIEN ne perd pas son occurrence due (garde-fou qui aplatissait tout)", () => {
    // ⚠️ LE constat de cross-review : le plafond était atteint AVANT la fenêtre. La
    // boucle rendait 240 occurrences de 2000→2019, PERDAIT l'occurrence réellement due
    // (2026-07-11) et rendait H30 = H60 = H90 — le bug plat que ce module corrige.
    const ancien = echeance({ dateEcheance: "2000-01-11", recurrence: "mensuelle" });

    const h30 = expanserOccurrences(ancien, {
      fin: ajouterJours(AUJ, 30)!,
      deriveesDepuis: AUJ,
    });
    const h90 = expanserOccurrences(ancien, {
      fin: ajouterJours(AUJ, 90)!,
      deriveesDepuis: AUJ,
    });

    // La tête de 2000 reste due (retard explicite) ; les dérivées reprennent à AUJ.
    expect(dates(h30)).toEqual(["2000-01-11", "2026-07-11"]);
    expect(dates(h90)).toEqual(["2000-01-11", "2026-07-11", "2026-08-11", "2026-09-11"]);
    // Les horizons ne sont plus plats — c'est tout l'objet du lot.
    expect(h30.length).not.toBe(h90.length);
    // Le rang reste l'index RÉEL depuis la tête (318 mois), jamais renuméroté.
    expect(h30[1].rang).toBe(318);
  });

  it("garde-fou : la sortie reste bornée sur une fenêtre aberrante, dates comprises", () => {
    const o = expanserOccurrences(echeance({ recurrence: "mensuelle" }), {
      fin: "2126-01-01", // 100 ans
      deriveesDepuis: DEPUIS_DEFAUT,
    });
    // 1 tête + MAX_OCCURRENCES dérivées. On asserte les DATES (une longueur seule
    // passerait aussi avec un moteur qui émettrait 240 occurrences fausses).
    expect(o).toHaveLength(241);
    expect(o[0].dateEcheance).toBe("2026-06-11"); // tête
    expect(o[1].dateEcheance).toBe("2026-07-11"); // 1re dérivée
    expect(o[240].dateEcheance).toBe("2046-06-11"); // 240e dérivée = tête + 240 mois
  });
});

describe("expanserOccurrences — robustesse (on n'invente jamais un montant)", () => {
  it("montant illisible → aucune occurrence", () => {
    expect(expanserOccurrences(echeance({ montant: "abc" }), { fin: "2026-12-31", deriveesDepuis: DEPUIS_DEFAUT })).toEqual(
      [],
    );
  });

  it("montant_regle illisible → la tête n'est pas projetée (pas de restant gonflé)", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "partiel", montantRegle: "n/a" }),
      { fin: "2026-07-31", deriveesDepuis: DEPUIS_DEFAUT },
    );
    // La tête est refusée (restant indéterminé), la série continue.
    expect(dates(o)).toEqual(["2026-07-11"]);
  });

  it("date d'échéance invalide → aucune occurrence", () => {
    expect(
      expanserOccurrences(echeance({ dateEcheance: "2026-02-30" }), { fin: "2026-12-31", deriveesDepuis: DEPUIS_DEFAUT }),
    ).toEqual([]);
  });

  it("conserve les centimes sans dérive de float", () => {
    const o = expanserOccurrences(
      echeance({ montant: "0.10", statut: "partiel", montantRegle: "0.03" }),
      { fin: "2026-09-09", deriveesDepuis: DEPUIS_DEFAUT },
    );
    expect(o[0].montant).toBe("0.07"); // 0.1 − 0.03 en float donnerait 0.07000000000000001
  });
});
