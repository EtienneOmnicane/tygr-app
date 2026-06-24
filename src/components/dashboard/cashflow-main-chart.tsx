"use client";

/**
 * Courbe de FLUX de trésorerie — ANCRE du dashboard (UI_GUIDELINES §4.2). SVG
 * « maison » (décision revue : Tremor incompatible React 19 ; cohérent avec le
 * zéro-dépendance des états). Ligne + aire `primary` + ligne de zéro + axes +
 * tooltip au survol. Hauteur min 380px (§4.2).
 *
 * CHANGEMENT DE GRANDEUR (2026-06-24) : on trace désormais le FLUX NET mensuel
 * (entrées − sorties par mois, dérivé de `transactions_cache` via
 * `cashflowParDevise`), PAS le solde consolidé EOD. Raison : `balance_history`
 * est vide en Staging (Omni-FI n'expose pas `/balances/history`, DASH-SOLDE2),
 * donc la courbe de solde restait perpétuellement « en cours de synchronisation »,
 * alors que les flux, eux, existent. Le titre dit « Flux de trésorerie » pour
 * rester honnête sur la grandeur affichée (un net, pas un niveau).
 *
 * Présentationnel : reçoit `PointCashflow[]` (UNE devise — la base_currency, filtrée
 * en amont par la page ; le multi-série est une dette explicite DASH-CASHFLOW-MULTISERIE).
 *
 * ⚠️ Le net peut être NÉGATIF (un mois où les sorties dépassent les entrées) — la
 * courbe de solde ne l'était jamais. On trace donc une LIGNE DE ZÉRO visible et le
 * domaine Y inclut toujours 0. Tooltip = entrées (vert) / sorties (rouge) / net.
 *
 * ⚠️ Frontière float (règle 8) : les montants restent des CHAÎNES pour l'affichage
 * (tooltip, axe Y → `formatMontant`). Le `Number()` interne sert UNIQUEMENT à la
 * GÉOMÉTRIE (position en pixels) — un cul-de-sac qui ne réinjecte jamais dans un
 * montant affiché. Aucune somme financière ici.
 *
 * État PARTIEL (décision revue) : `points` vide alors que le reste du dashboard a
 * des données → message « aucun flux sur la période » DANS la carte, pas un
 * dashboard vide. La carte garde sa place (pas de saut de layout).
 */
import { useId, useState } from "react";

import type { PointCashflow } from "@/server/insights/types";

import { formatMontant, estNegatif } from "@/lib/format-montant";
import { formaterMoisAnnee } from "@/lib/format-date";
import { StateCard, StateIllustration } from "@/components/dashboard/states/primitives";

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

export function CashflowMainChart({
  points,
  devise,
}: {
  points: PointCashflow[];
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
            Flux de trésorerie
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Entrées − sorties par mois
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span aria-hidden className="h-2 w-2 rounded-full bg-primary" />
          Flux net
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
