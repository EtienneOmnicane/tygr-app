"use client";

/**
 * Interface d'assignation des entités (BU) aux membres — CÂBLÉE (L3/L4).
 *
 * Données reçues en props depuis la page RSC (listerEntites + listerScopesMembre,
 * lus sous withWorkspace). L'enregistrement passe par la vraie Server Action
 * `definirScopesAction` (./actions.ts), PAR membre, via <form> + useActionState.
 *
 * Convention de périmètre — ALIGNÉE SUR LE SERVEUR (repositories/entites.ts) :
 *   • `entityIds = []`  → Vision Globale (le membre voit TOUT le groupe : aucune
 *                          ligne member_entity_scopes).
 *   • `entityIds = [..]`→ Vision Entité restreinte à ces entités.
 * Pour l'UX on distingue un `mode` explicite (GLOBALE | ENTITE) afin de gérer
 * proprement l'état transitoire « je veux restreindre mais je n'ai encore rien
 * coché » : enregistrer en mode ENTITE avec 0 case est BLOQUÉ côté UI, car envoyer
 * `[]` rouvrirait tout (contre l'intention). Garde-fou produit, pas une règle
 * serveur (le serveur, lui, traite [] comme Globale par conception).
 *
 * Tokens & conventions UI_GUIDELINES (§1.1/§2.2/§2.3). Pas de dépendance externe
 * (clsx/cva/lucide — règle 9) : micro-helper `cn` local + SVG inline.
 */
import { useMemo, useState } from "react";
import { useActionState } from "react";

import { definirScopesAction, type EtatAction } from "./actions";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

type RoleMembre = "ADMIN" | "MANAGER" | "VIEWER";

/** Entité telle que présentée (projection de EntiteLue côté page). */
export interface EntiteVue {
  id: string;
  nom: string;
  code: string | null;
}

/** Membre + son périmètre initial (scopeInitial = sortie de listerScopesMembre). */
export interface MembreVue {
  userId: string;
  nomComplet: string;
  email: string;
  role: RoleMembre;
  /** [] = Vision Globale (convention serveur) ; sinon entityIds du périmètre. */
  scopeInitial: string[];
}

// ── Helpers présentationnels ─────────────────────────────────────────────────
const ROLE_LABEL: Record<RoleMembre, string> = {
  ADMIN: "Administrator",
  MANAGER: "Manager",
  VIEWER: "Viewer",
};

// Tokens existants uniquement (cf. globals.css : pas de `info`).
const ROLE_BADGE: Record<RoleMembre, string> = {
  ADMIN: "bg-primary-50 text-primary",
  MANAGER: "bg-warning-bg text-warning",
  VIEWER: "bg-surface-inset text-text-muted",
};

const ETAT_INITIAL: EtatAction = { erreur: null, succes: null };

