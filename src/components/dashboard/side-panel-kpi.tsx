/**
 * Side-panel KPI du dashboard (UI_GUIDELINES §1.3) — carte SOLDE + carte
 * DÉTAILS (entrées / sorties / variation). Présentationnel PUR : reçoit les
 * sorties des services (`soldesParDevise`, `syntheseMois`) en props, NE recalcule
 * rien. Montants formatés via `formatMontant` (chaînes, zéro float, règle 8).
 *
 * Le solde = somme des soldes COURANTS par devise (`soldesCourantsParDevise`) —
 * source indépendante de `balance_history` (vide tant qu'Omni-FI n'expose pas
 * `/balances/history`). Multi-devises (CLAUDE.md) : UNE LIGNE PAR DEVISE, jamais
 * d'addition cross-devise. Mention « au JJ/MM » = date de dernière synchro.
 *
 * Couleurs : entrées `inflow-700` / sorties `outflow-700` — vert/rouge réservés
 * à la donnée (§3.1). Solde en `primary` (§1.3). Tout en `tabular-nums` (§0).
 */
import type {
  SoldeParDevise,
  SyntheseMois,
} from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { formaterMoisAnnee } from "@/lib/format-date";
import { StateCard } from "@/components/dashboard/states/primitives";

export function SidePanelKpi({
  soldesParDevise,
  syntheseMois,
  devise,
  dateSolde,
}: {
  /** Soldes consolidés courants, une entrée par devise (chaînes décimales). */
  soldesParDevise: SoldeParDevise[];
  /** Synthèse du mois (entrées/sorties/variation), chaînes décimales. */
  syntheseMois: SyntheseMois;
  /** Devise de base du workspace (sert de repli quand aucun compte/solde). */
  devise: string;
  /** Date de dernière synchro, formatée « JJ/MM » pour la méta de la carte solde. */
  dateSolde: string;
}) {
  // Repli : aucun solde (aucun compte sélectionné) → on montre 0 dans la devise de
  // base, plutôt qu'une carte vide. Le multi-devises empile une ligne par devise.
  const lignesSolde: SoldeParDevise[] =
    soldesParDevise.length > 0
      ? soldesParDevise
      : [{ currency: devise, total: "0" }];
  const monoDevise = lignesSolde.length === 1;

  return (
    <>
      {/* Carte SOLDE (§1.3) : une ligne par devise. Mono-devise → gros montant
          28px/700 ; multi-devises → pile compacte (chaque devise sur sa ligne). */}
      <StateCard>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            {monoDevise ? "Solde" : "Soldes par devise"}
          </span>
          <span className="text-xs text-text-muted">au {dateSolde}</span>
        </div>
        <div className={monoDevise ? "mt-4" : "mt-4 flex flex-col gap-2"}>
          {lignesSolde.map((s) => (
            <p
              key={s.currency}
              className={
                monoDevise
                  ? "text-[28px] font-bold leading-tight tracking-tight tabular-nums text-primary"
                  : "text-xl font-bold leading-tight tracking-tight tabular-nums text-primary"
              }
            >
              {formatMontant(s.total, s.currency)}
            </p>
          ))}
        </div>
      </StateCard>

      {/* Carte DÉTAILS (§1.3) : rangées KPI entrées/sorties/variation. */}
      <StateCard>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Détails
          </span>
          <span className="text-xs text-text-muted">
            {formaterMoisAnnee(syntheseMois.libelleMois)}
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
