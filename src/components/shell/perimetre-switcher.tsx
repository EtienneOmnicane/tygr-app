"use client";

/**
 * PerimetreSwitcher — sélecteur de périmètre d'affichage (L8b-1) dans le header
 * (zone ml-auto, à côté du WorkspaceSwitcher). Deux axes SEULEMENT :
 *   • « Groupe »      = aucun compte coché → on voit TOUT le droit du membre.
 *   • « Banque/compte » = N comptes cochés → vue restreinte à ces comptes.
 * (L'axe Entité est un lot séparé L8b-2 — rien ici.)
 *
 * CANAL (calque WorkspaceSwitcher) : un <form action={definirViewFilter}> poste
 * un <input hidden name="bankAccountId"> par compte coché ; « Groupe » = aucun
 * input. Le serveur écrit le JWT (unstable_update) et recharge la page. La
 * SÉCURITÉ n'est PAS ici : le serveur intersecte le filtre avec le DROIT (RLS,
 * tenancy.ts:391-419) — ce composant est du CONFORT.
 *
 * UX (calque CategoryPicker, UI_GUIDELINES §4.4 « dropdown riche ») : déclencheur
 * sur fond ink → popover sur surface claire avec recherche en tête (focus auto),
 * option « Groupe » épinglée, liste de comptes à cocher, bouton « Appliquer ».
 * Fermeture clic-extérieur + Échap. Pas de dépendance externe (règle 9) : `cn`
 * local + popover natif.
 *
 * État actif : les comptes cochés à l'ouverture = `viewFilterActif` ∩ `comptes`
 * (un id du filtre absent de `comptes` — révoqué / hors scope — est IGNORÉ, pas
 * de ligne fantôme). 0 coché ⇒ libellé « Groupe » (jamais « 0 compte »).
 *
 * Tokens sémantiques uniquement : l'état actif se marque en `accent`/`primary`
 * (coche), JAMAIS en vert/rouge de donnée (réservés aux montants inflow/outflow).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useActionState } from "react";

import {
  definirViewFilter,
  type EtatPerimetre,
} from "@/app/(workspace)/(dashboard)/actions";
import type { CompteConnecte } from "@/server/repositories/dashboard";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const ETAT_INITIAL: EtatPerimetre = { erreur: null };

/** Libellé court d'un compte pour la liste / le déclencheur (banque · compte). */
function libelleCompte(c: CompteConnecte): string {
  return c.institutionName ? `${c.institutionName} · ${c.accountName}` : c.accountName;
}

