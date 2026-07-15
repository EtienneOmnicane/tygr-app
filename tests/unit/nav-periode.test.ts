/**
 * Helpers PURS de propagation de la période dans la nav (TX/DASH-PERIODE-PERSIST1). Testés
 * SANS renderer React (le projet n'en a pas — CLAUDE.md § widget) : `sidebar-nav.tsx` et
 * `reinitialiser-periode.tsx` ne sont que des coquilles de câblage autour de ces fonctions,
 * donc c'est ICI que vit la preuve du comportement :
 *   (a) whitelist stricte periode/du/au + propagation SEULEMENT vers les segments qui lisent ;
 *   (b) état actif de la nav INDÉPENDANT des params ;
 *   (c) purge du reset (les 3 clés, le reste préservé — le prédicat `estHorsDefautPeriode`
 *       qui pilote la VISIBILITÉ du reset est prouvé dans `periode.test.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  doitPropagerPeriode,
  estActifNav,
  hrefAvecPeriode,
  queryPeriodeDepuis,
  retirerPeriodeQuery,
} from "@/components/shell/nav-periode";

/** URL réaliste : période RÉGLÉE + des params propres à /transactions (à NE PAS propager). */
const AVEC_PERIODE_ET_BRUIT = new URLSearchParams(
  "q=fournisseur&statut=rapproche&periode=3m&du=2026-03-03&au=2026-04-17",
);

describe("queryPeriodeDepuis — whitelist stricte des 3 clés", () => {
  it("ne retient QUE periode/du/au (jamais q, statut, …)", () => {
    const query = new URLSearchParams(queryPeriodeDepuis(AVEC_PERIODE_ET_BRUIT));
    expect(query.get("periode")).toBe("3m");
    expect(query.get("du")).toBe("2026-03-03");
    expect(query.get("au")).toBe("2026-04-17");
    expect(query.has("q")).toBe(false);
    expect(query.has("statut")).toBe(false);
  });

  it("URL sans période → chaîne vide", () => {
    expect(queryPeriodeDepuis(new URLSearchParams("q=x&statut=y"))).toBe("");
    expect(queryPeriodeDepuis(new URLSearchParams())).toBe("");
  });

  it("préserve FIDÈLEMENT un param dupliqué (les deux valeurs) — cohérence avec le serveur", () => {
    // `?du=X&du=Y` : le serveur cible le verra dupliqué et le rejettera comme la page source
    // (paramsPeriodeDepuisURL → tableau → lirePlage null). Propager `.get()` (1re valeur seule)
    // ferait DIVERGER les deux côtés (la cible accepterait une plage que la source ignore) —
    // d'où getAll/append.
    const query = new URLSearchParams(
      queryPeriodeDepuis(new URLSearchParams("du=2026-03-03&du=2026-09-09")),
    );
    expect(query.getAll("du")).toEqual(["2026-03-03", "2026-09-09"]);
  });
});

describe("doitPropagerPeriode — seuls les segments qui LISENT la période", () => {
  it("Dashboard « / » et /transactions : oui", () => {
    expect(doitPropagerPeriode("/")).toBe(true);
    expect(doitPropagerPeriode("/transactions")).toBe(true);
  });

  it("/echeances, /graphiques, /banques, /regles : non (ils ignorent ?periode)", () => {
    expect(doitPropagerPeriode("/echeances")).toBe(false);
    expect(doitPropagerPeriode("/graphiques")).toBe(false);
    expect(doitPropagerPeriode("/banques")).toBe(false);
    expect(doitPropagerPeriode("/regles")).toBe(false);
  });
});

