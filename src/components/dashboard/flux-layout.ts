/**
 * Constantes de LAYOUT de la carte d'ancre « Flux de trésorerie » (`flux-bars.tsx`).
 *
 * Module NEUTRE (`.ts`, pas de `"use client"`, zéro JSX/hook) : il ne porte que des
 * valeurs. Une seule source garantit que le graphe rendu et l'état vide occupent
 * EXACTEMENT la même hauteur (pas de saut de layout quand la donnée arrive).
 */

/**
 * Hauteur de l'ancre — UI_GUIDELINES §4.2 : « ~55vh (min 380px) ». Le plafond 520px
 * évite que le graphe devienne absurdement grand sur très grand écran (le `min-h
 * -[380px]` de la carte porte déjà le plancher ; ici on porte la VALEUR fluide). La
 * même hauteur sert aux barres ET à l'état vide → aucun saut de layout.
 */
export const HAUTEUR_ANCRE = "clamp(380px, 55vh, 520px)";
