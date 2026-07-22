/**
 * Groupeur d'options du FILTRE PAR CATÉGORIE de la toolbar /transactions
 * (TX-QA-FILTRE-CAT1). Module PUR (zéro React, zéro fetch) : transforme le
 * référentiel à plat en `GroupeSelect[]` pour le `Select` maison — testable en
 * unitaire sans renderer (choix projet : pas de renderer React de test).
 *
 * Hiérarchie visuelle = idiome `grouperParNature` du CategoryPicker (§4.4) : un
 * groupe par Nature (en-tête = son nom), contenant la Nature ELLE-MÊME
 * (sélectionnable — un split peut viser une racine) puis ses Sous-natures. Toute
 * catégorie NON RATTACHABLE à une racine de la liste est regroupée en fin, SANS
 * en-tête : parent archivé (absent de la liste active) MAIS AUSSI parent présent
 * sans être une racine (« petit-enfant » — le schéma serveur ne borne pas la
 * profondeur, cross-review 2026-07-22). Fail-safe : aucune catégorie active ne
 * disparaît des options (elle resterait sinon infiltrable depuis l'UI alors que
 * ses splits existent).
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
  const racines = categories.filter((c) => c.parentId === null).sort(parNom);
  // Rattachables = enfants DIRECTS d'une racine. Tester l'appartenance aux RACINES
  // (pas à la liste entière) : un « petit-enfant » dont le parent est présent mais
  // non-racine ne serait sinon ni groupé (la boucle ne parcourt que les enfants de
  // racines) ni orphelin (son parent existe) → il disparaîtrait en silence.
  const racineIds = new Set(racines.map((r) => r.id));
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
    .filter((c) => c.parentId !== null && !racineIds.has(c.parentId))
    .sort(parNom);
  if (orphelins.length > 0) {
    groupes.push({
      label: "",
      options: orphelins.map((o) => ({ value: o.id, label: o.name })),
    });
  }
  return groupes;
}
