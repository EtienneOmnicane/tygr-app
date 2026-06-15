/**
 * Briques présentationnelles partagées par les états du dashboard
 * (loading / vide / erreur). Tout est INERTE : aucun fetch, aucun état,
 * aucune Server Action. Couleurs exclusivement via les tokens TYGR câblés
 * dans `globals.css` (transposition du §0 de docs/UI_GUIDELINES.md).
 *
 * Pas de dépendance externe (clsx/cva/lucide non installés — règle 9) : on
 * fournit un micro-helper `cn` local et des SVG outline inline.
 */
import type { ReactNode, SVGProps } from "react";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Bloc squelette animé (animate-pulse natif Tailwind). `surface-inset` pour
 * le remplissage neutre — jamais une couleur sémantique (le chargement n'est
 * pas de la donnée). Hauteur/largeur pilotées par le parent via className.
 */
export function SkeletonBlock({
  className,
  rounded = "control",
}: {
  className?: string;
  rounded?: "control" | "card" | "pill" | "none";
}) {
  const radius =
    rounded === "card"
      ? "rounded-card"
      : rounded === "pill"
        ? "rounded-full"
        : rounded === "none"
          ? ""
          : "rounded-control";
  return (
    <div
      aria-hidden
      className={cn("animate-pulse bg-surface-inset", radius, className)}
    />
  );
}

/**
 * Carte de contenu standard (UI_GUIDELINES §1.1/§2.2) : fond blanc, rayon
 * `card`, ombre `card`, padding 24px. Toutes les cartes d'état la réutilisent
 * pour rester homogènes avec les vraies cartes du dashboard.
 */
export function StateCard({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-card bg-surface-card p-6 shadow-card",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * Illustration outline légère (style nuage FYGR, §4.4) aux couleurs TYGR.
 * Variante `empty` (document vide) ou `error` (nuage barré). `currentColor`
 * pour hériter de la teinte du conteneur (text-faint pour vide, danger pour
 * erreur) — aucune couleur en dur.
 */
export function StateIllustration({
  variant,
  className,
  ...rest
}: {
  variant: "empty" | "error";
} & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-hidden
      className={className}
      {...rest}
    >
      {variant === "empty" ? (
        <>
          {/* Document vide avec coin replié + lignes fantômes */}
          <path d="M30 18h26l12 12v48a2 2 0 0 1-2 2H30a2 2 0 0 1-2-2V20a2 2 0 0 1 2-2Z" />
          <path d="M56 18v12h12" />
          <path d="M38 46h20M38 56h20M38 66h12" strokeDasharray="3 4" />
        </>
      ) : (
        <>
          {/* Nuage de synchro interrompue + croix */}
          <path d="M34 64a14 14 0 0 1-2-27.86A18 18 0 0 1 66 38a12 12 0 0 1-2 25.9" />
          <path d="M40 50l16 16M56 50 40 66" />
        </>
      )}
    </svg>
  );
}
