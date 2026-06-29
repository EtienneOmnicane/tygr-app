"use client";

/**
 * Formulaire de création d'une règle de catégorisation. Présentationnel : état
 * LOCAL du formulaire (motif / stratégie / catégorie), remonte la création via
 * `onCreer` (le conteneur appelle la Server Action et gère le retour).
 *
 * Ergonomie de validation (refonte 2026-06-24) : le bouton « Créer la règle »
 * reste TOUJOURS cliquable (sauf pendant l'appel serveur) — il ne se grise plus
 * en silence quand un champ manque. Au clic, on valide : si un champ est invalide,
 * on AFFICHE un message d'erreur explicite SOUS le champ concerné (rouge, `danger`),
 * on marque le champ (`aria-invalid` + bordure `danger`) et on y place le focus.
 * L'erreur d'un champ disparaît dès qu'il redevient valide (à la frappe / sélection).
 *
 * La validation UI reste un garde-fou ERGONOMIQUE ; la vérité reste zod strict + FK
 * côté serveur (le conteneur mappe les codes S2 vers son bandeau d'erreur). Aucune
 * couleur en dur, aucune dépendance externe (`cn` local) — UI_GUIDELINES.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { CategorieUI } from "@/components/ui/category";

import type { RuleMatchType } from "./types-regles";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const OPTIONS_MATCH: Array<{ valeur: RuleMatchType; label: string }> = [
  { valeur: "contains", label: "contient" },
  { valeur: "starts_with", label: "commence par" },
];

/** Messages d'erreur de validation (source unique, réutilisés au rendu + tests). */
export const MSG_MOTIF_VIDE = "Saisissez un motif de libellé.";
export const MSG_CATEGORIE_VIDE = "Veuillez choisir une catégorie.";

/** Erreurs de champ du formulaire (absence de clé = champ valide). */
export type ErreursForm = { pattern?: string; categoryId?: string };

/**
 * Validation PURE des champs (testable, pas d'effet de bord). Renvoie les messages
 * par champ ; un objet vide = formulaire valide. Mêmes règles que le `disabled`
 * d'avant (motif non vide après trim, catégorie choisie), mais matérialisées en
 * messages au lieu d'un bouton muet.
 */
