/**
 * Moteur d'EXPANSION des échéances récurrentes en OCCURRENCES (incrément C0 —
 * `PLAN-conception-previsionnel-C.md` §4). Fonction PURE : zéro React, zéro DB, zéro
 * `Date` locale — toute la règle de récurrence vit ici, testable aux bornes (modèle
 * `machine-mfa.ts` / `allocation.ts`).
 *
 * ## Pourquoi ce module existe
 *
 * Le champ `echeances.recurrence` (`mensuelle` | `trimestrielle`) était STOCKÉ mais
 * JAMAIS LU : `synthetiserHorizon` comptait chaque échéance UNE fois, à sa date
 * stockée. Une mensuelle de 10 000 affichait donc 10 000 à plat sur 30/60/90 j au lieu
 * de 10 000 / 20 000 / 30 000 — un chiffre FAUX, qui SOUS-ESTIMAIT tout engagement
 * récurrent sur un écran censé dire ce qui pèsera sur la trésorerie.
 *
 * ## Sémantique « GABARIT + TÊTE » (décision D1, tranchée le 2026-07-17)
 *
 * Une échéance récurrente est UNE ligne (un GABARIT) ; ses occurrences sont projetées
 * À LA VOLÉE, jamais matérialisées en base (dette P1 `ECH-OCCURRENCES1`). Conséquences,
 * qui sont le cœur de la décision :
 *
 *  - La **TÊTE** (rang 0, l'occurrence à la date STOCKÉE) est la seule à porter
 *    `statut` et `montant_regle` — ce sont des colonnes de la LIGNE, elles ne peuvent
 *    décrire qu'une seule occurrence.
 *  - Les occurrences **DÉRIVÉES** (rang ≥ 1) sont TOUJOURS projetées comme dues, au
 *    montant PLEIN. Un statut terminal sur la tête n'éteint donc PLUS la série.
 *
 * ⚠️ C'est la CORRECTION d'un défaut d'optimisme silencieux : pointer « payée »
 * l'occurrence de juin d'un loyer mensuel effaçait juillet, août et toute la suite de
 * la projection — la trésorerie prévisionnelle remontait de 10 000 Rs/mois sans que
 * rien ne le signale. Un statut terminal ne concerne désormais que la tête.
 *
 * Corollaire assumé (D1, option b) : une série récurrente ne se CLÔT pas par un statut
 * — le geste de clôture est la SUPPRESSION de la ligne (le modèle n'a pas de
 * `recurrence_fin`). Cf. dette P1 `ECH-OCCURRENCES1` (TODOS.md).
 *
 * ## Fuseau (E20, CLAUDE.md « Localisation »)
 *
 * Ce module ne manipule QUE des dates « nues » `YYYY-MM-DD` DÉJÀ à Maurice, en
 * arithmétique ENTIÈRE — **aucun `new Date()`**, donc aucune dérive de fuseau possible.
 * Le fuseau est posé UNE fois, en amont, par `dateCouranteMaurice()`. Même patron que
 * `grilleMois` (`server/repositories/dashboard.ts`), pur pour exactement cette raison.
 *
 * ## Montants (règle 8)
 *
 * Chaînes décimales de bout en bout. Le module ne fait AUCUNE addition (il émet des
 * occurrences) : l'agrégation appartient à l'appelant, via `@/lib/montant-centimes`.
 * Aucun `parseFloat` ici — même pas pour une comparaison.
 */
import type {
  EcheanceDirection,
  EcheanceRecurrence,
  EcheanceStatut,
} from "@/server/db/schema";

import { enCentimes, depuisCentimes, ZERO_CENTIMES } from "@/lib/montant-centimes";

/**
 * Statuts TERMINAUX — une échéance qui ne pèse plus sur la trésorerie.
 * ⚠️ Duplication VOLONTAIRE de la constante du repository ? NON : le repository
 * l'importe désormais d'ici (source unique). Elle vit dans ce module PUR parce que
 * c'est lui qui décide si une occurrence est projetée.
 */
export const STATUTS_TERMINAUX: readonly EcheanceStatut[] = ["payee", "annulee"];

/**
 * Plafond dur d'occurrences par échéance. Garde-fou (le modèle n'a PAS de
 * `recurrence_fin` : une récurrente est théoriquement infinie) contre une borne
 * aberrante — PAS une règle métier. 240 = 20 ans de mensualités : très au-delà de
 * tout horizon réel (90 j) comme de toute grille de dashboard.
 */
const MAX_OCCURRENCES = 240;

/** Pas d'itération, en MOIS, par type de récurrence. */
const PAS_MOIS: Record<EcheanceRecurrence, number> = {
  mensuelle: 1,
  trimestrielle: 3,
};

