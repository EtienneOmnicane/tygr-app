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

/**
 * Plafond d'AFFICHAGE du delta, en points de pourcentage. Au-delà, l'étiquette
 * bascule sur « >999 % » plutôt que d'écrire le chiffre exact.
 *
 * Deux raisons, aucune n'étant du confort :
 *   1. **Sémantique** — un delta calculé sur une base précédente minuscule mais non
 *      nulle (0,47 vs 9 005 : +1 915 977 %, observé en prod sur une catégorie
 *      « Loyer » USD) n'informe sur rien : il mesure la petitesse du dénominateur,
 *      pas l'évolution de la catégorie.
 *   2. **Layout** — la colonne du badge est dimensionnée (`w-14`, `tabular-nums`) et
 *      un chiffre clé ne se tronque JAMAIS (règle de formatage) : sans borne, un
 *      delta à 7 chiffres déborderait sur le pourcentage voisin.
 *
 * Borne symétrique (hausse ET baisse) : une baisse est mathématiquement bornée à
 * −100 % tant que `montant` est positif, mais la symétrie évite de faire dépendre la
 * garde d'une hypothèse de signe sur des agrégats venus du SQL.
 */
export const PLAFOND_POURCENT = 999;

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
 *   - |delta| au-delà de `PLAFOND_POURCENT` → sens conservé, libellé « >999 % » (cf.
 *     la constante : un ratio sur une base négligeable ne mesure que le dénominateur).
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
  const sens = arrondi > 0 ? "hausse" : "baisse";
  const magnitude = Math.abs(arrondi);
  if (magnitude > PLAFOND_POURCENT) {
    // Le SENS reste vrai et informatif (la part a bien explosé) ; seule la précision
    // du chiffre est abandonnée. « nouveau » serait FAUX ici : la catégorie existait
    // à la période précédente, et l'infobulle « Nouveau sur cette période » mentirait.
    return { sens, pourcent: `>${PLAFOND_POURCENT}${ESPACE_FINE}%` };
  }
  return { sens, pourcent: `${magnitude}${ESPACE_FINE}%` };
}
