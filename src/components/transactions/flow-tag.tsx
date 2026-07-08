/**
 * Tag visuel ENTRÉE / SORTIE d'une transaction, dérivé du sens bancaire
 * (Credit → entrée, Debit → sortie). Rend la lecture du flux immédiate, en
 * complément du montant signé déjà coloré.
 *
 * Couleurs (UI_GUIDELINES §3.1) : le sens d'un flux EST une donnée financière —
 * le vert/rouge est donc LÉGITIME ici (même registre que le montant inflow/
 * outflow), contrairement aux badges de catégorie qui n'en portent jamais. Fond
 * pastel + texte 700 (§3.6 : jamais saturé), petite flèche directionnelle.
 *
 * Présentationnel PUR : aucune donnée fetchée, aucun état.
 */

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function FlowTag({
  sens,
  size = "sm",
  variant = "solid",
  className,
}: {
  sens: "Credit" | "Debit";
  size?: "sm" | "md";
  /**
   * "solid" (défaut) = pastille pastel §3.6 ; "subtle" = flèche + mot sans fond,
   * pour les contextes où le MONTANT au-dessus porte déjà la couleur ET le signe
   * (ligne /transactions) : la pastille faisait redite visuelle (« cercle » trop
   * présent). Le sens reste une donnée → couleur sémantique conservée, poids réduit.
   */
  variant?: "solid" | "subtle";
  className?: string;
}) {
  const entree = sens === "Credit";
  const subtil = variant === "subtle";
  return (
    <span
      className={cn(
        "inline-flex items-center font-medium",
        subtil
          ? "gap-0.5 text-[11px]"
          : cn(
              "gap-1 rounded-full",
              size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
            ),
        entree
          ? subtil
            ? "text-inflow-700"
            : "bg-inflow-bg text-inflow-700"
          : subtil
            ? "text-outflow-700"
            : "bg-outflow-bg text-outflow-700",
        className,
      )}
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={subtil ? "size-2.5" : "size-3"}
      >
        {entree ? (
          <>
            <path d="M12 19V5" />
            <path d="m6 11 6-6 6 6" />
          </>
        ) : (
          <>
            <path d="M12 5v14" />
            <path d="m6 13 6 6 6-6" />
          </>
        )}
      </svg>
      {entree ? "Entrée" : "Sortie"}
    </span>
  );
}
