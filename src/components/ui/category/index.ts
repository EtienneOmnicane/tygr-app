/**
 * Barrel des composants de catégorisation (Pilier 1). Présentationnels purs :
 * aucune Server Action ici, les actions sont injectées (contrat `types.ts`).
 */
export { CategoryBadge, indexTeinteCategorie, NB_TEINTES_CATEGORIE } from "./category-badge";
export { CategoryPicker } from "./category-picker";
export { CategoryManagerModal } from "./category-manager-modal";
export { SplitAllocationModal } from "./split-allocation-modal";
export {
  calculerAllocation,
  peutValider,
  versPayload,
  montantValide,
  type LigneAllocation,
  type EtatAllocation,
} from "./allocation";
export type {
  CategorieUI,
  SplitUI,
  RefTransactionUI,
  AjoutSplitManuelUI,
  ResultatAction,
  SourceCategorisation,
  ActionsCategorisation,
  ActionsReferentielCategories,
} from "./types";
