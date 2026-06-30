"use client";

/**
 * PeriodeSwitcher — sélecteur de PÉRIODE du dashboard (L8c), dans le header à côté
 * du PerimetreSwitcher. Presets uniquement : Ce mois / 3 mois / 6 mois / 12 mois / Tout.
 *
 * CANAL = searchParams (`?periode=...`), PAS le JWT (≠ PerimetreSwitcher qui touche la
 * RLS via une Server Action) : la période est un simple filtre de LECTURE. Ce composant
 * ne fait donc AUCUN appel serveur — il lit la valeur active dans l'URL
 * (`useSearchParams`) et la met à jour par une navigation CLIENT (`router.replace`), ce
 * qui re-rend le RSC `page.tsx` avec la nouvelle borne. Aucune Server Action, aucun
 * `unstable_update`, aucun `redirect`.
 *
 * `replace` (pas `push`) : changer de période n'empile pas une entrée d'historique à
 * chaque clic (le « précédent » du navigateur reste la vraie page d'où l'on vient).
 * `scroll: false` : on ne remonte pas en haut sur un simple changement de filtre. On
 * PRÉSERVE les autres searchParams existants (hygiène) et on ne pose pas `?periode`
 * pour le défaut « 6m » (URL propre = comportement historique).
 *
 * Source de vérité = l'URL. On NORMALISE la valeur lue par la MÊME liste blanche que le
 * serveur (`normaliserPreset`) → l'état actif affiché correspond exactement à ce que la
 * page calcule (un `?periode` trafiqué retombe sur « 6m » des deux côtés).
 *
 * Tokens UI_GUIDELINES uniquement : segment actif en `primary`, JAMAIS vert/rouge
 * (réservés aux montants inflow/outflow). Groupe segmenté sur `surface-inset` (calque
 * visuel du déclencheur PerimetreSwitcher). Responsive : le groupe condense (libellés
 * courts), JAMAIS de `flex-wrap` sur le header.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  PRESETS_PERIODE,
  PRESET_DEFAUT,
  normaliserPreset,
  type PresetPeriode,
} from "@/lib/periode";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Libellés FR des presets (l'ordre suit PRESETS_PERIODE → ordre d'affichage stable). */
const LIBELLES: Record<PresetPeriode, string> = {
  "ce-mois": "Ce mois",
  "3m": "3 mois",
  "6m": "6 mois",
  "12m": "12 mois",
  tout: "Tout",
};

export function PeriodeSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Vérité serveur = l'URL, normalisée par la MÊME garde que la page (défaut 6m).
  const actif = normaliserPreset(searchParams.get("periode") ?? undefined);

  function choisir(preset: PresetPeriode) {
    if (preset === actif) return; // no-op (évite une navigation inutile)
    // Repart des searchParams existants pour ne pas perdre d'autres filtres éventuels.
    const params = new URLSearchParams(searchParams.toString());
    if (preset === PRESET_DEFAUT) {
      params.delete("periode"); // défaut → URL propre (pas de ?periode=6m)
    } else {
      params.set("periode", preset);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Période d'affichage"
      className="flex items-center gap-0.5 rounded-full bg-surface-inset p-0.5"
    >
      {PRESETS_PERIODE.map((preset) => {
        const estActif = preset === actif;
        return (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={estActif}
            onClick={() => choisir(preset)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              estActif
                ? "bg-primary text-text-onink"
                : "text-ink/70 hover:text-ink",
            )}
          >
            {LIBELLES[preset]}
          </button>
        );
      })}
    </div>
  );
}
