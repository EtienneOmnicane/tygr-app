/**
 * Barrel du domaine « Analyse par catégorie » (camembert). Conteneur client +
 * briques présentationnelles (donut SVG fait main, légende, carte par devise) +
 * contrat d'actions injectées. Le câblage serveur (Server Action réelle) vit dans
 * la page RSC `src/app/(workspace)/graphiques/page.tsx` ; la démo Visual QA monte
 * la feature avec des stubs (`src/app/demo/graphiques-states/`).
 */
export { GraphiquesFeature } from "./graphiques-feature";
export { RepartitionDeviseCard } from "./repartition-devise-card";
export { DonutCategories } from "./donut-categories";
export { LegendeCategories } from "./legende-categories";
export { MentionReanalyse } from "./mention-reanalyse";
export { pourcentPart } from "./pourcent-part";
export {
  couleurCategorie,
  COULEUR_CAT_NEUTRE,
  NB_COULEURS_CATEGORIES,
} from "./palette-categories";
export type {
  ActionsGraphiques,
  ResultatAnalyse,
  SelectionGraphique,
} from "./types-graphiques";
