/**
 * Assemblage présentationnel du dashboard (UI_GUIDELINES §1.1). Reçoit les
 * sorties des 5 services (ou les fixtures), choisit l'état d'affichage et monte
 * shell + side-panel KPI + courbe (ancre) + table. PUR : aucune donnée fetchée
 * ici, la page (RSC) résout et passe les props.
 *
 * Logique d'états (décisions revue) :
 *   - AUCUN compte connecté            → empty GLOBAL (DashboardEmptyState).
 *   - Comptes présents, données vides  → PARTIEL par section : la courbe affiche
 *     « historique en cours de synchro », la table son propre vide ; les KPI/
 *     solde restent visibles. (Pas d'empty global qui masquerait le solde.)
 *   - Données présentes                → dashboard complet.
 * L'état loading (loading.tsx natif) et error (error.tsx) vivent au niveau route.
 */
import type {
  CompteConnecte,
  SoldeParDevise,
  SyntheseMensuelle,
  SyntheseMoisDevise,
  TransactionRecente,
} from "@/server/repositories/dashboard";
import type {
  ConcentrationVendors,
  PointCashflow,
} from "@/server/insights/types";

import { choisirEtatDashboard } from "@/lib/etat-dashboard";
import { formaterFraicheurRelative } from "@/lib/format-date";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { DashboardEmptyState } from "@/components/dashboard/states";
import { StateCard } from "@/components/dashboard/states/primitives";
import { SidePanelKpi } from "@/components/dashboard/side-panel-kpi";
import { ConnectedAccountsCard } from "@/components/dashboard/connected-accounts-card";
import { CashflowMainChart } from "@/components/dashboard/cashflow-main-chart";
import { CashFlowSummary } from "@/components/dashboard/cash-flow-summary";
import { TopVendorsCard } from "@/components/dashboard/top-vendors-card";
import { MonthlyCashflow } from "@/components/dashboard/monthly-cashflow";
import { TransactionsTable } from "@/components/dashboard/transactions-table";

export interface DonneesDashboard {
  comptes: CompteConnecte[];
  /** Solde Total = soldes courants par devise (une ligne par devise, jamais d'addition cross-devise). */
  soldesParDevise: SoldeParDevise[];
  /** Flux net mensuel (entrées − sorties), UNE devise (base_currency), dérivé des transactions. */
  flux: PointCashflow[];
  /** Synthèse du mois courant VENTILÉE PAR DEVISE (jamais d'addition cross-devise). */
  synthesesMois: SyntheseMoisDevise[];
  /** Concentration des contreparties (top postes, par défaut dépenses). */
  topVendors: ConcentrationVendors;
  /** Série entrées/sorties des N derniers mois (tendance), à plat par (mois, devise). */
  serieMensuelle: SyntheseMensuelle[];
  /** Mois attendus de la série (axe continu, du plus ancien au plus récent). */
  grilleMensuelle: string[];
  transactionsRecentes: TransactionRecente[];
}

export function DashboardContent({
  donnees,
  devise = "MUR",
  mois,
}: {
  donnees: DonneesDashboard;
  /** Devise de base du workspace (MUR au MVP mono-devise). */
  devise?: string;
  /** Mois courant "YYYY-MM" (Maurice) — libellé des cartes de synthèse. */
  mois: string;
}) {
  const {
    comptes,
    soldesParDevise,
    flux,
    synthesesMois,
    topVendors,
    serieMensuelle,
    grilleMensuelle,
    transactionsRecentes,
  } = donnees;

  // EMPTY GLOBAL : aucun compte → rien à montrer, CTA de connexion.
  // (état "vide" ; "partiel"/"complet" montent le shell ci-dessous — chaque zone
  // gère son propre vide. Logique testée : choisirEtatDashboard.)
  if (choisirEtatDashboard(donnees) === "vide") {
    return (
      <DashboardShell>
        <DashboardEmptyState />
      </DashboardShell>
    );
  }

  // Sinon : comptes connectés → on monte le shell complet. Chaque zone gère son
  // propre vide (PARTIEL) sans masquer le solde déjà disponible.
  // Fraîcheur (§3.7 / DR-F3) : on qualifie l'âge du SOLDE COURANT via la synchro la
  // plus récente (`lastSyncedAt`), JAMAIS via le dernier point de courbe (EOD).
  const synchro = synchroLaPlusRecente(comptes);
  const fraicheur = synchro
    ? formaterFraicheurRelative(synchro.lastSyncedAt)
    : null;

  return (
    <DashboardShell
      aside={
        <>
          <SidePanelKpi
            soldesParDevise={soldesParDevise}
            synthesesMois={synthesesMois}
            mois={mois}
            devise={devise}
            fraicheur={fraicheur}
            compteLabel={synchro?.compteLabel}
          />
          {/* Pile aside : SOLDE → DÉTAILS (SidePanelKpi) → COMPTES CONNECTÉS. */}
          <ConnectedAccountsCard comptes={comptes} />
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {/* Ancre : courbe de FLUX net mensuel (gère son propre état partiel si vide). */}
        <CashflowMainChart points={flux} devise={devise} />

        {/* Vision Entrées / Sorties du mois (demande métier), VENTILÉE PAR DEVISE —
            au-dessus de la table. */}
        <CashFlowSummary
          synthesesMois={synthesesMois}
          mois={mois}
          devise={devise}
        />

        {/* Top contreparties (concentration des postes, dérivé de la Voie A). */}
        <TopVendorsCard concentration={topVendors} />

        {/* Tendance : entrées/sorties des N derniers mois (barres + tableau). */}
        <MonthlyCashflow
          serie={serieMensuelle}
          grille={grilleMensuelle}
          devise={devise}
        />

        {/* Table : vide par section si pas encore de transactions. */}
        {transactionsRecentes.length > 0 ? (
          <TransactionsTable
            transactions={transactionsRecentes}
            devise={devise}
          />
        ) : (
          <StateCard>
            <h2 className="mb-2 text-sm font-semibold text-text">
              Transactions récentes
            </h2>
            <p className="text-sm text-text-muted">
              Aucune transaction synchronisée pour l’instant. Elles
              s’afficheront ici dès la première récupération.
            </p>
          </StateCard>
        )}
      </div>
    </DashboardShell>
  );
}

/**
 * Compte dont la synchro est la plus récente (pour la fraîcheur du solde §3.7).
 * Retourne la `Date` BRUTE de `lastSyncedAt` (pas une chaîne : le calcul de delta
 * vit dans `formaterFraicheurRelative`) + un label lisible pour le tooltip.
 * `null` si aucun compte n'a jamais été synchronisé.
 */
function synchroLaPlusRecente(
  comptes: CompteConnecte[],
): { lastSyncedAt: Date; compteLabel: string } | null {
  const synchronises = comptes.filter(
    (c): c is CompteConnecte & { lastSyncedAt: Date } => c.lastSyncedAt != null,
  );
  if (synchronises.length === 0) return null;
  const recent = synchronises.reduce((a, b) =>
    b.lastSyncedAt.getTime() > a.lastSyncedAt.getTime() ? b : a,
  );
  return {
    lastSyncedAt: recent.lastSyncedAt,
    compteLabel: recent.institutionName ?? recent.accountName,
  };
}
