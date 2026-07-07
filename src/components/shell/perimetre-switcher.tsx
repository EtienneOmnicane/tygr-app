"use client";

/**
 * PerimetreSwitcher — sélecteur de périmètre d'affichage dans le header (zone
 * ml-auto, à côté du WorkspaceSwitcher). DEUX onglets, modes SÉPARÉS (pas de
 * mixage) :
 *   • « Par compte » (L8b-1) — « Groupe » (aucun compte coché → tout le droit) ou
 *     N comptes cochés. Poste <input hidden name="bankAccountId"> via definirViewFilter.
 *   • « Par entité » (L8b-2) — choix UNIQUE d'une entité (BU) ; « Groupe » épinglée =
 *     reset. Poste un seul <input hidden name="entityId"> via definirPerimetreEntite,
 *     qui TRADUIT l'entité en comptes CÔTÉ SERVEUR (le client ne forge pas la liste).
 *
 * SÉCURITÉ : ce composant est du CONFORT. Le serveur intersecte le filtre avec le
 * DROIT (RLS, tenancy.ts) — le filtre ne peut que rétrécir. La traduction entité→comptes
 * est SERVEUR (definirPerimetreEntite), jamais ici.
 *
 * UX (calque CategoryPicker, UI_GUIDELINES §4.4 « dropdown riche ») : déclencheur sur
 * fond ink → popover sur surface claire ; barre d'onglets en tête, recherche (focus
 * auto), option « Groupe » épinglée, liste, bouton « Appliquer ». Fermeture
 * clic-extérieur + Échap. Pas de dépendance externe (règle 9) : `cn` local + popover natif.
 *
 * Tokens sémantiques uniquement : onglet/option actifs en `primary`, JAMAIS vert/rouge
 * de donnée (réservés aux montants inflow/outflow).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useActionState } from "react";

import {
  definirViewFilter,
  definirPerimetreEntite,
  type EtatPerimetre,
} from "@/app/(workspace)/actions";
import {
  basculerGroupe,
  etatSelectionGroupe,
  grouperParTitulaire,
} from "@/lib/grouper-titulaire";
import type {
  CompteConnecte,
  EntiteVisible,
} from "@/server/repositories/dashboard";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const ETAT_INITIAL: EtatPerimetre = { erreur: null };

type Onglet = "compte" | "entite";

/** Libellé court d'un compte pour la liste / le déclencheur (banque · compte). */
function libelleCompte(c: CompteConnecte): string {
  return c.institutionName ? `${c.institutionName} · ${c.accountName}` : c.accountName;
}

/**
 * Option « compte » de la listbox (markup HISTORIQUE, inchangé par le groupement
 * titulaire — D6) : checkbox per-compte, extraite pour être rendue à l'identique
 * en liste plate (repli mono-groupe) ET sous un sous-en-tête titulaire.
 */
function optionCompte(
  c: CompteConnecte,
  coches: Set<string>,
  basculer: (id: string) => void,
) {
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
}

/**
 * Re-dérive le NOM de l'entité dont l'ensemble de comptes correspond EXACTEMENT au
 * filtre courant (égalité ENSEMBLISTE : même cardinalité + mêmes ids), sinon `null`.
 * PURE (testable, sans effet). Sert au libellé du déclencheur (« Sucre ») et à
 * l'onglet ouvert par défaut.
 *
 * Pourquoi l'égalité EXACTE (et pas « même nombre de comptes ») : deux entités de
 * même taille seraient confondues, et un filtre « par compte » de N comptes piochés
 * dans des entités différentes afficherait à tort un nom d'entité. On n'affiche
 * « Sucre » QUE si le filtre est exactement l'ensemble des comptes (visibles) de Sucre.
 *
 * Péremption assumée (stratégie a, dette PERIMETRE-ENTITE-DERIVE1) : si l'ADMIN
 * réassigne ensuite un compte à/hors de l'entité, le filtre stocké (figé sur les
 * anciens ids) ne correspond plus → `null` → repli « N comptes ». Pas de mensonge.
 */
function entiteDuFiltre(
  viewFilterActif: string[] | null,
  entites: EntiteVisible[],
): string | null {
  if (!viewFilterActif || viewFilterActif.length === 0) return null;
  const filtre = new Set(viewFilterActif);
  if (filtre.size !== viewFilterActif.length) return null; // doublons → pas un ensemble propre
  for (const e of entites) {
    if (e.bankAccountIds.length !== filtre.size) continue;
    if (e.bankAccountIds.every((id) => filtre.has(id))) return e.name;
  }
  return null;
}

