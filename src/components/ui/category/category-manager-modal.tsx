"use client";

/**
 * CategoryManagerModal — gestion du référentiel de catégories (Pilier 1). Liste les
 * catégories (Nature / Sous-nature) en accordéons, avec recherche, renommage,
 * archivage confirmé et création contextuelle. Bâtie sur la primitive `Modal` (§4.4).
 *
 * Présentationnel + état de FORMULAIRE local : la liste arrive en props, les écritures
 * remontent via `actions` (ActionsReferentielCategories, fournies par le conteneur —
 * Server Actions du Backend en réel, stubs en démo/test). Le composant ne fetche rien ;
 * après une action réussie il demande au conteneur de rafraîchir via `onChanged`.
 *
 * Règles métier reflétées côté UI (le serveur reste juge) :
 * - Pas de doublon de nom au même niveau (miroir du UNIQUE
 *   `categories_workspace_name_parent`) → pré-validation + message serveur mappé.
 * - Archivage (is_active=false), JAMAIS de suppression dure : l'historique de splits
 *   référençant la catégorie doit survivre (FK + audit). D'où « Archiver », pas
 *   « Supprimer » — et un geste RÉVERSIBLE, ce qui interdit de le dramatiser
 *   visuellement au-delà du rang destructif de §2.3.
 *
 * Choix d'ergonomie, chacun réparant un défaut observé (`PLAN-cat-manager-ergonomie.md`) :
 *
 * - **Accordéons REPLIÉS par défaut** (§4.1 : la liste hiérarchique canonique du design
 *   system livre ses lignes repliées) : la liste des Natures devient le sommaire, et la
 *   découvrabilité est portée par le compteur de sous-catégories, pas par la hauteur.
 * - **La liste est le SEUL conteneur défilant.** `Modal` verrouille le scroll du body et
 *   centre son panneau : un contenu plus haut que le viewport déborderait des DEUX côtés,
 *   emportant titre et recherche au-dessus du bord haut, hors d'atteinte. Recherche et
 *   CTA de création restent donc hors du cadre défilant.
 * - **Un seul mode local actif** dans toute la modale (édition OU confirmation, sur une
 *   ligne). Le mode vit ici et non dans la ligne : sinon replier un groupe ou filtrer la
 *   liste démonterait la saisie en cours sans laisser de trace.
 * - **L'erreur s'affiche au contact du geste.** Avant, un échec d'archivage se rendait
 *   sous le bouton « Créer » — l'utilisateur lisait un échec de CRÉATION pour un geste
 *   d'archivage. Le `Callout` est désormais rattaché à la ligne ou au formulaire fautif.
 * - **Une région live permanente** annonce le résultat de chaque geste : sans elle, un
 *   archivage au clavier ne produit qu'une ligne disparue et un silence.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";

import { Modal } from "@/components/ui/modal/modal";
import { Callout } from "@/components/ui/states/callout";
import { cn, StateIllustration } from "@/components/ui/states";

import type { ActionsReferentielCategories, CategorieUI } from "./types";
import { LigneCategorie, type ModeLigne } from "./category-manager-ligne";

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

/**
 * Repli de casse ET d'accents pour la recherche : sans le retrait des diacritiques,
 * « electricite » ne trouve pas « Électricité » — précisément ce qu'un utilisateur tape
 * quand il cherche vite. Purement local (aucun lien avec `format-montant`/`format-date`,
 * dont la règle de source unique ne couvre que montants et dates).
 */
function replier(valeur: string): string {
  return valeur
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr");
}

/** Mode local actif — un seul dans toute la modale (cf. docstring). */
type ModeActif = { categoryId: string; type: Exclude<ModeLigne, "lecture"> } | null;

/** Emplacement d'une erreur serveur : au contact du geste qui l'a produite. */
type CibleErreur = { genre: "ligne"; categoryId: string } | { genre: "creation" };

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
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Gérer les catégories"
      size="sm"
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
      <ContenuGestionnaire categories={categories} actions={actions} onChanged={onChanged} />
    </Modal>
  );
}

