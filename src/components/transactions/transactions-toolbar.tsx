/**
 * Toolbar de filtres de /transactions (UI_GUIDELINES §2.2 toolbar + §2.3).
 * Présentationnelle PURE : reçoit l'état des filtres + les comptes, remonte les
 * changements via `onChange`. Aucun fetch, aucun état interne.
 *
 * - Sens : segmented control (segment actif = pill `ink` blanc, §2.3), pattern
 *   identique aux démos existantes (cohérence).
 * - Compte : affiché UNIQUEMENT s'il y a >1 compte connecté (sinon inutile).
 *   GROUPÉ PAR INSTITUTION (<optgroup>) : un même établissement (« Bank One »)
 *   ne se répète plus N fois — il devient l'en-tête de groupe, et chaque compte
 *   apparaît une fois par son `accountName` à l'intérieur (ergonomie, 2026-06-22).
 * - Statut de ventilation : select natif (Tout / Non catégorisé / Partiel / Complet).
 *
 * Changer un filtre = le parent recharge la page 1 (reset du curseur).
 */
import { useMemo } from "react";

import type {
  FiltresTransactions,
  StatutCategorisation,
} from "./types-transactions";

/**
 * Un compte connecté, pour le filtre par compte. On porte `accountName` ET
 * `institutionName` (et non plus un `nom` pré-résolu) pour pouvoir GROUPER par
 * établissement dans le select : l'institution devient l'`<optgroup>`, le compte
 * l'`<option>`. `institutionName` peut être nul (banque inconnue → groupe
 * « Autres comptes »).
 */
export interface CompteFiltre {
  bankAccountId: string;
  accountName: string;
  institutionName: string | null;
}

/** Libellé du groupe pour les comptes sans institution résolue. */
const GROUPE_SANS_INSTITUTION = "Autres comptes";

/**
 * Regroupe les comptes par institution en PRÉSERVANT l'ordre d'arrivée (le
 * serveur les trie déjà par `accountName` ; on ne réordonne pas). Chaque
 * institution rencontrée crée un groupe ; les comptes sans institution tombent
 * dans un groupe « Autres comptes » placé selon sa 1re occurrence.
 */
function grouperParInstitution(
  comptes: CompteFiltre[],
): Array<{ institution: string; comptes: CompteFiltre[] }> {
  const groupes: Array<{ institution: string; comptes: CompteFiltre[] }> = [];
  const index = new Map<string, number>();
  for (const compte of comptes) {
    const cle = compte.institutionName ?? GROUPE_SANS_INSTITUTION;
    let pos = index.get(cle);
    if (pos === undefined) {
      pos = groupes.length;
      index.set(cle, pos);
      groupes.push({ institution: cle, comptes: [] });
    }
    groupes[pos].comptes.push(compte);
  }
  return groupes;
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

  // Comptes groupés par établissement (mémoïsé : ne change qu'avec la liste).
  const groupes = useMemo(() => grouperParInstitution(comptes), [comptes]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* NB : le filtre Sens (Entrées/Sorties) n'est PAS exposé en v1 — le schéma de
          lecture Backend ne supporte pas encore ce filtre (pas de champ `sens`,
          .strict). Le filtrer côté client casserait la pagination (pages tronquées).
          À ré-activer dès que Backend l'ajoute (tracé TODOS TX-FILTRE1). */}

      {/* Compte — seulement si plusieurs comptes, groupés par institution */}
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
            {groupes.map((groupe) => (
              <optgroup key={groupe.institution} label={groupe.institution}>
                {groupe.comptes.map((c) => (
                  <option key={c.bankAccountId} value={c.bankAccountId}>
                    {c.accountName}
                  </option>
                ))}
              </optgroup>
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
