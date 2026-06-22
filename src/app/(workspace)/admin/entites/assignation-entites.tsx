"use client";

/**
 * Interface d'assignation des entités (BU) aux membres — MAQUETTE réactive.
 *
 * ⚠️ MOCK ABSOLU : aucune Server Action, aucun appel base de données. Les listes
 * `MOCK_ENTITES` / `MOCK_MEMBRES` sont en dur ; tout l'état d'assignation vit en
 * mémoire (useState). Le bouton « Enregistrer » n'envoie rien : il affiche un
 * toast inline « (démo) ». Quand les requêtes L3 seront livrées côté serveur,
 * ce composant sera recâblé sur une Server Action (props `membres` + action),
 * sans changer la présentation.
 *
 * Modèle métier (PLAN-entites-multi-tenant.md) : le workspace = le GROUPE
 * (« Omnicane ») ; les ENTITÉS sont des BU sous le workspace. Un membre a soit
 * une Vision Globale (tout le groupe), soit une Vision Entité (sous-ensemble
 * explicite d'entités — Omni-FI ne connaît pas les entités, l'assignation est
 * manuelle).
 *
 * Tokens & conventions UI_GUIDELINES (§1.1/§2.2/§2.3). Pas de dépendance externe
 * (clsx/cva/lucide non installés — règle 9) : micro-helper `cn` local + SVG
 * inline.
 */
import { useMemo, useState } from "react";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

type RoleMembre = "ADMIN" | "MANAGER" | "VIEWER";

interface EntiteMock {
  id: string;
  nom: string;
  /** Code interne Omnicane optionnel (mapping futur), cf. plan tableau `code`. */
  code: string;
}

interface MembreMock {
  id: string;
  nomComplet: string;
  email: string;
  role: RoleMembre;
  /**
   * `null` = Vision Globale (tout le groupe). Un tableau (même vide) = Vision
   * Entité restreinte à ces `entiteId`. Un tableau vide ⇒ aucun accès (cas
   * limite mis en avant par le plan, à signaler visuellement).
   */
  entitesAssignees: string[] | null;
}

// ── Données mockées ────────────────────────────────────────────────────────
// Vocabulaire issu du PLAN-entites-multi-tenant.md (« Sucrière BU », « Énergie
// BU ») et du briefing (« Omnicane Hôtellerie »).
const MOCK_ENTITES: EntiteMock[] = [
  { id: "ent-sucriere", nom: "Omnicane Sucrière", code: "SUC" },
  { id: "ent-energie", nom: "Omnicane Énergie", code: "ENE" },
  { id: "ent-hotellerie", nom: "Omnicane Hôtellerie", code: "HOT" },
  { id: "ent-immobilier", nom: "Omnicane Immobilier", code: "IMM" },
];

const MOCK_MEMBRES: MembreMock[] = [
  {
    id: "usr-1",
    nomComplet: "Aïsha Ramnauth",
    email: "aisha.ramnauth@omnicane.mu",
    role: "ADMIN",
    entitesAssignees: null, // Vision Globale
  },
  {
    id: "usr-2",
    nomComplet: "Jean-Claude Bissoondoyal",
    email: "jc.bissoondoyal@omnicane.mu",
    role: "MANAGER",
    entitesAssignees: ["ent-sucriere", "ent-energie"],
  },
  {
    id: "usr-3",
    nomComplet: "Priya Goorah",
    email: "priya.goorah@omnicane.mu",
    role: "VIEWER",
    entitesAssignees: ["ent-hotellerie"],
  },
  {
    id: "usr-4",
    nomComplet: "Marc Lebrun",
    email: "marc.lebrun@omnicane.mu",
    role: "MANAGER",
    entitesAssignees: null, // Vision Globale
  },
  {
    id: "usr-5",
    nomComplet: "Sundeep Callychurn",
    email: "sundeep.callychurn@omnicane.mu",
    role: "VIEWER",
    entitesAssignees: [], // cas limite : aucun accès
  },
];

