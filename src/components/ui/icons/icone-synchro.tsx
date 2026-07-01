/**
 * Icône « flèches circulaires » (↻) de synchronisation. SVG inline pur (zéro
 * dépendance — règle 9, pas de lucide). Décorative (`aria-hidden`) : le libellé
 * du bouton porte le sens accessible.
 *
 * Promue depuis `bank-connect-widget.tsx` (où elle était privée) pour être
 * partagée par le widget /banques ET le bouton « Synchroniser » du dashboard
 * (`sync-button.tsx`) — source unique, aucun doublon de markup (L8a).
 *
 * `className` pilote la taille/teinte depuis le parent (`currentColor` via
 * `stroke`). Pour l'état « en cours », le parent ajoute `motion-safe:animate-spin`.
 */
import type { SVGProps } from "react";

export function IconeSynchro({
  className = "h-4 w-4",
  ...rest
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9M2.5 8a5.5 5.5 0 0 1 9.4-3.9" />
      <path d="M12.2 1.8v2.6h-2.6M3.8 14.2v-2.6h2.6" />
    </svg>
  );
}
