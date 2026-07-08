/**
 * Étiquette de POURCENTAGE d'une part de camembert (« 24 % », « <1 % », « 100 % »).
 *
 * ⚠️ Frontière float (CLAUDE.md règle 8) : `part` est une CHAÎNE décimale (fraction
 * 0..1 calculée EN SQL). Le `Number()` interne est un CUL-DE-SAC d'AFFICHAGE — il
 * produit un LIBELLÉ (un ratio, jamais un montant) et ne réinjecte JAMAIS dans un
 * montant ni dans une addition. Aucun centime ne transite ici : les montants, eux,
 * passent par `format-montant.ts` (chaînes, sans float). Réutiliser cette fonction
 * partout où un pourcentage de part s'affiche (donut + légende) — source unique.
 *
 * Format FR : espace fine insécable (U+202F) avant le « % » — le signe ne se coupe
 * jamais du chiffre en fin de ligne (même règle que le symbole de devise).
 */

const ESPACE_FINE = " "; // U+202F, espace fine insécable (séparateur FR avant %)

/**
 * Convertit une fraction décimale (« 0.2431 ») en étiquette de pourcentage entière
 * (« 24 % »). Cas particuliers :
 *   - fraction non finie ou ≤ 0 → « 0 % » (garde-fou, ne devrait pas survenir : le
 *     SQL borne à des parts positives).
 *   - fraction positive mais qui arrondirait à 0 (< 0,5 %) → « <1 % » (jamais un
 *     « 0 % » trompeur pour une part réelle mais minuscule).
 */
export function pourcentPart(part: string): string {
  const fraction = Number(part);
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return `0${ESPACE_FINE}%`;
  }
  const pourcent = fraction * 100;
  const arrondi = Math.round(pourcent);
  if (arrondi === 0) {
    // Part réelle mais < 0,5 % : « <1 % » plutôt qu'un « 0 % » trompeur.
    return `<1${ESPACE_FINE}%`;
  }
  return `${arrondi}${ESPACE_FINE}%`;
}