// ── Helpers présentationnels ─────────────────────────────────────────────────
const ROLE_LABEL: Record<RoleMembre, string> = {
  ADMIN: "Administrateur",
  MANAGER: "Gestionnaire",
  VIEWER: "Lecteur",
};

// Tokens existants uniquement (cf. globals.css : pas de `info`). primary-50 /
// warning-bg / surface-inset sont définis dans le design system.
const ROLE_BADGE: Record<RoleMembre, string> = {
  ADMIN: "bg-primary-50 text-primary",
  MANAGER: "bg-warning-bg text-warning",
  VIEWER: "bg-surface-inset text-text-muted",
};

function initiales(nom: string): string {
  return nom
    .split(" ")
    .map((mot) => mot[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Type d'égalité « assignation identique » pour piloter l'état « modifié ». */
function memeAssignation(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const triA = [...a].sort();
  const triB = [...b].sort();
  return triA.every((v, i) => v === triB[i]);
}

export function AssignationEntites() {
  // État d'assignation courant, indexé par membre. Initialisé depuis le mock.
  const [assignations, setAssignations] = useState<Record<string, string[] | null>>(
    () =>
      Object.fromEntries(
        MOCK_MEMBRES.map((m) => [m.id, m.entitesAssignees]),
      ),
  );
  const [recherche, setRecherche] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // Référentiel initial pour détecter les modifications (dirty state).
  const initial = useMemo(
    () =>
      Object.fromEntries(
        MOCK_MEMBRES.map((m) => [m.id, m.entitesAssignees]),
      ) as Record<string, string[] | null>,
    [],
  );

  const membresFiltres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    if (q === "") return MOCK_MEMBRES;
    return MOCK_MEMBRES.filter(
      (m) =>
        m.nomComplet.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q),
    );
  }, [recherche]);

  const nbModifies = useMemo(
    () =>
      MOCK_MEMBRES.filter(
        (m) => !memeAssignation(assignations[m.id], initial[m.id]),
      ).length,
    [assignations, initial],
  );

  // ── Mutations d'état (purement locales) ───────────────────────────────────
  function basculerVisionGlobale(membreId: string, globale: boolean) {
    setToast(null);
    setAssignations((prev) => ({
      ...prev,
      // Globale = null ; repli en Vision Entité = tableau vide (à compléter).
      [membreId]: globale ? null : [],
    }));
  }

  function basculerEntite(membreId: string, entiteId: string) {
    setToast(null);
    setAssignations((prev) => {
      const courant = prev[membreId];
      // Cocher une entité depuis une Vision Globale fait basculer en Vision
      // Entité avec cette seule entité.
      const base = courant === null ? [] : courant;
      const present = base.includes(entiteId);
      const suivant = present
        ? base.filter((id) => id !== entiteId)
        : [...base, entiteId];
      return { ...prev, [membreId]: suivant };
    });
  }

  function reinitialiser() {
    setToast(null);
    setAssignations({ ...initial });
  }

  function enregistrer() {
    // MOCK : aucune Server Action. On simule un retour de succès inline.
    setToast(
      `Maquette — ${nbModifies} membre${nbModifies > 1 ? "s" : ""} ` +
        `serai${nbModifies > 1 ? "ent" : "t"} mis à jour une fois le back-end branché.`,
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Barre d'outils : recherche + compteur de modifications */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative flex-1 sm:max-w-xs">
          <span className="sr-only">Rechercher un membre</span>
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
            placeholder="Rechercher un membre…"
            className="h-10 w-full rounded-control border border-line bg-white pl-9 pr-3
              text-sm placeholder:text-text-faint focus:border-primary focus:outline-none
              focus:ring-2 focus:ring-primary/30"
          />
        </label>
        <p className="text-sm text-text-muted" role="status">
          {nbModifies === 0
            ? "Aucune modification"
            : `${nbModifies} modification${nbModifies > 1 ? "s" : ""} non enregistrée${nbModifies > 1 ? "s" : ""}`}
        </p>
      </div>

      {/* Liste des membres */}
      <ul className="flex flex-col gap-3">
        {membresFiltres.map((membre) => {
          const assignation = assignations[membre.id];
          const estGlobale = assignation === null;
          const nbEntites = estGlobale ? MOCK_ENTITES.length : assignation.length;
          const aucunAcces = !estGlobale && assignation.length === 0;

          return (
            <li
              key={membre.id}
              className="rounded-card bg-surface-card p-5 shadow-card"
            >
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
                    <p className="truncate text-sm font-semibold">
                      {membre.nomComplet}
                    </p>
                    <p className="truncate text-xs text-text-muted">
                      {membre.email}
                    </p>
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
                  aria-label={`Périmètre de ${membre.nomComplet}`}
                  className="flex rounded-control border border-line p-0.5 text-xs"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={estGlobale}
                    onClick={() => basculerVisionGlobale(membre.id, true)}
                    className={cn(
                      "rounded-[6px] px-2.5 py-1 font-medium transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                      estGlobale
                        ? "bg-primary text-white"
                        : "text-text-muted hover:text-text",
                    )}
                  >
                    Vision Globale
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!estGlobale}
                    onClick={() => basculerVisionGlobale(membre.id, false)}
                    className={cn(
                      "rounded-[6px] px-2.5 py-1 font-medium transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                      !estGlobale
                        ? "bg-primary text-white"
                        : "text-text-muted hover:text-text",
                    )}
                  >
                    Vision Entité
                  </button>
                </div>
              </div>

              {/* Récap périmètre */}
              <p
                className={cn(
                  "mt-3 text-xs",
                  aucunAcces ? "text-danger" : "text-text-muted",
                )}
              >
                {estGlobale
                  ? `Accès à l’ensemble du groupe (${MOCK_ENTITES.length} entités)`
                  : aucunAcces
                    ? "Aucune entité assignée — ce membre ne verra aucune donnée."
                    : `Vision restreinte à ${nbEntites} entité${nbEntites > 1 ? "s" : ""}`}
              </p>

              {/* Grille de cases par entité */}
              <fieldset
                className="mt-3 border-t border-line pt-3"
                disabled={estGlobale}
              >
                <legend className="sr-only">
                  Entités assignées à {membre.nomComplet}
                </legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {MOCK_ENTITES.map((entite) => {
                    const cochee = estGlobale || assignation.includes(entite.id);
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
                          disabled={estGlobale}
                          onChange={() => basculerEntite(membre.id, entite.id)}
                          className="size-4 shrink-0 accent-primary"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {entite.nom}
                        </span>
                        <span className="shrink-0 text-[11px] font-medium text-text-faint">
                          {entite.code}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </li>
          );
        })}

        {membresFiltres.length === 0 && (
          <li className="rounded-card border border-dashed border-line bg-surface-card p-8 text-center text-sm text-text-muted">
            Aucun membre ne correspond à « {recherche} ».
          </li>
        )}
      </ul>

      {/* Barre d'action collante */}
      <div className="sticky bottom-0 -mx-1 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface-card/95 px-4 py-3 shadow-card backdrop-blur">
        <div aria-live="polite" className="min-h-[1rem] text-xs">
          {toast !== null ? (
            <span role="status" className="text-success">
              {toast}
            </span>
          ) : (
            <span className="text-text-faint">
              Maquette — l’enregistrement sera branché sur le back-end.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reinitialiser}
            disabled={nbModifies === 0}
            className="h-9 rounded-control px-3 text-sm font-medium text-text-muted
              transition-colors hover:text-text focus:outline-none focus-visible:ring-2
              focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-48"
          >
            Réinitialiser
          </button>
          <button
            type="button"
            onClick={enregistrer}
            disabled={nbModifies === 0}
            className="flex h-9 items-center justify-center gap-2 rounded-control bg-primary
              px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-600
              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
              focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-48"
          >
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