/**
 * Corps du gestionnaire — porte TOUT l'état de travail (recherche, groupes ouverts, mode
 * local, formulaire de création, erreur).
 *
 * Il vit dans un composant séparé pour une raison de fond : `Modal` retourne `null` quand
 * elle est fermée, donc ce corps est DÉMONTÉ à la fermeture et l'état repart neuf à la
 * réouverture — gratuitement, sans effet de remise à zéro. C'est ce qui règle un défaut
 * réel de la version précédente, dont l'état vivait dans le composant exporté (monté en
 * permanence par le conteneur) : l'erreur d'un geste abandonné survivait à la fermeture,
 * et un filtre de recherche oublié aurait accueilli l'utilisateur à la réouverture en lui
 * faisant croire ses catégories disparues.
 */
function ContenuGestionnaire({
  categories,
  actions,
  onChanged,
}: {
  categories: CategorieUI[];
  actions: ActionsReferentielCategories;
  onChanged?: () => void;
}) {
  const [recherche, setRecherche] = useState("");
  const [ouverts, setOuverts] = useState<ReadonlySet<string>>(new Set());
  const [modeActif, setModeActif] = useState<ModeActif>(null);
  const [nomEdite, setNomEdite] = useState("");
  /** Formulaire de création ouvert (`parentId` nul = nouvelle Nature racine). */
  const [creation, setCreation] = useState<{ parentId: string | null } | null>(null);
  const [nomCreation, setNomCreation] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<{ cible: CibleErreur; message: string } | null>(null);
  const [annonce, setAnnonce] = useState("");
  /**
   * Ids archivés dont le rafraîchissement parent n'est pas encore arrivé. `onChanged` est
   * asynchrone et non attendable : sans ce sas, la ligne archivée reste cliquable pendant
   * le rechargement et un second clic répond « Catégorie introuvable » à propos d'un geste
   * pourtant RÉUSSI. Cet ensemble n'a pas besoin d'être purgé — dès que les props
   * arrivent, la catégorie archivée quitte `actives` et sa ligne n'est plus rendue ; et le
   * tout disparaît au démontage (cf. docstring).
   */
  const [mutes, setMutes] = useState<ReadonlySet<string>>(new Set());

  const champRechercheRef = useRef<HTMLInputElement>(null);
  const boutonNouvelleNatureRef = useRef<HTMLButtonElement>(null);
  const champCreationRef = useRef<HTMLInputElement>(null);

  // Ouvrir un formulaire de création y envoie le focus. Piloté ici plutôt que par
  // `autoFocus` : l'attribut ne rejoue pas quand le MÊME formulaire change de parent
  // (de la Nature A à la Nature B), et le focus resterait alors sur le lien cliqué.
  useEffect(() => {
    if (creation) champCreationRef.current?.focus();
  }, [creation]);

  const actives = useMemo(() => categories.filter((c) => c.isActive), [categories]);
  const natures = useMemo(() => actives.filter((c) => c.parentId === null), [actives]);

  const requete = replier(recherche.trim());

  /**
   * Groupes visibles. Une Nature qui matche montre TOUTES ses sous-catégories ; sinon
   * seules celles qui matchent, la Nature restant affichée pour donner le contexte du
   * résultat (une sous-catégorie orpheline de son parent est illisible).
   */
  const groupes = useMemo(() => {
    return natures
      .map((nature) => {
        const sousNatures = actives.filter((c) => c.parentId === nature.id);
        if (requete.length === 0) return { nature, sousNatures, natureMatche: true };
        const natureMatche = replier(nature.name).includes(requete);
        return {
          nature,
          sousNatures: natureMatche
            ? sousNatures
            : sousNatures.filter((sn) => replier(sn.name).includes(requete)),
          natureMatche,
        };
      })
      .filter((g) => requete.length === 0 || g.natureMatche || g.sousNatures.length > 0);
  }, [natures, actives, requete]);

  /** Ancre de focus toujours montée, quand l'élément manipulé vient de disparaître. */
  function focusAncre() {
    const cible = champRechercheRef.current ?? boutonNouvelleNatureRef.current;
    cible?.focus();
  }

  function fermerMode() {
    setModeActif(null);
    setErreur(null);
  }

  function basculerGroupe(natureId: string) {
    setOuverts((prev) => {
      const suivant = new Set(prev);
      if (suivant.has(natureId)) suivant.delete(natureId);
      else suivant.add(natureId);
      return suivant;
    });
    // Replier emporterait la ligne en cours d'édition : on quitte le mode explicitement
    // (même effet qu'« Annuler »), plutôt que de laisser une saisie mourir hors écran.
    if (modeActif) fermerMode();
    if (creation?.parentId === natureId) setCreation(null);
  }

  /** Pré-validation locale du doublon, insensible à la casse (le serveur re-juge). */
  function doublonAuNiveau(nom: string, parentId: string | null, exclureId?: string): boolean {
    const cible = nom.trim().toLocaleLowerCase("fr");
    if (cible.length === 0) return false;
    return categories.some(
      (c) =>
        c.id !== exclureId &&
        c.parentId === parentId &&
        c.name.toLocaleLowerCase("fr") === cible,
    );
  }

  const nomCreationNettoye = nomCreation.trim();
  const doublonCreation =
    creation !== null && doublonAuNiveau(nomCreationNettoye, creation.parentId);
  const peutCreer = nomCreationNettoye.length > 0 && !doublonCreation && !enCours;

  async function creer() {
    if (!creation || !peutCreer) return;
    const { parentId } = creation;
    const nom = nomCreationNettoye;
    setEnCours(true);
    setErreur(null);
    const r = await actions.creerCategorie({ name: nom, parentId });
    setEnCours(false);
    if (!r.ok) {
      setErreur({ cible: { genre: "creation" }, message: messagePourCode(r.code, r.message) });
      return;
    }
    // Le formulaire RESTE ouvert, vidé : on crée rarement une seule catégorie, et le
    // focus ne quitte jamais le champ (rien à rattraper).
    setNomCreation("");
    champCreationRef.current?.focus();
    if (parentId) setOuverts((prev) => new Set(prev).add(parentId));
    const masquee = requete.length > 0 && !replier(nom).includes(requete);
    const suffixe = masquee ? " Elle est masquée par la recherche en cours." : "";
    setAnnonce(
      parentId ? `Sous-catégorie ${nom} créée.${suffixe}` : `Nature ${nom} créée.${suffixe}`,
    );
    onChanged?.();
  }

  async function renommer(categorie: CategorieUI) {
    const nom = nomEdite.trim();
    if (nom.length === 0 || enCours) return;
    if (nom === categorie.name) {
      fermerMode();
      return;
    }
    setEnCours(true);
    setErreur(null);
    const r = await actions.renommerCategorie({ categoryId: categorie.id, name: nom });
    setEnCours(false);
    if (!r.ok) {
      setErreur({
        cible: { genre: "ligne", categoryId: categorie.id },
        message: messagePourCode(r.code, r.message),
      });
      return;
    }
    setModeActif(null);
    // Renommée sous filtre actif, la ligne peut cesser de matcher et se démonter sous le
    // doigt : on le DIT et on rattrape le focus, au lieu de le laisser tomber sur <body>.
    const masquee = requete.length > 0 && !replier(nom).includes(requete);
    setAnnonce(
      `${categorie.name} renommée en ${nom}.${
        masquee ? " Elle est masquée par la recherche en cours." : ""
      }`,
    );
    if (masquee) focusAncre();
    onChanged?.();
  }

  async function archiver(categorie: CategorieUI) {
    if (enCours) return;
    setEnCours(true);
    setErreur(null);
    const r = await actions.archiverCategorie(categorie.id);
    setEnCours(false);
    if (!r.ok) {
      setErreur({
        cible: { genre: "ligne", categoryId: categorie.id },
        message: messagePourCode(r.code, r.message),
      });
      return;
    }
    setModeActif(null);
    setMutes((prev) => new Set(prev).add(categorie.id));
    setAnnonce(`Catégorie ${categorie.name} archivée.`);
    focusAncre();
    onChanged?.();
  }

  function erreurDeLigne(categoryId: string): ReactNode {
    if (erreur?.cible.genre !== "ligne" || erreur.cible.categoryId !== categoryId) return null;
    return (
      <div className="mt-2">
        <Callout severite="danger" role="alert">
          {erreur.message}
        </Callout>
      </div>
    );
  }

  function rendreLigne(categorie: CategorieUI) {
    const mode: ModeLigne =
      modeActif?.categoryId === categorie.id ? modeActif.type : "lecture";
    return (
      <LigneCategorie
        categorie={categorie}
        mode={mode}
        nomEdite={mode === "edition" ? nomEdite : categorie.name}
        onNomEdite={setNomEdite}
        onOuvrirEdition={() => {
          setErreur(null);
          setNomEdite(categorie.name);
          setModeActif({ categoryId: categorie.id, type: "edition" });
        }}
        onOuvrirConfirmation={() => {
          setErreur(null);
          setModeActif({ categoryId: categorie.id, type: "confirmation" });
        }}
        onAnnulerMode={fermerMode}
        onRenommer={() => void renommer(categorie)}
        onArchiver={() => void archiver(categorie)}
        estDoublon={(nom) => doublonAuNiveau(nom, categorie.parentId, categorie.id)}
        enCours={enCours}
        inerte={mutes.has(categorie.id)}
        erreur={erreurDeLigne(categorie.id)}
      />
    );
  }

  return (
      <div className="flex flex-col gap-4">
        {/*
          Région live montée en PERMANENCE et vide : une région insérée dans le DOM avec
          son texte déjà présent est annoncée de façon peu fiable selon les couples
          lecteur d'écran / navigateur. Seul son contenu change.
        */}
        <p role="status" aria-live="polite" className="sr-only">
          {annonce}
        </p>

        {actives.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <StateIllustration variant="table" className="mb-5 h-16 w-16 text-text-faint" />
            <p className="text-base font-semibold text-text">Aucune catégorie pour l’instant</p>
            <p className="mt-1 max-w-sm text-sm text-text-muted">
              Créez une première Nature (par exemple «&nbsp;Charges&nbsp;»), puis
              ajoutez-lui des sous-catégories.
            </p>
            {creation ? (
              <div className="mt-5 w-full text-left">
                <FormulaireCreation
                  ref={champCreationRef}
                  label="Nom de la nouvelle Nature"
                  placeholder="Ex. Charges"
                  valeur={nomCreation}
                  onValeur={setNomCreation}
                  doublon={doublonCreation}
                  peutCreer={peutCreer}
                  onCreer={() => void creer()}
                  onAnnuler={() => {
                    setCreation(null);
                    setErreur(null);
                    boutonNouvelleNatureRef.current?.focus();
                  }}
                  erreur={erreur?.cible.genre === "creation" ? erreur.message : undefined}
                />
              </div>
            ) : (
              <button
                ref={boutonNouvelleNatureRef}
                type="button"
                onClick={() => {
                  setErreur(null);
                  setNomCreation("");
                  setCreation({ parentId: null });
                }}
                className="mt-5 inline-flex h-10 cursor-pointer items-center rounded-control
                  bg-primary px-4 text-sm font-semibold text-text-onink transition-colors
                  hover:bg-primary-600 focus:outline-none focus-visible:ring-2
                  focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                ＋ Nouvelle Nature
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Tête : recherche + création racine. HORS du cadre défilant. */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-4 w-4"
                  >
                    <circle cx="7" cy="7" r="4.5" />
                    <path d="m10.5 10.5 3 3" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  ref={champRechercheRef}
                  type="text"
                  value={recherche}
                  onChange={(e) => setRecherche(e.target.value)}
                  aria-label="Rechercher une catégorie"
                  placeholder="Rechercher une catégorie…"
                  className="h-10 w-full rounded-control border border-line bg-surface-inset pl-9 pr-10
                    text-sm text-text placeholder:text-text-faint focus:border-primary
                    focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {recherche.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setRecherche("");
                      champRechercheRef.current?.focus();
                    }}
                    aria-label="Effacer la recherche"
                    className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2
                      cursor-pointer items-center justify-center rounded-control text-text-muted
                      transition-colors hover:bg-surface-card hover:text-text focus:outline-none
                      focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span aria-hidden="true" className="text-base leading-none">
                      ×
                    </span>
                  </button>
                )}
              </div>
              <button
                ref={boutonNouvelleNatureRef}
                type="button"
                onClick={() => {
                  setErreur(null);
                  setNomCreation("");
                  setCreation({ parentId: null });
                }}
                className="inline-flex h-10 shrink-0 cursor-pointer items-center rounded-control
                  px-2 text-sm font-semibold text-primary transition-colors hover:text-primary-600
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                ＋ Nouvelle Nature
              </button>
            </div>

            {creation?.parentId === null && (
              <FormulaireCreation
                ref={champCreationRef}
                label="Nom de la nouvelle Nature"
                placeholder="Ex. Charges"
                valeur={nomCreation}
                onValeur={setNomCreation}
                doublon={doublonCreation}
                peutCreer={peutCreer}
                onCreer={() => void creer()}
                onAnnuler={() => {
                  setCreation(null);
                  setErreur(null);
                  boutonNouvelleNatureRef.current?.focus();
                }}
                erreur={erreur?.cible.genre === "creation" ? erreur.message : undefined}
              />
            )}

            {groupes.length === 0 ? (
              <div className="rounded-control bg-surface-inset px-4 py-8 text-center">
                <p className="text-sm text-text-muted">
                  Aucune catégorie ne correspond à «&nbsp;{recherche.trim()}&nbsp;».
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setRecherche("");
                    champRechercheRef.current?.focus();
                  }}
                  className="mt-2 cursor-pointer text-sm font-semibold text-primary
                    transition-colors hover:text-primary-600 focus:outline-none
                    focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Effacer la recherche
                </button>
              </div>
            ) : (
              /*
                SEUL conteneur défilant de la modale (cf. docstring) : `Modal` a verrouillé
                le scroll du body, tout débordement hors d'ici serait irrattrapable.
              */
              <ul className="flex max-h-[min(60vh,480px)] flex-col gap-1 overflow-y-auto">
                {groupes.map(({ nature, sousNatures }) => {
                  const ouvert = requete.length > 0 || ouverts.has(nature.id);
                  const idListe = `cat-groupe-${nature.id}`;
                  return (
                    <li key={nature.id}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => basculerGroupe(nature.id)}
                          aria-expanded={ouvert}
                          aria-controls={idListe}
                          className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center
                            justify-center rounded-control text-text-muted transition-colors
                            hover:bg-surface-inset hover:text-text focus:outline-none
                            focus-visible:ring-2 focus-visible:ring-primary"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            aria-hidden="true"
                            className={cn("h-4 w-4 transition-transform", ouvert && "rotate-90")}
                          >
                            <path
                              d="m6 3.5 4.5 4.5L6 12.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <span className="sr-only">
                            {ouvert ? "Replier" : "Déplier"} {nature.name}
                          </span>
                        </button>
                        <div className="min-w-0 flex-1">{rendreLigne(nature)}</div>
                        <span className="shrink-0 whitespace-nowrap pr-1 text-xs text-text-muted">
                          {sousNatures.length}
                          {sousNatures.length > 1 ? " sous-catégories" : " sous-catégorie"}
                        </span>
                      </div>

                      {/*
                        Groupe replié = DÉMONTÉ, jamais seulement masqué : le focus trap
                        de `Modal` collecte ses focusables par `querySelectorAll` sans
                        filtrer la visibilité, et des boutons cachés y créeraient des
                        arrêts de tabulation sur du vide.
                      */}
                      <div id={idListe} className={ouvert ? undefined : "hidden"}>
                        {ouvert && (
                        <>
                        <ul className="ml-9 flex flex-col gap-0.5 border-l border-line pl-2">
                          {sousNatures.map((sn) => (
                            <li key={sn.id}>{rendreLigne(sn)}</li>
                          ))}
                        </ul>
                        {creation?.parentId === nature.id ? (
                          <div className="ml-9 mt-1 pl-2">
                            <FormulaireCreation
                              ref={champCreationRef}
                              label={`Nom de la sous-catégorie de ${nature.name}`}
                              placeholder="Ex. Électricité"
                              valeur={nomCreation}
                              onValeur={setNomCreation}
                              doublon={doublonCreation}
                              peutCreer={peutCreer}
                              onCreer={() => void creer()}
                              onAnnuler={() => {
                                setCreation(null);
                                setErreur(null);
                              }}
                              erreur={
                                erreur?.cible.genre === "creation" ? erreur.message : undefined
                              }
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setErreur(null);
                              setNomCreation("");
                              setCreation({ parentId: nature.id });
                            }}
                            className="ml-9 mt-0.5 inline-flex h-8 cursor-pointer items-center
                              rounded-control px-2 text-[13px] font-semibold text-primary
                              transition-colors hover:text-primary-600 focus:outline-none
                              focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            ＋ ajouter une sous-catégorie
                          </button>
                        )}
                        </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
  );
}

/**
 * Formulaire de création inline. Le `parentId` est déduit du POINT D'ENTRÉE (bouton de
 * tête = Nature racine, lien sous un groupe = sous-catégorie), ce qui remplace l'ancien
 * `<select>` de parent : celui-ci flottait au-dessus de la liste sans être rattaché
 * visuellement à quoi que ce soit, et c'était la source de confusion à corriger.
 */
function FormulaireCreation({
  ref,
  label,
  placeholder,
  valeur,
  onValeur,
  doublon,
  peutCreer,
  onCreer,
  onAnnuler,
  erreur,
}: {
  ref?: Ref<HTMLInputElement>;
  label: string;
  placeholder: string;
  valeur: string;
  onValeur: (v: string) => void;
  doublon: boolean;
  peutCreer: boolean;
  onCreer: () => void;
  onAnnuler: () => void;
  erreur?: string;
}) {
  const idErreur = `creation-doublon-${label.replace(/\s+/g, "-")}`;
  return (
    <div
      className="flex flex-col gap-2 rounded-control bg-surface-inset p-3"
      onKeyDown={(e) => {
        // Confine Escape au formulaire : sans ça, il remonte jusqu'au listener de
        // `Modal` (posé sur `document`) et ferme toute la surface avec la saisie.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onAnnuler();
        }
      }}
    >
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[13px] text-text-muted">{label}</span>
          <input
            ref={ref}
            type="text"
            value={valeur}
            maxLength={NOM_MAX}
            onChange={(e) => onValeur(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (peutCreer) onCreer();
              }
            }}
            placeholder={placeholder}
            aria-invalid={doublon}
            aria-describedby={doublon ? idErreur : undefined}
            className={cn(
              "h-10 min-w-0 rounded-control border bg-surface-card px-3 text-sm text-text",
              "placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary",
              doublon ? "border-danger" : "border-line focus:border-primary",
            )}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            if (peutCreer) onCreer();
          }}
          aria-disabled={!peutCreer}
          className={cn(
            `inline-flex h-10 shrink-0 items-center rounded-control bg-success px-4 text-sm
             font-semibold text-text-onink transition-opacity focus:outline-none
             focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`,
            peutCreer ? "cursor-pointer hover:opacity-90" : "cursor-not-allowed opacity-48",
          )}
        >
          Créer
        </button>
        <button
          type="button"
          onClick={onAnnuler}
          className="inline-flex h-10 shrink-0 cursor-pointer items-center rounded-control px-2
            text-sm font-medium text-text-muted transition-colors hover:text-text
            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Annuler
        </button>
      </div>
      {doublon && (
        <p id={idErreur} className="text-xs text-danger">
          Une catégorie «&nbsp;{valeur.trim()}&nbsp;» existe déjà à ce niveau.
        </p>
      )}
      {erreur && (
        <Callout severite="danger" role="alert">
          {erreur}
        </Callout>
      )}
    </div>
  );
}
