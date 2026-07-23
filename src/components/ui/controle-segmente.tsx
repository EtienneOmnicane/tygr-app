"use client";

/**
 * Contrôle segmenté générique (radiogroup) — SOURCE UNIQUE du motif « pilule de
 * segments » (§2 / periode-switcher). Segment actif = `bg-primary text-text-onink`.
 * Désactivé en bloc pendant un re-fetch.
 *
 * PROMU depuis `graphiques-feature.tsx` (privé au fichier) : la périodicité (L2) et le
 * toggle graphique/tableau (L1) le réutilisent. Le laisser privé aurait créé une
 * SECONDE implémentation du même contrôle (radiogroup + focus ring + états désactivés)
 * — exactement la dette « source unique » que le projet combat (PLAN-graphs-fygr §5.2).
 *
 * A11y : `role="radiogroup"` + `role="radio"`/`aria-checked` ; focus ring `primary`
 * visible ; segments désactivables en bloc. Zéro dépendance externe (règle 9) : `cn`
 * local + SVG/JSX inline. Une icône OPTIONNELLE précède le libellé — mais JAMAIS
 * d'icône seule (le libellé texte reste toujours rendu, lisibilité + a11y).
 */
import type { ReactNode } from "react";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export interface OptionSegment<T extends string> {
  valeur: T;
  label: string;
  /** Glyphe OPTIONNEL rendu avant le libellé (jamais à sa place — pas d'icône seule). */
  icone?: ReactNode;
}

export function ControleSegmente<T extends string>({
  label,
  options,
  valeur,
  onChange,
  disabled,
  size = "md",
}: {
  /** Nom accessible du groupe (aria-label du radiogroup). */
  label: string;
  options: Array<OptionSegment<T>>;
  valeur: T;
  onChange: (valeur: T) => void;
  disabled?: boolean;
  /** `md` = px-3 py-1.5 text-sm (défaut) ; `sm` = px-2.5 py-1 text-xs. */
  size?: "sm" | "md";
}) {
  const tailleSegment =
    size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex w-fit rounded-full border border-line bg-surface-card p-0.5"
    >
      {options.map((o) => {
        const actif = o.valeur === valeur;
        return (
          <button
            key={o.valeur}
            type="button"
            role="radio"
            aria-checked={actif}
            disabled={disabled}
            onClick={() => onChange(o.valeur)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full font-medium transition-colors",
              tailleSegment,
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              "disabled:cursor-not-allowed disabled:opacity-60",
              actif ? "bg-primary text-text-onink" : "text-text-muted hover:text-text",
            )}
          >
            {o.icone && (
              <span aria-hidden className="inline-flex shrink-0">
                {o.icone}
              </span>
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
