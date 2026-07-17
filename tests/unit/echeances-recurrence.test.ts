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
    const o = expanserOccurrences(echeance(), { fin: "2026-09-09" });
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
    expect(expanserOccurrences(echeance(), { fin: "2026-06-10" })).toEqual([]);
  });

  it("ne projette rien si le statut est terminal", () => {
    for (const statut of ["payee", "annulee"] as const) {
      expect(expanserOccurrences(echeance({ statut }), { fin: "2026-12-31" })).toEqual([]);
    }
  });

  it("projette le RESTANT dû, pas le montant plein (règlement partiel)", () => {
    const o = expanserOccurrences(
      echeance({ statut: "partiel", montantRegle: "2500.50" }),
      { fin: "2026-09-09" },
    );
    expect(o).toHaveLength(1);
    expect(o[0].montant).toBe("7499.50");
  });

  it("ne projette pas une tête intégralement soldée (restant nul)", () => {
    const o = expanserOccurrences(
      echeance({ statut: "partiel", montantRegle: "10000.00" }),
      { fin: "2026-09-09" },
    );
    expect(o).toEqual([]);
  });
});

describe("expanserOccurrences — expansion MENSUELLE (le bug corrigé)", () => {
  // Le cas EXACT du constat : mensuelle de 10 000 au 11 juin, vue le 1er juin.
  // Avant C0 : 10 000 à plat sur 30/60/90 j. Attendu : 1 / 2 / 3 occurrences.
  const mensuelle = echeance({ recurrence: "mensuelle" });

  it("horizon 30 j → 1 occurrence (10 000)", () => {
    const o = expanserOccurrences(mensuelle, { fin: ajouterJours("2026-06-01", 30)! });
    expect(dates(o)).toEqual(["2026-06-11"]);
  });

  it("horizon 60 j → 2 occurrences (20 000)", () => {
    const o = expanserOccurrences(mensuelle, { fin: ajouterJours("2026-06-01", 60)! });
    expect(dates(o)).toEqual(["2026-06-11", "2026-07-11"]);
  });

  it("horizon 90 j → 3 occurrences (30 000)", () => {
    const o = expanserOccurrences(mensuelle, { fin: ajouterJours("2026-06-01", 90)! });
    expect(dates(o)).toEqual(["2026-06-11", "2026-07-11", "2026-08-11"]);
    expect(o.map((x) => x.rang)).toEqual([0, 1, 2]);
    // Toutes au montant plein : aucun règlement partiel ici.
    expect(o.map((x) => x.montant)).toEqual(["10000.00", "10000.00", "10000.00"]);
  });

  it("porte le mois YYYY-MM de CHAQUE occurrence (clé de la grille)", () => {
    const o = expanserOccurrences(mensuelle, { fin: "2026-08-31" });
    expect(o.map((x) => x.mois)).toEqual(["2026-06", "2026-07", "2026-08"]);
  });
});

describe("expanserOccurrences — expansion TRIMESTRIELLE", () => {
  it("avance de 3 mois en 3 mois", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2026-01-15", recurrence: "trimestrielle" }),
      { fin: "2026-12-31" },
    );
    expect(dates(o)).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  });

  it("n'apparaît dans l'horizon 90 j que si elle y tombe", () => {
    const t = echeance({ dateEcheance: "2026-06-11", recurrence: "trimestrielle" });
    // 90 j depuis le 1er juin = 30 août : la 2e occurrence (11 sept) est HORS fenêtre.
    expect(dates(expanserOccurrences(t, { fin: ajouterJours("2026-06-01", 90)! }))).toEqual([
      "2026-06-11",
    ]);
    // 120 j = 29 sept : la 2e entre dans la fenêtre.
    expect(dates(expanserOccurrences(t, { fin: ajouterJours("2026-06-01", 120)! }))).toEqual([
      "2026-06-11",
      "2026-09-11",
    ]);
  });
});

describe("expanserOccurrences — D1 « gabarit + tête » (fin de l'optimisme silencieux)", () => {
  it("une tête PAYEE n'éteint PAS les occurrences futures", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "payee" }),
      { fin: "2026-08-31" },
    );
    // La tête (11 juin) est payée → absente. Juillet/août restent dus.
    expect(dates(o)).toEqual(["2026-07-11", "2026-08-11"]);
    expect(o.map((x) => x.rang)).toEqual([1, 2]);
    expect(o.map((x) => x.montant)).toEqual(["10000.00", "10000.00"]);
  });

  it("une tête ANNULEE n'éteint PAS les occurrences futures", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "annulee" }),
      { fin: "2026-08-31" },
    );
    expect(dates(o)).toEqual(["2026-07-11", "2026-08-11"]);
  });

  it("un règlement partiel ne concerne QUE la tête (jamais les dérivées)", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "partiel", montantRegle: "4000.00" }),
      { fin: "2026-08-31" },
    );
    // Tête = restant (6 000) ; dérivées = montant PLEIN (10 000). Un acompte de juin
    // ne doit PAS raboter juillet/août.
    expect(o.map((x) => x.montant)).toEqual(["6000.00", "10000.00", "10000.00"]);
  });

  it("une tête soldée à 100 % n'éteint pas la série", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "partiel", montantRegle: "10000.00" }),
      { fin: "2026-08-31" },
    );
    expect(dates(o)).toEqual(["2026-07-11", "2026-08-11"]);
  });
});

