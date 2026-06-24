/**
 * Side-panel KPI du dashboard (UI_GUIDELINES §1.3) — carte SOLDE + carte
 * DÉTAILS (entrées / sorties / variation). Présentationnel PUR : reçoit les
 * sorties des services (`soldesParDevise`, `syntheseMois`) en props, NE recalcule
 * rien. Montants formatés via `formatMontant` (chaînes, zéro float, règle 8).
 *
 * Le solde = somme des soldes COURANTS par devise (`soldesCourantsParDevise`) —
 * source indépendante de `balance_history` (vide tant qu'Omni-FI n'expose pas
 * `/balances/history`). Multi-devises (CLAUDE.md) : UNE LIGNE PAR DEVISE, jamais
 * d'addition cross-devise.
 *
 * Hiérarchie HYBRIDE (décision audit 2026-06-22 §7-1) :
 *  - mono-devise  → un gros montant 28px/700 primary (ancre « trésorerie en 3 s »).
 *  - multi-devises → pile égalitaire 20px/700, VIRGULES DÉCIMALES ALIGNÉES (symbole
 *    en colonne gauche étroite, montant nu `text-right tabular-nums`). Aucune devise
 *    privilégiée, aucune conversion FX d'affichage.
 *
 * Fraîcheur (§3.7) : la méta « au JJ/MM » (faux EOD, anti-pattern DR-F3) est
 * remplacée par une PASTILLE branchée sur `lastSyncedAt` du solde courant.
 *
 * Couleurs : entrées `inflow-700` / sorties `outflow-700` — vert/rouge réservés
 * à la donnée (§3.1). Solde en `primary` (§1.3). Tout en `tabular-nums` (§0).
 */
import type {
  SoldeParDevise,
  SyntheseMoisDevise,
} from "@/server/repositories/dashboard";
import type { Fraicheur } from "@/lib/format-date";

import { replierSynthesesMois } from "@/lib/synthese-mois";
import { formatMontant, symbolePrefixe } from "@/lib/format-montant";
import { formaterMoisAnnee } from "@/lib/format-date";
import { StateCard } from "@/components/dashboard/states/primitives";
import { BalanceFreshnessPill } from "@/components/dashboard/balance-freshness-pill";

export function SidePanelKpi({
  soldesParDevise,
  synthesesMois,
  mois,
  devise,
  fraicheur,
  compteLabel,
}: {
  /** Soldes consolidés courants, une entrée par devise (chaînes décimales). */
  soldesParDevise: SoldeParDevise[];
  /** Synthèse du mois PAR DEVISE (entrées/sorties/variation), chaînes décimales. */
  synthesesMois: SyntheseMoisDevise[];
  /** Mois courant "YYYY-MM" (libellé de la carte Détails). */
  mois: string;
  /** Devise de base du workspace (sert de repli quand aucun compte/solde). */
  devise: string;
  /**
   * Fraîcheur du solde courant (`formaterFraicheurRelative` sur `lastSyncedAt`).
   * `null` quand aucune synchro connue (aucun compte/solde) → pastille masquée.
   */
  fraicheur: Fraicheur | null;
  /** Compte de la synchro la plus récente — enrichit le tooltip de la pastille. */
  compteLabel?: string | null;
}) {
  // Repli : aucun solde (aucun compte sélectionné) → on montre 0 dans la devise de
  // base, plutôt qu'une carte vide. Le multi-devises empile une ligne par devise.
  const lignesSolde: SoldeParDevise[] =
    soldesParDevise.length > 0
      ? soldesParDevise
      : [{ currency: devise, total: "0" }];
  const monoDevise = lignesSolde.length === 1;

  // Détails par devise (repli 0 dans la devise de base si aucune transaction).
  const lignesSynthese = replierSynthesesMois(synthesesMois, devise);
  const multiSynthese = lignesSynthese.length > 1;

  return (
    <>
      {/* Carte SOLDE (§1.3) : une ligne par devise. Mono → gros montant ;
          multi → pile égalitaire à décimales alignées (§7-1). */}
      <StateCard>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            {monoDevise ? "Solde" : "Soldes par devise"}
          </span>
          {fraicheur && (
            <BalanceFreshnessPill
              fraicheur={fraicheur}
              compteLabel={compteLabel}
            />
          )}
        </div>

        {monoDevise ? (
          <p className="mt-4 text-[28px] font-bold leading-tight tracking-tight tabular-nums text-primary">
            {formatMontant(lignesSolde[0].total, lignesSolde[0].currency)}
          </p>
        ) : (
          <SoldesMultiDevises lignes={lignesSolde} />
        )}
      </StateCard>

      {/* Carte DÉTAILS (§1.3) : rangées KPI entrées/sorties/variation, par devise. */}
      <StateCard>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Détails
          </span>
          <span className="text-xs text-text-muted">
            {formaterMoisAnnee(mois)}
          </span>
        </div>
        <div className="mt-4 flex flex-col gap-5">
          {lignesSynthese.map((s, i) => (
            <div
              key={s.currency}
              className={
                i > 0 ? "border-t border-line pt-5" : undefined
              }
            >
              {/* En multi-devise, on étiquette chaque groupe par sa devise. */}
              {multiSynthese && (
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                  {s.currency}
                </p>
              )}
              <dl className="flex flex-col gap-5">
                <KpiRow
                  label="Entrées"
                  valeur={formatMontant(s.entrees, s.currency, {
                    signeExplicite: true,
                  })}
                  couleur="text-inflow-700"
                />
                <KpiRow
                  label="Sorties"
                  valeur={formatMontant(s.sorties, s.currency)}
                  couleur="text-outflow-700"
                />
                <KpiRow
                  label="Variation"
                  valeur={formatMontant(s.variation, s.currency, {
                    signeExplicite: true,
                  })}
                  couleur="text-text"
                />
              </dl>
            </div>
          ))}
        </div>
      </StateCard>
    </>
  );
}

/**
 * Pile multi-devises à DÉCIMALES ALIGNÉES (§7-1). Grille 2 colonnes : symbole
 * (gauche, largeur auto) + montant NU aligné à droite (`tabular-nums` →
 * les virgules s'empilent). Repli : devise inconnue (pas de symbole préfixe) →
 * `formatMontant` complet (code ISO en suffixe), pas d'alignement forcé.
 */
function SoldesMultiDevises({ lignes }: { lignes: SoldeParDevise[] }) {
  return (
    <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
      {lignes.map((s) => {
        const symbole = symbolePrefixe(s.currency);
        return symbole ? (
          <div key={s.currency} className="contents">
            <span className="text-xl font-bold leading-tight text-primary">
              {symbole}
            </span>
            <span className="text-right text-xl font-bold leading-tight tracking-tight tabular-nums text-primary">
              {formatMontant(s.total, "")}
            </span>
          </div>
        ) : (
          // Devise inconnue : on ne sépare pas (le code ISO va en suffixe) ;
          // le montant occupe les 2 colonnes, toujours aligné à droite.
          <span
            key={s.currency}
            className="col-span-2 text-right text-xl font-bold leading-tight tracking-tight tabular-nums text-primary"
          >
            {formatMontant(s.total, s.currency)}
          </span>
        );
      })}
    </div>
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
