/**
 * Fixtures de DÉMO du dashboard côté UI (Epic 3, PR C) — données 100 % FICTIVES,
 * dédiées au rendu de prévisualisation / Visual QA (`/demo/dashboard`).
 *
 * Pourquoi une copie ici plutôt que d'importer `server/repositories/
 * dashboard.fixtures.ts` : la barrière anti-accès-DB (CLAUDE.md règle 2,
 * `no-restricted-imports`) confine `@/server/repositories/*` — une page UI ne
 * peut pas l'importer en valeur. Les TYPES, eux, viennent de `dashboard.ts` via
 * `import type` (effacé au build, autorisé). Mêmes valeurs que la fixture serveur
 * pour rester cohérent ; si l'une bouge, aligner l'autre.
 *
 * ⚠️ JAMAIS importé dans un chemin servant des données réelles. Démo uniquement.
 */
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

/** État SUCCÈS : dashboard complet (2 comptes MUR, courbe 90 j, 4 transactions). */
export const DEMO_DASHBOARD: DonneesDashboard = {
  comptes: [
    {
      bankAccountId: "demo-acc-mcb-4521",
      accountName: "MCB — Compte courant business",
      institutionName: "The Mauritius Commercial Bank",
      currency: "MUR",
      currentBalance: "5230000.00",
      lastSyncedAt: new Date("2026-06-12T08:00:00Z"),
    },
    {
      bankAccountId: "demo-acc-sbm-0937",
      accountName: "SBM — Compte opérations",
      institutionName: "State Bank of Mauritius",
      currency: "MUR",
      currentBalance: "2461000.00",
      lastSyncedAt: new Date("2026-06-12T07:00:00Z"),
    },
  ],
  soldeConsolide: "7691000.00",
  courbe: [
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
  ],
  syntheseMois: {
    libelleMois: "2026-06",
    entrees: "5200000.00",
    sorties: "4474000.00",
    variation: "726000.00",
  },
  transactionsRecentes: [
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
  ],
};

/**
 * État PARTIEL (décision revue) : comptes + solde + synthèse présents, MAIS
 * courbe et transactions vides — workspace fraîchement connecté, soldes/txns
 * pas encore synchronisés.
 */
export const DEMO_DASHBOARD_PARTIEL: DonneesDashboard = {
  comptes: DEMO_DASHBOARD.comptes,
  soldeConsolide: DEMO_DASHBOARD.soldeConsolide,
  courbe: [],
  syntheseMois: DEMO_DASHBOARD.syntheseMois,
  transactionsRecentes: [],
};

/** État VIDE : workspace connecté mais aucun compte (empty global + CTA). */
export const DEMO_DASHBOARD_VIDE: DonneesDashboard = {
  comptes: [],
  soldeConsolide: "0",
  courbe: [],
  syntheseMois: { libelleMois: "2026-06", entrees: "0", sorties: "0", variation: "0" },
  transactionsRecentes: [],
};
