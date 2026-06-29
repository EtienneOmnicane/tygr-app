"use client";

/**
 * Rendu SVG des BARRES entrées/sorties mensuelles — EXTRAIT verbatim de
 * `monthly-cashflow.tsx` (L8a) pour être réutilisé par la carte d'ancre unifiée
 * `flux-tresorerie-card.tsx` (toggle Barres/Courbe). La GÉOMÉTRIE des barres est
 * INCHANGÉE (ligne de base centrale, entrée vers le haut `inflow`, sortie vers le
 * bas `outflow`, hauteur ∝ valeur/max, labels) : déplacement, pas réécriture.
 *
 * `FluxBarres` rend UNIQUEMENT le corps (barres ou message « pas de mouvement »).
 * Le tableau récapitulatif mensuel RESTE dans `monthly-cashflow.tsx` (carte
 * « Évolution mensuelle »), qui réutilise `projeterSurGrille`/`maxFenetre` exportés
 * ici pour ne pas dupliquer la logique de projection.
 *
 * ⚠️ Multi-devises (règle 8) : MONO-AFFICHÉ sur la devise de BASE ; aucune addition
 * cross-devise, aucune conversion FX. Un mois qui n'a que d'autres devises reste à 0.
 * `parseFloat` n'est utilisé QUE pour l'ÉCHELLE (hauteur de barre) — JAMAIS pour un
 * montant affiché (les montants passent par `formatMontant` sur la chaîne, côté tableau).
 */
import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

import { formaterMoisAnnee } from "@/lib/format-date";

/** Une cellule mensuelle réduite à la devise de base (ce que la carte affiche). */
export interface MoisAffiche {
  libelleMois: string;
  entrees: string; // chaîne décimale, devise de base (ou "0")
  sorties: string; // chaîne décimale, devise de base (ou "0")
  variation: string; // chaîne décimale, devise de base (ou "0")
  /** Vrai si le mois porte des flux dans une devise ≠ base (signalé, jamais sommé). */
  autresDevises: boolean;
}

/**
 * Projette la série à plat (mois × devise) sur la GRILLE des mois attendus, réduite
 * à la devise de base. La grille garantit l'axe continu (un mois sans aucune
 * transaction apparaît à 0). Un mois qui n'a que d'autres devises reste à 0 + drapeau
 * `autresDevises` (on n'affiche jamais le montant d'une autre devise à la place).
 */
export function projeterSurGrille(
  serie: SyntheseMensuelle[],
  grille: string[],
  devise: string,
): MoisAffiche[] {
  const cible = devise.trim().toUpperCase();
  return grille.map((libelleMois) => {
    const duMois = serie.filter((s) => s.mois === libelleMois);
    const base = duMois.find((s) => s.currency.toUpperCase() === cible);
    const autresDevises = duMois.some((s) => s.currency.toUpperCase() !== cible);
    return {
      libelleMois,
      entrees: base?.entrees ?? "0",
      sorties: base?.sorties ?? "0",
      variation: base?.variation ?? "0",
      autresDevises,
    };
  });
}

/** Plus grande valeur (entrée OU sortie) de la fenêtre — échelle des barres. */
export function maxFenetre(mois: MoisAffiche[]): number {
  let max = 0;
  for (const m of mois) {
    // Échelle uniquement (hauteur relative) — parseFloat est ACCEPTABLE ici car ce
    // n'est PAS un montant affiché (les montants affichés passent par formatMontant
    // sur la chaîne). On borne juste la hauteur d'une barre.
    max = Math.max(max, Math.abs(parseFloat(m.entrees)), Math.abs(parseFloat(m.sorties)));
  }
  return max;
}

/**
 * Corps « barres » de l'ancre Flux : projette la série sur la grille puis rend les
 * barres empilées. Vide (aucun mouvement sur la fenêtre dans la devise de base) →
 * message neutre, la carte garde sa place.
 */
export function FluxBarres({
  serie,
  grille,
  devise,
}: {
  serie: SyntheseMensuelle[];
  grille: string[];
  devise: string;
}) {
  const mois = projeterSurGrille(serie, grille, devise);
  const max = maxFenetre(mois);
  const aucunMouvement = max === 0;
  const ilExisteAutresDevises = mois.some((m) => m.autresDevises);

  if (aucunMouvement) {
    return (
      <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
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
    <div className="flex min-h-[300px] flex-col justify-center">
      <BarresMensuelles mois={mois} max={max} devise={devise} />
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

/**
 * Barres empilées par mois : entrée (inflow) vers le haut, sortie (outflow) vers le
 * bas, à partir d'une ligne de base centrale. Hauteur ∝ montant / max de la fenêtre.
 * SVG inline (zéro dépendance — Tremor incompatible React 19, cohérent avec
 * `flux-chart-trace.tsx`).
 */
function BarresMensuelles({
  mois,
  max,
  devise,
}: {
  mois: MoisAffiche[];
  max: number;
  devise: string;
}) {
  const hauteurDemi = 64; // px pour la plus grande barre (entrée OU sortie)
  const largeurBarre = 28;
  const gap = 16;
  const largeur = mois.length * (largeurBarre + gap);
  const hauteur = hauteurDemi * 2 + 28; // + bande de labels sous l'axe

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${largeur} ${hauteur}`}
        width={largeur}
        height={hauteur}
        role="img"
        aria-label={`Entrées et sorties des ${mois.length} derniers mois, en ${devise}`}
        className="max-w-full"
      >
        {/* Ligne de base (axe zéro). Couleur en var() inline : convention SVG du
            projet (cf. flux-chart-trace.tsx) — les utilitaires fill-/stroke-
            custom ne sont pas employés pour les traits ici. */}
        <line
          x1={0}
          y1={hauteurDemi}
          x2={largeur}
          y2={hauteurDemi}
          stroke="var(--color-line)"
          strokeWidth={1}
        />
        {mois.map((m, i) => {
          const cx = i * (largeurBarre + gap) + gap / 2;
          const hEntree = max > 0 ? (Math.abs(parseFloat(m.entrees)) / max) * hauteurDemi : 0;
          const hSortie = max > 0 ? (Math.abs(parseFloat(m.sorties)) / max) * hauteurDemi : 0;
          // Libellé court : initiale du mois (M de l'axe). Le détail est dans le tableau.
          const labelCourt = formaterMoisAnnee(m.libelleMois).slice(0, 3);
          return (
            <g key={m.libelleMois}>
              {/* Entrée (au-dessus de l'axe) — vert `inflow` (donnée, §3.1) */}
              <rect
                x={cx}
                y={hauteurDemi - hEntree}
                width={largeurBarre}
                height={hEntree}
                rx={2}
                fill="var(--color-inflow)"
              />
              {/* Sortie (en dessous de l'axe) — rouge `outflow` (donnée, §3.1) */}
              <rect
                x={cx}
                y={hauteurDemi}
                width={largeurBarre}
                height={hSortie}
                rx={2}
                fill="var(--color-outflow)"
              />
              {/* Label du mois sous l'axe */}
              <text
                x={cx + largeurBarre / 2}
                y={hauteurDemi * 2 + 18}
                textAnchor="middle"
                fill="var(--color-text-muted)"
                className="text-[10px]"
              >
                {labelCourt}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
