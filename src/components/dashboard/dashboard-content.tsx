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
  SoldeParDevise,
  SyntheseMois,
  TransactionRecente,
} from "@/server/repositories/dashboard";

import { choisirEtatDashboard } from "@/lib/etat-dashboard";
import { formaterFraicheurRelative } from "@/lib/format-date";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { DashboardEmptyState } from "@/components/dashboard/states";
import { StateCard } from "@/components/dashboard/states/primitives";
import { SidePanelKpi } from "@/components/dashboard/side-panel-kpi";
import { ConnectedAccountsCard } from "@/components/dashboard/connected-accounts-card";
import { CashflowMainChart } from "@/components/dashboard/cashflow-main-chart";
import { CashFlowSummary } from "@/components/dashboard/cash-flow-summary";
import { TransactionsTable } from "@/components/dashboard/transactions-table";

export interface DonneesDashboard {
  comptes: CompteConnecte[];
  /** Solde Total = soldes courants par devise (une ligne par devise, jamais d'addition cross-devise). */
  soldesParDevise: SoldeParDevise[];
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
  const { comptes, soldesParDevise, courbe, syntheseMois, transactionsRecentes } =
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
            syntheseMois={syntheseMois}
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
        {/* Ancre : courbe (gère son propre état partiel si courbe vide). */}
        <CashflowMainChart points={courbe} devise={devise} />

        {/* Vision Entrées / Sorties du mois (demande métier) — au-dessus de la
            table, dans la devise de base (cf. note multidevise du composant). */}
        <CashFlowSummary syntheseMois={syntheseMois} devise={devise} />

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
