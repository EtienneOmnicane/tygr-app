/**
 * `echelleNice` — arrondit un plafond BRUT (déjà dérivé en number, géométrie d'axe)
 * au prochain palier « nice » lisible (mantisse ∈ {1, 2, 2.5, 5} × 10^n), toujours
 * ≥ à l'entrée. Sert à poser des BORNES d'axe rondes (0 / 500k / 1M…) sans qu'un
 * gros mois n'écrase les petits et sans qu'une barre unique ne remplisse toute la
 * hauteur (fenêtre à faible amplitude).
 *
 * ⚠️ GÉOMÉTRIE D'AXE UNIQUEMENT (règle 8) : ce module est NEUTRE (`.ts`, pas de
 * `"use client"`, zéro JSX, zéro hook, zéro import de module client) — il peut être
 * appelé depuis un Server Component. Il opère sur un `number` DÉJÀ DÉRIVÉ (une
 * échelle déjà calculée par `maxFenetre`/`valeurGeo`, elles-mêmes en cul-de-sac
 * float) : il ne réinjecte JAMAIS son résultat dans un montant affiché ou stocké.
 * Aucune somme financière ici, aucune chaîne décimale en entrée/sortie.
 */

/** Mantisses « nice » couvertes, dans l'ordre croissant. Le `10` ferme la boucle :
 *  il capture les mantisses proches de la décade suivante (ex. 8,1 → 10). Les paliers
 *  intermédiaires (1.5, 3, 4, 6, 8) EXISTENT pour éviter que l'axe ne double le max :
 *  sans eux, un max de mantisse 5,2 sautait à 10 → la plus haute barre ne remplissait
 *  que ~52 % de la hauteur, laissant le haut de la carte vide (bug « je vois rien »).
 *  Avec ces paliers le pire cas de remplissage passe de ~50 % à ~67 %. */
const MANTISSES_NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/** Tolérance pour les cas « pile » (ex. 50 → mantisse 5.000000000000001 en float à
 *  cause de la division par la puissance de 10) : sans elle, 50 sauterait à 10×10^1
 *  au lieu de rester à 5×10^1. */
const EPSILON = 1e-9;

/**
 * Plafond sûr de repli : utilisé pour toute entrée non exploitable (zéro, négatif,
 * NaN, Infinity) afin qu'une division en aval par ce plafond ne fasse jamais 0/0 ni
 * ne divise par zéro. `1` est le plus petit palier « nice » de l'échelle — un choix
 * neutre qui ne prétend représenter aucun montant réel.
 */
const PLAFOND_SUR_DEFAUT = 1;

/**
 * Retourne le plus petit plafond « nice » (mantisse ∈ {1, 2, 2.5, 5} × 10^n) qui soit
 * ≥ `maxBrut`. Fail-safe : toute entrée non finie ou ≤ 0 retourne `PLAFOND_SUR_DEFAUT`
 * (1) plutôt que de propager NaN/Infinity/0 vers un dénominateur en aval.
 */
export function echelleNice(maxBrut: number): number {
  if (!Number.isFinite(maxBrut) || maxBrut <= 0) {
    return PLAFOND_SUR_DEFAUT;
  }

  const exposant = Math.floor(Math.log10(maxBrut));
  const base = 10 ** exposant;
  const mantisse = maxBrut / base;

  const mantisseNice =
    MANTISSES_NICE.find((m) => m >= mantisse - EPSILON) ??
    MANTISSES_NICE[MANTISSES_NICE.length - 1];

  return mantisseNice * base;
}
