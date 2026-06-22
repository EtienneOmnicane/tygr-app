"use client";

/**
 * Courbe de trésorerie — ANCRE du dashboard (UI_GUIDELINES §4.2). SVG « maison »
 * (décision revue : Tremor incompatible React 19 ; cohérent avec le zéro-
 * dépendance des états). Aire + ligne de position `primary` + axes + tooltip au
 * survol. Hauteur min 380px (§4.2).
 *
 * Présentationnel : reçoit `PointCourbe[]` (chaînes décimales) en props.
 *
 * ⚠️ Frontière float (règle 8) : les montants restent des CHAÎNES pour
 * l'affichage (tooltip, axe Y → `formatMontant`). Le `Number()` interne sert
 * UNIQUEMENT à la GÉOMÉTRIE (position en pixels d'un point) — un cul-de-sac qui
 * ne réinjecte jamais dans un montant affiché. Aucune somme financière ici.
 *
 * État PARTIEL (décision revue) : `points` vide alors que le reste du dashboard
 * a des données (workspace fraîchement connecté, soldes pas encore synchronisés)
 * → message « historique en cours de synchronisation » DANS la carte, pas un
 * dashboard vide. La carte garde sa place (pas de saut de layout).
 */
import { useId, useState } from "react";

import type { PointCourbe } from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { formaterDateComptable } from "@/lib/format-date";
import { StateCard, StateIllustration } from "@/components/dashboard/states/primitives";

// Géométrie du viewBox (unités SVG, mises à l'échelle en %).
const VB_W = 720;
const VB_H = 280;
const PAD_L = 56; // marge axe Y (montants tabular)
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 28; // marge axe X (dates)

/** Convertit une chaîne décimale en number POUR LA GÉOMÉTRIE uniquement. */
function valeurGeo(montant: string): number {
  return Number(montant);
}

export function CashflowMainChart({
  points,
  devise,
}: {
  points: PointCourbe[];
  devise: string;
}) {
  const gradId = useId();
  const [survol, setSurvol] = useState<number | null>(null);

  return (
    <StateCard className="min-h-[380px]">
      {/* En-tête de carte (§4.2 : titre + légende). */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text">
            Position de trésorerie
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Solde consolidé, 90 derniers jours
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span aria-hidden className="h-2 w-2 rounded-full bg-primary" />
          Solde consolidé
        </div>
      </div>

      {points.length === 0 ? (
        <CourbeVide />
      ) : (
        <Trace
          points={points}
          devise={devise}
          gradId={gradId}
          survol={survol}
          setSurvol={setSurvol}
        />
      )}
    </StateCard>
  );
}

/**
 * État PARTIEL : pas d'historique, mais la carte tient sa place. Message
 * neutre (pas une erreur, pas un vide « sec ») : la synchro arrive.
 */
function CourbeVide() {
  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
      <StateIllustration
        variant="empty"
        className="mb-4 h-14 w-14 text-text-faint"
      />
      <p className="text-sm font-medium text-text">
        Historique en cours de synchronisation
      </p>
      <p className="mt-1 max-w-sm text-xs text-text-muted">
        Vos comptes sont connectés. La courbe de trésorerie s’affichera dès que
        les premiers soldes quotidiens seront récupérés.
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
  points: PointCourbe[];
  devise: string;
  gradId: string;
  survol: number | null;
  setSurvol: (i: number | null) => void;
}) {
  // Bornes Y (géométrie). On élargit légèrement pour ne pas coller aux bords.
  const valeurs = points.map((p) => valeurGeo(p.soldeConsolide));
  const min = Math.min(...valeurs);
  const max = Math.max(...valeurs);
  const etendue = max - min || 1; // évite la division par zéro (courbe plate)
  const yMin = min - etendue * 0.1;
  const yMax = max + etendue * 0.1;

  const x = (i: number) =>
    PAD_L +
    (i / Math.max(points.length - 1, 1)) * (VB_W - PAD_L - PAD_R);
  const y = (v: number) =>
    PAD_T + (1 - (v - yMin) / (yMax - yMin)) * (VB_H - PAD_T - PAD_B);

  const ligne = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(valeurGeo(p.soldeConsolide))}`)
    .join(" ");
  const aire =
    `M ${x(0)} ${VB_H - PAD_B} ` +
    points
      .map((p, i) => `L ${x(i)} ${y(valeurGeo(p.soldeConsolide))}`)
      .join(" ") +
    ` L ${x(points.length - 1)} ${VB_H - PAD_B} Z`;

  // 4 graduations Y réparties (affichées via formatMontant, chaînes).
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
        aria-label="Courbe du solde consolidé sur 90 jours"
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

        {/* Aire + ligne de position. */}
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
          <g key={p.date}>
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
                  cy={y(valeurGeo(p.soldeConsolide))}
                  r={4}
                  fill="var(--color-primary)"
                  stroke="var(--color-surface-card)"
                  strokeWidth={2}
                />
              </>
            )}
          </g>
        ))}

        {/* Axe X : première / dernière date (évite l'encombrement). */}
        <text x={PAD_L} y={VB_H - 8} className="fill-text-faint text-[10px]">
          {formaterDateComptable(points[0].date)}
        </text>
        <text
          x={VB_W - PAD_R}
          y={VB_H - 8}
          textAnchor="end"
          className="fill-text-faint text-[10px]"
        >
          {formaterDateComptable(points[points.length - 1].date)}
        </text>
      </svg>

      {/* Tooltip (§4.2) : carte blanche, date + montant tabular. */}
      {pActif && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-control bg-surface-card px-3 py-2 shadow-popover">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {formaterDateComptable(pActif.date)}
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-text">
            {formatMontant(pActif.soldeConsolide, devise)}
          </p>
        </div>
      )}
    </div>
  );
}

/** Format compact pour l'axe Y (géométrie déjà calculée) : 7,7 M / 512 k. */
function compact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} M`;
  if (abs >= 1_000) return `${Math.round(v / 1_000)} k`;
  return `${Math.round(v)}`;
}
