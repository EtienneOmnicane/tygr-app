/**
 * Carte « Comptes connectés » (side-panel du dashboard). Liste chaque compte
 * bancaire relié avec son libellé et son solde courant — parité avec le
 * benchmark FYGR. Présentationnel pur : reçoit les comptes déjà résolus.
 *
 * Ordre dans la pile aside : SOLDE (SidePanelKpi) → DÉTAILS → COMPTES CONNECTÉS.
 *
 * Montants : `formatMontant` (décomposition de chaîne, jamais de float — règle 8),
 * `tabular-nums` pour l'alignement des chiffres. `currentBalance` peut être null
 * (compte sans solde encore synchronisé) → tiret cadratin.
 */
import type { CompteConnecte } from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";

export function ConnectedAccountsCard({ comptes }: { comptes: CompteConnecte[] }) {
  // Aucun compte → la carte ne se monte pas (l'empty GLOBAL du dashboard a déjà
  // pris le relais en amont ; ici on évite une carte vide superflue).
  if (comptes.length === 0) return null;

  return (
    <StateCard>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          Comptes connectés
        </span>
        <span className="text-xs font-medium tabular-nums text-text-muted">
          {comptes.length}
        </span>
      </div>
      <ul className="mt-4 flex flex-col divide-y divide-line">
        {comptes.map((compte) => (
          <li
            key={compte.bankAccountId}
            className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0"
          >
            <span className="truncate text-[13px] text-text">
              {compte.accountName}
            </span>
            <span className="text-sm font-semibold tabular-nums text-text">
              {compte.currentBalance
                ? formatMontant(compte.currentBalance, compte.currency)
                : "—"}
            </span>
          </li>
        ))}
      </ul>
    </StateCard>
  );
}
