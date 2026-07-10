/**
 * Table des transactions récentes (UI_GUIDELINES §2.2). Présentationnel PUR :
 * reçoit `TransactionRecente[]` (chaînes décimales). Colonnes DATE · LIBELLÉ ·
 * CATÉGORIE · MONTANT — montant aligné à droite, tabular-nums (§0).
 *
 * Sémantique (§3.1) : Credit → `inflow` (vert, +), Debit → `outflow` (rouge, −).
 * La couleur ne porte QUE sur la donnée. Libellé via `LibelleTransaction` (partagé
 * avec /transactions) : cascade marchand → libellé brut OBIE → repli. La catégorie est
 * SAUTÉE dans la cascade (`categorieFr={null}`) car le dashboard a une colonne Catégorie
 * dédiée (anti-doublon). Le narratif brut reste lisible au survol (`title`).
 *
 * Liste vide gérée par le parent (empty state) ; ici on suppose ≥ 1 ligne.
 */
import type { TransactionRecente } from "@/server/repositories/dashboard";

import { formatMontant } from "@/lib/format-montant";
import { formaterDateComptable } from "@/lib/format-date";
import { categorieFr } from "@/lib/categories-fr";
import { StateCard } from "@/components/dashboard/states/primitives";
import { FlowTag } from "@/components/transactions/flow-tag";
import { LibelleTransaction } from "@/components/transactions/libelle-transaction";

export function TransactionsTable({
  transactions,
  devise,
}: {
  transactions: TransactionRecente[];
  devise: string;
}) {
  return (
    <StateCard>
      <h2 className="mb-4 text-base font-semibold text-text">
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
              // Accessibilité de la donnée brute (règle produit 2026-06-23, alignée sur
              // /transactions) : le narratif bancaire d'origine reste lisible au survol
              // même quand un marchand l'a remplacé. `undefined` si absent ⇒ React omet
              // l'attribut (pas d'infobulle vide). Brut hors log/aria (non imposé).
              title={t.bankLabelRaw ?? undefined}
              className="grid grid-cols-[88px_1fr_140px_140px] items-center gap-4 py-3"
            >
              <span className="text-xs tabular-nums text-text-muted">
                {formaterDateComptable(t.transactionDate)}
              </span>
              {/* Cascade ALIGNÉE sur /transactions (dette TECH-DASHBOARD-CASCADE résolue
                  2026-07-10) : marchand → (catégorie SAUTÉE via categorieFr={null}, car
                  le dashboard a une colonne Catégorie DÉDIÉE → anti-doublon) → libellé
                  brut OBIE → repli générique. On ne tombe plus sur « Opération bancaire »
                  quand un narratif brut existe. */}
              <LibelleTransaction
                cleanLabel={t.cleanLabel}
                categorieFr={null}
                bankLabelRaw={t.bankLabelRaw}
                className="truncate text-sm"
              />
              <span className="truncate text-xs text-text-muted">
                {categorieFr(t.primaryCategory)}
              </span>
              <span className="text-right">
                <span
                  className={`block text-sm font-semibold tabular-nums ${
                    sortie ? "text-outflow-700" : "text-inflow-700"
                  }`}
                >
                  {formatMontant(montantSigne, devise, { signeExplicite: true })}
                </span>
                <span className="mt-1 flex justify-end">
                  <FlowTag sens={t.creditDebit} />
                </span>
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
