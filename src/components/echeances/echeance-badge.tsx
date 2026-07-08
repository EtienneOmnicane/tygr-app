/**
 * EcheanceBadge — pastille de STATUT d'échéance (UI_GUIDELINES §3.6). Brique
 * présentationnelle PURE : aucune donnée fetchée, aucun état, aucune Server Action.
 * SOURCE UNIQUE du rendu d'un statut d'échéance (label + teinte) — aucun composant
 * ne redéfinit sa propre table de statuts (même esprit que la source unique de
 * formatage, règle 8).
 *
 * Mapping §3.6 (fond pastel + texte foncé, JAMAIS de fond saturé) :
 *   En cours          → primary-50 / primary
 *   En retard         → outflow-bg / outflow-700   (dérivé, jamais stocké — ECH-D5)
 *   Partiel           → warning-bg / warning
 *   Paiement en cours → primary-50 / primary
 *   Payée             → success-bg / success
 *   Annulée           → surface-inset / text-muted
 *
 * ⚠️ Le rouge « en retard » vient d'`outflow` (donnée), cohérent §3.1 : c'est une
 * information financière (une sortie/dette exigible dépassée), pas une erreur système.
 */
import type { StatutEcheanceAffiche } from "./types-echeances";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

interface StyleStatut {
  label: string;
  classes: string;
}

/** Table unique statut d'affichage → { libellé FR, teinte pastel §3.6 }. */
const STYLES: Record<StatutEcheanceAffiche, StyleStatut> = {
  en_cours: { label: "En cours", classes: "bg-primary-50 text-primary" },
  en_retard: { label: "En retard", classes: "bg-outflow-bg text-outflow-700" },
  partiel: { label: "Partiel", classes: "bg-warning-bg text-warning" },
  paiement_en_cours: {
    label: "Paiement en cours",
    classes: "bg-primary-50 text-primary",
  },
  payee: { label: "Payée", classes: "bg-success-bg text-success" },
  annulee: { label: "Annulée", classes: "bg-surface-inset text-text-muted" },
};

export function EcheanceBadge({
  statut,
  className,
}: {
  /** Statut d'AFFICHAGE (inclut le dérivé « en_retard »). */
  statut: StatutEcheanceAffiche;
  className?: string;
}) {
  const style = STYLES[statut];
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        style.classes,
        className,
      )}
    >
      {style.label}
    </span>
  );
}

/** Libellé FR d'un statut d'affichage (réutilisable hors badge : options de select). */
export function libelleStatut(statut: StatutEcheanceAffiche): string {
  return STYLES[statut].label;
}
