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
  soldesParDevise: [
    { currency: "MUR", total: "7691000.00" },
    { currency: "USD", total: "179200.00" },
  ],
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
  // Tendance 6 mois (MUR) ; mars porte aussi de l'USD pour illustrer le drapeau
  // « + autres devises » (jamais additionné à la devise de base). Série à plat
  // (mois × devise), comme la sortie de `syntheseParMois`.
  serieMensuelle: [
    { mois: "2026-01", currency: "MUR", entrees: "3800000.00", sorties: "3450000.00", variation: "350000.00" },
    { mois: "2026-02", currency: "MUR", entrees: "4120000.00", sorties: "3980000.00", variation: "140000.00" },
    { mois: "2026-03", currency: "MUR", entrees: "4560000.00", sorties: "4210000.00", variation: "350000.00" },
    { mois: "2026-03", currency: "USD", entrees: "42000.00", sorties: "18000.00", variation: "24000.00" },
    { mois: "2026-04", currency: "MUR", entrees: "5010000.00", sorties: "4880000.00", variation: "130000.00" },
    { mois: "2026-05", currency: "MUR", entrees: "4790000.00", sorties: "5120000.00", variation: "-330000.00" },
    { mois: "2026-06", currency: "MUR", entrees: "5200000.00", sorties: "4474000.00", variation: "726000.00" },
  ],
  grilleMensuelle: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
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
      isAutoCategorized: true,
      categorySource: "OMNIFI",
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
      isAutoCategorized: true,
      categorySource: "OMNIFI",
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
      isAutoCategorized: true,
      categorySource: "OMNIFI",
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
      isAutoCategorized: true,
      categorySource: "OMNIFI",
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
  soldesParDevise: DEMO_DASHBOARD.soldesParDevise,
  courbe: [],
  syntheseMois: DEMO_DASHBOARD.syntheseMois,
  serieMensuelle: [],
  grilleMensuelle: [],
  transactionsRecentes: [],
};

/** État VIDE : workspace connecté mais aucun compte (empty global + CTA). */
export const DEMO_DASHBOARD_VIDE: DonneesDashboard = {
  comptes: [],
  soldesParDevise: [],
  courbe: [],
  syntheseMois: { libelleMois: "2026-06", entrees: "0", sorties: "0", variation: "0" },
  serieMensuelle: [],
  grilleMensuelle: [],
  transactionsRecentes: [],
};
