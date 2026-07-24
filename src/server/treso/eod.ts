/**
 * Trésorerie EOD — helpers PURS de la couche lecture (TRESO-EOD-ELECTION,
 * PLAN-treso-eod.md §3 report, §4.2 complétude, §3.3/D6 consolidé).
 *
 * Module NEUTRE, zéro I/O, zéro `Date.now()` : entrées = EOD réels élus
 * (`balance_history`) + mouvements nets par jour ; sorties = axes continus,
 * statuts, séries consolidées. Testable hors DB (modèle `grilleMois` /
 * `flux-projection.ts`). Le repository (`dashboard.ts`) fetch, ce module calcule.
 *
 * Règle 8 (montants) : arithmétique en CENTIMES BigInt (`montant-centimes`),
 * jamais de float, jamais de tolérance d'arrondi — les deux membres du contrôle
 * de complétude sont des décimaux exacts ; toute tolérance masquerait précisément
 * le défaut recherché (§4.2).
 *
 * Frontière donnée/rendu (§3.2) : le report vit ICI (à la lecture), JAMAIS en
 * base — `balance_history` ne contient que des EOD observés. Chaque jour reporté
 * reste DISCERNABLE (`dateSource`) : c'est ce qui permet au drapeau de complétude
 * de suivre la valeur portée.
 */
import {
  ZERO_CENTIMES,
  depuisCentimes,
  enCentimesSigne,
} from "@/lib/montant-centimes";

/** Un EOD RÉEL élu (une ligne `balance_history`) : jour comptable Maurice + solde. */
export interface PointEodReel {
  date: string; // YYYY-MM-DD (jour comptable Maurice)
  solde: string; // chaîne numeric(15,2), signée (découvert possible)
}

/** Un jour de série continue après report (§3.1) — reporté ⇔ `date !== dateSource`. */
export interface JourSerie {
  date: string;
  solde: string;
  /** Jour EOD RÉEL dont la valeur est portée (lui-même pour un jour observé). */
  dateSource: string;
}

/**
 * Statut du contrôle §4.2 pour un jour EOD réel :
 * - COMPLET : Δ_observé = Δ_attendu — l'intervalle ]K, J] se réconcilie (PAS une
 *   preuve absolue : deux erreurs opposées se compensent, §4.3) ;
 * - INCOMPLET : écart ≠ 0 — drapeau (transaction perdue, ex æquo mal départagé,
 *   solde nul sur la vraie dernière, tombstone…), JAMAIS un verdict ni un rejet ;
 * - NON_EVALUABLE : premier EOD connu (aucun K antérieur), ou montant illisible
 *   (fail-closed : on ne prétend ni complet ni incomplet).
 */
export type StatutCompletude = "COMPLET" | "INCOMPLET" | "NON_EVALUABLE";

/** Mouvement NET d'un jour comptable (Σ crédits − Σ débits), chaîne signée. */
export interface MouvementJour {
  date: string;
  delta: string;
}

/** Entrée du consolidé : un compte, sa devise, ses EOD réels + mouvements. */
export interface CompteEod {
  bankAccountId: string;
  /** Devise du COMPTE (D_c) — les séries se consolident PAR devise, jamais entre. */
  currency: string;
  points: PointEodReel[];
  mouvements: MouvementJour[];
}

/** Un point de courbe consolidée par devise, avec le drapeau de complétude (D2). */
export interface PointConsolideFiable {
  date: string;
  currency: string;
  soldeConsolide: string;
  /**
   * Faux si AU MOINS une valeur contribuée ce jour provient d'un jour EOD en écart
   * (INCOMPLET §4.2). NON_EVALUABLE ne rend PAS douteux (sinon tout bord gauche le
   * serait — le premier EOD n'a pas de K antérieur, §4.3).
   */
  fiable: boolean;
}

/** Jour calendaire suivant (« YYYY-MM-DD » + 1 j). PUR, UTC sur date nue — aucun
 *  fuseau : on itère des jours comptables Maurice déjà posés (même doctrine que
 *  `periode.ts` : rien à convertir entre deux dates déjà Maurice). */
export function jourSuivant(date: string): string {
  const [a, m, j] = date.split("-").map(Number);
  return new Date(Date.UTC(a!, m! - 1, j! + 1)).toISOString().slice(0, 10);
}

