"use client";

/**
 * Démo / Visual QA de la page /transactions (Pilier 1 — liste + ventilation).
 * NON destinée à la production : données FICTIVES, actions STUB (aucun fetch, aucune
 * DB, aucune auth). Sert à capturer hors auth/DB (Quality Gate 4) :
 *  - densité §2.2 (py-14/px-16, ~44px, PAS de zébrage, séparateurs `line`),
 *  - alignement `tabular-nums` des montants à droite,
 *  - couleur sémantique des montants (Credit vert / Debit rouge) UNIQUEMENT,
 *  - badges de catégorie SANS vert/rouge ; « partiel » en ambre,
 *  - libellé : CASCADE marchand → catégorie FR → brut bancaire (italique atténué) →
 *    repli « Opération bancaire » (arbitrage produit 2026-06-23). t1/t5 = marchand ;
 *    t3 = catégorie (niveau 2, sous-texte catégorie MASQUÉ par anti-doublon) ; t6 =
 *    brut bancaire (niveau 3) ; le brut alimente TOUJOURS l'infobulle `title` au survol,
 *  - catégorie OBIE de la banque en sous-texte (DISTINCTE du statut de ventilation ;
 *    masquée quand elle EST déjà le libellé principal — anti-doublon),
 *  - INDICES DE FIABILITÉ AMONT (TECH-API-TRACE) : badge ambre « À vérifier » (Low +
 *    catégorie posée) et icône de SOURCE (⚙ règle / 🤖 ML) + infobulle. Les cas C1-C6
 *    ci-dessous couvrent la matrice pour la QA visuelle anti-chevauchement (desktop+mobile) :
 *      C1 t7  = Low + catégorie + ML_FALLBACK  → badge « À vérifier » + 🤖
 *      C2 t4  = Low SANS catégorie             → AUCUN badge (→ « Non catégorisé »), aucune icône
 *      C3 t1  = High + USER_RULE               → pas de badge, ⚙ seul
 *      C4 t2  = Medium + SYSTEM_RULE           → pas de badge, ⚙ seul
 *      C5 t5  = null / null                    → IDENTIQUE à avant (non-régression)
 *      C6 t8  = Low + cat + ML, libellés LONGS → tous indices SANS chevauchement (R1/R3)
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

// Lignes fictives couvrant tous les cas d'affichage.
const LIGNES: TransactionListItem[] = [
  {
    // Niveau 1 : marchand enrichi. Le brut bancaire reste accessible au survol (title).
    transactionId: "t1",
    transactionDate: "2026-06-11",
    label: "Beachcomber Resorts",
    cleanLabel: "Beachcomber Resorts",
    bankLabelRaw: "CRDT / TRF / BEACHCOMBER RESORTS LTD INV-4471",
    categorieBanque: "Revenus",
    compteNom: "Compte courant MUR",
    montantAbs: "10000.00",
    devise: "MUR",
    sens: "Credit",
    bankAccountId: "acc-mur",
    statutCategorisation: "complet",
    categorie: { id: "cat-income-clients", name: "Paiements clients" },
    nbCategories: 1,
    // C3 : fiabilité haute + règle Omni-FI → pas de badge, ⚙ seul.
    niveauFiabilite: "High",
    sourceClassification: "USER_RULE",
  },
  {
    transactionId: "t2",
    transactionDate: "2026-06-10",
    label: "Central Electricity Board",
    cleanLabel: "Central Electricity Board",
    bankLabelRaw: null,
    categorieBanque: "Charges",
    compteNom: "Compte courant MUR",
    montantAbs: "8750.50",
    devise: "MUR",
    sens: "Debit",
    bankAccountId: "acc-mur",
    statutCategorisation: "partiel",
    categorie: { id: "cat-charges-elec", name: "Électricité" },
    nbCategories: 1,
    // C4 : fiabilité moyenne + règle système → pas de badge, ⚙ seul. Coexiste avec
    // l'indice « partiel » de ventilation (deux ambres distincts, concepts A et B).
    niveauFiabilite: "Medium",
    sourceClassification: "SYSTEM_RULE",
  },
  {
    // Niveau 2 : PAS de marchand, mais catégorie banque présente → le libellé principal
    // EST la catégorie (« Charges »), et son sous-texte catégorie est MASQUÉ (anti-
    // doublon). Le brut reste lisible au survol (title).
    transactionId: "t3",
    transactionDate: "2026-06-09",
    label: "Charges",
    cleanLabel: null,
    bankLabelRaw: "DBIT / POS / BLUEMARBLE SUPERMARKET QBNS",
    categorieBanque: "Charges",
    compteNom: "Compte courant MUR",
    montantAbs: "152340.00",
    devise: "MUR",
    sens: "Debit",
    bankAccountId: "acc-mur",
    statutCategorisation: "complet",
    categorie: null,
    nbCategories: 3,
    // Multi-catégories + ML moyen : pas de badge « À vérifier », ⚙ modèle. Vérifie que
    // la pastille « 3 catégories » et l'icône coexistent sans gêne.
    niveauFiabilite: "Medium",
    sourceClassification: "ML_FALLBACK",
  },
  {
    // Marchand présent MAIS catégorie banque absente → pas de sous-texte catégorie.
    transactionId: "t4",
    transactionDate: "2026-06-08",
    label: "Stripe payout",
    cleanLabel: "Stripe payout",
    bankLabelRaw: null,
    categorieBanque: null,
    compteNom: "Compte USD",
    montantAbs: "4200.00",
    devise: "USD",
    sens: "Credit",
    bankAccountId: "acc-usd",
    statutCategorisation: "non_categorise",
    categorie: null,
    nbCategories: 0,
    // C2 : « Low » mais SANS catégorie posée (défaut serializer). La règle anti-bruit
    // n'affiche PAS « À vérifier » → la ligne reste « Non catégorisé ». Source absente.
    niveauFiabilite: "Low",
    sourceClassification: null,
  },
  {
    transactionId: "t5",
    transactionDate: "2026-06-07",
    label: "Loyer bureaux Ebène",
    cleanLabel: "Loyer bureaux Ebène",
    bankLabelRaw: "DBIT / SO / RENT EBENE OFFICE 06-2026",
    categorieBanque: "Loyer",
    compteNom: "Compte courant MUR",
    montantAbs: "65000.00",
    devise: "MUR",
    sens: "Debit",
    bankAccountId: "acc-mur",
    statutCategorisation: "complet",
    categorie: { id: "cat-charges-loyer", name: "Loyer" },
    nbCategories: 1,
    // C5 : aucune métadonnée de fiabilité remontée → AUCUN indice. La ligne doit être
    // pixel-identique à l'avant-fonctionnalité (non-régression visuelle).
    niveauFiabilite: null,
    sourceClassification: null,
  },
  {
    // Niveau 3 : NI marchand NI catégorie cartographiée → ultime filet = libellé brut
    // bancaire, en `text-muted` italique (se lit comme un repli). Sous-texte : compte
    // seul (pas de catégorie). Le title reprend ce même brut.
    transactionId: "t6",
    transactionDate: "2026-06-06",
    label: "DBIT / ATM / WDL PORT LOUIS WATERFRONT",
    cleanLabel: null,
    bankLabelRaw: "DBIT / ATM / WDL PORT LOUIS WATERFRONT",
    categorieBanque: null,
    compteNom: "Compte courant MUR",
    montantAbs: "3000.00",
    devise: "MUR",
    sens: "Debit",
    bankAccountId: "acc-mur",
    statutCategorisation: "non_categorise",
    categorie: null,
    nbCategories: 0,
    // Repli brut, sans métadonnées : aucun indice.
    niveauFiabilite: null,
    sourceClassification: null,
  },
  {
    // C1 : LE cas cible — fiabilité « Low » + catégorie posée + source ML.
    // → badge ambre « À vérifier » DANS la colonne Statut + 🤖 en fin de sous-texte.
    transactionId: "t7",
    transactionDate: "2026-06-05",
    label: "Amazon EU",
    cleanLabel: "Amazon EU",
    bankLabelRaw: "DBIT / POS / AMZN MKTPLACE LU",
    categorieBanque: "Achats en ligne",
    compteNom: "Compte USD",
    montantAbs: "1299.90",
    devise: "USD",
    sens: "Debit",
    bankAccountId: "acc-usd",
    statutCategorisation: "non_categorise",
    categorie: null,
    nbCategories: 0,
    niveauFiabilite: "Low",
    sourceClassification: "ML_FALLBACK",
  },
  {
    // C6 : cas de STRESS anti-chevauchement — marchand long + nom de compte long +
    // badge « À vérifier » + icône ML, à inspecter en mobile (375px) et desktop.
    transactionId: "t8",
    transactionDate: "2026-06-04",
    label: "Mauritius Commercial Bank Trade Finance Settlement",
    cleanLabel: "Mauritius Commercial Bank Trade Finance Settlement",
    bankLabelRaw: "DBIT / TRF / MCB TRADE FINANCE SETTLEMENT REF-99812",
    categorieBanque: "Frais bancaires",
    compteNom: "Compte Courant Principal Multi-Devises EUR",
    montantAbs: "284530.75",
    devise: "EUR",
    sens: "Debit",
    bankAccountId: "acc-orphelin",
    statutCategorisation: "partiel",
    categorie: { id: "cat-charges-mat", name: "Matériel" },
    nbCategories: 1,
    niveauFiabilite: "Low",
    sourceClassification: "ML_FALLBACK",
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
        <span className="text-lg font-bold tracking-tight">Dodo</span>
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
