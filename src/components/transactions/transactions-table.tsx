/**
 * Tableau dense des transactions (UI_GUIDELINES §2.2). Présentationnel PUR :
 * reçoit les lignes + un handler d'ouverture, ne fetch rien. Le parent
 * (transactions-feature) gère l'état, la pagination et la modale.
 *
 * `<table>` SÉMANTIQUE (≠ la grille `<div>` du dashboard) : lignes cliquables au
 * clavier, en-têtes `<th scope>`, lecture d'écran correcte. En-tête STICKY en haut
 * de la zone scrollable. Largeurs fixées par `<colgroup>` (le `<table>` ne se
 * pilote pas en grid). Séparateurs `line` 1px via `divide-y` sur le `<tbody>` ;
 * PAS de zébrage (§2.2 : blanc + séparateurs fins suffisent).
 */
import { TransactionRow } from "./transaction-row";
import type { TransactionListItem } from "./types-transactions";

export function TransactionsTable({
  transactions,
  onOpen,
}: {
  transactions: TransactionListItem[];
  onOpen: (transaction: TransactionListItem) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface-card shadow-card">
      {/* table-fixed : impose les largeurs du <colgroup> → `truncate` opère et la
          table ne déborde jamais du viewport mobile (sinon table-auto élargit au
          contenu et le montant sort de l'écran). */}
      <table className="w-full table-fixed border-collapse text-left">
        {/* Largeurs de colonnes (imposées par table-fixed). La colonne Catégorie
            est ramenée à 0 SOUS lg (`w-0`) car ses cellules sont masquées
            (`hidden lg:table-cell`) — en table-fixed, une <col> à largeur fixe
            réserverait l'espace même cellules masquées et ferait déborder la table.
            Seuil lg (1024) et non sm (640) : entre 640 et 1024, la sidebar (232px)
            + 200px de catégorie affamaient le LIBELLÉ (réduit à 1-2 lettres) —
            l'info clé cède avant la colonne quasi constante (FINDING-002b). */}
        <colgroup>
          <col className="w-[68px] sm:w-[92px]" />
          <col />
          <col className="w-0 lg:w-[200px]" />
          <col className="w-[128px] sm:w-[150px]" />
        </colgroup>

        <thead>
          <tr className="sticky top-0 z-10 border-b border-line-strong bg-surface-card">
            <th
              scope="col"
              className="px-3 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
            >
              Date
            </th>
            <th
              scope="col"
              className="px-3 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
            >
              Libellé
            </th>
            <th
              scope="col"
              className="hidden px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted lg:table-cell"
            >
              Catégorie
            </th>
            <th
              scope="col"
              className="px-3 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:px-4"
            >
              Montant
            </th>
          </tr>
        </thead>

        <tbody className="divide-y divide-line">
          {transactions.map((t) => (
            <TransactionRow
              key={`${t.transactionId}:${t.transactionDate}`}
              transaction={t}
              onOpen={onOpen}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
