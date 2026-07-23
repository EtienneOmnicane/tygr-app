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
import type { OccurrenceProjetee } from "@/lib/echeances-recurrence";
import { ZERO_CENTIMES, depuisCentimes, enCentimes } from "@/lib/montant-centimes";

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
 * Plus grande valeur de la fenêtre parmi les SEULES séries VISIBLES (légende
 * interactive, L1). Masquer une série la retire de l'échelle : sinon une série cachée
 * mais grande écraserait la série restante (PLAN-graphs-fygr §9.1). Booléens plats
 * (pas le type `VisibiliteSeries` de `charts/`) pour garder ce module NEUTRE, sans
 * dépendance vers un composant client. `parseFloat` cantonné à la géométrie (règle 8).
 */
export function maxFenetreVisible(
  mois: MoisAffiche[],
  montrerEntrees: boolean,
  montrerSorties: boolean,
): number {
  let max = 0;
  for (const m of mois) {
    if (montrerEntrees) max = Math.max(max, Math.abs(parseFloat(m.entrees)));
    if (montrerSorties) max = Math.max(max, Math.abs(parseFloat(m.sorties)));
  }
  return max;
}

/* ------------------------------------------------------------------ */
/* PRÉVISIONNEL (C1) — échéances projetées, jamais du réalisé          */
/* ------------------------------------------------------------------ */

/**
 * Agrège des OCCURRENCES d'échéances (moteur pur `expanserOccurrences`) en cellules
 * mensuelles, sur la grille des mois PRÉVISIONNELS, réduites à la devise de BASE.
 *
 * Contrat identique à `projeterSurGrille` (dont c'est le pendant prévisionnel), pour que
 * les deux séries se rendent avec la même géométrie :
 *  - la GRILLE fait l'axe : un mois sans aucune occurrence sort à 0 (colonne présente) ;
 *  - MONO-DEVISE (règle 8 / DASH-FX1) : seules les occurrences en devise de base sont
 *    sommées ; un mois qui n'a que d'AUTRES devises reste à 0 + drapeau `autresDevises`.
 *    Aucune conversion FX n'est inventée, aucune addition cross-devise.
 *
 * Le SENS vient de `direction` (encaissement → entrées, décaissement → sorties) : tous les
 * montants du modèle sont POSITIFS — lire le signe de `montant` serait un faux constat.
 *
 * Somme en CENTIMES ENTIERS BigInt (`@/lib/montant-centimes`, source unique) : additionner
 * des chaînes décimales en float perdrait des centimes (règle 8). `parseFloat` n'apparaît
 * pas ici — il reste cantonné à l'échelle géométrique (`maxFenetre*`).
 *
 * Une occurrence au montant illisible est IGNORÉE plutôt qu'avalée comme 0 : le moteur
 * n'en émet pas (il refuse de projeter un montant qu'il ne sait pas lire), donc ce cas est
 * une défense en profondeur, pas un chemin métier.
 */
export function projeterEcheancesSurGrille(
  occurrences: OccurrenceProjetee[],
  grille: string[],
  devise: string,
): MoisAffiche[] {
  const cible = devise.trim().toUpperCase();

  const parMois = new Map<string, { enc: bigint; dec: bigint; autres: boolean }>();
  for (const occ of occurrences) {
    const acc = parMois.get(occ.mois) ?? {
      enc: ZERO_CENTIMES,
      dec: ZERO_CENTIMES,
      autres: false,
    };
    if (occ.devise.trim().toUpperCase() !== cible) {
      // Signalée, JAMAIS sommée (même patron que `autresDevises` du réalisé).
      acc.autres = true;
    } else {
      const centimes = enCentimes(occ.montant);
      if (centimes !== null) {
        if (occ.direction === "encaissement") acc.enc += centimes;
        else acc.dec += centimes;
      }
    }
    parMois.set(occ.mois, acc);
  }

  return grille.map((libelleMois) => {
    // Un mois sans occurrence est un ZÉRO comme un autre : il passe par `depuisCentimes`
    // (« 0.00 ») plutôt que par un littéral « 0 ». Sinon la même grille rendrait deux
    // écritures du zéro selon qu'un mois porte ou non des occurrences dans l'autre sens.
    const { enc, dec, autres } = parMois.get(libelleMois) ?? {
      enc: ZERO_CENTIMES,
      dec: ZERO_CENTIMES,
      autres: false,
    };
    return {
      libelleMois,
      entrees: depuisCentimes(enc),
      sorties: depuisCentimes(dec),
      // Net = encaissements − décaissements, EN CENTIMES (jamais sur les chaînes).
      variation: depuisCentimes(enc - dec),
      autresDevises: autres,
    };
  });
}

