/**
 * CALLOUT — surface d'alerte inline TRANSVERSE (UI_GUIDELINES §3.4).
 *
 * §3.4 impose TROIS signaux pour qu'une erreur système ne se confonde jamais avec un
 * montant sortant : **fond teinté + icône + message**. Un simple texte rouge est
 * interdit — le rouge nu appartient à la donnée (`outflow`).
 *
 * ⚠️ CONTRASTE (mesuré, pas jugé à l'œil — WCAG 2.1) : le motif « `text-danger` sur
 * `bg-danger-bg` », déjà répandu dans le projet, plafonne à **4,40:1** et ÉCHOUE donc
 * l'AA en corps de texte (seuil 4,5). D'où la répartition ci-dessous :
 *
 *   - le MESSAGE porte `text-text`  → 11,46:1 sur `danger-bg`, 11,59:1 sur `warning-bg` ;
 *   - l'ICÔNE porte la couleur de sévérité → elle véhicule le signal, pas la lisibilité.
 *
 * §3.4 exige que le message EXISTE, jamais qu'il soit coloré : la contrainte
 * d'accessibilité et la règle sémantique sont donc satisfaites en même temps.
 * (`warning` sur `warning-bg` passe de justesse à 4,56:1 — on ne s'en sert pas non plus
 * pour du corps de texte, par cohérence de la primitive.)
 *
 * Facture APP UI (pas « mosaïque de cartes ») : `rounded-control`, aucune ombre, aucune
 * bordure gauche colorée (motif générique), hauteur compacte. Un callout est une LIGNE
 * d'information, pas une carte.
 *
 * Présentationnel PUR : aucun fetch, aucun état, aucune Server Action. L'action
 * éventuelle est fournie par l'appelant via `action` (lien ou bouton déjà stylé).
 */
import type { ReactNode } from "react";

import { cn } from "./primitives";

/** Sévérités disponibles. `success` n'existe PAS : un succès n'est pas une alerte. */
export type SeveriteCallout = "danger" | "warning";

const STYLES: Record<SeveriteCallout, { fond: string; icone: string }> = {
  danger: { fond: "bg-danger-bg", icone: "text-danger" },
  warning: { fond: "bg-warning-bg", icone: "text-warning" },
};

export function Callout({
  severite,
  children,
  action,
  role,
  className,
}: {
  severite: SeveriteCallout;
  /** Message. Reste en `text-text` (contraste AA) — cf. docstring. */
  children: ReactNode;
  /**
   * Action explicite attachée au callout (lien ou bouton). Rendue à droite sur écran
   * large, sous le message en dessous de `sm` : un callout sans action est du bruit.
   */
  action?: ReactNode;
  /**
   * `alert` pour une erreur (annonce immédiate), `status` pour une information
   * actionnable. Laissé à l'appelant : lui seul sait si l'état mérite l'interruption.
   */
  role?: "alert" | "status";
  className?: string;
}) {
  const style = STYLES[severite];

  return (
    <div
      role={role}
      className={cn(
        "flex flex-col gap-2 rounded-control px-3 py-2.5",
        "sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        style.fond,
        className,
      )}
    >
      <p className="flex items-start gap-2 text-sm text-text">
        <IconeAlerte className={cn("mt-0.5 h-4 w-4 shrink-0", style.icone)} />
        <span>{children}</span>
      </p>
      {action && <span className="shrink-0 sm:self-center">{action}</span>}
    </div>
  );
}

/**
 * Icône « triangle d'alerte » (⚠). SVG inline pur (règle 9 — ni lucide ni clsx au
 * projet). Décorative : le message porte le sens accessible, et `role` porte l'urgence.
 */
function IconeAlerte({ className }: { className?: string }) {
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
    >
      <path d="M8 1.8 1.4 13.4a1 1 0 0 0 .87 1.5h11.46a1 1 0 0 0 .87-1.5L8 1.8Z" />
      <path d="M8 6.2v3.4" />
      <path d="M8 12.1h.01" />
    </svg>
  );
}
