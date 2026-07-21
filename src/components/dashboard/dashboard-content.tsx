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
 * Logique d'états (décisions revue) :
 *   - AUCUN compte connecté            → empty GLOBAL (DashboardEmptyState).
 *   - AUCUN compte VISIBLE, mais le tenant a une connexion et le lecteur est borné
 *                                      → hors périmètre (DashboardHorsPerimetreState).
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
import {
  DashboardEmptyState,
  DashboardHorsPerimetreState,
} from "@/components/dashboard/states";
import { StateCard } from "@/components/dashboard/states/primitives";
import { SoldesDevisesRow } from "@/components/dashboard/soldes-devises-row";
import { BalanceFreshnessPill } from "@/components/dashboard/balance-freshness-pill";
import { SyncButton } from "@/components/dashboard/sync-button";
import { SynchroProvider } from "@/components/sync/sync-contexte";
import { SyncSummaryConnecte } from "@/components/sync/sync-summary-connecte";
import { NudgePremiereSynchroConnecte } from "@/components/sync/nudge-premiere-synchro-connecte";
import { ConsommerDrapeauConnexion } from "@/components/sync/consommer-drapeau-connexion";
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
  /**
   * Le TENANT porte-t-il au moins une connexion bancaire ? (NUDGE-VISION-ENTITE1)
   * Booléen DÉRIVÉ serveur d'un COUNT sur `bank_connections` — jamais un compte, jamais
   * un identifiant : l'UI n'a pas à savoir combien ni lesquelles. Sert uniquement à ne
   * plus confondre « cet espace n'a aucune banque » avec « ses comptes ne me sont pas
   * accessibles ».
   */
  aDesConnexionsTenant: boolean;
  /**
   * Le périmètre du LECTEUR est-il borné (Vision Entité ou droit par compte) ?
   * Résolu serveur depuis `ctx.entityScope`/`ctx.accountScope`, JAMAIS un paramètre
   * client. Indispensable en plus du drapeau ci-dessus : une connexion peut exister
   * avec zéro compte pour des raisons étrangères au périmètre, et l'état
   * « hors périmètre » mentirait alors à un lecteur non borné (cf. `etat-dashboard.ts`).
   */
  lecteurBorne: boolean;
}

