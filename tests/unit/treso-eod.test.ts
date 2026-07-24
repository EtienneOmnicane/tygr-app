/**
 * Trésorerie EOD — helpers PURS (TRESO-EOD-ELECTION) : report §3, contrôle de
 * complétude §4.2, consolidé multi-comptes D6-a (PLAN-treso-eod.md §7-C/§7-D).
 * Fixtures volontairement IRRÉGULIÈRES (trous, multi-devise, écarts) — un jeu
 * trop régulier rendrait les cas décisifs non capturables (plan §7, note fixtures).
 */
import { describe, expect, it } from "vitest";

import { enCentimesSigne } from "@/lib/montant-centimes";
import {
  consoliderCourbeFiable,
  evaluerCompletude,
  jourSuivant,
  reporterSerie,
  type CompteEod,
} from "@/server/treso/eod";

describe("enCentimesSigne (montant-centimes — pendant signé, règle 8)", () => {
  it("parse les soldes signés (découvert) en centimes BigInt exacts", () => {
    expect(enCentimesSigne("1234.50")).toBe(BigInt(123450));
    expect(enCentimesSigne("-1234.50")).toBe(BigInt(-123450));
    expect(enCentimesSigne("0")).toBe(BigInt(0));
    expect(enCentimesSigne("-0.00")).toBe(BigInt(0)); // zéro négatif = zéro
  });

  it("refuse les formes invalides — null, jamais un repli silencieux", () => {
    for (const mauvais of ["", "abc", "1,50", "1e3", "--5", "1.234"]) {
      expect(enCentimesSigne(mauvais)).toBeNull();
    }
  });
});

describe("jourSuivant (itération de jours comptables, pur — aucun fuseau)", () => {
  it("incrémente à travers fin de mois, fin d'année et 29 février", () => {
    expect(jourSuivant("2026-07-23")).toBe("2026-07-24");
    expect(jourSuivant("2026-06-30")).toBe("2026-07-01");
    expect(jourSuivant("2026-12-31")).toBe("2027-01-01");
    expect(jourSuivant("2028-02-28")).toBe("2028-02-29"); // bissextile
    expect(jourSuivant("2027-02-28")).toBe("2027-03-01"); // non bissextile
  });
});

describe("reporterSerie — report AVANT uniquement (§3.1, §7-D)", () => {
  const bornes = { from: "2026-07-01", to: "2026-07-06" };

  it("comble les trous par la valeur ANTÉRIEURE et prolonge le bord droit jusqu'à to", () => {
    const serie = reporterSerie(
      [
        { date: "2026-07-02", solde: "100.00" },
        { date: "2026-07-04", solde: "250.00" },
      ],
      bornes,
    );
    expect(serie).toEqual([
      { date: "2026-07-02", solde: "100.00", dateSource: "2026-07-02" },
      { date: "2026-07-03", solde: "100.00", dateSource: "2026-07-02" }, // reporté
      { date: "2026-07-04", solde: "250.00", dateSource: "2026-07-04" },
      { date: "2026-07-05", solde: "250.00", dateSource: "2026-07-04" }, // reporté
      { date: "2026-07-06", solde: "250.00", dateSource: "2026-07-04" }, // bord droit
    ]);
  });

  it("AUCUN report avant le premier EOD connu (pas de solde plat fabriqué)", () => {
    const serie = reporterSerie([{ date: "2026-07-03", solde: "9.99" }], bornes);
    // La série DÉMARRE au premier EOD réel — les 1er et 2 juillet n'existent pas.
    expect(serie[0]).toEqual({ date: "2026-07-03", solde: "9.99", dateSource: "2026-07-03" });
    expect(serie.map((j) => j.date)).toEqual([
      "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06",
    ]);
  });

  it("le dernier EOD ANTÉRIEUR à from ancre le bord gauche de la fenêtre", () => {
    const serie = reporterSerie(
      [
        { date: "2026-06-20", solde: "5.00" }, // vieux — écrasé par le plus récent
        { date: "2026-06-28", solde: "70.00" }, // ancre (dernier ≤ from)
        { date: "2026-07-05", solde: "80.00" },
      ],
      bornes,
    );
    expect(serie[0]).toEqual({ date: "2026-07-01", solde: "70.00", dateSource: "2026-06-28" });
    expect(serie[4]).toEqual({ date: "2026-07-05", solde: "80.00", dateSource: "2026-07-05" });
    expect(serie).toHaveLength(6); // axe continu 07-01 → 07-06
  });

  it("aucun EOD ≤ to → série VIDE ; bornes inversées → série VIDE", () => {
    expect(reporterSerie([{ date: "2026-07-09", solde: "1.00" }], bornes)).toEqual([]);
    expect(reporterSerie([], bornes)).toEqual([]);
    expect(
      reporterSerie([{ date: "2026-07-02", solde: "1.00" }], { from: "2026-07-06", to: "2026-07-01" }),
    ).toEqual([]);
  });

  it("accepte des points non triés (tri interne stable)", () => {
    const serie = reporterSerie(
      [
        { date: "2026-07-04", solde: "2.00" },
        { date: "2026-07-02", solde: "1.00" },
      ],
      bornes,
    );
    expect(serie[0]!.date).toBe("2026-07-02");
    expect(serie[2]!.solde).toBe("2.00");
  });
});

