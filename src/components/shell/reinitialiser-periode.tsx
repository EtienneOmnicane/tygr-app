"use client";

/**
 * ReinitialiserPeriode — bouton « Réinitialiser la période » de la barre de vue
 * (TX/DASH-PERIODE-PERSIST1). Ramène le GROUPE période ENTIER au défaut « 6 mois » : efface
 * `?periode`/`?du`/`?au` de l'URL en UNE action, tout en PRÉSERVANT les autres params (ex. la
 * recherche `?q` de /transactions).
 *
 * DISTINCT du « × » du `PlageDatesSwitcher` : celui-là n'efface que la PLAGE (`?du`/`?au`) et
 * rend la main au preset ; ce bouton-ci ramène TOUT au défaut (preset compris). Les deux
 * coexistent — portes de sortie complémentaires.
 *
 * CANAL = searchParams (comme les switchers), PAS le JWT : la période est un filtre de
 * LECTURE. `router.replace` (pas `push` : un reset de filtre n'empile pas d'historique) +
 * `scroll: false` (on ne remonte pas en haut) + autres params préservés (`retirerPeriodeQuery`).
 *
 * VISIBILITÉ : uniquement HORS défaut (`estHorsDefautPeriode` — source unique, MÊMES gardes
 * que le serveur : `lirePlage` + `normaliserPreset`), sinon `null` (pas de bouton leurre :
 * rien à réinitialiser). Un `?periode`/`?du` forgé ou dupliqué retombe au défaut → pas de bouton.
 *
 * Style NEUTRE `text-muted` — c'est une action neutre, JAMAIS `inflow`/`outflow` (réservés aux
 * montants) ni le rouge `danger` (réservé aux erreurs). Tokens sémantiques uniquement, pas de
 * `flex-wrap` (règle UI : condenser le header).
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { retirerPeriodeQuery } from "@/components/shell/nav-periode";
import { estHorsDefautPeriode, paramsPeriodeDepuisURL } from "@/lib/periode";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function ReinitialiserPeriode() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Vérité = l'URL, lue par les MÊMES helpers que le serveur : `paramsPeriodeDepuisURL` gère le
  // param dupliqué (pas de `.get()` maison), puis `estHorsDefautPeriode` juge (réutilise
  // lirePlage + normaliserPreset). Au défaut → on ne rend rien.
  const horsDefaut = estHorsDefautPeriode(paramsPeriodeDepuisURL(searchParams));
  if (!horsDefaut) return null;

  function reinitialiser() {
    const query = retirerPeriodeQuery(searchParams);
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <button
      type="button"
      onClick={reinitialiser}
      title="Revenir à la période par défaut (6 mois)"
      className={cn(
        "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
        "text-text-muted transition-colors hover:bg-surface-inset hover:text-ink",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
      )}
    >
      Réinitialiser la période
    </button>
  );
}
