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
 * `success` suit EXACTEMENT la même répartition (A11Y-VERT-SUCCES1) : `text-success`
 * (#1d9e55) plafonne à 3,46:1 et échoue l'AA en texte, donc le message de succès est
 * lui aussi en `text-text` et le vert ne subsiste qu'en FOND + ICÔNE. La sévérité
 * change alors deux choses seulement : l'icône (coche, pas triangle d'alerte) et le
 * fait qu'un succès est FERMABLE (cf. `onFermer`) — un résultat est éphémère, une
 * alerte non.
 *
 * ⚠️ ÉCART CONNU, mesuré au DOM (Gate 4, 2026-07-20) : l'icône `text-success` sur
 * `success-bg` tombe à **2,93:1**, soit 0,07 sous le seuil 3:1 des objets non textuels
 * (le fond teinté, plus sombre que le blanc, rabote le contraste du vert : 3,46 → 2,93).
 * Non corrigé ICI à dessein — le seul correctif propre est un token `success-700` plus
 * sombre, qui est l'objet même de A11Y-VERT-SUCCES1 (P1, branche dédiée post-démo) ;
 * l'introduire en catimini reviendrait à trancher cet arbitrage sans le dire. Recycler
 * `inflow-700` (5,36:1) serait pire : c'est un token de DONNÉE financière, et §3.7
 * interdit de le détourner en couleur d'état système. L'écart reste sans conséquence
 * fonctionnelle : l'icône est `aria-hidden` et strictement redondante avec le message,
 * qui porte le sens à 15,1:1 — 1.4.11 vise les objets graphiques NÉCESSAIRES à la
 * compréhension. Les icônes `warning` (4,56:1) et `danger` (4,40:1) passent, elles.
 *
 * Facture APP UI (pas « mosaïque de cartes ») : `rounded-control`, aucune ombre, aucune
 * bordure gauche colorée (motif générique), hauteur compacte. Un callout est une LIGNE
 * d'information, pas une carte.
 *
 * Présentationnel PUR : aucun fetch, aucun état, aucune Server Action. L'action
 * éventuelle est fournie par l'appelant via `action` (lien ou bouton déjà stylé) ; la
 * fermeture est un simple `onFermer` — c'est l'APPELANT qui détient l'état de
 * fermeture, et donc qui garantit sa ré-apparition (cf. `onFermer`).
 */
import type { ReactNode } from "react";

import { cn } from "./primitives";

/**
 * Sévérités disponibles. `success` porte un RÉSULTAT (éphémère, fermable), `warning` et
 * `danger` portent une CONDITION (elles durent tant que la condition tient).
 */
export type SeveriteCallout = "danger" | "warning" | "success";

const STYLES: Record<SeveriteCallout, { fond: string; icone: string }> = {
  danger: { fond: "bg-danger-bg", icone: "text-danger" },
  warning: { fond: "bg-warning-bg", icone: "text-warning" },
  success: { fond: "bg-success-bg", icone: "text-success" },
};

export function Callout({
  severite,
  children,
  action,
  role,
  onFermer,
  libelleFermer = "Fermer ce message",
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
  /**
   * Rend un bouton « fermer ». Réservé à ce qui est ÉPHÉMÈRE (le résultat du dernier
   * geste). ⚠️ Ne JAMAIS le brancher sur un avertissement dont la condition est encore
   * vraie : fermer un `warning`/`danger` toujours valide masque un problème réel —
   * exactement l'échec silencieux que les messages de synchro existent pour surfacer.
   * L'état de fermeture appartient à l'appelant et ne doit pas être PERSISTÉ
   * (localStorage & co.) : un nouveau résultat doit toujours se ré-annoncer.
   */
  onFermer?: () => void;
  /** Libellé accessible du bouton de fermeture (l'icône est décorative). */
  libelleFermer?: string;
  className?: string;
}) {
  const style = STYLES[severite];
  const Icone = severite === "success" ? IconeSucces : IconeAlerte;

  return (
    <div
      role={role}
      className={cn(
        "flex flex-col gap-2 rounded-control px-3 py-2",
        "sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        style.fond,
        className,
      )}
    >
      <p className="flex items-start gap-2 text-sm text-text">
        <Icone className={cn("mt-0.5 h-4 w-4 shrink-0", style.icone)} />
        <span>{children}</span>
      </p>
      {(action || onFermer) && (
        <span className="flex shrink-0 items-center gap-3 sm:self-center">
          {action}
          {onFermer && (
            <button
              type="button"
              onClick={onFermer}
              aria-label={libelleFermer}
              className={cn(
                "-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center",
                "rounded-[2px] text-text-muted transition-colors hover:text-text",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                "focus-visible:ring-offset-2",
              )}
            >
              <IconeFermer className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      )}
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

/**
 * Icône « coche cerclée » (succès). SVG inline pur (règle 9). Décorative comme sa
 * jumelle d'alerte : c'est le message en `text-text` qui porte le sens accessible —
 * le vert n'est ici qu'un signal graphique, jamais le véhicule de la lisibilité.
 */
function IconeSucces({ className }: { className?: string }) {
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
      <circle cx="8" cy="8" r="6.4" />
      <path d="m5.3 8.2 1.9 1.9 3.5-3.9" />
    </svg>
  );
}

/** Icône « croix » du bouton de fermeture. Décorative : `aria-label` porte le sens. */
function IconeFermer({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
