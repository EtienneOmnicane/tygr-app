/**
 * Indicateur de statut de ventilation pour une ligne de /transactions.
 * Présentationnel PUR (aucune donnée fetchée, aucun état).
 *
 * Rend, selon le résumé porté par la ligne (B2 du contrat,
 * FB0709-TX-CATEGORIE-VISIBLE1 : le NOM prime sur le compteur) :
 *  - 1 catégorie  → CategoryBadge réel (couleur déterministe), + « partiel » si la
 *                   somme des splits < |montant|.
 *  - N catégories → badge de la catégorie DOMINANTE + suffixe « +N−1 » (le détail
 *                   s'ouvre dans la modale) ; repli pastille neutre « N catégories »
 *                   si la dominante est inconnue, + « partiel » éventuel.
 *  - 0 catégorie  → « Non catégorisé » en `text-muted` : incitation DISCRÈTE, pas
 *                   une alerte (l'absence de ventilation n'est pas une erreur).
 *
 * ⚠️ Couleurs (UI_GUIDELINES) : JAMAIS de vert/rouge ici (réservés aux montants
 * inflow/outflow). Le « partiel » emploie l'AMBRE (`warning`, token des états
 * partiels §3.6), cohérent avec le « partiel serein » de la modale (pas de rouge).
 */
import { CategoryBadge } from "@/components/ui/category";
import type { StatutCategorisation } from "./types-transactions";

/** Concatène des classes en ignorant les valeurs falsy. Pas de clsx (règle 9). */
function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Petit point ambre + libellé « partiel » — indice de ventilation incomplète. */
function IndicePartiel() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium text-warning"
      title="Ventilation partielle : une partie du montant reste à catégoriser"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
      partiel
    </span>
  );
}

export function CategorisationStatusBadge({
  statut,
  categorie,
  nbCategories,
  size = "sm",
  className,
}: {
  statut: StatutCategorisation;
  /** Catégorie unique (mono) ou DOMINANTE (multi) ; null si aucune/inconnue. */
  categorie: { id: string; name: string } | null;
  nbCategories: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const partiel = statut === "partiel";

  // 0 catégorie : incitation neutre, jamais d'alerte.
  if (nbCategories === 0 || statut === "non_categorise") {
    return (
      <span
        className={cn(
          "inline-flex items-center text-[11px] font-medium text-text-muted",
          className,
        )}
      >
        Non catégorisé
      </span>
    );
  }

  // 1 catégorie : badge réel + indice partiel éventuel.
  if (nbCategories === 1 && categorie) {
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        <CategoryBadge name={categorie.name} colorKey={categorie.id} size={size} />
        {partiel && <IndicePartiel />}
      </span>
    );
  }

  // N catégories, dominante CONNUE : badge nommé + « +N−1 » (les autres parts,
  // détaillées dans la modale). Le nom peut tronquer (CategoryBadge), le suffixe
  // reste entier. FB0709-TX-CATEGORIE-VISIBLE1.
  if (categorie) {
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        <CategoryBadge name={categorie.name} colorKey={categorie.id} size={size} />
        <span
          className="text-[11px] font-medium text-text-muted"
          title={`${nbCategories} catégories ventilées — détail dans la fenêtre de ventilation`}
        >
          +{nbCategories - 1}
        </span>
        {partiel && <IndicePartiel />}
      </span>
    );
  }

  // Repli (dominante inconnue) : pastille neutre de comptage.
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className={cn(
          "inline-flex max-w-full items-center rounded-full bg-surface-inset font-medium text-text",
          size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        )}
      >
        {nbCategories} catégories
      </span>
      {partiel && <IndicePartiel />}
    </span>
  );
}
