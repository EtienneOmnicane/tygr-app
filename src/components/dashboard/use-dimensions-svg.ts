"use client";

/**
 * Hook de MESURE d'un élément SVG (largeur + hauteur rendues, en px), via
 * `ResizeObserver`. Extrait du patron de la courbe (`flux-chart-trace.tsx`) pour être
 * partagé avec les barres (`flux-bars.tsx`) sans dupliquer le code de l'observateur.
 *
 * Pourquoi mesurer : un viewBox SVG en coordonnées FIXES étiré sur une zone fluide
 * déforme le dessin (cause racine corrigée sur la courbe). En connaissant les px
 * RÉELS, on peut poser un viewBox où 1 unité = 1 px → aucune déformation, et un
 * dessin qui remplit exactement la zone.
 *
 * Les dimensions servent UNIQUEMENT à la géométrie (positions/tailles en px) ; elles
 * ne sont JAMAIS réinjectées dans un montant affiché (frontière float, règle 8).
 *
 * @param largeurDefaut largeur de repli avant la 1re mesure (SSR / 1er paint).
 * @param hauteurDefaut hauteur de repli avant la 1re mesure.
 */
import { useEffect, useRef, useState } from "react";

export function useDimensionsSvg(largeurDefaut: number, hauteurDefaut: number) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [dimensions, setDimensions] = useState({
    largeur: largeurDefaut,
    hauteur: hauteurDefaut,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver(([entree]) => {
      const { width, height } = entree.contentRect;
      // Ignore les mesures dégénérées (élément masqué / pas encore monté) pour ne
      // jamais produire un viewBox à 0 (division par zéro en aval).
      if (width <= 0 || height <= 0) return;
      setDimensions({ largeur: width, hauteur: height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return { ref, ...dimensions };
}
