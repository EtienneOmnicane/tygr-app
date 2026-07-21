"use client";

/**
 * Donut « Analyse par catégorie » pour UNE devise. Rendu SVG fait main (aucune lib de
 * graphes — règle 9). Chaque part est un SECTEUR ANNULAIRE (arc externe + arc interne)
 * tracé depuis sa fraction `part`.
 *
 * ⚠️ Frontière float (règle 8) : `part` est une CHAÎNE décimale. Le `Number()` interne
 * (`fractionGeo`) sert UNIQUEMENT à la GÉOMÉTRIE (angles en radians) — cul-de-sac qui ne
 * réinjecte JAMAIS dans un montant affiché. Le TOTAL au centre et les montants viennent,
 * eux, des chaînes SQL formatées par `format-montant.ts` (aucune addition JS).
 *
 * Couleurs via `couleurCategorie` (tokens `--color-chart-cat-*`) : 8 teintes distinctes,
 * queue + « Non catégorisé » en neutre. Le survol (piloté par la carte parente, partagé
 * avec la légende) met en avant une part et estompe les autres.
 */
import { formatMontant } from "@/lib/format-montant";
import type { PartCategorie } from "@/server/insights/types";

import { couleurCategorie } from "./palette-categories";
import { pourcentPart } from "./pourcent-part";

// Géométrie du viewBox (unités SVG — le SVG est mis à l'échelle par la CSS, donc ces
// unités ne sont PAS des pixels écran : ne jamais en dériver une largeur CSS en px).
// Anneau centré.
//
// Rayons élargis (DONUT-CENTRE-DEBORDE1) : le total central débordait sur l'anneau. Le
// trou n'est pas un carré mais un CERCLE — une ligne de texte décalée du centre dispose
// d'une CORDE, plus courte que le diamètre. Mesuré à 1440 px : « Rs 4 500 000,00 » =
// 127,9 px pour une corde de 120,2 px à sa hauteur, soit 7,7 px mordus sur l'anneau.
// Les deux rayons montent de 6 : l'ÉPAISSEUR D'ANNEAU RESTE 36 (on agrandit le trou,
// on ne rogne pas la donnée) et le trou gagne 9 % de diamètre.
const VB = 220;
const CENTRE = VB / 2;
const RAYON_EXT = 106; // marge au bord du viewBox : 4 (stroke inter-secteurs = 1,5)
const RAYON_INT = 70; // épaisseur d'anneau = 36, inchangée
const DEBUT = -Math.PI / 2; // 12 h (haut), sens horaire

