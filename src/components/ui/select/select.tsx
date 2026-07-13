"use client";

/**
 * Select — remplaçant maison du `<select>` natif (UI_GUIDELINES §4.4 « dropdown »).
 *
 * POURQUOI : la liste ouverte d'un `<select>` natif est dessinée par l'OS — donc
 * NON stylable (pas de tokens, pas de `shadow-popover`) et, quand elle est longue
 * (filtre « compte » de /transactions : ~12 banques × N comptes), son défilement
 * est erratique. Ce composant rend une liste `role="listbox"` bornée en hauteur
 * (`max-h-72 overflow-y-auto`) : esthétique cohérente ET scroll maîtrisé.
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
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

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

  function ouvrir() {
    if (disabled) return;
    setOuvert(true);
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

  function rechercheTypeahead(char: string): number {
    const maintenant = Date.now();
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
  useEffect(() => {
    if (!ouvert) return;
    const conteneur = conteneurRef.current;

    function onPointerDown(e: MouseEvent) {
      if (conteneur && !conteneur.contains(e.target as Node)) {
        setOuvert(false);
        setIndexActif(-1);
      }
    }
    function onKeyDownCapture(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const cible = e.target as Node | null;
      if (conteneur && cible && conteneur.contains(cible)) {
        e.stopImmediatePropagation();
        e.preventDefault();
        fermer();
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDownCapture, true);
    };
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
        setOuvert(true);
        const idx = rechercheTypeahead(e.key);
        setIndexActif(idx >= 0 ? idx : premierActif());
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
          const idx = rechercheTypeahead(e.key);
          if (idx >= 0) setIndexActif(idx);
        }
    }
  }

  const tailleTrigger = size === "sm" ? "h-8 px-2 text-xs" : "h-10 px-3 text-sm";

  // Compteur d'index partagé entre groupes (aligne data-index sur optionsPlates).
  let compteur = -1;

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

      {ouvert && (
        <div
          ref={listeRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 top-full z-50 mt-1 max-h-72 min-w-full w-max
            max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-control
            border border-line bg-surface-card p-1 shadow-popover"
        >
          {optionsPlates.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-text-muted">
              {libelleVide}
            </p>
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
      )}
    </div>
  );
}
