/**
 * Barrel du domaine Transactions (page /transactions). Composants présentationnels
 * purs + conteneur client ; aucune Server Action ici (injectées via le contrat
 * `types-transactions.ts`). Source de vérité visuelle : docs/UI_GUIDELINES.md.
 */
export { TransactionsFeature } from "./transactions-feature";
export { TransactionsTable } from "./transactions-table";
export { TransactionRow } from "./transaction-row";
export { TransactionsToolbar, type CompteFiltre } from "./transactions-toolbar";
export { CategorisationStatusBadge } from "./categorisation-status-badge";
export { FiabiliteBadge } from "./fiabilite-badge";
export { SourceClassificationIcon } from "./source-classification-icon";
export { afficherAVerifier, descriptionSource } from "./regle-fiabilite";
export { TransactionsLoading } from "./states/transactions-loading";
export type {
  TransactionListItem,
  CurseurTransactions,
  FiltresTransactions,
  PageTransactions,
  StatutCategorisation,
  NiveauFiabilite,
  SourceClassification,
  ActionsTransactions,
} from "./types-transactions";