/** Tri chronologique STABLE par date (comparaison lexicographique, licite sur
 *  YYYY-MM-DD de largeur fixe — aucun `new Date`, aucun fuseau parasite). */
function parDate<T extends { date: string }>(xs: T[]): T[] {
  return [...xs].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/**
 * Report AVANT uniquement (§3.1) : axe continu d'un COMPTE sur [from, to].
 *
 * - Un jour sans EOD porte l'EOD du dernier jour connu ANTÉRIEUR (un solde est un
 *   stock : il persiste jusqu'au mouvement suivant).
 * - Le dernier EOD antérieur à `from` ancre légitimement le bord gauche de la
 *   fenêtre (la connaissance ne s'arrête pas au bord de l'écran).
 * - AUCUN report arrière : avant le premier EOD connu, il n'y a RIEN — un solde
 *   plat fabriqué serait parfaitement crédible et parfaitement faux. La série
 *   démarre donc à `max(from, premier EOD)` ; sans aucun EOD ≤ to → série VIDE.
 * - Bord droit prolongé jusqu'à `to` (le rendu décide quoi en faire — §2.5 :
 *   l'ancrage `current_balance` est un problème de rendu, jamais une écriture).
 */
export function reporterSerie(
  points: PointEodReel[],
  bornes: { from: string; to: string },
): JourSerie[] {
  if (bornes.from > bornes.to) return [];
  const reels = parDate(points.filter((p) => p.date <= bornes.to));
  if (reels.length === 0) return [];

  const parJour = new Map(reels.map((p) => [p.date, p] as const));
  // Dernier EOD ≤ from (ancre du bord gauche), sinon départ au premier EOD réel.
  const anterieurs = reels.filter((p) => p.date <= bornes.from);
  const depart =
    anterieurs.length > 0 ? bornes.from : reels[0]!.date;
  let porte: PointEodReel =
    anterieurs.length > 0 ? anterieurs[anterieurs.length - 1]! : reels[0]!;

  const serie: JourSerie[] = [];
  for (let d = depart; d <= bornes.to; d = jourSuivant(d)) {
    const reel = parJour.get(d);
    if (reel) porte = reel;
    serie.push({ date: d, solde: porte.solde, dateSource: porte.date });
  }
  return serie;
}

/**
 * Contrôle de complétude §4.2 — la différence de `RunningBalance` (gratuit) :
 * si l'on détient TOUTES les transactions entre deux clôtures K < J, alors
 * `EOD(J) − EOD(K) = Σ mouvements de ]K, J]`. Signe DÉJÀ porté par `delta`
 * (le repository somme `+amount` Credit / `−amount` Debit — jamais le signe
 * d'`amount`, positif-only côté OBIE).
 *
 * Entrées : TOUS les EOD réels connus du compte (pas tronqués à la fenêtre — le
 * K du premier jour de fenêtre est souvent AVANT elle) + les mouvements nets par
 * jour. Sortie : un statut PAR jour EOD réel, dans l'ordre chronologique.
 *
 * Ce que ça ne prouve PAS (§4.3, à ne pas surinterpréter) : écart = 0 n'est pas
 * une preuve (compensations) ; un jour entier perdu en bord de fenêtre déplace K
 * sans créer d'écart ; un écart peut être un mouvement réel jamais servi
 * (intérêts/frais) — DRAPEAU, jamais une condition de rejet d'ingestion.
 */
export function evaluerCompletude(
  points: PointEodReel[],
  mouvements: MouvementJour[],
): { date: string; statut: StatutCompletude }[] {
  const reels = parDate(points);
  const deltas = parDate(mouvements);
  const statuts: { date: string; statut: StatutCompletude }[] = [];

  for (let i = 0; i < reels.length; i += 1) {
    if (i === 0) {
      // Aucun K antérieur connu : le contrôle ne couvre pas le premier EOD.
      statuts.push({ date: reels[i]!.date, statut: "NON_EVALUABLE" });
      continue;
    }
    const k = reels[i - 1]!;
    const j = reels[i]!;
    const soldeK = enCentimesSigne(k.solde);
    const soldeJ = enCentimesSigne(j.solde);
    if (soldeK === null || soldeJ === null) {
      statuts.push({ date: j.date, statut: "NON_EVALUABLE" });
      continue;
    }
    let attendu = ZERO_CENTIMES;
    let illisible = false;
    for (const m of deltas) {
      if (m.date <= k.date || m.date > j.date) continue; // intervalle ]K, J]
      const delta = enCentimesSigne(m.delta);
      if (delta === null) {
        illisible = true;
        break;
      }
      attendu += delta;
    }
    if (illisible) {
      statuts.push({ date: j.date, statut: "NON_EVALUABLE" });
      continue;
    }
    statuts.push({
      date: j.date,
      statut: soldeJ - soldeK === attendu ? "COMPLET" : "INCOMPLET",
    });
  }
  return statuts;
}

/**
 * Courbe CONSOLIDÉE par devise sur [from, to], report §3.1 + drapeau §4.2 (D2)
 * + bord gauche D6 option (a) : la série d'une devise ne DÉMARRE qu'à la date où
 * TOUS ses comptes ont un EOD connu (`max` des départs de séries individuelles).
 *
 * Pourquoi (§3.3) : des historiques inégaux (MCB 91 j vs SBM 37 j) sommés dès le
 * plus ancien produisent une MARCHE verticale au premier jour du compte court —
 * un FM la lirait comme une entrée massive. Démarrer au plus court est honnête,
 * coût nul ; corollaire ASSUMÉ : un compte sans AUCUN EOD vide la série de sa
 * devise (fail-closed — le périmètre `is_selected` reste la main de l'utilisateur),
 * et le bord gauche dépend du périmètre sélectionné (contre-intuitif mais correct,
 * à expliciter en UI au lot F1).
 *
 * Multi-devise (règle 8) : une série PAR devise, sommes en centimes BigInt au sein
 * d'une même devise uniquement — JAMAIS d'addition cross-devise, aucun FX.
 * Drapeau : un jour consolidé est `fiable: false` dès qu'UNE valeur contribuée
 * provient d'un jour EOD INCOMPLET (la valeur portée par report GARDE le statut de
 * son jour source — `dateSource`).
 *
 * Sortie triée (date, devise) — même convention que `courbeTresorerie`.
 */
export function consoliderCourbeFiable(
  comptes: CompteEod[],
  bornes: { from: string; to: string },
): PointConsolideFiable[] {
  // Pré-calcul par compte : série reportée + statuts par jour EOD source.
  const prepares = comptes.map((c) => ({
    currency: c.currency,
    serie: reporterSerie(c.points, bornes),
    statuts: new Map(
      evaluerCompletude(c.points, c.mouvements).map((s) => [s.date, s.statut]),
    ),
  }));

  const devises = [...new Set(comptes.map((c) => c.currency))].sort();
  const sortie: PointConsolideFiable[] = [];

  for (const devise of devises) {
    const duGroupe = prepares.filter((p) => p.currency === devise);
    // D6 (a) : un compte sans série ⇒ aucune date où « tous connus » ⇒ série vide.
    if (duGroupe.some((p) => p.serie.length === 0)) continue;
    const departs = duGroupe.map((p) => p.serie[0]!.date);
    const bordGauche = departs.reduce((a, b) => (a > b ? a : b));

    const parJour = duGroupe.map(
      (p) => new Map(p.serie.map((j) => [j.date, j] as const)),
    );
    for (let d = bordGauche; d <= bornes.to; d = jourSuivant(d)) {
      let total = ZERO_CENTIMES;
      let fiable = true;
      let illisible = false;
      for (let i = 0; i < duGroupe.length; i += 1) {
        const jour = parJour[i]!.get(d);
        // Par construction (bordGauche = max des départs, séries continues
        // jusqu'à to), chaque compte a une valeur ; garde défensive sinon.
        if (!jour) {
          illisible = true;
          break;
        }
        const centimes = enCentimesSigne(jour.solde);
        if (centimes === null) {
          illisible = true;
          break;
        }
        total += centimes;
        if (duGroupe[i]!.statuts.get(jour.dateSource) === "INCOMPLET") {
          fiable = false;
        }
      }
      if (illisible) continue; // fail-closed : pas de point fabriqué
      sortie.push({
        date: d,
        currency: devise,
        soldeConsolide: depuisCentimes(total),
        fiable,
      });
    }
  }

  // Tri (date, devise) — les groupes ont été produits par devise puis par date.
  return sortie.sort((a, b) =>
    a.date < b.date
      ? -1
      : a.date > b.date
        ? 1
        : a.currency < b.currency
          ? -1
          : a.currency > b.currency
            ? 1
            : 0,
  );
}
