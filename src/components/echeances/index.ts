/**
 * Barrel du domaine « Échéances prévisionnelles » (UI). Composants présentationnels
 * (liste dirigée, formulaire bimodal, badge de statut, synthèse par horizon) +
 * conteneur client + contrat d'actions. Le câblage serveur (Server Actions réelles)
 * vit dans la page RSC `src/app/(workspace)/echeances/page.tsx`.
 */
export { EcheancesFeature } from "./echeances-feature";
export { EcheancesList } from "./echeances-list";
export { EcheancesSynthese } from "./echeances-synthese";
export { EcheanceForm, type EntiteOptionUI } from "./echeance-form";
export { EcheanceBadge, libelleStatut } from "./echeance-badge";
export type {
  ActionsEcheances,
  ChangerStatutInputUI,
  CreerEcheanceInputUI,
  DeviseEcheance,
  DirectionEcheance,
  EcheanceUI,
  EcheancesVueUI,
  ModifierEcheanceInputUI,
  RecurrenceEcheance,
  ResultatAction,
  StatutEcheance,
  StatutEcheanceAffiche,
  SyntheseEcheancesUI,
  SyntheseHorizonDeviseUI,
  SyntheseHorizonUI,
} from "./types-echeances";
