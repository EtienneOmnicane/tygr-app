/**
 * Toolbar de filtres de /transactions (UI_GUIDELINES §2.2 toolbar + §2.3).
 * Présentationnelle PURE : reçoit l'état des filtres + les comptes, remonte les
 * changements via `onChange`. Aucun fetch, aucun état interne.
 *
 * - Sens : segmented control (segment actif = pill `ink` blanc, §2.3), pattern
 *   identique aux démos existantes (cohérence).
 * - Compte : affiché UNIQUEMENT s'il y a >1 compte connecté (sinon inutile).
 * - Statut de ventilation : select natif (Tout / Non catégorisé / Partiel / Complet).
 *
 * Changer un filtre = le parent recharge la page 1 (reset du curseur).
 */
import type {
  FiltresTransactions,
  StatutCategorisation,
} from "./types-transactions";

/** Un compte connecté, pour le filtre par compte. */
export interface CompteFiltre {
  bankAccountId: string;
  nom: string;
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
    <div className="flex flex-wrap items-center gap-3">
      {/* NB : le filtre Sens (Entrées/Sorties) n'est PAS exposé en v1 — le schéma de
          lecture Backend ne supporte pas encore ce filtre (pas de champ `sens`,
          .strict). Le filtrer côté client casserait la pagination (pages tronquées).
          À ré-activer dès que Backend l'ajoute (tracé TODOS TX-FILTRE1). */}

      {/* Compte — seulement si plusieurs comptes */}
      {comptes.length > 1 && (
        <label className="inline-flex items-center gap-2 text-sm text-text-muted">
          <span className="sr-only">Filtrer par compte</span>
          <select
            value={filtres.bankAccountId ?? ""}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...filtres,
                bankAccountId: e.target.value || undefined,
              })
            }
            className={champSelect}
          >
            <option value="">Tous les comptes</option>
            {comptes.map((c) => (
              <option key={c.bankAccountId} value={c.bankAccountId}>
                {c.nom}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Statut de ventilation */}
      <label className="inline-flex items-center gap-2 text-sm text-text-muted">
        <span className="sr-only">Filtrer par statut de ventilation</span>
        <select
          value={filtres.statutCategorisation ?? ""}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...filtres,
              statutCategorisation:
                (e.target.value as StatutCategorisation) || undefined,
            })
          }
          className={champSelect}
        >
          {OPTIONS_STATUT.map((o) => (
            <option key={o.label} value={o.valeur}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
