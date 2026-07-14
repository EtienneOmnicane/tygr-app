/**
 * Géométrie PURE du popover du `Select` (TX-STATUT-SELECT-LAYOUT1).
 *
 * L'invariant qui tue le bug d'origine : le menu tient TOUJOURS dans le viewport (il ne
 * déborde ni ne pousse aucun conteneur — c'est ce débordement, dans un ancêtre
 * `overflow-x-auto`, qui faisait apparaître une scrollbar parasite). On l'assène donc à
 * chaque cas via `bornesMenu` plutôt que de ne comparer que des nombres.
 */
import { describe, expect, it } from "vitest";

import {
  MARGE_VIEWPORT_PX,
  MENU_LARGEUR_MAX_PX,
  MENU_MAX_PX,
  calculerPositionMenu,
  memePosition,
  type PositionMenu,
  type RectTrigger,
  type Viewport,
} from "@/components/ui/select/position-menu";

const DESKTOP: Viewport = { largeur: 1440, hauteur: 900 };

/** Boîte réellement occupée par le menu, à sa hauteur/largeur MAXIMALES. */
function bornesMenu(p: PositionMenu, vp: Viewport) {
  const haut = p.top ?? vp.hauteur - (p.bottom as number) - p.maxHeight;
  return {
    haut,
    bas: haut + p.maxHeight,
    gauche: p.left,
    droite: p.left + Math.max(p.minWidth, p.maxWidth),
  };
}

/** Le menu, même plein, reste DANS le viewport (marges comprises). */
function attendreDansLeViewport(p: PositionMenu, vp: Viewport) {
  const b = bornesMenu(p, vp);
  expect(b.haut).toBeGreaterThanOrEqual(MARGE_VIEWPORT_PX);
  expect(b.bas).toBeLessThanOrEqual(vp.hauteur - MARGE_VIEWPORT_PX);
  expect(b.gauche).toBeGreaterThanOrEqual(MARGE_VIEWPORT_PX);
  expect(b.droite).toBeLessThanOrEqual(vp.largeur - MARGE_VIEWPORT_PX);
}

/** Trigger h-10 (40px) de la toolbar /transactions, largeur 160. */
function trigger(top: number, left = 300, width = 160): RectTrigger {
  return { top, bottom: top + 40, left, width };
}

describe("calculerPositionMenu — sens d'ouverture", () => {
  it("ouvre SOUS le trigger quand l'espace du bas suffit", () => {
    const p = calculerPositionMenu(trigger(200), DESKTOP);
    expect(p.top).toBe(244); // bottom (240) + écart (4)
    expect(p.bottom).toBeNull();
    expect(p.maxHeight).toBe(MENU_MAX_PX); // pleine hauteur : rien n'est rogné
    attendreDansLeViewport(p, DESKTOP);
  });

  it("BASCULE au-dessus (FLIP) quand le bas est trop court et que le haut est meilleur", () => {
    const p = calculerPositionMenu(trigger(700), DESKTOP); // 160px sous le trigger
    expect(p.top).toBeNull();
    expect(p.bottom).toBe(204); // hauteur (900) − top (700) + écart (4)
    expect(p.maxHeight).toBe(MENU_MAX_PX); // 688px au-dessus : pleine hauteur
    attendreDansLeViewport(p, DESKTOP);
  });

  it("NE bascule PAS si le haut est encore plus court que le bas (dégradation inutile)", () => {
    const court: Viewport = { largeur: 1440, hauteur: 300 };
    const p = calculerPositionMenu(trigger(30), court); // 18px au-dessus, 218px en dessous
    expect(p.top).toBe(74);
    expect(p.bottom).toBeNull();
    expect(p.maxHeight).toBe(218); // borné à l'espace réel → défilement interne
    attendreDansLeViewport(p, court);
  });

  it("borne la hauteur à l'espace disponible du côté retenu (jamais de débordement)", () => {
    const court: Viewport = { largeur: 1440, hauteur: 420 };
    const p = calculerPositionMenu(trigger(300), court); // bas : 68px ; haut : 288px → FLIP
    expect(p.top).toBeNull();
    expect(p.maxHeight).toBe(288);
    attendreDansLeViewport(p, court);
  });
});

