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
 * ⚠️ PLAGE EXPLICITE (lot A1) — `?du`/`?au` PRIMENT sur le preset côté serveur
 * (`resoudrePeriode`). Conséquence NON NÉGOCIABLE ici : tant qu'une plage valide est
 * active, ce groupe n'allume AUCUN segment (`actif = null`). Laisser « 6 mois » allumé
 * pendant qu'une plage de mars filtre la page serait le mensonge d'affichage que tout ce
 * chantier combat — à l'échelle du contrôle. On lit la plage par le MÊME `lirePlage` que
 * le serveur (source unique) : les deux ne peuvent pas diverger.
 * Cliquer un preset EFFACE la plage (porte de sortie ; l'autre est le « × » du
 * `PlageDatesSwitcher`).
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
  lirePlage,
  normaliserPreset,
  paramsPeriodeDepuisURL,
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

  // Une plage explicite VALIDE prime → AUCUN preset ne s'applique : `actif = null`, donc
  // aucun segment allumé (le `PlageDatesSwitcher` porte l'état actif). Sinon : vérité =
  // l'URL, normalisée par la MÊME garde que la page (défaut 6m).
  // `paramsPeriodeDepuisURL` (et pas des `.get()` à la main) : un param DUPLIQUÉ doit être
  // vu comme un tableau — donc REJETÉ — exactement comme côté serveur. Sinon `?du=X&du=Y`
  // allumerait le contrôle sur une plage que la page, elle, ignore (divergence UI/serveur).
  const params = paramsPeriodeDepuisURL(searchParams);
  const plage = lirePlage(params);
  const actif: PresetPeriode | null = plage
    ? null
    : normaliserPreset(params.periode);

  function choisir(preset: PresetPeriode) {
    if (preset === actif) return; // no-op (évite une navigation inutile)
    // Repart des searchParams existants pour ne pas perdre d'autres filtres éventuels.
    const params = new URLSearchParams(searchParams.toString());
    // Choisir un preset SORT de la plage explicite (sinon la plage continuerait de primer
    // et le clic n'aurait aucun effet visible : un bouton mort). `actif` valant null sous
    // plage, on ne peut pas court-circuiter au-dessus — le clic passe toujours ici.
    params.delete("du");
    params.delete("au");
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
