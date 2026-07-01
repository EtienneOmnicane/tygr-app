/**
 * Projection PURE de la série mensuelle (mois × devise) sur la grille des mois,
 * réduite à la devise de base — partagée par `flux-bars.tsx` (CLIENT, le SVG des
 * barres) ET `monthly-cashflow.tsx` (SERVEUR, le tableau « Évolution mensuelle »).
 *
 * Module NEUTRE (`.ts`, pas de `"use client"`, zéro JSX, zéro hook, zéro import de
 * module client) : ces fonctions sont appelées depuis un Server Component, donc elles
 * ne peuvent PAS vivre dans un fichier `"use client"` (Next interdit d'invoquer une
 * fonction d'un module client depuis le serveur — fix C2). Elles étaient à l'origine
 * dans `flux-bars.tsx` ; déplacement PUR, formules inchangées.
 *
 * ⚠️ Multi-devises (règle 8) : MONO-AFFICHÉ sur la devise de BASE ; aucune addition
 * cross-devise, aucune conversion FX. Un mois qui n'a que d'autres devises reste à 0.
 * `parseFloat` n'est utilisé QUE pour l'ÉCHELLE (hauteur de barre) — JAMAIS pour un
 * montant affiché (les montants passent par `formatMontant` sur la chaîne).
 */
import type { SyntheseMensuelle } from "@/server/repositories/dashboard";
import type { PointCashflow } from "@/server/insights/types";

/** Une cellule mensuelle réduite à la devise de base (ce que la carte affiche). */
export interface MoisAffiche {
  libelleMois: string;
  entrees: string; // chaîne décimale, devise de base (ou "0")
  sorties: string; // chaîne décimale, devise de base (ou "0")
  variation: string; // chaîne décimale, devise de base (ou "0")
  /** Vrai si le mois porte des flux dans une devise ≠ base (signalé, jamais sommé). */
  autresDevises: boolean;
}

/**
 * Projette la série à plat (mois × devise) sur la GRILLE des mois attendus, réduite
 * à la devise de base. La grille garantit l'axe continu (un mois sans aucune
 * transaction apparaît à 0). Un mois qui n'a que d'autres devises reste à 0 + drapeau
 * `autresDevises` (on n'affiche jamais le montant d'une autre devise à la place).
 */
export function projeterSurGrille(
  serie: SyntheseMensuelle[],
  grille: string[],
  devise: string,
): MoisAffiche[] {
  const cible = devise.trim().toUpperCase();
  return grille.map((libelleMois) => {
    const duMois = serie.filter((s) => s.mois === libelleMois);
    const base = duMois.find((s) => s.currency.toUpperCase() === cible);
    const autresDevises = duMois.some((s) => s.currency.toUpperCase() !== cible);
    return {
      libelleMois,
      entrees: base?.entrees ?? "0",
      sorties: base?.sorties ?? "0",
      variation: base?.variation ?? "0",
      autresDevises,
    };
  });
}

/** Plus grande valeur (entrée OU sortie) de la fenêtre — échelle des barres. */
export function maxFenetre(mois: MoisAffiche[]): number {
  let max = 0;
  for (const m of mois) {
    // Échelle uniquement (hauteur relative) — parseFloat est ACCEPTABLE ici car ce
    // n'est PAS un montant affiché (les montants affichés passent par formatMontant
    // sur la chaîne). On borne juste la hauteur d'une barre.
    max = Math.max(max, Math.abs(parseFloat(m.entrees)), Math.abs(parseFloat(m.sorties)));
  }
  return max;
}

/**
 * Projette la série mensuelle sur la MÊME grille CONTINUE que les barres, mais rendue
 * sous forme de `PointCashflow[]` pour la vue COURBE (`FluxCourbe`). Réutilise
 * `projeterSurGrille` (axe continu, mois vides à "0", réduction devise de base) puis
 * mappe chaque cellule `MoisAffiche` en point.
 *
 * Raison d'être (fix « courbe effondrée ») : la courbe recevait auparavant les points
 * BRUTS de `cashflowParDevise` (mois vides ABSENTS). Sur une fenêtre où un seul mois est
 * peuplé, cela donnait 1 point → axe collé à gauche. En passant par la grille, la courbe
 * reçoit N points (un par mois de la fenêtre), exactement comme les barres, donc un axe
 * pleine largeur ancré sur le mois courant.
 *
 * ⚠️ Mapping PUR, AUCUN recalcul de montant (règle 8) : `net ← variation` (le repo définit
 * `variation = entrees − sorties` EN SQL, identique à la sémantique de `net`), entrées et
 * sorties recopiées telles quelles (chaînes décimales), `currency` = devise de base,
 * `nbTransactions = 0` (non lu par le rendu de courbe — cul-de-sac neutre, jamais affiché).
 */
export function projeterPointsCourbe(
  serie: SyntheseMensuelle[],
  grille: string[],
  devise: string,
): PointCashflow[] {
  return projeterSurGrille(serie, grille, devise).map((m) => ({
    bucket: m.libelleMois,
    currency: devise,
    entrees: m.entrees,
    sorties: m.sorties,
    net: m.variation,
    nbTransactions: 0,
  }));
}
