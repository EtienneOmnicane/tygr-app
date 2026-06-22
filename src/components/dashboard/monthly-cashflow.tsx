/**
 * Carte « Évolution mensuelle » — vision Entrées / Sorties sur les N derniers mois
 * (tendance), COMPLÉMENTAIRE de `CashFlowSummary` qui ne montre que le mois courant.
 * Posée sous celle-ci dans la zone principale du dashboard (demande métier 2026-06-22).
 *
 * Présentationnel PUR (UI_GUIDELINES — composant d'affichage) : reçoit la SÉRIE
 * mensuelle DÉJÀ agrégée en SQL (`syntheseParMois` → une ligne par (mois, devise))
 * + la GRILLE des mois attendus (`grilleMois`, axe continu : la série omet les mois
 * sans transaction) + la devise de base. NE recalcule aucun total, NE fetch rien.
 * Montants formatés via `formatMontant` sur les chaînes décimales (zéro float — règle 8).
 *
 * ⚠️ Multi-devises (CLAUDE.md règle 8) : on n'additionne JAMAIS des devises. La carte
 * est MONO-AFFICHÉE (décision PO 2026-06-22) : pour chaque mois on lit la ligne de la
 * devise de BASE ; s'il existe d'autres devises ce mois-là, on le SIGNALE par un
 * indicateur discret (« + autres devises ») sans rien sommer. La conversion FX est un
 * chantier séparé (DASH-FX1) — aucun taux inventé ici.
 *
 * Couleurs (§3.1) : vert/rouge réservés à la DONNÉE — entrées `inflow` / sorties
 * `outflow`. `tabular-nums` (§0) pour aligner les chiffres du tableau.
 */
import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

import { formaterMoisAnnee } from "@/lib/format-date";
import { formatMontant } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";

/** Une cellule mensuelle réduite à la devise de base (ce que la carte affiche). */
interface MoisAffiche {
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
function projeterSurGrille(
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
function maxFenetre(mois: MoisAffiche[]): number {
  let max = 0;
  for (const m of mois) {
    // Échelle uniquement (hauteur relative) — parseFloat est ACCEPTABLE ici car ce
    // n'est PAS un montant affiché (les montants affichés passent par formatMontant
    // sur la chaîne). On borne juste la hauteur d'une barre.
    max = Math.max(max, Math.abs(parseFloat(m.entrees)), Math.abs(parseFloat(m.sorties)));
  }
  return max;
}

export function MonthlyCashflow({
  serie,
  grille,
  devise = "MUR",
}: {
  /** Série mensuelle à plat (mois × devise), agrégée en SQL (`syntheseParMois`). */
  serie: SyntheseMensuelle[];
  /** Mois attendus, du plus ancien au plus récent (`grilleMois`) — axe continu. */
  grille: string[];
  /** Devise de base du workspace (affichage mono-devise, cf. note multidevise). */
  devise?: string;
}) {
  const mois = projeterSurGrille(serie, grille, devise);
  const max = maxFenetre(mois);
  // Vide = aucun mouvement sur toute la fenêtre dans la devise de base.
  const aucunMouvement = max === 0;
  const ilExisteAutresDevises = mois.some((m) => m.autresDevises);

  return (
    <StateCard>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Évolution mensuelle</h2>
        <span className="text-xs text-text-muted">{mois.length} derniers mois</span>
      </div>

      {aucunMouvement ? (
        <p className="mt-6 mb-2 text-center text-sm text-text-muted">
          Pas encore de mouvement sur la période.
        </p>
      ) : (
        <>
          {/* Graphique en barres empilées (entrée au-dessus, sortie en dessous). */}
          <BarresMensuelles mois={mois} max={max} devise={devise} />

          {/* Tableau récapitulatif sous les barres. */}
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-text-muted">
                  <th className="py-2 pr-3 font-medium">Mois</th>
                  <th className="py-2 px-3 text-right font-medium">Entrées</th>
                  <th className="py-2 px-3 text-right font-medium">Sorties</th>
                  <th className="py-2 pl-3 text-right font-medium">Variation</th>
                </tr>
              </thead>
              <tbody>
                {mois.map((m) => (
                  <LigneMois key={m.libelleMois} mois={m} devise={devise} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Note multi-devises : présente dès qu'un mois porte une autre devise. */}
      {ilExisteAutresDevises && (
        <p className="mt-3 text-[11px] text-text-faint">
          Certains mois comportent aussi des mouvements dans d’autres devises, non
          additionnés ici (affichage en {devise}).
        </p>
      )}
    </StateCard>
  );
}

/**
 * Barres empilées par mois : entrée (inflow) vers le haut, sortie (outflow) vers le
 * bas, à partir d'une ligne de base centrale. Hauteur ∝ montant / max de la fenêtre.
 * SVG inline (zéro dépendance — Tremor incompatible React 19, cohérent avec
 * `cashflow-main-chart.tsx`).
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
    <div className="mt-4 overflow-x-auto">
      <svg
        viewBox={`0 0 ${largeur} ${hauteur}`}
        width={largeur}
        height={hauteur}
        role="img"
        aria-label={`Entrées et sorties des ${mois.length} derniers mois, en ${devise}`}
        className="max-w-full"
      >
        {/* Ligne de base (axe zéro). Couleur en var() inline : convention SVG du
            projet (cf. cashflow-main-chart.tsx) — les utilitaires fill-/stroke-
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

/** Une ligne du tableau : mois + entrées (vert) + sorties (rouge) + variation. */
function LigneMois({ mois, devise }: { mois: MoisAffiche; devise: string }) {
  const variationNegative = mois.variation.trim().startsWith("-");
  const variationNulle = mois.variation === "0" || mois.variation === "0.00";
  const couleurVariation = variationNulle
    ? "text-text"
    : variationNegative
      ? "text-outflow-700"
      : "text-inflow-700";

  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="py-2 pr-3 text-text">
        {formaterMoisAnnee(mois.libelleMois)}
        {mois.autresDevises && (
          <span
            className="ml-1.5 align-middle text-[10px] text-text-faint"
            title="Mouvements aussi dans d’autres devises (non additionnés)"
          >
            + autres devises
          </span>
        )}
      </td>
      <td className="py-2 px-3 text-right tabular-nums text-inflow-700">
        {formatMontant(mois.entrees, devise, { signeExplicite: true })}
      </td>
      <td className="py-2 px-3 text-right tabular-nums text-outflow-700">
        {formatMontant(mois.sorties, devise)}
      </td>
      <td className={`py-2 pl-3 text-right font-medium tabular-nums ${couleurVariation}`}>
        {formatMontant(mois.variation, devise, { signeExplicite: true })}
      </td>
    </tr>
  );
}
