/**
 * Constantes de LAYOUT partagées par les deux vues de la carte d'ancre « Flux de
 * trésorerie » (la courbe `flux-chart-trace.tsx` ET les barres `flux-bars.tsx`).
 *
 * Module NEUTRE (`.ts`, pas de `"use client"`, zéro JSX/hook) : il ne porte que des
 * valeurs. But anti-duplication — la hauteur de l'ancre était définie en double
 * potentiel ; une seule source ici garantit que courbe et barres occupent EXACTEMENT
 * la même hauteur (pas de saut de layout au toggle).
 */

/**
 * Hauteur de l'ancre — UI_GUIDELINES §4.2 : « ~55vh (min 380px) ». Le plafond 520px
 * évite que le graphe devienne absurdement grand sur très grand écran (le `min-h
 * -[380px]` de la carte porte déjà le plancher ; ici on porte la VALEUR fluide). La
 * même hauteur sert au tracé (courbe), aux barres ET à l'état vide → aucun saut de
 * layout au toggle/vide.
 */
export const HAUTEUR_ANCRE = "clamp(380px, 55vh, 520px)";
