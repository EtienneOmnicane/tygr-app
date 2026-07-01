"use client";

/**
 * Carte ANCRE du dashboard (UI_GUIDELINES §1.1/§4.2) : « Flux de trésorerie » unifiée
 * (L8a). Un TOGGLE Barres/Courbe bascule entre deux vues de la MÊME grandeur mensuelle
 * (entrées − sorties par mois), sans aucun fetch. Les DEUX vues dérivent de la MÊME source
 * en props (`serieMensuelle` = syntheseParMois + `grilleMensuelle` = grilleMois) : les
 * barres via `projeterSurGrille`, la courbe via `projeterPointsCourbe` (même grille continue
 * → N points, mois vides à zéro). On réutilise les rendus SVG extraits (`FluxCourbe`,
 * `FluxBarres`) — géométrie inchangée vs l'existant.
 *
 * ⚠️ La courbe ne consomme PLUS les points bruts de `cashflowParDevise` (mois vides absents),
 * qui s'effondraient à 1 point quand un seul mois de la fenêtre était peuplé (fix « courbe
 * effondrée »). Elle passe désormais par la grille, exactement comme les barres.
 *
 * Îlot client : porte l'état du toggle. Le survol de la courbe est local à `FluxCourbe`.
 *
 * Couleurs (§3.1) : le CONTRÔLE (segmented control) est du CHROME → `ink` / `surface-inset`
 * / `text-*` UNIQUEMENT, jamais une couleur de donnée. Le vert/rouge n'apparaît que DANS
 * le SVG des barres et dans la LÉGENDE des barres (qui décrit la donnée). Hauteur min 380px
 * (§4.2) : la carte garde sa place quelle que soit la vue (pas de saut de layout au toggle).
 */
import { useState } from "react";

import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

import { formaterMoisAnnee } from "@/lib/format-date";
import { cn } from "@/components/ui/states/primitives";
import { StateCard } from "@/components/dashboard/states/primitives";
import { FluxCourbe } from "@/components/dashboard/flux-chart-trace";
import { FluxBarres } from "@/components/dashboard/flux-bars";
import { projeterPointsCourbe } from "@/components/dashboard/flux-projection";

type Vue = "courbe" | "barres";

export function FluxTresorerieCard({
  serieMensuelle,
  grilleMensuelle,
  devise,
}: {
  /** Série entrées/sorties (mois × devise) — alimente COURBE (via grille) ET barres. */
  serieMensuelle: SyntheseMensuelle[];
  /** Axe continu des mois attendus (comble les mois sans transaction). */
  grilleMensuelle: string[];
  /** Devise de base du workspace. */
  devise: string;
}) {
  const [vue, setVue] = useState<Vue>("courbe");

  // La COURBE consomme désormais la MÊME série continue que les barres (projetée sur la
  // grille → N points, mois vides à net="0"), au lieu des points bruts filtrés qui
  // s'effondraient à 1 point quand un seul mois de la fenêtre était peuplé.
  const pointsCourbe = projeterPointsCourbe(serieMensuelle, grilleMensuelle, devise);
  // Un mois est « peuplé » (dans la devise de base) s'il porte un mouvement non nul.
  const moisPeuples = pointsCourbe.filter(
    (p) => p.entrees !== "0" || p.sorties !== "0",
  );
  // 0 mois peuplé : préserver EXACTEMENT l'écran vide actuel. Comme la série a toujours N
  // points (jamais 0), la garde `points.length === 0` de FluxCourbe ne se déclencherait
  // plus → on lui passe [] pour ré-obtenir `CourbeVide` (message « Aucun flux… »).
  const courbeVide = moisPeuples.length === 0;
  // 1 seul mois peuplé : la courbe s'affiche pleine largeur, mais on signale que les
  // autres mois sont à zéro (bandeau info, tokens neutres) — le graphe n'est pas masqué.
  const moisUnique =
    moisPeuples.length === 1 ? moisPeuples[0]!.bucket : null;

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
        <>
          {/* Bandeau INFO : uniquement si UN seul mois est peuplé sur la fenêtre. Chrome
              neutre (surface-inset / text-muted) — jamais de vert/rouge (réservés à la
              donnée), jamais de couleur en dur. N'existe pas de token `info` au projet. */}
          {moisUnique && (
            <p
              role="status"
              className="mb-3 rounded-control border border-line bg-surface-inset px-3 py-2 text-xs text-text-muted"
            >
              Données disponibles sur un seul mois — dernières données&nbsp;:{" "}
              <span className="font-medium text-text">
                {formaterMoisAnnee(moisUnique)}
              </span>
              . Les autres mois de la période sont sans mouvement.
            </p>
          )}
          <FluxCourbe points={courbeVide ? [] : pointsCourbe} devise={devise} />
        </>
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
