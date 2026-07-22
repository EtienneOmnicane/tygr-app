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
 * `transaction_date` dérive de `BookingDateTime AT TIME ZONE 'Indian/Mauritius'`).
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

const FMT_MOIS_MAURICE = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  timeZone: FUSEAU_MAURICE,
});

const FMT_DATE_MAURICE = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: FUSEAU_MAURICE,
});

/**
 * Mois calendaire COURANT à l'Île Maurice (`YYYY-MM`). Conversion EXPLICITE vers
 * Indian/Mauritius (CLAUDE.md, non négociable) : un instant UTC du 31 à 22h tombe
 * le 1er du mois suivant à Maurice (+4h). `maintenant` injectable pour des tests
 * déterministes (défaut = now). en-CA donne « YYYY-MM-DD » → on garde « YYYY-MM ».
 */
export function moisCourantMaurice(maintenant: Date = new Date()): string {
  return FMT_MOIS_MAURICE.format(maintenant).slice(0, 7);
}

/**
 * Date calendaire COURANTE à l'Île Maurice (`YYYY-MM-DD`). Conversion EXPLICITE vers
 * Indian/Mauritius (CLAUDE.md « Localisation & temps », non négociable) : un instant
 * UTC du 8 juillet à 22h tombe le 9 à Maurice (+4h). Sert de « aujourd'hui » comptable
 * pour dériver le statut « en retard » d'une échéance et borner les horizons de
 * synthèse (30/60/90 j) — jamais une date « nue » comparée sans fuseau posé (E20).
 * `maintenant` injectable pour des tests déterministes (défaut = now). en-CA donne
 * directement « YYYY-MM-DD », comparable lexicographiquement à `date_echeance`.
 */
export function dateCouranteMaurice(maintenant: Date = new Date()): string {
  return FMT_DATE_MAURICE.format(maintenant);
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

// Abréviations FR NON AMBIGUËS (pas de troncature algorithmique : « Juin » et
// « Juillet » coupés à 3 lettres donnent tous deux « Jui » — deux mois consécutifs
// devenaient indistinguables sur l'axe du graphe de flux).
const MOIS_COURTS = [
  "Janv", "Févr", "Mars", "Avr", "Mai", "Juin",
  "Juil", "Août", "Sept", "Oct", "Nov", "Déc",
] as const;

/**
 * Formate un libellé de mois `YYYY-MM` en COURT « Juin 26 » (abréviation FR
 * non ambiguë + année sur 2 chiffres) — pour les axes de graphe denses où le mois
 * plein ne tient pas. L'année (2 chiffres) lève l'ambiguïté entre deux mois homonymes
 * d'années différentes (deux « Janv » sur l'axe) ; la table `MOIS_COURTS` lève celle
 * entre mois d'une même année (Juin/Juil). Aucun parser ni `new Date` (pas de fuseau).
 * Entrée hors forme `YYYY-MM` → restituée telle quelle (défense).
 */
export function formaterMoisCourt(libelleMois: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(libelleMois);
  if (!m) return libelleMois;
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx >= 12) return libelleMois;
  return `${MOIS_COURTS[idx]} ${m[1].slice(2)}`;
}

/**
 * Libellé FR d'un INTERVALLE de dates comptables « nues » : « 3 mars → 17 avr. 2026 ».
 * Sert de libellé de période quand une PLAGE PRÉCISE (`?du`/`?au`) borne l'écran — là où
 * un preset dirait « 6 derniers mois » (TOOLBAR-DATE-PRECISE1). SOURCE UNIQUE de ce
 * libellé (dette C8 : aucune concaténation de dates maison dans un composant).
 *
 * L'année n'est portée QUE par la borne haute quand les deux bornes tombent la même année
 * (« 3 mars → 17 avr. 2026 ») — sinon les deux la portent (« 12 déc. 2025 → 8 janv. 2026 »),
 * car un intervalle à cheval sur deux années serait sinon ambigu. Réutilise les formateurs
 * du module (aucun `new Date` supplémentaire, donc aucun risque de fuseau).
 */
export function formaterIntervalleComptable(du: string, au: string): string {
  if (!estDateISO(du) || !estDateISO(au)) return `${du} → ${au}`; // défense : on n'invente pas
  const memeAnnee = du.slice(0, 4) === au.slice(0, 4);
  const debut = memeAnnee ? formaterDateComptable(du) : formaterDateComptableLongue(du);
  return `${debut} → ${formaterDateComptableLongue(au)}`;
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
 * absolu (tooltip) est converti à Maurice (`Indian/Mauritius`, UTC+4 — cf.
 * `FUSEAU_MAURICE` ; surtout PAS « Asia/Port_Louis » qui lève RangeError).
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