function initiales(nom: string): string {
  return nom
    .split(" ")
    .map((mot) => mot[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Égalité d'ensembles d'entityIds (ordre indifférent) pour le dirty state. */
function memeJeu(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const triA = [...a].sort();
  const triB = [...b].sort();
  return triA.every((v, i) => v === triB[i]);
}

export function AssignationEntites({
  entites,
  membres,
}: {
  entites: EntiteVue[];
  membres: MembreVue[];
}) {
  const [recherche, setRecherche] = useState("");

  const membresFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    if (q === "") return membres;
    return membres.filter(
      (m) =>
        m.nomComplet.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q),
    );
  }, [recherche, membres]);

  return (
    <div className="flex flex-col gap-4">
      {/* Barre d'outils : recherche */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative flex-1 sm:max-w-xs">
          <span className="sr-only">Search members</span>
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-faint"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Search members…"
            className="h-10 w-full rounded-control border border-line bg-white pl-9 pr-3
              text-sm placeholder:text-text-faint focus:border-primary focus:outline-none
              focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <p className="text-sm text-text-muted">
          {membres.length} member{membres.length > 1 ? "s" : ""}
        </p>
      </div>

      {/* Liste des membres — chaque carte gère son propre enregistrement */}
      <ul className="flex flex-col gap-3">
        {membresFiltres.map((membre) => (
          <CarteMembre key={membre.userId} membre={membre} entites={entites} />
        ))}

        {membresFiltres.length === 0 && (
          <li className="rounded-card border border-dashed border-line bg-surface-card p-8 text-center text-sm text-text-muted">
            No member matches “{recherche}”.
          </li>
        )}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Carte d'un membre : périmètre éditable + enregistrement (par membre) */
/* ------------------------------------------------------------------ */

function CarteMembre({
  membre,
  entites,
}: {
  membre: MembreVue;
  entites: EntiteVue[];
}) {
  // §12 — un ADMIN n'est jamais restreint à un périmètre (le serveur le refuse :
  // `AdminNonScopableError`). On ne PROPOSE donc pas le geste : laisser l'écran offrir des
  // cases à cocher pour les faire rejeter ensuite serait un piège. On explique la règle.
  if (membre.role === "ADMIN") {
    return <CarteMembreAdmin membre={membre} />;
  }
  return <CarteMembreScopable membre={membre} entites={entites} />;
}

/**
 * Carte d'un ADMIN : pas de sélecteur de périmètre. Administrer porte sur le tenant
 * entier ; un périmètre y est un contresens (et casserait ses propres écrans — ses gardes
 * d'écriture refuseraient de s'exécuter sous une vue partielle).
 */
function CarteMembreAdmin({ membre }: { membre: MembreVue }) {
  /**
   * CHEMIN DE RÉPARATION d'un périmètre HÉRITÉ (constat de la revue finale).
   *
   * Depuis §12, scoper un ADMIN est refusé — mais la garde n'EFFACE pas les états déjà en
   * base (une ligne posée avant la règle, ou par l'UI pré-§12 qui le permettait justement).
   * Un tel ADMIN voit le bandeau « Restricted view » et ses gardes d'écriture le bloquent.
   *
   * Or les messages d'erreur lui disaient : « Ask another administrator to lift the
   * restriction » — et cet autre administrateur n'avait AUCUN contrôle pour le faire. La
   * boucle était fermée sans issue : seul un UPDATE direct en base réparait. Prescrire une
   * action que l'interface ne permet pas est un piège opérationnel.
   *
   * `entityIds = []` (aucun hidden posté) est le chemin de réparation, explicitement permis
   * par la garde (elle ne mord que sur un périmètre NON VIDE).
   */
  const [etat, action, enCours] = useActionState(
    definirScopesAction,
    ETAT_INITIAL,
  );
  const aUnScopeHerite = membre.scopeInitial.length > 0;

  return (
    <li className="rounded-card bg-surface-card p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full
              bg-surface-inset text-xs font-semibold text-text-muted"
          >
            {initiales(membre.nomComplet)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{membre.nomComplet}</p>
            <p className="truncate text-xs text-text-muted">{membre.email}</p>
          </div>
          <span
            className={cn(
              "ml-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
              ROLE_BADGE[membre.role],
            )}
          >
            {ROLE_LABEL[membre.role]}
          </span>
        </div>

        {aUnScopeHerite ? (
          <form action={action} className="flex flex-col items-end gap-1.5">
            <input type="hidden" name="userId" value={membre.userId} />
            {/* Aucun `entityIds` posté ⇒ getAll → [] ⇒ retrait du périmètre. */}
            <p className="text-xs text-warning">
              Carries a restriction inherited from an earlier setup — it limits
              their own admin screens.
            </p>
            <div aria-live="polite" className="min-h-[1rem] text-xs">
              {etat.erreur !== null && (
                <span role="alert" className="text-danger">
                  {etat.erreur}
                </span>
              )}
              {etat.succes !== null && (
                <span role="status" className="text-success">
                  Restriction cleared.
                </span>
              )}
            </div>
            <button
              type="submit"
              disabled={enCours}
              className="h-9 rounded-control bg-primary px-3 text-xs font-semibold text-white
                transition-colors hover:bg-primary-600 focus:outline-none focus-visible:ring-2
                focus-visible:ring-primary focus-visible:ring-offset-2
                disabled:cursor-not-allowed disabled:opacity-[0.48]"
            >
              {enCours ? "Clearing…" : "Clear restriction"}
            </button>
          </form>
        ) : (
          <p className="text-xs text-text-muted">
            Always sees the whole group — an administrator cannot be limited to
            specific entities.
          </p>
        )}
      </div>
    </li>
  );
}

function CarteMembreScopable({
  membre,
  entites,
}: {
  membre: MembreVue;
  entites: EntiteVue[];
}) {
  // Mode initial dérivé de la convention serveur : [] = Globale.
  const [mode, setMode] = useState<"GLOBALE" | "ENTITE">(
    membre.scopeInitial.length === 0 ? "GLOBALE" : "ENTITE",
  );
  // Entités cochées en mode ENTITE (mémorisées même si on repasse en Globale).
  const [selection, setSelection] = useState<string[]>(membre.scopeInitial);

  const [etat, action, enCours] = useActionState(
    definirScopesAction,
    ETAT_INITIAL,
  );

  // entityIds qui seront ENVOYÉS (convention serveur : Globale ⇒ []).
  const entityIdsAEnvoyer = mode === "GLOBALE" ? [] : selection;

  // Dirty : l'ensemble à envoyer diffère-t-il du périmètre initial ?
  const modifie = !memeJeu(entityIdsAEnvoyer, membre.scopeInitial);

  // Garde-fou produit : mode ENTITE sans aucune case → envoyer [] rouvrirait tout.
  const entiteSansCase = mode === "ENTITE" && selection.length === 0;

  function toggleEntite(entiteId: string) {
    setSelection((prev) =>
      prev.includes(entiteId)
        ? prev.filter((id) => id !== entiteId)
        : [...prev, entiteId],
    );
  }

  function reinitialiser() {
    setMode(membre.scopeInitial.length === 0 ? "GLOBALE" : "ENTITE");
    setSelection(membre.scopeInitial);
  }

  const estGlobale = mode === "GLOBALE";
  const nbEntites = estGlobale ? entites.length : selection.length;

  return (
    <li className="rounded-card bg-surface-card p-5 shadow-card">
      {/* En-tête membre */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full
              bg-surface-inset text-xs font-semibold text-text-muted"
          >
            {initiales(membre.nomComplet)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{membre.nomComplet}</p>
            <p className="truncate text-xs text-text-muted">{membre.email}</p>
          </div>
          <span
            className={cn(
              "ml-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
              ROLE_BADGE[membre.role],
            )}
          >
            {ROLE_LABEL[membre.role]}
          </span>
        </div>

        {/* Bascule Vision Globale / Vision Entité */}
        <div
          role="radiogroup"
          aria-label={`Access for ${membre.nomComplet}`}
          className="flex rounded-control border border-line p-0.5 text-xs"
        >
          <button
            type="button"
            role="radio"
            aria-checked={estGlobale}
            disabled={enCours}
            onClick={() => setMode("GLOBALE")}
            className={cn(
              "rounded-[6px] px-2.5 py-1 font-medium transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              estGlobale
                ? "bg-primary text-white"
                : "text-text-muted hover:text-text",
            )}
          >
            Whole group
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!estGlobale}
            disabled={enCours}
            onClick={() => setMode("ENTITE")}
            className={cn(
              "rounded-[6px] px-2.5 py-1 font-medium transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              !estGlobale
                ? "bg-primary text-white"
                : "text-text-muted hover:text-text",
            )}
          >
            Selected entities
          </button>
        </div>
      </div>

      {/* Récap périmètre */}
      <p
        className={cn(
          "mt-3 text-xs",
          entiteSansCase ? "text-danger" : "text-text-muted",
        )}
      >
        {estGlobale
          ? `Access to the whole group (${entites.length} ${entites.length > 1 ? "entities" : "entity"})`
          : entiteSansCase
            ? "Pick at least one entity, or switch back to whole-group access."
            : `Access limited to ${nbEntites} ${nbEntites > 1 ? "entities" : "entity"}`}
      </p>

      {/* Formulaire : cases + champs cachés + bouton, le tout posté à l'action */}
      <form action={action}>
        <input type="hidden" name="userId" value={membre.userId} />
        {/* Un input caché par entité réellement envoyée → getAll("entityIds"). */}
        {entityIdsAEnvoyer.map((id) => (
          <input key={id} type="hidden" name="entityIds" value={id} />
        ))}

        <fieldset
          className="mt-3 border-t border-line pt-3"
          disabled={estGlobale || enCours}
        >
          <legend className="sr-only">
            Entities assigned to {membre.nomComplet}
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {entites.map((entite) => {
              const cochee = estGlobale || selection.includes(entite.id);
              return (
                <label
                  key={entite.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-control border px-3 py-2 text-sm transition-colors",
                    estGlobale
                      ? "cursor-not-allowed border-line bg-surface-inset opacity-60"
                      : cochee
                        ? "border-primary bg-primary/5"
                        : "border-line hover:border-primary/50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={cochee}
                    disabled={estGlobale || enCours}
                    onChange={() => toggleEntite(entite.id)}
                    className="size-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 flex-1 truncate">{entite.nom}</span>
                  {entite.code && (
                    <span className="shrink-0 text-[11px] font-medium text-text-faint">
                      {entite.code}
                    </span>
                  )}
                </label>
              );
            })}
            {entites.length === 0 && (
              <p className="col-span-full text-xs text-text-muted">
                No entity has been created for this group yet.
              </p>
            )}
          </div>
        </fieldset>

        {/* Pied de carte : retour action + boutons */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div aria-live="polite" className="min-h-[1rem] text-xs">
            {etat.erreur !== null && (
              <span role="alert" className="text-danger">
                {etat.erreur}
              </span>
            )}
            {etat.succes !== null && (
              <span role="status" className="text-success">
                {etat.succes}
              </span>
            )}
            {etat.erreur === null && etat.succes === null && modifie && (
              <span className="text-text-faint">Unsaved changes.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reinitialiser}
              disabled={!modifie || enCours}
              className="h-9 rounded-control px-3 text-sm font-medium text-text-muted
                transition-colors hover:text-text focus:outline-none focus-visible:ring-2
                focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-48"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={!modifie || entiteSansCase || enCours}
              className="flex h-9 items-center justify-center gap-2 rounded-control bg-primary
                px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-600
                focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-48"
            >
              {enCours && (
                <span
                  aria-hidden
                  className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                />
              )}
              {enCours ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </li>
  );
}
