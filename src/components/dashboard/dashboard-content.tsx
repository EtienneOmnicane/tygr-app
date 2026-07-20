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
 *   3. Flux de trésorerie — ANCRE PLEINE LARGEUR (UI_GUIDELINES §6.1/§6.7 : une seule
 *      ancre par écran ; sans KPI contextuel à droite, on passe pleine largeur).
 *   4. Synthèse du mois en BANDEAU horizontal sous le graphe (Entrées | Sorties |
 *      Variation en mono-devise ; repli empilé par devise en multi-devise).
 *   5. Features conservées hors maquette (Top contreparties, Évolution mensuelle,
 *      Transactions récentes), empilées pleine largeur dessous.
 *
 * Logique d'états (décisions revue, INCHANGÉE) :
 *   - AUCUN compte connecté            → empty GLOBAL (DashboardEmptyState).
 *   - Comptes présents, données vides  → PARTIEL par section : le graphe de flux
 *     affiche son propre vide, la table le sien ; les KPI/solde restent visibles.
 *     (Pas d'empty global qui masquerait le solde.)
 *   - Données présentes                → dashboard complet.
 * L'état loading (loading.tsx natif) et error (error.tsx) vivent au niveau route.
 */
import type {
  CompteConnecte,
  SoldeParDevise,
  SyntheseMensuelle,
  SynthesePeriodeDevise,
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
import { SyncButton } from "@/components/dashboard/sync-button";
import { SynchroProvider } from "@/components/sync/sync-contexte";
import { SyncSummaryConnecte } from "@/components/sync/sync-summary-connecte";
import { FluxTresorerieCard } from "@/components/dashboard/flux-tresorerie-card";
import type { PrevisionFlux } from "@/components/dashboard/flux-projection";
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
  synthesesMois: SynthesePeriodeDevise[];
  /** Concentration des contreparties (top postes, par défaut dépenses). */
  topVendors: ConcentrationVendors;
  /** Série entrées/sorties des N derniers mois (tendance), à plat par (mois, devise). */
  serieMensuelle: SyntheseMensuelle[];
  /** Mois attendus de la série (axe continu, du plus ancien au plus récent). */
  grilleMensuelle: string[];
  /**
   * Zone PRÉVISIONNELLE (C1) — échéances projetées, occurrences récurrentes comprises.
   * `null` = pas de zone prévision (fenêtre qui n'atteint pas le mois courant, D4, ou
   * workspace sans aucune échéance) : l'axe reste alors exactement celui d'aujourd'hui.
   * Jamais additionnée au réalisé : deux sources, deux séries, deux rendus (§3.5).
   */
  prevision: PrevisionFlux | null;
  transactionsRecentes: TransactionRecente[];
}

export function DashboardContent({
  donnees,
  devise = "MUR",
  libellePeriode,
  syntheseTitre,
  syntheseLibelle,
  role,
}: {
  donnees: DonneesDashboard;
  /** Devise de base du workspace (MUR au MVP mono-devise). */
  devise?: string;
  /**
   * Libellé de la FENÊTRE réellement appliquée, calculé par la page (SOURCE UNIQUE) :
   * « 6 derniers mois » sous preset, « 3 mars → 17 avr. 2026 » sous plage précise
   * (`?du`/`?au`). ⚠️ Ne PAS le recomposer ici depuis `grilleMensuelle.length` : sous une
   * plage passée (janvier→mars consultée en juin), « 3 derniers mois » serait FAUX — c'est
   * le mensonge d'affichage que le lot TOOLBAR-DATE-PRECISE1 combat.
   */
  libellePeriode: string;
  /** Titre de la carte de synthèse : « Synthèse du mois » ou « Synthèse de la période ». */
  syntheseTitre: string;
  /** Ce que la carte de synthèse agrège vraiment : « Juin 2026 » ou l'intervalle réel. */
  syntheseLibelle: string;
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
    prevision,
    transactionsRecentes,
  } = donnees;
  // NB : `donnees.flux` n'est PLUS déstructuré ici — le graphe ne le consomme plus
  // (il dérive de la série mensuelle projetée, cf. FluxTresorerieCard). Le champ reste
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
  // Sous-titre maquette : « <période> · N comptes connectés ». Le libellé de période vient
  // de la PAGE (source unique — il doit dire la fenêtre RÉELLEMENT appliquée, preset ou
  // plage précise) ; on ne le recalcule surtout pas depuis la grille d'axe.
  const nbComptes = comptes.length;

  return (
    <DashboardShell>
      <SynchroProvider>
        <div className="flex flex-col gap-6">
        {/* 1. EN-TÊTE — titre + sous-titre à gauche, « Synchroniser » à droite.
            PAS de `flex-wrap` (CLAUDE.md § Intégration UI : on CONDENSE sous le
            breakpoint, on n'enroule jamais un header). La condensation se fait par
            `min-w-0` + `truncate` sur le bloc de titre — seuls des LIBELLÉS tronquent,
            jamais un chiffre — et `shrink-0` sur l'action, qui reste toujours atteignable.
            La pastille de fraîcheur a quitté ce cluster : elle porte désormais la ligne
            d'état de `SyncSummary` ci-dessous, là où se lit le résultat de la synchro
            (la dupliquer aux deux endroits n'aurait rien dit de plus). */}
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-text">
              Trésorerie
            </h1>
            <p className="mt-1 truncate text-sm text-text-muted">
              {libellePeriode} · {nbComptes} compte{nbComptes > 1 ? "s" : ""} connecté
              {nbComptes > 1 ? "s" : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <SyncButton role={role} />
          </div>
        </header>

        {/* 1bis. COMPTE RENDU DE SYNCHRO — ligne d'état (pastille de fraîcheur +
            résultat serveur) puis callouts actionnables. Aligné à gauche, largeur
            bornée. Monté en permanence pour que le bloc ne s'effondre pas entre deux
            synchros (sinon toute la grille ci-dessous saute à chaque clic). */}
        <SyncSummaryConnecte
          fraicheur={fraicheur}
          compteLabel={synchro?.compteLabel}
          role={role}
        />

        {/* 2. RANGÉE KPI « Soldes par devise » — horizontale (une carte par devise,
            devise de base en ink). Remplace la carte SOLDE verticale du side-panel. */}
        <SoldesDevisesRow
          soldesParDevise={soldesParDevise}
          comptes={comptes}
          devise={devise}
        />

        {/* 3. FLUX DE TRÉSORERIE — ancre PLEINE LARGEUR (UI_GUIDELINES §6.1/§6.7 : une
            seule ancre par écran ; pas de KPI contextuel à droite → pleine largeur).
            `FluxBarres` mesure son SVG (ResizeObserver) → s'élargit seul. Zéro fetch. */}
        <FluxTresorerieCard
          serieMensuelle={serieMensuelle}
          grilleMensuelle={grilleMensuelle}
          prevision={prevision}
          devise={devise}
          libellePeriode={libellePeriode}
        />

        {/* 4. SYNTHÈSE DU MOIS — bandeau horizontal sous le graphe (remplace l'ancienne
            pile droite Synthèse + Comptes connectés, cette dernière retirée du dashboard).
            `disposition="bandeau"` : mono-devise → 3 colonnes Entrées | Sorties | Variation
            (comble l'espace, pas de creux) ; multi-devise → repli empilé PAR DEVISE
            (jamais d'addition cross-devise, règle 8). */}
        <CashFlowSummary
          synthesesMois={synthesesMois}
          titre={syntheseTitre}
          libelle={syntheseLibelle}
          devise={devise}
          disposition="bandeau"
        />

        {/* 5. FEATURES CONSERVÉES hors maquette, empilées pleine largeur. */}
        {/* Top contreparties (concentration des postes, dérivé de la Voie A),
            fenêtrées sur la MÊME période que la courbe (FB0709-TOPVENDORS5) —
            le libellé reprend la formulation du sous-titre d'en-tête. */}
        <TopVendorsCard concentration={topVendors} libellePeriode={libellePeriode} />

        {/* Tendance : entrées/sorties sur la fenêtre appliquée (barres + tableau). Sous
            plage, les mois d'extrémité sont PARTIELS — d'où le libellé explicite. */}
        <MonthlyCashflow
          serie={serieMensuelle}
          grille={grilleMensuelle}
          devise={devise}
          libellePeriode={libellePeriode}
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
      </SynchroProvider>
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
