"use client";

/**
 * SplitAllocationModal — ventilation d'UNE transaction sur N catégories
 * (Pilier 1). Le composant le plus critique : réconciliation des montants en
 * temps réel. Plan design acté 10/10 (PLAN-split-allocation-modal.md,
 * plan-design-review 2026-06-17).
 *
 * MODÈLE (décisions design) :
 * - Invariant serveur : somme des splits ≤ |montant txn|. Le PARTIEL est VALIDE
 *   (D1) — ventiler moins que le total est un état serein, jamais une erreur.
 * - Édition OPTIMISTE LOCALE (D4) : on édite les lignes en état local, aucun
 *   appel serveur pendant l'édition. Au Valider, on envoie l'état cible COMPLET
 *   en UNE requête atomique `onReplace` (→ remplacerSplitsAction, tout-ou-rien).
 * - Saisie BRUT@focus / FORMATÉ@blur (D2) : le champ montre la valeur brute
 *   pendant la frappe (curseur stable), formatée aux milliers à la perte de focus.
 * - Pré-validation UI : dépassement → champ `danger` + Valider inactif (le
 *   serveur reste juge, mais l'UI n'amène jamais jusqu'au rejet).
 * - a11y (D3) : bandeau `aria-live="polite"` annonce le reste après chaque saisie.
 *
 * Présentationnel + état local : `categories` et l'action `onReplace` sont
 * injectées par le conteneur (Server Actions en réel, stubs en démo/test).
 */
import { useId, useMemo, useState } from "react";

import { formatMontant } from "@/lib/format-montant";
import { Modal } from "@/components/ui/modal/modal";

import {
  calculerAllocation,
  ligneEnDepassement,
  lignesEnDoublon,
  montantPourLeReste,
  montantValide,
  peutValider,
  versPayload,
  MAX_SPLITS,
  type LigneAllocation,
} from "./allocation";
import type { CategorieUI, ResultatAction, SplitUI } from "./types";
import { CategoryBadge } from "./category-badge";
import { CategoryPicker } from "./category-picker";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** N'accepte à la frappe que chiffres + un séparateur décimal (≤ 2 décimales). */
function nettoyerSaisie(v: string): string {
  // On tolère . et , comme séparateur, on normalise en point.
  const normalise = v.replace(",", ".").replace(/[^\d.]/g, "");
  const [entier, ...reste] = normalise.split(".");
  if (reste.length === 0) return entier;
  return `${entier}.${reste.join("").slice(0, 2)}`;
}

let compteurCle = 0;
function nouvelleCle(): string {
  compteurCle += 1;
  return `ligne-${compteurCle}`;
}

