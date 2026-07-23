/**
 * Tests de `versInputBackend` — le COMPOSEUR de filtres UI → schéma Backend
 * (`@/app/(workspace)/transactions/adapter`). Frontière testable où le contrat UI
 * (`FiltresTransactions`, minuscules, `recherche`) est traduit vers l'entrée du
 * repository (`ListerTransactionsInput`, statut MAJ).
 *
 * Couvre spécifiquement le chantier « recherche » (FB0709-RECHERCHE-TX1) :
 * - passe-plat de `recherche` (jamais transformé côté UI ; l'échappement LIKE et le
 *   trim/min/max vivent côté serveur — testés en isolation + schema) ;
 * - cumul recherche + statut + FENÊTRE GLOBALE (injectée par le 3e argument `periode`,
 *   plus par un filtre in-page — TX-TOOLBAR-DEDUP1) ;
 * - absence de `recherche` → champ ABSENT de l'input (pas de clé vide qui casserait
 *   le `.strict()` Zod, et jamais de chaîne vide que `min(1)` rejetterait) ;
 * - la somme nette (`versFiltresSommeNette`) hérite de la MÊME fenêtre que la liste.
 *
 * NB : plus de filtre `bankAccountId` au niveau UI — le périmètre de comptes est
 * piloté globalement par le `PerimetreSwitcher` de la navbar (doublon retiré, PR
 * #190). Le SCHÉMA backend l'accepte toujours (cumul prouvé côté isolation) ; c'est
 * seulement le composeur UI qui ne le transmet plus.
 */
import { describe, expect, it } from "vitest";

import {
  versFiltresSommeNette,
  versInputBackend,
} from "@/app/(workspace)/transactions/adapter";

describe("versInputBackend — recherche (FB0709-RECHERCHE-TX1)", () => {
  it("passe la recherche telle quelle dans l'input backend", () => {
    expect(versInputBackend({ recherche: "loyer" }, null)).toEqual({
      recherche: "loyer",
    });
  });

  it("n'ajoute PAS le champ recherche quand il est absent (undefined)", () => {
    // Un autre filtre est présent : on prouve que seule `recherche` manque à l'appel,
    // et que le composeur n'invente pas de clé vide (le `.strict()` Zod la rejetterait).
    const input = versInputBackend({ statutCategorisation: "partiel" }, null);
    expect(input).toEqual({ statut: "PARTIEL" });
    expect("recherche" in input).toBe(false);
  });

  it("n'ajoute PAS le champ recherche pour une chaîne vide (garde falsy)", () => {
    // La toolbar remonte `undefined`, jamais "" — mais si un "" arrivait, le passe-plat
    // `if (filtres?.recherche)` le rejette (falsy), évitant un min(1) Zod rouge.
    const input = versInputBackend({ recherche: "" }, null);
    expect("recherche" in input).toBe(false);
  });

  it("cumule recherche + statut + la fenêtre GLOBALE (injectée par periode)", () => {
    // Les dates ne sont PLUS un filtre in-page (TX-TOOLBAR-DEDUP1) : elles arrivent de la
    // barre de vue via le 3e argument `periode`, jamais de l'objet `filtres`.
    const input = versInputBackend(
      { recherche: "beachcomber", statutCategorisation: "complet" },
      null,
      { from: "2026-03-01", to: "2026-03-31" },
    );
    expect(input).toEqual({
      recherche: "beachcomber",
      statut: "COMPLET", // traduit UI (minuscule) → Backend (MAJ)
      dateDebut: "2026-03-01",
      dateFin: "2026-03-31",
    });
  });

  it("injecte la fenêtre GLOBALE seule (aucun filtre in-page)", () => {
    // Vue par défaut : la période borne la lecture même sans recherche/statut.
    const input = versInputBackend(undefined, null, {
      from: "2026-01-01",
      to: "2026-06-30",
    });
    expect(input).toEqual({ dateDebut: "2026-01-01", dateFin: "2026-06-30" });
  });

  it("sans periode, n'ajoute AUCUNE borne de date (surface stub démo/tests)", () => {
    // `periode` est optionnel : une surface sans fenêtre (démo) ne pose aucune borne.
    const input = versInputBackend({ recherche: "loyer" }, null);
    expect("dateDebut" in input).toBe(false);
    expect("dateFin" in input).toBe(false);
  });

  it("transmet le curseur avec la recherche (page suivante d'un résultat filtré)", () => {
    const input = versInputBackend({ recherche: "loyer" }, "Y3Vyc2V1cg");
    expect(input).toEqual({ recherche: "loyer", curseur: "Y3Vyc2V1cg" });
  });
});

describe("versInputBackend — filtre catégorie (TX-QA-FILTRE-CAT1)", () => {
  const CAT = "9f8e7d6c-5b4a-4321-8abc-0123456789ab";

  it("passe le categorieId tel quel dans l'input backend", () => {
    expect(versInputBackend({ categorieId: CAT }, null)).toEqual({
      categorieId: CAT,
    });
  });

  it("n'ajoute PAS le champ quand il est absent (pas de clé vide sous .strict)", () => {
    const input = versInputBackend({ recherche: "loyer" }, null);
    expect("categorieId" in input).toBe(false);
  });

  it("cumule catégorie + recherche + statut + fenêtre GLOBALE", () => {
    const input = versInputBackend(
      {
        recherche: "beachcomber",
        statutCategorisation: "partiel",
        categorieId: CAT,
      },
      null,
      { from: "2026-03-01", to: "2026-03-31" },
    );
    expect(input).toEqual({
      recherche: "beachcomber",
      statut: "PARTIEL",
      categorieId: CAT,
      dateDebut: "2026-03-01",
      dateFin: "2026-03-31",
    });
  });

  it("la somme nette hérite MÉCANIQUEMENT du filtre catégorie (dérivation, pas recopie)", () => {
    // C'est LA garantie anti-divergence : un total qui ne porterait pas le filtre
    // catégorie totaliserait d'autres lignes que celles affichées (faux chiffre).
    const input = versFiltresSommeNette({ categorieId: CAT });
    expect(input).toEqual({ categorieId: CAT });
    expect("curseur" in input).toBe(false);
    expect("limite" in input).toBe(false);
  });
});

describe("versFiltresSommeNette — hérite de la fenêtre globale", () => {
  it("porte la MÊME période que la liste, SANS curseur ni limite", () => {
    // La somme dérive de `versInputBackend` : la fenêtre `periode` y descend
    // mécaniquement → le total est borné à la période EXACTEMENT comme les lignes.
    const input = versFiltresSommeNette(
      { statutCategorisation: "partiel" },
      { from: "2026-03-01", to: "2026-03-31" },
    );
    expect(input).toEqual({
      statut: "PARTIEL",
      dateDebut: "2026-03-01",
      dateFin: "2026-03-31",
    });
    expect("curseur" in input).toBe(false);
    expect("limite" in input).toBe(false);
  });
});
