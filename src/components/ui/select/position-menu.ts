/**
 * Géométrie du popover du `Select` — logique PURE (aucun React, aucun DOM).
 *
 * POURQUOI un module à part : le menu est PORTALÉ dans `document.body` et positionné en
 * `fixed` (cf. `select.tsx`). Tout le calcul — côté d'ouverture (FLIP), hauteur bornée,
 * largeur, débordement des bords — vit ici pour être TESTABLE sans navigateur (convention
 * maison : `allocation.ts`, `machine-mfa.ts` ; pas de renderer React de test au projet).
 * `select.tsx` ne fait plus que MESURER (`getBoundingClientRect`) et APPLIQUER.
 *
 * Les constantes sont le miroir EXACT des classes Tailwind que le popover portait avant
 * le portal (`max-h-72`, `max-w-[24rem]`, `mt-1`) : le rendu ne change pas, seul le
 * conteneur change. En `fixed`, un `%` (l'ancien `min-w-full`) référerait le VIEWPORT et
 * non plus le trigger — d'où le calcul explicite de `minWidth` ici.
 */

/** Hauteur max du menu (`max-h-72` = 18rem). Sert AUSSI de seuil de FLIP. */
export const MENU_MAX_PX = 288;
/** Largeur max du menu (ancien `max-w-[24rem]`). */
export const MENU_LARGEUR_MAX_PX = 384;
/** Écart trigger ↔ menu (ancien `mt-1`). */
export const ECART_TRIGGER_PX = 4;
/** Marge de sécurité aux bords du viewport : le menu ne colle jamais le bord. */
export const MARGE_VIEWPORT_PX = 8;

/** Rect du trigger, en coordonnées VIEWPORT (= `getBoundingClientRect`). */
export interface RectTrigger {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

export interface Viewport {
  largeur: number;
  hauteur: number;
}

/** Style de positionnement à appliquer au menu `fixed`. Unités : px. */
export interface PositionMenu {
  left: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  /** Menu SOUS le trigger : distance au bord HAUT du viewport. `null` si FLIP. */
  top: number | null;
  /** FLIP — menu AU-DESSUS : distance au bord BAS du viewport. `null` sinon. */
  bottom: number | null;
}

function borner(valeur: number, min: number, max: number): number {
  return Math.min(Math.max(valeur, min), max);
}

/**
 * Position du menu à partir du rect du trigger et du viewport.
 *
 * Verticale — le menu s'ouvre SOUS le trigger, et BASCULE au-dessus (FLIP) seulement si
 * l'espace du bas est trop court ET que celui du haut est MEILLEUR : basculer vers un côté
 * plus étroit dégraderait sans rien résoudre. Le côté retenu est ancré par le bord qui
 * touche le trigger (`top` en bas, `bottom` en flip) → la hauteur RÉELLE du menu n'a pas
 * besoin d'être mesurée (elle varie avec le nombre d'options).
 *
 * INVARIANT (vérifié en test sur TOUS les cas, y compris dégénérés) : la boîte du menu, à sa
 * hauteur maximale, tient DANS le viewport. Il tient à deux bornages complémentaires :
 *  1. l'ANCRE (`top`/`bottom`) est bornée aux marges. Le menu étant `fixed` et RESUIVI au
 *     scroll, un trigger sorti de l'écran donnerait sinon une ancre NÉGATIVE — menu à cheval
 *     hors de l'écran, premières options inatteignables (constat de revue F1) ;
 *  2. `maxHeight` se déduit de l'ancre BORNÉE (et non de l'espace brut du trigger) : quel que
 *     soit le rect d'entrée, le menu s'arrête à la marge opposée. S'il est plus haut, il
 *     défile en interne (`overflow-y-auto`, inchangé).
 * Le composant ferme par ailleurs le menu dès que le trigger n'est plus visible (cf. l'
 * `IntersectionObserver` de `select.tsx`) : ce bornage couvre la TRANSITION, pas l'orphelin.
 */
export function calculerPositionMenu(
  trigger: RectTrigger,
  viewport: Viewport,
): PositionMenu {
  const espaceBas =
    viewport.hauteur - trigger.bottom - ECART_TRIGGER_PX - MARGE_VIEWPORT_PX;
  const espaceHaut = trigger.top - ECART_TRIGGER_PX - MARGE_VIEWPORT_PX;
  const versLeHaut = espaceBas < MENU_MAX_PX && espaceHaut > espaceBas;

  // Ancre = distance au bord du viewport du côté retenu (`top` en bas, `bottom` en flip),
  // BORNÉE aux marges. `hauteur - ancre - marge` est alors l'espace restant jusqu'à la marge
  // OPPOSÉE — la même formule vaut pour les deux sens, et redonne exactement `espaceBas` /
  // `espaceHaut` quand l'ancre n'a pas eu besoin d'être bornée.
  const ancre = borner(
    versLeHaut
      ? viewport.hauteur - trigger.top + ECART_TRIGGER_PX
      : trigger.bottom + ECART_TRIGGER_PX,
    MARGE_VIEWPORT_PX,
    Math.max(MARGE_VIEWPORT_PX, viewport.hauteur - MARGE_VIEWPORT_PX),
  );
  const maxHeight = borner(
    viewport.hauteur - ancre - MARGE_VIEWPORT_PX,
    0,
    MENU_MAX_PX,
  );

  // Largeur : au moins celle du trigger (parité `min-w-full`), sans jamais excéder le
  // viewport. `left` est borné aux marges — le trigger peut être partiellement scrollé
  // hors-vue (groupe de filtres `overflow-x-auto` de /transactions) : son rect serait
  // alors négatif, et le menu naîtrait hors écran.
  const largeurDispo = Math.max(0, viewport.largeur - 2 * MARGE_VIEWPORT_PX);
  const minWidth = Math.min(trigger.width, largeurDispo);
  const left = borner(
    trigger.left,
    MARGE_VIEWPORT_PX,
    Math.max(MARGE_VIEWPORT_PX, viewport.largeur - MARGE_VIEWPORT_PX - minWidth),
  );
  // Plafond de largeur = bord droit du viewport, jamais sous `minWidth` (sinon `max-width`
  // et `min-width` se contrediraient — en CSS `min-width` gagnerait, silencieusement).
  const maxWidth = Math.max(
    minWidth,
    Math.min(MENU_LARGEUR_MAX_PX, viewport.largeur - left - MARGE_VIEWPORT_PX),
  );

  return {
    left,
    minWidth,
    maxWidth,
    maxHeight,
    // L'ancre BORNÉE (et non le rect brut du trigger) : c'est elle qui garantit l'invariant.
    top: versLeHaut ? null : ancre,
    bottom: versLeHaut ? ancre : null,
  };
}

/** Égalité structurelle — évite un re-render à chaque `scroll` qui ne déplace rien. */
export function memePosition(a: PositionMenu | null, b: PositionMenu | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.left === b.left &&
    a.minWidth === b.minWidth &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight &&
    a.top === b.top &&
    a.bottom === b.bottom
  );
}