/**
 * La zone prévisionnelle telle que la page la résout et la passe à l'UI (payload SERVEUR,
 * même chemin que le réalisé — aucun fetch client, donc aucun nouvel état de chargement).
 *
 * `null` côté page (pas un objet vide) quand la fenêtre n'atteint pas le mois courant
 * (D4) : l'absence de prévision se dit par l'absence de la structure, pas par des mois
 * remplis de zéros — une prévision vide n'est pas une prévision nulle (§5.3).
 */
export interface PrevisionFlux {
  /** Part prévisionnelle du mois d'ancrage : ses échéances RESTANTES (D2, colonne pivot). */
  moisCourant: MoisAffiche;
  /** Les `nbMoisPrevision` mois qui suivent l'ancrage, alimentés par les échéances seules. */
  moisFuturs: MoisAffiche[];
}

/**
 * Les mois de la prévision dans l'ORDRE d'affichage : le mois d'ancrage (ses échéances
 * RESTANTES, D2) puis les mois futurs. Source UNIQUE de cet ordre — l'encart et les tests
 * le lisent d'ici plutôt que de recomposer `[moisCourant, ...moisFuturs]` chacun de leur
 * côté (c'est exactement la duplication qui fait diverger une garde de son rendu).
 */
export function moisPrevision(prevision: PrevisionFlux): MoisAffiche[] {
  return [prevision.moisCourant, ...prevision.moisFuturs];
}

/**
 * Plus grande valeur (entrée OU sortie) de la SEULE prévision — l'échelle PROPRE de
 * l'encart « Échéances à venir » (FLUX-PREV-AXE1, option E du plan §4.1).
 *
 * ⚠️ C'est le cœur de l'option E, et la raison pour laquelle cette fonction ne peut PAS
 * être `maxFenetreColonnes` : cette dernière court sur l'axe COMPLET (réalisé + prévision),
 * donc elle porte l'échelle du réalisé — des millions de MUR mesurés en banque. Rapportées
 * à ce plafond, des échéances saisies en milliers rendent moins d'un pixel (rapport mesuré
 * jusqu'à 1:520). Ici le plafond est celui des échéances SEULES : la plus grosse échéance
 * fait une barre pleine, et les autres se comparent ENTRE ELLES — la seule comparaison qui
 * ait un sens, puisque les deux séries ne sont pas commensurables (mesure exhaustive de
 * `transactions_cache` contre sous-ensemble déclaré d'`echeances`).
 *
 * `parseFloat` est cantonné à la GÉOMÉTRIE (hauteur/largeur relative), jamais à un montant
 * affiché — même frontière que `maxFenetre`/`maxFenetreColonnes` (règle 8).
 */
export function maxPrevision(mois: MoisAffiche[]): number {
  let max = 0;
  for (const m of mois) {
    max = Math.max(max, Math.abs(parseFloat(m.entrees)), Math.abs(parseFloat(m.sorties)));
  }
  return max;
}

/**
 * Largeur d'une barre en POURCENTAGE de sa piste, pour l'encart à échelle propre.
 *
 * Rendu en `%` et non en px : l'encart ne mesure pas son conteneur (aucun `ResizeObserver`,
 * donc aucun îlot client — c'est un composant serveur pur). Le pourcentage suit la largeur
 * réelle quelle qu'elle soit, sans jamais dériver un px CSS d'une unité de viewBox — le
 * piège que le SVG étiré du graphe a appris (`flux-bars.tsx`, PLAN §6.3).
 *
 * Borné à [0, 100] : un plafond nul (aucune échéance) rend 0 plutôt qu'`Infinity`/`NaN`.
 * Géométrie pure (règle 8) — `parseFloat` ne touche ici qu'une largeur, pas un montant.
 */