describe("evaluerCompletude — différence de RunningBalance (§4.2, §7-C)", () => {
  it("jour complet ⇒ COMPLET (Δ_observé = Δ_attendu, exact au centime)", () => {
    const statuts = evaluerCompletude(
      [
        { date: "2026-07-01", solde: "1000.00" },
        { date: "2026-07-02", solde: "1250.50" },
      ],
      [{ date: "2026-07-02", delta: "250.50" }],
    );
    expect(statuts).toEqual([
      { date: "2026-07-01", statut: "NON_EVALUABLE" }, // premier EOD : aucun K
      { date: "2026-07-02", statut: "COMPLET" },
    ]);
  });

  it("une transaction perdue ⇒ INCOMPLET (l'écart vaut son montant signé)", () => {
    // Réel : +250.50 et −100.00 le 2 ; la passe n'a servi que le +250.50.
    const statuts = evaluerCompletude(
      [
        { date: "2026-07-01", solde: "1000.00" },
        { date: "2026-07-02", solde: "1150.50" }, // solde VRAI (les 2 mouvements)
      ],
      [{ date: "2026-07-02", delta: "250.50" }], // base incomplète
    );
    expect(statuts[1]).toEqual({ date: "2026-07-02", statut: "INCOMPLET" });
  });

  it("K antérieur de plusieurs jours ⇒ somme sur l'intervalle ]K, J] entier", () => {
    const statuts = evaluerCompletude(
      [
        { date: "2026-07-01", solde: "100.00" },
        { date: "2026-07-05", solde: "40.00" }, // −60 sur 4 jours
      ],
      [
        { date: "2026-07-01", delta: "999.99" }, // = K : EXCLU de ]K, J]
        { date: "2026-07-02", delta: "-100.00" },
        { date: "2026-07-04", delta: "15.00" },
        { date: "2026-07-05", delta: "25.00" }, // = J : INCLUS
        { date: "2026-07-09", delta: "777.77" }, // > J : exclu
      ],
    );
    expect(statuts[1]).toEqual({ date: "2026-07-05", statut: "COMPLET" });
  });

  it("débits et crédits mêlés : le delta SIGNÉ porte le sens (jamais |amount|)", () => {
    // Sortie nette (delta négatif) : un détecteur qui sommerait des montants nus
    // (positifs OBIE) déclarerait l'écart nul à tort — contre-preuve.
    const statuts = evaluerCompletude(
      [
        { date: "2026-07-01", solde: "500.00" },
        { date: "2026-07-02", solde: "300.00" },
      ],
      [{ date: "2026-07-02", delta: "-200.00" }],
    );
    expect(statuts[1]).toEqual({ date: "2026-07-02", statut: "COMPLET" });
  });

  it("montant illisible ⇒ NON_EVALUABLE (fail-closed : ni complet, ni faux drapeau)", () => {
    const statuts = evaluerCompletude(
      [
        { date: "2026-07-01", solde: "100.00" },
        { date: "2026-07-02", solde: "pas-un-montant" },
      ],
      [],
    );
    expect(statuts[1]).toEqual({ date: "2026-07-02", statut: "NON_EVALUABLE" });
  });
});

