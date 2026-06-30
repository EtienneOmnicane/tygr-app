"use client";

/**
 * Carte ANCRE du dashboard (UI_GUIDELINES §1.1/§4.2) : « Flux de trésorerie » unifiée
 * (L8a). Un TOGGLE Barres/Courbe bascule entre deux vues de la MÊME grandeur mensuelle
 * (entrées − sorties par mois), sans aucun fetch : les deux séries arrivent déjà en
 * props depuis la page RSC (`flux` = cashflowParDevise, `serieMensuelle`+`grille` =
 * syntheseParMois). On réutilise les rendus SVG extraits (`FluxCourbe`, `FluxBarres`) —
 * géométrie inchangée vs l'existant.
 *
 * Îlot client : porte l'état du toggle. Le survol de la courbe est local à `FluxCourbe`.
 *
 * Couleurs (§3.1) : le CONTRÔLE (segmented control) est du CHROME → `ink` / `surface-inset`
 * / `text-*` UNIQUEMENT, jamais une couleur de donnée. Le vert/rouge n'apparaît que DANS
 * le SVG des barres et dans la LÉGENDE des barres (qui décrit la donnée). Hauteur min 380px
 * (§4.2) : la carte garde sa place quelle que soit la vue (pas de saut de layout au toggle).
 */
import { useState } from "react";

import type { PointCashflow } from "@/server/insights/types";
import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

import { cn } from "@/components/ui/states/primitives";
import { StateCard } from "@/components/dashboard/states/primitives";
import { FluxCourbe } from "@/components/dashboard/flux-chart-trace";
import { FluxBarres } from "@/components/dashboard/flux-bars";

type Vue = "courbe" | "barres";

export function FluxTresorerieCard({
  flux,
  serieMensuelle,
  grilleMensuelle,
  devise,
}: {
  /** Points de flux net mensuel (UNE devise, base_currency) — vue Courbe. */
  flux: PointCashflow[];
  /** Série entrées/sorties (mois × devise) — vue Barres. */
  serieMensuelle: SyntheseMensuelle[];
  /** Axe continu des mois attendus (comble les mois sans transaction) — vue Barres. */
  grilleMensuelle: string[];
  /** Devise de base du workspace. */
  devise: string;
}) {
  const [vue, setVue] = useState<Vue>("courbe");

  return (
    <StateCard className="min-h-[380px]">
      {/* En-tête PARTAGÉ : titre + sous-titre, légende adaptée à la vue, toggle à droite. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">Flux de trésorerie</h2>
          <p className="mt-0.5 text-xs text-text-muted">Entrées − sorties par mois</p>
        </div>

        <div className="flex items-center gap-3">
          <Legende vue={vue} />
          <ToggleVue vue={vue} onChange={setVue} />
        </div>
      </div>

      {vue === "courbe" ? (
        <FluxCourbe points={flux} devise={devise} />
      ) : (
        <FluxBarres serie={serieMensuelle} grille={grilleMensuelle} devise={devise} />
      )}
    </StateCard>
  );
}

/**
 * Légende contextuelle. Courbe → un seul repère « Flux net » (point primary). Barres →
 * deux repères Entrées (inflow) / Sorties (outflow). Ici le vert/rouge DÉCRIT la donnée
 * affichée (légitime, §3.1).
 */
function Legende({ vue }: { vue: Vue }) {
  if (vue === "courbe") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-text-muted">
        <span aria-hidden className="h-2 w-2 rounded-full bg-primary" />
        Flux net
      </span>
    );
  }
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
    </span>
  );
}

/**
 * Segmented control Courbe/Barres (UI_GUIDELINES §2.3 : conteneur `surface-inset`
 * rounded-control, segment actif = pill `ink` texte blanc). CHROME uniquement —
 * aucune couleur de donnée. `aria-pressed` sur chaque segment ; focus ring primary.
 */
function ToggleVue({
  vue,
  onChange,
}: {
  vue: Vue;
  onChange: (v: Vue) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Affichage du flux de trésorerie"
      className="inline-flex rounded-control bg-surface-inset p-0.5"
    >
      <SegmentVue actif={vue === "courbe"} onClick={() => onChange("courbe")}>
        Courbe
      </SegmentVue>
      <SegmentVue actif={vue === "barres"} onClick={() => onChange("barres")}>
        Barres
      </SegmentVue>
    </div>
  );
}

function SegmentVue({
  actif,
  onClick,
  children,
}: {
  actif: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={actif}
      onClick={onClick}
      className={cn(
        "rounded-[6px] px-3 py-1 text-xs font-semibold transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        "focus-visible:ring-offset-2",
        actif
          ? "bg-ink text-text-onink"
          : "text-text-muted hover:text-text",
      )}
    >
      {children}
    </button>
  );
}
