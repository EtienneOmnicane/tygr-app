/**
 * Tests du groupeur d'options du filtre par catégorie (TX-QA-FILTRE-CAT1) —
 * module PUR `construireGroupesCategories` (la toolbar n'est pas rendue : pas de
 * renderer React au projet, choix tracé TODOS). Vérifie l'idiome hiérarchique du
 * CategoryPicker (Nature sélectionnable + Sous-natures), le tri, et le fail-safe
 * des orphelins (aucune catégorie active ne disparaît des options).
 */
import { describe, expect, it } from "vitest";

import {
  construireGroupesCategories,
  type CategorieOptionFiltre,
} from "@/components/transactions/options-filtre-categorie";

const REFERENTIEL: CategorieOptionFiltre[] = [
  // Volontairement dans le désordre : l'état local du conteneur APPEND les
  // créations de session, l'ordre d'arrivée n'est donc jamais garanti trié.
  { id: "n-rev", name: "Revenus", parentId: null },
  { id: "sn-elec", name: "Électricité", parentId: "n-cha" },
  { id: "n-cha", name: "Charges", parentId: null },
  { id: "sn-loyer", name: "Loyer", parentId: "n-cha" },
  { id: "sn-clients", name: "Paiements clients", parentId: "n-rev" },
];

describe("construireGroupesCategories", () => {
  it("groupe par Nature (triées), la Nature elle-même sélectionnable en tête", () => {
    const groupes = construireGroupesCategories(REFERENTIEL);
    expect(groupes.map((g) => g.label)).toEqual(["Charges", "Revenus"]);
    // La Nature est une OPTION (un split peut viser une racine), suivie de ses
    // Sous-natures triées par nom.
    expect(groupes[0].options).toEqual([
      { value: "n-cha", label: "Charges" },
      { value: "sn-elec", label: "Électricité" },
      { value: "sn-loyer", label: "Loyer" },
    ]);
    expect(groupes[1].options).toEqual([
      { value: "n-rev", label: "Revenus" },
      { value: "sn-clients", label: "Paiements clients" },
    ]);
  });

  it("tri français : « Électricité » avant « Loyer » (accent ≠ fin d'alphabet)", () => {
    // Un tri par code point classerait « É » (U+00C9) APRÈS « L » — localeCompare fr
    // le remet à sa place alphabétique. C'est le piège du tri de libellés accentués.
    const options = construireGroupesCategories(REFERENTIEL)[0].options;
    const idx = (label: string) => options.findIndex((o) => o.label === label);
    expect(idx("Électricité")).toBeLessThan(idx("Loyer"));
  });

  it("FAIL-SAFE orphelins : un enfant au parent absent reste proposable (groupe final sans en-tête)", () => {
    // Cas réel : parent archivé (absent de la liste ACTIVE) alors que l'enfant
    // reste actif — ses splits existent, il doit rester filtrable depuis l'UI.
    const groupes = construireGroupesCategories([
      ...REFERENTIEL,
      { id: "sn-orphelin", name: "Ancienne sous-nature", parentId: "n-archivee" },
    ]);
    const dernier = groupes[groupes.length - 1];
    expect(dernier.label).toBe("");
    expect(dernier.options).toEqual([
      { value: "sn-orphelin", label: "Ancienne sous-nature" },
    ]);
  });

  it("référentiel VIDE → aucun groupe (la toolbar ne rend alors pas le Select)", () => {
    expect(construireGroupesCategories([])).toEqual([]);
  });
});
