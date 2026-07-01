"use client";

/**
 * CategoryPicker — sélecteur de catégorie (mono) en popover (UI_GUIDELINES §4.4
 * « dropdown riche ») : recherche en tête (focus auto), liste hiérarchique à 2
 * niveaux (Nature racine / Sous-nature indentée 24px), item sélectionné mis en
 * évidence, et — en pied — création rapide d'une catégorie. Sert l'assignation
 * rapide d'UNE catégorie à une transaction.
 *
 * Présentationnel : les catégories arrivent en props (aucun fetch), la sélection
 * remonte via `onSelect`. La CRÉATION remonte via `onCreate` (le conteneur câble
 * la Server Action `creerCategorieAction`) — le picker n'appelle aucun service
 * directement. Pas de dépendance externe (clsx/radix non installés, règle 9) :
 * `cn` local + popover natif.
 *
 * FERMETURE (fix UX) : si `onClose` est fourni (cas popover ouvert depuis un
 * bouton, p. ex. dans SplitAllocationModal), le picker se ferme au CLIC EXTÉRIEUR
 * et à la touche ÉCHAP — pour ne plus bloquer l'utilisateur. L'Échap fait un
 * stopPropagation : il ferme le picker SANS fermer une éventuelle modale parente
 * (qui écoute aussi Escape). Sans `onClose` (démo statique), aucune fermeture
 * auto (le picker reste monté).
 *
 * Seules les catégories ACTIVES sont proposées (le conteneur filtre `isActive`,
 * mais on re-garde ici par sûreté). Une catégorie archivée reste visible sur les
 * splits existants (via CategoryBadge), elle n'est juste plus proposée.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { CategorieUI, ResultatAction } from "./types";
import { CategoryBadge } from "./category-badge";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Regroupe une liste plate en arbre Nature → Sous-natures (profondeur 2). */
function grouperParNature(categories: CategorieUI[]): Array<{
  nature: CategorieUI;
  sousNatures: CategorieUI[];
}> {
  const racines = categories.filter((c) => c.parentId === null);
  return racines.map((nature) => ({
    nature,
    sousNatures: categories.filter((c) => c.parentId === nature.id),
  }));
}