export function SplitAllocationModal({
  open,
  onClose,
  transaction,
  categories,
  initialSplits,
  onReplace,
  onSaved,
  onCreateCategorie,
}: {
  open: boolean;
  onClose: () => void;
  /** La transaction à ventiler (contexte + montant absolu + devise). */
  transaction: {
    transactionId: string;
    transactionDate: string;
    /** Libellé propre (ex. « Beachcomber Resorts »). */
    label: string;
    /** Montant ABSOLU de la transaction, chaîne décimale > 0. */
    montantAbs: string;
    devise: string;
    /** Sens, pour le contexte (l'UI manipule des valeurs absolues). */
    sens: "Credit" | "Debit";
  };
  categories: CategorieUI[];
  /** Splits déjà enregistrés (pour pré-remplir l'édition). */
  initialSplits: SplitUI[];
  /** Action atomique de remplacement (→ remplacerSplitsAction). */
  onReplace: (
    splits: Array<{ categoryId: string; amount: string }>,
  ) => Promise<ResultatAction>;
  /** Appelé après un remplacement réussi (le conteneur recharge). */
  onSaved?: () => void;
  /**
   * Crée une catégorie (Nature racine) depuis le picker (→ creerCategorieAction).
   * Optionnel : absent → pas de bouton « Ajouter une catégorie ». La catégorie
   * créée est ajoutée localement (affichage immédiat) puis sélectionnée.
   */
  onCreateCategorie?: (
    name: string,
  ) => Promise<ResultatAction<{ categoryId: string }>>;
}) {
  // État LOCAL des lignes (édition optimiste). Initialisé depuis les splits existants.
  const [lignes, setLignes] = useState<LigneAllocation[]>(() =>
    initialSplits.length > 0
      ? initialSplits.map((s) => ({
          cle: nouvelleCle(),
          categoryId: s.categoryId,
          montantSaisi: s.amount,
        }))
      : [{ cle: nouvelleCle(), categoryId: null, montantSaisi: "" }],
  );
  const [pickerOuvert, setPickerOuvert] = useState<string | null>(null);
  const [focusCle, setFocusCle] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  // Catégories créées localement (depuis le picker), pas encore dans les props
  // (le conteneur recharge le référentiel au prochain rendu). On les CONCATÈNE aux
  // props plutôt que de dupliquer tout l'état (évite un setState/effect de synchro).
  const [categoriesCreees, setCategoriesCreees] = useState<CategorieUI[]>([]);
  const categoriesLocales = useMemo(
    () => [...categories, ...categoriesCreees],
    [categories, categoriesCreees],
  );

  const resteLabelId = useId();

  const etat = useMemo(
    () => calculerAllocation(transaction.montantAbs, lignes),
    [transaction.montantAbs, lignes],
  );
  // Lignes dont la catégorie est utilisée sur ≥ 2 parts (TX-QA-SPLIT-DOUBLON1) :
  // peintes en `danger` + « Valider » bloqué (peutValider en tient compte). L'UI
  // évite au client d'atteindre le rejet serveur, sans jamais le remplacer.
  const clesEnDoublon = useMemo(() => lignesEnDoublon(lignes), [lignes]);
  const valider = peutValider(transaction.montantAbs, lignes);

  function majLigne(cle: string, patch: Partial<LigneAllocation>) {
    setLignes((prev) =>
      prev.map((l) => (l.cle === cle ? { ...l, ...patch } : l)),
    );
  }

  function ajouterLigne(montantPrefill?: string) {
    if (lignes.length >= MAX_SPLITS) return;
    setLignes((prev) => [
      ...prev,
      { cle: nouvelleCle(), categoryId: null, montantSaisi: montantPrefill ?? "" },
    ]);
  }

  function retirerLigne(cle: string) {
    setLignes((prev) => {
      const reste = prev.filter((l) => l.cle !== cle);
      // Garde toujours au moins une ligne vierge.
      return reste.length > 0
        ? reste
        : [{ cle: nouvelleCle(), categoryId: null, montantSaisi: "" }];
    });
  }

  function categoriserLeReste() {
    // Raccourci D1 : pré-remplit une nouvelle ligne avec le montant restant.
    if (etat.depasse) return;
    const resteC = etat.reste;
    if (montantValide(resteC)) ajouterLigne(resteC);
  }

  function mettreLeResteSurLigne(cle: string) {
    // Raccourci TX-QA-SPLIT-MAX1 : la ligne COURANTE absorbe tout le reste (≠
    // categoriserLeReste qui crée une nouvelle ligne). Le montant est calculé en
    // centimes par le helper pur (reste + contribution actuelle de la ligne),
    // null si rien à ventiler → aucune action.
    const cible = montantPourLeReste(transaction.montantAbs, lignes, cle);
    if (cible !== null) majLigne(cle, { montantSaisi: cible });
  }

  async function soumettre() {
    if (!valider || enCours) return;
    setEnCours(true);
    setErreur(null);
    const r = await onReplace(versPayload(lignes));
    setEnCours(false);
    if (r.ok) {
      onSaved?.();
      onClose();
    } else {
      setErreur(r.message);
    }
  }

  const categorieDe = (id: string | null) =>
    id ? categoriesLocales.find((c) => c.id === id) ?? null : null;

  // Affichage du montant dans le champ : brut si focus, formaté (nu) sinon.
  function affichageMontant(ligne: LigneAllocation): string {
    if (focusCle === ligne.cle) return ligne.montantSaisi;
    if (ligne.montantSaisi.trim() === "") return "";
    if (!montantValide(ligne.montantSaisi)) return ligne.montantSaisi;
    // Formaté sans devise (la devise est affichée à côté du champ).
    return formatMontant(ligne.montantSaisi, "").trim();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ventiler la transaction"
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer text-sm font-semibold text-primary hover:text-primary-600
              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={soumettre}
            disabled={!valider || enCours}
            className="inline-flex h-10 cursor-pointer items-center rounded-control bg-success px-5
              text-sm font-semibold text-text-onink transition-opacity
              hover:opacity-90 focus:outline-none focus-visible:ring-2
              focus-visible:ring-primary focus-visible:ring-offset-2
              disabled:cursor-not-allowed disabled:opacity-48"
          >
            {enCours ? "Enregistrement…" : "Valider"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Contexte transaction */}
        <p className="text-[13px] text-text-muted">
          {transaction.label} ·{" "}
          {transaction.sens === "Credit" ? "entrée" : "sortie"} ·{" "}
          <span className="font-semibold tabular-nums text-text">
            {formatMontant(transaction.montantAbs, transaction.devise)}
          </span>
        </p>

        {/* BANDEAU de réconciliation (sticky en haut de la zone scrollable) */}
        <div
          className="sticky top-0 z-10 rounded-card bg-surface-inset p-4"
          aria-live="polite"
          aria-labelledby={resteLabelId}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="text-text-muted">
              Total{" "}
              <span className="font-semibold tabular-nums text-text">
                {formatMontant(transaction.montantAbs, transaction.devise)}
              </span>
            </span>
            <span className="text-text-muted">
              Alloué{" "}
              <span className="font-semibold tabular-nums text-text">
                {formatMontant(etat.alloue, transaction.devise)}
              </span>
            </span>
            <span id={resteLabelId} className="text-text-muted">
              {etat.depasse ? "Dépassement " : "Reste "}
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  etat.depasse ? "text-danger" : "text-text",
                )}
              >
                {formatMontant(
                  etat.depasse ? etat.reste.replace("-", "") : etat.reste,
                  transaction.devise,
                )}
              </span>
            </span>
          </div>

          {/* Barre de progression : primary jusqu'au total, danger au-delà. */}
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-card">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                etat.depasse ? "bg-danger" : "bg-primary",
              )}
              style={{ width: `${Math.min(100, Math.round(etat.ratio * 100))}%` }}
            />
          </div>

          {etat.depasse && (
            <p role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-danger">
              <span aria-hidden>⚠</span>
              La somme dépasse le montant de la transaction. Ajustez avant de valider.
            </p>
          )}
        </div>

        {/* LIGNES de splits */}
        <div className="flex flex-col gap-3">
          {lignes.map((ligne) => {
            const cat = categorieDe(ligne.categoryId);
            const enDepassement = ligneEnDepassement(
              transaction.montantAbs,
              lignes,
              ligne.cle,
            );
            const enDoublon = clesEnDoublon.has(ligne.cle);
            // Montant qui ferait absorber tout le reste à CETTE ligne (null si rien
            // à ventiler → bouton « Tout le reste » masqué). Calcul pur en centimes.
            const resteCible = montantPourLeReste(
              transaction.montantAbs,
              lignes,
              ligne.cle,
            );
            return (
              <div key={ligne.cle} className="flex flex-col gap-1">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                {/* Sélecteur de catégorie */}
                <div className="relative sm:flex-1">
                  <button
                    type="button"
                    onClick={() =>
                      setPickerOuvert(pickerOuvert === ligne.cle ? null : ligne.cle)
                    }
                    className={cn(
                      `flex h-10 w-full cursor-pointer items-center justify-between rounded-control
                      border bg-surface-inset px-3 text-sm text-text
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`,
                      enDoublon ? "border-danger" : "border-line",
                    )}
                  >
                    {cat ? (
                      <CategoryBadge name={cat.name} colorKey={cat.id} size="sm" />
                    ) : (
                      <span className="text-text-faint">Choisir une catégorie</span>
                    )}
                    <span aria-hidden className="text-text-muted">▾</span>
                  </button>
                  {pickerOuvert === ligne.cle && (
                    <div className="absolute left-0 top-11 z-20">
                      <CategoryPicker
                        categories={categoriesLocales}
                        selectedId={ligne.categoryId}
                        onSelect={(categoryId) => {
                          majLigne(ligne.cle, { categoryId });
                          setPickerOuvert(null);
                        }}
                        onClose={() => setPickerOuvert(null)}
                        onCreate={
                          onCreateCategorie
                            ? async (name) => {
                                const res = await onCreateCategorie(name);
                                // Ajout local (affichage immédiat du badge) ; le
                                // picker sélectionne ensuite la nouvelle catégorie.
                                if (res.ok) {
                                  setCategoriesCreees((prev) => [
                                    ...prev,
                                    {
                                      id: res.data.categoryId,
                                      name: name.trim(),
                                      parentId: null,
                                      isActive: true,
                                    },
                                  ]);
                                }
                                return res;
                              }
                            : undefined
                        }
                      />
                    </div>
                  )}
                </div>

                {/* Champ montant (brut@focus / formaté@blur) + devise */}
                <div className="flex items-center gap-2 sm:w-56">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={affichageMontant(ligne)}
                    onFocus={() => setFocusCle(ligne.cle)}
                    onBlur={() => setFocusCle(null)}
                    onChange={(e) =>
                      majLigne(ligne.cle, {
                        montantSaisi: nettoyerSaisie(e.target.value),
                      })
                    }
                    placeholder="0,00"
                    aria-label="Montant de la catégorie"
                    aria-invalid={enDepassement}
                    className={cn(
                      "h-10 w-full rounded-control border bg-surface-inset px-3 text-right",
                      "text-sm tabular-nums text-text placeholder:text-text-faint",
                      "focus:outline-none focus:ring-2 focus:ring-primary",
                      enDepassement ? "border-danger" : "border-line focus:border-primary",
                    )}
                  />
                  <span className="text-xs text-text-muted">{transaction.devise}</span>
                  {resteCible !== null && (
                    <button
                      type="button"
                      onClick={() => mettreLeResteSurLigne(ligne.cle)}
                      aria-label={`Affecter tout le reste à cette catégorie (${formatMontant(resteCible, transaction.devise)})`}
                      title="Affecter tout le reste à cette ligne"
                      className="inline-flex h-9 shrink-0 cursor-pointer items-center whitespace-nowrap
                        rounded-control border border-line bg-surface-inset px-2.5 text-xs
                        font-semibold text-text transition-colors hover:border-primary
                        hover:text-primary focus:outline-none focus-visible:ring-2
                        focus-visible:ring-primary"
                    >
                      Max
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => retirerLigne(ligne.cle)}
                    aria-label="Retirer cette catégorie"
                    className="cursor-pointer rounded-control p-1.5 text-text-muted transition-colors
                      hover:text-danger focus:outline-none focus-visible:ring-2
                      focus-visible:ring-primary"
                  >
                    <span aria-hidden>🗑</span>
                  </button>
                </div>
              </div>
              {/* Doublon de catégorie (TX-QA-SPLIT-DOUBLON1) : message inline sous la
                  ligne fautive. Confort UI — la garde serveur reste souveraine. */}
              {enDoublon && (
                <p role="alert" className="flex items-center gap-1.5 text-xs text-danger">
                  <span aria-hidden>⚠</span>
                  Catégorie déjà utilisée — choisissez-en une autre ou fusionnez les montants.
                </p>
              )}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => ajouterLigne()}
              disabled={lignes.length >= MAX_SPLITS}
              className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-primary
                hover:text-primary-600 focus:outline-none focus-visible:ring-2
                focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-48"
            >
              <span aria-hidden>+</span> Ajouter une catégorie
            </button>

            {/* Raccourci D1 : catégoriser le reste (visible si reste > 0 sans dépassement) */}
            {!etat.depasse && montantValide(etat.reste) && (
              <button
                type="button"
                onClick={categoriserLeReste}
                className="cursor-pointer text-sm font-semibold text-primary hover:text-primary-600
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                + Catégoriser le reste ({formatMontant(etat.reste, transaction.devise)})
              </button>
            )}
          </div>
        </div>

        {/* Reste non catégorisé : info bienveillante (D1), jamais une erreur. */}
        {!etat.depasse && montantValide(etat.reste) && (
          <p className="text-xs text-text-muted">
            {formatMontant(etat.reste, transaction.devise)} restent non catégorisés —
            vous pourrez compléter plus tard.
          </p>
        )}

        {/* Erreur serveur (rare : course concurrente) — mappée, modale reste ouverte. */}
        {erreur && (
          <p role="alert" className="text-xs text-danger">
            {erreur}
          </p>
        )}
      </div>
    </Modal>
  );
}
