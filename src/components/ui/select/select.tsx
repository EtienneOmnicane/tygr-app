"use client";

/**
 * Select — remplaçant maison du `<select>` natif (UI_GUIDELINES §4.4 « dropdown »).
 *
 * POURQUOI : la liste ouverte d'un `<select>` natif est dessinée par l'OS — donc
 * NON stylable (pas de tokens, pas de `shadow-popover`) et, quand elle est longue
 * (filtre « compte » de /transactions : ~12 banques × N comptes), son défilement
 * est erratique. Ce composant rend une liste `role="listbox"` bornée en hauteur
 * (`MENU_MAX_PX`, appliquée en `maxHeight` calculé — cf. `position-menu.ts` ; l'ancienne
 * classe `max-h-72` a disparu avec le passage en `fixed`) : esthétique cohérente ET
 * scroll maîtrisé.
 *
 * CONTRÔLÉ (miroir du natif) : `value` + `onChange(value)`. Options à plat
 * (`options`) OU groupées (`groups` — ex. comptes par institution : un `label` de
 * groupe vide ne rend PAS d'en-tête). Présentationnel : aucun fetch, aucun état
 * métier ; le conteneur décide de la donnée.
 *
 * A11Y / clavier (parité natif) : trigger `role="combobox"` +
 * `aria-activedescendant` (le focus DOM reste sur le trigger). Entrée/Espace/Flèche
 * ouvre ; ↑/↓ déplacent le surlignage (sautent les `disabled`) ; Entrée/Espace
 * valide ; Home/End ; typeahead ; Échap ferme ; clic-extérieur ferme. L'Échap est
 * capturé et `stopImmediatePropagation` pour NE PAS fermer une modale parente
 * (repris du pattern CategoryPicker). Zéro dépendance externe (règle 9) : `cn`
 * local + SVG inline.
 *
 * MENU PORTALÉ EN `fixed` (TX-STATUT-SELECT-LAYOUT1) : le menu n'est PAS rendu dans le
 * conteneur du trigger — il est portalé dans `document.body` et positionné en `fixed` sur
 * le rect du trigger (`position-menu.ts`). En `absolute`, il grossissait le premier ancêtre
 * scrollable : le groupe de filtres de /transactions est `overflow-x-auto`, or CSS force
 * alors `overflow-y` à `auto` → le menu (288px) débordait de la rangée (40px), la toolbar
 * devenait scrollable → scrollbar parasite + saut de layout. Le même ancêtre clippant existe
 * ailleurs (tableau d'assignation, liste des suggestions en modale). Un `fixed` portalé
 * échappe à TOUT ancêtre clippant/scrollable ET, étant hors flux, ne peut créer aucune
 * scrollbar de document : la cause disparaît au lieu d'être contournée écran par écran.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  calculerPositionMenu,
  memePosition,
  type PositionMenu,
} from "./position-menu";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export interface OptionSelect {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface GroupeSelect {
  /** En-tête de groupe. Vide (`""`) = groupe sans en-tête (options « à plat »). */
  label: string;
  options: OptionSelect[];
}