/** Le sous-ensemble PROJETABLE d'une échéance — ce que le moteur exige, rien de plus. */
export interface EcheanceProjetable {
  id: string;
  direction: EcheanceDirection;
  /** Chaîne décimale POSITIVE (le sens est porté par `direction`). */
  montant: string;
  /** Part déjà réglée, ou null. Ne concerne QUE la tête (cf. « gabarit + tête »). */
  montantRegle: string | null;
  devise: string;
  /** Date « nue » Maurice `YYYY-MM-DD` de la TÊTE. */
  dateEcheance: string;
  /** Statut STOCKÉ. Ne concerne QUE la tête. */
  statut: EcheanceStatut;
  recurrence: EcheanceRecurrence | null;
}

/** Une occurrence projetée — jamais persistée, recalculée à chaque lecture. */
export interface OccurrenceProjetee {
  echeanceId: string;
  direction: EcheanceDirection;
  /** Chaîne décimale POSITIVE : restant dû pour la tête, montant PLEIN pour les dérivées. */
  montant: string;
  devise: string;
  /** Date « nue » Maurice `YYYY-MM-DD` de CETTE occurrence. */
  dateEcheance: string;
  /** `YYYY-MM` — clé de jointure avec la grille mensuelle (lot UI ultérieur). */
  mois: string;
  /** 0 = TÊTE (date stockée, porte statut/montant_regle) ; ≥ 1 = dérivée. */
  rang: number;
}

/** Bornes d'expansion, dates « nues » Maurice INCLUSIVES. */
export interface BornesExpansion {
  /**
   * Borne basse OPTIONNELLE. Absente = pas de borne basse : on part de la tête.
   * La synthèse d'horizon n'en pose PAS (« une dette exigible hier reste due »).
   */
  debut?: string;
  /** Borne haute OBLIGATOIRE (ex. aujourd'hui + 90 j). Sans elle, la série est infinie. */
  fin: string;
}

/* ------------------------------------------------------------------ */
/* Arithmétique de dates « nues » — PURE, sans `Date` (E20)            */
/* ------------------------------------------------------------------ */

interface DateNue {
  annee: number;
  mois: number; // 1..12
  jour: number; // 1..31
}

/** Année bissextile (règle grégorienne complète — 2000 oui, 1900 non). */
function estBissextile(annee: number): boolean {
  return (annee % 4 === 0 && annee % 100 !== 0) || annee % 400 === 0;
}

const JOURS_PAR_MOIS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Dernier jour du mois (1..12), bissextilité comprise. */
function dernierJourDuMois(annee: number, mois: number): number {
  if (mois === 2 && estBissextile(annee)) return 29;
  return JOURS_PAR_MOIS[mois - 1];
}

/** Décompose `YYYY-MM-DD`. `null` si la forme n'est pas exactement celle-là. */
function decomposer(dateIso: string): DateNue | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!m) return null;
  const annee = Number(m[1]);
  const mois = Number(m[2]);
  const jour = Number(m[3]);
  if (mois < 1 || mois > 12) return null;
  if (jour < 1 || jour > dernierJourDuMois(annee, mois)) return null;
  return { annee, mois, jour };
}

/** Recompose `YYYY-MM-DD` (zéros de tête garantis → l'ordre lexical = l'ordre calendaire). */
function composer(d: DateNue): string {
  const mm = String(d.mois).padStart(2, "0");
  const jj = String(d.jour).padStart(2, "0");
  return `${d.annee}-${mm}-${jj}`;
}

/**
 * Ajoute `jours` (≥ 0) à une date « nue ». PURE, sans `Date` : sert à calculer la borne
 * `aujourd'hui + N` des horizons 30/60/90 exactement comme le faisait `(date + N)` en SQL.
 * Retourne `null` si l'entrée n'est pas une date valide (on n'invente pas de date).
 */
export function ajouterJours(dateIso: string, jours: number): string | null {
  const d = decomposer(dateIso);
  if (!d || jours < 0 || !Number.isInteger(jours)) return null;
  let { annee, mois } = d;
  let jour = d.jour + jours;
  for (;;) {
    const dim = dernierJourDuMois(annee, mois);
    if (jour <= dim) break;
    jour -= dim;
    mois += 1;
    if (mois > 12) {
      mois = 1;
      annee += 1;
    }
  }
  return composer({ annee, mois, jour });
}

