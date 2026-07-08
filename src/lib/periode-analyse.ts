/**
 * Presets de période de l'analyse par catégorie → bornes comptables Maurice
 * [from, to] (« YYYY-MM-DD »). SOURCE UNIQUE des presets (enum + libellés FR),
 * importable côté client (sélecteur) ET réutilisée côté serveur (Server Action)
 * pour dériver les bornes — le client n'envoie qu'un preset, jamais des dates
 * brutes (pas de fuseau client interpolé dans une borne comptable, E20).
 *
 * ⚠️ Fuseau (CLAUDE.md « Localisation & temps », non négociable) : on part de
 * `dateCouranteMaurice()` — la date comptable COURANTE À MAURICE (conversion
 * explicite Indian/Mauritius faite dans format-date.ts). L'arithmétique de bornes
 * (soustraction de jours / recul de mois) se fait ensuite sur cette date « nue »
 * en UTC : une fois la date Maurice obtenue, décaler des jours/mois est un calcul
 * CALENDAIRE pur, sans re-conversion de fuseau (lire les composantes en UTC
 * neutralise le fuseau du serveur). `maintenant` injectable → tests déterministes.
 *
 * Zéro dépendance (règle 9) : `Date` natif, aucune lib de dates.
 */
import { dateCouranteMaurice } from "./format-date";
import type { PeriodePresetParam } from "./insights-schema";

export interface BornesPeriode {
  /** Borne basse INCLUSIVE, date comptable Maurice « YYYY-MM-DD ». */
  from: string;
  /** Borne haute INCLUSIVE, date comptable Maurice « YYYY-MM-DD » (aujourd'hui). */
  to: string;
}

/** Ordre d'affichage des presets dans le sélecteur (source unique). */
export const PERIODES: readonly PeriodePresetParam[] = [
  "mois-courant",
  "30-jours",
  "90-jours",
  "12-mois",
] as const;

/** Libellés FR courts des presets (axes/segments denses). Source unique. */
export const LIBELLE_PERIODE: Record<PeriodePresetParam, string> = {
  "mois-courant": "Ce mois-ci",
  "30-jours": "30 jours",
  "90-jours": "90 jours",
  "12-mois": "12 mois",
};

/** Parse une date « nue » YYYY-MM-DD en instant UTC minuit (aucun décalage local). */
function enUtc(dateISO: string): Date {
  return new Date(`${dateISO}T00:00:00Z`);
}

/** Restitue « YYYY-MM-DD » depuis un instant (composantes lues en UTC). */
function versISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bornes [from, to] d'un preset, calculées à Maurice. `to` = aujourd'hui Maurice
 * (borne haute inclusive) ; `from` selon le preset :
 *   - mois-courant : 1er du mois courant Maurice
 *   - 30-jours     : aujourd'hui − 29 j (fenêtre glissante de 30 jours)
 *   - 90-jours     : aujourd'hui − 89 j
 *   - 12-mois      : 1er du mois, 11 mois en arrière (fenêtre de 12 mois)
 */
export function bornesPeriodeMaurice(
  preset: PeriodePresetParam,
  maintenant: Date = new Date(),
): BornesPeriode {
  const to = dateCouranteMaurice(maintenant); // « YYYY-MM-DD » Maurice
  const aujourdhui = enUtc(to);

  switch (preset) {
    case "mois-courant": {
      // 1er du mois de `to` — pas de new Date arithmétique (indexation de chaîne).
      const from = `${to.slice(0, 7)}-01`;
      return { from, to };
    }
    case "30-jours": {
      const d = enUtc(to);
      d.setUTCDate(d.getUTCDate() - 29);
      return { from: versISO(d), to };
    }
    case "90-jours": {
      const d = enUtc(to);
      d.setUTCDate(d.getUTCDate() - 89);
      return { from: versISO(d), to };
    }
    case "12-mois": {
      // 1er du mois, 11 mois en arrière. Date.UTC normalise le débordement de mois.
      const d = new Date(
        Date.UTC(aujourdhui.getUTCFullYear(), aujourdhui.getUTCMonth() - 11, 1),
      );
      return { from: versISO(d), to };
    }
    default: {
      // Exhaustivité : tout preset non couvert est une régression de type.
      const _exhaustif: never = preset;
      throw new Error(`preset de période inconnu : ${String(_exhaustif)}`);
    }
  }
}

/** Millisecondes dans une journée (arithmétique calendaire pure, dates « nues » UTC). */
const JOUR_MS = 24 * 60 * 60 * 1000;

/**
 * Fenêtre PRÉCÉDENTE (L4 variation) : fenêtre CONTIGUË de MÊME LONGUEUR (en jours)
 * finissant la VEILLE de `courant.from`. Règle UNIFORME pour tous les presets (baseline
 * glissante), volontairement ≠ « même mois calendaire » : un « 30 jours » se compare aux
 * 30 jours d'avant, un « mois-courant » de 8 jours se compare aux 8 jours précédents —
 * comparaison homogène en durée (pas d'artefact de mois court/long).
 *
 * Pure & testable (aucune horloge) : dérive uniquement des bornes reçues. Les bornes
 * étant INCLUSIVES des deux côtés, la longueur = (to − from) + 1 jour.
 */
export function bornesPeriodePrecedente(courant: BornesPeriode): BornesPeriode {
  const from = enUtc(courant.from);
  const to = enUtc(courant.to);
  // Longueur inclusive en jours (arrondi : garde-fou contre un éventuel résidu d'heure).
  const longueurJours = Math.round((to.getTime() - from.getTime()) / JOUR_MS) + 1;
  const precTo = new Date(from.getTime() - JOUR_MS); // veille de `from`
  const precFrom = new Date(precTo.getTime() - (longueurJours - 1) * JOUR_MS);
  return { from: versISO(precFrom), to: versISO(precTo) };
}
