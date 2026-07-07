/**
 * Assemblage présentationnel du dashboard (UI_GUIDELINES §1.1, refonte Dodo —
 * maquette Dodo.dc.html). Reçoit les sorties des services (ou les fixtures),
 * choisit l'état d'affichage et monte la GRILLE du tableau de bord. PUR : aucune
 * donnée fetchée ici, la page (RSC) résout et passe les props.
 *
 * MISE EN PAGE (refonte Etienne — « plus rangé, plus symétrique ») : on abandonne
 * le side-panel gauche fixe au profit d'une COLONNE PLEINE LARGEUR empilée, calquée
 * sur la maquette :
 *   1. En-tête : titre « Trésorerie » (26px) + sous-titre (période · comptes) ;
 *      à droite, fraîcheur du solde + bouton « Synchroniser ».
 *   2. Rangée KPI « Soldes par devise » horizontale (SoldesDevisesRow), carte de
 *      la devise de base mise en avant (ink).
 *   3. Grille 2fr/1fr : Flux de trésorerie (ancre) + Synthèse du mois côte à côte.
 *   4. Comptes connectés en PLEINE LARGEUR.
 *   5. Features conservées hors maquette (Top contreparties, Évolution mensuelle,
 *      Transactions récentes), empilées pleine largeur dessous.
 *
 * Logique d'états (décisions revue, INCHANGÉE) :
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
import type { WorkspaceRole } from "@/server/db/schema";

import { choisirEtatDashboard } from "@/lib/etat-dashboard";
import { formaterFraicheurRelative } from "@/lib/format-date";
import { DashboardShell } from "@/components/shell/dashboard-shell";
import { DashboardEmptyState } from "@/components/dashboard/states";
import { StateCard } from "@/components/dashboard/states/primitives";
import { SoldesDevisesRow } from "@/components/dashboard/soldes-devises-row";
import { BalanceFreshnessPill } from "@/components/dashboard/balance-freshness-pill";
import { SyncButton } from "@/components/dashboard/sync-button";
import { ConnectedAccountsCard } from "@/components/dashboard/connected-accounts-card";
import { FluxTresorerieCard } from "@/components/dashboard/flux-tresorerie-card";
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
  role,
}: {
  donnees: DonneesDashboard;
  /** Devise de base du workspace (MUR au MVP mono-devise). */
  devise?: string;
  /** Mois courant "YYYY-MM" (Maurice) — libellé des cartes de synthèse. */
  mois: string;
  /** Rôle résolu serveur — gate le bouton « Synchroniser » du side-panel (confort UI). */
  role: WorkspaceRole;
}) {
  const {
    comptes,
    soldesParDevise,
    synthesesMois,
    topVendors,
    serieMensuelle,
    grilleMensuelle,
    transactionsRecentes,
  } = donnees;
  // NB : `donnees.flux` n'est PLUS déstructuré ici — la courbe ne le consomme plus
  // (elle dérive de la série mensuelle projetée, cf. FluxTresorerieCard). Le champ reste
  // néanmoins un discriminant vivant de l'état d'onboarding, lu par `choisirEtatDashboard`
  // (partiel vs complet) via l'objet `donnees` complet ci-dessous.

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

  // Sinon : comptes connectés → dashboard PLEINE LARGEUR (grille maquette). Chaque
  // zone gère son propre vide (PARTIEL) sans masquer le solde déjà disponible.
  // Fraîcheur (§3.7 / DR-F3) : on qualifie l'âge du SOLDE COURANT via la synchro la
  // plus récente (`lastSyncedAt`), JAMAIS via le dernier point de courbe (EOD).
  const synchro = synchroLaPlusRecente(comptes);
  const fraicheur = synchro
    ? formaterFraicheurRelative(synchro.lastSyncedAt)
    : null;
  // Sous-titre maquette : « N derniers mois · N comptes connectés ». Le nombre de
  // mois = longueur de la grille d'axe (nbMois du preset) ; on ne recalcule rien.
  const nbMoisFenetre = grilleMensuelle.length;
  const nbComptes = comptes.length;

  return (
    <DashboardShell>
      <div className="flex flex-col gap-6">
        {/* 1. EN-TÊTE — titre + sous-titre à gauche ; fraîcheur du solde +
            « Synchroniser » à droite (repris de l'ancienne carte SOLDE : on
            rafraîchit là où on lit l'âge de la donnée). Pas de flex-wrap sur le
            titre lui-même ; le cluster droit s'enroule sous lg si nécessaire. */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-text">
              Trésorerie
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              {nbMoisFenetre} dernier{nbMoisFenetre > 1 ? "s" : ""} mois ·{" "}
              {nbComptes} compte{nbComptes > 1 ? "s" : ""} connecté
              {nbComptes > 1 ? "s" : ""}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {fraicheur && (
              <BalanceFreshnessPill
                fraicheur={fraicheur}
                compteLabel={synchro?.compteLabel}
              />
            )}
            <SyncButton role={role} />
          </div>
        </header>

        {/* 2. RANGÉE KPI « Soldes par devise » — horizontale (une carte par devise,
            devise de base en ink). Remplace la carte SOLDE verticale du side-panel. */}
        <SoldesDevisesRow
          soldesParDevise={soldesParDevise}
          comptes={comptes}
          devise={devise}
        />

        {/* 3. GRILLE 2fr / 1fr : Flux de trésorerie (ancre, colonne gauche) + pile
            droite « Synthèse du mois » PUIS « Comptes connectés » (demande Etienne :
            remonter les comptes dans l'espace résiduel à droite de la courbe — la
            Synthèse est plus courte que la courbe, la colonne droite restait creuse).
            lg:grid-cols-3 → col-span-2 (2/3) + col-span-1 (1/3) = 2fr/1fr ; empilé
            sous lg. */}
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-3">
          {/* Ancre : FLUX net mensuel — carte unifiée avec toggle Barres/Courbe (L8a).
              Les deux vues partagent les séries déjà chargées par la page (zéro fetch). */}
          <div className="lg:col-span-2">
            <FluxTresorerieCard
              serieMensuelle={serieMensuelle}
              grilleMensuelle={grilleMensuelle}
              devise={devise}
            />
          </div>
          {/* Colonne droite (1fr) : Synthèse du mois PUIS Comptes connectés, empilés,
              pour occuper la hauteur de la courbe plutôt que de laisser un vide. */}
          <div className="flex flex-col gap-3.5 lg:col-span-1">
            {/* Synthèse du mois (Entrées / Sorties / Variation), VENTILÉE PAR DEVISE. */}
            <CashFlowSummary
              synthesesMois={synthesesMois}
              mois={mois}
              devise={devise}
            />
            {/* Comptes connectés — remontés dans la colonne droite (sortis de la
                pleine largeur) pour combler l'espace à droite de la courbe. La carte
                reste robuste en colonne étroite : libellés `truncate`, montants
                `shrink-0 whitespace-nowrap tabular-nums` (jamais tronqués). */}
            <ConnectedAccountsCard comptes={comptes} />
          </div>
        </div>

        {/* 4. FEATURES CONSERVÉES hors maquette, empilées pleine largeur. */}
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
            <h2 className="mb-2 text-base font-semibold text-text">
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
