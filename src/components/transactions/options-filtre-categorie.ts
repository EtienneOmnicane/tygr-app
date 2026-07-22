/**
 * Groupeur d'options du FILTRE PAR CATÉGORIE de la toolbar /transactions
 * (TX-QA-FILTRE-CAT1). Module PUR (zéro React, zéro fetch) : transforme le
 * référentiel à plat en `GroupeSelect[]` pour le `Select` maison — testable en
 * unitaire sans renderer (choix projet : pas de renderer React de test).
 *
 * Hiérarchie visuelle = idiome `grouperParNature` du CategoryPicker (§4.4) : un
 * groupe par Nature (en-tête = son nom), contenant la Nature ELLE-MÊME
 * (sélectionnable — un split peut viser une racine) puis ses Sous-natures. Les
 * enfants ORPHELINS (parent absent de la liste — p. ex. parent archivé alors que
 * l'enfant reste actif) sont regroupés en fin, SANS en-tête : fail-safe, aucune
 * catégorie active ne disparaît des options (elle resterait sinon infiltrables
 * depuis l'UI alors que ses splits existent).
 *
 * Tri par nom (localeCompare fr) à chaque niveau : le serveur trie déjà à plat,
 * mais l'état LOCAL du conteneur APPEND les catégories créées en cours de session
 * (FB0709-CAT-PICKER-FRAICHEUR1) — on re-trie donc ici, défensivement.
 */
import type { GroupeSelect } from "@/components/ui/select";

/** Shape MINIMAL attendu par le filtre (sous-ensemble de `CategorieUI`). */
export interface CategorieOptionFiltre {
  id: string;
  name: string;
  parentId: string | null;
}

/** Valeur du Select signifiant « pas de filtre » (option par défaut). */
export const VALEUR_TOUTES_CATEGORIES = "";

const parNom = (a: CategorieOptionFiltre, b: CategorieOptionFiltre) =>
  a.name.localeCompare(b.name, "fr");

/**
 * Construit les groupes d'options du référentiel (SANS l'option « Toutes
 * catégories », prépendue par la toolbar). Liste vide → tableau vide (la toolbar
 * ne rend alors pas le Select du tout — pas de contrôle mort).
 */
export function construireGroupesCategories(
  categories: CategorieOptionFiltre[],
): GroupeSelect[] {
  const ids = new Set(categories.map((c) => c.id));
  const racines = categories.filter((c) => c.parentId === null).sort(parNom);
  const groupes: GroupeSelect[] = racines.map((nature) => ({
    label: nature.name,
    options: [
      { value: nature.id, label: nature.name },
      ...categories
        .filter((c) => c.parentId === nature.id)
        .sort(parNom)
        .map((sn) => ({ value: sn.id, label: sn.name })),
    ],
  }));

  const orphelins = categories
    .filter((c) => c.parentId !== null && !ids.has(c.parentId))
    .sort(parNom);
  if (orphelins.length > 0) {
    groupes.push({
      label: "",
      options: orphelins.map((o) => ({ value: o.id, label: o.name })),
    });
  }
  return groupes;
}
