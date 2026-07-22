"use client";

/**
 * LigneCategorie — une entrée du référentiel dans `CategoryManagerModal`, en TROIS
 * modes exclusifs : lecture / édition (renommage) / confirmation d'archivage.
 *
 * Composant CONTRÔLÉ : le mode ne vit pas ici mais dans l'orchestrateur, qui n'en
 * autorise qu'UN SEUL actif dans toute la modale. Raison : replier un accordéon ou
 * filtrer la liste démonterait une ligne qui porterait son propre mode, et la saisie
 * disparaîtrait sans que personne ne sache où elle est passée. L'état vit au-dessus,
 * les transitions sont donc explicites et annonçables.
 *
 * Trois invariants d'accessibilité, chacun corrigeant un défaut mesuré en revue :
 *
 * 1. **Escape est intercepté sur le CONTENEUR de ligne**, pas sur le champ. Un handler
 *    posé sur l'`<input>` ne voit rien quand le focus est sur « Enregistrer », et le
 *    mode confirmation n'a AUCUN champ sur quoi l'accrocher — Escape fermait alors la
 *    modale entière et perdait le geste. `stopPropagation` suffit à confiner la touche :
 *    React délègue `keydown` sur le conteneur du portail (`document.body`), qui est un
 *    descendant strict du `document` où `Modal` écoute. ⚠️ Deux conditions invisibles :
 *    le portail doit rester sous `document`, et l'écoute de `Modal` rester en phase
 *    BUBBLE — la passer en capture casserait ceci sans qu'aucun test ne rougisse.
 *
 * 2. **`aria-disabled` plutôt que `disabled`** pendant une action en vol. Un `disabled`
 *    posé sur le bouton que l'utilisateur vient d'activer lui arrache le focus (il part
 *    sur `<body>`) et sort l'élément de l'arbre d'accessibilité : plus rien n'est
 *    annoncé, et le focus trap de `Modal` ne rattrape pas `<body>`. Le garde
 *    anti-double-soumission est conservé, mais côté handler.
 *
 * 3. **Aucune sortie de mode ne laisse le focus orphelin** : quitter l'édition rend le
 *    focus au bouton « Renommer » de la même ligne. La destination après archivage
 *    (la ligne n'existe plus) est décidée par l'orchestrateur.
 *
 * Les actions ne sont révélées au survol que sur pointeur FIN (`pointer-fine`), jamais
 * sur un simple seuil de largeur : un iPad en paysage ou un laptop tactile matchent
 * `md:` sans avoir de survol, et les boutons y resteraient invisibles pour toujours.
 */
import { useEffect, useId, useRef } from "react";

import { cn } from "@/components/ui/states";

import { CategoryBadge } from "./category-badge";
import type { CategorieUI } from "./types";

/** Longueur max d'un nom (aligné varchar(120) + zod nomCategorie). */
const NOM_MAX = 120;

/** Mode d'une ligne. Un seul est actif dans toute la modale (cf. docstring). */
export type ModeLigne = "lecture" | "edition" | "confirmation";

