/**
 * Table des transactions récentes (UI_GUIDELINES §2.2). Présentationnel PUR :
 * reçoit `TransactionRecente[]` (chaînes décimales). Colonnes DATE · LIBELLÉ ·
 * CATÉGORIE · MONTANT — montant aligné à droite, tabular-nums (§0).
 *
 * Sémantique (§3.1) : Credit → `inflow` (vert, +), Debit → `outflow` (rouge, −).
 * La couleur ne porte QUE sur la donnée. `cleanLabel` peut être null (PII jamais
 * affichée, bank_label_raw exclu côté service) → fallback neutre.
 *
 * Liste vide gérée par le parent (empty state) ; ici on suppose ≥ 1 ligne.
 */
import type { TransactionRecente } from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { formaterDateComptable } from "@/lib/format-date";
import { categorieFr } from "@/lib/categories-fr";
import { StateCard } from "@/components/dashboard/states/primitives";

export function TransactionsTable({
  transactions,
  devise,
}: {
  transactions: TransactionRecente[];
  devise: string;
}) {
  return (
    <StateCard>
      <h2 className="mb-4 text-sm font-semibold text-text">
        Transactions récentes
      </h2>

      <div className="grid grid-cols-[88px_1fr_140px_140px] gap-4 border-b border-line pb-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        <span>Date</span>
        <span>Libellé</span>
        <span>Catégorie</span>
        <span className="text-right">Montant</span>
      </div>

      <div className="divide-y divide-line">
        {transactions.map((t) => {
          const sortie = t.creditDebit === "Debit";
          // Montant signé pour l'affichage : Debit → négatif (chaîne, pas float).
          const montantSigne = sortie ? `-${depouiller(t.amount)}` : t.amount;
          return (
            <div
              key={t.omnifiTxnId}
              className="grid grid-cols-[88px_1fr_140px_140px] items-center gap-4 py-3"
            >
              <span className="text-xs tabular-nums text-text-muted">
                {formaterDateComptable(t.transactionDate)}
              </span>
              <span className="truncate text-sm text-text">
                {t.cleanLabel ?? "Opération bancaire"}
              </span>
              <span className="truncate text-xs text-text-muted">
                {categorieFr(t.primaryCategory)}
              </span>
              <span
                className={`text-right text-sm font-semibold tabular-nums ${
                  sortie ? "text-outflow-700" : "text-inflow-700"
                }`}
              >
                {formatMontant(montantSigne, devise, { signeExplicite: true })}
              </span>
            </div>
          );
        })}
      </div>
    </StateCard>
  );
}

/** Retire un éventuel signe « - » de tête (on reconstruit le signe via creditDebit). */
function depouiller(montant: string): string {
  const t = montant.trim();
  return t.startsWith("-") ? t.slice(1) : t;
}
