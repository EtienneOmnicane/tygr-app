"use client";

/**
 * Rendu SVG de la COURBE de flux net mensuel — EXTRAIT verbatim de
 * `cashflow-main-chart.tsx` (L8a) pour être réutilisé par la carte d'ancre unifiée
 * `flux-tresorerie-card.tsx` (toggle Barres/Courbe). La GÉOMÉTRIE est INCHANGÉE
 * (viewBox, paddings, ligne de zéro, graduations, tooltip, zones de survol) : c'est
 * un déplacement, pas une réécriture — aucune régression de dessin attendue.
 *
 * `FluxCourbe` rend UNIQUEMENT le corps du graphe (le `Trace` quand il y a des points,
 * sinon `CourbeVide`) et porte son propre état de survol + `useId` du gradient.
 * L'en-tête de carte (titre + légende) et la `StateCard` vivent dans le conteneur,
 * partagés avec la vue « barres ».
 *
 * ⚠️ Frontière float (règle 8) : les montants restent des CHAÎNES pour l'affichage
 * (tooltip, axe Y → `formatMontant`/`compact`). Le `Number()` interne (`valeurGeo`)
 * sert UNIQUEMENT à la GÉOMÉTRIE (position en pixels) — cul-de-sac qui ne réinjecte
 * jamais dans un montant affiché. Aucune somme financière ici.
 *
 * ⚠️ Le net peut être NÉGATIF : ligne de zéro visible, domaine Y incluant toujours 0.
 */
import { useId, useState } from "react";

import type { PointCashflow } from "@/server/insights/types";

import { formatMontant, estNegatif } from "@/lib/format-montant";
import { formaterMoisAnnee } from "@/lib/format-date";
import { StateIllustration } from "@/components/dashboard/states/primitives";

// Géométrie du viewBox (unités SVG, mises à l'échelle en %).
const VB_W = 720;
const VB_H = 280;
const PAD_L = 56; // marge axe Y (montants tabular)
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 28; // marge axe X (mois)

/** Convertit une chaîne décimale en number POUR LA GÉOMÉTRIE uniquement. */
function valeurGeo(montant: string): number {
  return Number(montant);
}

/**
 * Corps « courbe » de l'ancre Flux. Vide → message neutre (la carte garde sa place) ;
 * sinon → tracé SVG. Le survol est local (îlot client).
 */
export function FluxCourbe({
  points,
  devise,
}: {
  points: PointCashflow[];
  devise: string;
}) {
  const gradId = useId();
  const [survol, setSurvol] = useState<number | null>(null);

  if (points.length === 0) {
    return <CourbeVide />;
  }
  return (
    <Trace
      points={points}
      devise={devise}
      gradId={gradId}
      survol={survol}
      setSurvol={setSurvol}
    />
  );
}

/**
 * État PARTIEL : pas encore de flux sur la période, mais la carte tient sa place.
 * Message neutre (pas une erreur, pas un vide « sec ») : les données arrivent.
 */
function CourbeVide() {
  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
      <StateIllustration
        variant="empty"
        className="mb-4 h-14 w-14 text-text-faint"
      />
      <p className="text-sm font-medium text-text">
        Aucun flux sur la période
      </p>
      <p className="mt-1 max-w-sm text-xs text-text-muted">
        Vos comptes sont connectés. La courbe des flux s’affichera dès que les
        premières transactions seront récupérées.
      </p>
    </div>
  );
}

