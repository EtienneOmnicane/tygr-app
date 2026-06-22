/**
 * Carte « Synthèse du mois » — vision Entrées / Sorties (Cash In / Cash Out) du
 * mois courant, posée dans la zone principale du dashboard, AU-DESSUS de la table
 * des transactions (demande métier 2026-06-22). Rend clairement visibles les deux
 * flux que la carte « Détails » du side-panel n'exposait que discrètement.
 *
 * Présentationnel PUR : reçoit `syntheseMois` (sortie du service `syntheseMois`,
 * déjà agrégée EN SQL) + la devise de base, NE recalcule rien. Montants formatés
 * via `formatMontant` (chaînes décimales, zéro float — règle 8).
 *
 * ⚠️ Multi-devises (CLAUDE.md règle 8) : `syntheseMois` somme `amount` SANS
 * GROUP BY devise (simplification mono-devise du MVP, alignée sur le side-panel
 * qui l'affiche déjà avec `base_currency`). On reproduit STRICTEMENT cette
 * convention — on n'invente aucun taux ni agrégat cross-devise (FX = chantier
 * DASH-FX1, hors périmètre). Affichage donc dans la devise de base.
 *
 * Couleurs (§3.1) : vert/rouge réservés à la DONNÉE — entrées `inflow` / sorties
 * `outflow`. Fonds `inflow-bg` / `outflow-bg` (teintes douces) pour séparer les
 * deux blocs sans crier. `tabular-nums` (§0) pour l'alignement des chiffres.
 */
import type { SyntheseMois } from "@/server/repositories/dashboard";

import { formaterMoisAnnee } from "@/lib/format-date";
import { formatMontant, estNegatif, estZero } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";

export function CashFlowSummary({
  syntheseMois,
  devise = "MUR",
}: {
  /** Entrées / sorties / variation du mois (chaînes décimales, déjà agrégées). */
  syntheseMois: SyntheseMois;
  /** Devise de base du workspace (affichage mono-devise, cf. note multidevise). */
  devise?: string;
}) {
  // La variation peut être positive (excédent), négative (déficit) ou nulle.
  const variationNegative = estNegatif(syntheseMois.variation);
  const variationNulle = estZero(syntheseMois.variation);
  const couleurVariation = variationNulle
    ? "text-text"
    : variationNegative
      ? "text-outflow-700"
      : "text-inflow-700";

  return (
    <StateCard>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Synthèse du mois</h2>
        <span className="text-xs text-text-muted">
          {formaterMoisAnnee(syntheseMois.libelleMois)}
        </span>
      </div>

      {/* Deux flux côte à côte : Entrées (vert) / Sorties (rouge). */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FluxBloc
          sens="entree"
          label="Entrées"
          valeur={formatMontant(syntheseMois.entrees, devise, {
            signeExplicite: true,
          })}
        />
        <FluxBloc
          sens="sortie"
          label="Sorties"
          valeur={formatMontant(syntheseMois.sorties, devise)}
        />
      </div>

      {/* Variation nette = entrées − sorties (déjà calculée en SQL). */}
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="text-[13px] font-medium text-text-muted">
          Variation nette
        </span>
        <span
          className={`text-lg font-semibold tabular-nums ${couleurVariation}`}
        >
          {formatMontant(syntheseMois.variation, devise, {
            signeExplicite: true,
          })}
        </span>
      </div>
    </StateCard>
  );
}

/**
 * Bloc d'un flux (entrée ou sortie) : pastille fléchée + libellé + montant. Fond
 * teinté doux propre au sens (jamais une couleur sémantique pour autre chose que
 * la donnée, §3.1).
 */
function FluxBloc({
  sens,
  label,
  valeur,
}: {
  sens: "entree" | "sortie";
  label: string;
  valeur: string;
}) {
  const entree = sens === "entree";
  return (
    <div
      className={`flex items-center gap-3 rounded-control p-3 ${
        entree ? "bg-inflow-bg" : "bg-outflow-bg"
      }`}
    >
      <span
        aria-hidden
        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
          entree ? "bg-inflow/12 text-inflow-700" : "bg-outflow/12 text-outflow-700"
        }`}
      >
        <FlecheFlux entree={entree} />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
          {label}
        </p>
        <p
          className={`truncate text-xl font-bold leading-tight tabular-nums ${
            entree ? "text-inflow-700" : "text-outflow-700"
          }`}
        >
          {valeur}
        </p>
      </div>
    </div>
  );
}

/** Flèche montante (entrée) ou descendante (sortie), outline currentColor. */
function FlecheFlux({ entree }: { entree: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      {entree ? (
        <>
          <path d="M12 19V5" />
          <path d="m6 11 6-6 6 6" />
        </>
      ) : (
        <>
          <path d="M12 5v14" />
          <path d="m6 13 6 6 6-6" />
        </>
      )}
    </svg>
  );
}
