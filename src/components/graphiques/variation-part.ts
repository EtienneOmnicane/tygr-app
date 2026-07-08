/**
 * Étiquette de VARIATION d'une part vs la période PRÉCÉDENTE (« +12 % », « −8 % »,
 * « stable », « nouveau ») — source unique du calcul d'affichage de la variation (L4).
 *
 * ⚠️ Frontière float (CLAUDE.md règle 8) : `montant` et `montantPrecedent` sont des
 * CHAÎNES décimales (agrégats SQL). Le `Number()` interne est un CUL-DE-SAC d'AFFICHAGE —
 * il produit un RATIO (%), jamais un montant, et ne réinjecte JAMAIS dans une addition ni
 * un montant affiché (même contrat que `pourcent-part.ts`). Aucun centime ne transite ici.
 *
 * Neutralité sémantique (UI_GUIDELINES) : le SENS est porté par une flèche, JAMAIS par une
 * couleur `inflow`/`outflow` (vert/rouge réservés aux MONTANTS) — le rendu choisit des
 * tokens neutres (`text`/`text-muted`).
 */

const ESPACE_FINE = " "; // U+202F, espace fine insécable (séparateur FR avant %)

/** Sens de la variation d'une part entre deux fenêtres contiguës. */
export type SensVariation = "hausse" | "baisse" | "stable" | "nouveau";

export interface Variation {
  sens: SensVariation;
  /** Libellé du delta (« 12 % ») ; `null` quand non chiffrable (nouveau/stable arrondi). */
  pourcent: string | null;
}

/**
 * Variation d'affichage d'une part. Cas :
 *   - `montantPrecedent` ≤ 0 (catégorie absente de la période précédente) → « nouveau »
 *     (pas de % : division par zéro non définie, on ne fabrique pas un +∞).
 *   - delta arrondi à 0 % → « stable » (pas de flèche trompeuse pour un écart < 0,5 %).
 *   - sinon → hausse/baisse + |delta| % entier.
 */
export function variationPart(
  montant: string,
  montantPrecedent: string,
): Variation {
  const prev = Number(montantPrecedent);
  const cur = Number(montant);
  if (!Number.isFinite(prev) || prev <= 0) {
    return { sens: "nouveau", pourcent: null };
  }
  if (!Number.isFinite(cur)) {
    return { sens: "stable", pourcent: null };
  }
  const delta = ((cur - prev) / prev) * 100;
  const arrondi = Math.round(delta);
  if (arrondi === 0) {
    return { sens: "stable", pourcent: null };
  }
  return {
    sens: arrondi > 0 ? "hausse" : "baisse",
    pourcent: `${Math.abs(arrondi)}${ESPACE_FINE}%`,
  };
}
