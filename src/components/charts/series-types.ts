/**
 * Types d'AFFICHAGE des séries de graphiques — module NEUTRE (`.ts`, aucun `"use
 * client"`, aucun import serveur), transverse au dashboard et à `/graphiques`.
 *
 * Ces types décrivent ce que la LÉGENDE et le graphe manipulent (des séries NOMMÉES,
 * masquables) ; ce ne sont PAS un miroir des DTO serveur (`PointCashflow`,
 * `SyntheseMensuelle`). La frontière est délibérée : l'UI raisonne sur « quelles
 * courbes montrer », le serveur sur « quels agrégats ».
 *
 * Couleurs : on ne stocke JAMAIS un hex ici — seulement un NOM de token Tailwind
 * (`bg-inflow` / `bg-outflow`), résolu au rendu (aucune couleur en dur, règle UI). Le
 * vert/rouge de `inflow`/`outflow` DÉCRIT la donnée (légitime, UI_GUIDELINES §3.1).
 */

/** Les deux séries du graphe de flux : entrées (crédits) et sorties (débits). */
export type IdSerieFlux = "entrees" | "sorties";

/** Métadonnée d'affichage d'une série de flux (légende + pastille). */
export interface SerieFluxMeta {
  id: IdSerieFlux;
  /** Libellé NOMMÉ, en français, affiché tel quel dans la légende. */
  libelle: string;
  /** NOM de token Tailwind de la pastille (jamais un hex). */
  tokenPastille: string;
}

/**
 * Ordre et nommage CANONIQUES des séries de flux — source unique consommée par la
 * légende ET par la géométrie des barres. Entrées au-dessus de l'axe (`inflow`),
 * sorties en dessous (`outflow`).
 */
export const SERIES_FLUX: readonly SerieFluxMeta[] = [
  { id: "entrees", libelle: "Entrées", tokenPastille: "bg-inflow" },
  { id: "sorties", libelle: "Sorties", tokenPastille: "bg-outflow" },
];

/** Ensemble des séries actuellement VISIBLES (masquage piloté par la légende). */
export type VisibiliteSeries = ReadonlySet<IdSerieFlux>;

/** Toutes les séries visibles — état initial du graphe. */
export const TOUTES_SERIES_VISIBLES: VisibiliteSeries = new Set<IdSerieFlux>([
  "entrees",
  "sorties",
]);

/**
 * Bascule la visibilité d'une série en respectant l'INVARIANT PRODUIT : on ne peut
 * jamais masquer la DERNIÈRE série visible (le graphe ne doit pas devenir un cadre
 * vide sans explication). Retourne l'ensemble INCHANGÉ si la bascule le violerait —
 * la décision vit ICI (pure, testable), pas dispersée dans le composant.
 */
export function basculerVisibilite(
  visibles: VisibiliteSeries,
  id: IdSerieFlux,
): VisibiliteSeries {
  const suivant = new Set(visibles);
  if (suivant.has(id)) {
    // Refus de masquer la dernière série visible (cadre vide interdit).
    if (suivant.size === 1) return visibles;
    suivant.delete(id);
  } else {
    suivant.add(id);
  }
  return suivant;
}

/** Une série est-elle VERROUILLÉE (masquage interdit car c'est la dernière visible) ? */
export function estDerniereVisible(
  visibles: VisibiliteSeries,
  id: IdSerieFlux,
): boolean {
  return visibles.size === 1 && visibles.has(id);
}
