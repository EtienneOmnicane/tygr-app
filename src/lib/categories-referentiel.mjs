/**
 * Référentiel STANDARD de catégories de trésorerie — source de vérité UNIQUE
 * (QA-ONBOARD-CATEG1), importée par :
 *   - scripts/seed-categories-lib.mjs (seed à la création de workspace CLI :
 *     seed-admin, seed-omnifi-demo, et le rattrapage seed-categories) ;
 *   - src/server/repositories/categorisation.ts (CTA in-app « Importer les
 *     catégories standard », réservé ADMIN) ;
 *   - tests/isolation/seed-categories-isolation.test.ts (preuve d'isolation).
 * Volontairement en .mjs SOUS src/lib : importable tel quel par les scripts node
 * (sans loader TS) ET par le code applicatif TS (allowJs) — une seule source,
 * pas de dérive script/app/test (CLAUDE.md règle 9).
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

/**
 * Préfixe de la clé du verrou consultatif (`pg_advisory_xact_lock`) qui sérialise
 * les seeds concurrents du référentiel sur un MÊME workspace. Partagé — SOURCE
 * UNIQUE (règle 9) — par le seed CLI (`scripts/seed-categories-lib.mjs`) ET le CTA
 * applicatif (`src/server/repositories/categorisation.ts`) : les deux chemins
 * hachent `PREFIXE + workspace_id` avec `hashtextextended(…, 0)`, donc prennent
 * EXACTEMENT la même clé (CTA×CTA et CTA×CLI se sérialisent). Extrait ici pour
 * qu'aucune dérive de constante entre les deux fichiers ne puisse casser la
 * sérialisation en silence (rappel : `UNIQUE(workspace_id, name, parent_id)` ne
 * contraint pas les Natures — parent_id NULL, NULLs distincts en SQL).
 */
export const PREFIXE_VERROU_SEED_CATEGORIES = "tygr.seed_categories.";
