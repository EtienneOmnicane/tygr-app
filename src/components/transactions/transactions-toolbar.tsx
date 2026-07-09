"use client";

/**
 * Toolbar de filtres de /transactions (UI_GUIDELINES §2.2 toolbar + §2.3).
 * Présentationnelle : reçoit l'état des filtres + les comptes, remonte les
 * changements via `onChange`. Aucun fetch. Un SEUL état interne : le TAMPON de
 * saisie de la recherche (débouncé) — l'affichage suit la frappe sans attendre le
 * re-render du parent ; le filtre APPLIQUÉ reste piloté par le parent (source de
 * vérité). D'où la directive `"use client"` (hooks React pour le debounce).
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
 *
 * Recherche : input contrôlé sur le libellé nettoyé (`cleanLabel` serveur, jamais
 * bank_label_raw — PII). L'affichage est immédiat (état LOCAL au frappé), mais
 * `onChange` est DÉBOUNCÉ ~300 ms → une seule requête après la fin de saisie (pas
 * une par touche). Vide → `recherche: undefined` (jamais chaîne vide : le Zod
 * `min(1)` la rejetterait). Le terme reste en état mémoire, JAMAIS dans l'URL (pas
 * de fuite du libellé dans l'historique navigateur — règle 8).
 */
import { useEffect, useRef, useState } from "react";

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

/** Délai de debounce du champ de recherche (ms) : temps de frappe avant requête. */
const DEBOUNCE_RECHERCHE_MS = 300;
/** Longueur max de saisie, alignée sur `listerTransactionsSchema.recherche` (max 120). */
const RECHERCHE_MAX = 120;

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

  // Texte de recherche en état LOCAL : l'affichage suit la frappe SANS attendre le
  // re-render du parent (qui n'arrive qu'après la requête). Le parent reste la source
  // de vérité du filtre appliqué ; ce state n'est que le tampon d'entrée débouncé.
  const [termeSaisi, setTermeSaisi] = useState(filtres.recherche ?? "");
  // Dernière valeur normalisée qu'on a nous-même émise via onChange — sert à ne PAS
  // écraser la frappe en cours quand le parent renvoie ce que nous venons d'émettre.
  const dernierEmis = useRef<string | undefined>(filtres.recherche);
  // Miroir TOUJOURS À JOUR des filtres/onChange courants. Un timer de debounce armé
  // capture le render où il a été posé ; sans ce ref, il fusionnerait sur un `filtres`
  // PÉRIMÉ et écraserait un filtre (compte/statut/date) que l'utilisateur aurait
  // changé pendant la fenêtre de 300 ms (perte silencieuse de filtre). On lit donc
  // `filtresRef.current`/`onChangeRef.current` AU MOMENT du tir → l'émission fusionne
  // toujours sur les filtres réellement appliqués à cet instant. Mise à jour en effet
  // (post-commit) : interdit d'écrire un ref pendant le render (React Compiler) ; le
  // timer tire toujours APRÈS un commit, donc le ref est à jour au moment du tir.
  const filtresRef = useRef(filtres);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    filtresRef.current = filtres;
    onChangeRef.current = onChange;
  });

  // Resynchronise l'input si le filtre change à la SOURCE (parent), p. ex. un reset
  // externe des filtres — mais pas quand le parent ne fait que refléter notre propre
  // émission (sinon on interromprait la frappe). On compare à `dernierEmis`.
  useEffect(() => {
    if (filtres.recherche !== dernierEmis.current) {
      dernierEmis.current = filtres.recherche;
      setTermeSaisi(filtres.recherche ?? "");
    }
  }, [filtres.recherche]);

  // Debounce : émet `onChange` ~300 ms après la dernière frappe. Chaîne vide (ou
  // uniquement des espaces) → `recherche: undefined` (jamais "" : Zod min(1) la
  // rejette). N'émet QUE si la valeur normalisée diffère de la dernière émise (évite
  // une requête redondante quand la valeur revient à l'identique après debounce).
  useEffect(() => {
    const normalise = termeSaisi.trim() === "" ? undefined : termeSaisi.trim();
    if (normalise === dernierEmis.current) return;
    const t = setTimeout(() => {
      dernierEmis.current = normalise;
      // Fusionne sur les filtres COURANTS (ref), pas sur le snapshot capturé : évite
      // d'écraser un filtre modifié pendant la fenêtre de debounce (cf. filtresRef).
      onChangeRef.current({ ...filtresRef.current, recherche: normalise });
    }, DEBOUNCE_RECHERCHE_MS);
    return () => clearTimeout(t);
    // Deps = [termeSaisi] seul : on ré-arme le timer UNIQUEMENT sur une nouvelle frappe.
    // `filtres`/`onChange` ne sont pas référencés dans l'effet (lus via refs à l'émission),
    // donc pas de re-run en boucle ni de stale closure — l'exhaustive-deps est satisfait.
  }, [termeSaisi]);

  function effacerRecherche() {
    setTermeSaisi("");
    // Émission immédiate (pas de debounce à l'effacement explicite) : réactivité du ×.
    // Via les refs (cohérent avec le timer) : fusionne sur les filtres courants.
    if (dernierEmis.current !== undefined) {
      dernierEmis.current = undefined;
      onChangeRef.current({ ...filtresRef.current, recherche: undefined });
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-3">
      {/* NB : le filtre Sens (Entrées/Sorties) n'est PAS exposé en v1 — le schéma de
          lecture Backend ne supporte pas encore ce filtre (pas de champ `sens`,
          .strict). Le filtrer côté client casserait la pagination (pages tronquées).
          À ré-activer dès que Backend l'ajoute (tracé TODOS TX-FILTRE1). */}

      {/* Recherche par libellé — porte sur cleanLabel serveur (ILIKE), débounce
          ~300 ms (état local `termeSaisi`). Loupe décorative, croix d'effacement
          conditionnelle. maxLength borné (garde d'UI ; le serveur reste la vraie garde). */}
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          type="text"
          inputMode="search"
          value={termeSaisi}
          maxLength={RECHERCHE_MAX}
          disabled={disabled}
          onChange={(e) => setTermeSaisi(e.target.value)}
          placeholder="Rechercher un libellé…"
          aria-label="Rechercher un libellé de transaction"
          className={champSelect + " w-56 pl-9 " + (termeSaisi ? "pr-9" : "")}
        />
        {termeSaisi && (
          <button
            type="button"
            onClick={effacerRecherche}
            disabled={disabled}
            aria-label="Effacer la recherche"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer
              items-center justify-center rounded-control text-text-muted transition-colors
              hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
              disabled:cursor-not-allowed disabled:opacity-[0.48]"
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

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
