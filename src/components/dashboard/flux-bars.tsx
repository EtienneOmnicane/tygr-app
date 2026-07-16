"use client";

/**
 * Rendu SVG des BARRES entrées/sorties mensuelles — EXTRAIT verbatim de
 * `monthly-cashflow.tsx` (L8a) pour être réutilisé par la carte d'ancre
 * `flux-tresorerie-card.tsx`. La GÉOMÉTRIE des barres est INCHANGÉE (ligne de base
 * centrale, entrée vers le haut `inflow`, sortie vers le bas `outflow`, hauteur ∝
 * valeur/max, labels) : déplacement, pas réécriture.
 *
 * `FluxBarres` rend UNIQUEMENT le corps (barres ou message « pas de mouvement »).
 * Le tableau récapitulatif mensuel RESTE dans `monthly-cashflow.tsx` (carte
 * « Évolution mensuelle »), qui réutilise `projeterSurGrille` (module NEUTRE
 * `flux-projection.ts`, importé ici aussi) pour ne pas dupliquer la projection.
 *
 * Survol (îlot client) : chaque colonne porte une zone de HIT pleine hauteur ; au
 * survol, un tooltip (§4.2, carte blanche) détaille le mois — Entrées / Sorties /
 * Net — via `formatMontant` (source unique, `tabular-nums`, jamais de float). Design
 * REPRIS verbatim de l'ancien tooltip de la courbe pour garder le même langage visuel.
 *
 * ⚠️ La projection (`projeterSurGrille`/`maxFenetre`/`MoisAffiche`) vit dans
 * `flux-projection.ts` (`.ts` neutre, SANS `"use client"`) car `monthly-cashflow.tsx`
 * — un Server Component — l'appelle ; une fonction d'un module client ne peut pas être
 * invoquée depuis le serveur (fix C2). Ce fichier-ci reste client (JSX/SVG des barres).
 *
 * ⚠️ Multi-devises (règle 8) : MONO-AFFICHÉ sur la devise de BASE ; aucune addition
 * cross-devise, aucune conversion FX.
 */
import { useState } from "react";

import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

import { formaterMoisCourt, formaterMoisAnnee } from "@/lib/format-date";
import { formatMontant, estNegatif } from "@/lib/format-montant";
import {
  maxFenetre,
  projeterSurGrille,
  type MoisAffiche,
} from "@/components/dashboard/flux-projection";
import { echelleNice } from "@/components/dashboard/echelle-nice";
import { HAUTEUR_ANCRE } from "@/components/dashboard/flux-layout";
import { useDimensionsSvg } from "@/components/dashboard/use-dimensions-svg";

/**
 * Corps « barres » de l'ancre Flux : projette la série sur la grille puis rend les
 * barres empilées. Vide (aucun mouvement sur la fenêtre dans la devise de base) →
 * message neutre, la carte garde sa place.
 */
