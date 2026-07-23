"use client";

/**
 * Carte ANCRE du dashboard (UI_GUIDELINES §1.1/§4.2) : « Flux de trésorerie ». Feature
 * CLIENTE INTERACTIVE (PLAN-graphs-fygr) — elle porte l'état d'AFFICHAGE, jamais de fetch
 * ni de logique métier :
 *  - L1 · TOGGLE graphique ↔ tableau : une même série, deux représentations (le graphe
 *    donne la forme, le tableau les valeurs exactes). Invariant : les deux reçoivent la
 *    MÊME donnée.
 *  - L1 · LÉGENDE NOMMÉE INTERACTIVE : masquer/afficher entrées ou sorties (jamais les
 *    deux — cf. `series-types.ts`). N'apparaît qu'en vue graphique (le tableau montre
 *    toujours toutes les colonnes).
 *  - L3 · SÉLECTEUR DE DEVISE : une série à la fois (jamais d'addition cross-devise,
 *    règle 8). N'apparaît que si la fenêtre porte plus d'une devise. Ferme la dette
 *    DASH-CASHFLOW-MULTISERIE (le graphe n'était visible que sur la devise de base).
 *
 * La donnée arrive en props (`serieMensuelle` = syntheseParMois + `grilleMensuelle` =
 * grilleMois) ; `FluxBarres`/`TableauEvolution` la projettent sur la grille continue
 * (mois vides à zéro). Îlot client car `FluxBarres` mesure son SVG (ResizeObserver) et la
 * carte porte désormais de l'état d'affichage.
 *
 * ⚠️ 100 % RÉALISÉ depuis FLUX-PREV-AXE1 (option E) : la carte ne reçoit plus de prévision.
 * Les échéances vivent dans `echeances-encart.tsx`. Couleurs (§3.1) : vert/rouge n'apparaît
 * que DANS le SVG des barres, le tableau et la LÉGENDE (qui décrivent la donnée).
 */
import { useMemo, useState } from "react";

import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

import { StateCard } from "@/components/dashboard/states/primitives";
import { FluxBarres } from "@/components/dashboard/flux-bars";
import { TableauEvolution } from "@/components/dashboard/monthly-cashflow";
import { Select } from "@/components/ui/select/select";
import { LegendeSeries } from "@/components/charts/legende-series";
import { ToggleVue, type VueFlux } from "@/components/charts/toggle-vue";
import {
  SERIES_FLUX,
  TOUTES_SERIES_VISIBLES,
  basculerVisibilite,
  type IdSerieFlux,
  type VisibiliteSeries,
} from "@/components/charts/series-types";

export function FluxTresorerieCard({
  serieMensuelle,
  grilleMensuelle,
  devise,
  libellePeriode,
}: {
  /** Série entrées/sorties (mois × devise) — alimente le graphe ET le tableau. */
  serieMensuelle: SyntheseMensuelle[];
  /** Axe continu des mois attendus (comble les mois sans transaction). */
  grilleMensuelle: string[];
  /** Devise de BASE du workspace (défaut du sélecteur L3). */
  devise: string;
  /** Libellé de la fenêtre appliquée (source unique : la page). */
  libellePeriode?: string;
}) {
  const [vue, setVue] = useState<VueFlux>("graphique");
  const [visibles, setVisibles] = useState<VisibiliteSeries>(
    TOUTES_SERIES_VISIBLES,
  );
  const [deviseSel, setDeviseSel] = useState<string>(devise);

  // Devises RÉELLEMENT présentes dans la fenêtre, devise de base en tête (toujours
  // offerte, même sans mouvement) puis les autres par ordre alphabétique stable.
  const devisesDisponibles = useMemo(
    () => devisesPresentes(serieMensuelle, devise),
    [serieMensuelle, devise],
  );
  // Le sélecteur n'a de sens qu'en multi-devise (une seule → rien à choisir).
  const multiDevise = devisesDisponibles.length > 1;
  // Défense : si la devise sélectionnée disparaît de la fenêtre (re-fetch futur), on
  // retombe sur une devise présente plutôt que d'afficher un graphe muet.
  const deviseAffichee = devisesDisponibles.includes(deviseSel)
    ? deviseSel
    : devisesDisponibles[0];

  const basculerSerie = (id: IdSerieFlux) =>
    setVisibles((v) => basculerVisibilite(v, id));

  return (
    <StateCard className="min-h-[380px]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">Flux de trésorerie</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Entrées − sorties par mois · réalisé
          </p>
        </div>

        {/* Cluster de contrôles (contenu de carte — `flex-wrap` autorisé, ce n'est pas
            le header de page). Devise (multi) · toggle · légende (vue graphique seule). */}
        <div className="flex flex-wrap items-center gap-3">
          {multiDevise && (
            <Select
              value={deviseAffichee}
              onChange={setDeviseSel}
              size="sm"
              ariaLabel="Devise affichée"
              options={devisesDisponibles.map((d) => ({ value: d, label: d }))}
            />
          )}
          <ToggleVue vue={vue} onChange={setVue} />
          {vue === "graphique" && (
            <LegendeSeries
              series={SERIES_FLUX}
              visibles={visibles}
              onBasculer={basculerSerie}
            />
          )}
        </div>
      </div>

      {vue === "graphique" ? (
        <FluxBarres
          serie={serieMensuelle}
          grille={grilleMensuelle}
          devise={deviseAffichee}
          libellePeriode={libellePeriode}
          visibles={visibles}
        />
      ) : (
        <TableauEvolution
          serie={serieMensuelle}
          grille={grilleMensuelle}
          devise={deviseAffichee}
        />
      )}
    </StateCard>
  );
}

/**
 * Devises présentes dans la série, devise de BASE en tête (toujours offerte même sans
 * mouvement — le graphe doit pouvoir revenir à la devise de référence), puis les autres
 * par ordre alphabétique STABLE (déterminisme du rendu). Pur.
 */
function devisesPresentes(
  serie: SyntheseMensuelle[],
  base: string,
): string[] {
  const autres = [
    ...new Set(serie.map((s) => s.currency).filter((c) => c !== base)),
  ].sort();
  return [base, ...autres];
}
