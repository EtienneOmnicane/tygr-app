/**
 * Calcul des BORNES de période du dashboard (chantier L8c — sélecteur de période).
 *
 * Distinct de `format-date.ts` (qui fait du FORMATAGE d'AFFICHAGE) : ici on CALCULE
 * des bornes de date pour filtrer les lectures (jamais d'affichage). Source UNIQUE de
 * ce calcul (CLAUDE.md « Formatage des données financières », dette C8 : pas de
 * redéfinition locale de découpe/recul de date dans un composant ou une page). Les
 * helpers étaient à l'origine privés à `(dashboard)/page.tsx` ; promus ici car C1
 * (mapping preset) les réutilise — copier aurait violé la source unique.
 *
 * FUSEAU (CLAUDE.md « Localisation & temps », non négociable) : « aujourd'hui » à
 * Maurice se calcule par conversion EXPLICITE vers `Indian/Mauritius` (UTC+4) via
 * `Intl` (même approche que `moisCourantMaurice`), PAS par un « +4h » manuel : on
 * raisonne en date calendaire Maurice, jamais en date « nue » décalée à la main.
 * (Maurice n'a pas de DST, mais l'IANA est la convention du repo et reste correcte si
 * la règle changeait.) ⚠️ L'identifiant correct est `Indian/Mauritius` ; « Asia/
 * Port_Louis » N'EXISTE PAS et fait planter `Intl` (cf. format-date.ts).
 *
 * Le mapping preset→bornes est PUR (aucun accès DB) et NORMALISE toute valeur d'URL
 * inconnue vers le défaut `6m` (liste blanche stricte) : la valeur brute de `?periode`
 * ne touche JAMAIS le SQL — elle est traduite ici en `nbMois`/dates typées (défense en
 * profondeur ; la vraie barrière reste l'argument typé passé aux repos déjà bordés).
 */

/** Fuseau de l'Île Maurice (UTC+4). IANA correct — surtout pas « Asia/Port_Louis ». */
const FUSEAU_MAURICE = "Indian/Mauritius";

/** « YYYY-MM-DD » à Maurice. en-CA produit déjà ce format ISO. */
const FMT_JOUR_MAURICE = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: FUSEAU_MAURICE,
});

/** Première partition de `transactions_cache` (migration 0003) : plancher du preset « tout ». */
export const PLANCHER_HISTORIQUE = "2024-01-01";

/** Identifiants de preset acceptés (liste blanche stricte — toute autre valeur → défaut). */
export const PRESETS_PERIODE = ["ce-mois", "3m", "6m", "12m", "tout"] as const;
export type PresetPeriode = (typeof PRESETS_PERIODE)[number];

/** Preset par défaut = comportement historique (NB_MOIS_HISTORIQUE=6) → zéro régression. */
export const PRESET_DEFAUT: PresetPeriode = "6m";

/**
 * Bornes résolues d'une période, prêtes à passer aux repos.
 * - `nbMois` : fenêtre de tendance (≥ 1). Pour « tout », c'est le nb de mois entre
 *   le plancher historique et le mois courant (syntheseParMois exige nbMois ≥ 1).
 * - `from`/`to` : dates comptables Maurice « YYYY-MM-DD » INCLUSIVES (contrat des repos).
 * - `moisAncrage` : « YYYY-MM » du mois courant (ancre de grilleMois + libellé d'en-tête).
 * - `preset` : l'identifiant normalisé réellement appliqué (pour l'UI / l'état actif).
 */
export interface BornesPeriode {
  preset: PresetPeriode;
  nbMois: number;
  from: string;
  to: string;
  moisAncrage: string;
}

/** Date du jour à Maurice « YYYY-MM-DD ». `maintenant` injectable (tests déterministes). */
export function aujourdhuiMaurice(maintenant: Date = new Date()): string {
  return FMT_JOUR_MAURICE.format(maintenant);
}

/**
 * Premier jour (« YYYY-MM-DD ») du mois obtenu en reculant de `recul` mois depuis
 * `mois` (« YYYY-MM »). Calcul PUR sur les composantes (pas de fuseau : on raisonne en
 * mois calendaires Maurice, déjà portés par `mois`). `Date.UTC` normalise les
 * débordements d'année. Ex. ("2026-06", 5) → "2026-01-01".
 */
