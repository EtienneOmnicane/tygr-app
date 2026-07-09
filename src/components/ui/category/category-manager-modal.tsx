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
import { useMemo, useRef, useState } from "react";

import { Modal } from "@/components/ui/modal/modal";

import type { ActionsReferentielCategories, CategorieUI } from "./types";
import { CategoryBadge } from "./category-badge";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Longueur max d'un nom de catégorie (aligné varchar(120) + zod nomCategorie). */
const NOM_MAX = 120;

/** Mappe un code d'erreur serveur (registre S2) en message UI. */
function messagePourCode(code: string, fallback: string): string {
  switch (code) {
    case "CATEGORIE_DEJA_EXISTANTE":
      return "Cette catégorie existe déjà à ce niveau.";
    case "CATEGORY_NOT_FOUND":
      return "Catégorie introuvable (peut-être déjà supprimée).";
    case "CATEGORY_NOT_AUTHORIZED":
      return "Action réservée aux administrateurs.";
    case "INVALID_PARAMS":
      return "Nom invalide (1 à 120 caractères).";
    default:
      return fallback;
  }
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

  /**
   * Renomme une catégorie (FB0709-CAT-RENOMMER1). Le serveur reste la vraie garde
   * (ADMIN + unicité insensible à la casse) ; ici on relaie le résultat et on
   * mappe l'erreur (dont CATEGORIE_DEJA_EXISTANTE). Retourne `true` au succès pour
   * que la ligne referme son mode édition. `onChanged` rafraîchit la liste.
   */
  async function renommer(categoryId: string, nouveauNom: string): Promise<boolean> {
    setEnCours(true);
    setErreur(null);
    const r = await actions.renommerCategorie({ categoryId, name: nouveauNom });
    setEnCours(false);
    if (r.ok) {
      onChanged?.();
      return true;
    }
    setErreur(messagePourCode(r.code, r.message));
    return false;
  }

  /**
   * Doublon insensible à la casse pour un renommage à un niveau donné, EN
   * S'EXCLUANT SOI-MÊME (renommer « VAT » en « vat » — même ligne — reste permis).
   * Pré-validation UI (le serveur re-juge) : miroir de `existeCategorieMemeNom`.
   */
  function doublonAuRenommage(
    categoryId: string,
    nom: string,
    parentId: string | null,
  ): boolean {
    const cible = nom.trim().toLocaleLowerCase("fr");
    if (cible.length === 0) return false;
    return categories.some(
      (c) =>
        c.id !== categoryId &&
        c.parentId === parentId &&
        c.name.toLocaleLowerCase("fr") === cible,
    );
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
                    onRenommer={renommer}
                    estDoublon={(nom) => doublonAuRenommage(nature.id, nom, null)}
                    disabled={enCours}
                  />
                  {sousNatures.length > 0 && (
                    <ul className="ml-6 mt-1 flex flex-col gap-1">
                      {sousNatures.map((sn) => (
                        <li key={sn.id}>
                          <LigneCategorie
                            categorie={sn}
                            onArchiver={archiver}
                            onRenommer={renommer}
                            estDoublon={(nom) =>
                              doublonAuRenommage(sn.id, nom, nature.id)
                            }
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
  onRenommer,
  estDoublon,
  disabled,
}: {
  categorie: CategorieUI;
  onArchiver: (categoryId: string) => void;
  /** Renomme ; résout `true` au succès (la ligne referme alors son édition). */
  onRenommer: (categoryId: string, nouveauNom: string) => Promise<boolean>;
  /** Pré-validation locale du doublon insensible casse (le serveur reste juge). */
  estDoublon: (nom: string) => boolean;
  disabled: boolean;
}) {
  const [edition, setEdition] = useState(false);
  const [nom, setNom] = useState(categorie.name);
  const champRef = useRef<HTMLInputElement>(null);

  function ouvrir() {
    setNom(categorie.name);
    setEdition(true);
    requestAnimationFrame(() => champRef.current?.select());
  }
  function annuler() {
    setEdition(false);
    setNom(categorie.name);
  }

  const nomNettoye = nom.trim();
  const inchange = nomNettoye === categorie.name;
  const doublon = !inchange && estDoublon(nomNettoye);
  const peutEnregistrer = nomNettoye.length > 0 && !doublon && !disabled;

  async function enregistrer() {
    if (!peutEnregistrer) return;
    // Nom inchangé : referme sans appel serveur inutile.
    if (inchange) {
      setEdition(false);
      return;
    }
    const ok = await onRenommer(categorie.id, nomNettoye);
    if (ok) setEdition(false);
  }

  if (edition) {
    return (
      <div className="flex flex-col gap-1 rounded-control px-2 py-1.5">
        <div className="flex items-center gap-2">
          <input
            ref={champRef}
            type="text"
            value={nom}
            maxLength={NOM_MAX}
            disabled={disabled}
            onChange={(e) => setNom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void enregistrer();
              } else if (e.key === "Escape") {
                e.preventDefault();
                annuler();
              }
            }}
            aria-label={`Nouveau nom pour ${categorie.name}`}
            className={cn(
              "h-9 min-w-0 flex-1 rounded-control border bg-surface-inset px-3 text-sm text-text",
              "placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary",
              doublon ? "border-danger" : "border-line focus:border-primary",
            )}
          />
          <button
            type="button"
            onClick={() => void enregistrer()}
            disabled={!peutEnregistrer}
            className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-control bg-primary px-3
              text-sm font-semibold text-text-onink transition-colors hover:bg-primary-600
              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
              disabled:cursor-not-allowed disabled:opacity-48"
          >
            Enregistrer
          </button>
          <button
            type="button"
            onClick={annuler}
            disabled={disabled}
            className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-control px-2 text-sm
              font-medium text-text-muted transition-colors hover:text-text focus:outline-none
              focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-48"
          >
            Annuler
          </button>
        </div>
        {doublon && (
          <p role="alert" className="px-1 text-xs text-danger">
            Une catégorie « {nomNettoye} » existe déjà à ce niveau.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-control px-2 py-1.5 hover:bg-surface-inset">
      <CategoryBadge name={categorie.name} colorKey={categorie.id} size="sm" />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={ouvrir}
          disabled={disabled}
          className="cursor-pointer text-xs font-semibold text-text-muted transition-colors
            hover:text-primary focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-48"
        >
          Renommer
        </button>
        <button
          type="button"
          onClick={() => onArchiver(categorie.id)}
          disabled={disabled}
          className="cursor-pointer text-xs font-semibold text-text-muted transition-colors
            hover:text-danger focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-48"
        >
          Archiver
        </button>
      </div>
    </div>
  );
}