describe("hrefAvecPeriode — (a) propage UNIQUEMENT periode/du/au et SEULEMENT vers les bons segments", () => {
  it("Dashboard reçoit la période (SANS le bruit q/statut)", () => {
    // Comparaison par URL (pas par chaîne) pour ne pas dépendre de l'ordre des clés.
    const [chemin, query] = hrefAvecPeriode("/", AVEC_PERIODE_ET_BRUIT).split("?");
    expect(chemin).toBe("/");
    const params = new URLSearchParams(query);
    expect(params.get("periode")).toBe("3m");
    expect(params.get("du")).toBe("2026-03-03");
    expect(params.get("au")).toBe("2026-04-17");
    expect(params.has("q")).toBe(false);
    expect(params.has("statut")).toBe(false);
  });

  it("/transactions reçoit la période", () => {
    const [chemin, query] = hrefAvecPeriode(
      "/transactions",
      AVEC_PERIODE_ET_BRUIT,
    ).split("?");
    expect(chemin).toBe("/transactions");
    const params = new URLSearchParams(query);
    expect(params.get("periode")).toBe("3m");
    expect(params.get("du")).toBe("2026-03-03");
    expect(params.get("au")).toBe("2026-04-17");
  });

  it("les segments qui n'en lisent pas restent NUS (aucun ?periode fantôme)", () => {
    for (const href of ["/echeances", "/graphiques", "/banques", "/regles"]) {
      expect(hrefAvecPeriode(href, AVEC_PERIODE_ET_BRUIT)).toBe(href);
    }
  });

  it("URL sans période → href nu (pas de « ? » orphelin), même sur un segment éligible", () => {
    expect(hrefAvecPeriode("/", new URLSearchParams())).toBe("/");
    expect(hrefAvecPeriode("/transactions", new URLSearchParams("q=x"))).toBe(
      "/transactions",
    );
  });
});

describe("estActifNav — (b) l'état actif reste correct et INDÉPENDANT des params", () => {
  it("Dashboard « / » n'est actif qu'en EXACT (jamais en préfixe, sinon il s'allumerait partout)", () => {
    expect(estActifNav("/", "/")).toBe(true);
    expect(estActifNav("/", "/transactions")).toBe(false);
    expect(estActifNav("/", "/banques")).toBe(false);
  });

  it("les autres segments sont actifs en PRÉFIXE (sous-routes comprises)", () => {
    expect(estActifNav("/transactions", "/transactions")).toBe(true);
    expect(estActifNav("/transactions", "/transactions/tx-123")).toBe(true);
    expect(estActifNav("/transactions", "/")).toBe(false);
    expect(estActifNav("/banques", "/banques/connexion-42")).toBe(true);
  });

  it("dépend UNIQUEMENT de (href nu, pathname) — pathname sans query (piège du ticket)", () => {
    // `usePathname` ne rend NI query NI hash : sur /transactions?periode=3m le pathname reste
    // « /transactions » → actif. La propagation de période (hrefAvecPeriode) ne touche donc
    // JAMAIS l'état actif, calculé sur l'href NU.
    expect(estActifNav("/transactions", "/transactions")).toBe(true);
    expect(estActifNav("/", "/")).toBe(true);
  });
});

describe("retirerPeriodeQuery — purge du reset : les 3 clés, le reste préservé", () => {
  it("retire periode/du/au et GARDE les autres params (ordre d'insertion conservé)", () => {
    expect(retirerPeriodeQuery(AVEC_PERIODE_ET_BRUIT)).toBe(
      "q=fournisseur&statut=rapproche",
    );
  });

  it("URL 100 % période → chaîne vide (le reset produit une URL propre `pathname` nu)", () => {
    expect(
      retirerPeriodeQuery(
        new URLSearchParams("periode=3m&du=2026-03-03&au=2026-04-17"),
      ),
    ).toBe("");
    expect(retirerPeriodeQuery(new URLSearchParams("periode=12m"))).toBe("");
  });

  it("purge aussi un param de période DUPLIQUÉ (toutes ses valeurs)", () => {
    expect(retirerPeriodeQuery(new URLSearchParams("du=X&du=Y&q=z"))).toBe("q=z");
  });
});
