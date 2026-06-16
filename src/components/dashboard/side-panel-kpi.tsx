/**
 * Side-panel KPI du dashboard (UI_GUIDELINES §1.3) — carte SOLDE + carte
 * DÉTAILS (entrées / sorties / variation). Présentationnel PUR : reçoit les
 * sorties des services (`soldeConsolide`, `syntheseMois`) en props, NE recalcule
 * rien. Montants formatés via `formatMontant` (chaînes, zéro float, règle 8).
 *
 * Le solde = dernier EOD consolidé (même source que la fin de courbe) — pas
 * `current_balance` (décision revue : KPI et courbe coïncident). Mention « au
 * JJ/MM » pour assumer que c'est l'EOD.
 *
 * Couleurs : entrées `inflow-700` / sorties `outflow-700` — vert/rouge réservés
 * à la donnée (§3.1). Solde en `primary` (§1.3). Tout en `tabular-nums` (§0).
 */
import type { SyntheseMois } from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";

export function SidePanelKpi({
  soldeConsolide,
  syntheseMois,
  devise,
  dateSolde,
}: {
  /** Solde consolidé courant (dernier EOD), chaîne décimale. */
  soldeConsolide: string;
  /** Synthèse du mois (entrées/sorties/variation), chaînes décimales. */
  syntheseMois: SyntheseMois;
  /** Devise de base du workspace (MUR au MVP mono-devise). */
  devise: string;
  /** Date du dernier EOD, formatée « JJ/MM » pour la méta de la carte solde. */
  dateSolde: string;
}) {
  return (
    <>
      {/* Carte SOLDE (§1.3) : montant 28px/700 tabular en primary. */}
      <StateCard>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Solde
          </span>
          <span className="text-xs text-text-muted">au {dateSolde}</span>
        </div>
        <p className="mt-4 text-[28px] font-bold leading-tight tracking-tight tabular-nums text-primary">
          {formatMontant(soldeConsolide, devise)}
        </p>
      </StateCard>

      {/* Carte DÉTAILS (§1.3) : rangées KPI entrées/sorties/variation. */}
      <StateCard>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Détails
          </span>
          <span className="text-xs text-text-muted">
            {moisLisible(syntheseMois.libelleMois)}
          </span>
        </div>
        <dl className="mt-4 flex flex-col gap-5">
          <KpiRow
            label="Entrées"
            valeur={formatMontant(syntheseMois.entrees, devise, {
              signeExplicite: true,
            })}
            couleur="text-inflow-700"
          />
          <KpiRow
            label="Sorties"
            valeur={formatMontant(syntheseMois.sorties, devise)}
            couleur="text-outflow-700"
          />
          <KpiRow
            label="Variation"
            valeur={formatMontant(syntheseMois.variation, devise, {
              signeExplicite: true,
            })}
            couleur="text-text"
          />
        </dl>
      </StateCard>
    </>
  );
}

function KpiRow({
  label,
  valeur,
  couleur,
}: {
  label: string;
  valeur: string;
  couleur: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${couleur}`}>
        {valeur}
      </dd>
    </div>
  );
}

/** "2026-06" → "Juin 2026". Purement présentationnel. */
function moisLisible(libelleMois: string): string {
  const [annee, mois] = libelleMois.split("-");
  const noms = [
    "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
  ];
  const idx = Number(mois) - 1;
  return idx >= 0 && idx < 12 ? `${noms[idx]} ${annee}` : libelleMois;
}
