/**
 * Tests de `versInputBackend` — le COMPOSEUR de filtres UI → schéma Backend
 * (`@/app/(workspace)/transactions/adapter`). Frontière testable où le contrat UI
 * (`FiltresTransactions`, minuscules, `recherche`) est traduit vers l'entrée du
 * repository (`ListerTransactionsInput`, statut MAJ).
 *
 * Couvre spécifiquement le chantier « recherche » (FB0709-RECHERCHE-TX1) :
 * - passe-plat de `recherche` (jamais transformé côté UI ; l'échappement LIKE et le
 *   trim/min/max vivent côté serveur — testés en isolation + schema) ;
 * - cumul de plusieurs filtres (recherche + compte + statut + dates) ;
 * - absence de `recherche` → champ ABSENT de l'input (pas de clé vide qui casserait
 *   le `.strict()` Zod, et jamais de chaîne vide que `min(1)` rejetterait).
 */
import { describe, expect, it } from "vitest";

import { versInputBackend } from "@/app/(workspace)/transactions/adapter";

const COMPTE = "dddd0001-dddd-4ddd-8ddd-dddddddddddd";

describe("versInputBackend — recherche (FB0709-RECHERCHE-TX1)", () => {
  it("passe la recherche telle quelle dans l'input backend", () => {
    expect(versInputBackend({ recherche: "loyer" }, null)).toEqual({
      recherche: "loyer",
    });
  });

  it("n'ajoute PAS le champ recherche quand il est absent (undefined)", () => {
    const input = versInputBackend({ bankAccountId: COMPTE }, null);
    expect(input).toEqual({ bankAccountId: COMPTE });
    expect("recherche" in input).toBe(false);
  });

  it("n'ajoute PAS le champ recherche pour une chaîne vide (garde falsy)", () => {
    // La toolbar remonte `undefined`, jamais "" — mais si un "" arrivait, le passe-plat
    // `if (filtres?.recherche)` le rejette (falsy), évitant un min(1) Zod rouge.
    const input = versInputBackend({ recherche: "" }, null);
    expect("recherche" in input).toBe(false);
  });

  it("cumule recherche + compte + statut + dates (composeur de filtres)", () => {
    const input = versInputBackend(
      {
        recherche: "beachcomber",
        bankAccountId: COMPTE,
        statutCategorisation: "complet",
        dateDebut: "2026-03-01",
        dateFin: "2026-03-31",
      },
      null,
    );
    expect(input).toEqual({
      recherche: "beachcomber",
      bankAccountId: COMPTE,
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