export function CategoryPicker({
  categories,
  selectedId,
  onSelect,
  onClose,
  onCreate,
  placeholder = "Rechercher une catégorie…",
}: {
  /** Référentiel (à plat). Le composant regroupe en Nature/Sous-nature. */
  categories: CategorieUI[];
  /** Catégorie actuellement assignée (mise en évidence), si une. */
  selectedId?: string | null;
  /** Remonte l'id choisi au conteneur (qui appelle l'action serveur). */
  onSelect: (categoryId: string) => void;
  /**
   * Demande de fermeture (clic-extérieur / Échap). Si absent, le picker ne se
   * ferme pas tout seul (cas démo où il est monté en permanence).
   */
  onClose?: () => void;
  /**
   * Crée une NOUVELLE catégorie (Nature racine : parentId null côté conteneur).
   * Absent → le bouton « Ajouter une catégorie » n'est pas rendu. Au succès, la
   * nouvelle catégorie est immédiatement sélectionnée.
   */
  onCreate?: (name: string) => Promise<ResultatAction<{ categoryId: string }>>;
  placeholder?: string;
}) {
  const [recherche, setRecherche] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const conteneurRef = useRef<HTMLDivElement>(null);

  // Fermeture : clic-extérieur (mousedown, sur document) + Échap. Les deux
  // seulement si le conteneur veut bien fermer (`onClose`).
  useEffect(() => {
    if (!onClose) return;
    const conteneur = conteneurRef.current;

    function onPointerDown(e: MouseEvent) {
      // `mousedown` (pas `click`) : ferme dès l'appui, avant qu'un focus/clic
      // interne n'altère la cible.
      if (conteneur && !conteneur.contains(e.target as Node)) {
        onClose?.();
      }
    }
    function onKeyDownCapture(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Capture sur `document` : on s'exécute AVANT le handler bubble d'une
      // modale parente (qui écoute aussi Escape sur `document`). Si l'Échap vient
      // de l'intérieur du picker, on le consomme ENTIÈREMENT
      // (stopImmediatePropagation) → la modale ne le voit pas et reste ouverte.
      // C'est le cœur du fix (la modale est rendue dans un portail : on ne peut
      // pas se reposer sur le seul bubbling DOM via le conteneur).
      const cible = e.target as Node | null;
      if (conteneur && cible && conteneur.contains(cible)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose?.();
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDownCapture, true);
    };
  }, [onClose]);

  // Filtre actives + correspondance recherche (sur le nom, insensible casse/accents).
  const filtrees = useMemo(() => {
    const q = recherche.trim().toLocaleLowerCase("fr");
    const actives = categories.filter((c) => c.isActive);
    if (!q) return actives;
    return actives.filter((c) => c.name.toLocaleLowerCase("fr").includes(q));
  }, [categories, recherche]);

  const groupes = useMemo(() => grouperParNature(filtrees), [filtrees]);
  const aucunResultat = filtrees.length === 0;

  return (
    <div
      ref={conteneurRef}
      className="w-[320px] rounded-control bg-surface-card p-2 shadow-popover"
    >
      {/* Recherche en tête (§4.4 : focus auto) */}
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={recherche}
        onChange={(e) => setRecherche(e.target.value)}
        placeholder={placeholder}
        className="mb-2 w-full rounded-control border border-line bg-surface-inset
          px-3 py-2 text-sm text-text placeholder:text-text-faint
          focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary
          focus:ring-offset-0"
        aria-label="Rechercher une catégorie"
      />

      <div role="listbox" className="max-h-72 overflow-y-auto pb-1" aria-label="Catégories">
        {aucunResultat ? (
          <p className="px-2 py-6 text-center text-sm text-text-muted">
            Aucune catégorie ne correspond.
          </p>
        ) : (
          groupes.map(({ nature, sousNatures }) => (
            <div key={nature.id} className="mb-1">
              {/* Ligne Nature (racine) — sélectionnable elle-même */}
              <ItemCategorie
                categorie={nature}
                selectionne={selectedId === nature.id}
                onSelect={onSelect}
              />
              {/* Sous-natures indentées 24px (§4.4) */}
              {sousNatures.map((sn) => (
                <ItemCategorie
                  key={sn.id}
                  categorie={sn}
                  indent
                  selectionne={selectedId === sn.id}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* Pied : création rapide d'une catégorie (si le conteneur la câble). */}
      {onCreate && (
        <CreationCategorie
          nomInitial={recherche}
          onCreate={onCreate}
          onCree={(categoryId) => {
            onSelect(categoryId);
            onClose?.();
          }}
        />
      )}
    </div>
  );
}

function ItemCategorie({
  categorie,
  selectionne,
  indent = false,
  onSelect,
}: {
  categorie: CategorieUI;
  selectionne: boolean;
  indent?: boolean;
  onSelect: (categoryId: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selectionne}
      onClick={() => onSelect(categorie.id)}
      className={cn(
        "flex w-full cursor-pointer items-center rounded-control px-2 py-1.5 text-left transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        indent && "pl-6",
        selectionne ? "bg-primary-50" : "hover:bg-surface-inset",
      )}
    >
      <CategoryBadge name={categorie.name} colorKey={categorie.id} size="sm" />
      {selectionne && (
        <span aria-hidden className="ml-auto text-xs font-semibold text-primary">
          ✓
        </span>
      )}
    </button>
  );
}

/**
 * Bloc de création inline en pied de picker. Mode replié = bouton « + Ajouter une
 * catégorie » ; déplié = champ + Créer/Annuler. Pré-rempli avec la recherche en
 * cours (créer ce qu'on cherchait sans le retaper). Erreur affichée inline.
 */
function CreationCategorie({
  nomInitial,
  onCreate,
  onCree,
}: {
  nomInitial: string;
  onCreate: (name: string) => Promise<ResultatAction<{ categoryId: string }>>;
  onCree: (categoryId: string) => void;
}) {
  const [deplie, setDeplie] = useState(false);
  const [nom, setNom] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const champRef = useRef<HTMLInputElement>(null);

  function ouvrir() {
    setNom(nomInitial.trim());
    setErreur(null);
    setDeplie(true);
    // Focus le champ au prochain tick (après rendu).
    requestAnimationFrame(() => champRef.current?.focus());
  }

  function annuler() {
    setDeplie(false);
    setNom("");
    setErreur(null);
  }

  async function soumettre() {
    const valeur = nom.trim();
    if (valeur === "" || enCours) return;
    setEnCours(true);
    setErreur(null);
    try {
      const res = await onCreate(valeur);
      if (res.ok) {
        annuler();
        onCree(res.data.categoryId);
      } else {
        setErreur(res.message);
      }
    } catch {
      setErreur("La création a échoué. Réessayez.");
    } finally {
      setEnCours(false);
    }
  }

  if (!deplie) {
    return (
      <div className="mt-2 border-t border-line pt-2">
        <button
          type="button"
          onClick={ouvrir}
          className="flex w-full cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-left
            text-sm font-medium text-primary transition-colors hover:bg-primary-50
            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span aria-hidden className="text-base leading-none">+</span>
          Ajouter une catégorie
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="flex items-center gap-2">
        <input
          ref={champRef}
          type="text"
          value={nom}
          maxLength={120}
          disabled={enCours}
          onChange={(e) => setNom(e.target.value)}
          onKeyDown={(e) => {
            // Échap/Entrée gérés ici sans remonter (ne ferme pas le picker).
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void soumettre();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              annuler();
            }
          }}
          placeholder="Nom de la catégorie"
          aria-label="Nom de la nouvelle catégorie"
          className="h-9 min-w-0 flex-1 rounded-control border border-line bg-surface-inset px-3
            text-sm text-text placeholder:text-text-faint focus:border-primary
            focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-48"
        />
        <button
          type="button"
          onClick={() => void soumettre()}
          disabled={nom.trim() === "" || enCours}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-control bg-primary
            px-3 text-sm font-semibold text-text-onink transition-colors hover:bg-primary-600
            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
            disabled:cursor-not-allowed disabled:opacity-48"
        >
          {enCours ? "…" : "Créer"}
        </button>
        <button
          type="button"
          onClick={annuler}
          disabled={enCours}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-control px-2 text-sm
            font-medium text-text-muted transition-colors hover:text-text
            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
            disabled:cursor-not-allowed disabled:opacity-48"
        >
          Annuler
        </button>
      </div>
      {erreur && (
        <p role="alert" className="mt-1.5 px-1 text-xs text-danger">
          {erreur}
        </p>
      )}
    </div>
  );
}
