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
 *
 * PLAGE EXPLICITE (TOOLBAR-DATE-PRECISE1, lot A1) : `?du`/`?au` PRIMENT sur `?periode`.
 * La règle de priorité vit ICI, dans une fonction pure qui possède TOUT le contrat
 * d'URL (d'où `resoudrePeriode(searchParams)` — l'objet entier, pas le seul `?periode`) :
 * une page ne doit pas pouvoir câbler la moitié du contrat et mentir sur l'autre.
 *
 * ⚠️ FUSEAU — les deux chemins n'ont PAS le même besoin, et c'est VOULU :
 *   - chemin PRESET : dérive « aujourd'hui » d'un INSTANT → conversion EXPLICITE
 *     `Indian/Mauritius` obligatoire (`aujourdhuiMaurice`), cf. règle CLAUDE.md.
 *   - chemin PLAGE : ne touche AUCUN instant. `du`/`au` sont des DATES COMPTABLES
 *     MAURICE saisies telles quelles (un `<input type="date">` n'a pas de fuseau),
 *     comparées à `transaction_date` qui EST déjà la date Maurice (E20). Il n'y a donc
 *     rien à convertir — et surtout rien à décaler « de +4h » à la main. La règle
 *     « jamais de date nue » interdit de dériver un JOUR depuis un INSTANT sans poser le
 *     fuseau ; elle n'interdit pas de comparer deux dates comptables déjà Maurice.
 *     (Le seul instant du chantier — le `max` du champ « au » — est converti côté UI par
 *     `dateCouranteMaurice`, jamais par le `new Date()` du navigateur.)
 */
import { estDateISO } from "./format-date";

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
 * Amplitude MAXIMALE d'une plage explicite, en mois. Anti-abus (règle 3 — toute entrée
 * porte ses bornes) : sans plafond, un `?du=1900-01-01` forgé à la main ferait générer
 * 1 200+ mois de grille de tendance et un GROUP BY d'autant. Les données commencent à
 * `PLANCHER_HISTORIQUE` (2024-01-01) : 10 ans ne bride AUCUN usage légitime.
 */
export const MAX_MOIS_PLAGE = 120;

/**
 * Bornes résolues d'une période, prêtes à passer aux repos.
 * - `nbMois` : fenêtre de tendance (≥ 1). Pour « tout », c'est le nb de mois entre
 *   le plancher historique et le mois courant (syntheseParMois exige nbMois ≥ 1).
 * - `from`/`to` : dates comptables Maurice « YYYY-MM-DD » INCLUSIVES (contrat des repos).
 * - `moisAncrage` : « YYYY-MM » ancrant la tendance (grilleMois + libellé d'en-tête) : le
 *   mois COURANT sur un preset, le mois de FIN DE PLAGE sur une plage explicite.
 * - `preset` : l'identifiant normalisé réellement appliqué, ou **`null` si une PLAGE
 *   EXPLICITE (?du/?au) a primé**. Ce `null` est une garde ANTI-MENSONGE au niveau du
 *   TYPE : aucun appelant ne peut lire `.preset`, voir « 6m » et croire que c'est ce qui
 *   filtre, alors qu'une plage borne réellement la lecture.
 */
export interface BornesPeriode {
  preset: PresetPeriode | null;
  nbMois: number;
  from: string;
  to: string;
  moisAncrage: string;
}

/** Plage de dates explicite, validée. Dates comptables Maurice, bornes INCLUSIVES. */
export interface PlageExplicite {
  du: string;
  au: string;
}

/**
 * Params d'URL lus par ce module. Forme volontairement PERMISSIVE : c'est exactement ce
 * que rend le `searchParams` de Next (`string | string[] | undefined`), et le client peut
 * lui passer le résultat d'un `URLSearchParams.get()` (`string | null` → `?? undefined`).
 * Les autres params éventuels sont ignorés (index signature) : ce module ne possède QUE
 * le contrat de période.
 */
export interface ParamsPeriode {
  periode?: string | string[] | undefined;
  du?: string | string[] | undefined;
  au?: string | string[] | undefined;
}

/**
 * Les 3 clés d'URL qui portent la période. SOURCE UNIQUE : lue par le serveur
 * (`paramsPeriodeDepuisURL`), PROPAGÉE par la nav (`nav-periode.ts` — la période doit
 * survivre au clic de sidebar) et PURGÉE par le reset. Toute lecture/écriture de période
 * itère CETTE liste → aucune divergence possible (si la nav propageait « period » au lieu de
 * « periode », ou oubliait « au », un lien perdrait silencieusement une borne).
 *
 * Garde au TYPE, pas seulement à la vigilance : `paramsPeriodeDepuisURL` construit son objet
 * en assignant `params[cle]` pour `cle ∈ CLES_PERIODE` — ça ne compile que si
 * `ClePeriode ⊆ keyof ParamsPeriode`. Ajouter une clé ici sans l'ajouter à `ParamsPeriode`
 * casse le build.
 */
