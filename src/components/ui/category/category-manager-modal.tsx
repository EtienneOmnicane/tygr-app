"use client";

/**
 * CategoryManagerModal — gestion du référentiel de catégories (Pilier 1). Liste
 * les catégories existantes (Nature / Sous-nature) avec archivage, et permet d'en
 * créer de nouvelles. Bâtie sur la primitive `Modal` (§4.4).
 *
 * Présentationnel + état de FORMULAIRE local : la liste arrive en props, les
 * écritures remontent via `actions` (ActionsReferentielCategories, fournies par
 * le conteneur — Server Actions du Backend en réel, stubs en démo/test). Le
 * composant ne fetche rien lui-même ; après une action réussie, il demande au
 * conteneur de rafraîchir via `onChanged`.
 *
 * Règles métier reflétées côté UI (le serveur reste juge) :
 * - Pas de doublon de nom au même niveau (miroir du UNIQUE
 *   `categories_workspace_name_parent`) → pré-validation + message serveur mappé.
 * - Archivage (is_active=false), JAMAIS de suppression dure : l'historique de
 *   splits référençant la catégorie doit survivre (FK + audit). D'où « Archiver »
 *   et non « Supprimer ».
 */
import { useMemo, useState } from "react";

import { Modal } from "@/components/ui/modal/modal";

import type { ActionsReferentielCategories, CategorieUI } from "./types";
import { CategoryBadge } from "./category-badge";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function CategoryManagerModal({
  open,
  onClose,
  categories,
  actions,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** Référentiel courant (à plat). */
  categories: CategorieUI[];
  actions: ActionsReferentielCategories;
  /** Appelé après une création/archivage réussi → le conteneur recharge. */
  onChanged?: () => void;
}) {
  const [nom, setNom] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const natures = useMemo(
    () => categories.filter((c) => c.parentId === null && c.isActive),
    [categories],
  );

  // Pré-validation locale du doublon (le serveur re-valide — il reste juge).
  const nomNettoye = nom.trim();
  const doublon = useMemo(
    () =>
      nomNettoye.length > 0 &&
      categories.some(
        (c) =>
          c.parentId === parentId &&
          c.name.toLocaleLowerCase("fr") === nomNettoye.toLocaleLowerCase("fr"),
      ),
    [categories, nomNettoye, parentId],
  );
  const peutCreer = nomNettoye.length > 0 && !doublon && !enCours;

  async function creer() {
    if (!peutCreer) return;
    setEnCours(true);
    setErreur(null);
    const r = await actions.creerCategorie({ name: nomNettoye, parentId });
    setEnCours(false);
    if (r.ok) {
      setNom("");
      setParentId(null);
      onChanged?.();
    } else {
      setErreur(r.message);
    }
  }

  async function archiver(categoryId: string) {
    setEnCours(true);
    setErreur(null);
    const r = await actions.archiverCategorie(categoryId);
    setEnCours(false);
    if (r.ok) onChanged?.();
    else setErreur(r.message);
  }

  const groupes = natures.map((nature) => ({
    nature,
    sousNatures: categories.filter((c) => c.parentId === nature.id && c.isActive),
  }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Gérer les catégories"
      size="lg"
      footer={
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-semibold text-primary hover:text-primary-600
            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Fermer
        </button>
      }
    >
      <div className="flex flex-col gap-6">
        {/* Création */}
        <section>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Nouvelle catégorie
          </h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[13px] text-text-muted">Nom</span>
              <input
                type="text"
                value={nom}
                onChange={(e) => setNom(e.target.value)}
                maxLength={120}
                placeholder="Ex. Électricité"
                className={cn(
                  "rounded-control border bg-surface-inset px-3 py-2 text-sm text-text",
                  "placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary",
                  doublon ? "border-danger" : "border-line focus:border-primary",
                )}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[13px] text-text-muted">Nature parente</span>
              <select
                value={parentId ?? ""}
                onChange={(e) => setParentId(e.target.value || null)}
                className="rounded-control border border-line bg-surface-inset px-3 py-2
                  text-sm text-text focus:border-primary focus:outline-none focus:ring-2
                  focus:ring-primary"
              >
                <option value="">— Aucune (Nature racine) —</option>
                {natures.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={creer}
              disabled={!peutCreer}
              className="inline-flex h-10 items-center rounded-control bg-success px-4
                text-sm font-semibold text-text-onink transition-colors
                hover:opacity-90 focus:outline-none focus-visible:ring-2
                focus-visible:ring-primary focus-visible:ring-offset-2
                disabled:opacity-48"
            >
              Créer
            </button>
          </div>
          {doublon && (
            <p className="mt-2 text-xs text-danger">
              Une catégorie « {nomNettoye} » existe déjà à ce niveau.
            </p>
          )}
          {erreur && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {erreur}
            </p>
          )}
        </section>

        {/* Liste existante */}
        <section>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Catégories existantes
          </h3>
          {groupes.length === 0 ? (
            <p className="text-sm text-text-muted">
              Aucune catégorie pour l’instant. Créez-en une ci-dessus.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {groupes.map(({ nature, sousNatures }) => (
                <li key={nature.id}>
                  <LigneCategorie
                    categorie={nature}
                    onArchiver={archiver}
                    disabled={enCours}
                  />
                  {sousNatures.length > 0 && (
                    <ul className="ml-6 mt-1 flex flex-col gap-1">
                      {sousNatures.map((sn) => (
                        <li key={sn.id}>
                          <LigneCategorie
                            categorie={sn}
                            onArchiver={archiver}
                            disabled={enCours}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

function LigneCategorie({
  categorie,
  onArchiver,
  disabled,
}: {
  categorie: CategorieUI;
  onArchiver: (categoryId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-control px-2 py-1.5 hover:bg-surface-inset">
      <CategoryBadge name={categorie.name} colorKey={categorie.id} size="sm" />
      <button
        type="button"
        onClick={() => onArchiver(categorie.id)}
        disabled={disabled}
        className="text-xs font-semibold text-text-muted transition-colors
          hover:text-danger focus:outline-none focus-visible:ring-2
          focus-visible:ring-primary disabled:opacity-48"
      >
        Archiver
      </button>
    </div>
  );
}
