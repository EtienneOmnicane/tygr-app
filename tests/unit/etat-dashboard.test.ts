/**
 * Sélection de l'état d'affichage du dashboard (Epic 3, PR D) — fonction pure.
 * Couvre les 3 parcours du plan (vide / partiel / complet) : c'est l'équivalent
 * testable du « E2E des 3 parcours » tant que le rendu React n'est pas outillé
 * (testing-library absent — E2E navigateur = TODO).
 */
import { describe, expect, it } from "vitest";

import { choisirEtatDashboard, type EtatDashboard } from "@/lib/etat-dashboard";
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

/** Un point de flux minimal (la valeur importe peu : on teste la PRÉSENCE). */
const POINT_FLUX = {
  bucket: "2026-06",
  currency: "MUR",
  entrees: "1000.00",
  sorties: "0.00",
  net: "1000.00",
  nbTransactions: 1,
};

function donnees(over: Partial<DonneesDashboard>): DonneesDashboard {
  return {
    comptes: [],
    soldesParDevise: [],
    flux: [],
    synthesesMois: [],
    topVendors: { direction: "outflow", lignes: [] },
    serieMensuelle: [],
    grilleMensuelle: [],
    // La prévision ne discrimine PAS l'état d'onboarding (vide/partiel/complet) : elle
    // dépend d'échéances saisies à la main, pas de la connexion bancaire.
    prevision: null,
    transactionsRecentes: [],
    // Défaut NEUTRE : lecteur non borné, tenant sans connexion → les cas historiques
    // ci-dessous gardent exactement leur sémantique d'avant NUDGE-VISION-ENTITE1.
    aDesConnexionsTenant: false,
    lecteurBorne: false,
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

  it("PARTIEL : comptes présents mais aucun flux (post-onboarding)", () => {
    const e = choisirEtatDashboard(
      donnees({ comptes: UN_COMPTE, flux: [] }),
    );
    expect(e).toBe("partiel");
  });

  it("COMPLET : comptes + au moins un point de flux", () => {
    const e = choisirEtatDashboard(
      donnees({ comptes: UN_COMPTE, flux: [POINT_FLUX] }),
    );
    expect(e).toBe("complet");
  });

  it("VIDE prime sur le flux : pas de compte → vide même si le flux a des points", () => {
    // Cas dégénéré (ne devrait pas arriver), mais la règle « pas de compte =
    // vide » doit être stricte : on ne montre pas une courbe orpheline.
    const e = choisirEtatDashboard(
      donnees({ comptes: [], flux: [POINT_FLUX] }),
    );
    expect(e).toBe("vide");
  });

  // ── HORS PÉRIMÈTRE (NUDGE-VISION-ENTITE1) ────────────────────────────────────
  // Les quatre cas suivants partagent TOUS `comptes: []`. Seuls les deux drapeaux de
  // périmètre les distinguent — c'est exactement la confusion que le lot corrige.

  it("HORS PÉRIMÈTRE : lecteur borné + le tenant a une connexion", () => {
    const e: EtatDashboard = choisirEtatDashboard(
      donnees({
        comptes: [],
        aDesConnexionsTenant: true,
        lecteurBorne: true,
      }),
    );
    expect(e).toBe("hors-perimetre");
  });

  it("VIDE : lecteur borné mais le tenant n'a AUCUNE connexion (rien à rendre visible)", () => {
    const e = choisirEtatDashboard(
      donnees({
        comptes: [],
        aDesConnexionsTenant: false,
        lecteurBorne: true,
      }),
    );
    expect(e).toBe("vide");
  });

  it("VIDE : connexion sans compte, lecteur NON borné — l'état ne doit pas mentir", () => {
    // Le cas qui rendrait l'écran menteur si `aDesConnexionsTenant` suffisait (constat
    // de cross-review) : une connexion PEUT être commitée avec zéro compte — découverte
    // vide, ou comptes tous écartés par le filtre `Status !== "Enabled"` de
    // l'orchestration, situation déjà observée en production. Un ADMIN en Vision Globale
    // lirait alors « un administrateur peut vous donner accès » : il EST l'administrateur,
    // et aucun compte n'attend d'être rattaché. Le périmètre du LECTEUR tranche.
    const e = choisirEtatDashboard(
      donnees({
        comptes: [],
        aDesConnexionsTenant: true,
        lecteurBorne: false,
      }),
    );
    expect(e).toBe("vide");
  });

  it("HORS PÉRIMÈTRE ne concerne QUE le cas sans compte visible", () => {
    // Dès qu'un compte est visible, le périmètre n'a plus à s'expliquer : on montre la
    // donnée. Les drapeaux sont inertes ici.
    const e = choisirEtatDashboard(
      donnees({
        comptes: UN_COMPTE,
        flux: [POINT_FLUX],
        aDesConnexionsTenant: true,
        lecteurBorne: true,
      }),
    );
    expect(e).toBe("complet");
  });
});
