"use client";

/**
 * Démo / Visual QA de la page /transactions (Pilier 1 — liste + ventilation).
 * NON destinée à la production : données FICTIVES, actions STUB (aucun fetch, aucune
 * DB, aucune auth). Sert à capturer hors auth/DB (Quality Gate 4) :
 *  - densité §2.2 (py-14/px-16, ~44px, PAS de zébrage, séparateurs `line`),
 *  - alignement `tabular-nums` des montants à droite,
 *  - couleur sémantique des montants (Credit vert / Debit rouge) UNIQUEMENT,
 *  - badges de catégorie SANS vert/rouge ; « partiel » en ambre,
 *  - clic d'une ligne → SplitAllocationModal,
 *  - les 4 états (liste / loading / vide / erreur).
 */
import { useMemo, useState } from "react";

import { TransactionsFeature } from "@/components/transactions";
import { TransactionsLoading } from "@/components/transactions";
import { AppErrorState, EmptyState } from "@/components/ui/states";
import type {
  ActionsTransactions,
  CurseurTransactions,
  FiltresTransactions,
  TransactionListItem,
} from "@/components/transactions/types-transactions";
import type { CategorieUI, SplitUI } from "@/components/ui/category";

// Référentiel fictif (mêmes natures que la démo catégorisation).
const CATEGORIES: CategorieUI[] = [
  { id: "cat-charges", name: "Charges", parentId: null, isActive: true },
  { id: "cat-charges-elec", name: "Électricité", parentId: "cat-charges", isActive: true },
  { id: "cat-charges-loyer", name: "Loyer", parentId: "cat-charges", isActive: true },
  { id: "cat-charges-mat", name: "Matériel", parentId: "cat-charges", isActive: true },
  { id: "cat-income", name: "Revenus", parentId: null, isActive: true },
  { id: "cat-income-clients", name: "Paiements clients", parentId: "cat-income", isActive: true },
];

const COMPTES = [
  { bankAccountId: "acc-mur", nom: "Compte courant MUR" },
  { bankAccountId: "acc-usd", nom: "Compte USD" },
];

// Lignes fictives couvrant tous les cas d'affichage.
const LIGNES: TransactionListItem[] = [
  {
    transactionId: "t1",
    transactionDate: "2026-06-11",
    label: "Beachcomber Resorts",
    compteNom: "Compte courant MUR",
    montantAbs: "10000.00",
    devise: "MUR",
    sens: "Credit",
    bankAccountId: "acc-mur",
    statutCategorisation: "complet",
    categorie: { id: "cat-income-clients", name: "Paiements clients" },
    nbCategories: 1,
  },
  {
    transactionId: "t2",
    transactionDate: "2026-06-10",
    label: "Central Electricity Board",
    compteNom: "Compte courant MUR",
    montantAbs: "8750.50",
    devise: "MUR",
    sens: "Debit",
    bankAccountId: "acc-mur",
    statutCategorisation: "partiel",
    categorie: { id: "cat-charges-elec", name: "Électricité" },
    nbCategories: 1,
  },
  {
    transactionId: "t3",
    transactionDate: "2026-06-09",
    label: "Cim Finance — virement fournisseurs",
    compteNom: "Compte courant MUR",
    montantAbs: "152340.00",
    devise: "MUR",
    sens: "Debit",
    bankAccountId: "acc-mur",
    statutCategorisation: "complet",
    categorie: null,
    nbCategories: 3,
  },
  {
    transactionId: "t4",
    transactionDate: "2026-06-08",
    label: "Stripe payout",
    compteNom: "Compte USD",
    montantAbs: "4200.00",
    devise: "USD",
    sens: "Credit",
    bankAccountId: "acc-usd",
    statutCategorisation: "non_categorise",
    categorie: null,
    nbCategories: 0,
  },
  {
    transactionId: "t5",
    transactionDate: "2026-06-07",
    label: "Loyer bureaux Ebène",
    compteNom: "Compte courant MUR",
    montantAbs: "65000.00",
    devise: "MUR",
    sens: "Debit",
    bankAccountId: "acc-mur",
    statutCategorisation: "complet",
    categorie: { id: "cat-charges-loyer", name: "Loyer" },
    nbCategories: 1,
  },
];

