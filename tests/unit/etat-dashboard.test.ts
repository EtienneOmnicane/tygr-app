/**
 * Sélection de l'état d'affichage du dashboard (Epic 3, PR D) — fonction pure.
 * Couvre les 3 parcours du plan (vide / partiel / complet) : c'est l'équivalent
 * testable du « E2E des 3 parcours » tant que le rendu React n'est pas outillé
 * (testing-library absent — E2E navigateur = TODO).
 */
import { describe, expect, it } from "vitest";

import { choisirEtatDashboard, type EtatDashboard } from "@/lib/etat-dashboard";
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

const SYNTHESE = {
  libelleMois: "2026-06",
  entrees: "0",
  sorties: "0",
  variation: "0",
};

function donnees(over: Partial<DonneesDashboard>): DonneesDashboard {
  return {
    comptes: [],
    soldesParDevise: [],
    courbe: [],
    syntheseMois: SYNTHESE,
    serieMensuelle: [],
    grilleMensuelle: [],
    transactionsRecentes: [],
    ...over,
  };
}

const UN_COMPTE = [
  {
    bankAccountId: "acc-1",
    accountName: "Compte test",
    institutionName: "Banque test",
    currency: "MUR",
    currentBalance: "1000.00",
    lastSyncedAt: new Date("2026-06-12T00:00:00Z"),
  },
];

describe("choisirEtatDashboard", () => {
  it("VIDE : aucun compte connecté", () => {
    const e: EtatDashboard = choisirEtatDashboard(donnees({ comptes: [] }));
    expect(e).toBe("vide");
  });

  it("PARTIEL : comptes présents mais courbe vide (post-onboarding)", () => {
    const e = choisirEtatDashboard(
      donnees({ comptes: UN_COMPTE, courbe: [] }),
    );
    expect(e).toBe("partiel");
  });

  it("COMPLET : comptes + au moins un point de courbe", () => {
    const e = choisirEtatDashboard(
      donnees({
        comptes: UN_COMPTE,
        courbe: [{ date: "2026-06-12", soldeConsolide: "1000.00" }],
      }),
    );
    expect(e).toBe("complet");
  });

  it("VIDE prime sur la courbe : pas de compte → vide même si la courbe a des points", () => {
    // Cas dégénéré (ne devrait pas arriver), mais la règle « pas de compte =
    // vide » doit être stricte : on ne montre pas une courbe orpheline.
    const e = choisirEtatDashboard(
      donnees({
        comptes: [],
        courbe: [{ date: "2026-06-12", soldeConsolide: "1000.00" }],
      }),
    );
    expect(e).toBe("vide");
  });
});
