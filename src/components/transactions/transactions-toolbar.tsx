/**
 * Toolbar de filtres de /transactions (UI_GUIDELINES §2.2 toolbar + §2.3).
 * Présentationnelle PURE : reçoit l'état des filtres + les comptes, remonte les
 * changements via `onChange`. Aucun fetch, aucun état interne.
 *
 * - Sens : segmented control (segment actif = pill `ink` blanc, §2.3), pattern
 *   identique aux démos existantes (cohérence).
 * - Compte : affiché UNIQUEMENT s'il y a >1 compte connecté (sinon inutile).
 *   Accordéon par TITULAIRE (`CompteSelecteur`, C2) — remplace l'ancien `<Select>`
 *   natif groupé par institution, ingérable dès qu'un titulaire porte des dizaines
 *   de comptes (« banque noyée », feedback 0709).
 * - Statut de ventilation : select natif (Tout / Non catégorisé / Partiel / Complet).
 *
 * Changer un filtre = le parent recharge la page 1 (reset du curseur).
 */
import { Select } from "@/components/ui/select";

import { CompteSelecteur } from "./comptes-selecteur";
import type {
  FiltresTransactions,
  StatutCategorisation,
} from "./types-transactions";

/**
 * Un compte connecté, pour le filtre par compte. Porte `accountName` +
 * `institutionName` (sous-libellé de l'option) et le TITULAIRE (`holderId`/
 * `holderName`) — clé de groupement de l'accordéon `CompteSelecteur` (C2).
 */
export interface CompteFiltre {
  bankAccountId: string;
  accountName: string;
  institutionName: string | null;
  /**
   * Titulaire (Omni-FI Party) du compte, pour l'accordéon de sélection groupé par
   * titulaire (C2 — `CompteSelecteur`). `null` = compte sans titulaire exploitable
   * → bucket « Non regroupé ». Ces deux champs satisfont `CompteTitulable`
   * (`grouperParTitulaire`). Fournis par `listerComptes` (via `account_party_role`).
   */
  holderId: string | null;
  holderName: string | null;
}

const OPTIONS_STATUT: Array<{ valeur: StatutCategorisation | ""; label: string }> = [
  { valeur: "", label: "Tous statuts" },
  { valeur: "non_categorise", label: "Non catégorisé" },
  { valeur: "partiel", label: "Partiel" },
  { valeur: "complet", label: "Complet" },
];

export function TransactionsToolbar({
  filtres,
  comptes,
  onChange,
  disabled = false,
}: {
  filtres: FiltresTransactions;
  /** Comptes connectés (le filtre Compte n'apparaît que si >1). */
  comptes: CompteFiltre[];
  onChange: (filtres: FiltresTransactions) => void;
  /** Désactive les contrôles pendant un chargement. */
  disabled?: boolean;
}) {
  const champSelect =
    "h-10 rounded-control border border-line bg-surface-card px-3 text-sm text-text " +
    "focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
    "disabled:opacity-[0.48]";

  return (
    <div className="flex flex-wrap items-start gap-3">
      {/* NB : le filtre Sens (Entrées/Sorties) n'est PAS exposé en v1 — le schéma de
          lecture Backend ne supporte pas encore ce filtre (pas de champ `sens`,
          .strict). Le filtrer côté client casserait la pagination (pages tronquées).
          À ré-activer dès que Backend l'ajoute (tracé TODOS TX-FILTRE1). */}

      {/* Compte — seulement si plusieurs comptes. Accordéon par TITULAIRE
          (CompteSelecteur, C2) : remplace le <Select> natif groupé par institution,
          ingérable dès qu'un titulaire porte des dizaines de comptes. */}
      {comptes.length > 1 && (
        <CompteSelecteur
          comptes={comptes}
          valeur={filtres.bankAccountId}
          disabled={disabled}
          onChange={(bankAccountId) =>
            onChange({ ...filtres, bankAccountId })
          }
        />
      )}

      {/* Statut de ventilation */}
      <Select
        ariaLabel="Filtrer par statut de ventilation"
        value={filtres.statutCategorisation ?? ""}
        disabled={disabled}
        onChange={(v) =>
          onChange({
            ...filtres,
            statutCategorisation: (v as StatutCategorisation) || undefined,
          })
        }
        options={OPTIONS_STATUT.map((o) => ({ value: o.valeur, label: o.label }))}
      />

      {/* Bornes de date comptable (from/to) — INCLUSES. Opt-in : vides = aucune
          fenêtre (montre tout). Le range part au SERVEUR (WHERE gte/lte via
          versInputBackend) — JAMAIS de filtrage date côté client (TX-FILTRE1).
          `<input type="date">` émet nativement `YYYY-MM-DD` = format attendu par
          `transaction_date`, sans conversion. Bornage croisé min/max = garde-fou
          visuel ; la vraie garde `dateDebut ≤ dateFin` reste côté serveur (Zod). */}
      <label className="inline-flex items-center gap-2 text-sm text-text-muted">
        <span className="sr-only">Date de début</span>
        <input
          type="date"
          value={filtres.dateDebut ?? ""}
          max={filtres.dateFin || undefined}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...filtres, dateDebut: e.target.value || undefined })
          }
          className={champSelect}
        />
      </label>

      <label className="inline-flex items-center gap-2 text-sm text-text-muted">
        <span className="sr-only">Date de fin</span>
        <input
          type="date"
          value={filtres.dateFin ?? ""}
          min={filtres.dateDebut || undefined}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...filtres, dateFin: e.target.value || undefined })
          }
          className={champSelect}
        />
      </label>
    </div>
  );
}