// Le menu SUIT le trigger au scroll (il est `fixed`) : le trigger peut donc se retrouver
// HORS de l'écran alors que le menu est ouvert. Sans bornage de l'ancre, `top`/`bottom`
// devenaient NÉGATIFS → le menu sortait de l'écran, options inatteignables (constat de revue
// F1 : ces trois cas ÉCHOUAIENT avant le bornage). Le composant ferme par ailleurs le menu
// dès que le trigger n'est plus visible — ces cas couvrent la TRANSITION avant la fermeture.
describe("calculerPositionMenu — trigger scrollé hors de l'écran (verticalement)", () => {
  it("ramène le menu à l'écran quand le trigger est passé AU-DESSUS du viewport", () => {
    const p = calculerPositionMenu(trigger(-120), DESKTOP); // trigger entièrement au-dessus
    expect(p.top).toBe(MARGE_VIEWPORT_PX); // et non −76 (= bottom −80 + écart 4)
    attendreDansLeViewport(p, DESKTOP);
  });

  it("ramène le menu à l'écran quand le trigger est passé SOUS le viewport", () => {
    const p = calculerPositionMenu(trigger(940), DESKTOP); // trigger entièrement en dessous
    expect(p.bottom).toBe(MARGE_VIEWPORT_PX); // et non −36
    attendreDansLeViewport(p, DESKTOP);
  });

  it("tient l'invariant « dans le viewport » pour TOUTE position verticale du trigger", () => {
    for (let haut = -400; haut <= 1200; haut += 20) {
      attendreDansLeViewport(calculerPositionMenu(trigger(haut), DESKTOP), DESKTOP);
    }
  });
});

describe("calculerPositionMenu — largeur et bords", () => {
  it("est au moins aussi large que le trigger, plafonné à 24rem", () => {
    const p = calculerPositionMenu(trigger(200, 300, 160), DESKTOP);
    expect(p.minWidth).toBe(160);
    expect(p.maxWidth).toBe(MENU_LARGEUR_MAX_PX);
    expect(p.left).toBe(300);
    attendreDansLeViewport(p, DESKTOP);
  });

  it("rabote la largeur au bord DROIT quand le trigger y est collé", () => {
    const p = calculerPositionMenu(trigger(200, 1300, 100), DESKTOP);
    expect(p.left).toBe(1300);
    expect(p.maxWidth).toBe(132); // 1440 − 1300 − 8, et non 384
    attendreDansLeViewport(p, DESKTOP);
  });

  it("ramène le menu dans l'écran quand le trigger est scrollé hors-vue à gauche", () => {
    // Cas RÉEL : le groupe de filtres de /transactions est `overflow-x-auto` — un trigger
    // décalé par le scroll horizontal a un `left` NÉGATIF.
    const p = calculerPositionMenu(trigger(200, -40, 160), DESKTOP);
    expect(p.left).toBe(MARGE_VIEWPORT_PX);
    attendreDansLeViewport(p, DESKTOP);
  });

  it("ne dépasse jamais le viewport, même si le trigger est plus large que lui", () => {
    const etroit: Viewport = { largeur: 320, hauteur: 900 };
    const p = calculerPositionMenu(trigger(200, 0, 500), etroit);
    expect(p.minWidth).toBe(304); // 320 − 2×8
    expect(p.maxWidth).toBe(304); // jamais < minWidth (sinon min-width gagnerait en CSS)
    attendreDansLeViewport(p, etroit);
  });
});

describe("memePosition", () => {
  const p = calculerPositionMenu(trigger(200), DESKTOP);

  it("reconnaît deux mesures identiques (pas de re-render au scroll qui ne déplace rien)", () => {
    expect(memePosition(p, calculerPositionMenu(trigger(200), DESKTOP))).toBe(true);
  });

  it("détecte un déplacement d'un seul pixel", () => {
    expect(memePosition(p, calculerPositionMenu(trigger(201), DESKTOP))).toBe(false);
  });

  it("gère les null (menu fermé)", () => {
    expect(memePosition(null, null)).toBe(true);
    expect(memePosition(p, null)).toBe(false);
    expect(memePosition(null, p)).toBe(false);
  });
});
