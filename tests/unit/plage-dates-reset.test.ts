/**
 * PLAGE-DATES-RESET-UX1 — le geste « × » doit vider les champs ET l'URL.
 *
 * Le projet n'a pas de renderer React de test (choix tracé, CLAUDE.md) : on teste la
 * LOGIQUE PURE extraite du composant (`resyncDepuisUrl`, `parametresPlage`) — même pattern
 * que `machine-mfa.ts`. Le rendu réel est couvert au Visual QA (Gate 4).
 *
 * Trou de couverture comblé : au clic « × », `ecrire(null)` pose `dernierEcrit = "|"` ET
 * nettoie l'URL. La `cleUrl` résultante (`"|"`) == `dernierEcrit` → la resynchro conclut
 * « écriture interne » et NE réinitialise PAS `du`/`au`. Le filtre disparaît mais les
 * `<input>` gardent l'ancienne plage. Le correctif : le handler vide le brouillon LUI-MÊME.
 */
import { describe, it, expect } from "vitest";

import {
  resyncDepuisUrl,
  parametresPlage,
} from "@/components/shell/plage-dates-switcher";
import { lirePlage, paramsPeriodeDepuisURL } from "@/lib/periode";

// Plage valide pour `lirePlage` : dates ISO, du ≤ au, ≥ PLANCHER_HISTORIQUE (2024-01-01).
const DU = "2026-03-03";
const AU = "2026-04-17";
const CLE_PLAGE = `${DU}|${AU}`;

describe("parametresPlage — construction de l'URL", () => {
  it("retire du/au et PRÉSERVE les autres params quand la plage est effacée (null)", () => {
    const p = parametresPlage(`du=${DU}&au=${AU}&periode=6m&perimetre=x`, null);
    expect(p.has("du")).toBe(false);
    expect(p.has("au")).toBe(false);
    expect(p.get("periode")).toBe("6m");
    expect(p.get("perimetre")).toBe("x");
  });

  it("pose du/au quand une plage est fournie, autres params préservés", () => {
    const p = parametresPlage("periode=3m", { du: DU, au: AU });
    expect(p.get("du")).toBe(DU);
    expect(p.get("au")).toBe(AU);
    expect(p.get("periode")).toBe("3m");
  });
});

describe("resyncDepuisUrl — garde-fou d'écriture interne", () => {
  it("réaligne les champs sur une plage arrivée de l'EXTÉRIEUR (dernierEcrit ≠ cleUrl)", () => {
    expect(resyncDepuisUrl(CLE_PLAGE, null, { du: DU, au: AU })).toEqual({
      du: DU,
      au: AU,
    });
  });

  it("ne réaligne PAS quand l'URL reflète notre propre écriture (protège le brouillon)", () => {
    expect(resyncDepuisUrl(CLE_PLAGE, CLE_PLAGE, { du: DU, au: AU })).toBeNull();
  });

  it("après NOTRE effacement (cleUrl === '|' === dernierEcrit) → null : la resynchro ne vide pas → le handler « × » doit vider lui-même", () => {
    expect(resyncDepuisUrl("|", "|", null)).toBeNull();
  });

  it("réaligne à VIDE quand un changement EXTERNE efface la plage (ex. clic preset)", () => {
    expect(resyncDepuisUrl("|", CLE_PLAGE, null)).toEqual({ du: "", au: "" });
  });
});

/**
 * Mini-harnais : reproduit le CYCLE d'état du composant (setState modélisés en champs
 * mutables), mais toute la DÉCISION passe par les vraies fonctions extraites
 * (`resyncDepuisUrl`, `parametresPlage`, `lirePlage`) — pas de logique dupliquée ici,
 * seulement le câblage. Faute de renderer React, c'est la fidélité maximale ; le rendu
 * réel reste validé au Visual QA.
 */
function creerHarnais(du0: string, au0: string, query0: string) {
  let du = du0;
  let au = au0;
  let search = query0;
  let dernierEcrit: string | null = null;

  const cleDe = (q: string): string => {
    const plage = lirePlage(paramsPeriodeDepuisURL(new URLSearchParams(q)));
    return `${plage?.du ?? ""}|${plage?.au ?? ""}`;
  };
  let cleUrlPrecedente = cleDe(query0);

  // Miroir du bloc de resynchronisation (corps de rendu).
  const rendre = () => {
    const plage = lirePlage(paramsPeriodeDepuisURL(new URLSearchParams(search)));
    const cleUrl = `${plage?.du ?? ""}|${plage?.au ?? ""}`;
    if (cleUrl !== cleUrlPrecedente) {
      cleUrlPrecedente = cleUrl;
      const resync = resyncDepuisUrl(cleUrl, dernierEcrit, plage);
      if (resync) {
        du = resync.du;
        au = resync.au;
      }
    }
  };

  // Miroir de `ecrire`.
  const ecrire = (nouvelle: { du: string; au: string } | null) => {
    dernierEcrit = nouvelle ? `${nouvelle.du}|${nouvelle.au}` : "|";
    search = parametresPlage(search, nouvelle).toString();
    rendre();
  };

  return {
    get du() {
      return du;
    },
    get au() {
      return au;
    },
    get search() {
      return search;
    },
    /**
     * Geste « × » — MIROIR de `effacerTout` du composant : vide EXPLICITEMENT les deux
     * champs puis efface l'URL. ⚠️ Portée honnête (pas de renderer) : ce corps RECOPIE le
     * câblage `setDu("")/setAu("")` (impur, non importable) ; ce que le test PROTÈGE vraiment
     * est la logique de décision `resyncDepuisUrl` (le root cause) — le vidage NE peut PAS
     * venir de la resynchro (elle retourne `null` sur notre propre écriture). Le corps trivial
     * du handler réel est couvert au Visual QA (Gate 4), pas ici.
     */
    cliquerCroix() {
      du = "";
      au = "";
      ecrire(null);
    },
    /** Édition : vider la borne « au » (input onChange → setAu(""); appliquer(du, "")). */
    viderBorneAu() {
      au = "";
      const valide = lirePlage({ du, au: "" });
      if (valide) {
        ecrire(valide);
        return;
      }
      // `appliquer` : si une plage filtrait encore, on la lève (rallume le preset).
      const plageCourante = lirePlage(
        paramsPeriodeDepuisURL(new URLSearchParams(search)),
      );
      if (plageCourante) ecrire(null);
    },
  };
}

describe("geste « × » (effacerTout) — le correctif", () => {
  it("après le clic : les DEUX champs sont vides ET l'URL n'a plus du/au", () => {
    const h = creerHarnais(DU, AU, `du=${DU}&au=${AU}&periode=6m`);
    h.cliquerCroix();

    expect(h.du).toBe("");
    expect(h.au).toBe("");
    const params = new URLSearchParams(h.search);
    expect(params.has("du")).toBe(false);
    expect(params.has("au")).toBe(false);
    // Le preset survit (il se rallume) — on n'efface QUE la plage.
    expect(params.get("periode")).toBe("6m");
  });
});

describe("non-régression du garde-fou — édition en cours", () => {
  it("vider « au » NE vide PAS la borne « du » déjà remplie (le brouillon est protégé)", () => {
    const h = creerHarnais(DU, AU, `du=${DU}&au=${AU}`);
    h.viderBorneAu();

    expect(h.du).toBe(DU); // conservé
    expect(h.au).toBe(""); // vidé par l'utilisateur
    // La plage n'étant plus complète, l'URL la lève (le preset reprend la main).
    const params = new URLSearchParams(h.search);
    expect(params.has("du")).toBe(false);
    expect(params.has("au")).toBe(false);
  });
});
