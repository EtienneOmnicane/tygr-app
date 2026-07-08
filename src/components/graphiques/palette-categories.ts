/**
 * Palette catégorielle du camembert — SOURCE UNIQUE du mapping rang → couleur de part.
 * Les valeurs vivent dans les tokens `globals.css` (`--color-chart-cat-*`, recopiés de
 * UI_GUIDELINES §0). Ce module ne fait QUE choisir la VARIABLE CSS ; il n'introduit
 * AUCUNE couleur en dur (règle UI : jamais de couleur en dur dans un composant).
 *
 * Attribution (parts triées par montant décroissant, « Non catégorisé » en dernier) :
 *   - 8 teintes distinctes pour les 8 premières catégories.
 *   - Rang ≥ 8 → couleur NEUTRE (queue « Autres », arc gris contigu).
 *   - « Non catégorisé » → TOUJOURS la couleur neutre, quel que soit son rang.
 */
export const NB_COULEURS_CATEGORIES = 8;

/** Variable CSS neutre (queue de catégories + « Non catégorisé »). */
export const COULEUR_CAT_NEUTRE = "var(--color-chart-cat-neutral)";

/**
 * Couleur (variable CSS) d'une part selon son rang (0-based) et son drapeau
 * `estNonCategorise`. Non catégorisé ou rang hors des 8 teintes → neutre.
 */
export function couleurCategorie(rang: number, estNonCategorise: boolean): string {
  if (estNonCategorise || rang >= NB_COULEURS_CATEGORIES) {
    return COULEUR_CAT_NEUTRE;
  }
  return `var(--color-chart-cat-${rang + 1})`;
}
