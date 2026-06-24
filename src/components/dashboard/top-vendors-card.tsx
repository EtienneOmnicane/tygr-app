/**
 * Carte « Top contreparties » — concentration des plus gros postes, dérivée de la
 * Voie A des Insights (`vendorsParConcentration`, TECH-API-INSIGHTS). Donne à voir
 * où part (ou d'où vient) l'essentiel des flux : par défaut les DÉPENSES (outflow).
 *
 * Présentationnel PUR (UI_GUIDELINES) : reçoit `ConcentrationVendors` (lignes déjà
 * triées par montant décroissant, agrégées EN SQL) ; NE recalcule aucun montant. Les
 * montants sont des CHAÎNES décimales formatées via `formatMontant` (zéro float, règle
 * 8). `part` (fraction 0..1) ne sert QU'À la géométrie de la barre de proportion — un
 * cul-de-sac `Number()` qui ne réinjecte jamais dans un montant affiché.
 *
 * Multi-devises (CLAUDE.md règle 8) : les lignes peuvent porter des devises
 * différentes ; on les GROUPE par devise (jamais d'addition cross-devise), `part`
 * restant relative au total de SA devise. En mono-devise, pas d'en-tête de groupe.
 *
 * Couleurs (§3.1) : la barre porte la couleur du SENS (sorties `outflow`, entrées
 * `inflow`) — vert/rouge réservés à la donnée. Le libellé peut tronquer (nom de
 * contrepartie) ; le MONTANT ne tronque JAMAIS (`tabular-nums`, `whitespace-nowrap`).
 */
import type {
  ConcentrationVendors,
  DirectionVendors,
  LigneVendor,
} from "@/server/insights/types";

import { formatMontant } from "@/lib/format-montant";
import {
  StateCard,
  StateIllustration,
} from "@/components/dashboard/states/primitives";

/** Libellé de l'axe analysé selon la direction (titre + sous-titre de la carte). */
const LIBELLE_DIRECTION: Record<
  DirectionVendors,
  { titre: string; sousTitre: string; sens: "inflow" | "outflow" }
> = {
  outflow: {
    titre: "Top contreparties",
    sousTitre: "Principaux postes de dépenses",
    sens: "outflow",
  },
  inflow: {
    titre: "Top contreparties",
    sousTitre: "Principales sources de recettes",
    sens: "inflow",
  },
  both: {
    titre: "Top contreparties",
    sousTitre: "Postes les plus importants",
    sens: "outflow",
  },
};

export function TopVendorsCard({
  concentration,
}: {
  concentration: ConcentrationVendors;
}) {
  const { direction, lignes } = concentration;
  const meta = LIBELLE_DIRECTION[direction];

  // Devises présentes (ordre d'apparition = ordre du tri par montant décroissant).
  const devises = lignes.reduce<string[]>((acc, l) => {
    if (!acc.includes(l.currency)) acc.push(l.currency);
    return acc;
  }, []);
  const multiDevise = devises.length > 1;

  return (
    <StateCard>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text">{meta.titre}</h2>
          <p className="mt-0.5 text-xs text-text-muted">{meta.sousTitre}</p>
        </div>
      </div>

      {lignes.length === 0 ? (
        <VendorsVide />
      ) : (
        <div className="flex flex-col gap-5">
          {devises.map((devise) => (
            <div key={devise}>
              {multiDevise && (
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                  {devise}
                </p>
              )}
              <ul className="flex flex-col gap-3">
                {lignes
                  .filter((l) => l.currency === devise)
                  .map((ligne, i) => (
                    <LigneContrepartie
                      key={`${devise}-${ligne.contrepartie}-${i}`}
                      ligne={ligne}
                      sens={meta.sens}
                    />
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </StateCard>
  );
}

/** Une contrepartie : libellé (tronquable) + montant (jamais tronqué) + barre de part. */
function LigneContrepartie({
  ligne,
  sens,
}: {
  ligne: LigneVendor;
  sens: "inflow" | "outflow";
}) {
  const pct = pourcentageLargeur(ligne.part);
  const couleurBarre = sens === "outflow" ? "bg-outflow" : "bg-inflow";

  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] text-text" title={ligne.contrepartie}>
          {ligne.contrepartie}
        </span>
        <span className="whitespace-nowrap text-[13px] font-semibold tabular-nums text-text">
          {formatMontant(ligne.montant, ligne.currency)}
        </span>
      </div>
      {/* Barre de proportion (part du total de la devise). Géométrie pure. */}
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-inset">
        <div
          className={`h-full rounded-full ${couleurBarre}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </li>
  );
}

/** État vide : pas encore de contreparties (pas une erreur). */
function VendorsVide() {
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center text-center">
      <StateIllustration
        variant="empty"
        className="mb-3 h-12 w-12 text-text-faint"
      />
      <p className="text-sm font-medium text-text">Aucune contrepartie</p>
      <p className="mt-1 max-w-xs text-xs text-text-muted">
        Les postes les plus importants apparaîtront ici dès que des transactions
        seront catégorisées.
      </p>
    </div>
  );
}

/**
 * `part` (chaîne décimale 0..1) → largeur en % pour la barre. GÉOMÉTRIE uniquement
 * (cul-de-sac float, ne réinjecte aucun montant). Bornée [0, 100] ; une part absente/
 * non finie → 0. On garde un minimum visuel de 2 % pour qu'une toute petite barre
 * reste perceptible (sans mentir sur l'ordre, le tri reste celui des montants).
 */
function pourcentageLargeur(part: string): number {
  const n = Number(part);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const pct = Math.min(100, n * 100);
  return Math.max(2, pct);
}
