/**
 * Fixtures de DÉMO du dashboard côté UI (Epic 3) — données 100 % FICTIVES,
 * dédiées au rendu de prévisualisation / Visual QA (`/demo/dashboard`).
 *
 * Pourquoi une copie ici plutôt que d'importer `server/repositories/
 * dashboard.fixtures.ts` : la barrière anti-accès-DB (CLAUDE.md règle 2,
 * `no-restricted-imports`) confine `@/server/repositories/*` — une page UI ne
 * peut pas l'importer en valeur. Les TYPES, eux, viennent de `dashboard.ts` /
 * `insights/types.ts` via `import type` (effacé au build, autorisé).
 *
 * ⚠️ JAMAIS importé dans un chemin servant des données réelles. Démo uniquement.
 */
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

/** Mois courant de la démo (libellé des cartes de synthèse). */
export const DEMO_MOIS = "2026-06";

/**
 * État SUCCÈS : dashboard complet. Multi-devise (MUR + USD) pour exercer la
 * synthèse ventilée et la pile de soldes ; flux mensuel AVEC un mois NÉGATIF
 * (mai) pour valider la ligne de zéro et l'aire en-dessous.
 */
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
  // Flux net mensuel (base_currency MUR) — mai négatif (sorties > entrées).
  flux: [
    { bucket: "2026-01", currency: "MUR", entrees: "3800000.00", sorties: "3450000.00", net: "350000.00", nbTransactions: 42 },
    { bucket: "2026-02", currency: "MUR", entrees: "4120000.00", sorties: "3980000.00", net: "140000.00", nbTransactions: 38 },
    { bucket: "2026-03", currency: "MUR", entrees: "4560000.00", sorties: "4210000.00", net: "350000.00", nbTransactions: 45 },
    { bucket: "2026-04", currency: "MUR", entrees: "5010000.00", sorties: "4880000.00", net: "130000.00", nbTransactions: 51 },
    { bucket: "2026-05", currency: "MUR", entrees: "4790000.00", sorties: "5120000.00", net: "-330000.00", nbTransactions: 47 },
    { bucket: "2026-06", currency: "MUR", entrees: "5200000.00", sorties: "4474000.00", net: "726000.00", nbTransactions: 49 },
  ],
  // Synthèse du mois courant PAR DEVISE (MUR + USD) — jamais additionnées.
  synthesesMois: [
    { currency: "MUR", entrees: "5200000.00", sorties: "4474000.00", variation: "726000.00" },
    { currency: "USD", entrees: "118000.00", sorties: "92500.00", variation: "25500.00" },
  ],
  // Top contreparties (dépenses) — multi-devise pour exercer le groupement.
  topVendors: {
    direction: "outflow",
    lignes: [
      { contrepartie: "Ebène Cybercity", currency: "MUR", montant: "1850000.00", part: "0.41", nbTransactions: 3 },
      { contrepartie: "CEB", currency: "MUR", montant: "1120000.00", part: "0.25", nbTransactions: 6 },
      { contrepartie: "Mauritius Telecom", currency: "MUR", montant: "624000.00", part: "0.14", nbTransactions: 4 },
      { contrepartie: "Vivo Energy", currency: "MUR", montant: "388000.00", part: "0.086", nbTransactions: 5 },
      { contrepartie: "AWS EMEA", currency: "USD", montant: "62400.00", part: "0.67", nbTransactions: 2 },
    ],
  },
  // Tendance 6 mois (MUR) ; mars porte aussi de l'USD. Série à plat (mois × devise).
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
 * État PARTIEL (décision revue) : comptes + solde présents, MAIS flux, synthèse,
 * vendors et transactions vides — workspace fraîchement connecté, données pas
 * encore synchronisées. La synthèse vide se replie sur « 0 dans la devise de base ».
 */
export const DEMO_DASHBOARD_PARTIEL: DonneesDashboard = {
  comptes: DEMO_DASHBOARD.comptes,
  soldesParDevise: DEMO_DASHBOARD.soldesParDevise,
  flux: [],
  synthesesMois: [],
  topVendors: { direction: "outflow", lignes: [] },
  serieMensuelle: [],
  grilleMensuelle: [],
  transactionsRecentes: [],
};

/** État VIDE : workspace connecté mais aucun compte (empty global + CTA). */
export const DEMO_DASHBOARD_VIDE: DonneesDashboard = {
  comptes: [],
  soldesParDevise: [],
  flux: [],
  synthesesMois: [],
  topVendors: { direction: "outflow", lignes: [] },
  serieMensuelle: [],
  grilleMensuelle: [],
  transactionsRecentes: [],
};
