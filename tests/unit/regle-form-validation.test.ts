/**
 * Validation ergonomique du formulaire de règles (`validerChamps`) — fonction PURE.
 * Le projet n'outille pas le rendu React ; cette logique (la décision « quel champ
 * est en erreur et avec quel message ») est extraite et testée unitairement.
 * Exit-criteria (règle 3) : chemin heureux + chaque échec + cas limite (espaces).
 */
import { describe, expect, it } from "vitest";

import {
  validerChamps,
  MSG_MOTIF_VIDE,
  MSG_CATEGORIE_VIDE,
} from "@/components/regles/regle-form";

const CAT = "cat-123"; // id de catégorie plausible

describe("validerChamps (formulaire de règles)", () => {
  it("VALIDE : motif renseigné + catégorie choisie → aucune erreur", () => {
    expect(validerChamps("EDF", CAT)).toEqual({});
  });

  it("ÉCHEC motif : motif vide → message motif, pas d'erreur catégorie", () => {
    expect(validerChamps("", CAT)).toEqual({ pattern: MSG_MOTIF_VIDE });
  });

  it("ÉCHEC catégorie : catégorie non choisie → message catégorie seul", () => {
    expect(validerChamps("EDF", "")).toEqual({ categoryId: MSG_CATEGORIE_VIDE });
  });

  it("ÉCHEC double : motif vide ET catégorie absente → les deux messages", () => {
    expect(validerChamps("", "")).toEqual({
      pattern: MSG_MOTIF_VIDE,
      categoryId: MSG_CATEGORIE_VIDE,
    });
  });

  it("CAS LIMITE : motif d'espaces uniquement est INVALIDE (trim)", () => {
    // Le garde-fou s'appuie sur trim() — un motif « tout espaces » ne doit pas
    // passer (il créerait une règle au motif vide côté serveur).
    expect(validerChamps("   ", CAT)).toEqual({ pattern: MSG_MOTIF_VIDE });
  });

  it("CAS LIMITE : motif avec espaces autour mais contenu réel est VALIDE", () => {
    expect(validerChamps("  AMAZON  ", CAT)).toEqual({});
  });
});