export function Select({
  value,
  onChange,
  options,
  groups,
  placeholder,
  disabled = false,
  size = "md",
  id,
  ariaLabel,
  libelleVide = "Aucune option.",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Liste plate d'options… */
  options?: OptionSelect[];
  /** …OU liste groupée (ex. comptes par institution). L'un des deux. */
  groups?: GroupeSelect[];
  /** Libellé du trigger si `value` ne correspond à aucune option. */
  placeholder?: string;
  disabled?: boolean;
  /** `md` = h-10/text-sm (défaut) ; `sm` = h-8/text-xs. */
  size?: "sm" | "md";
  /** Associe un `<label htmlFor>` visible (posé sur le trigger). */
  id?: string;
  /** Nom accessible quand il n'y a pas de `<label>` visible. */
  ariaLabel?: string;
  /** Message quand la liste est vide. Défaut FR (cf. `libelleFermer` du Modal, Q-LANG §9). */
  libelleVide?: string;
  /** Classes de layout additionnelles sur le trigger (largeur…). */
  className?: string;
}) {
  const reactId = useId();
  const baseId = id ?? reactId;
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const conteneurRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listeRef = useRef<HTMLDivElement>(null);
  const tamponRef = useRef<{ texte: string; t: number }>({ texte: "", t: 0 });

  const [ouvert, setOuvert] = useState(false);
  const [indexActif, setIndexActif] = useState(-1);
  // Position VIEWPORT du menu portalé. `null` = pas encore mesurée (menu non rendu).
  const [position, setPosition] = useState<PositionMenu | null>(null);

  const mesurer = useCallback((): PositionMenu | null => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const r = trigger.getBoundingClientRect();
    return calculerPositionMenu(
      { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
      { largeur: window.innerWidth, hauteur: window.innerHeight },
    );
  }, []);

  // Normalisation : `options` plates → un seul groupe sans en-tête. `optionsPlates`
  // suit l'ordre visuel (indices = data-index / aria-activedescendant).
  const groupesNorm = useMemo<GroupeSelect[]>(
    () => groups ?? [{ label: "", options: options ?? [] }],
    [groups, options],
  );
  const optionsPlates = useMemo(
    () => groupesNorm.flatMap((g) => g.options),
    [groupesNorm],
  );

  const optionSelectionnee = optionsPlates.find((o) => o.value === value);
  const libelleAffiche = optionSelectionnee?.label ?? placeholder ?? "";
  const affichePlaceholder = optionSelectionnee === undefined;

  function premierActif(): number {
    return optionsPlates.findIndex((o) => !o.disabled);
  }
  function dernierActif(): number {
    for (let i = optionsPlates.length - 1; i >= 0; i -= 1) {
      if (!optionsPlates[i].disabled) return i;
    }
    return -1;
  }
  function actifSuivant(depart: number, sens: 1 | -1): number {
    const n = optionsPlates.length;
    if (n === 0) return -1;
    let i = depart;
    for (let k = 0; k < n; k += 1) {
      i = (i + sens + n) % n;
      if (!optionsPlates[i].disabled) return i;
    }
    return depart;
  }

  /**
   * PORTE UNIQUE d'ouverture — tout chemin (clic, flèche, typeahead) passe par ici. Le menu
   * portalé ne se rend QUE si sa position est connue (`ouvert && position`) : un
   * `setOuvert(true)` isolé ne l'afficherait PAS. La mesure est faite ICI, synchroniquement,
   * avant le premier rendu du menu (en effet post-commit, il apparaîtrait une frame en (0,0)
   * puis sauterait). `indexInitial` sert au typeahead, qui ouvre sur l'option trouvée.
   */
  function ouvrir(indexInitial?: number) {
    if (disabled) return;
    setPosition(mesurer());
    setOuvert(true);
    if (indexInitial !== undefined) {
      setIndexActif(indexInitial);
      return;
    }
    const idxSel = optionsPlates.findIndex((o) => o.value === value && !o.disabled);
    setIndexActif(idxSel >= 0 ? idxSel : premierActif());
  }
  function fermer(refocus = true) {
    setOuvert(false);
    setIndexActif(-1);
    if (refocus) triggerRef.current?.focus();
  }
  function choisir(idx: number) {
    const opt = optionsPlates[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    fermer();
  }

  /**
   * Typeahead : accumule les frappes rapprochées (<600 ms) en un préfixe de recherche.
   * L'instant vient de l'ÉVÉNEMENT (`e.timeStamp`, monotone) et non de `Date.now()` : un
   * appel impur en portée de rendu est refusé par le React Compiler (`react-hooks/purity`),
   * et l'horodatage de la frappe est de toute façon la bonne source (celui de la SAISIE, pas
   * celui du traitement).
   */
  function rechercheTypeahead(char: string, maintenant: number): number {
    const t = tamponRef.current;
    t.texte = maintenant - t.t < 600 ? t.texte + char : char;
    t.t = maintenant;
    const q = t.texte.toLocaleLowerCase("fr");
    return optionsPlates.findIndex(
      (o) => !o.disabled && o.label.toLocaleLowerCase("fr").startsWith(q),
    );
  }

  // Fermeture : clic-extérieur (mousedown) + Échap (capture, sans fermer une
  // modale parente). Actif uniquement quand ouvert.
  //
  // ⚠️ « Dans le Select » = conteneur du trigger OU menu portalé. Ces deux sous-arbres sont
  // DISJOINTS dans le DOM (le menu vit sous `document.body`), et ces écouteurs sont NATIFS :
  // ils voient la position RÉELLE de la cible, pas l'arbre React. Ne tester que le conteneur
  // (comme avant le portal) casserait tout : (a) le `mousedown` sur une option passerait pour
  // un clic EXTÉRIEUR → le menu se démonterait entre `mousedown` et `mouseup` → aucun `click`
  // ne serait émis → SÉLECTION IMPOSSIBLE ; (b) l'Échap frappé depuis le menu ne serait pas
  // `stopImmediatePropagation`é → il fermerait la MODALE parente (propositions, §admin).
  useEffect(() => {
    if (!ouvert) return;

    function dansLeSelect(cible: Node | null): boolean {
      if (!cible) return false;
      return (
        conteneurRef.current?.contains(cible) === true ||
        listeRef.current?.contains(cible) === true
      );
    }

    function onPointerDown(e: MouseEvent) {
      if (!dansLeSelect(e.target as Node)) {
        setOuvert(false);
        setIndexActif(-1);
      }
    }
    function onKeyDownCapture(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (!dansLeSelect(e.target as Node | null)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      fermer();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDownCapture, true);
    };
  }, [ouvert]);

  // Le menu est ancré au VIEWPORT (`fixed`) : tout ce qui déplace le trigger à l'écran doit
  // le repositionner tant qu'il est ouvert. `capture: true` est OBLIGATOIRE — un `scroll` ne
  // BULLE pas : sans capture, on manquerait le défilement des ancêtres scrollables (groupe de
  // filtres `overflow-x-auto`, corps d'une modale) et le menu resterait « collé » à l'écran
  // pendant que son trigger glisse.
  //
  // Coalescé par `requestAnimationFrame` : une rafale de `scroll` ne doit provoquer qu'UNE
  // mesure par frame (`getBoundingClientRect` force un recalcul de layout). Et on bail si la
  // position est inchangée — scroller la liste INTERNE du menu ne déplace pas le trigger.
  useEffect(() => {
    if (!ouvert) return;
    let frame = 0;

    function repositionner() {
      // La MESURE (lecture DOM) vit hors de l'updater : un updater de state doit être PUR
      // (React le double-invoque en StrictMode). L'updater ne fait plus que comparer.
      const suivante = mesurer();
      setPosition((precedente) =>
        suivante && memePosition(precedente, suivante) ? precedente : suivante,
      );
    }
    function planifier() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        repositionner();
      });
    }

    window.addEventListener("scroll", planifier, true);
    window.addEventListener("resize", planifier);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", planifier, true);
      window.removeEventListener("resize", planifier);
    };
  }, [ouvert, mesurer]);

  // Le `fixed` échappe aux ancêtres clippants — c'est le but, mais c'est à double tranchant :
  // quand le TRIGGER, lui, disparaît (scrollé hors de l'écran, ou clippé par la liste
  // `overflow-y-auto` d'une modale), le menu continuerait de flotter, ORPHELIN, sur une ancre
  // invisible. On ferme dès que le trigger n'est plus visible du tout.
  //
  // `IntersectionObserver` (racine = viewport) est le bon outil : son rectangle d'intersection
  // tient compte des rectangles de CLIP de tous les ancêtres — il détecte donc le trigger
  // masqué par un conteneur scrollable, ce qu'un simple test du rect ne verrait pas (le rect
  // reste « dans le viewport » même quand un ancêtre le clippe). Sans refocus : l'utilisateur
  // a délibérément défilé ailleurs, et le focus n'a de toute façon jamais quitté le trigger.
  useEffect(() => {
    if (!ouvert) return;
    const trigger = triggerRef.current;
    if (!trigger || typeof IntersectionObserver === "undefined") return;

    const observateur = new IntersectionObserver(
      ([entree]) => {
        if (!entree.isIntersecting) fermer(false);
      },
      { threshold: 0 },
    );
    observateur.observe(trigger);
    return () => observateur.disconnect();
  }, [ouvert]);

  // Option active toujours visible dans la liste scrollable.
  useEffect(() => {
    if (!ouvert || indexActif < 0) return;
    const el = listeRef.current?.querySelector<HTMLElement>(
      `[data-index="${indexActif}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [ouvert, indexActif]);

  function estImprimable(e: React.KeyboardEvent): boolean {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!ouvert) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        ouvrir();
      } else if (estImprimable(e)) {
        e.preventDefault();
        const idx = rechercheTypeahead(e.key, e.timeStamp);
        ouvrir(idx >= 0 ? idx : premierActif());
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setIndexActif((i) => (i < 0 ? premierActif() : actifSuivant(i, 1)));
        break;
      case "ArrowUp":
        e.preventDefault();
        setIndexActif((i) => (i < 0 ? dernierActif() : actifSuivant(i, -1)));
        break;
      case "Home":
        e.preventDefault();
        setIndexActif(premierActif());
        break;
      case "End":
        e.preventDefault();
        setIndexActif(dernierActif());
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (indexActif >= 0) choisir(indexActif);
        break;
      case "Tab":
        setOuvert(false);
        setIndexActif(-1);
        break;
      default:
        if (estImprimable(e)) {
          e.preventDefault();
          const idx = rechercheTypeahead(e.key, e.timeStamp);
          if (idx >= 0) setIndexActif(idx);
        }
    }
  }

  const tailleTrigger = size === "sm" ? "h-8 px-2 text-xs" : "h-10 px-3 text-sm";

  // Compteur d'index partagé entre groupes (aligne data-index sur optionsPlates).
  let compteur = -1;

  const menu = ouvert && position && (
    <div
      ref={listeRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      // Géométrie CALCULÉE (position-menu.ts), pas des classes : en `fixed`, un `%`
      // (l'ancien `min-w-full`) référerait le viewport et non plus le trigger, et la
      // hauteur doit se borner à l'espace réel pour ne jamais déborder de l'écran.
      // `z-[60]` : au-dessus de l'overlay de la Modal (`z-50`) — le Select vit DANS des
      // modales (sas des suggestions). Deux portals frères en `z-50` se départageraient à
      // l'ordre du DOM : le menu passerait DERRIÈRE l'overlay au moindre remaniement.
      style={{
        left: position.left,
        top: position.top ?? undefined,
        bottom: position.bottom ?? undefined,
        minWidth: position.minWidth,
        maxWidth: position.maxWidth,
        maxHeight: position.maxHeight,
      }}
      className="fixed z-[60] w-max overflow-y-auto rounded-control border border-line
        bg-surface-card p-1 shadow-popover"
    >
      {optionsPlates.length === 0 ? (
        <p className="px-2 py-4 text-center text-sm text-text-muted">{libelleVide}</p>
      ) : (
        groupesNorm.map((groupe, gi) => (
          <div
            key={groupe.label || `g-${gi}`}
            role="group"
            aria-label={groupe.label || undefined}
          >
            {groupe.label && (
              <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                {groupe.label}
              </div>
            )}
            {groupe.options.map((opt) => {
              compteur += 1;
              const idx = compteur;
              const selectionne = opt.value === value;
              const actif = idx === indexActif;
              return (
                <button
                  key={opt.value || `opt-${idx}`}
                  type="button"
                  role="option"
                  id={optionId(idx)}
                  data-index={idx}
                  aria-selected={selectionne}
                  aria-disabled={opt.disabled || undefined}
                  disabled={opt.disabled}
                  onClick={() => choisir(idx)}
                  onMouseEnter={() => {
                    if (!opt.disabled) setIndexActif(idx);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-sm text-text transition-colors",
                    opt.disabled
                      ? "cursor-not-allowed opacity-[0.48]"
                      : "cursor-pointer",
                    selectionne && "bg-primary-50 font-medium",
                    !selectionne && actif && "bg-surface-inset",
                    !selectionne && !actif && "hover:bg-surface-inset",
                  )}
                >
                  <span className="min-w-0 truncate">{opt.label}</span>
                  {selectionne && (
                    <span
                      aria-hidden
                      className="shrink-0 text-xs font-semibold text-primary"
                    >
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))
      )}
    </div>
  );

  return (
    <div ref={conteneurRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        id={baseId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={ouvert}
        aria-controls={ouvert ? listboxId : undefined}
        aria-activedescendant={
          ouvert && indexActif >= 0 ? optionId(indexActif) : undefined
        }
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (ouvert ? fermer() : ouvrir())}
        onKeyDown={onKeyDown}
        className={cn(
          "inline-flex items-center justify-between gap-2 rounded-control border bg-surface-card text-text transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          "disabled:cursor-not-allowed disabled:opacity-[0.48]",
          tailleTrigger,
          ouvert ? "border-primary" : "border-line",
          !disabled && "cursor-pointer",
          className,
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate text-left",
            affichePlaceholder && "text-text-faint",
          )}
        >
          {libelleAffiche}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={cn(
            "h-4 w-4 shrink-0 text-text-muted transition-transform",
            ouvert && "rotate-180",
          )}
        >
          <path
            d="M6 8l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Le menu quitte l'arbre DOM du trigger (mais RESTE son descendant dans l'arbre
          REACT : les handlers, le contexte et la propagation synthétique sont intacts —
          d'où, entre autres, la modale qui ne se ferme pas au clic sur une option, son
          `onMouseDown` d'overlay ne fermant que si `target === currentTarget`).
          Garde SSR identique à `modal.tsx` : `document` n'existe pas au rendu serveur. */}
      {menu && typeof document !== "undefined" && createPortal(menu, document.body)}
    </div>
  );
}
