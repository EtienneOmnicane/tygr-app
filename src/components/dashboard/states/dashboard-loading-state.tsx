/**
 * État LOADING du dashboard — squelette de chargement (UI_GUIDELINES §4.4,
 * checklist §6.5). Reprend la FORME réelle de l'écran : la carte « courbe de
 * trésorerie » (ancre, §4.2) puis la carte « table de transactions » (§2.2).
 *
 * Présentationnel pur : aucun fetch, aucun état. `animate-pulse` natif Tailwind.
 * Les placeholders de montants portent déjà `tabular-nums` (directive §0) pour
 * que le passage au contenu réel ne déplace pas les chiffres.
 */
import { SkeletonBlock, StateCard, cn } from "./primitives";

const HAUTEURS_BARRES = [
  "h-16",
  "h-24",
  "h-20",
  "h-32",
  "h-28",
  "h-40",
  "h-24",
  "h-36",
  "h-20",
  "h-28",
  "h-44",
  "h-32",
];

export function DashboardLoadingState({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-busy="true"
      aria-label="Chargement du tableau de bord"
    >
      <span className="sr-only">Chargement des données de trésorerie…</span>

      {/* Carte courbe de trésorerie (ancre du dashboard) */}
      <StateCard className="min-h-[380px]">
        {/* En-tête : titre + période + légende */}
        <div className="mb-6 flex items-start justify-between">
          <div className="flex flex-col gap-2">
            <SkeletonBlock className="h-4 w-44" />
            <SkeletonBlock className="h-3 w-56" />
          </div>
          <div className="flex items-center gap-4">
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-3 w-20" />
          </div>
        </div>

        {/* Zone de dessin : axe Y (montants tabular) + barres */}
        <div className="flex gap-4">
          <div className="flex w-12 shrink-0 flex-col justify-between py-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonBlock
                key={i}
                className="h-3 w-10 tabular-nums"
              />
            ))}
          </div>
          <div className="flex flex-1 items-end gap-3 border-l border-b border-line pl-4 pb-1">
            {HAUTEURS_BARRES.map((h, i) => (
              <SkeletonBlock
                key={i}
                className={cn("w-full min-w-[8px]", h)}
              />
            ))}
          </div>
        </div>

        {/* Axe X */}
        <div className="mt-4 flex justify-between pl-16">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-3 w-10" />
          ))}
        </div>
      </StateCard>

      {/* Carte table de transactions */}
      <StateCard>
        {/* Titre de carte */}
        <SkeletonBlock className="mb-5 h-4 w-40" />

        {/* En-têtes de colonnes (DATE · LIBELLÉ · CATÉGORIE · MONTANT) */}
        <div className="grid grid-cols-[88px_1fr_140px_120px] gap-4 border-b border-line pb-3">
          <SkeletonBlock className="h-3 w-12" />
          <SkeletonBlock className="h-3 w-24" />
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="ml-auto h-3 w-16" />
        </div>

        {/* Lignes de transactions */}
        <div className="divide-y divide-line">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[88px_1fr_140px_120px] items-center gap-4 py-3"
            >
              <SkeletonBlock className="h-3 w-16" />
              <SkeletonBlock className="h-3 w-3/4" />
              <SkeletonBlock className="h-5 w-24" rounded="pill" />
              {/* Montant : aligné à droite, largeur stable tabular-nums */}
              <SkeletonBlock className="ml-auto h-3 w-20 tabular-nums" />
            </div>
          ))}
        </div>
      </StateCard>
    </div>
  );
}