export function PerimetreSwitcher({
  comptes,
  entites,
  viewFilterActif,
}: {
  /** Comptes visibles du membre (scopés RLS), source de l'onglet « Par compte ». */
  comptes: CompteConnecte[];
  /** Entités visibles du membre (scopées RLS), source de l'onglet « Par entité ». */
  entites: EntiteVisible[];
  /** viewFilter courant (ids) ; null/[]/absent = « Groupe ». */
  viewFilterActif: string[] | null;
}) {
  const [ouvert, setOuvert] = useState(false);
  const [recherche, setRecherche] = useState("");
  const conteneurRef = useRef<HTMLDivElement>(null);
  const inputRechercheRef = useRef<HTMLInputElement>(null);

  // Entité dont l'ensemble de comptes correspond EXACTEMENT au filtre courant (ou
  // null). Dérive l'onglet ouvert par défaut + la présélection. Stable au remount
  // (key viewFilterActif), donc calculée une fois ici (pas un useMemo dépendant).
  const entiteActive = entites.find(
    (e) => entiteDuFiltre(viewFilterActif, [e]) !== null,
  );

  // Onglet ouvert par défaut : « Par entité » si le filtre actif EST une entité
  // connue (présélectionnée), sinon « Par compte ». Repart de cette vérité serveur
  // au remount.
  const [onglet, setOnglet] = useState<Onglet>(
    () => (entiteActive ? "entite" : "compte"),
  );

  // Deux useActionState distincts (une action par onglet). Seul le <form> de
  // l'onglet ACTIF est rendu, donc une seule action peut être soumise à la fois.
  const [, actionCompte, enCoursCompte] = useActionState(
    definirViewFilter,
    ETAT_INITIAL,
  );
  const [, actionEntite, enCoursEntite] = useActionState(
    definirPerimetreEntite,
    ETAT_INITIAL,
  );

  // Ensemble des ids RÉELLEMENT sélectionnables (présents dans comptes) — sert à
  // ignorer les ids fantômes du filtre actif (révoqués / hors scope).
  const idsConnus = useMemo(
    () => new Set(comptes.map((c) => c.bankAccountId)),
    [comptes],
  );

  // Sélection locale « Par compte » (cochés). Initialisée UNE fois depuis
  // viewFilterActif ∩ comptes (ids fantômes ignorés). Pas de resynchronisation par
  // effet : après un Appliquer, l'action fait redirect('/') et le conteneur remonte
  // le composant via une `key` dérivée du périmètre actif (cf. app-header.tsx) → ce
  // useState repart proprement sur la nouvelle vérité serveur.
  const [coches, setCoches] = useState<Set<string>>(
    () => new Set((viewFilterActif ?? []).filter((id) => idsConnus.has(id))),
  );

  // Sélection locale « Par entité » (UNE entité, radio-like). Le mode « Par entité »
  // est INDÉPENDANT de `coches` (pas de mixage). Présélectionne l'entité active si le
  // filtre courant correspond exactement à l'une d'elles ; sinon null (« Groupe »).
  const [entiteChoisie, setEntiteChoisie] = useState<string | null>(
    () => entiteActive?.entityId ?? null,
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

  // Libellé du déclencheur (FERMÉ) : dérivé de la vérité serveur `viewFilterActif`.
  //   « Groupe » (0)  →  « Sucre » si le filtre = exactement une entité (C5)  →  le
  //   nom du compte (1 compte, hors entité)  →  « N comptes » (repli / péremption).
  // INVARIANT : tout id de `coches` provient de `comptes` (init filtré par idsConnus
  // + basculer() n'ajoute que des ids de la liste rendue) → le find à 1 coché ne
  // retourne jamais undefined.
  const nbCoches = coches.size;
  let libelleDeclencheur: string;
  if (nbCoches === 0) {
    libelleDeclencheur = "Groupe";
  } else if (entiteActive) {
    libelleDeclencheur = entiteActive.name; // ex. « Sucre »
  } else if (nbCoches === 1) {
    libelleDeclencheur = libelleCompte(
      comptes.find((c) => coches.has(c.bankAccountId))!,
    );
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

  // Groupement par TITULAIRE (D6/S1) dans la listbox « Par compte » : accordéon
  // CONTRÔLÉ React (pas de <details> natif ici — une checkbox contrôlée dans un
  // <summary> entrerait en conflit d'événements avec le toggle). La sélection
  // reste per-compte, les inputs postés (bankAccountId) sont INCHANGÉS, aucun
  // nouvel axe serveur. Recalculé sur la liste FILTRÉE (la recherche peut vider
  // un groupe → il disparaît). < 2 groupes → liste plate historique (repli).
  const groupesTitulaire = useMemo(
    () => grouperParTitulaire(comptesFiltres),
    [comptesFiltres],
  );

  // Volets ouverts (clé = holderId ?? "non-regroupe"). REPLIÉS par défaut (S1) ;
  // pendant une RECHERCHE active, tous les groupes s'affichent DÉPLIÉS (les
  // correspondances doivent être visibles sans clic) sans écraser cet état.
  const [groupesOuverts, setGroupesOuverts] = useState<Set<string>>(new Set());
  const rechercheActive = recherche.trim().length > 0;

  function basculerOuverture(cle: string) {
    // Pendant une recherche, l'ouverture est FORCÉE (`|| rechercheActive`) : un
    // clic chevron n'aurait AUCUN retour visuel mais muterait quand même le Set
    // → état d'ouverture inversé/corrompu une fois la recherche effacée
    // (constat cross-review). No-op tant que la recherche est active.
    if (rechercheActive) return;
    setGroupesOuverts((prev) => {
      const next = new Set(prev);
      if (next.has(cle)) next.delete(cle);
      else next.add(cle);
      return next;
    });
  }

  const entitesFiltrees = useMemo(() => {
    const q = recherche.trim().toLocaleLowerCase("fr");
    if (!q) return entites;
    return entites.filter((e) => e.name.toLocaleLowerCase("fr").includes(q));
  }, [entites, recherche]);

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

  // L'onglet « Par entité » n'a de sens que s'il existe au moins une entité visible.
  const aDesEntites = entites.length > 0;
  const ongletEffectif: Onglet = aDesEntites ? onglet : "compte";

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
        <div
          className="absolute right-0 z-20 mt-2 w-[300px] rounded-control bg-surface-card
            p-2 text-text shadow-popover"
          role="dialog"
          aria-label="Choisir le périmètre d'affichage"
        >
          {/* Barre d'onglets (uniquement si des entités existent). Onglet actif en
              `primary` (jamais vert/rouge). Changer d'onglet ne soumet rien et ne
              touche pas la sélection de l'autre onglet (modes séparés). */}
          {aDesEntites && (
            <div
              role="tablist"
              aria-label="Mode de filtrage"
              className="mb-2 flex gap-1 rounded-control bg-surface-inset p-1"
            >
              {(
                [
                  ["compte", "Par compte"],
                  ["entite", "Par entité"],
                ] as const
              ).map(([cle, libelle]) => {
                const actif = ongletEffectif === cle;
                return (
                  <button
                    key={cle}
                    type="button"
                    role="tab"
                    aria-selected={actif}
                    onClick={() => {
                      setOnglet(cle);
                      setRecherche(""); // recherche propre à chaque onglet (modes séparés)
                    }}
                    className={cn(
                      "flex-1 rounded-[6px] px-3 py-1.5 text-sm font-medium transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      actif
                        ? "bg-surface-card text-primary shadow-sm"
                        : "text-text-muted hover:text-text",
                    )}
                  >
                    {libelle}
                  </button>
                );
              })}
            </div>
          )}

          <input
            ref={inputRechercheRef}
            type="text"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder={
              ongletEffectif === "entite"
                ? "Rechercher une entité…"
                : "Rechercher un compte…"
            }
            aria-label={
              ongletEffectif === "entite"
                ? "Rechercher une entité"
                : "Rechercher un compte"
            }
            className="mb-2 w-full rounded-control border border-line bg-surface-inset
              px-3 py-2 text-sm text-text placeholder:text-text-faint focus:border-primary
              focus:outline-none focus:ring-2 focus:ring-primary"
          />

          {ongletEffectif === "compte" ? (
            /* ───────── Onglet « Par compte » (L8b-1) — INCHANGÉ ───────── */
            <form action={actionCompte} role="tabpanel" aria-label="Filtrer par compte">
              {/* Option « Groupe » épinglée = état PAR DÉFAUT / reset (décocher tout).
                  Encadré accent permanent (point de retour), ✓ quand actif. */}
              <button
                type="button"
                onClick={() => setCoches(new Set())}
                role="option"
                aria-selected={nbCoches === 0}
                className={cn(
                  "mb-1 flex w-full items-center justify-between rounded-control border px-2 py-1.5",
                  "text-left text-sm transition-colors focus:outline-none focus-visible:ring-2",
                  "focus-visible:ring-primary",
                  nbCoches === 0
                    ? "border-primary bg-primary-50 font-medium"
                    : "border-line/60 hover:bg-surface-inset",
                )}
              >
                <span>
                  Groupe
                  <span className="ml-1 text-xs text-text-muted">
                    · tous les comptes (vue par défaut)
                  </span>
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
                ) : groupesTitulaire.length < 2 ? (
                  /* Repli mono-groupe : liste plate historique, aucun en-tête. */
                  comptesFiltres.map((c) => optionCompte(c, coches, basculer))
                ) : (
                  /* Accordéon TITULAIRE (S1/S2) — en-tête de groupe = [checkbox
                     tri-état] [chevron + nom] [N comptes]. La case de groupe est
                     du CONFORT (règle 2) : basculerGroupe ne coche QUE des ids du
                     groupe (périmètre RLS) ; les inputs postés restent les
                     bankAccountId de `coches`, inchangés. Compteur only — jamais
                     de solde agrégé (règle 8). « Non regroupé » en dernier. */
                  groupesTitulaire.map((groupe) => {
                    const titre = groupe.holderName ?? "Non regroupé";
                    const cle = groupe.holderId ?? "non-regroupe";
                    // `voletOuvert` (PAS `ouvert` : ce nom est déjà pris par
                    // l'état du popover — shadowing piégeux relevé en revue).
                    const voletOuvert = rechercheActive || groupesOuverts.has(cle);
                    // SÉMANTIQUE ASSUMÉE (WYSIWYG, pattern « sélectionner les
                    // visibles ») : pendant une recherche, tri-état et bascule
                    // agissent sur les comptes FILTRÉS du groupe — jamais sur
                    // des comptes invisibles (pas de (dé)sélection surprise).
                    // Les cochés hors filtre ne sont PAS touchés.
                    const etat = etatSelectionGroupe(groupe.comptes, coches);
                    const nb = groupe.comptes.length;
                    return (
                      <div key={cle} role="group" aria-label={titre}>
                        <div className="flex items-center gap-2 px-2 py-1.5">
                          {/* Tri-état natif : indeterminate posé par ref (pas un
                              attribut HTML). Pas de `name` → jamais posté. */}
                          <input
                            type="checkbox"
                            checked={etat === "tous"}
                            ref={(el) => {
                              if (el) el.indeterminate = etat === "partiel";
                            }}
                            onChange={() =>
                              setCoches((prev) => basculerGroupe(prev, groupe.comptes))
                            }
                            aria-label={`Tout cocher — ${titre}`}
                            className="h-4 w-4 shrink-0 cursor-pointer accent-primary
                              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          />
                          <button
                            type="button"
                            onClick={() => basculerOuverture(cle)}
                            aria-expanded={voletOuvert}
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-control
                              text-left focus:outline-none focus-visible:ring-2
                              focus-visible:ring-primary"
                          >
                            <span
                              aria-hidden
                              className={cn(
                                "shrink-0 text-[10px] text-text-muted transition-transform",
                                voletOuvert && "rotate-90",
                              )}
                            >
                              ▸
                            </span>
                            <span
                              className="truncate text-[11px] font-semibold uppercase
                                tracking-[0.08em] text-text-muted"
                              title={titre}
                            >
                              {titre}
                            </span>
                          </button>
                          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-text-muted">
                            {nb} compte{nb > 1 ? "s" : ""}
                          </span>
                        </div>
                        {voletOuvert && (
                          <div className="pl-6">
                            {groupe.comptes.map((c) => optionCompte(c, coches, basculer))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Inputs cachés = la sélection POSTÉE. « Groupe » ⇒ aucun input ⇒ []. */}
              {[...coches].map((id) => (
                <input key={id} type="hidden" name="bankAccountId" value={id} />
              ))}

              <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
                {/* « Tout effacer » : reset explicite → « Groupe » (validé via Appliquer).
                    Visible seulement quand au moins un compte est coché. */}
                {nbCoches > 0 ? (
                  <button
                    type="button"
                    onClick={() => setCoches(new Set())}
                    className="rounded-control px-2 py-1 text-xs font-medium text-text-muted
                      transition-colors hover:text-text focus:outline-none focus-visible:ring-2
                      focus-visible:ring-primary"
                  >
                    Tout effacer
                  </button>
                ) : (
                  <span aria-hidden />
                )}
                <button
                  type="submit"
                  disabled={enCoursCompte}
                  className="inline-flex h-9 items-center justify-center rounded-control bg-primary
                    px-3 text-sm font-semibold text-text-onink transition-colors hover:bg-primary-600
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                    disabled:cursor-not-allowed disabled:opacity-48"
                >
                  {enCoursCompte ? "…" : "Appliquer"}
                </button>
              </div>
            </form>
          ) : (
            /* ───────── Onglet « Par entité » (L8b-2) — choix UNIQUE ───────── */
            <form
              action={
                /* Reset (« Groupe » sélectionné) ⇒ definirViewFilter avec [] (aucun
                   input entityId rendu). Une entité choisie ⇒ definirPerimetreEntite
                   (qui traduit côté serveur). Un seul <form>, action choisie selon la
                   sélection — pas de mixage : « Par compte » est rendu ailleurs. */
                entiteChoisie === null ? actionCompte : actionEntite
              }
              role="tabpanel"
              aria-label="Filtrer par entité"
            >
              {/* « Groupe » épinglée = état par défaut / reset. Comme l'onglet « Par
                  compte », on sélectionne ici (setState) puis on valide via Appliquer
                  (qui poste definirViewFilter avec [] tant qu'aucune entité n'est
                  choisie). Encadré accent permanent = point de retour. */}
              <button
                type="button"
                onClick={() => setEntiteChoisie(null)}
                role="option"
                aria-selected={entiteChoisie === null}
                className={cn(
                  "mb-1 flex w-full items-center justify-between rounded-control border px-2 py-1.5",
                  "text-left text-sm transition-colors focus:outline-none focus-visible:ring-2",
                  "focus-visible:ring-primary",
                  entiteChoisie === null
                    ? "border-primary bg-primary-50 font-medium"
                    : "border-line/60 hover:bg-surface-inset",
                )}
              >
                <span>
                  Groupe
                  <span className="ml-1 text-xs text-text-muted">
                    · toutes les entités (vue par défaut)
                  </span>
                </span>
                {entiteChoisie === null && (
                  <span aria-hidden className="text-xs font-semibold text-primary">✓</span>
                )}
              </button>

              <div
                role="listbox"
                aria-label="Entités"
                className="max-h-64 overflow-y-auto border-t border-line pt-1"
              >
                {entitesFiltrees.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-text-muted">
                    Aucune entité ne correspond.
                  </p>
                ) : (
                  entitesFiltrees.map((e) => {
                    const actif = entiteChoisie === e.entityId;
                    return (
                      <button
                        key={e.entityId}
                        type="button"
                        role="option"
                        aria-selected={actif}
                        onClick={() => setEntiteChoisie(e.entityId)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left",
                          "text-sm transition-colors focus:outline-none focus-visible:ring-2",
                          "focus-visible:ring-primary",
                          actif ? "bg-primary-50" : "hover:bg-surface-inset",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
                            actif
                              ? "border-primary bg-primary text-text-onink"
                              : "border-line",
                          )}
                        >
                          {actif ? "✓" : ""}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-text">{e.name}</span>
                        <span className="shrink-0 text-xs text-text-muted">
                          {e.nbComptes} compte{e.nbComptes > 1 ? "s" : ""}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              {/* L'entité choisie POSTÉE (un seul champ). Absent si « Groupe » (le reset
                  passe par formAction=definirViewFilter sur le bouton « Groupe »). */}
              {entiteChoisie !== null && (
                <input type="hidden" name="entityId" value={entiteChoisie} />
              )}

              <div className="mt-2 flex items-center justify-end gap-2 border-t border-line pt-2">
                {/* Appliquer : poste l'action du form (definirViewFilter [] si « Groupe »,
                    definirPerimetreEntite sinon). Non désactivé sur « Groupe » (le reset
                    est une action valide). `enCours` selon l'action réellement soumise. */}
                <button
                  type="submit"
                  disabled={entiteChoisie === null ? enCoursCompte : enCoursEntite}
                  className="inline-flex h-9 items-center justify-center rounded-control bg-primary
                    px-3 text-sm font-semibold text-text-onink transition-colors hover:bg-primary-600
                    focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                    disabled:cursor-not-allowed disabled:opacity-48"
                >
                  {(entiteChoisie === null ? enCoursCompte : enCoursEntite)
                    ? "…"
                    : "Appliquer"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