export function DashboardContent({
  donnees,
  devise = "MUR",
  libellePeriode,
  syntheseTitre,
  syntheseLibelle,
  role,
  connexionEtablie = false,
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
  /**
   * L'utilisateur ARRIVE d'un parcours de connexion réussi (`?connexion=etablie`, posé
   * par la redirection du widget). Arme le nudge « lancez une première synchronisation ».
   *
   * ⚠️ C'est un signal d'ARRIVÉE, pas un état du workspace : il ne se déduit NI de
   * `comptes`, NI de `flux` (tous deux filtrés par période/devise — cf. docstring de
   * `NudgePremiereSynchro`). Ne pas « l'améliorer » en le dérivant des données.
   */
  connexionEtablie?: boolean;
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

  // ÉTATS SANS COMPTE VISIBLE — "vide" et "hors-perimetre" partagent `comptes = []`
  // mais racontent deux histoires opposées : l'un dit « rien n'est connecté », l'autre
  // « c'est connecté, mais pas pour vous ». Les confondre faisait NIER à un membre scopé
  // une banque que /banques lui montre (NUDGE-VISION-ENTITE1). Logique testée :
  // choisirEtatDashboard. "partiel"/"complet" montent le shell ci-dessous — chaque zone
  // gère alors son propre vide.
  //
  // `switch` exhaustif et non chaîne de `if` : la garde `never` du défaut fait ÉCHOUER LE
  // TYPECHECK si un état futur n'est pas traité. Avec un `if`, un état non couvert
  // laisserait monter le dashboard complet sur `comptes = []` — en-tête « 0 compte
  // connecté », aucune pastille de fraîcheur, cartes vides : un écran dégradé SILENCIEUX,
  // sans erreur pour le signaler.
  const etat = choisirEtatDashboard(donnees);
  switch (etat) {
    case "vide":
    case "hors-perimetre":
      return (
        <DashboardShell>
          {/* Le jeton se consomme MÊME ICI, où l'invite ne monte pas. Sans ça il
              survivait dans l'URL, et `periode-switcher` le RECOPIE à chaque changement
              de période (il ne retire que du/au/periode) : le drapeau se propageait donc
              indéfiniment et pouvait réarmer l'invite bien plus tard, une fois les comptes
              devenus visibles. Un jeton d'arrivée se consomme à l'arrivée — pas seulement
              quand on a quelque chose à en faire. */}
          {connexionEtablie && <ConsommerDrapeauConnexion />}
          {/* Pas de nudge « lancez une première synchronisation » ici, y compris sous
              `connexionEtablie` : une synchro ne peut pas rendre visibles des comptes
              hors périmètre (ils resteraient non assignés). L'invite pointerait un geste
              voué à l'échec — la contradiction serait déplacée, pas supprimée. Le geste
              utile appartient à un administrateur, c'est ce que dit l'état. */}
          {etat === "hors-perimetre" ? (
            <DashboardHorsPerimetreState />
          ) : (
            <DashboardEmptyState />
          )}
        </DashboardShell>
      );
    case "partiel":
    case "complet":
      break;
    default: {
      const jamais: never = etat;
      throw new Error(`État dashboard non traité : ${String(jamais)}`);
    }
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
        {/* 1. EN-TÊTE — titre + sous-titre à gauche, CLUSTER STATUT+ACTION à droite.
            PAS de `flex-wrap` (CLAUDE.md § Intégration UI : on CONDENSE sous le
            breakpoint, on n'enroule jamais un header). La condensation se fait par
            `min-w-0` + `truncate` sur le bloc de titre — seuls des LIBELLÉS tronquent,
            jamais un chiffre — et `shrink-0` sur le cluster, qui reste toujours
            atteignable.

            La pastille de fraîcheur est REVENUE ici (retour Etienne 2026-07-20) :
            « quand la donnée date-t-elle ? » et « rafraîchir » sont le même objet
            mental, et ils étaient aux deux coins opposés de l'écran — la pastille sous
            le titre, le bouton en haut à droite. Regroupés, ils se lisent d'un seul
            regard, et le compte rendu ci-dessous n'a plus à porter de socle permanent :
            il ne montre que ce qui est nouveau. Le séparateur reste décoratif
            (`aria-hidden`) : c'est la proximité qui fait le groupe, pas le trait. */}
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
          <div className="flex shrink-0 items-center gap-3">
            {fraicheur && (
              <>
                <BalanceFreshnessPill
                  fraicheur={fraicheur}
                  compteLabel={synchro?.compteLabel}
                  // Décision produit inchangée : la réparation ne s'amorce pas depuis la
                  // pastille — sur le Dashboard elle vit dans les callouts du compte
                  // rendu, qui portent le geste avec son contexte.
                  ctaReconnexion={false}
                />
                <span aria-hidden className="h-4 w-px bg-line-strong" />
              </>
            )}
            <SyncButton role={role} />
          </div>
        </header>

        {/* 1bis. NUDGE POST-CONNEXION — l'utilisateur vient de relier une banque : ses
            COMPTES sont là (le solde s'affiche), ses TRANSACTIONS non (la finalisation
            n'en importe aucune). Sans cette invite, il découvre un graphe vide sans
            savoir que le geste suivant lui appartient. S'efface dès la première synchro
            (cf. `NudgePremiereSynchroConnecte`) pour ne jamais contredire le compte
            rendu ci-dessous. */}
        {connexionEtablie && <NudgePremiereSynchroConnecte role={role} />}

        {/* 1ter. COMPTE RENDU DE SYNCHRO — transitoire par construction : notice de
            succès FERMABLE (résultat du dernier clic) + callouts d'avertissement qui
            durent tant que leur condition tient. Ne monte rien quand il n'a rien à
            dire, pour que soldes et graphe remontent. */}
        <SyncSummaryConnecte role={role} />

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