export function largeurRelative(valeur: string, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  const v = Math.abs(parseFloat(valeur));
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min((v / max) * 100, 100);
}

/**
 * Une colonne de l'axe : ce que la barre du mois porte, réalisé et prévision SÉPARÉS.
 * Jamais fusionnés en un chiffre — deux sources (`transactions_cache` vs `echeances`)
 * ne s'additionnent pas dans une même valeur (§3.5, frontière non ambiguë).
 *
 * ⚠️ DÉBRANCHÉ DU RENDU depuis FLUX-PREV-AXE1 (option E) : le graphe « Flux de trésorerie »
 * est redevenu 100 % réalisé, donc plus aucune colonne ne porte de prévision. Ce type et
 * les deux fonctions qui le produisent (`composerColonnes`, `maxFenetreColonnes`) restent
 * ici — testés — parce que l'option E est explicitement RÉVERSIBLE (plan §4.1) et que
 * FLUX-PREV-BASELINE1 (option F, TODOS.md) remettra une série prévisionnelle sur l'axe le
 * jour où elle sera commensurable. Ils décrivent la FRONTIÈRE réalisé/projection, qui reste
 * la règle du domaine même quand elle n'est plus dessinée.
 */
export interface ColonneFlux {
  libelleMois: string;
  /** Réalisé du mois. `null` sur un mois FUTUR (aucune transaction ne peut y exister). */
  realise: MoisAffiche | null;
  /** Prévision du mois. `null` sur un mois PASSÉ (la projection ne remonte pas le temps). */
  prevision: MoisAffiche | null;
}

/**
 * Compose l'axe affiché : les mois RÉALISÉS, puis les mois PRÉVISIONNELS.
 *
 * Le mois d'ANCRAGE (dernier du réalisé) est la colonne PIVOT : elle porte les DEUX
 * (décision D2 — « réalisé à date » + échéances restantes du mois, empilés), et n'est
 * jamais dupliquée en tête de la zone future.
 *
 * `previsionMoisCourant` est optionnel : sans lui (fenêtre passée, D4 — la prévision ne
 * s'affiche que si la fenêtre atteint le mois courant), l'axe reste exactement celui
 * d'aujourd'hui. Une prévision vide n'est PAS une prévision nulle : on ne fabrique pas de
 * colonnes fantômes à zéro (§5.3).
 */
export function composerColonnes(
  realises: MoisAffiche[],
  previsionsFutures: MoisAffiche[],
  previsionMoisCourant: MoisAffiche | null = null,
): ColonneFlux[] {
  const dernier = realises.length - 1;
  const colonnes: ColonneFlux[] = realises.map((m, i) => ({
    libelleMois: m.libelleMois,
    realise: m,
    prevision: i === dernier ? previsionMoisCourant : null,
  }));
  for (const p of previsionsFutures) {
    colonnes.push({ libelleMois: p.libelleMois, realise: null, prevision: p });
  }
  return colonnes;
}

/**
 * Plus grande valeur (entrée OU sortie) de l'axe COMPLET — échelle des barres.
 *
 * ⚠️ Somme réalisé + prévision par colonne : sur le mois pivot les deux segments sont
 * EMPILÉS (D2), donc c'est leur TOTAL qui doit tenir dans la demi-bande. Prendre le max
 * de chaque part isolément ferait DÉBORDER la barre empilée hors de la zone traçable.
 *
 * `parseFloat` est cantonné ici, à la GÉOMÉTRIE (hauteur relative) — jamais à un montant
 * affiché (règle 8), comme dans `maxFenetre`.
 */
export function maxFenetreColonnes(colonnes: ColonneFlux[]): number {
  let max = 0;
  for (const c of colonnes) {
    const entrees =
      Math.abs(parseFloat(c.realise?.entrees ?? "0")) +
      Math.abs(parseFloat(c.prevision?.entrees ?? "0"));
    const sorties =
      Math.abs(parseFloat(c.realise?.sorties ?? "0")) +
      Math.abs(parseFloat(c.prevision?.sorties ?? "0"));
    max = Math.max(max, entrees, sorties);
  }
  return max;
}
