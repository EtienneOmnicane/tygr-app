/**
 * Badge « À vérifier » — indice de FIABILITÉ AMONT faible (concept B). Présentationnel
 * PUR (aucune donnée fetchée, aucun état). Il REÇOIT le verdict (calculé par le module
 * pur `regle-fiabilite`) ; il ne décide pas lui-même.
 *
 * ⚠️ COULEUR (UI_GUIDELINES §3.6 badges de statut / §3.7) : AMBRE (`warning` /
 * `warning-bg`), cohérent avec l'« partiel » de `CategorisationStatusBadge`. JAMAIS de
 * rouge (réservé aux montants `outflow`, §3.1) : « à vérifier » est un état à confirmer,
 * pas une erreur ni une perte. JAMAIS de vert non plus.
 *
 * Distinct du badge de VENTILATION manuelle (concept A) : les deux peuvent coexister
 * dans la colonne Statut (pile verticale), ils ne se remplacent pas.
 */

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Triangle d'alerte outline (SVG inline — pas de lucide, règle 9). */
function IconeAlerte() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2.5 14.5 13.5H1.5L8 2.5Z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.5h.01" />
    </svg>
  );
}

export function FiabiliteBadge({
  /** Verdict pré-calculé par `afficherAVerifier`. `false` ⇒ rien n'est rendu. */
  afficher,
  className,
}: {
  afficher: boolean;
  className?: string;
}) {
  if (!afficher) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning",
        className,
      )}
      title="Classification automatique peu fiable — à vérifier"
    >
      <IconeAlerte />À vérifier
    </span>
  );
}
