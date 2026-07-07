/**
 * Carte « Synthèse du mois » — vision Entrées / Sorties / Variation nette du mois
 * courant. Refonte Dodo (maquette Dodo.dc.html §Synthèse du mois) : posée dans la
 * COLONNE DROITE (1fr) du dashboard, à côté de la carte Flux (2fr). Le format passe
 * de deux blocs teintés côte à côte à des LIGNES EMPILÉES (Entrées / Sorties /
 * Variation nette), plus lisibles dans une colonne étroite et symétriques avec la
 * hauteur de la carte Flux.
 *
 * Présentationnel PUR : reçoit `synthesesMois` (sortie du service
 * `syntheseMoisParDevise`, déjà agrégée EN SQL) + le mois courant, NE recalcule
 * rien. Montants formatés via `formatMontant` (chaînes décimales, zéro float — règle 8).
 *
 * ⚠️ Multi-devises (CLAUDE.md règle 8) : `syntheseMoisParDevise` renvoie UNE entrée
 * PAR devise (GROUP BY currency). On affiche donc un groupe Entrées/Sorties/Variation
 * PAR devise, empilé — JAMAIS d'addition cross-devise, aucune conversion FX (chantier
 * DASH-FX1). Mois sans transaction → tableau vide → on affiche 0 dans la devise de
 * base (repli `replierSynthesesMois`).
 *
 * Couleurs (§3.1) : vert/rouge réservés à la DONNÉE — entrées `inflow-700` / sorties
 * `outflow-700`, variation colorée par son signe. `tabular-nums` (§0) pour
 * l'alignement des chiffres. La note « aucune entrée » n'apparaît que si le flux
 * d'entrées est nul (aide contextuelle vers les échéances), en tokens neutres.
 */
import Link from "next/link";

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
  // Aide contextuelle : aucune ENTRÉE sur la 1re devise → on oriente vers les échéances.
  const aucuneEntree = estZero(lignes[0]!.entrees);

  return (
    <StateCard className="flex flex-col">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-text">Synthèse du mois</h2>
        <span className="text-xs text-text-muted">{formaterMoisAnnee(mois)}</span>
      </div>

      <div className="mt-4 flex flex-1 flex-col gap-6">
        {lignes.map((s) => (
          <BlocDevise key={s.currency} synthese={s} afficherDevise={multi} />
        ))}

        {aucuneEntree && (
          <p className="mt-auto rounded-control bg-surface-page px-3.5 py-3 text-[13px] leading-relaxed text-text-muted">
            Aucune entrée enregistrée ce mois-ci.{" "}
            <Link
              href="/echeances"
              className="font-semibold text-primary underline-offset-2 hover:underline
                focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                focus-visible:ring-offset-2 rounded-[2px]"
            >
              Voir les échéances à venir
            </Link>
          </p>
        )}
      </div>
    </StateCard>
  );
}

/** Groupe de synthèse pour UNE devise : lignes empilées Entrées / Sorties / Variation. */
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
      {/* En multi-devise, on étiquette chaque groupe par sa devise. */}
      {afficherDevise && (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
          {devise}
        </p>
      )}

      <LigneSynthese
        label="Entrées"
        valeur={formatMontant(synthese.entrees, devise, {
          signeExplicite: true,
        })}
        couleur="text-inflow-700"
      />
      <LigneSynthese
        label="Sorties"
        valeur={formatMontant(synthese.sorties, devise)}
        couleur="text-outflow-700"
      />
      <LigneSynthese
        label="Variation nette"
        valeur={formatMontant(synthese.variation, devise, {
          signeExplicite: true,
        })}
        couleur={couleurVariation}
        accent
        derniere
      />
    </div>
  );
}

/**
 * Une ligne Label ↔ Montant, séparée par un filet bas (sauf la dernière). `accent`
 * (variation nette) → label plus marqué et montant en gras. Montant jamais tronqué
 * (`whitespace-nowrap tabular-nums`, chiffre clé).
 */
function LigneSynthese({
  label,
  valeur,
  couleur,
  accent = false,
  derniere = false,
}: {
  label: string;
  valeur: string;
  couleur: string;
  accent?: boolean;
  derniere?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-3.5 ${
        derniere ? "" : "border-b border-line"
      }`}
    >
      <span
        className={
          accent
            ? "text-sm font-semibold text-text"
            : "text-sm text-text-muted"
        }
      >
        {label}
      </span>
      <span
        className={`whitespace-nowrap tabular-nums ${
          accent ? "text-lg font-bold" : "text-base font-semibold"
        } ${couleur}`}
      >
        {valeur}
      </span>
    </div>
  );
}
