/**
 * Fixtures de DÉMONSTRATION du dashboard (Epic 3) — données 100 % FICTIVES,
 * typées EXACTEMENT comme les sorties des 5 services de lecture
 * (`dashboard.ts`). Destinées à l'agent UI : permettent de câbler et de visual-QA
 * le dashboard AVANT que le seed Omni-FI sandbox ne soit opérationnel.
 *
 * Contrat (à respecter par l'UI) :
 * - Montants = CHAÎNES décimales (règle 8). L'UI formate en tabular-nums, ne
 *   recalcule rien. Les sorties peuvent être négatives (variation, solde).
 * - Aucune PII : libellés nettoyés plausibles (PME mauricienne), pas de
 *   bank_label_raw.
 * - Cohérence interne : la dernière valeur de la courbe = solde consolidé
 *   courant ; la synthèse correspond aux transactions récentes du mois.
 *
 * ⚠️ NE JAMAIS importer ces fixtures dans un chemin servant des données réelles.
 * Réservé au rendu de démo/preview et aux tests d'affichage.
 */
import type {
  CompteConnecte,
  PointCourbe,
  SyntheseMois,
  TransactionRecente,
} from "./dashboard";

export const FIXTURE_COMPTES: CompteConnecte[] = [
  {
    bankAccountId: "demo-acc-mcb-4521",
    accountName: "MCB — Compte courant business",
    currency: "MUR",
    currentBalance: "5230000.00",
    lastSyncedAt: new Date("2026-06-12T08:00:00Z"),
  },
  {
    bankAccountId: "demo-acc-sbm-0937",
    accountName: "SBM — Compte opérations",
    currency: "MUR",
    currentBalance: "2461000.00",
    lastSyncedAt: new Date("2026-06-12T07:00:00Z"),
  },
];

/** Solde consolidé courant = somme des derniers EOD (cohérent avec la courbe). */
export const FIXTURE_SOLDE_CONSOLIDE = "7691000.00";

/**
 * Courbe 90 j (fenêtre 2026-03-14 → 2026-06-12), un point hebdomadaire pour
 * rester lisible ; la dernière valeur = FIXTURE_SOLDE_CONSOLIDE. Inclut une
 * portion BASSE (sous un éventuel seuil) pour tester le rendu d'alerte.
 */
export const FIXTURE_COURBE: PointCourbe[] = [
  { date: "2026-03-14", soldeConsolide: "2750000.00" },
  { date: "2026-03-21", soldeConsolide: "3120000.00" },
  { date: "2026-03-28", soldeConsolide: "1694000.00" },
  { date: "2026-04-04", soldeConsolide: "2480000.00" },
  { date: "2026-04-11", soldeConsolide: "4310000.00" },
  { date: "2026-04-18", soldeConsolide: "3890000.00" },
  { date: "2026-04-25", soldeConsolide: "5120000.00" },
  { date: "2026-05-02", soldeConsolide: "4675000.00" },
  { date: "2026-05-09", soldeConsolide: "6240000.00" },
  { date: "2026-05-16", soldeConsolide: "5980000.00" },
  { date: "2026-05-23", soldeConsolide: "7150000.00" },
  { date: "2026-05-30", soldeConsolide: "6720000.00" },
  { date: "2026-06-06", soldeConsolide: "8030000.00" },
  { date: "2026-06-12", soldeConsolide: "7691000.00" },
];

export const FIXTURE_SYNTHESE_MOIS: SyntheseMois = {
  libelleMois: "2026-06",
  entrees: "5200000.00",
  sorties: "4474000.00",
  variation: "726000.00",
};

export const FIXTURE_TRANSACTIONS_RECENTES: TransactionRecente[] = [
  {
    omnifiTxnId: "demo-tx-0008",
    transactionDate: "2026-06-11",
    amount: "1530000.00",
    currency: "MUR",
    creditDebit: "Credit",
    cleanLabel: "Beachcomber Resorts",
    primaryCategory: "Income",
    subCategory: "Client Payments",
    bankAccountId: "demo-acc-sbm-0937",
  },
  {
    omnifiTxnId: "demo-tx-0007",
    transactionDate: "2026-06-09",
    amount: "1290000.00",
    currency: "MUR",
    creditDebit: "Credit",
    cleanLabel: "Ciel Textile",
    primaryCategory: "Income",
    subCategory: "Client Payments",
    bankAccountId: "demo-acc-sbm-0937",
  },
  {
    omnifiTxnId: "demo-tx-0006",
    transactionDate: "2026-06-05",
    amount: "384250.00",
    currency: "MUR",
    creditDebit: "Debit",
    cleanLabel: "CEB",
    primaryCategory: "Utilities",
    subCategory: "Electricity",
    bankAccountId: "demo-acc-mcb-4521",
  },
  {
    omnifiTxnId: "demo-tx-0005",
    transactionDate: "2026-06-01",
    amount: "950000.00",
    currency: "MUR",
    creditDebit: "Debit",
    cleanLabel: "Ebène Cybercity",
    primaryCategory: "Rent",
    subCategory: "Office Rent",
    bankAccountId: "demo-acc-mcb-4521",
  },
];

/** Agrégat prêt à l'emploi : un dashboard complet en un objet (état « succès »). */
export const FIXTURE_DASHBOARD = {
  comptes: FIXTURE_COMPTES,
  soldeConsolide: FIXTURE_SOLDE_CONSOLIDE,
  courbe: FIXTURE_COURBE,
  syntheseMois: FIXTURE_SYNTHESE_MOIS,
  transactionsRecentes: FIXTURE_TRANSACTIONS_RECENTES,
} as const;

/** État « vide » : workspace connecté mais aucune donnée (teste l'empty state). */
export const FIXTURE_DASHBOARD_VIDE = {
  comptes: [] as CompteConnecte[],
  soldeConsolide: "0",
  courbe: [] as PointCourbe[],
  syntheseMois: {
    libelleMois: "2026-06",
    entrees: "0",
    sorties: "0",
    variation: "0",
  } satisfies SyntheseMois,
  transactionsRecentes: [] as TransactionRecente[],
} as const;
