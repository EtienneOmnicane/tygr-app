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
