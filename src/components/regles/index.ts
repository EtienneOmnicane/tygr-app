/**
 * Barrel du domaine « Règles de catégorisation » (UI). Composants présentationnels
 * + conteneur client + contrat d'actions. Le câblage serveur vit dans la page RSC
 * `src/app/(workspace)/regles/page.tsx`.
 */
export { ReglesFeature } from "./regles-feature";
export { ReglesList } from "./regles-list";
export { RegleForm } from "./regle-form";
export type {
  ActionsRegles,
  RegleUI,
  RuleMatchType,
  ResultatAction,
} from "./types-regles";