describe("expanserOccurrences — clamp de quantième (piège n°1)", () => {
  it("clampe au dernier jour du mois court", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2026-01-31", recurrence: "mensuelle" }),
      { fin: "2026-04-30" },
    );
    // ⚠️ LE test du lot : le clamp ne doit PAS être cumulatif. Un décalage naïf
    // depuis l'occurrence précédente donnerait 28 mars / 28 avril — la série
    // dériverait DÉFINITIVEMENT après février.
    expect(dates(o)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("respecte le 29 février d'une année bissextile", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2024-01-31", recurrence: "mensuelle" }),
      { fin: "2024-03-31" },
    );
    expect(dates(o)).toEqual(["2024-01-31", "2024-02-29", "2024-03-31"]);
  });

  it("clampe une trimestrielle du 30 novembre sur février", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2025-11-30", recurrence: "trimestrielle" }),
      { fin: "2026-03-31" },
    );
    expect(dates(o)).toEqual(["2025-11-30", "2026-02-28"]);
  });

  it("franchit l'année sans dériver", () => {
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2026-11-15", recurrence: "mensuelle" }),
      { fin: "2027-02-28" },
    );
    expect(dates(o)).toEqual(["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15"]);
  });
});

describe("expanserOccurrences — bornes", () => {
  it("inclut une occurrence tombant PILE sur la borne haute", () => {
    const o = expanserOccurrences(echeance({ recurrence: "mensuelle" }), {
      fin: "2026-07-11",
    });
    expect(dates(o)).toEqual(["2026-06-11", "2026-07-11"]);
  });

  it("exclut une occurrence tombant un jour APRÈS la borne haute", () => {
    const o = expanserOccurrences(echeance({ recurrence: "mensuelle" }), {
      fin: "2026-07-10",
    });
    expect(dates(o)).toEqual(["2026-06-11"]);
  });

  it("sans borne basse : le RETARD reste compté (une dette exigible hier reste due)", () => {
    // Tête très antérieure à la fenêtre, non récurrente : toujours projetée.
    const o = expanserOccurrences(echeance({ dateEcheance: "2026-01-05" }), {
      fin: "2026-09-09",
    });
    expect(dates(o)).toEqual(["2026-01-05"]);
  });

  it("avec borne basse : filtre les occurrences antérieures en gardant les rangs RÉELS", () => {
    // Série mensuelle du 11 janvier, fenêtre juin→août (usage dashboard, lot suivant).
    const o = expanserOccurrences(
      echeance({ dateEcheance: "2026-01-11", recurrence: "mensuelle" }),
      { debut: "2026-06-01", fin: "2026-08-31" },
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
      }),
    ).toEqual([]);
  });

  it("borne aberrante → série bornée par le garde-fou (pas d'explosion)", () => {
    const o = expanserOccurrences(echeance({ recurrence: "mensuelle" }), {
      fin: "2126-01-01", // 100 ans
    });
    expect(o).toHaveLength(240); // MAX_OCCURRENCES
  });
});

describe("expanserOccurrences — robustesse (on n'invente jamais un montant)", () => {
  it("montant illisible → aucune occurrence", () => {
    expect(expanserOccurrences(echeance({ montant: "abc" }), { fin: "2026-12-31" })).toEqual(
      [],
    );
  });

  it("montant_regle illisible → la tête n'est pas projetée (pas de restant gonflé)", () => {
    const o = expanserOccurrences(
      echeance({ recurrence: "mensuelle", statut: "partiel", montantRegle: "n/a" }),
      { fin: "2026-07-31" },
    );
    // La tête est refusée (restant indéterminé), la série continue.
    expect(dates(o)).toEqual(["2026-07-11"]);
  });

  it("date d'échéance invalide → aucune occurrence", () => {
    expect(
      expanserOccurrences(echeance({ dateEcheance: "2026-02-30" }), { fin: "2026-12-31" }),
    ).toEqual([]);
  });

  it("conserve les centimes sans dérive de float", () => {
    const o = expanserOccurrences(
      echeance({ montant: "0.10", statut: "partiel", montantRegle: "0.03" }),
      { fin: "2026-09-09" },
    );
    expect(o[0].montant).toBe("0.07"); // 0.1 − 0.03 en float donnerait 0.07000000000000001
  });
});
