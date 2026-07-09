"use client";

/**
 * Sélecteur de compte de /transactions — accordéon par TITULAIRE (C2,
 * PLAN-transactions-selecteur-entites.md). Remplace le `<Select>` natif groupé
 * par institution : avec des dizaines de comptes sur peu de banques, la liste
 * déroulante native devenait ingérable (« banque noyée »). L'accordéon reprend le
 * markup `<details>/<summary>` de `ConnectedAccountsCard` (dashboard) mais le rend
 * SÉLECTIONNABLE — sélection SIMPLE (un compte OU « Tous les comptes »), pas la
 * multi-sélection du sélecteur de périmètre.
 *
 * PRÉSENTATIONNEL PUR (règle 2, §Intégration UI) : options en props, `onChange` en
 * prop, ZÉRO fetch, ZÉRO état interne de données. Le seul état local admissible est
 * l'ouverture des volets `<details>` (état de VUE, pas de donnée). Le filtrage réel
 * vit côté serveur (le parent pousse `bankAccountId` dans les filtres → recharge
 * page 1) ; ce composant n'est qu'un choix d'UI. Le serveur intersecte de toute
 * façon DROIT ∩ filtre : un id hors périmètre soumis ici ne fuiterait rien.
 *
 * Tokens UI_GUIDELINES uniquement (aucune couleur en dur) : l'item sélectionné
 * porte `primary`. `tabular-nums` sans objet ici (aucun montant — c'est un filtre).
 */
import { useId } from "react";

import { cn } from "@/components/ui/states/primitives";
import { grouperParTitulaire } from "@/lib/grouper-titulaire";

import type { CompteFiltre } from "./transactions-toolbar";

/** Libellé du bucket sans titulaire exploitable (aligné sur le dashboard, D7). */
const TITRE_NON_REGROUPE = "Non regroupé";

/**
 * Rangée d'un compte, rendue comme un `radio` (sélection simple). La sélection
 * courante (`bankAccountId` ou `undefined` = « Tous ») pilote `aria-checked` et le
 * style. Le clic remonte l'id (ou `undefined` pour « Tous ») via `onSelect`.
 */
function OptionCompte({
  id,
  libelle,
  sousLibelle,
  selectionne,
  onSelect,
  disabled,
}: {
  id: string;
  libelle: string;
  sousLibelle?: string | null;
  selectionne: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selectionne}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        "disabled:cursor-not-allowed disabled:opacity-[0.48]",
        selectionne
          ? "bg-primary/10 font-medium text-primary"
          : "text-text hover:bg-surface-inset",
      )}
    >
      {/* Puce d'état (radio) — couleur portée par le token primary quand sélectionné. */}
      <span
        aria-hidden
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
          selectionne ? "border-primary" : "border-line",
        )}
      >
        {selectionne && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" title={libelle} data-testid={`compte-option-${id}`}>
          {libelle}
        </span>
        {sousLibelle && (
          <span className="truncate text-[11px] text-text-muted" title={sousLibelle}>
            {sousLibelle}
          </span>
        )}
      </span>
    </button>
  );
}

export function CompteSelecteur({
  comptes,
  valeur,
  onChange,
  disabled = false,
}: {
  /** Comptes connectés (déjà scopés RLS en amont), avec titulaire pour le groupement. */
  comptes: CompteFiltre[];
  /** Compte sélectionné (`bankAccountId`), ou `undefined` = « Tous les comptes ». */
  valeur: string | undefined;
  /** Remonte le compte choisi (`undefined` pour « Tous »). */
  onChange: (bankAccountId: string | undefined) => void;
  /** Désactive tous les contrôles pendant un chargement. */
  disabled?: boolean;
}) {
  // Nom d'accessibilité stable pour le groupe radio (un id par instance montée).
  const radiogroupId = useId();
  const groupes = grouperParTitulaire(comptes);
  const aucunSelectionne = valeur === undefined;

  // « Tous les comptes » : toujours en tête, hors accordéon (choix par défaut).
  const optionTous = (
    <OptionCompte
      id="tous"
      libelle="Tous les comptes"
      selectionne={aucunSelectionne}
      onSelect={() => onChange(undefined)}
      disabled={disabled}
    />
  );

  // Rendu d'un compte : nom de compte en libellé principal, institution en
  // sous-libellé (l'institution n'est plus l'en-tête de groupe — le titulaire l'est).
  const renderCompte = (compte: CompteFiltre) => (
    <OptionCompte
      key={compte.bankAccountId}
      id={compte.bankAccountId}
      libelle={compte.accountName}
      sousLibelle={compte.institutionName}
      selectionne={valeur === compte.bankAccountId}
      onSelect={() => onChange(compte.bankAccountId)}
      disabled={disabled}
    />
  );

  return (
    <div
      role="radiogroup"
      aria-label="Filtrer par compte"
      aria-describedby={radiogroupId}
      className="w-full max-w-[18rem] rounded-control border border-line bg-surface-card p-1.5"
    >
      <span id={radiogroupId} className="sr-only">
        Sélectionnez un compte pour filtrer la liste des transactions.
      </span>

      {optionTous}

      {groupes.length < 2 ? (
        /* Repli mono-groupe (un seul titulaire, ou tous « Non regroupé ») : liste
           plate sans accordéon superflu — même repli que le dashboard. */
        <div className="mt-1 flex flex-col">{comptes.map(renderCompte)}</div>
      ) : (
        <div className="mt-1 flex flex-col">
          {groupes.map((groupe) => {
            const nb = groupe.comptes.length;
            const titre = groupe.holderName ?? TITRE_NON_REGROUPE;
            // Ouvrir d'emblée le volet qui CONTIENT le compte sélectionné — sinon
            // la sélection courante serait invisible sous un volet replié.
            const contientSelection = groupe.comptes.some(
              (c) => c.bankAccountId === valeur,
            );
            return (
              <details
                key={groupe.holderId ?? "non-regroupe"}
                open={contientSelection}
                className="group"
              >
                <summary
                  className="flex cursor-pointer list-none items-center justify-between gap-2
                    rounded-control px-2.5 py-2 text-[13px] font-medium text-text
                    hover:bg-surface-inset focus:outline-none focus-visible:ring-2
                    focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className="shrink-0 text-[10px] text-text-muted transition-transform
                        group-open:rotate-90"
                    >
                      ▸
                    </span>
                    <span
                      className={cn(
                        "truncate",
                        groupe.holderId === null && "text-text-muted",
                      )}
                      title={titre}
                    >
                      {titre}
                    </span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-text-muted">
                    {nb} compte{nb > 1 ? "s" : ""}
                  </span>
                </summary>
                <div className="flex flex-col pl-3">
                  {groupe.comptes.map(renderCompte)}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
