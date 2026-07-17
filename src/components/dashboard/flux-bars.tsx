"use client";

/**
 * Rendu SVG des BARRES entrées/sorties mensuelles — corps de la carte d'ancre
 * `flux-tresorerie-card.tsx`. La GÉOMÉTRIE du réalisé est INCHANGÉE (ligne de base
 * centrale, entrée vers le haut `inflow`, sortie vers le bas `outflow`, hauteur ∝
 * valeur/max, labels).
 *
 * ## Prévisionnel (C1 — PLAN-conception-previsionnel-C.md §5, UI_GUIDELINES §3.5)
 *
 * L'axe se prolonge vers le FUTUR : les mois qui suivent le mois courant sont alimentés
 * par les ÉCHÉANCES projetées (occurrences récurrentes comprises), jamais par des
 * transactions. Les deux séries ne sont JAMAIS additionnées en un chiffre — elles
 * arrivent séparées (`ColonneFlux`) et se rendent séparément :
 *
 *  - **Mois passés** : réalisé seul, opacité 100 %.
 *  - **Mois courant (colonne PIVOT, D2)** : réalisé à date (100 %) + échéances restantes
 *    du mois (45 %) EMPILÉES sur la même colonne — c'est le comportement FYGR.
 *  - **Mois futurs** : prévision seule (45 %) sur fond `surface-forecast`.
 *
 * Le basculement réalisé→prévisionnel porte TOUJOURS deux signaux (§3.5, accessibilité) :
 * fond/opacité ET label — jamais la couleur seule. Pour un lecteur d'écran, ni l'opacité
 * ni le fond ne sont perceptibles : l'`aria-label` annonce donc explicitement la projection.
 *
 * ⚠️ La projection (`projeterSurGrille`/`maxFenetre*`/`composerColonnes`) vit dans
 * `flux-projection.ts` (`.ts` neutre, SANS `"use client"`) car `monthly-cashflow.tsx` — un
 * Server Component — l'appelle ; une fonction d'un module client ne peut pas être invoquée
 * depuis le serveur (fix C2). Ce fichier-ci reste client (JSX/SVG des barres).
 *
 * ⚠️ Multi-devises (règle 8) : MONO-AFFICHÉ sur la devise de BASE ; aucune addition
 * cross-devise, aucune conversion FX — pour les échéances comme pour le réalisé.
 */
import { useState } from "react";

import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

import { formaterMoisCourt, formaterMoisAnnee } from "@/lib/format-date";
import { formatMontant, estNegatif } from "@/lib/format-montant";
import {
  composerColonnes,
  maxFenetreColonnes,
  projeterSurGrille,
  type ColonneFlux,
  type MoisAffiche,
  type PrevisionFlux,
} from "@/components/dashboard/flux-projection";
import { echelleNice } from "@/components/dashboard/echelle-nice";
import { HAUTEUR_ANCRE } from "@/components/dashboard/flux-layout";
import { useDimensionsSvg } from "@/components/dashboard/use-dimensions-svg";

/** Opacité des barres PRÉVISIONNELLES (§3.5 : réalisé 100 % → prévisionnel 45 %). */
const OPACITE_PREVISION = 0.45;

/**
 * Corps « barres » de l'ancre Flux : projette la série sur la grille, compose l'axe
 * (réalisé + prévision) puis rend les barres. Vide → message neutre, la carte garde sa place.
 */
