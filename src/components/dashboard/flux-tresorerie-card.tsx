"use client";

/**
 * Carte ANCRE du dashboard (UI_GUIDELINES §1.1/§4.2) : « Flux de trésorerie ». Elle rend
 * les BARRES entrées/sorties par mois, sans fetch : la donnée arrive en props
 * (`serieMensuelle` = syntheseParMois + `grilleMensuelle` = grilleMois) et `FluxBarres`
 * la projette sur la grille continue (`projeterSurGrille` — mois vides à zéro).
 *
 * La vue « courbe » et son toggle ont été retirés (décision produit 2026-07-10) : la carte
 * n'a plus qu'une seule représentation, donc plus d'état local — c'est un îlot client
 * uniquement parce que `FluxBarres` mesure son SVG (ResizeObserver). L'état « aucun
 * mouvement sur la période » est porté par `FluxBarres` lui-même.
 *
 * Couleurs (§3.1) : le vert/rouge n'apparaît que DANS le SVG des barres et dans la LÉGENDE
 * (qui décrit la donnée). Hauteur min 380px (§4.2) : la carte garde sa place même vide.
 */
import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

import { StateCard } from "@/components/dashboard/states/primitives";
import { FluxBarres } from "@/components/dashboard/flux-bars";
import type { PrevisionFlux } from "@/components/dashboard/flux-projection";

export function FluxTresorerieCard({
  serieMensuelle,
  grilleMensuelle,
  prevision,
  devise,
  libellePeriode,
}: {
  /** Série entrées/sorties (mois × devise) — alimente les barres. */
  serieMensuelle: SyntheseMensuelle[];
  /** Axe continu des mois attendus (comble les mois sans transaction). */
  grilleMensuelle: string[];
  /**
   * Zone prévisionnelle (échéances projetées) ou `null` — la page décide (D4). La carte ne
   * la calcule pas : elle arrive dans le MÊME payload serveur que le réalisé.
   */
  prevision?: PrevisionFlux | null;
  /** Devise de base du workspace. */
  devise: string;
  /** Libellé de la fenêtre appliquée (source unique : la page) — relayé à `FluxBarres`. */
  libellePeriode?: string;
}) {
  return (
    <StateCard className="min-h-[380px]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">Flux de trésorerie</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {prevision
              ? "Entrées − sorties par mois · prévision issue des échéances"
              : "Entrées − sorties par mois"}
          </p>
        </div>

        <Legende avecPrevision={Boolean(prevision)} />
      </div>

      <FluxBarres
        serie={serieMensuelle}
        grille={grilleMensuelle}
        prevision={prevision}
        devise={devise}
        libellePeriode={libellePeriode}
      />
    </StateCard>
  );
}

/**
 * Légende des barres : Entrées (inflow) / Sorties (outflow). Ici le vert/rouge DÉCRIT la
 * donnée affichée (légitime, §3.1).
 *
 * La pastille « Prévision » n'apparaît que si une zone prévisionnelle est rendue — et elle
 * est NEUTRE (`surface-forecast` + bordure), jamais verte/rouge : le prévisionnel n'emprunte
 * pas les couleurs sémantiques du réalisé, sous peine de les confondre (§3.5).
 */
function Legende({ avecPrevision }: { avecPrevision: boolean }) {
  return (
    <span className="flex items-center gap-3 text-xs text-text-muted">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-inflow" />
        Entrées
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2 w-2 rounded-full bg-outflow" />
        Sorties
      </span>
      {avecPrevision && (
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full border border-line bg-surface-forecast"
          />
          Prévision
        </span>
      )}
    </span>
  );
}
