/**
 * Carte « Synthèse du mois » — vision Entrées / Sorties (Cash In / Cash Out) du
 * mois courant, posée dans la zone principale du dashboard, AU-DESSUS de la table
 * des transactions (demande métier 2026-06-22). Rend clairement visibles les deux
 * flux que la carte « Détails » du side-panel n'exposait que discrètement.
 *
 * Présentationnel PUR : reçoit `synthesesMois` (sortie du service
 * `syntheseMoisParDevise`, déjà agrégée EN SQL) + le mois courant, NE recalcule
 * rien. Montants formatés via `formatMontant` (chaînes décimales, zéro float — règle 8).
 *
 * ⚠️ Multi-devises (CLAUDE.md règle 8) : `syntheseMoisParDevise` renvoie UNE entrée
 * PAR devise (GROUP BY currency). On affiche donc un bloc Entrées/Sorties/Variation
 * PAR devise, côte à côte — JAMAIS d'addition cross-devise, aucune conversion FX
 * (chantier DASH-FX1). Mois sans transaction → tableau vide → on affiche 0 dans la
 * devise de base (repli `replierSynthesesMois`).
 *
 * Couleurs (§3.1) : vert/rouge réservés à la DONNÉE — entrées `inflow` / sorties
 * `outflow`. Fonds `inflow-bg` / `outflow-bg` (teintes douces) pour séparer les
 * deux blocs sans crier. `tabular-nums` (§0) pour l'alignement des chiffres.
 */
import type { SyntheseMoisDevise } from "@/server/repositories/dashboard";

import { replierSynthesesMois } from "@/lib/synthese-mois";
import { formaterMoisAnnee } from "@/lib/format-date";
import { formatMontant, estNegatif, estZero } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";

export function CashFlowSummary({
  synthesesMois,
  mois,
  devise = "MUR",
}: {
  /** Entrées/sorties/variation du mois PAR DEVISE (chaînes décimales, déjà agrégées). */
  synthesesMois: SyntheseMoisDevise[];
  /** Mois courant "YYYY-MM" (libellé de la carte). */
  mois: string;
  /** Devise de base du workspace (repli quand aucune transaction le mois). */
  devise?: string;
}) {
  // Repli : aucune donnée le mois → 0 dans la devise de base (jamais une carte vide).
  const lignes = replierSynthesesMois(synthesesMois, devise);
  const multi = lignes.length > 1;

  return (
    <StateCard>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text">Synthèse du mois</h2>
        <span className="text-xs text-text-muted">{formaterMoisAnnee(mois)}</span>
      </div>

      <div className="mt-4 flex flex-col gap-5">
        {lignes.map((s) => (
          <BlocDevise key={s.currency} synthese={s} afficherDevise={multi} />
        ))}
      </div>
    </StateCard>
  );
}

/** Bloc de synthèse pour UNE devise (entrées/sorties côte à côte + variation). */
function BlocDevise({
  synthese,
  afficherDevise,
}: {
  synthese: SyntheseMoisDevise;
  afficherDevise: boolean;
}) {
  const devise = synthese.currency;
  // La variation peut être positive (excédent), négative (déficit) ou nulle.
  const variationNegative = estNegatif(synthese.variation);
  const variationNulle = estZero(synthese.variation);
  const couleurVariation = variationNulle
    ? "text-text"
    : variationNegative
      ? "text-outflow-700"
      : "text-inflow-700";

  return (
    <div>
      {/* En multi-devise, on étiquette chaque bloc par sa devise. */}
      {afficherDevise && (
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {devise}
        </p>
      )}

      {/* Deux flux côte à côte : Entrées (vert) / Sorties (rouge). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FluxBloc
          sens="entree"
          label="Entrées"
          valeur={formatMontant(synthese.entrees, devise, {
            signeExplicite: true,
          })}
        />
        <FluxBloc
          sens="sortie"
          label="Sorties"
          valeur={formatMontant(synthese.sorties, devise)}
        />
      </div>

      {/* Variation nette = entrées − sorties (déjà calculée en SQL). */}
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="text-[13px] font-medium text-text-muted">
          Variation nette
        </span>
        <span className={`text-lg font-semibold tabular-nums ${couleurVariation}`}>
          {formatMontant(synthese.variation, devise, { signeExplicite: true })}
        </span>
      </div>
    </div>
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