export function FluxBarres({
  serie,
  grille,
  prevision,
  devise,
  libellePeriode,
}: {
  serie: SyntheseMensuelle[];
  grille: string[];
  /**
   * Zone prévisionnelle résolue par la page (`null` = aucune : fenêtre qui n'atteint pas
   * le mois courant, ou workspace sans échéance). Composant PUR : il ne décide pas si la
   * prévision s'applique, il rend ce qu'on lui donne.
   */
  prevision?: PrevisionFlux | null;
  devise: string;
  /**
   * Libellé de la fenêtre appliquée (source unique : la page) — porté par l'`aria-label`
   * du graphe. ⚠️ Sous une PLAGE précise, « N derniers mois » serait FAUX : c'est la seule
   * chose qu'un lecteur d'écran entend de la fenêtre (TOOLBAR-DATE-PRECISE1).
   */
  libellePeriode?: string;
}) {
  const realises = projeterSurGrille(serie, grille, devise);
  const colonnes = composerColonnes(
    realises,
    prevision?.moisFuturs ?? [],
    prevision?.moisCourant ?? null,
  );

  // Le max BRUT pilote la détection « aucun mouvement » (0 = fenêtre vide) ; le max
  // « nice » (toujours ≥ 1, jamais 0) sert UNIQUEMENT à l'échelle du rendu des barres
  // non-vides — sans cette séparation, une fenêtre vide afficherait des barres à
  // plat au lieu du message neutre (echelleNice(0) = 1 ≠ 0).
  //
  // ⚠️ Il court sur les COLONNES, pas sur le seul réalisé : un workspace neuf SANS
  // transactions mais AVEC des échéances saisies doit voir sa prévision, pas « Aucun
  // mouvement » (défaut n°1 du plan §5.2). L'échelle englobe donc aussi la prévision —
  // sinon une grosse échéance future déborderait de la zone traçable (défaut n°2).
  const maxBrut = maxFenetreColonnes(colonnes);
  const aucunMouvement = maxBrut === 0;
  const max = echelleNice(maxBrut);
  const ilExisteAutresDevises = colonnes.some(
    (c) => c.realise?.autresDevises || c.prevision?.autresDevises,
  );

  if (aucunMouvement) {
    return (
      <div
        className="flex flex-col items-center justify-center text-center"
        style={{ minHeight: HAUTEUR_ANCRE }}
      >
        <p className="text-sm font-medium text-text">
          Aucun mouvement sur la période
        </p>
        <p className="mt-1 max-w-sm text-xs text-text-muted">
          Les entrées et sorties s’afficheront ici dès les premières transactions
          synchronisées.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ minHeight: HAUTEUR_ANCRE }}>
      {/* Le SVG remplit la hauteur disponible (flex-1) ET la largeur (w-full) :
          les barres ne sont plus « perdues » dans du vide (C1) et s'étalent sur
          toute la largeur de la carte (C2). */}
      <BarresMensuelles
        colonnes={colonnes}
        max={max}
        devise={devise}
        libellePeriode={libellePeriode}
      />
      {/* Note multi-devises : présente dès qu'un mois porte une autre devise — RÉALISÉE
          ou PROJETÉE (une échéance en USD n'est pas plus additionnable qu'une transaction). */}
      {ilExisteAutresDevises && (
        <p className="mt-3 text-[11px] text-text-faint">
          Certains mois comportent aussi des mouvements ou des échéances dans d’autres
          devises, non additionnés ici (affichage en {devise}).
        </p>
      )}
    </div>
  );
}

// Géométrie des barres. Le viewBox est en px RÉELS (mesurés) → 1 unité = 1 px, donc
// AUCUNE déformation (cohérent avec la courbe). Dimensions de repli avant la 1re
// mesure (SSR / 1er paint), ratio plausible d'une carte d'ancre.
const LARGEUR_DEFAUT = 640;
const HAUTEUR_DEFAUT = 380;
const BANDE_LABELS = 22; // px réservés sous l'axe pour les libellés de mois
// Bande ÉLARGIE quand la colonne pivot porte son sous-label « Réalisé à date » (§3.5) :
// il lui faut une SECONDE ligne sous le libellé de mois, sinon les deux se superposent.
const BANDE_LABELS_PIVOT = 38;
const FRACTION_BARRE = 0.5; // largeur d'une barre = 50 % de sa colonne (reste = gap)
const LARGEUR_BARRE_MAX = 40; // px — plafond : sur peu de mois (colonnes larges) une
// barre à 50 % deviendrait un gros bloc (« graphe cassé »). On la borne pour qu'elle
// reste lisible et centrée. Sur « Tout » (colonnes étroites) le plafond ne mord pas.
const MAX_LABELS = 8; // densité max de labels d'axe X (C3 : 1 label sur N au-delà)

/**
 * Barres empilées par mois : entrée (inflow) vers le haut, sortie (outflow) vers le
 * bas, à partir d'une ligne de base centrale. Hauteur ∝ montant / max de la fenêtre.
 * SVG inline (zéro dépendance — Tremor incompatible React 19).
 *
 * REMPLISSAGE (C1+C2) : le SVG fait `w-full` et porte `HAUTEUR_ANCRE`, et son viewBox
 * suit la taille RÉELLE mesurée (`useDimensionsSvg`). La hauteur d'une demi-bande et
 * la largeur des colonnes sont donc DÉRIVÉES de l'espace réel (plus de plafond 64px
 * en dur, plus de scroll horizontal) : les barres occupent toute la carte sans être
 * déformées (1 unité = 1 px). `parseFloat` ne sert QU'À la hauteur (géométrie),
 * jamais à un montant affiché (frontière float, règle 8).
 */
