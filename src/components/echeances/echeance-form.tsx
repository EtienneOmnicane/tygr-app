"use client";

/**
 * Formulaire d'ÉCHÉANCE — BIMODAL (création / édition). Présentationnel : état LOCAL
 * du formulaire, remonte l'action via `onCreer` (création) ou `onModifier` (édition) ;
 * le conteneur appelle la Server Action et gère le retour normalisé.
 *
 * Périmètre des champs = contrat serveur (schéma zod `creer/modifierEcheanceSchema`) :
 * sens, libellé, contrepartie (opt), montant + devise, date, catégorie (opt),
 * récurrence (opt), entité (opt). Le STATUT n'est PAS ici : une échéance naît
 * « en_cours » et sa transition passe par une action DÉDIÉE (`changerStatut`, part
 * réglée incluse) — séparation des préoccupations, alignée sur le backend.
 *
 * Le pré-remplissage se fait à l'initialisation des `useState` : le conteneur REMONTE
 * ce composant (via `key`) quand l'échéance éditée change — pas de synchro d'effet.
 *
 * Montants (règle 8) : on ne calcule RIEN. On accepte la virgule FR à la saisie et on
 * la normalise en point décimal (chaîne) avant de remonter — jamais de parseFloat.
 * Aucune couleur en dur, aucune dépendance externe (`cn` local) — UI_GUIDELINES.
 */
import { useId, useMemo, useState } from "react";

import { Select } from "@/components/ui/select";
import type { CategorieUI } from "@/components/ui/category";

import type {
  CreerEcheanceInputUI,
  DeviseEcheance,
  DirectionEcheance,
  EcheanceUI,
  ModifierEcheanceInputUI,
  RecurrenceEcheance,
} from "./types-echeances";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const OPTIONS_DIRECTION: Array<{ valeur: DirectionEcheance; label: string }> = [
  { valeur: "encaissement", label: "À encaisser" },
  { valeur: "decaissement", label: "À décaisser" },
];

const OPTIONS_DEVISE: Array<{ valeur: DeviseEcheance; label: string }> = [
  { valeur: "MUR", label: "Rs · Roupie" },
  { valeur: "USD", label: "$ · Dollar" },
  { valeur: "EUR", label: "€ · Euro" },
];

const OPTIONS_RECURRENCE: Array<{ valeur: "" | RecurrenceEcheance; label: string }> = [
  { valeur: "", label: "Aucune (ponctuelle)" },
  { valeur: "mensuelle", label: "Mensuelle" },
  { valeur: "trimestrielle", label: "Trimestrielle" },
];

