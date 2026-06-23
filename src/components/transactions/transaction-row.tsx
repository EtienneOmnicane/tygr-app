/**
 * Une ligne du tableau /transactions (UI_GUIDELINES §2.2). Présentationnel PUR.
 *
 * Toute la ligne est une cible cliquable (souris ET clavier) qui ouvre la
 * SplitAllocationModal pour la transaction. Densité §2.2 : `py-[14px] px-4`,
 * hauteur ~44px, séparateur `line` (porté par le `<tbody>` parent), PAS de zébrage,
 * hover `surface-inset`.
 *
 * Sémantique montant (§3.1) : Credit → `inflow-700` (vert, +), Debit →
 * `outflow-700` (rouge, −). La couleur ne porte QUE sur le montant (donnée
 * financière). Le badge de catégorie n'a, lui, JAMAIS de vert/rouge.
 */
import { formatMontant } from "@/lib/format-montant";
import { formaterDateComptable } from "@/lib/format-date";

import { CategorisationStatusBadge } from "./categorisation-status-badge";
import { FlowTag } from "./flow-tag";
import { LibelleTransaction } from "./libelle-transaction";
import type { TransactionListItem } from "./types-transactions";

/** Retire un éventuel signe « - » de tête (on reconstruit le signe via `sens`). */
function depouiller(montant: string): string {
  const t = montant.trim();
  return t.startsWith("-") ? t.slice(1) : t;
}

export function TransactionRow({
  transaction,
  onOpen,
}: {
  transaction: TransactionListItem;
  /** Ouvre la ventilation pour cette transaction. */
  onOpen: (transaction: TransactionListItem) => void;
}) {
  const sortie = transaction.sens === "Debit";
  // Montant signé pour l'affichage : Debit → négatif (chaîne décimale, pas float).
  const montantSigne = sortie
    ? `-${depouiller(transaction.montantAbs)}`
    : transaction.montantAbs;

  const sensLabel = sortie ? "sortie" : "entrée";
  const ariaLabel = `${transaction.label}, ${formatMontant(
    transaction.montantAbs,
    transaction.devise,
  )} ${sensLabel}, ${formaterDateComptable(transaction.transactionDate)} — ouvrir la ventilation`;

  function declencher() {
    onOpen(transaction);
  }

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={declencher}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          declencher();
        }
      }}
      className="cursor-pointer transition-colors hover:bg-surface-inset focus:outline-none focus-visible:bg-surface-inset focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
    >
      {/* Date — nue Maurice, mise en forme par format-date (pas de re-conversion). */}
      <td className="whitespace-nowrap px-3 py-[14px] text-xs tabular-nums text-text-muted sm:px-4">
        {formaterDateComptable(transaction.transactionDate)}
      </td>

      {/* Libellé (marchand) + sous-texte « compte · catégorie banque ». Le libellé
          passe par LibelleTransaction → repli discret si cleanLabel null (PII : on
          n'affiche jamais bank_label_raw). La catégorie OBIE (sous-texte) est
          DISTINCTE du statut de ventilation manuelle (colonne dédiée à droite).
          En mobile (colonne Catégorie masquée), le badge de statut se replie ICI. */}
      <td className="px-3 py-[14px] sm:px-4">
        <LibelleTransaction
          cleanLabel={transaction.cleanLabel}
          className="block truncate text-sm"
        />
        <span className="block truncate text-xs text-text-muted">
          {transaction.compteNom}
          {transaction.categorieBanque && (
            <>
              {" · "}
              {transaction.categorieBanque}
            </>
          )}
        </span>
        <span className="mt-1 flex sm:hidden">
          <CategorisationStatusBadge
            statut={transaction.statutCategorisation}
            categorie={transaction.categorie}
            nbCategories={transaction.nbCategories}
          />
        </span>
      </td>

      {/* Statut de ventilation (manuelle) — jamais de vert/rouge. Masqué en mobile
          (replié sous le libellé ci-dessus) pour garder Date · Libellé · Montant. */}
      <td className="hidden px-4 py-[14px] sm:table-cell">
        <CategorisationStatusBadge
          statut={transaction.statutCategorisation}
          categorie={transaction.categorie}
          nbCategories={transaction.nbCategories}
        />
      </td>

      {/* Montant — aligné droite, tabular-nums, couleur sémantique. Toujours visible
          (info critique), même en mobile. Police légèrement réduite en mobile pour
          que les montants à 6 chiffres (« −152 340,00 MUR ») tiennent sans rogner
          la colonne Libellé. Sous le montant : tag Entrée/Sortie pour une lecture
          immédiate du flux (le sens EST une donnée → vert/rouge légitime, §3.1). */}
      <td className="whitespace-nowrap px-3 py-[14px] text-right sm:px-4">
        <span
          className={`block text-[13px] font-semibold tabular-nums sm:text-sm ${
            sortie ? "text-outflow-700" : "text-inflow-700"
          }`}
        >
          {formatMontant(montantSigne, transaction.devise, {
            signeExplicite: true,
          })}
        </span>
        <span className="mt-1 flex justify-end">
          <FlowTag sens={transaction.sens} />
        </span>
      </td>
    </tr>
  );
}