export function premierJourMoisRecul(mois: string, recul: number): string {
  const [a, m] = mois.split("-").map(Number);
  const d = new Date(Date.UTC(a, m - 1 - recul, 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Nombre de mois (≥ 1) entre le mois de `dateDebut` (« YYYY-MM-DD ») et `moisFin`
 * (« YYYY-MM »), bornes INCLUSES. Sert au preset « tout » : combien de mois de tendance
 * couvrir entre le plancher historique et le mois courant. Arithmétique entière sur
 * année/mois (pas de fuseau). Borné à ≥ 1 (syntheseParMois refuse 0).
 * Ex. ("2024-01-01", "2026-06") → 30.
 */
export function nbMoisEntre(dateDebut: string, moisFin: string): number {
  const [aD, mD] = dateDebut.split("-").map(Number);
  const [aF, mF] = moisFin.split("-").map(Number);
  return Math.max(1, (aF - aD) * 12 + (mF - mD) + 1);
}

/**
 * Normalise une valeur de `?periode` (string | string[] | undefined) vers un preset
 * connu. Toute valeur hors liste blanche (inconnue, absente, tableau, casse/espaces)
 * → `PRESET_DEFAUT` (« 6m »). CONTRAT STRICT : pas de tolérance de casse/espaces
 * (« 6M », « 6m » avec espaces → défaut) ; l'URL est forgée par notre UI, on n'accepte
 * que les valeurs exactes. C'est la garde de non-régression + anti-injection.
 */
export function normaliserPreset(
  valeur: string | string[] | undefined,
): PresetPeriode {
  if (typeof valeur !== "string") return PRESET_DEFAUT;
  return (PRESETS_PERIODE as readonly string[]).includes(valeur)
    ? (valeur as PresetPeriode)
    : PRESET_DEFAUT;
}

/** Nombre de mois de fenêtre par preset borné (« tout » est traité à part). */
const NB_MOIS_PAR_PRESET: Record<Exclude<PresetPeriode, "tout">, number> = {
  "ce-mois": 1,
  "3m": 3,
  "6m": 6,
  "12m": 12,
};

/**
 * Résout les bornes d'une période à partir de la valeur brute de `?periode`.
 * PUR : aucun accès DB. L'ancre temporelle passe TOUJOURS par `aujourdhuiMaurice`
 * (injectable) — jamais un `new Date()` nu comparé sans fuseau (CLAUDE.md).
 *
 * - presets bornés (ce-mois/3m/6m/12m) : `from` = 1er jour du mois reculé de
 *   (nbMois − 1), `to` = aujourd'hui.
 * - « tout » : `from` = PLANCHER_HISTORIQUE ("2024-01-01", début 1re partition —
 *   OPTION 1 du plan, on ne touche PAS la signature de cashflowParDevise), `to` =
 *   aujourd'hui, `nbMois` = nb de mois entre le plancher et le mois courant (≥ 1).
 *   Le filtre reste sur transaction_date → pruning des partitions préservé.
 *
 * Invariant garanti : `from ≤ to` (satisfait la validation d'insights.ts) et
 * `nbMois ≥ 1` (satisfait syntheseParMois).
 */
export function resoudrePeriode(
  valeur: string | string[] | undefined,
  maintenant: Date = new Date(),
): BornesPeriode {
  const preset = normaliserPreset(valeur);
  const to = aujourdhuiMaurice(maintenant);
  const moisAncrage = to.slice(0, 7);

  if (preset === "tout") {
    return {
      preset,
      from: PLANCHER_HISTORIQUE,
      to,
      moisAncrage,
      nbMois: nbMoisEntre(PLANCHER_HISTORIQUE, moisAncrage),
    };
  }

  const nbMois = NB_MOIS_PAR_PRESET[preset];
  return {
    preset,
    from: premierJourMoisRecul(moisAncrage, nbMois - 1),
    to,
    moisAncrage,
    nbMois,
  };
}