/** Une entité assignable (sas ADMIN). Forme minimale — la page RSC la fournit. */
export interface EntiteOptionUI {
  id: string;
  nom: string;
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

/** Décimal positif après normalisation virgule→point (garde-fou ergonomique). */
function montantValide(saisie: string): boolean {
  const normalise = saisie.trim().replace(",", ".");
  return /^\d{1,13}(\.\d{1,2})?$/.test(normalise) && Number(normalise) > 0;
}

/** Normalise une saisie de montant en chaîne décimale à point (jamais de float). */
function normaliserMontant(saisie: string): string {
  return saisie.trim().replace(",", ".");
}

export function EcheanceForm({
  categories,
  entites = [],
  onCreer,
  mode = "creation",
  directionInitiale = "encaissement",
  valeurInitiale,
  onModifier,
  onAnnuler,
  enCours = false,
}: {
  categories: CategorieUI[];
  /** Entités assignables (opt). Vide → champ entité masqué (assignation ADMIN/sas). */
  entites?: EntiteOptionUI[];
  /** Remonte la création ; le conteneur appelle l'action et réinitialise au succès. */
  onCreer: (input: CreerEcheanceInputUI) => void;
  /** "creation" (défaut) ou "edition" (pré-rempli depuis `valeurInitiale`). */
  mode?: "creation" | "edition";
  /** Sens par défaut en création (= vue active « encaisser » / « décaisser »). */
  directionInitiale?: DirectionEcheance;
  /** Échéance à éditer (obligatoire si mode="edition") — pré-remplit le formulaire. */
  valeurInitiale?: EcheanceUI;
  /** Remonte la modification (mode édition). */
  onModifier?: (input: ModifierEcheanceInputUI) => void;
  /** Annule l'édition (referme le mode édition côté conteneur). */
  onAnnuler?: () => void;
  /** Désactive le formulaire pendant l'appel serveur. */
  enCours?: boolean;
}) {
  const edition = mode === "edition" && valeurInitiale !== undefined;

  const [direction, setDirection] = useState<DirectionEcheance>(
    edition ? valeurInitiale!.direction : directionInitiale,
  );
  const [libelle, setLibelle] = useState(edition ? valeurInitiale!.libelle : "");
  const [contrepartie, setContrepartie] = useState(
    edition ? (valeurInitiale!.contrepartie ?? "") : "",
  );
  const [montant, setMontant] = useState(edition ? valeurInitiale!.montant : "");
  const [devise, setDevise] = useState<DeviseEcheance>(
    edition ? (valeurInitiale!.devise as DeviseEcheance) : "MUR",
  );
  const [dateEcheance, setDateEcheance] = useState(
    edition ? valeurInitiale!.dateEcheance : "",
  );
  const [categorieId, setCategorieId] = useState(
    edition ? (valeurInitiale!.categorieId ?? "") : "",
  );
  const [recurrence, setRecurrence] = useState<"" | RecurrenceEcheance>(
    edition ? (valeurInitiale!.recurrence ?? "") : "",
  );
  const [entiteId, setEntiteId] = useState(
    edition ? (valeurInitiale!.entityId ?? "") : "",
  );

  const optionsCat = useMemo(() => optionsCategories(categories), [categories]);

  const libelleOk = libelle.trim().length > 0;
  const montantOk = montantValide(montant);
  const dateOk = dateEcheance.trim().length > 0;
  const peutSoumettre = libelleOk && montantOk && dateOk && !enCours;

  const idDirection = useId();
  const idLibelle = useId();
  const idContrepartie = useId();
  const idMontant = useId();
  const idDevise = useId();
  const idDate = useId();
  const idCat = useId();
  const idRecurrence = useId();
  const idEntite = useId();

  const champ =
    "h-10 rounded-control border border-line bg-surface-card px-3 text-sm text-text " +
    "focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
    "disabled:opacity-[0.48]";

  function soumettre(e: React.FormEvent) {
    e.preventDefault();
    if (!peutSoumettre) return;

    const contrepartieNette = contrepartie.trim();
    const base = {
      direction,
      libelle: libelle.trim(),
      contrepartie: contrepartieNette.length > 0 ? contrepartieNette : null,
      montant: normaliserMontant(montant),
      devise,
      dateEcheance,
      categorieId: categorieId !== "" ? categorieId : null,
      recurrence: recurrence !== "" ? recurrence : null,
      entityId: entiteId !== "" ? entiteId : null,
    };

    if (edition) {
      onModifier?.({ echeanceId: valeurInitiale!.id, ...base });
    } else {
      onCreer(base);
    }
  }

  return (
    <form
      onSubmit={soumettre}
      className="rounded-control border border-line bg-surface-card p-4"
    >
      <p className="mb-3 text-sm font-semibold text-text">
        {edition ? "Modifier l’échéance" : "Nouvelle échéance"}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        {/* Sens */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idDirection} className="text-xs text-text-muted">
            Sens
          </label>
          <Select
            id={idDirection}
            value={direction}
            disabled={enCours}
            onChange={(v) => setDirection(v as DirectionEcheance)}
            options={OPTIONS_DIRECTION.map((o) => ({
              value: o.valeur,
              label: o.label,
            }))}
          />
        </div>

        {/* Libellé */}
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor={idLibelle} className="text-xs text-text-muted">
            Libellé
          </label>
          <input
            id={idLibelle}
            type="text"
            value={libelle}
            disabled={enCours}
            onChange={(e) => setLibelle(e.target.value)}
            placeholder="ex. Facture client Alpha, Loyer entrepôt…"
            className={cn(champ, "min-w-[200px]")}
            maxLength={255}
          />
        </div>

        {/* Contrepartie (opt) */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idContrepartie} className="text-xs text-text-muted">
            Contrepartie <span className="text-text-faint">(opt.)</span>
          </label>
          <input
            id={idContrepartie}
            type="text"
            value={contrepartie}
            disabled={enCours}
            onChange={(e) => setContrepartie(e.target.value)}
            placeholder="Client / fournisseur"
            className={cn(champ, "min-w-[160px]")}
            maxLength={255}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        {/* Montant */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idMontant} className="text-xs text-text-muted">
            Montant
          </label>
          <input
            id={idMontant}
            type="text"
            inputMode="decimal"
            value={montant}
            disabled={enCours}
            onChange={(e) => setMontant(e.target.value)}
            placeholder="0,00"
            className={cn(champ, "w-36 text-right tabular-nums")}
          />
        </div>

        {/* Devise */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idDevise} className="text-xs text-text-muted">
            Devise
          </label>
          <Select
            id={idDevise}
            value={devise}
            disabled={enCours}
            onChange={(v) => setDevise(v as DeviseEcheance)}
            options={OPTIONS_DEVISE.map((o) => ({
              value: o.valeur,
              label: o.label,
            }))}
          />
        </div>

        {/* Date d'exigibilité */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idDate} className="text-xs text-text-muted">
            Exigible le
          </label>
          <input
            id={idDate}
            type="date"
            value={dateEcheance}
            disabled={enCours}
            min="2000-01-01"
            max="2100-12-31"
            onChange={(e) => setDateEcheance(e.target.value)}
            className={cn(champ, "tabular-nums")}
          />
        </div>

        {/* Catégorie (opt) */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idCat} className="text-xs text-text-muted">
            Catégorie <span className="text-text-faint">(opt.)</span>
          </label>
          <Select
            id={idCat}
            value={categorieId}
            disabled={enCours}
            onChange={(v) => setCategorieId(v)}
            options={[
              { value: "", label: "Aucune" },
              ...optionsCat.map((o) => ({ value: o.id, label: o.label })),
            ]}
          />
        </div>

        {/* Récurrence (opt) */}
        <div className="flex flex-col gap-1">
          <label htmlFor={idRecurrence} className="text-xs text-text-muted">
            Récurrence
          </label>
          <Select
            id={idRecurrence}
            value={recurrence}
            disabled={enCours}
            onChange={(v) => setRecurrence(v as "" | RecurrenceEcheance)}
            options={OPTIONS_RECURRENCE.map((o) => ({
              value: o.valeur,
              label: o.label,
            }))}
          />
        </div>

        {/* Entité (opt) — n'apparaît que si des entités sont fournies (sas ADMIN). */}
        {entites.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={idEntite} className="text-xs text-text-muted">
              Entité <span className="text-text-faint">(opt.)</span>
            </label>
            <Select
              id={idEntite}
              value={entiteId}
              disabled={enCours}
              onChange={(v) => setEntiteId(v)}
              options={[
                { value: "", label: "Non assignée" },
                ...entites.map((ent) => ({ value: ent.id, label: ent.nom })),
              ]}
            />
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
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
          {enCours
            ? edition
              ? "Enregistrement…"
              : "Création…"
            : edition
              ? "Enregistrer"
              : "Ajouter l’échéance"}
        </button>

        {edition && (
          <button
            type="button"
            onClick={onAnnuler}
            disabled={enCours}
            className="h-10 rounded-control border border-line px-4 text-sm font-medium text-text-muted
              transition-colors hover:bg-surface-inset focus:outline-none
              focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-[0.48]"
          >
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}
