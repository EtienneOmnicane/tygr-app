"use client";

/**
 * PlageDatesSwitcher — sélecteur de PLAGE DE DATES PRÉCISE (`?du` / `?au`) de la barre
 * de vue (lot A1, TOOLBAR-DATE-PRECISE1 ; plan `PLAN-toolbar-date-precise.md`). Vit à
 * côté du `PeriodeSwitcher`, dont il COMPLÈTE les presets : « du 3 mars au 17 avril »
 * (rapprochement, clôture, contrôle d'un relevé) n'est pas exprimable en presets.
 *
 * CANAL = searchParams, comme `PeriodeSwitcher` (et PAS le JWT, ≠ PerimetreSwitcher qui
 * touche la RLS) : une plage est un simple filtre de LECTURE. Aucun appel serveur ici —
 * on écrit l'URL par `router.replace` (`scroll: false`, autres params PRÉSERVÉS), ce qui
 * re-rend le RSC avec les nouvelles bornes.
 *
 * ⚠️ PRIORITÉ — une plage valide PRIME sur le preset (règle du lot, tenue côté serveur
 * par `resoudrePeriode`). L'UI doit le DIRE, sinon elle ment à l'échelle du contrôle :
 *   - le `PeriodeSwitcher` n'allume AUCUN segment tant qu'une plage est active (il lit
 *     le même `lirePlage`) ;
 *   - ce contrôle-ci porte alors l'état actif (bordure `primary`) et un bouton « × » qui
 *     efface la plage et rend la main au preset.
 *
 * ⚠️ VALIDATION — jamais réimplémentée ici : `lirePlage` (lib/periode.ts) est la SOURCE
 * UNIQUE, partagée avec le serveur. Un composant qui validerait des dates dans son coin
 * pourrait diverger de ce que la page filtre réellement — c'est précisément le bug de
 * classe A2/A4. Idem pour la découpe/lecture de dates : aucun parsing maison
 * (CLAUDE.md § Formatage — `format-date.ts` est la seule source).
 *
 * Tokens sémantiques uniquement (jamais de vert/rouge : réservés aux montants
 * inflow/outflow). Pas de `flex-wrap` sur le header (règle UI : condenser, jamais wrapper).
 */
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { dateCouranteMaurice } from "@/lib/format-date";
import {
  lirePlage,
  paramsPeriodeDepuisURL,
  PLANCHER_HISTORIQUE,
  type PlageExplicite,
} from "@/lib/periode";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function PlageDatesSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // VÉRITÉ = l'URL, lue et validée par les MÊMES fonctions que le serveur
  // (`paramsPeriodeDepuisURL` + `lirePlage`) — y compris pour un param DUPLIQUÉ, que les
  // deux côtés doivent rejeter de la même façon (sinon le contrôle s'allume sur une plage
  // que la page ignore).
  const plage = lirePlage(paramsPeriodeDepuisURL(searchParams));

  // BROUILLON de saisie : les deux champs se remplissent l'un après l'autre, et on ne
  // COMMET dans l'URL qu'une paire COMPLÈTE ET VALIDE (écrire `?du` seul ferait replier le
  // serveur sur le preset pendant que le champ afficherait une date). Le brouillon peut
  // donc diverger TRANSITOIREMENT de l'URL pendant l'édition — c'est le comportement normal
  // d'un filtre de plage (on applique quand c'est cohérent), pas le « mensonge » que le lot
  // combat (lequel est STRUCTUREL : un contrôle qui ne peut JAMAIS filtrer).
  const [du, setDu] = useState(plage?.du ?? "");
  const [au, setAu] = useState(plage?.au ?? "");

  // Re-synchronisation quand l'URL change SOUS NOS PIEDS — mais UNIQUEMENT si le changement
  // est EXTERNE (clic sur un preset, retour navigateur, lien collé) : quand c'est NOUS qui
  // venons d'écrire, le brouillon est déjà la vérité et l'écraser effacerait la borne que
  // l'utilisateur est en train de composer. D'où le témoin `dernierEcrit`.
  //
  // Ajustement d'état PENDANT LE RENDU (motif React officiel), et surtout PAS :
  //   - un `setState` dans un effet → interdit (lint `react-hooks/set-state-in-effect`) ;
  //   - un remount par `key` → il REMPLACERAIT le <input> à chaque écriture d'URL, donc à
  //     chaque frappe validante : le champ perdrait le FOCUS au milieu de l'édition (éditer
  //     le jour d'une date complète écrit l'URL → remount → focus perdu avant le mois).
  // `dernierEcrit` est un ÉTAT et non une `ref` : lire une ref pendant le rendu est interdit
  // (lint `react-hooks/refs` — une ref n'est pas une source de vérité de rendu). Un état, si.
  const cleUrl = `${plage?.du ?? ""}|${plage?.au ?? ""}`;
  const [dernierEcrit, setDernierEcrit] = useState<string | null>(null);
  const [cleUrlPrecedente, setCleUrlPrecedente] = useState(cleUrl);
  if (cleUrl !== cleUrlPrecedente) {
    setCleUrlPrecedente(cleUrl);
    const resync = resyncDepuisUrl(cleUrl, dernierEcrit, plage);
    if (resync) {
      setDu(resync.du);
      setAu(resync.au);
    }
  }

  const active = plage !== null;

  // Paire COMPLÈTE mais refusée par la garde (typiquement `du > au` tapé au clavier : le
  // picker natif l'empêche via min/max, la saisie manuelle non). On n'écrit pas — et on le
  // DIT (`aria-invalid`), sinon le champ afficherait une plage qui ne filtre pas.
  const saisieInvalide = du !== "" && au !== "" && lirePlage({ du, au }) === null;

  /** Écrit (ou efface) `?du`/`?au` en PRÉSERVANT les autres params (hygiène). */
  function ecrire(nouvelle: PlageExplicite | null) {
    // Mémorise CE QU'ON ÉCRIT pour ne pas prendre notre propre écriture pour un changement
    // externe (et donc écraser le brouillon en cours de saisie).
    setDernierEcrit(nouvelle ? `${nouvelle.du}|${nouvelle.au}` : "|");
    const query = parametresPlage(searchParams.toString(), nouvelle).toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  /**
   * Applique le brouillon, en passant par la MÊME garde que le serveur (`lirePlage` :
   * dates réelles, du ≤ au, amplitude bornée, plancher).
   *
   * ⚠️ Si la paire n'est PAS exploitable (une borne vidée, ou `du > au` tapé au clavier) et
   * qu'une plage filtre ENCORE dans l'URL, on la LÈVE. Ne rien faire serait le piège relevé
   * en cross-review : le champ « du » vidé, la bordure toujours active — et le serveur qui
   * continue de filtrer sur l'ancienne plage. L'utilisateur croirait avoir retiré la borne.
   * Lever la plage rallume le preset : ce qu'on VOIT redevient ce qui FILTRE. La saisie reste
   * dans les champs (le témoin `dernierEcrit` empêche de l'effacer), donc compléter la paire
   * la ré-applique aussitôt.
   */
  function appliquer(prochainDu: string, prochainAu: string) {
    const valide = lirePlage({ du: prochainDu, au: prochainAu });
    if (valide) {
      ecrire(valide);
      return;
    }
    if (plage) ecrire(null);
  }

  /**
   * Geste « × » : effacement VOLONTAIRE de la plage. Contrairement à l'édition en cours
   * (protégée par `dernierEcrit`), ce geste DOIT forcer le vidage des DEUX champs. Sinon
   * l'URL se nettoie (preset rallumé) mais les `<input>` gardent l'ancienne plage : la
   * resynchro plus haut prend ce nettoyage pour notre propre écriture (`cleUrl === dernierEcrit
   * === "|"` via `resyncDepuisUrl`) et n'y touche pas. On vide donc le brouillon ICI, en plus
   * d'effacer l'URL. Le garde-fou reste intact — il ne protège que l'ÉDITION, pas ce geste.
   */
  function effacerTout() {
    setDu("");
    setAu("");
    ecrire(null);
  }

  // Bornes natives du navigateur : elles EMPÊCHENT de composer une plage inversée dans le
  // sélecteur (même motif que `transactions-toolbar.tsx`). La vraie garde reste `lirePlage`
  // (côté serveur ET ici) : le natif guide, il ne protège pas.
  //
  // `max` du champ « au » = AUJOURD'HUI À MAURICE (conversion explicite, CLAUDE.md) et
  // surtout PAS le `new Date()` du navigateur : à 21 h à Paris, Maurice est déjà le
  // lendemain — la date comptable sélectionnable doit suivre Maurice, pas le poste client.
  // `suppressHydrationWarning` : cet attribut dérive de l'horloge ; serveur et client
  // peuvent tomber de part et d'autre de minuit à Maurice (fenêtre de quelques ms).
  const aujourdhui = dateCouranteMaurice();

  return (
    <div
      role="group"
      aria-label="Plage de dates précise"
      className={cn(
        // CONDENSATION (règle UI : condenser sous le breakpoint, JAMAIS `flex-wrap` sur le
        // header) : ce contrôle ajoute ~280 px à une barre qui porte déjà les presets, le
        // périmètre et le CTA. Sous `lg` il s'efface — les presets, eux, restent : on ne perd
        // pas la capacité de borner l'écran, seulement la saisie au jour (outil d'analyste).
        "hidden shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 transition-colors lg:flex",
        // Saisie refusée (du > au tapé au clavier) : on le SIGNALE, on ne l'applique pas.
        // `danger` est ici un état d'ERREUR de saisie (UI_GUIDELINES §3.4), pas une donnée —
        // le rouge « réservé aux montants » vise les VALEURS (outflow), pas la validation.
        saisieInvalide
          ? "border-danger bg-danger-bg"
          : active
            ? "border-primary bg-primary-50"
            : "border-line bg-surface-card hover:border-line-strong",
      )}
    >
      <input
        type="date"
        aria-label="Début de la plage (du)"
        aria-invalid={saisieInvalide || undefined}
        value={du}
        min={PLANCHER_HISTORIQUE}
        max={au || aujourdhui}
        suppressHydrationWarning
        onChange={(e) => {
          setDu(e.target.value);
          appliquer(e.target.value, au);
        }}
        className={cn(
          "w-[118px] bg-transparent px-1 py-0.5 text-xs text-ink tabular-nums",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        )}
      />

      <span aria-hidden className="text-xs text-text-muted">
        –
      </span>

      <input
        type="date"
        aria-label="Fin de la plage (au)"
        aria-invalid={saisieInvalide || undefined}
        value={au}
        min={du || PLANCHER_HISTORIQUE}
        max={aujourdhui}
        suppressHydrationWarning
        onChange={(e) => {
          setAu(e.target.value);
          appliquer(du, e.target.value);
        }}
        className={cn(
          "w-[118px] bg-transparent px-1 py-0.5 text-xs text-ink tabular-nums",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        )}
      />

      {/* Sortie de plage : rend la main au preset (le PeriodeSwitcher se rallume). Monté
          UNIQUEMENT quand une plage filtre réellement — un « × » inerte serait un leurre.
          (2ᵉ porte de sortie : cliquer un preset efface aussi la plage.) */}
      {active && (
        <button
          type="button"
          onClick={effacerTout}
          aria-label="Effacer la plage de dates et revenir aux périodes prédéfinies"
          title="Effacer la plage"
          className={cn(
            // Cible ≥24px (`h-6 w-6`) : le « × » doit se viser sans précision au pixel (le
            // `h-5 w-5` précédent était trop petit). Glyphe `text-sm leading-none` (plus
            // lisible que `text-xs`), centré dans la pastille. `shrink-0` : jamais compressé.
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm leading-none",
            "text-text-muted transition-colors hover:bg-surface-inset hover:text-ink",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          )}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Décide, à un changement de la clé d'URL, si les champs doivent se RÉALIGNER sur l'URL.
 * Extrait PUR — testable sans renderer React (pattern du projet, cf. `machine-mfa.ts`) :
 *   - `cleUrl === dernierEcrit` → c'est NOTRE propre écriture : on ne réaligne pas, sinon on
 *     écraserait le brouillon que l'utilisateur compose (perte de la borne en cours) → `null`.
 *   - sinon (preset cliqué, retour navigateur, lien collé) → réaligner sur l'URL.
 * ⚠️ Corollaire : après un effacement volontaire (« × »), `cleUrl === "|" === dernierEcrit`
 * → retourne `null`. C'est pourquoi le handler « × » (`effacerTout`) vide les champs LUI-MÊME :
 * la resynchro ne le fera pas (c'est le bug PLAGE-DATES-RESET-UX1).
 */
export function resyncDepuisUrl(
  cleUrl: string,
  dernierEcrit: string | null,
  plage: PlageExplicite | null,
): { du: string; au: string } | null {
  if (cleUrl === dernierEcrit) return null;
  return { du: plage?.du ?? "", au: plage?.au ?? "" };
}

/**
 * Construit les `searchParams` PROCHAINS en posant (`nouvelle`) ou retirant (`null`) `du`/`au`,
 * tous les AUTRES params préservés (hygiène — ce contrôle ne possède que `?du`/`?au`). Extrait
 * de `ecrire` pour être testable : après un reset, l'URL ne doit plus porter `du`/`au`.
 */
export function parametresPlage(
  baseQuery: string,
  nouvelle: PlageExplicite | null,
): URLSearchParams {
  const params = new URLSearchParams(baseQuery);
  if (nouvelle) {
    params.set("du", nouvelle.du);
    params.set("au", nouvelle.au);
  } else {
    params.delete("du");
    params.delete("au");
  }
  return params;
}
