/**
 * Référentiel de catégories de trésorerie injecté par `scripts/seed-categories.mjs`.
 * Extrait dans un module à part pour être IMPORTÉ aussi par le test d'isolation du
 * seed (tests/isolation/seed-categories-isolation.test.ts) — une seule source de
 * vérité, pas de dérive script/test (CLAUDE.md règle 9).
 *
 * Chaque entrée = une NATURE (catégorie racine, parent_id NULL) + ses SOUS-NATURES.
 * Noms en français (langue de l'UI), uniques à leur niveau (contrainte
 * categories_workspace_name_parent_unique). Vocabulaire aligné sur
 * src/lib/categories-fr.ts (catégorie OBIE traduite ↔ catégorie manuelle).
 */
export const REFERENTIEL_CATEGORIES = [
  {
    nature: "Revenus",
    sousNatures: ["Ventes", "Subventions", "Produits financiers", "Autres revenus"],
  },
  {
    nature: "Charges d'exploitation",
    sousNatures: ["Loyer", "Charges (eau, électricité)", "Fournitures", "Maintenance"],
  },
  {
    nature: "Personnel",
    sousNatures: ["Salaires", "Charges sociales", "Notes de frais"],
  },
  {
    nature: "Taxes & impôts",
    sousNatures: ["TVA", "Impôt sur les sociétés", "Autres taxes"],
  },
  {
    nature: "Frais financiers",
    sousNatures: ["Frais bancaires", "Intérêts d'emprunt", "Change (FX)"],
  },
  {
    nature: "Assurances",
    sousNatures: ["Assurance des biens", "Assurance responsabilité"],
  },
  {
    nature: "Investissements",
    sousNatures: ["Équipement", "Immobilier"],
  },
];

/** Nombre total de catégories (natures + sous-natures) du référentiel. */
export const NB_CATEGORIES_REFERENTIEL = REFERENTIEL_CATEGORIES.reduce(
  (n, g) => n + 1 + g.sousNatures.length,
  0,
);