function BarresMensuelles({
  colonnes,
  max,
  devise,
  libellePeriode,
}: {
  colonnes: ColonneFlux[];
  max: number;
  devise: string;
  /** Libellé de la fenêtre appliquée — seule description de la période pour un lecteur d'écran. */
  libellePeriode?: string;
}) {
  const { ref, largeur, hauteur } = useDimensionsSvg(
    LARGEUR_DEFAUT,
    HAUTEUR_DEFAUT,
  );

  // Index de la colonne survolée (îlot client). `null` = aucun survol → pas de tooltip.
  const [survol, setSurvol] = useState<number | null>(null);
  const colonneActive = survol != null ? colonnes[survol] : null;

  // FRONTIÈRE réalisé / prévisionnel. Le PIVOT est la colonne qui porte les DEUX (le mois
  // courant, D2) ; tout ce qui suit le premier mois sans réalisé est purement projeté.
  // Calculé AVANT la géométrie : la présence du pivot élargit la bande de labels.
  const idxPivot = colonnes.findIndex((c) => c.realise !== null && c.prevision !== null);
  const premierFutur = colonnes.findIndex((c) => c.realise === null);
  const ilExistePrevision = colonnes.some((c) => c.prevision !== null);

  // Zone des barres = hauteur totale moins la bande de labels ; l'axe zéro est au
  // centre de cette zone (entrées au-dessus, sorties en dessous). `hauteurDemi`
  // borné ≥ 0 par sécurité (cartes très basses).
  const bandeLabels = idxPivot >= 0 ? BANDE_LABELS_PIVOT : BANDE_LABELS;
  const hauteurDemi = Math.max((hauteur - bandeLabels) / 2, 0);
  const yAxe = hauteurDemi;

  // Une colonne par mois ; la barre occupe `FRACTION_BARRE` de sa colonne, centrée
  // (le reste fait l'espace inter-barres), MAIS bornée à `LARGEUR_BARRE_MAX` pour ne
  // pas devenir un bloc sur peu de mois (colonnes larges). Le `cx` ci-dessous lit
  // cette largeur EFFECTIVE (plafonnée) → la barre reste centrée dans sa colonne.
  // Garde-fou `colonnes.length` (jamais 0 ici : l'appelant a déjà filtré
  // `aucunMouvement`, mais on ne divise pas par zéro).
  const pas = colonnes.length > 0 ? largeur / colonnes.length : largeur;
  const largeurBarre = Math.min(pas * FRACTION_BARRE, LARGEUR_BARRE_MAX);

  // C3 — densité des labels : au-delà de MAX_LABELS mois, on n'affiche qu'un label
  // sur `pasLabel`, régulièrement espacé, en garantissant TOUJOURS le premier (i=0)
  // et le dernier (lisibilité des bornes de la fenêtre).
  //
  // ⚠️ La zone prévisionnelle ALLONGE l'axe → le pas des labels grossit (défaut n°3 du
  // plan §5.2) : sur 6 mois + 3 projetés, il passe de 1 à 2 et le PIVOT perd son libellé.
  // Or c'est la colonne la plus lourde de sens — « Réalisé à date » y pointerait un mois
  // anonyme. Le pivot est donc garanti au même titre que les bornes (constat de Visual QA).
  const pasLabel = Math.max(1, Math.ceil(colonnes.length / MAX_LABELS));
  const dernier = colonnes.length - 1;

  // Hauteur de la zone traçable (hors bande de labels) — sert au bandeau de survol
  // qui met en évidence la colonne active sur toute la hauteur des barres.
  const hauteurZone = Math.max(hauteur - bandeLabels, 0);

  const xFrontiere = premierFutur >= 0 ? premierFutur * pas : null;
  // Ligne des libellés de mois : remontée d'un cran quand le pivot porte son sous-label.
  const yLabelMois = hauteur - (idxPivot >= 0 ? 20 : 6);

  const hauteurDe = (montant: string | undefined) =>
    max > 0 && montant !== undefined
      ? (Math.abs(parseFloat(montant)) / max) * hauteurDemi
      : 0;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${largeur} ${hauteur}`}
        className="w-full"
        style={{ height: HAUTEUR_ANCRE }}
        role="img"
        // Deux signaux visuels (fond + opacité) ne s'entendent PAS : la projection doit
        // être ANNONCÉE, sinon un lecteur d'écran lit du prévisionnel comme du réalisé (§3.5).
        aria-label={
          ilExistePrevision
            ? `Entrées et sorties — ${libellePeriode ?? `${colonnes.length} derniers mois`}, en ${devise}. Inclut une projection des échéances à venir sur les mois suivants.`
            : `Entrées et sorties — ${libellePeriode ?? `${colonnes.length} derniers mois`}, en ${devise}`
        }
      >
        {/* ZONE PRÉVISIONNELLE (§3.5) : fond `surface-forecast` continu sur les colonnes
            PUREMENT projetées. Le mois pivot en est EXCLU — il est majoritairement réalisé ;
            un fond continu sur toute sa colonne dirait « tout est prévision », ce qui serait
            faux. Sa part projetée se signale par l'opacité + le sous-label « Réalisé à date ». */}
        {xFrontiere !== null && (
          <rect
            x={xFrontiere}
            y={0}
            width={largeur - xFrontiere}
            height={hauteurZone}
            fill="var(--color-surface-forecast)"
          />
        )}
        {/* Bandeau de mise en évidence de la colonne survolée (chrome neutre, jamais une
            couleur de donnée). Rendu AVANT l'axe et les barres → il reste en arrière-plan.
            ⚠️ `line-strong` et NON `surface-inset` (#f0ecdf) : ce dernier est à 2 unités RGB
            de `surface-forecast` (#efebdd) — indistinguable. Depuis que la zone
            prévisionnelle existe, il produisait DEUX faux signaux (constat de Visual QA) :
            survoler un mois PASSÉ le peignait comme du prévisionnel, et dans la zone
            prévisionnelle le survol devenait invisible. `line-strong` se détache des deux
            fonds (blanc et forecast) sans emprunter de couleur sémantique. */}
        {survol != null && (
          <rect
            x={survol * pas}
            y={0}
            width={pas}
            height={hauteurZone}
            fill="var(--color-line-strong)"
            fillOpacity={0.5}
          />
        )}
        {/* Ligne de base (axe zéro). Couleur en var() inline : convention SVG du
            projet — les utilitaires fill-/stroke- custom ne sont pas employés pour
            les traits ici. */}
        <line
          x1={0}
          y1={yAxe}
          x2={largeur}
          y2={yAxe}
          stroke="var(--color-line)"
          strokeWidth={1}
        />
        {/* Séparateur « aujourd'hui » (§3.5) : pointillé 1px `line-strong` sur toute la
            hauteur, posé à la frontière — à partir d'ici, plus aucun montant n'est réalisé.
            Il ne tombe PAS au jour près : la granularité de l'axe est le mois, et le mois
            courant est à cheval (son sous-label « Réalisé à date » dit où l'on en est). */}
        {xFrontiere !== null && (
          <line
            x1={xFrontiere}
            y1={0}
            x2={xFrontiere}
            y2={hauteurZone}
            stroke="var(--color-line-strong)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {colonnes.map((c, i) => {
          const cx = i * pas + (pas - largeurBarre) / 2;
          const hEntreeR = hauteurDe(c.realise?.entrees);
          const hSortieR = hauteurDe(c.realise?.sorties);
          const hEntreeP = hauteurDe(c.prevision?.entrees);
          const hSortieP = hauteurDe(c.prevision?.sorties);
          const labelVisible = i % pasLabel === 0 || i === dernier || i === idxPivot;
          return (
            <g key={c.libelleMois}>
              {/* Entrée RÉALISÉE (au-dessus de l'axe) — vert `inflow` (donnée, §3.1) */}
              <rect
                x={cx}
                y={yAxe - hEntreeR}
                width={largeurBarre}
                height={hEntreeR}
                rx={2}
                fill="var(--color-inflow)"
              />
              {/* Sortie RÉALISÉE (en dessous de l'axe) — rouge `outflow` (donnée, §3.1) */}
              <rect
                x={cx}
                y={yAxe}
                width={largeurBarre}
                height={hSortieR}
                rx={2}
                fill="var(--color-outflow)"
              />
              {/* Parts PROJETÉES — EMPILÉES au-delà du réalisé (D2). Sur un mois futur
                  `hEntreeR`/`hSortieR` valent 0 : la même formule les fait partir de l'axe.
                  Même teinte sémantique que le réalisé (une sortie reste une sortie) mais à
                  45 % : c'est l'opacité, jamais une couleur inventée, qui porte le statut. */}
              <rect
                x={cx}
                y={yAxe - hEntreeR - hEntreeP}
                width={largeurBarre}
                height={hEntreeP}
                rx={2}
                fill="var(--color-inflow)"
                fillOpacity={OPACITE_PREVISION}
              />
              <rect
                x={cx}
                y={yAxe + hSortieR}
                width={largeurBarre}
                height={hSortieP}
                rx={2}
                fill="var(--color-outflow)"
                fillOpacity={OPACITE_PREVISION}
              />
              {/* Label du mois sous l'axe (densité bornée, C3). « Juin 26 » : le mois
                  court + l'année 2 chiffres lève l'ambiguïté entre années. Le détail
                  complet reste dans le tableau « Évolution mensuelle ». */}
              {labelVisible && (
                <text
                  x={cx + largeurBarre / 2}
                  y={yLabelMois}
                  textAnchor="middle"
                  fill={
                    c.realise === null
                      ? "var(--color-text-faint)"
                      : "var(--color-text-muted)"
                  }
                  className="text-[11px]"
                >
                  {formaterMoisCourt(c.libelleMois)}
                </text>
              )}
              {/* Sous-label de la colonne PIVOT (§3.5) — le second signal, TEXTUEL, du
                  basculement : ce mois n'est réalisé que jusqu'à aujourd'hui, le reste de
                  sa barre est projeté. Rendu DANS le SVG, en unités de viewBox : le SVG
                  est étiré (`w-full`), donc un positionnement en px CSS se décalerait de
                  tout le facteur d'échelle (constat de Visual QA). */}
              {i === idxPivot && (
                <text
                  x={cx + largeurBarre / 2}
                  y={hauteur - 6}
                  textAnchor="middle"
                  fill="var(--color-primary)"
                  className="text-[11px] italic"
                >
                  Réalisé à date
                </text>
              )}
            </g>
          );
        })}
        {/* Zones de HIT : une par colonne, PLEINE largeur/hauteur et transparentes,
            posées en DERNIER (au-dessus des barres) pour capter le survol partout
            dans la colonne — pas seulement sur la barre étroite. */}
        {colonnes.map((c, i) => (
          <rect
            key={`hit-${c.libelleMois}`}
            x={i * pas}
            y={0}
            width={pas}
            height={hauteurZone}
            fill="transparent"
            onMouseEnter={() => setSurvol(i)}
            onMouseLeave={() => setSurvol(null)}
          />
        ))}
      </svg>

      {/* Tooltip (§4.2) : carte blanche, mois + entrées/sorties/net tabular. Centré
          en haut (même patron que l'ancienne courbe), inerte au pointeur. */}
      {colonneActive && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-control bg-surface-card px-3 py-2 shadow-popover">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {formaterMoisAnnee(colonneActive.libelleMois)}
          </p>
          {/* Un chiffre projeté ne doit JAMAIS se lire comme du réalisé au survol
              (défaut n°5 du plan §5.2) : chaque bloc est ÉTIQUETÉ dès que les deux
              coexistent, et la zone prévisionnelle porte toujours sa mention. */}
          {colonneActive.realise && (
            <BlocTooltip
              titre={colonneActive.prevision ? "Réalisé à date" : null}
              mois={colonneActive.realise}
              devise={devise}
            />
          )}
          {colonneActive.prevision && (
            <BlocTooltip
              titre="Prévision"
              mois={colonneActive.prevision}
              devise={devise}
              attenue
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Un bloc du tooltip : entrées / sorties / net d'UNE série (réalisé ou prévision).
 * `titre` est optionnel — sur un mois passé, il n'y a rien à distinguer.
 */
function BlocTooltip({
  titre,
  mois,
  devise,
  attenue = false,
}: {
  titre: string | null;
  mois: MoisAffiche;
  devise: string;
  /** Bloc prévisionnel : libellés en `text-faint` (§3.5 — le prévisionnel s'atténue). */
  attenue?: boolean;
}) {
  return (
    <div className={attenue ? "mt-2 border-t border-line pt-2" : "mt-1"}>
      {titre && (
        <p
          className={`mb-0.5 text-[11px] ${attenue ? "italic text-text-faint" : "text-primary"}`}
        >
          {titre}
        </p>
      )}
      <dl className="flex flex-col gap-0.5">
        <LigneTooltip
          label="Entrées"
          valeur={formatMontant(mois.entrees, devise, { signeExplicite: true })}
          couleur="text-inflow-700"
        />
        <LigneTooltip
          label="Sorties"
          valeur={formatMontant(mois.sorties, devise)}
          couleur="text-outflow-700"
        />
        <LigneTooltip
          label="Net"
          valeur={formatMontant(mois.variation, devise, { signeExplicite: true })}
          couleur={estNegatif(mois.variation) ? "text-outflow-700" : "text-text"}
        />
      </dl>
    </div>
  );
}

/** Une rangée du tooltip : libellé discret + montant tabular coloré. */
function LigneTooltip({
  label,
  valeur,
  couleur,
}: {
  label: string;
  valeur: string;
  couleur: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-[11px] text-text-muted">{label}</dt>
      <dd className={`text-sm font-semibold tabular-nums ${couleur}`}>{valeur}</dd>
    </div>
  );
}