describe("consoliderCourbeFiable — consolidé par devise, D6-a + drapeau (§3.3, §4)", () => {
  const bornes = { from: "2026-07-01", to: "2026-07-04" };

  /** Compte simple : EOD réels + mouvements réconciliés (tout COMPLET). */
  function compte(
    id: string,
    currency: string,
    points: { date: string; solde: string }[],
    mouvements: { date: string; delta: string }[] = [],
  ): CompteEod {
    return { bankAccountId: id, currency, points, mouvements };
  }

  it("D6-a : historiques inégaux ⇒ la série démarre quand TOUS les comptes ont un EOD (pas de marche muette)", () => {
    const pts = consoliderCourbeFiable(
      [
        compte("A", "MUR", [{ date: "2026-07-01", solde: "1000.00" }]),
        compte("B", "MUR", [{ date: "2026-07-03", solde: "500.00" }]),
      ],
      bornes,
    );
    // Aucun point les 1-2 juillet (B inconnu) — la marche d'escalier n'existe pas.
    expect(pts).toEqual([
      { date: "2026-07-03", currency: "MUR", soldeConsolide: "1500.00", fiable: true },
      { date: "2026-07-04", currency: "MUR", soldeConsolide: "1500.00", fiable: true },
    ]);
  });

  it("un compte sans AUCUN EOD vide la série de SA devise ; l'autre devise vit (fail-closed D6-a)", () => {
    const pts = consoliderCourbeFiable(
      [
        compte("A", "MUR", [{ date: "2026-07-01", solde: "1000.00" }]),
        compte("B", "MUR", []), // sélectionné, jamais dérivé
        compte("C", "USD", [{ date: "2026-07-02", solde: "300.00" }]),
      ],
      bornes,
    );
    expect(pts.filter((p) => p.currency === "MUR")).toEqual([]);
    expect(pts.filter((p) => p.currency === "USD")).toHaveLength(3); // 07-02 → 07-04
  });

  it("multi-devise : séries INDÉPENDANTES, jamais d'addition cross-devise (règle 8)", () => {
    const pts = consoliderCourbeFiable(
      [
        compte("A", "MUR", [{ date: "2026-07-01", solde: "3000.00" }]),
        compte("C", "USD", [{ date: "2026-07-01", solde: "500.00" }]),
      ],
      bornes,
    );
    const du1er = pts.filter((p) => p.date === "2026-07-01");
    expect(du1er).toEqual([
      { date: "2026-07-01", currency: "MUR", soldeConsolide: "3000.00", fiable: true },
      { date: "2026-07-01", currency: "USD", soldeConsolide: "500.00", fiable: true },
    ]);
    expect(pts.some((p) => p.soldeConsolide === "3500.00")).toBe(false);
  });

  it("le drapeau suit la valeur PORTÉE : un jour EOD en écart contamine ses jours reportés", () => {
    const pts = consoliderCourbeFiable(
      [
        compte(
          "A",
          "MUR",
          [
            { date: "2026-07-01", solde: "1000.00" },
            { date: "2026-07-02", solde: "1100.00" }, // écart : delta servi = +50 ≠ +100
          ],
          [{ date: "2026-07-02", delta: "50.00" }],
        ),
      ],
      bornes,
    );
    // 07-01 : NON_EVALUABLE (premier EOD) → ne rend PAS douteux (§4.3).
    expect(pts[0]).toMatchObject({ date: "2026-07-01", fiable: true });
    // 07-02 : INCOMPLET → douteux ; 07-03/04 REPORTENT cette valeur → douteux aussi.
    expect(pts[1]).toMatchObject({ date: "2026-07-02", fiable: false });
    expect(pts[2]).toMatchObject({ date: "2026-07-03", fiable: false });
    expect(pts[3]).toMatchObject({ date: "2026-07-04", fiable: false });
  });

  it("sommes en centimes exacts, découvert compris (jamais de float)", () => {
    const pts = consoliderCourbeFiable(
      [
        compte("A", "MUR", [{ date: "2026-07-01", solde: "0.10" }]),
        compte("B", "MUR", [{ date: "2026-07-01", solde: "0.20" }]),
        compte("C", "MUR", [{ date: "2026-07-01", solde: "-0.30" }]),
      ],
      { from: "2026-07-01", to: "2026-07-01" },
    );
    // 0.1 + 0.2 − 0.3 : un float donnerait 5.55e-17 ; les centimes donnent zéro.
    expect(pts).toEqual([
      { date: "2026-07-01", currency: "MUR", soldeConsolide: "0.00", fiable: true },
    ]);
  });

  it("périmètre vide ⇒ série vide ; sortie triée (date, devise)", () => {
    expect(consoliderCourbeFiable([], bornes)).toEqual([]);
    const pts = consoliderCourbeFiable(
      [
        compte("C", "USD", [{ date: "2026-07-01", solde: "1.00" }]),
        compte("A", "MUR", [{ date: "2026-07-01", solde: "2.00" }]),
      ],
      { from: "2026-07-01", to: "2026-07-02" },
    );
    expect(pts.map((p) => `${p.date}/${p.currency}`)).toEqual([
      "2026-07-01/MUR", "2026-07-01/USD", "2026-07-02/MUR", "2026-07-02/USD",
    ]);
  });
});
