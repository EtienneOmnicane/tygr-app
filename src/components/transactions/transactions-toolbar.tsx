"use client";

/**
 * Toolbar de /transactions (UI_GUIDELINES §1.1 « filtres à gauche · actions à
 * droite », §2.2 toolbar h-10 gap-12, §2.3 hiérarchie de boutons).
 *
 * Présentationnelle : reçoit l'état des filtres, remonte les changements via
 * `onChange`. Aucun fetch, aucun état MÉTIER. Un SEUL état interne : le TAMPON de
 * saisie de la recherche (débouncé) — l'affichage suit la frappe sans attendre le
 * re-render du parent ; le filtre APPLIQUÉ reste piloté par le parent (source de
 * vérité). D'où la directive `"use client"` (hooks React pour le debounce).
 *
 * - Le périmètre de comptes/entités est piloté GLOBALEMENT par le `PerimetreSwitcher`
 *   de la navbar (topbar) → scope serveur via `withWorkspace`/RLS. La toolbar ne
 *   duplique DONC PLUS de sélecteur de compte (retrait feedback 0709 : doublon moche
 *   du sélecteur navbar).
 * - Recherche par libellé (débouncée) et statut de ventilation. La FENÊTRE DE DATES
 *   ne vit plus ici : elle est portée par la barre de vue GLOBALE (`?periode`/`?du`/
 *   `?au`, `resoudrePeriode`), source unique, injectée côté serveur (TX-TOOLBAR-DEDUP1).
 * - Action secondaire à DROITE : « Gérer les catégories » (ADMIN seul). Elle vit ICI
 *   plutôt qu'en bouton orphelin au-dessus du tableau → une seule barre d'actions
 *   cohérente. La toolbar ne connaît PAS la garde de rôle : elle rend simplement le
 *   bouton si le parent lui passe `onOuvrirGestionCategories` (absent ⇒ surface
 *   ABSENTE du DOM, cf. règle D2 — le parent seul décide, le serveur reste la garde).
 *
 * Changer un filtre = le parent recharge la page 1 (reset du curseur).
 *
 * Recherche : input contrôlé sur le libellé nettoyé (`cleanLabel` serveur, jamais
 * bank_label_raw — PII). L'affichage est immédiat (état LOCAL au frappé), mais
 * `onChange` est DÉBOUNCÉ ~300 ms → une seule requête après la fin de saisie (pas
 * une par touche). Vide → `recherche: undefined` (jamais chaîne vide : le Zod
 * `min(1)` la rejetterait). Le terme reste en état mémoire, JAMAIS dans l'URL (pas
 * de fuite du libellé dans l'historique navigateur — règle 8).
 *
 * Responsive : la rangée ne `flex-wrap` JAMAIS (interdit sur un header, cf. CLAUDE.md
 * « Responsive header »). Sous `lg`, elle se CONDENSE : le libellé du bouton d'action
 * disparaît au profit de la seule icône, et le groupe de filtres devient scrollable
 * horizontalement plutôt que de casser la ligne.
 */
import { useEffect, useRef, useState } from "react";

import { Select } from "@/components/ui/select";

import type {
  FiltresTransactions,
  StatutCategorisation,
} from "./types-transactions";

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
  onChange,
  disabled = false,
  onOuvrirGestionCategories,
}: {
  filtres: FiltresTransactions;
  onChange: (filtres: FiltresTransactions) => void;
  /** Désactive les contrôles pendant un chargement. */
  disabled?: boolean;
  /**
   * Ouvre le gestionnaire de catégories. Fourni UNIQUEMENT quand l'utilisateur a le
   * droit d'administrer le référentiel (le parent le dérive de `actionsReferentiel`,
   * lui-même ADMIN-only). Absent ⇒ le bouton n'est pas rendu du tout (surface absente
   * du DOM, pas simplement grisée).
   */
  onOuvrirGestionCategories?: () => void;
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
  // PÉRIMÉ et écraserait un filtre (statut/date) que l'utilisateur aurait changé
  // pendant la fenêtre de 300 ms (perte silencieuse de filtre). On lit donc
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
    // `justify-between` : filtres à gauche, actions à droite (§1.1). JAMAIS de
    // `flex-wrap` — sous le breakpoint, le groupe de filtres défile horizontalement
    // et l'action se condense en icône seule, plutôt que de casser la rangée.
    <div className="flex items-center justify-between gap-3">
      {/* NB : le filtre Sens (Entrées/Sorties) n'est PAS exposé en v1 — le schéma de
          lecture Backend ne supporte pas encore ce filtre (pas de champ `sens`,
          .strict). Le filtrer côté client casserait la pagination (pages tronquées).
          À ré-activer dès que Backend l'ajoute (tracé TODOS TX-FILTRE1). */}

      {/* Groupe FILTRES (gauche). `min-w-0` + `overflow-x-auto` : sous le breakpoint,
          les contrôles défilent au lieu de passer à la ligne. `shrink-0` sur chaque
          contrôle pour qu'aucun ne s'écrase. */}
      <div className="flex min-w-0 items-center gap-3 overflow-x-auto">
        {/* Recherche par libellé — porte sur cleanLabel serveur (ILIKE), débounce
            ~300 ms (état local `termeSaisi`). Loupe décorative, croix d'effacement
            conditionnelle. maxLength borné (garde d'UI ; le serveur reste la vraie garde). */}
        <div className="relative shrink-0">
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

        {/* Statut de ventilation */}
        <div className="shrink-0">
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
        </div>
      </div>

      {/* Groupe ACTIONS (droite) — ADMIN seul (le parent ne passe la closure qu'à
          l'admin). Bouton SECONDAIRE (§2.3 : bordure `line`, fond `surface-card`) en
          h-10 pour s'aligner sur les contrôles de la rangée (§2.2). Sous `lg`, le
          libellé se masque : l'icône seule condense la rangée sans wrap. `shrink-0`
          garantit que l'action n'est jamais écrasée par les filtres. */}
      {onOuvrirGestionCategories && (
        <button
          type="button"
          onClick={onOuvrirGestionCategories}
          title="Gérer les catégories"
          className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-control
            border border-line bg-surface-card px-3 text-sm font-medium text-text
            transition-colors hover:bg-surface-inset focus:outline-none
            focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-4 w-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0
                 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65
                 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65
                 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2
                 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1
                 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65
                 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            />
          </svg>
          {/* Le libellé disparaît sous `lg` (condensation) ; `title` + `sr-only`
              gardent l'action nommée pour le lecteur d'écran et l'infobulle. */}
          <span className="hidden lg:inline">Gérer les catégories</span>
          <span className="sr-only lg:hidden">Gérer les catégories</span>
        </button>
      )}
    </div>
  );
}