/**
 * Décale une date de `n` mois en CLAMPANT le quantième au dernier jour du mois cible.
 *
 * ⚠️ Le décalage part TOUJOURS du quantième d'ORIGINE, jamais de l'occurrence
 * précédente — c'est le piège n°1 de tout calcul de récurrence. Un décalage cumulatif
 * (`occurrence(n) = occurrence(n−1) + 1 mois`) fait dériver 31 jan → 28 fév → **28 mars
 * → 28 avril…** : la série entière se décale DÉFINITIVEMENT après le premier mois court.
 * Ni lint, ni tsc, ni le build ne le voient — seul un test le voit (cf. cas « clamp non
 * cumulatif » de la suite).
 */
function decalerMois(origine: DateNue, n: number): DateNue {
  const total = origine.annee * 12 + (origine.mois - 1) + n;
  const annee = Math.floor(total / 12);
  const mois = (total % 12) + 1;
  const jour = Math.min(origine.jour, dernierJourDuMois(annee, mois));
  return { annee, mois, jour };
}

/* ------------------------------------------------------------------ */
/* Moteur                                                              */
/* ------------------------------------------------------------------ */

/** Restant dû de la TÊTE : `montant − coalesce(montant_regle, 0)`, en centimes. */
function restantTeteCentimes(e: EcheanceProjetable): bigint | null {
  const montant = enCentimes(e.montant);
  if (montant === null) return null;
  if (e.montantRegle === null) return montant;
  const regle = enCentimes(e.montantRegle);
  // Un `montant_regle` illisible ne doit pas silencieusement valoir 0 (ce qui
  // GONFLERAIT le restant dû) : on refuse de projeter cette tête.
  if (regle === null) return null;
  return montant - regle;
}

/**
 * Expanse les occurrences d'UNE échéance dans `bornes` (inclusives).
 *
 * Règles (D1 « gabarit + tête ») :
 *  1. Montant illisible → `[]` (on ne projette jamais un montant inventé).
 *  2. Non récurrente : la tête seule, si elle est dans les bornes ET non terminale.
 *  3. Récurrente : tête (si non terminale) + dérivées, pas `mensuelle` = 1 mois /
 *     `trimestrielle` = 3 mois, tant qu'on reste ≤ `bornes.fin`.
 *  4. Tête = restant dû ; dérivées = montant PLEIN.
 *  5. Un restant dû ≤ 0 ne projette PAS la tête (rien ne reste à mouvementer) — mais
 *     n'éteint pas les dérivées.
 *  6. Occurrences hors bornes ignorées ; le `rang` reste l'index réel depuis la tête
 *     (une série antérieure à `bornes.debut` qui rattrape la fenêtre garde ses rangs).
 *
 * Retour trié par date croissante. Aucune addition ici (règle 8 : l'appelant agrège).
 */
export function expanserOccurrences(
  echeance: EcheanceProjetable,
  bornes: BornesExpansion,
): OccurrenceProjetee[] {
  const tete = decomposer(echeance.dateEcheance);
  const fin = decomposer(bornes.fin);
  if (!tete || !fin) return [];
  // Borne basse absente = pas de borne basse (cf. `BornesExpansion.debut`).
  if (bornes.debut !== undefined && !decomposer(bornes.debut)) return [];
  if (bornes.debut !== undefined && bornes.debut > bornes.fin) return [];

  const montantPlein = enCentimes(echeance.montant);
  if (montantPlein === null) return [];

  const estTerminale = STATUTS_TERMINAUX.includes(echeance.statut);
  const pas = echeance.recurrence ? PAS_MOIS[echeance.recurrence] : null;

  const occurrences: OccurrenceProjetee[] = [];

  for (let rang = 0; rang < MAX_OCCURRENCES; rang += 1) {
    // Chaque occurrence se calcule depuis la TÊTE (clamp non cumulatif).
    const d = rang === 0 ? tete : decalerMois(tete, rang * (pas as number));
    const dateIso = composer(d);
    if (dateIso > bornes.fin) break;

    const montantC = rang === 0 ? restantTeteCentimes(echeance) : montantPlein;

    // La TÊTE porte statut/montant_regle : terminale ou soldée → pas projetée. Les
    // DÉRIVÉES sont toujours dues (D1) — c'est la fin de l'optimisme silencieux.
    const projetable =
      rang === 0 ? !estTerminale && montantC !== null && montantC > ZERO_CENTIMES : true;

    const dansBornes = bornes.debut === undefined || dateIso >= bornes.debut;

    if (projetable && dansBornes && montantC !== null) {
      occurrences.push({
        echeanceId: echeance.id,
        direction: echeance.direction,
        montant: depuisCentimes(montantC),
        devise: echeance.devise,
        dateEcheance: dateIso,
        mois: dateIso.slice(0, 7),
        rang,
      });
    }

    if (pas === null) break; // non récurrente : la tête et rien d'autre
  }

  return occurrences;
}