// Splits fictifs renvoyés à l'ouverture de la modale, par transaction.
const SPLITS: Record<string, SplitUI[]> = {
  t1: [
    { id: "s1", categoryId: "cat-income-clients", amount: "10000.00", source: "MANUAL", ruleId: null },
  ],
  t2: [
    { id: "s2", categoryId: "cat-charges-elec", amount: "5000.00", source: "MANUAL", ruleId: null },
  ],
  t3: [
    { id: "s3", categoryId: "cat-charges-mat", amount: "100000.00", source: "MANUAL", ruleId: null },
    { id: "s4", categoryId: "cat-charges-loyer", amount: "40000.00", source: "MANUAL", ruleId: null },
    { id: "s5", categoryId: "cat-charges-elec", amount: "12340.00", source: "MANUAL", ruleId: null },
  ],
};

type Scenario = "liste" | "loading" | "vide" | "erreur";

const SCENARIOS: Array<{ id: Scenario; label: string }> = [
  { id: "liste", label: "Liste peuplée" },
  { id: "loading", label: "Chargement" },
  { id: "vide", label: "Vide" },
  { id: "erreur", label: "Erreur" },
];

export default function TransactionsDemoPage() {
  const [scenario, setScenario] = useState<Scenario>("liste");

  // Actions stub : filtrent la liste fictive en mémoire (pas de réseau).
  const actions: ActionsTransactions = useMemo(
    () => ({
      async listerTransactions(args: {
        curseur?: CurseurTransactions | null;
        filtres?: FiltresTransactions;
      }) {
        const f = args.filtres ?? {};
        const lignes = LIGNES.filter((l) => {
          if (f.bankAccountId && l.bankAccountId !== f.bankAccountId) return false;
          if (f.statutCategorisation && l.statutCategorisation !== f.statutCategorisation)
            return false;
          return true;
        });
        return { ok: true as const, data: { lignes, curseurSuivant: null } };
      },
      async chargerSplits(ref) {
        // Démonstration du garde-fou : la ligne « t5 » simule un échec serveur —
        // chargerSplits LÈVE (comme listerSplitsAction), le conteneur bloque alors
        // l'ouverture de la modale et affiche l'alerte (anti-écrasement).
        if (ref.transactionId === "t5") {
          throw new Error("Échec simulé de chargement des splits (démo).");
        }
        return SPLITS[ref.transactionId] ?? [];
      },
    }),
    [],
  );

  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">TYGR</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Transactions (Pilier 1)
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Page transactions — données fictives, actions inertes (Visual QA).
      </div>

      <main className="mx-auto w-full max-w-5xl px-6 py-8">
        {/* Sélecteur de scénario (les 4 états). */}
        <div
          role="group"
          aria-label="Scénario à prévisualiser"
          className="mb-6 inline-flex gap-1 rounded-control bg-surface-inset p-1"
        >
          {SCENARIOS.map((s) => {
            const actif = s.id === scenario;
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={actif}
                onClick={() => setScenario(s.id)}
                className={
                  actif
                    ? "rounded-[6px] bg-ink px-4 py-1.5 text-sm font-semibold text-text-onink"
                    : "rounded-[6px] px-4 py-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                }
              >
                {s.label}
              </button>
            );
          })}
        </div>

        <div className="mb-6">
          <h1 className="text-xl font-semibold text-text">Transactions</h1>
          <p className="mt-1 text-sm text-text-muted">
            Parcourez, filtrez et catégorisez vos opérations. Cliquez une ligne pour
            ventiler son montant.
          </p>
        </div>

        {scenario === "liste" && (
          <TransactionsFeature
            initial={{ lignes: LIGNES, curseurSuivant: null }}
            categories={CATEGORIES}
            comptes={COMPTES}
            actions={actions}
            remplacerSplits={async () => ({ ok: true, data: undefined })}
            aucuneBanque={false}
          />
        )}

        {scenario === "loading" && <TransactionsLoading />}

        {scenario === "vide" && (
          <EmptyState
            illustration="table"
            title="Aucune transaction pour ces critères"
            message="Aucune opération ne correspond aux filtres sélectionnés, ou la première synchronisation est encore en cours."
          />
        )}

        {scenario === "erreur" && (
          <AppErrorState onRetry={() => setScenario("liste")} />
        )}
      </main>
    </div>
  );
}