export function FluxBarres({
  serie,
  grille,
  devise,
  libellePeriode,
}: {
  serie: SyntheseMensuelle[];
  grille: string[];
  devise: string;
  /**
   * Libellé de la fenêtre appliquée (source unique : la page) — porté par l'`aria-label`
   * du graphe. ⚠️ Sous une PLAGE précise, « N derniers mois » serait FAUX : c'est la seule
   * chose qu'un lecteur d'écran entend de la fenêtre (TOOLBAR-DATE-PRECISE1).
   */
  libellePeriode?: string;
}) {
  const mois = projeterSurGrille(serie, grille, devise);
  // Le max BRUT pilote la détection « aucun mouvement » (0 = fenêtre vide) ; le max
  // « nice » (toujours ≥ 1, jamais 0) sert UNIQUEMENT à l'échelle du rendu des barres
  // non-vides — sans cette séparation, une fenêtre vide afficherait des barres à
  // plat au lieu du message neutre (echelleNice(0) = 1 ≠ 0).
  const maxBrut = maxFenetre(mois);
  const aucunMouvement = maxBrut === 0;
  const max = echelleNice(maxBrut);
  const ilExisteAutresDevises = mois.some((m) => m.autresDevises);

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
        mois={mois}
        max={max}
        devise={devise}
        libellePeriode={libellePeriode}
      />
      {/* Note multi-devises : présente dès qu'un mois porte une autre devise. */}
      {ilExisteAutresDevises && (
        <p className="mt-3 text-[11px] text-text-faint">
          Certains mois comportent aussi des mouvements dans d’autres devises, non
          additionnés ici (affichage en {devise}).
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
  mois,
  max,
  devise,
  libellePeriode,
}: {
  mois: MoisAffiche[];
  max: number;
  devise: string;
  /** Libellé de la fenêtre appliquée — seule description de la période pour un lecteur d'écran. */
  libellePeriode?: string;
}) {
  const { ref, largeur, hauteur } = useDimensionsSvg(
    LARGEUR_DEFAUT,
    HAUTEUR_DEFAUT,
  );

  // Index du mois survolé (îlot client). `null` = aucun survol → pas de tooltip.
  const [survol, setSurvol] = useState<number | null>(null);
  const moisActif = survol != null ? mois[survol] : null;

  // Zone des barres = hauteur totale moins la bande de labels ; l'axe zéro est au
  // centre de cette zone (entrées au-dessus, sorties en dessous). `hauteurDemi`
  // borné ≥ 0 par sécurité (cartes très basses).
  const hauteurDemi = Math.max((hauteur - BANDE_LABELS) / 2, 0);
  const yAxe = hauteurDemi;

  // Une colonne par mois ; la barre occupe `FRACTION_BARRE` de sa colonne, centrée
  // (le reste fait l'espace inter-barres), MAIS bornée à `LARGEUR_BARRE_MAX` pour ne
  // pas devenir un bloc sur peu de mois (colonnes larges). Le `cx` ci-dessous lit
  // cette largeur EFFECTIVE (plafonnée) → la barre reste centrée dans sa colonne.
  // Garde-fou `mois.length` (jamais 0 ici : l'appelant a déjà filtré `aucunMouvement`,
  // mais on ne divise pas par zéro).
  const pas = mois.length > 0 ? largeur / mois.length : largeur;
  const largeurBarre = Math.min(pas * FRACTION_BARRE, LARGEUR_BARRE_MAX);

  // C3 — densité des labels : au-delà de MAX_LABELS mois, on n'affiche qu'un label
  // sur `pasLabel`, régulièrement espacé, en garantissant TOUJOURS le premier (i=0)
  // et le dernier (lisibilité des bornes de la fenêtre).
  const pasLabel = Math.max(1, Math.ceil(mois.length / MAX_LABELS));
  const dernier = mois.length - 1;

  // Hauteur de la zone traçable (hors bande de labels) — sert au bandeau de survol
  // qui met en évidence la colonne active sur toute la hauteur des barres.
  const hauteurZone = Math.max(hauteur - BANDE_LABELS, 0);

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${largeur} ${hauteur}`}
        className="w-full"
        style={{ height: HAUTEUR_ANCRE }}
        role="img"
        aria-label={`Entrées et sorties — ${libellePeriode ?? `${mois.length} derniers mois`}, en ${devise}`}
      >
        {/* Bandeau de mise en évidence de la colonne survolée (chrome neutre :
            `surface-inset`, jamais une couleur de donnée). Rendu AVANT l'axe et les
            barres → il reste en arrière-plan. */}
        {survol != null && (
          <rect
            x={survol * pas}
            y={0}
            width={pas}
            height={hauteurZone}
            fill="var(--color-surface-inset)"
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
        {mois.map((m, i) => {
          const cx = i * pas + (pas - largeurBarre) / 2;
          const hEntree =
            max > 0 ? (Math.abs(parseFloat(m.entrees)) / max) * hauteurDemi : 0;
          const hSortie =
            max > 0 ? (Math.abs(parseFloat(m.sorties)) / max) * hauteurDemi : 0;
          const labelVisible = i % pasLabel === 0 || i === dernier;
          return (
            <g key={m.libelleMois}>
              {/* Entrée (au-dessus de l'axe) — vert `inflow` (donnée, §3.1) */}
              <rect
                x={cx}
                y={yAxe - hEntree}
                width={largeurBarre}
                height={hEntree}
                rx={2}
                fill="var(--color-inflow)"
              />
              {/* Sortie (en dessous de l'axe) — rouge `outflow` (donnée, §3.1) */}
              <rect
                x={cx}
                y={yAxe}
                width={largeurBarre}
                height={hSortie}
                rx={2}
                fill="var(--color-outflow)"
              />
              {/* Label du mois sous l'axe (densité bornée, C3). « Juin 26 » : le mois
                  court + l'année 2 chiffres lève l'ambiguïté entre années. Le détail
                  complet reste dans le tableau « Évolution mensuelle ». */}
              {labelVisible && (
                <text
                  x={cx + largeurBarre / 2}
                  y={hauteur - 6}
                  textAnchor="middle"
                  fill="var(--color-text-muted)"
                  className="text-[11px]"
                >
                  {formaterMoisCourt(m.libelleMois)}
                </text>
              )}
            </g>
          );
        })}
        {/* Zones de HIT : une par colonne, PLEINE largeur/hauteur et transparentes,
            posées en DERNIER (au-dessus des barres) pour capter le survol partout
            dans la colonne — pas seulement sur la barre étroite. */}
        {mois.map((m, i) => (
          <rect
            key={`hit-${m.libelleMois}`}
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
      {moisActif && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-control bg-surface-card px-3 py-2 shadow-popover">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {formaterMoisAnnee(moisActif.libelleMois)}
          </p>
          <dl className="mt-1 flex flex-col gap-0.5">
            <LigneTooltip
              label="Entrées"
              valeur={formatMontant(moisActif.entrees, devise, {
                signeExplicite: true,
              })}
              couleur="text-inflow-700"
            />
            <LigneTooltip
              label="Sorties"
              valeur={formatMontant(moisActif.sorties, devise)}
              couleur="text-outflow-700"
            />
            <LigneTooltip
              label="Net"
              valeur={formatMontant(moisActif.variation, devise, {
                signeExplicite: true,
              })}
              couleur={estNegatif(moisActif.variation) ? "text-outflow-700" : "text-text"}
            />
          </dl>
        </div>
      )}
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
