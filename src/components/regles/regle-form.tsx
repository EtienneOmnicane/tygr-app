"use client";

/**
 * Formulaire de création d'une règle de catégorisation. Présentationnel : état
 * LOCAL du formulaire (motif / stratégie / catégorie / priorité), remonte la
 * création via `onCreer` (le conteneur appelle la Server Action et gère le retour).
 *
 * Validation côté UI = garde-fou ergonomique (motif non vide, catégorie choisie) ;
 * la vraie validation (zod strict + FK) vit côté serveur. Aucune couleur en dur,
 * aucune dépendance externe (`cn` local) — UI_GUIDELINES.
 */
import { useId, useMemo, useState } from "react";

import type { CategorieUI } from "@/components/ui/category";

import type { RuleMatchType } from "./types-regles";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const OPTIONS_MATCH: Array<{ valeur: RuleMatchType; label: string }> = [
  { valeur: "contains", label: "contient" },
  { valeur: "starts_with", label: "commence par" },
];

/** Options du select catégorie, hiérarchisées Nature → Sous-nature (indentée). */
function optionsCategories(categories: CategorieUI[]) {
  const actives = categories.filter((c) => c.isActive);
  const racines = actives.filter((c) => c.parentId === null);
  const options: Array<{ id: string; label: string }> = [];
  for (const nature of racines) {
    options.push({ id: nature.id, label: nature.name });
    for (const sn of actives.filter((c) => c.parentId === nature.id)) {
      options.push({ id: sn.id, label: `— ${sn.name}` }); // tiret cadratin = indentation
    }
  }
  return options;
}

export function RegleForm({
  categories,
  onCreer,
  enCours = false,
}: {
  categories: CategorieUI[];
  /** Remonte la création ; le conteneur appelle l'action et réinitialise au succès. */
  onCreer: (input: {
    pattern: string;
    matchType: RuleMatchType;
    categoryId: string;
  }) => void;
  /** Désactive le formulaire pendant l'appel serveur. */
  enCours?: boolean;
}) {
  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState<RuleMatchType>("contains");
  const [categoryId, setCategoryId] = useState("");

  const options = useMemo(() => optionsCategories(categories), [categories]);
  const motifValide = pattern.trim().length > 0;
  const peutSoumettre = motifValide && categoryId !== "" && !enCours;

  const idMotif = useId();
  const idMatch = useId();
  const idCat = useId();

  const champ =
    "h-10 rounded-control border border-line bg-surface-card px-3 text-sm text-text " +
    "focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
    "disabled:opacity-[0.48]";

  function soumettre(e: React.FormEvent) {
    e.preventDefault();
    if (!peutSoumettre) return;
    onCreer({ pattern: pattern.trim(), matchType, categoryId });
  }

  return (
    <form
      onSubmit={soumettre}
      className="rounded-control border border-line bg-surface-card p-4"
    >
      <p className="mb-3 text-sm font-semibold text-text">Nouvelle règle</p>

      <div className="flex flex-wrap items-end gap-3">
        {/* Stratégie : « Si le libellé [contient / commence par] » */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idMatch} className="text-xs text-text-muted">
            Si le libellé
          </label>
          <select
            id={idMatch}
            value={matchType}
            disabled={enCours}
            onChange={(e) => setMatchType(e.target.value as RuleMatchType)}
            className={champ}
          >
            {OPTIONS_MATCH.map((o) => (
              <option key={o.valeur} value={o.valeur}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Motif */}
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={idMotif} className="text-xs text-text-muted">
            le texte
          </label>
          <input
            id={idMotif}
            type="text"
            value={pattern}
            disabled={enCours}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="ex. EDF, SALAIRE, AMAZON…"
            className={cn(champ, "min-w-[180px]")}
            maxLength={255}
          />
        </div>

        {/* Catégorie cible : « alors classer dans … » */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idCat} className="text-xs text-text-muted">
            alors classer dans
          </label>
          <select
            id={idCat}
            value={categoryId}
            disabled={enCours}
            onChange={(e) => setCategoryId(e.target.value)}
            className={champ}
          >
            <option value="" disabled>
              Choisir une catégorie…
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={!peutSoumettre}
          className={cn(
            "h-10 rounded-control px-4 text-sm font-semibold transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
            peutSoumettre
              ? "bg-primary text-text-onink hover:bg-primary-600"
              : "cursor-not-allowed bg-surface-inset text-text-faint",
          )}
        >
          {enCours ? "Création…" : "Créer la règle"}
        </button>
      </div>
    </form>
  );
}