export function validerChamps(pattern: string, categoryId: string): ErreursForm {
  const erreurs: ErreursForm = {};
  if (pattern.trim().length === 0) erreurs.pattern = MSG_MOTIF_VIDE;
  if (categoryId === "") erreurs.categoryId = MSG_CATEGORIE_VIDE;
  return erreurs;
}

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
  cleReset = 0,
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
  /**
   * Compteur de reset : le conteneur l'incrémente après une création RÉUSSIE pour
   * vider le formulaire (le composant ne sait pas, seul, si `onCreer` a abouti —
   * `onCreer` est `void`). À chaque changement de valeur, on réinitialise motif /
   * catégorie / stratégie / erreurs. La valeur initiale (montage) ne déclenche rien.
   */
  cleReset?: number;
}) {
  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState<RuleMatchType>("contains");
  const [categoryId, setCategoryId] = useState("");
  const [erreurs, setErreurs] = useState<ErreursForm>({});

  // Reset au succès : quand `cleReset` change (≠ montage), on revient à l'état vierge.
  const cleResetVue = useRef(cleReset);
  useEffect(() => {
    if (cleResetVue.current !== cleReset) {
      cleResetVue.current = cleReset;
      setPattern("");
      setCategoryId("");
      setMatchType("contains");
      setErreurs({});
    }
  }, [cleReset]);

  const options = useMemo(() => optionsCategories(categories), [categories]);

  const idMotif = useId();
  const idMatch = useId();
  const idCat = useId();
  // ids des messages d'erreur (aria-describedby ne pointe que si l'erreur existe).
  const idErrMotif = `${idMotif}-err`;
  const idErrCat = `${idCat}-err`;

  // Refs pour placer le focus sur le premier champ fautif au submit invalide.
  const refMotif = useRef<HTMLInputElement>(null);
  const refCat = useRef<HTMLSelectElement>(null);

  const champBase =
    "h-10 rounded-control border bg-surface-card px-3 text-sm text-text " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
    "disabled:opacity-[0.48]";
  // Bordure : danger si le champ est en erreur, sinon ligne neutre + focus primary.
  const bordure = (enErreur: boolean) =>
    enErreur
      ? "border-danger focus:border-danger"
      : "border-line focus:border-primary";

  function soumettre(e: React.FormEvent) {
    e.preventDefault();
    if (enCours) return;
    const prochaines = validerChamps(pattern, categoryId);
    setErreurs(prochaines);
    if (prochaines.pattern || prochaines.categoryId) {
      // Focus le PREMIER champ fautif (ordre visuel : motif avant catégorie).
      if (prochaines.pattern) refMotif.current?.focus();
      else refCat.current?.focus();
      return;
    }
    onCreer({ pattern: pattern.trim(), matchType, categoryId });
  }

  // Effacement d'erreur dès qu'un champ redevient valide (anti-erreur fantôme).
  function majMotif(valeur: string) {
    setPattern(valeur);
    if (erreurs.pattern && valeur.trim().length > 0) {
      setErreurs((e) => ({ ...e, pattern: undefined }));
    }
  }
  function majCategorie(valeur: string) {
    setCategoryId(valeur);
    if (erreurs.categoryId && valeur !== "") {
      setErreurs((e) => ({ ...e, categoryId: undefined }));
    }
  }

  return (
    <form
      onSubmit={soumettre}
      noValidate
      className="rounded-control border border-line bg-surface-card p-4"
    >
      <p className="mb-3 text-sm font-semibold text-text">Nouvelle règle</p>

      {/* items-start (pas items-end) : chaque champ réserve un slot d'erreur sous
          lui, donc l'alignement des CHAMPS reste stable quand un message apparaît. */}
      <div className="flex flex-wrap items-start gap-3">
        {/* Stratégie : « Si le libellé [contient / commence par] » (jamais en erreur). */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idMatch} className="text-xs text-text-muted">
            Si le libellé
          </label>
          <select
            id={idMatch}
            value={matchType}
            disabled={enCours}
            onChange={(e) => setMatchType(e.target.value as RuleMatchType)}
            className={cn(champBase, bordure(false))}
          >
            {OPTIONS_MATCH.map((o) => (
              <option key={o.valeur} value={o.valeur}>
                {o.label}
              </option>
            ))}
          </select>
          <SlotErreur />
        </div>

        {/* Motif */}
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={idMotif} className="text-xs text-text-muted">
            le texte
          </label>
          <input
            ref={refMotif}
            id={idMotif}
            type="text"
            value={pattern}
            disabled={enCours}
            onChange={(e) => majMotif(e.target.value)}
            placeholder="ex. EDF, SALAIRE, AMAZON…"
            className={cn(champBase, bordure(Boolean(erreurs.pattern)), "min-w-[180px]")}
            maxLength={255}
            aria-invalid={erreurs.pattern ? true : undefined}
            aria-describedby={erreurs.pattern ? idErrMotif : undefined}
          />
          <SlotErreur id={idErrMotif} message={erreurs.pattern} />
        </div>

        {/* Catégorie cible : « alors classer dans … » */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idCat} className="text-xs text-text-muted">
            alors classer dans
          </label>
          <select
            ref={refCat}
            id={idCat}
            value={categoryId}
            disabled={enCours}
            onChange={(e) => majCategorie(e.target.value)}
            className={cn(champBase, bordure(Boolean(erreurs.categoryId)))}
            aria-invalid={erreurs.categoryId ? true : undefined}
            aria-describedby={erreurs.categoryId ? idErrCat : undefined}
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
          <SlotErreur id={idErrCat} message={erreurs.categoryId} />
        </div>

        {/* Bouton TOUJOURS cliquable hors appel serveur : le clic déclenche la
            validation (et l'affichage des erreurs) au lieu d'un bouton grisé muet. */}
        <div className="flex flex-col gap-1">
          {/* Aligne le bouton sur la rangée des champs (le label fait h ~16px). */}
          <span aria-hidden className="text-xs">
            &nbsp;
          </span>
          <button
            type="submit"
            disabled={enCours}
            className={cn(
              "h-10 rounded-control px-4 text-sm font-semibold transition-colors",
              "bg-primary text-text-onink hover:bg-primary-600",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-[0.48]",
            )}
          >
            {enCours ? "Création…" : "Créer la règle"}
          </button>
          <SlotErreur />
        </div>
      </div>
    </form>
  );
}

/**
 * Emplacement d'erreur sous un champ. TOUJOURS rendu (hauteur réservée
 * `min-h-[1rem]`) pour que l'apparition d'un message ne décale pas l'alignement
 * des champs voisins. `role="alert"` pour annoncer le message aux lecteurs d'écran.
 */
function SlotErreur({ id, message }: { id?: string; message?: string }) {
  return (
    <p
      id={id}
      role={message ? "alert" : undefined}
      className="min-h-[1rem] text-xs text-danger"
    >
      {message}
    </p>
  );
}
