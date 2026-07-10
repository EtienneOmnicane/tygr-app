/**
 * Tests de `versInputBackend` — le COMPOSEUR de filtres UI → schéma Backend
 * (`@/app/(workspace)/transactions/adapter`). Frontière testable où le contrat UI
 * (`FiltresTransactions`, minuscules, `recherche`) est traduit vers l'entrée du
 * repository (`ListerTransactionsInput`, statut MAJ).
 *
 * Couvre spécifiquement le chantier « recherche » (FB0709-RECHERCHE-TX1) :
 * - passe-plat de `recherche` (jamais transformé côté UI ; l'échappement LIKE et le
 *   trim/min/max vivent côté serveur — testés en isolation + schema) ;
 * - cumul de plusieurs filtres (recherche + statut + dates) ;
 * - absence de `recherche` → champ ABSENT de l'input (pas de clé vide qui casserait
 *   le `.strict()` Zod, et jamais de chaîne vide que `min(1)` rejetterait).
 *
 * NB : plus de filtre `bankAccountId` au niveau UI — le périmètre de comptes est
 * piloté globalement par le `PerimetreSwitcher` de la navbar (doublon retiré, PR
 * #190). Le SCHÉMA backend l'accepte toujours (cumul prouvé côté isolation) ; c'est
 * seulement le composeur UI qui ne le transmet plus.
 */
import { describe, expect, it } from "vitest";

import { versInputBackend } from "@/app/(workspace)/transactions/adapter";

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

  it("cumule recherche + statut + dates (composeur de filtres)", () => {
    const input = versInputBackend(
      {
        recherche: "beachcomber",
        statutCategorisation: "complet",
        dateDebut: "2026-03-01",
        dateFin: "2026-03-31",
      },
      null,
    );
    expect(input).toEqual({
      recherche: "beachcomber",
      statut: "COMPLET", // traduit UI (minuscule) → Backend (MAJ)
      dateDebut: "2026-03-01",
      dateFin: "2026-03-31",
    });
  });

  it("transmet le curseur avec la recherche (page suivante d'un résultat filtré)", () => {
    const input = versInputBackend({ recherche: "loyer" }, "Y3Vyc2V1cg");
    expect(input).toEqual({ recherche: "loyer", curseur: "Y3Vyc2V1cg" });
  });
});
