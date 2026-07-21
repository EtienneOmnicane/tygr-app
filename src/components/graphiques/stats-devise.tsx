"use client";

/**
 * Bandeau de statistiques d'en-tête d'une carte de répartition, POUR UNE devise (L2 +
 * L3). Rend une donnée « maigre » plus lisible sans jamais masquer la réalité — le KPI
 * de COUVERTURE (% catégorisé) EXPOSE le fait qu'un workspace peu catégorisé produit un
 * donut pauvre, plutôt que de le cacher. Cinq indicateurs :
 *   - Moyenne / opération : `devise.montantMoyen` (total/nb, calculé EN SQL — règle 8).
 *   - Parts : nombre de PARTS catégorisées (hors « Non catégorisé »), COMPTÉ en JS sur
 *     `parts` (compter des éléments ≠ additionner des montants → autorisé).
 *   - Catégorisé : couverture = 1 − part non-catégorisée (ratio d'AFFICHAGE, cul-de-sac
 *     float — jamais réinjecté dans un montant).
 *   - Plus grosse part (L3) : 1re part catégorisée (parts déjà triées montant
 *     décroissant, « Non catégorisé » repoussé en fin) + sa part.
 *   - Concentration top 3 (L3) : part cumulée des 3 premières PARTS (somme de FRACTIONS,
 *     ratio d'affichage — pas une addition de montants).
 *
 * ⚠️ POURQUOI « PART » ET NON « POSTE »/« CATÉGORIE » (2026-07-21). Depuis l'axe de
 * catégorie EFFECTIVE, une même catégorie peut légitimement produire DEUX parts : la
 * fraction ventilée par l'utilisateur (origine TYGR) et son reliquat resté sur la
 * catégorie bancaire (origine AMONT). « Poste dominant » annonçait donc la plus grosse
 * PART en la faisant passer pour la plus grosse CATÉGORIE — sur un jeu réel, « Fournisseurs
 * 29 % » là où « Loyer » pesait 46 % en cumulant ses deux parts. Les libellés disent
 * maintenant exactement ce qui est calculé, et ce que le donut montre (le plus gros
 * SECTEUR est bien celui-là). Le cumul par catégorie exigerait d'additionner des montants
 * — INTERDIT côté JS (règle 8) : il se ferait en SQL. Dette `STATS-CUMUL-CATEGORIE1`.
 *
 * Présentationnel pur (CLAUDE.md) : aucun fetch, aucun état, tokens sémantiques
 * uniquement (aucune couleur en dur, pas de vert/rouge — ce ne sont pas des montants
 * signés). Les montants viennent de `format-montant.ts`, les ratios de `pourcent-part.ts`.
 */
import { formatMontant } from "@/lib/format-montant";
import type { RepartitionDevise } from "@/server/insights/types";

import { pourcentPart } from "./pourcent-part";

/** Number() borné [0,1] d'une fraction d'affichage (cul-de-sac float, jamais un montant). */
function fractionSure(part: string): number {
  const n = Number(part);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Une cellule de statistique : libellé discret + valeur. */
function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-faint">
        {label}
      </dt>
      <dd className="min-w-0 text-sm font-semibold tabular-nums text-text">
        {children}
      </dd>
    </div>
  );
}

export function StatsDevise({ devise }: { devise: RepartitionDevise }) {
  // Parts CATÉGORISÉES (déjà triées montant décroissant) et poste non-catégorisé.
  const categorisees = devise.parts.filter((p) => !p.estNonCategorise);
  const nonCat = devise.parts.find((p) => p.estNonCategorise);

  // Couverture = 1 − part non-catégorisée (ratio d'affichage). Bornée [0,1] par sûreté.
  const couverture = Math.max(0, Math.min(1, 1 - fractionSure(nonCat?.part ?? "0")));

  // Plus grosse part + concentration top 3 (s'il existe au moins une part catégorisée).
  const dominant = categorisees[0];
  const top3 = categorisees
    .slice(0, 3)
    .reduce((s, p) => s + fractionSure(p.part), 0);

  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-3 border-t border-line pt-4">
      <Stat label="Moyenne / opération">
        <span className="whitespace-nowrap">
          {formatMontant(devise.montantMoyen, devise.currency)}
        </span>
      </Stat>

      <Stat label="Parts">{categorisees.length}</Stat>

      <Stat label="Catégorisé">{pourcentPart(String(couverture))}</Stat>

      {dominant ? (
        <Stat label="Plus grosse part">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="min-w-0 max-w-[10rem] truncate" title={dominant.categorie}>
              {dominant.categorie}
            </span>
            <span className="shrink-0 text-xs font-normal text-text-faint">
              {pourcentPart(dominant.part)}
            </span>
          </span>
        </Stat>
      ) : null}

      {categorisees.length > 0 ? (
        <Stat label="Concentration top 3">{pourcentPart(String(top3))}</Stat>
      ) : null}
    </dl>
  );
}