/** Fraction d'une part POUR LA GÉOMÉTRIE uniquement (jamais un montant). */
function fractionGeo(part: string): number {
  const n = Number(part);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Point (x, y) sur un cercle centré, angle en radians. */
function surCercle(rayon: number, angle: number): [number, number] {
  return [CENTRE + rayon * Math.cos(angle), CENTRE + rayon * Math.sin(angle)];
}

/** Chemin d'un secteur annulaire [a0, a1] (radians), rayons ext/int. */
function cheminSecteur(a0: number, a1: number): string {
  const grand = a1 - a0 > Math.PI ? 1 : 0;
  const [x0e, y0e] = surCercle(RAYON_EXT, a0);
  const [x1e, y1e] = surCercle(RAYON_EXT, a1);
  const [x1i, y1i] = surCercle(RAYON_INT, a1);
  const [x0i, y0i] = surCercle(RAYON_INT, a0);
  return [
    `M ${x0e} ${y0e}`,
    `A ${RAYON_EXT} ${RAYON_EXT} 0 ${grand} 1 ${x1e} ${y1e}`,
    `L ${x1i} ${y1i}`,
    `A ${RAYON_INT} ${RAYON_INT} 0 ${grand} 0 ${x0i} ${y0i}`,
    "Z",
  ].join(" ");
}

export function DonutCategories({
  parts,
  total,
  devise,
  survol,
  onSurvol,
}: {
  parts: PartCategorie[];
  total: string;
  devise: string;
  survol: number | null;
  onSurvol?: (index: number | null) => void;
}) {
  // Fractions géométriques par part (cul-de-sac float — jamais un montant).
  const fractions = parts.map((p) => fractionGeo(p.part));
  // Normalisation par la somme des fractions → l'anneau se referme exactement (pas de
  // trou de fin dû aux arrondis). Somme nulle (aucune donnée) : garde-fou = 1.
  const somme = fractions.reduce((s, f) => s + f, 0) || 1;
  const anneauComplet = parts.length === 1;

  // Bornes angulaires cumulées (géométrie), calculées SANS mutation de variable
  // pendant le rendu (prefix-sum pur — n de catégories petit, coût négligeable).
  const secteurs = parts.map((p, i) => {
    const avant = fractions.slice(0, i).reduce((s, f) => s + f, 0);
    const a0 = DEBUT + (avant / somme) * 2 * Math.PI;
    const a1 = DEBUT + ((avant + fractions[i]) / somme) * 2 * Math.PI;
    return { part: p, index: i, a0, a1, couleur: couleurCategorie(i, p.estNonCategorise) };
  });

  const partActive = survol != null ? parts[survol] : null;

  return (
    <div className="relative mx-auto w-full max-w-[240px]">
      <svg
        viewBox={`0 0 ${VB} ${VB}`}
        className="w-full"
        role="img"
        aria-label={`Répartition par catégorie en ${devise}`}
      >
        {anneauComplet ? (
          // Une seule catégorie : anneau plein (deux cercles) — un secteur de 360°
          // dégénère en arc nul. Le trou est rempli par la surface de la carte.
          <>
            <circle cx={CENTRE} cy={CENTRE} r={RAYON_EXT} fill={secteurs[0].couleur} />
            <circle cx={CENTRE} cy={CENTRE} r={RAYON_INT} fill="var(--color-surface-card)" />
          </>
        ) : (
          secteurs.map((s) => {
            const estix = survol === null || survol === s.index;
            return (
              <path
                key={`${s.part.categorie}-${s.index}`}
                d={cheminSecteur(s.a0, s.a1)}
                fill={s.couleur}
                stroke="var(--color-surface-card)"
                strokeWidth={1.5}
                className="transition-opacity"
                style={{ opacity: estix ? 1 : 0.35 }}
                onMouseEnter={() => onSurvol?.(s.index)}
                onMouseLeave={() => onSurvol?.(null)}
              />
            );
          })
        )}
      </svg>

      {/* Centre : total mono-devise (chaîne SQL formatée) ou détail de la part survolée.
          Overlay HTML (pas du <text> SVG) → tabular-nums + retour à la ligne propre pour
          les gros montants. `pointer-events-none` : ne bloque pas le survol des secteurs. */}
      {/* Largeur en POURCENTAGE, pas en px : le SVG est fluide (`w-full`), donc un
          padding fixe (`px-8`) ne suit pas l'échelle — il laissait 156 px de texte pour
          un trou de 128 px. 58 % du côté reste inscrit dans le cercle intérieur (2×70/220
          = 63,6 %) avec la marge qu'exige une ligne décalée du centre. */}
      <div className="pointer-events-none absolute inset-0 mx-auto flex w-[58%] flex-col items-center justify-center text-center">
        {partActive ? (
          <>
            <span className="max-w-full truncate text-xs font-medium text-text-muted">
              {partActive.categorie}
            </span>
            <span className="whitespace-nowrap text-base font-bold tabular-nums text-text">
              {formatMontant(partActive.montant, devise)}
            </span>
            <span className="text-xs tabular-nums text-text-faint">
              {pourcentPart(partActive.part)}
            </span>
          </>
        ) : (
          <>
            <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
              Total
            </span>
            <span className="whitespace-nowrap text-base font-bold tabular-nums text-text">
              {formatMontant(total, devise)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
