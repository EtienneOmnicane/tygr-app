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
  PointCourbe,
  SyntheseMois,
  TransactionRecente,
} from "@/server/repositories/dashboard";

import { choisirEtatDashboard } from "@/lib/etat-dashboard";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { DashboardEmptyState } from "@/components/dashboard/states";
import { StateCard } from "@/components/dashboard/states/primitives";
import { SidePanelKpi } from "@/components/dashboard/side-panel-kpi";
import { ConnectedAccountsCard } from "@/components/dashboard/connected-accounts-card";
import { CashflowMainChart } from "@/components/dashboard/cashflow-main-chart";
import { TransactionsTable } from "@/components/dashboard/transactions-table";

export interface DonneesDashboard {
  comptes: CompteConnecte[];
  soldeConsolide: string;
  courbe: PointCourbe[];
  syntheseMois: SyntheseMois;
  transactionsRecentes: TransactionRecente[];
}

export function DashboardContent({
  donnees,
  devise = "MUR",
}: {
  donnees: DonneesDashboard;
  /** Devise de base du workspace (MUR au MVP mono-devise). */
  devise?: string;
}) {
  const { comptes, soldeConsolide, courbe, syntheseMois, transactionsRecentes } =
    donnees;

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
  const dateSolde = courbe.length
    ? jourMoisCourt(courbe[courbe.length - 1].date)
    : jourMoisCourt(dernierSync(comptes));

  return (
    <DashboardShell
      aside={
        <>
          <SidePanelKpi
            soldeConsolide={soldeConsolide}
            syntheseMois={syntheseMois}
            devise={devise}
            dateSolde={dateSolde}
          />
          {/* Pile aside : SOLDE → DÉTAILS (SidePanelKpi) → COMPTES CONNECTÉS. */}
          <ConnectedAccountsCard comptes={comptes} />
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {/* Ancre : courbe (gère son propre état partiel si courbe vide). */}
        <CashflowMainChart points={courbe} devise={devise} />

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

/** Dernière date de sync parmi les comptes (fallback pour la méta solde). */
function dernierSync(comptes: CompteConnecte[]): string {
  const dates = comptes
    .map((c) => c.lastSyncedAt)
    .filter((d): d is Date => d != null)
    .sort((a, b) => b.getTime() - a.getTime());
  const d = dates[0] ?? new Date();
  return d.toISOString().slice(0, 10);
}

/** "2026-06-12" → "12/06". Présentationnel. */
function jourMoisCourt(date: string): string {
  const [, mois, jour] = date.split("-");
  return `${jour}/${mois}`;
}
