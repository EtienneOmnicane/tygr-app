/**
 * Barrel des états présentationnels du dashboard (Epic 3 — loading / vide /
 * erreur). Composants « stupides » : aucun fetch, aucune logique d'état.
 * Source de vérité visuelle : docs/UI_GUIDELINES.md.
 */
export { DashboardLoadingState } from "./dashboard-loading-state";
export { DashboardEmptyState } from "./dashboard-empty-state";
export { DashboardErrorState } from "./dashboard-error-state";
export { SkeletonBlock, StateCard, StateIllustration, cn } from "./primitives";
