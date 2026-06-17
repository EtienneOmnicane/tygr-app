"use client";

/**
 * CategoryPicker — sélecteur de catégorie (mono) en popover (UI_GUIDELINES §4.4
 * « dropdown riche ») : recherche en tête (focus auto), liste hiérarchique à 2
 * niveaux (Nature racine / Sous-nature indentée 24px), item sélectionné mis en
 * évidence. Sert l'assignation rapide d'UNE catégorie à une transaction (le cas
 * courant ; la ventilation multi-catégories passe par SplitAllocationModal).
 *
 * Présentationnel PUR : les catégories arrivent en props (aucun fetch), la
 * sélection remonte via `onSelect`. Pas de Server Action ici — le conteneur
 * (page/feature) câble la lecture et l'écriture. Pas de dépendance externe
 * (clsx/radix non installés, règle 9) : `cn` local + popover natif.
 *
 * Seules les catégories ACTIVES sont proposées (le conteneur filtre `isActive`,
 * mais on re-garde ici par sûreté). Une catégorie archivée reste visible sur les
 * splits existants (via CategoryBadge), elle n'est juste plus proposée.
 */
import { useMemo, useRef, useState } from "react";

import type { CategorieUI } from "./types";
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
  placeholder = "Rechercher une catégorie…",
}: {
  /** Référentiel (à plat). Le composant regroupe en Nature/Sous-nature. */
  categories: CategorieUI[];
  /** Catégorie actuellement assignée (mise en évidence), si une. */
  selectedId?: string | null;
  /** Remonte l'id choisi au conteneur (qui appelle l'action serveur). */
  onSelect: (categoryId: string) => void;
  placeholder?: string;
}) {
  const [recherche, setRecherche] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
    <div className="w-[320px] rounded-control bg-surface-card p-2 shadow-popover">
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

      <div role="listbox" className="max-h-72 overflow-y-auto" aria-label="Catégories">
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
        "flex w-full items-center rounded-control px-2 py-1.5 text-left transition-colors",
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
