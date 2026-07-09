/**
 * Toolbar de filtres de /transactions (UI_GUIDELINES §2.2 toolbar + §2.3).
 * Présentationnelle PURE : reçoit l'état des filtres + les comptes, remonte les
 * changements via `onChange`. Aucun fetch, aucun état interne.
 *
 * - Sens : segmented control (segment actif = pill `ink` blanc, §2.3), pattern
 *   identique aux démos existantes (cohérence).
 * - Compte : affiché UNIQUEMENT s'il y a >1 compte connecté (sinon inutile).
 *   GROUPÉ PAR TITULAIRE (party Omni-FI) dans le popover du `Select` : l'en-tête de
 *   groupe = nom du titulaire, chaque compte apparaît une fois par son `accountName`
 *   à l'intérieur. Résout la « banque noyée » (un titulaire portant des dizaines de
 *   comptes) mieux que le groupement par institution (feedback 0709). En-têtes NON
 *   repliables : on garde la navigation clavier séquentielle du Select (a11y) —
 *   décision Etienne 2026-07-09.
 * - Statut de ventilation : Select (Tout / Non catégorisé / Partiel / Complet).
 *
 * Changer un filtre = le parent recharge la page 1 (reset du curseur).
 */
import { useMemo } from "react";

import { Select } from "@/components/ui/select";
import { grouperParTitulaire } from "@/lib/grouper-titulaire";

import type {
  FiltresTransactions,
  StatutCategorisation,
} from "./types-transactions";

/**
 * Un compte connecté, pour le filtre par compte. Porte `accountName` (option) +
 * `institutionName` (repli si accountName absent) et le TITULAIRE (`holderId`/
 * `holderName`) — clé et libellé de groupe du popover, via `grouperParTitulaire`
 * (satisfait `CompteTitulable`). `holderId`/`holderName` null ⇒ bucket final « Non
 * regroupé ». Fournis par `listerComptes` (via `account_party_role`).
 */
export interface CompteFiltre {
  bankAccountId: string;
  accountName: string;
  institutionName: string | null;
  holderId: string | null;
  holderName: string | null;
}

/** En-tête du bucket des comptes sans titulaire exploitable (fin de liste). */
const GROUPE_SANS_TITULAIRE = "Autres comptes";

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

  // Comptes groupés par TITULAIRE (mémoïsé : ne change qu'avec la liste). L'ordre
  // (nommés → génériques → « Non regroupé ») et la conservation totale (chaque
  // compte 1×) sont garantis par le helper partagé `grouperParTitulaire`.
  const groupesTitulaire = useMemo(() => grouperParTitulaire(comptes), [comptes]);

  // Toolbar de CONTENU (pas le header — le flex-wrap y est acceptable). Rangée
  // homogène : tous les contrôles en `h-10`, gap horizontal + vertical distincts
  // pour un wrap lisible sur petit écran ; les deux bornes de date restent
  // SOLIDAIRES dans leur propre groupe (elles ne se séparent pas au retour ligne).
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* NB : le filtre Sens (Entrées/Sorties) n'est PAS exposé en v1 — le schéma de
          lecture Backend ne supporte pas encore ce filtre (pas de champ `sens`,
          .strict). Le filtrer côté client casserait la pagination (pages tronquées).
          À ré-activer dès que Backend l'ajoute (tracé TODOS TX-FILTRE1). */}

      {/* Compte — seulement si plusieurs comptes, groupés par TITULAIRE. Le
          placeholder « Tous les comptes » s'affiche quand aucun compte n'est filtré
          (value = "" ne matche aucune option). */}
      {comptes.length > 1 && (
        <Select
          ariaLabel="Filtrer par compte"
          placeholder="Tous les comptes"
          value={filtres.bankAccountId ?? ""}
          disabled={disabled}
          onChange={(v) =>
            onChange({ ...filtres, bankAccountId: v || undefined })
          }
          className="max-w-[16rem]"
          groups={[
            { label: "", options: [{ value: "", label: "Tous les comptes" }] },
            ...groupesTitulaire.map((groupe) => ({
              label: groupe.holderName ?? GROUPE_SANS_TITULAIRE,
              options: groupe.comptes.map((c) => ({
                value: c.bankAccountId,
                // accountName en priorité ; repli institutionName si vide/générique,
                // puis libellé neutre — jamais une option sans texte.
                label: c.accountName || c.institutionName || "Compte",
              })),
            })),
          ]}
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
          visuel ; la vraie garde `dateDebut ≤ dateFin` reste côté serveur (Zod).
          Les deux bornes vivent dans UN groupe solidaire : au wrap, elles restent
          ensemble (jamais une borne orpheline sur la ligne suivante). */}
      <div className="inline-flex items-center gap-2">
        <label className="inline-flex items-center text-sm text-text-muted">
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
        <span aria-hidden className="text-text-faint">
          →
        </span>
        <label className="inline-flex items-center text-sm text-text-muted">
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
    </div>
  );
}
