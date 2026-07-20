/**
 * Seuils de LISIBILITÉ des barres du graphe de flux, et décision « cette valeur est-elle
 * représentable par une barre ? ».
 *
 * Module NEUTRE (`.ts`, pas de `"use client"`, zéro JSX/hook) : consommé par `flux-bars.tsx`
 * (CLIENT, le rendu) ET par la garde de couverture des fixtures de démo
 * (`tests/unit/dashboard-demo-couverture-echelle.test.ts`). Une seule source pour le seuil,
 * sinon la garde et le rendu divergent en silence — exactement l'angle mort qui a laissé
 * passer le défaut (PLAN-flux-previsionnel-lisibilite.md §0.2).
 *
 * ⚠️ GÉOMÉTRIE UNIQUEMENT (règle 8). Tout ici est en PIXELS et en `number` : ce module ne
 * voit jamais un montant affiché, ne formate rien, ne réinjecte rien dans une chaîne
 * décimale. Les montants passent par `@/lib/format-montant`, sans exception.
 */

/**
 * Hauteur (px) en dessous de laquelle un `<rect>` cesse d'être lu comme une barre.
 *
 * En dessous de ~3 px, le `rx={2}` des barres écrase la forme en un trait, l'antialiasing
 * la dilue, et le lecteur ne perçoit plus une grandeur mais un artefact. C'est le seuil à
 * partir duquel le rendu bascule sur un SUBSTITUT TEXTUEL (étiquette de valeur) plutôt que
 * de prétendre représenter la valeur par une hauteur.
 */
export const SEUIL_LISIBILITE_PX = 3;

/**
 * Rapport `plafond d'axe / valeur` au-delà duquel une barre rend MOINS D'UN PIXEL.
 *
 * Dérivé de la géométrie réelle de l'ancre, pas choisi : `HAUTEUR_ANCRE` vaut
 * `clamp(380px, 55vh, 520px)` ; à 55vh sur un écran de 900 px la carte fait 495 px, moins
 * la bande de labels avec pivot (38 px), divisé en deux demi-bandes →
 * `hauteurDemi ≈ 228,5 px`. Une barre fait `(valeur / plafond) × hauteurDemi` : elle passe
 * sous 1 px dès que `valeur / plafond < 1 / 228,5`.
 *
 * Sert de GARDE PERMANENTE sur les fixtures de démo : le corpus doit contenir au moins un
 * cas AU-DELÀ de ce rapport, sinon le Visual QA ne peut structurellement pas voir le
 * défaut et la Gate 4 valide un angle mort (décision Etienne, 2026-07-20).
 */
export const RAPPORT_BARRE_INVISIBLE = 229;

/**
 * Largeur moyenne d'un glyphe à 11 px en Geist `tabular-nums` (chasse fixe pour les
 * chiffres). Sert à décider si une étiquette tient dans sa colonne — estimation
 * DÉLIBÉRÉMENT généreuse : sous-estimer produirait des étiquettes qui se chevauchent,
 * alors que sur-estimer ne coûte qu'une rotation de plus.
 */
export const LARGEUR_GLYPHE_11PX = 6.4;

/** Largeur estimée (px) d'une étiquette rendue à 11 px tabular. */
export function largeurEtiquette(texte: string): number {
  return texte.length * LARGEUR_GLYPHE_11PX;
}

/**
 * Épaisseur (px) du TICK qui remplace une barre trop basse.
 *
 * Ce n'est PAS un plancher de hauteur de barre (explicitement écarté, §4.3 du plan) : un
 * plancher ferait rendre la même hauteur à des valeurs d'un facteur 13, donc le graphe
 * AFFIRMERAIT quelque chose de faux. Le tick est une forme DIFFÉRENTE d'une barre — un
 * trait constant, jamais arrondi, qui ne prétend à aucune proportion. Il dit « il y a
 * quelque chose ici », et c'est l'étiquette qui dit quoi.
 */
export const EPAISSEUR_TICK_PX = 2;

/**
 * Écart (px) entre le tick et son étiquette.
 *
 * Porté à 6 px au Visual QA : quand une colonne porte une entrée ET une sortie toutes deux
 * illisibles, les deux étiquettes se retrouvent collées de part et d'autre de l'axe (la
 * hauteur des barres, qui les séparerait normalement, est nulle par construction).
 */
export const ECART_ETIQUETTE_PX = 6;

/**
 * Marge (px) exigée de part et d'autre d'une étiquette horizontale. En dessous, elle
 * mordrait sur les colonnes voisines et le rendu bascule en vertical.
 */
export const MARGE_ETIQUETTE_PX = 6;

/**
 * Vrai si l'étiquette doit être rendue à la VERTICALE (rotation −90°, lecture de bas en
 * haut) faute de largeur de colonne.
 *
 * La bascule garantit la contrainte posée par Etienne — « lisible sur toutes les fenêtres » :
 * une étiquette verticale n'occupe que la hauteur de sa police (~11 px), donc elle tient
 * même sur le preset « tout » (jusqu'à ~39 colonnes, soit ~28 px par colonne), là où
 * `Rs 10 k` à l'horizontale (~45 px) déborderait sur ses voisines.
 */
export function etiquetteVerticale(texte: string, largeurColonne: number): boolean {
  return largeurEtiquette(texte) > largeurColonne - MARGE_ETIQUETTE_PX * 2;
}

/**
 * Vrai si la valeur EXISTE (non nulle) mais que sa barre est trop basse pour être lue —
 * le cas qui justifie une étiquette de substitution.
 *
 * Les deux conditions comptent : une valeur NULLE n'est pas « illisible », elle est
 * absente — l'étiqueter écrirait « Rs 0 » sur chaque mois sans échéance, transformant un
 * silence légitime en bruit (et, sur un mois qui porte des échéances dans une AUTRE devise,
 * en faux constat — cf. `autresDevises`).
 */
export function estIllisible(hauteurPx: number, estValeurNulle: boolean): boolean {
  if (estValeurNulle) return false;
  return hauteurPx < SEUIL_LISIBILITE_PX;
}

/**
 * Rapport `plafond / valeur` d'une barre — l'inverse de sa hauteur relative. Plus il est
 * grand, plus la barre est écrasée. `Infinity` pour une valeur nulle (aucune barre à
 * rendre), `0` pour un plafond non exploitable (rien à comparer).
 *
 * Utilisé par la garde de couverture pour mesurer l'écart d'ordre de grandeur d'une
 * fixture, en une grandeur SANS unité (donc indépendante de la hauteur d'écran).
 */
export function rapportEcrasement(valeur: number, plafond: number): number {
  if (!Number.isFinite(valeur) || !Number.isFinite(plafond) || plafond <= 0) return 0;
  if (valeur <= 0) return Number.POSITIVE_INFINITY;
  return plafond / valeur;
}
