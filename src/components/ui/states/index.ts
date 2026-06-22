/**
 * Barrel des briques d'état TRANSVERSES (UI_GUIDELINES §4.4). Réutilisables par
 * tout domaine. Composants présentationnels purs : aucun fetch, aucune logique
 * d'état. Source de vérité visuelle : docs/UI_GUIDELINES.md.
 */
export {
  cn,
  SkeletonBlock,
  StateCard,
  StateIllustration,
  type StateIllustrationVariant,
} from "./primitives";
export { EmptyState, type EmptyStateCta } from "./empty-state";
export { AppErrorState } from "./app-error-state";
