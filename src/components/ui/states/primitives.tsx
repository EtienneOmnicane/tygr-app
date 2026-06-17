/**
 * Briques présentationnelles d'état, TRANSVERSES (promues depuis
 * `components/dashboard/states/primitives.tsx`). Réutilisables par tout domaine
 * (dashboard, sections graphiques/échéances/transactions, …). Tout est INERTE :
 * aucun fetch, aucun état, aucune Server Action. Couleurs exclusivement via les
 * tokens TYGR câblés dans `globals.css` (transposition du §0 de
 * docs/UI_GUIDELINES.md).
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
 * pour rester homogènes avec les vraies cartes de l'application.
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

/** Variantes d'illustration outline disponibles. */
export type StateIllustrationVariant =
  | "empty"
  | "error"
  | "chart"
  | "calendar"
  | "table";

/**
 * Illustration outline légère (style nuage FYGR, §4.4) aux couleurs TYGR.
 * `currentColor` pour hériter de la teinte du conteneur (text-faint pour les
 * vides neutres, danger pour l'erreur) — aucune couleur en dur. Toutes les
 * variantes partagent le même gabarit (viewBox 96×96, stroke 2px outline)
 * pour une facture homogène entre sections.
 *
 * Variantes par section (Empty States différenciés — décision design D1) :
 *   - `chart`    : courbe de trésorerie (section Graphiques)
 *   - `calendar` : échéancier (section Échéances)
 *   - `table`    : lignes d'opérations (section Transactions)
 */
export function StateIllustration({
  variant,
  className,
  ...rest
}: {
  variant: StateIllustrationVariant;
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
      {variant === "empty" && (
        <>
          {/* Document vide avec coin replié + lignes fantômes */}
          <path d="M30 18h26l12 12v48a2 2 0 0 1-2 2H30a2 2 0 0 1-2-2V20a2 2 0 0 1 2-2Z" />
          <path d="M56 18v12h12" />
          <path d="M38 46h20M38 56h20M38 66h12" strokeDasharray="3 4" />
        </>
      )}

      {variant === "error" && (
        <>
          {/* Nuage de synchro interrompue + croix */}
          <path d="M34 64a14 14 0 0 1-2-27.86A18 18 0 0 1 66 38a12 12 0 0 1-2 25.9" />
          <path d="M40 50l16 16M56 50 40 66" />
        </>
      )}

      {variant === "chart" && (
        <>
          {/* Axes + courbe ascendante avec points (section Graphiques) */}
          <path d="M26 22v44a2 2 0 0 0 2 2h44" />
          <path d="M34 60l12-14 10 8 16-22" />
          <circle cx="34" cy="60" r="2.5" fill="currentColor" stroke="none" />
          <circle cx="46" cy="46" r="2.5" fill="currentColor" stroke="none" />
          <circle cx="56" cy="54" r="2.5" fill="currentColor" stroke="none" />
          <circle cx="72" cy="32" r="2.5" fill="currentColor" stroke="none" />
        </>
      )}

      {variant === "calendar" && (
        <>
          {/* Grille de calendrier + anneaux + jour marqué (section Échéances) */}
          <rect x="24" y="28" width="48" height="44" rx="4" />
          <path d="M24 40h48" />
          <path d="M36 22v10M60 22v10" />
          <path d="M36 50h6M54 50h6M36 60h6M54 60h6" />
        </>
      )}

      {variant === "table" && (
        <>
          {/* En-tête + lignes/colonnes d'opérations (section Transactions) */}
          <rect x="22" y="26" width="52" height="44" rx="4" />
          <path d="M22 40h52" />
          <path d="M48 40v30" />
          <path d="M30 52h10M56 52h10M30 62h10M56 62h10" strokeDasharray="3 4" />
        </>
      )}
    </svg>
  );
}
