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
import { FiabiliteBadge } from "./fiabilite-badge";
import { FlowTag } from "./flow-tag";
import { LibelleTransaction, resoudreLibelle } from "./libelle-transaction";
import { afficherAVerifier } from "./regle-fiabilite";
import { SourceClassificationIcon } from "./source-classification-icon";
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

  // Niveau de cascade retenu pour le libellé (cf. LibelleTransaction). Sert l'anti-
  // doublon : si le libellé PRINCIPAL est déjà la catégorie (niveau 2), on masque le
  // sous-texte « catégorie » sous le libellé pour ne pas l'afficher deux fois.
  const { niveau: niveauLibelle } = resoudreLibelle({
    cleanLabel: transaction.cleanLabel,
    categorieFr: transaction.categorieBanque,
    bankLabelRaw: transaction.bankLabelRaw,
  });
  const libelleEstCategorie = niveauLibelle === "categorie";

  // Indice de fiabilité AMONT (concept B) : badge « À vérifier » SI la classification
  // Omni-FI est peu fiable ET une catégorie est posée (cf. regle-fiabilite : on évite
  // le bruit du défaut « Low » des lignes non enrichies). Verdict calculé hors JSX.
  const aVerifier = afficherAVerifier({
    niveauFiabilite: transaction.niveauFiabilite,
    categorieBanque: transaction.categorieBanque,
  });

  function declencher() {
    onOpen(transaction);
  }

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      // Accessibilité de la donnée brute (règle produit 2026-06-23) : le libellé
      // bancaire d'ORIGINE (TransactionInformation) est TOUJOURS lisible au survol,
      // même quand un marchand/catégorie l'a remplacé à l'affichage. `undefined` (pas
      // chaîne vide) quand le brut est absent ⇒ React omet l'attribut (pas d'infobulle
      // vide). Le brut reste hors aria-label/log (non imposé, consultable à la demande).
      title={transaction.bankLabelRaw ?? undefined}
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
          passe par LibelleTransaction → cascade marchand → catégorie FR → libellé brut
          bancaire (OBIE TransactionInformation) → repli générique. La catégorie OBIE
          (sous-texte) est DISTINCTE du statut de ventilation manuelle (colonne dédiée
          à droite). ANTI-DOUBLON : si le libellé principal EST déjà la catégorie
          (niveau 2 de la cascade), on n'affiche PAS la catégorie en sous-texte (sinon
          deux fois la même). En mobile (colonne Catégorie masquée), le badge de statut
          se replie ICI. */}
      <td className="px-3 py-[14px] sm:px-4">
        <LibelleTransaction
          cleanLabel={transaction.cleanLabel}
          categorieFr={transaction.categorieBanque}
          bankLabelRaw={transaction.bankLabelRaw}
          className="block truncate text-sm"
        />
        {/* Sous-texte « compte · catégorie » + icône de SOURCE de classification
            (concept C) en fin de ligne. Conteneur `flex` : le texte (tronquable) vit
            dans un span `truncate` interne, l'icône `shrink-0` reste à droite et n'est
            JAMAIS rognée par la troncature (anti-chevauchement R3). `min-w-0` autorise
            l'enfant flex à rétrécir pour que le truncate opère. */}
        <span className="flex min-w-0 items-center gap-1 text-xs text-text-muted">
          <span className="truncate">
            {transaction.compteNom}
            {transaction.categorieBanque && !libelleEstCategorie && (
              <>
                {" · "}
                {transaction.categorieBanque}
              </>
            )}
          </span>
          <SourceClassificationIcon source={transaction.sourceClassification} />
        </span>
        {/* Repli MOBILE (colonne Statut masquée) : badge de ventilation + badge
            « À vérifier » côte à côte. `flex-wrap` LOCAL autorisé ici (ce n'est pas le
            header — la règle anti-flex-wrap vise le header) : sur un petit écran, deux
            badges passent à la ligne proprement plutôt que de déborder (anti-chevauchement R2). */}
        <span className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
          <CategorisationStatusBadge
            statut={transaction.statutCategorisation}
            categorie={transaction.categorie}
            nbCategories={transaction.nbCategories}
          />
          <FiabiliteBadge afficher={aVerifier} />
        </span>
      </td>

      {/* Statut de ventilation (manuelle, concept A) — jamais de vert/rouge. Masqué en
          mobile (replié sous le libellé ci-dessus) pour garder Date · Libellé · Montant.
          Le badge « À vérifier » (concept B, fiabilité amont) se PILE dessous : les deux
          coexistent (ils ne se remplacent pas). `items-start` garde les badges calés à
          gauche, `gap-1` les sépare sans alourdir la densité de ligne. */}
      <td className="hidden px-4 py-[14px] align-top sm:table-cell">
        <span className="flex flex-col items-start gap-1">
          <CategorisationStatusBadge
            statut={transaction.statutCategorisation}
            categorie={transaction.categorie}
            nbCategories={transaction.nbCategories}
          />
          <FiabiliteBadge afficher={aVerifier} />
        </span>
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