export function LigneCategorie({
  categorie,
  mode,
  nomEdite,
  onNomEdite,
  onOuvrirEdition,
  onOuvrirConfirmation,
  onAnnulerMode,
  onRenommer,
  onArchiver,
  estDoublon,
  enCours,
  inerte,
  erreur,
}: {
  categorie: CategorieUI;
  mode: ModeLigne;
  /** Valeur du champ de renommage (portée par l'orchestrateur, cf. docstring). */
  nomEdite: string;
  onNomEdite: (valeur: string) => void;
  onOuvrirEdition: () => void;
  onOuvrirConfirmation: () => void;
  /** Quitte le mode courant (Annuler, Escape, repli du groupe). */
  onAnnulerMode: () => void;
  onRenommer: () => void;
  onArchiver: () => void;
  /** Pré-validation locale du doublon insensible à la casse (le serveur reste juge). */
  estDoublon: (nom: string) => boolean;
  /** Une action est en vol : les gestes sont neutralisés sans perdre le focus. */
  enCours: boolean;
  /**
   * Ligne mutée dont le rafraîchissement parent n'est pas encore arrivé. Sans ça, la
   * ligne archivée reste cliquable pendant le rechargement et un second clic répond
   * « Catégorie introuvable » à propos d'un geste qui a pourtant RÉUSSI.
   */
  inerte: boolean;
  /** Erreur serveur rattachée à CETTE ligne (rendue au contact du geste). */
  erreur?: React.ReactNode;
}) {
  const champRef = useRef<HTMLInputElement>(null);
  const boutonRenommerRef = useRef<HTMLButtonElement>(null);
  const modePrecedentRef = useRef<ModeLigne>(mode);
  const idErreurDoublon = useId();

  const nomNettoye = nomEdite.trim();
  const inchange = nomNettoye === categorie.name;
  const doublon = !inchange && estDoublon(nomNettoye);
  const peutEnregistrer = nomNettoye.length > 0 && !doublon && !enCours;
  const neutralise = enCours || inerte;

  // Focus dirigé à CHAQUE transition de mode : entrer en édition sélectionne le nom
  // (on retape par-dessus) ; en sortir rend le focus au bouton d'origine plutôt que
  // de le laisser tomber sur <body> quand le bouton cliqué se démonte sous le doigt.
  //
  // ⚠️ SAUF après un archivage réussi (`inerte`) : cette ligne est en sursis et va
  // disparaître au rafraîchissement. Sans cette garde, l'effet — qui s'exécute APRÈS
  // le rendu — écrase l'ancre de focus posée par l'orchestrateur et remet le focus sur
  // un bouton condamné, donc sur <body> une phrase plus tard. Mesuré au Gate 4, pas
  // déduit : les deux acteurs veulent placer le focus, et c'est l'effet qui gagne.
  useEffect(() => {
    const precedent = modePrecedentRef.current;
    modePrecedentRef.current = mode;
    if (mode === precedent) return;
    if (mode === "edition") champRef.current?.select();
    else if (precedent !== "lecture" && mode === "lecture" && !inerte) {
      boutonRenommerRef.current?.focus();
    }
  }, [mode, inerte]);

  function surTouche(e: React.KeyboardEvent<HTMLDivElement>) {
    // Escape referme le mode LOCAL sans laisser `Modal` fermer toute la surface.
    if (e.key === "Escape" && mode !== "lecture") {
      e.preventDefault();
      e.stopPropagation();
      onAnnulerMode();
    }
  }

  return (
    <div
      onKeyDown={surTouche}
      className={cn(
        "group rounded-control px-2 py-1.5 transition-colors",
        mode === "lecture" && "hover:bg-surface-inset",
        // La confirmation ne prend PAS de fond `danger-bg`, pour deux raisons mesurées
        // à la capture : (1) le `Callout` d'erreur serveur s'y rend et son fond teinté —
        // le signal même exigé par §3.4 — devenait invisible sur un conteneur de la
        // même teinte ; (2) un aplat rouge sur-dramatise un geste RÉVERSIBLE. Le rang
        // destructif reste porté par le bouton « Archiver » en texte `danger` (§2.3).
        mode === "confirmation" && "bg-surface-inset",
        inerte && "opacity-48",
      )}
    >
      {mode === "edition" ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              ref={champRef}
              type="text"
              value={nomEdite}
              maxLength={NOM_MAX}
              onChange={(e) => onNomEdite(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (peutEnregistrer) onRenommer();
                }
              }}
              aria-label={`Nouveau nom pour ${categorie.name}`}
              aria-invalid={doublon}
              aria-describedby={doublon ? idErreurDoublon : undefined}
              className={cn(
                "h-9 min-w-0 flex-1 rounded-control border bg-surface-inset px-3 text-sm text-text",
                "placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary",
                doublon ? "border-danger" : "border-line focus:border-primary",
              )}
            />
            <button
              type="button"
              onClick={() => {
                if (peutEnregistrer) onRenommer();
              }}
              aria-disabled={!peutEnregistrer}
              className={cn(
                `inline-flex h-9 shrink-0 items-center rounded-control bg-primary px-3 text-sm
                 font-semibold text-text-onink transition-colors focus:outline-none
                 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`,
                peutEnregistrer ? "cursor-pointer hover:bg-primary-600" : "cursor-not-allowed opacity-48",
              )}
            >
              Enregistrer
            </button>
            <button
              type="button"
              onClick={onAnnulerMode}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-control px-2
                text-sm font-medium text-text-muted transition-colors hover:text-text
                focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Annuler
            </button>
          </div>
          {doublon && (
            // Pas de role="alert" : le texte contient le nom saisi, donc il se
            // ré-annoncerait à CHAQUE frappe en s'interrompant lui-même. C'est la
            // description du champ (aria-describedby), pas une alerte.
            <p id={idErreurDoublon} className="px-1 text-xs text-danger">
              Une catégorie « {nomNettoye} » existe déjà à ce niveau.
            </p>
          )}
        </div>
      ) : mode === "confirmation" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-text">
            Archiver «&nbsp;{categorie.name}&nbsp;» ?{" "}
            <span className="text-text-muted">
              Elle disparaîtra des listes de choix ; l’historique est conservé.
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                if (!neutralise) onArchiver();
              }}
              aria-disabled={neutralise}
              // Rang DESTRUCTIF §2.3 = traitement TEXTE, pas un bouton plein : un
              // second aplat saturé face au vert « Créer » effacerait la hiérarchie,
              // et l'archivage est réversible (is_active=false, jamais de suppression).
              className={cn(
                `inline-flex h-8 items-center rounded-control px-3 text-sm font-semibold
                 text-danger transition-colors focus:outline-none focus-visible:ring-2
                 focus-visible:ring-danger focus-visible:ring-offset-2`,
                neutralise ? "cursor-not-allowed opacity-48" : "cursor-pointer hover:bg-danger-bg",
              )}
            >
              Archiver
            </button>
            <button
              type="button"
              onClick={onAnnulerMode}
              className="inline-flex h-8 cursor-pointer items-center rounded-control px-3 text-sm
                font-medium text-text-muted transition-colors hover:text-text focus:outline-none
                focus-visible:ring-2 focus-visible:ring-primary"
            >
              Annuler
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <CategoryBadge name={categorie.name} colorKey={categorie.id} size="sm" />
          {/*
            Révélation au survol RÉSERVÉE au pointeur fin. `opacity-0` (et non `hidden`)
            préserve la focusabilité ; `group-focus-within` évite que le clavier cible un
            bouton invisible ; le `opacity-100` de base garde les actions atteignables
            partout où le survol n'existe pas.
          */}
          <div
            className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity
              pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100
              pointer-fine:group-hover:opacity-100"
          >
            <BoutonIcone
              ref={boutonRenommerRef}
              label={`Renommer la catégorie ${categorie.name}`}
              onClick={onOuvrirEdition}
              neutralise={neutralise}
            >
              <path
                d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5.5 12.5 2.5 13.5l1-3 8-8Z"
                strokeLinejoin="round"
              />
            </BoutonIcone>
            <BoutonIcone
              label={`Archiver la catégorie ${categorie.name}`}
              onClick={onOuvrirConfirmation}
              neutralise={neutralise}
              danger
            >
              <rect x="2.25" y="3" width="11.5" height="3" rx="0.75" />
              <path d="M3.25 6.5v6.25a.75.75 0 0 0 .75.75h8a.75.75 0 0 0 .75-.75V6.5" />
              <path d="M6.5 9.25h3" strokeLinecap="round" />
            </BoutonIcone>
          </div>
        </div>
      )}
      {erreur}
    </div>
  );
}

/**
 * Bouton-icône 32×32 (WCAG 2.2 SC 2.5.8 : 24×24 minimum, marge gardée). Le libellé
 * n'est JAMAIS l'icône seule : `aria-label` nomme la catégorie, pour que « Archiver »
 * reste compréhensible lu hors de son contexte visuel.
 */
function BoutonIcone({
  ref,
  label,
  onClick,
  neutralise,
  danger,
  children,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  onClick: () => void;
  neutralise: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        if (!neutralise) onClick();
      }}
      aria-disabled={neutralise}
      title={label}
      aria-label={label}
      className={cn(
        `inline-flex h-8 w-8 items-center justify-center rounded-control text-text-muted
         transition-colors focus:outline-none focus-visible:opacity-100 focus-visible:ring-2
         focus-visible:ring-primary focus-visible:ring-offset-1`,
        neutralise
          ? "cursor-not-allowed opacity-48"
          : cn("cursor-pointer", danger ? "hover:bg-danger-bg hover:text-danger" : "hover:bg-surface-inset hover:text-primary"),
      )}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        className="h-4 w-4"
      >
        {children}
      </svg>
    </button>
  );
}