export const CLES_PERIODE = ["periode", "du", "au"] as const;
export type ClePeriode = (typeof CLES_PERIODE)[number];

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
 * DERNIER jour (« YYYY-MM-DD ») du mois `mois` (« YYYY-MM »). `Date.UTC(a, m, 0)` = jour 0
 * du mois SUIVANT = dernier jour du mois demandé (gère 28/29/30/31 sans table). PUR, en
 * UTC sur une date « nue » → aucun décalage de fuseau (cf. en-tête).
 *
 * Sert à borner au JOUR la synthèse du mois d'ancrage depuis que les repos prennent
 * [from, to] : sous un PRESET, la carte « Synthèse du mois » couvre le mois ENTIER —
 * exactement ce que faisait l'ancien `syntheseMoisParDevise(mois)`. Zéro régression.
 */
export function dernierJourMois(mois: string): string {
  const [a, m] = mois.split("-").map(Number);
  return new Date(Date.UTC(a!, m!, 0)).toISOString().slice(0, 10);
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
 * Une valeur d'URL n'est prise que si c'est une CHAÎNE unique. Un tableau (`?du=a&du=b`)
 * est un param dupliqué : refusé, jamais « le premier gagne » (même contrat strict que
 * `normaliserPreset` — l'URL est forgée par notre UI).
 */
function valeurUnique(valeur: string | string[] | undefined): string | undefined {
  return typeof valeur === "string" ? valeur : undefined;
}

/**
 * Adapte un `URLSearchParams` (CLIENT) vers `ParamsPeriode` (la forme que voit le SERVEUR
 * via Next). SOURCE UNIQUE de cette lecture — et ce n'est PAS un détail :
 *
 * ⚠️ `URLSearchParams.get()` rend la PREMIÈRE valeur d'un param dupliqué, là où Next livre
 * au serveur un `string[]` (que `valeurUnique` REJETTE). Un `?du=X&du=Y` (lien partagé,
 * bookmark) faisait donc diverger l'UI du serveur : le contrôle s'allumait sur une plage
 * « valide » pendant que la page filtrait le preset — exactement le mensonge d'affichage
 * que ce lot combat, retourné contre lui (constat de cross-review, 2026-07-14). On restitue
 * donc le TABLEAU dès qu'un param est dupliqué : les deux côtés voient la même chose et
 * replient tous les deux sur le preset.
 */
export function paramsPeriodeDepuisURL(sp: URLSearchParams): ParamsPeriode {
  const lire = (cle: string): string | string[] | undefined => {
    const valeurs = sp.getAll(cle);
    if (valeurs.length === 0) return undefined;
    return valeurs.length === 1 ? valeurs[0] : valeurs; // dupliqué → tableau → rejeté
  };
  // Itère `CLES_PERIODE` (et NON des littéraux « periode »/« du »/« au ») : la nav et le
  // reset itèrent la MÊME liste → impossible de diverger. Le typage de la boucle est la garde
  // (cf. CLES_PERIODE) : `params[cle] =` n'accepte `cle` que s'il est bien une clé de ParamsPeriode.
  const params: ParamsPeriode = {};
  for (const cle of CLES_PERIODE) params[cle] = lire(cle);
  return params;
}

/**
 * Lit et VALIDE la plage explicite `?du`/`?au`. SOURCE UNIQUE de cette validation :
 * appelée par le serveur (`resoudrePeriode`) ET par l'UI (`PlageDatesSwitcher` pour son
 * état actif, `PeriodeSwitcher` pour savoir qu'aucun preset ne s'applique). Un composant
 * ne re-valide JAMAIS des dates dans son coin — sinon l'UI et le serveur peuvent diverger,
 * et c'est exactement comme ça qu'on affiche une période que la page ne filtre pas.
 *
 * `null` (⇒ repli sur le preset) dès que la plage n'est pas EXPLOITABLE TELLE QUELLE :
 *   - un seul des deux bords (plage incomplète) — on ne devine pas la borne manquante ;
 *   - format/calendrier invalide (« 2026-02-30 », « hier », tableau) → `estDateISO`
 *     (source unique de validité de date, format-date.ts — pas une 3ᵉ implémentation) ;
 *   - bornes INVERSÉES (`du > au`) — comparaison LEXICOGRAPHIQUE, licite sur du
 *     « YYYY-MM-DD » de largeur fixe : aucun `new Date`, donc aucun fuseau parasite ;
 *   - amplitude > MAX_MOIS_PLAGE (anti-abus, cf. la constante).
 *
 * Repli SILENCIEUX (pas de throw) : c'est la convention EXISTANTE du module
 * (`normaliserPreset` : hors liste blanche → défaut). Une page de LECTURE ne rend pas un
 * 400 sur un param cosmétique ; et la valeur brute n'atteint jamais le SQL de toute façon.
 */
export function lirePlage(params: ParamsPeriode): PlageExplicite | null {
  const du = valeurUnique(params.du);
  const au = valeurUnique(params.au);
  if (!du || !au) return null;
  if (!estDateISO(du) || !estDateISO(au)) return null;
  if (du > au) return null;
  // Plancher : rien n'existe avant la 1re partition — et une date « an 1 » forgée à la main
  // produirait des libellés de mois hors format (« 1-12 ») dans la grille d'axe. L'UI pose
  // déjà ce `min` sur le champ ; ici c'est la garde qui compte (comparaison lexicographique).
  if (du < PLANCHER_HISTORIQUE) return null;
  if (nbMoisEntre(du, au.slice(0, 7)) > MAX_MOIS_PLAGE) return null;
  return { du, au };
}

/**
 * La période est-elle RÉGLÉE au-delà du défaut « 6 mois » ? Vrai si une PLAGE explicite
 * valide filtre (`?du`/`?au`) OU si un preset ≠ `PRESET_DEFAUT` est actif.
 *
 * Réutilise EXACTEMENT les gardes que le serveur applique (`lirePlage` + `normaliserPreset`)
 * — aucune détection maison : un `?periode`/`?du` forgé, dupliqué ou incomplet retombe au
 * défaut ICI comme côté page, donc le bouton reset n'apparaît pas pour une valeur qui, de
 * toute façon, filtre déjà comme « 6 mois ». C'est ce qui pilote l'affichage du reset.
 */
export function estHorsDefautPeriode(params: ParamsPeriode): boolean {
  return (
    lirePlage(params) !== null ||
    normaliserPreset(params.periode) !== PRESET_DEFAUT
  );
}

/**
 * Résout les bornes de période depuis les `searchParams` (objet ENTIER : `?periode`,
 * `?du`, `?au`). PUR : aucun accès DB.
 *
 * PRIORITÉ (règle du lot A1) : une **plage explicite VALIDE prime sur le preset**. Le
 * preset ne sert alors à rien — d'où `preset: null` en retour (cf. BornesPeriode).
 *
 * - PLAGE (`?du`/`?au` valides) : `from`/`to` = les dates saisies. `moisAncrage` = mois de
 *   `au`, donc la tendance se termine à la FIN DE LA PLAGE et non « aujourd'hui » (une
 *   plage de mars ne doit pas tracer une courbe qui court jusqu'à juillet). `nbMois` =
 *   nb de mois couverts par la plage (≥ 1). AUCUNE conversion de fuseau ici — c'est
 *   correct, cf. l'en-tête du module.
 * - PRESETS bornés (ce-mois/3m/6m/12m) : `from` = 1er jour du mois reculé de (nbMois − 1),
 *   `to` = aujourd'hui MAURICE (`aujourdhuiMaurice`, injectable — jamais un `new Date()`
 *   nu comparé sans fuseau, CLAUDE.md).
 * - « tout » : `from` = PLANCHER_HISTORIQUE ("2024-01-01", début 1re partition —
 *   OPTION 1 du plan, on ne touche PAS la signature de cashflowParDevise), `to` =
 *   aujourd'hui, `nbMois` = nb de mois entre le plancher et le mois courant (≥ 1).
 *   Le filtre reste sur transaction_date → pruning des partitions préservé.
 *
 * Invariants garantis dans les DEUX chemins : `from ≤ to` (satisfait la validation
 * d'insights.ts — pour la plage c'est `lirePlage` qui rejette `du > au`) et `nbMois ≥ 1`
 * (satisfait syntheseParMois — `nbMoisEntre` borne à 1).
 */
export function resoudrePeriode(
  params: ParamsPeriode,
  maintenant: Date = new Date(),
): BornesPeriode {
  // La plage prime : on ne calcule même pas le preset (il ne s'appliquerait pas).
  const plage = lirePlage(params);
  if (plage) {
    const moisAncrage = plage.au.slice(0, 7);
    return {
      preset: null,
      from: plage.du,
      to: plage.au,
      moisAncrage,
      nbMois: nbMoisEntre(plage.du, moisAncrage),
    };
  }

  const preset = normaliserPreset(params.periode);
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