export function PerimetreSwitcher({
  comptes,
  viewFilterActif,
}: {
  /** Comptes visibles du membre (scopés RLS), source du sélecteur. */
  comptes: CompteConnecte[];
  /** viewFilter courant (ids) ; null/[]/absent = « Groupe ». */
  viewFilterActif: string[] | null;
}) {
  const [ouvert, setOuvert] = useState(false);
  const [recherche, setRecherche] = useState("");
  const [, action, enCours] = useActionState(definirViewFilter, ETAT_INITIAL);
  const conteneurRef = useRef<HTMLDivElement>(null);
  const inputRechercheRef = useRef<HTMLInputElement>(null);

  // Ensemble des ids RÉELLEMENT sélectionnables (présents dans comptes) — sert à
  // ignorer les ids fantômes du filtre actif (révoqués / hors scope).
  const idsConnus = useMemo(
    () => new Set(comptes.map((c) => c.bankAccountId)),
    [comptes],
  );

  // Sélection locale (cochés). Initialisée UNE fois depuis viewFilterActif ∩
  // comptes (ids fantômes ignorés). Pas de resynchronisation par effet : après un
  // Appliquer, definirViewFilter fait redirect('/') et le conteneur remonte le
  // composant via une `key` dérivée du périmètre actif (cf. app-header.tsx) → ce
  // useState repart proprement sur la nouvelle vérité serveur. (Éviter setState
  // dans un effet, react-hooks/set-state-in-effect.)
  const [coches, setCoches] = useState<Set<string>>(
    () => new Set((viewFilterActif ?? []).filter((id) => idsConnus.has(id))),
  );

  // Fermeture clic-extérieur (mousedown) + Échap (calque CategoryPicker).
  useEffect(() => {
    if (!ouvert) return;
    const conteneur = conteneurRef.current;
    function onPointerDown(e: MouseEvent) {
      if (conteneur && !conteneur.contains(e.target as Node)) setOuvert(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOuvert(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [ouvert]);

  // Focus la recherche à l'ouverture.
  useEffect(() => {
    if (ouvert) requestAnimationFrame(() => inputRechercheRef.current?.focus());
  }, [ouvert]);

  // Libellé du déclencheur : « Groupe » (0 coché), le compte (1), « N comptes » (N).
  const nbCoches = coches.size;
  let libelleDeclencheur: string;
  if (nbCoches === 0) {
    libelleDeclencheur = "Groupe";
  } else if (nbCoches === 1) {
    const seul = comptes.find((c) => coches.has(c.bankAccountId));
    libelleDeclencheur = seul ? libelleCompte(seul) : "1 compte";
  } else {
    libelleDeclencheur = `${nbCoches} comptes`;
  }

  const comptesFiltres = useMemo(() => {
    const q = recherche.trim().toLocaleLowerCase("fr");
    if (!q) return comptes;
    return comptes.filter((c) =>
      libelleCompte(c).toLocaleLowerCase("fr").includes(q),
    );
  }, [comptes, recherche]);

  function basculer(id: string) {
    setCoches((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Aucun compte connecté → pas de sélecteur (rien à filtrer).
  if (comptes.length === 0) return null;

  return (
    <div className="relative" ref={conteneurRef}>
      <button
        type="button"
        onClick={() => setOuvert((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={ouvert}
        className="flex max-w-[220px] items-center gap-2 rounded-full bg-surface-inset
          px-3 py-1 text-xs font-medium text-ink focus:outline-none focus:ring-2
          focus:ring-primary"
      >
        <span aria-hidden className="text-ink/60">Vue</span>
        <span className="truncate">{libelleDeclencheur}</span>
        <span aria-hidden>▾</span>
      </button>

      {ouvert && (
        <form
          action={action}
          className="absolute right-0 z-20 mt-2 w-[300px] rounded-control bg-surface-card
            p-2 shadow-popover"
          role="dialog"
          aria-label="Choisir le périmètre d'affichage"
        >
          <input
            ref={inputRechercheRef}
            type="text"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Rechercher un compte…"
            aria-label="Rechercher un compte"
            className="mb-2 w-full rounded-control border border-line bg-surface-inset
              px-3 py-2 text-sm text-text placeholder:text-text-faint focus:border-primary
              focus:outline-none focus:ring-2 focus:ring-primary"
          />

          {/* Option « Groupe » épinglée : décocher tout = revenir au défaut. */}
          <button
            type="button"
            onClick={() => setCoches(new Set())}
            role="option"
            aria-selected={nbCoches === 0}
            className={cn(
              "mb-1 flex w-full items-center justify-between rounded-control px-2 py-1.5",
              "text-left text-sm transition-colors focus:outline-none focus-visible:ring-2",
              "focus-visible:ring-primary",
              nbCoches === 0 ? "bg-primary-50 font-medium" : "hover:bg-surface-inset",
            )}
          >
            <span>
              Groupe
              <span className="ml-1 text-xs text-text-muted">· tous les comptes</span>
            </span>
            {nbCoches === 0 && (
              <span aria-hidden className="text-xs font-semibold text-primary">✓</span>
            )}
          </button>

          <div
            role="listbox"
            aria-label="Comptes"
            aria-multiselectable="true"
            className="max-h-64 overflow-y-auto border-t border-line pt-1"
          >
            {comptesFiltres.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-text-muted">
                Aucun compte ne correspond.
              </p>
            ) : (
              comptesFiltres.map((c) => {
                const coche = coches.has(c.bankAccountId);
                return (
                  <button
                    key={c.bankAccountId}
                    type="button"
                    role="option"
                    aria-selected={coche}
                    onClick={() => basculer(c.bankAccountId)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left",
                      "text-sm transition-colors focus:outline-none focus-visible:ring-2",
                      "focus-visible:ring-primary",
                      coche ? "bg-primary-50" : "hover:bg-surface-inset",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border text-[10px]",
                        coche
                          ? "border-primary bg-primary text-text-onink"
                          : "border-line",
                      )}
                    >
                      {coche ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text">
                      {libelleCompte(c)}
                    </span>
                    <span className="shrink-0 text-xs text-text-muted">{c.currency}</span>
                  </button>
                );
              })
            )}
          </div>

          {/* Inputs cachés = la sélection POSTÉE. « Groupe » ⇒ aucun input ⇒ []. */}
          {[...coches].map((id) => (
            <input key={id} type="hidden" name="bankAccountId" value={id} />
          ))}

          <div className="mt-2 flex items-center justify-end gap-2 border-t border-line pt-2">
            <button
              type="submit"
              disabled={enCours}
              className="inline-flex h-9 items-center justify-center rounded-control bg-primary
                px-3 text-sm font-semibold text-text-onink transition-colors hover:bg-primary-600
                focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                disabled:cursor-not-allowed disabled:opacity-48"
            >
              {enCours ? "…" : "Appliquer"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
