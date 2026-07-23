"use client";

/**
 * Légende NOMMÉE et INTERACTIVE d'un graphe de flux — remplace la légende statique de
 * l'ancre « Flux de trésorerie ». Chaque entrée est un `<button aria-pressed>` (JAMAIS
 * un `div` cliquable) qui masque/affiche sa série.
 *
 * Invariants (PLAN-graphs-fygr §5.3) :
 *  - on ne peut pas masquer TOUTES les séries : la dernière visible est VERROUILLÉE
 *    (`aria-disabled` + `title`), et le clic est inerte — le graphe ne devient jamais
 *    un cadre vide sans explication (la décision vit dans `series-types.ts`).
 *  - une série masquée se signale par l'OPACITÉ **et** un libellé BARRÉ (`line-through`)
 *    — jamais par la couleur seule (WCAG 1.4.1).
 *
 * Le vert/rouge des pastilles DÉCRIT la donnée (`inflow`/`outflow`, UI_GUIDELINES §3.1) ;
 * `tokenPastille` est un NOM de token (jamais un hex). Présentationnel PUR : `onBasculer`
 * est une prop optionnelle et INERTE par défaut (le conteneur porte l'état).
 */
import type { IdSerieFlux, SerieFluxMeta, VisibiliteSeries } from "./series-types";
import { estDerniereVisible } from "./series-types";

export function LegendeSeries({
  series,
  visibles,
  onBasculer,
}: {
  series: readonly SerieFluxMeta[];
  visibles: VisibiliteSeries;
  /** Bascule d'une série. Absent → légende inerte (rendu pur, aucune interaction). */
  onBasculer?: (id: IdSerieFlux) => void;
}) {
  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label="Séries affichées"
    >
      {series.map((serie) => {
        const visible = visibles.has(serie.id);
        const verrouillee = estDerniereVisible(visibles, serie.id);
        return (
          <button
            key={serie.id}
            type="button"
            aria-pressed={visible}
            aria-disabled={verrouillee || undefined}
            // Interactif seulement si un handler est fourni ET que le clic est légal.
            onClick={
              onBasculer && !verrouillee
                ? () => onBasculer(serie.id)
                : undefined
            }
            title={
              verrouillee
                ? "Au moins une série doit rester visible"
                : visible
                  ? `Masquer la série ${serie.libelle}`
                  : `Afficher la série ${serie.libelle}`
            }
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              onBasculer && !verrouillee ? "cursor-pointer hover:bg-surface-inset" : "",
              verrouillee ? "cursor-default" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span
              aria-hidden
              className={[
                "h-2 w-2 shrink-0 rounded-full",
                serie.tokenPastille,
                // Signal NON-coloré du masquage : la pastille s'estompe (l'état est
                // aussi porté par le libellé barré ci-dessous — jamais la couleur seule).
                visible ? "" : "opacity-30",
              ].join(" ")}
            />
            <span
              className={
                visible
                  ? "text-text-muted"
                  : "text-text-faint line-through"
              }
            >
              {serie.libelle}
            </span>
          </button>
        );
      })}
    </div>
  );
}
