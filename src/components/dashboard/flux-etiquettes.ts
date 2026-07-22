/**
 * Seuils de LISIBILITÉ des barres de flux, et décision « cette valeur est-elle
 * représentable par une barre ? ».
 *
 * Module NEUTRE (`.ts`, pas de `"use client"`, zéro JSX/hook). Une seule source pour les
 * seuils, sinon la garde et le rendu divergent en silence — exactement l'angle mort qui a
 * laissé passer le défaut (PLAN-flux-previsionnel-lisibilite.md §0.2).
 *
 * ## Deux familles, dont une GELÉE (FLUX-PREV-AXE1)
 *
 *  - **Vivante** — `EPAISSEUR_TICK_PX`, `LARGEUR_PISTE_ENCART_REF_PX`,
 *    `SEUIL_BARRE_ENCART_POURCENT` : consommés par `echeances-encart.tsx` (le rendu) et par
 *    la garde de couverture (`tests/unit/dashboard-demo-couverture-echelle.test.ts`).
 *  - **Gelée** — `SEUIL_LISIBILITE_PX`, `RAPPORT_BARRE_INVISIBLE`, `LARGEUR_GLYPHE_11PX`,
 *    `largeurEtiquette`, `etiquetteVerticale`, `estIllisible`, `MARGE_ETIQUETTE_PX` :
 *    ils servaient les étiquettes de valeur du graphe, retirées avec la sortie de la
 *    prévision hors de l'axe. `flux-bars.tsx` n'importe donc PLUS rien d'ici. Conservés
 *    parce que FLUX-PREV-BASELINE1 (option F) les rebranchera, et couverts par
 *    `tests/unit/flux-etiquettes.test.ts` — jamais du code mort sans filet.
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
 *
 * GELÉ (cf. en-tête) : plus aucune étiquette de valeur dans le graphe depuis FLUX-PREV-AXE1.
 */
export const SEUIL_LISIBILITE_PX = 3;

/**
 * Rapport `plafond d'axe / valeur` au-delà duquel une barre VERTICALE du graphe rend MOINS
 * D'UN PIXEL.
 *
 * Dérivé de la géométrie de l'ancre, pas choisi : `HAUTEUR_ANCRE` vaut
 * `clamp(380px, 55vh, 520px)` ; à 55vh sur un écran de 900 px la carte fait 495 px, moins
 * la bande de labels, divisé en deux demi-bandes → `hauteurDemi ≈ 228,5 px`. Une barre fait
 * `(valeur / plafond) × hauteurDemi` : elle passe sous 1 px dès que
 * `valeur / plafond < 1 / 228,5`.
 *
 * GELÉ (cf. en-tête). Il gardait le corpus de fixtures quand réalisé et prévision
 * partageaient un axe ; ce rôle est tenu depuis FLUX-PREV-AXE1 par
 * `SEUIL_BARRE_ENCART_POURCENT`, qui mesure l'écrasement INTERNE à la prévision. Seul
 * `tests/unit/flux-etiquettes.test.ts` le consomme encore.
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
 * Épaisseur (px) minimale d'une marque de PRÉSENCE : la plus petite trace qui reste
 * perceptible une fois la valeur trop faible pour être représentée à l'échelle.
 *
 * ⚠️ Employée de DEUX façons, à ne pas confondre :
 *  - dans le graphe (usage GELÉ, cf. en-tête) c'était un TICK : une forme *différente*
 *    d'une barre — trait constant, jamais arrondi, sans teinte sémantique — qui ne
 *    prétendait à aucune proportion, la valeur étant portée par une étiquette à côté ;
 *  - dans l'encart (`echeances-encart.tsx`) c'est un PLANCHER de largeur sur la barre
 *    elle-même. Un plancher est écarté §4.3 du plan POUR LE GRAPHE, où rien d'autre ne
 *    porte la valeur : deux montants d'un facteur 13 y rendraient la même hauteur et le
 *    graphe affirmerait du faux. Dans l'encart le montant EXACT est écrit sur chaque
 *    ligne, systématiquement : le plancher ne peut plus faire lire une fausse grandeur,
 *    il empêche seulement une ligne de paraître vide.
 */
export const EPAISSEUR_TICK_PX = 2;

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
 * Largeur de RÉFÉRENCE (px) de la piste d'une barre dans l'encart « Échéances à venir ».
 *
 * L'encart ne mesure pas son conteneur (composant serveur pur, barres en `%`) : cette
 * référence ne sert donc PAS au rendu, uniquement à la garde de couverture, pour traduire
 * un pourcentage en pixels plausibles.
 *
 * MESURÉE puis CORRIGÉE DU CHROME (Visual QA du 2026-07-21) :
 * `getBoundingClientRect()` sur la barre pleine de `DEMO_DASHBOARD_PREVISION_CONTRASTEE`
 * (viewport 1440) donne 1146,94 px — mais sur `/demo/dashboard`, qui n'est PAS sous le
 * groupe de routes `(workspace)` et n'a donc pas l'`AppSidebar` (`w-[232px]`, jamais
 * masquée, montée par `(workspace)/layout.tsx`). La piste de PRODUCTION vaut donc
 * 1146,94 − 232 ≈ 915 px.
 *
 * ⚠️ Piège à retenir : une mesure prise sur une route de démo décrit le chrome de la démo,
 * pas celui du produit. Elle doit être corrigée du chrome manquant, sinon la garde se
 * calibre sur un écran qui n'existe pas. (Une version antérieure retenait 1147 brut, et
 * une autre encore 800 px « au jugé ».)
 *
 * ⚠️ Sa monotonie n'est PAS uniforme selon les tests de la garde — augmenter cette
 * référence fait BAISSER `SEUIL_BARRE_ENCART_POURCENT`, ce qui **durcit** le test « il
 * existe un cas sous le tick » mais **assouplit** le test « le cas sain reste lisible »
 * (assertion `>=`). Ne pas la bouger pour faire passer un test : la remesurer.
 */
export const LARGEUR_PISTE_ENCART_REF_PX = 915;

/**
 * Part (%) en dessous de laquelle une barre de l'encart cesse d'être représentable et se
 * réduit à son tick de présence — le pendant horizontal de `SEUIL_LISIBILITE_PX`.
 *
 * Dérivé, pas choisi : un tick fait `EPAISSEUR_TICK_PX` sur une piste de
 * `LARGEUR_PISTE_ENCART_REF_PX`. En dessous, la barre ne porte plus l'information : c'est
 * le MONTANT ÉCRIT à côté d'elle qui la porte (canal indépendant de l'échelle).
 */
export const SEUIL_BARRE_ENCART_POURCENT =
  (EPAISSEUR_TICK_PX / LARGEUR_PISTE_ENCART_REF_PX) * 100;

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