function Trace({
  points,
  devise,
  gradId,
  survol,
  setSurvol,
}: {
  points: PointCashflow[];
  devise: string;
  gradId: string;
  survol: number | null;
  setSurvol: (i: number | null) => void;
}) {
  // Bornes Y (géométrie). Le domaine inclut TOUJOURS 0 (le net traverse zéro) et
  // s'élargit légèrement pour ne pas coller aux bords.
  const valeurs = points.map((p) => valeurGeo(p.net));
  const min = Math.min(0, ...valeurs);
  const max = Math.max(0, ...valeurs);
  const etendue = max - min || 1; // évite la division par zéro (série plate à 0)
  const yMin = min - etendue * 0.1;
  const yMax = max + etendue * 0.1;

  const x = (i: number) =>
    PAD_L +
    (i / Math.max(points.length - 1, 1)) * (VB_W - PAD_L - PAD_R);
  const y = (v: number) =>
    PAD_T + (1 - (v - yMin) / (yMax - yMin)) * (VB_H - PAD_T - PAD_B);

  // Ligne de référence à 0 (le flux net y est centré).
  const yZero = y(0);

  const ligne = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(valeurGeo(p.net))}`)
    .join(" ");
  // Aire fermée sur la LIGNE DE ZÉRO (pas le bas du graphe) : une aire au-dessus
  // pour les mois excédentaires, en-dessous pour les déficitaires.
  const aire =
    `M ${x(0)} ${yZero} ` +
    points
      .map((p, i) => `L ${x(i)} ${y(valeurGeo(p.net))}`)
      .join(" ") +
    ` L ${x(points.length - 1)} ${yZero} Z`;

  // 4 graduations Y réparties (affichées via compact, géométrie déjà calculée).
  const graduations = [0, 1, 2, 3].map((k) => {
    const v = yMin + (k / 3) * (yMax - yMin);
    return { v, py: y(v) };
  });

  const pActif = survol != null ? points[survol] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="h-[300px] w-full"
        role="img"
        aria-label="Courbe du flux net de trésorerie par mois"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Graduations Y + libellés tabular. */}
        {graduations.map((g, k) => (
          <g key={k}>
            <line
              x1={PAD_L}
              y1={g.py}
              x2={VB_W - PAD_R}
              y2={g.py}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 8}
              y={g.py + 3}
              textAnchor="end"
              className="fill-text-faint text-[10px] tabular-nums"
            >
              {compact(g.v)}
            </text>
          </g>
        ))}

        {/* Ligne de ZÉRO appuyée (référence du flux net, §3.1 neutre). */}
        <line
          x1={PAD_L}
          y1={yZero}
          x2={VB_W - PAD_R}
          y2={yZero}
          stroke="var(--color-line-strong)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />

        {/* Aire + ligne de flux net. */}
        <path d={aire} fill={`url(#${gradId})`} />
        <path
          d={ligne}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {/* Points + zones de survol (toute la colonne, pour un hover facile). */}
        {points.map((p, i) => (
          <g key={p.bucket}>
            <rect
              x={x(i) - (VB_W - PAD_L - PAD_R) / points.length / 2}
              y={PAD_T}
              width={(VB_W - PAD_L - PAD_R) / points.length}
              height={VB_H - PAD_T - PAD_B}
              fill="transparent"
              onMouseEnter={() => setSurvol(i)}
              onMouseLeave={() => setSurvol(null)}
            />
            {survol === i && (
              <>
                <line
                  x1={x(i)}
                  y1={PAD_T}
                  x2={x(i)}
                  y2={VB_H - PAD_B}
                  stroke="var(--color-line-strong)"
                  strokeWidth={1}
                />
                <circle
                  cx={x(i)}
                  cy={y(valeurGeo(p.net))}
                  r={4}
                  fill="var(--color-primary)"
                  stroke="var(--color-surface-card)"
                  strokeWidth={2}
                />
              </>
            )}
          </g>
        ))}

        {/* Axe X : premier / dernier mois (évite l'encombrement). */}
        <text x={PAD_L} y={VB_H - 8} className="fill-text-faint text-[10px]">
          {formaterMoisAnnee(points[0].bucket)}
        </text>
        <text
          x={VB_W - PAD_R}
          y={VB_H - 8}
          textAnchor="end"
          className="fill-text-faint text-[10px]"
        >
          {formaterMoisAnnee(points[points.length - 1].bucket)}
        </text>
      </svg>

      {/* Tooltip (§4.2) : carte blanche, mois + entrées/sorties/net tabular. */}
      {pActif && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-control bg-surface-card px-3 py-2 shadow-popover">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {formaterMoisAnnee(pActif.bucket)}
          </p>
          <dl className="mt-1 flex flex-col gap-0.5">
            <LigneTooltip
              label="Entrées"
              valeur={formatMontant(pActif.entrees, devise, { signeExplicite: true })}
              couleur="text-inflow-700"
            />
            <LigneTooltip
              label="Sorties"
              valeur={formatMontant(pActif.sorties, devise)}
              couleur="text-outflow-700"
            />
            <LigneTooltip
              label="Net"
              valeur={formatMontant(pActif.net, devise, { signeExplicite: true })}
              couleur={estNegatif(pActif.net) ? "text-outflow-700" : "text-text"}
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

/** Format compact pour l'axe Y (géométrie déjà calculée) : 7,7 M / 512 k / −1,2 M. */
function compact(v: number): string {
  const abs = Math.abs(v);
  const signe = v < 0 ? "−" : ""; // U+2212 (vrai signe moins, règle formatage)
  if (abs >= 1_000_000) return `${signe}${(abs / 1_000_000).toFixed(1)} M`;
  if (abs >= 1_000) return `${signe}${Math.round(abs / 1_000)} k`;
  return `${signe}${Math.round(abs)}`;
}
