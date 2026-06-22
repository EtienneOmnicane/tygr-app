/**
 * Formatage d'AFFICHAGE des dates comptables (colonne Date de /transactions,
 * méta du solde, en-têtes de synthèse). SOURCE UNIQUE de formatage de date
 * d'affichage (CLAUDE.md « Formatage des données financières » — dette C8 :
 * plus aucune redéfinition locale de noms de mois / découpe ad-hoc dans un
 * composant).
 *
 * ⚠️ Distinction cruciale (CLAUDE.md « Localisation & temps ») : ce module ne fait
 * AUCUNE conversion de fuseau. Il reçoit une date au format `YYYY-MM-DD` (ou un
 * libellé `YYYY-MM`) DÉJÀ calculée à Maurice par le Backend (E20 :
 * `transaction_date` dérive de `BookingDateTime AT TIME ZONE 'Asia/Port_Louis'`).
 * La date est « nue » (date comptable Maurice), on la met juste en forme pour
 * l'œil — on ne la compare pas, on ne la décale pas.
 *
 * Piège évité : `new Date("2026-06-11")` est parsé en UTC minuit ; un
 * `toLocaleDateString` dans le fuseau du navigateur afficherait potentiellement la
 * VEILLE. On lit donc les composantes en `timeZone: "UTC"` pour neutraliser le
 * fuseau local et restituer fidèlement la date comptable telle quelle.
 *
 * Zéro dépendance (règle 9) : `Intl.DateTimeFormat` natif, locale fr.
 */

const FMT_JOUR_MOIS = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const FMT_JOUR_MOIS_AN = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const FMT_DATE_NUMERIQUE = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

// Noms de mois pleins (libellé "Juin 2026") — un seul endroit, plus de
// redéfinition locale dans les composants (dette C8, CLAUDE.md « Formatage »).
const MOIS_PLEINS = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
] as const;

// Horodatage ABSOLU Maurice (tooltip de fraîcheur) : « 12/06/2026 12:00 ».
// Contrairement aux dates comptables « nues », ici on convertit EXPLICITEMENT un
// instant (TIMESTAMPTZ lastSyncedAt) vers le fuseau de Maurice (CLAUDE.md
// Localisation). ⚠️ L'identifiant IANA correct est « Indian/Mauritius » (UTC+4) :
// « Asia/Port_Louis » (écrit dans CLAUDE.md / l'en-tête historique) N'EXISTE PAS et
// fait planter `Intl` (RangeError). Dette doc remontée (voir TODOS TZ-DOC1).
const FUSEAU_MAURICE = "Indian/Mauritius";

const FMT_HORODATAGE_MAURICE = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: FUSEAU_MAURICE,
});

const RTF_FR = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });

/** Niveau de fraîcheur du solde (mappé aux tokens §3.7). */
export type NiveauFraicheur = "frais" | "recent" | "perime";

export interface Fraicheur {
  /** frais <6h (success) · recent <24h (warning) · perime ≥24h (danger). */
  niveau: NiveauFraicheur;
  /** Libellé relatif FR : « il y a 2 h », « hier », « il y a 3 j ». */
  libelle: string;
  /** Horodatage absolu Maurice pour le tooltip : « 12/06/2026 à 08:00 ». */
  horodatageAbsolu: string;
}

const SIX_HEURES_MS = 6 * 3_600_000;
const VINGT_QUATRE_HEURES_MS = 24 * 3_600_000;

/** Vrai si la chaîne est une date `YYYY-MM-DD` plausible (forme stricte). */
export function estDateISO(valeur: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valeur)) return false;
  const d = new Date(`${valeur}T00:00:00Z`);
  // Rejette les dates « roulées » (ex. 2026-02-30 → 2026-03-02).
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valeur;
}

/**
 * Formate une date comptable « nue » `YYYY-MM-DD` en « 11 juin » (jour + mois court).
 * Retourne la chaîne d'entrée telle quelle si elle n'est pas une date valide
 * (affichage défensif — on n'invente pas de date).
 */
export function formaterDateComptable(transactionDate: string): string {
  if (!estDateISO(transactionDate)) return transactionDate;
  return FMT_JOUR_MOIS.format(new Date(`${transactionDate}T00:00:00Z`));
}

/**
 * Variante avec l'année (« 11 juin 2026 ») — pour les contextes où l'année n'est
 * pas évidente (ex. tooltip, en-tête de groupe). Même garde défensive.
 */
export function formaterDateComptableLongue(transactionDate: string): string {
  if (!estDateISO(transactionDate)) return transactionDate;
  return FMT_JOUR_MOIS_AN.format(new Date(`${transactionDate}T00:00:00Z`));
}

/**
 * Formate une date « nue » `YYYY-MM-DD` en numérique court FR « 12/06/2026 »
 * (méta du solde, en-têtes compacts). Même garde fuseau (lecture UTC) et même
 * défense que les autres : entrée invalide → restituée telle quelle.
 */
export function formaterDateCourteNumerique(transactionDate: string): string {
  if (!estDateISO(transactionDate)) return transactionDate;
  return FMT_DATE_NUMERIQUE.format(new Date(`${transactionDate}T00:00:00Z`));
}

/**
 * Formate un libellé de mois `YYYY-MM` en « Juin 2026 » (en-tête de synthèse
 * mensuelle). Entrée hors forme `YYYY-MM` (ou mois hors 01..12) → restituée
 * telle quelle (défense). Pas de `new Date` : on indexe la table de mois, donc
 * aucun risque de décalage de fuseau.
 */
export function formaterMoisAnnee(libelleMois: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(libelleMois);
  if (!m) return libelleMois;
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx >= 12) return libelleMois;
  return `${MOIS_PLEINS[idx]} ${m[1]}`;
}

/**
 * Fraîcheur d'un solde COURANT à partir de sa dernière synchro `lastSyncedAt`
 * (UI_GUIDELINES §3.7 — pastille success/warning/danger). C'est la VRAIE réponse à
 * DR-F3 : on qualifie l'âge de la donnée instantanée, on n'affiche JAMAIS un EOD de
 * courbe comme « date du solde ».
 *
 * Seuils : <6h → `frais` (vert) · <24h → `recent` (ambre) · ≥24h → `perime` (rouge,
 * CTA Reconnecter côté UI). Le libellé relatif (« il y a 2 h ») sort de
 * `Intl.RelativeTimeFormat` (locale fr, zéro dépendance — règle 9). L'horodatage
 * absolu (tooltip) est converti à Maurice (Asia/Port_Louis, CLAUDE.md Localisation).
 *
 * `maintenant` est injectable pour des tests déterministes (pas de mock de Date
 * global). Un delta négatif (horloge client en avance sur le serveur) est borné à 0
 * → « à l'instant », jamais « dans 2 h ».
 */
export function formaterFraicheurRelative(
  derniereSynchro: Date,
  maintenant: Date = new Date(),
): Fraicheur {
  const deltaMs = Math.max(0, maintenant.getTime() - derniereSynchro.getTime());

  const niveau: NiveauFraicheur =
    deltaMs < SIX_HEURES_MS
      ? "frais"
      : deltaMs < VINGT_QUATRE_HEURES_MS
        ? "recent"
        : "perime";

  const heures = Math.floor(deltaMs / 3_600_000);
  const libelle =
    heures < 1
      ? "à l’instant"
      : heures < 24
        ? RTF_FR.format(-heures, "hour")
        : RTF_FR.format(-Math.floor(heures / 24), "day");

  return {
    niveau,
    libelle,
    horodatageAbsolu: FMT_HORODATAGE_MAURICE.format(derniereSynchro),
  };
}
