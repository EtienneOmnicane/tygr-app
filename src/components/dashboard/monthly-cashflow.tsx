/**
 * Carte « Évolution mensuelle » — TABLEAU récapitulatif des entrées/sorties/variation
 * par mois sur la fenêtre N mois. COMPLÉMENTAIRE de l'ancre « Flux de trésorerie »
 * (`flux-tresorerie-card.tsx`) : l'ancre donne la FORME (courbe/barres), ce tableau
 * donne les VALEURS exactes par mois.
 *
 * Depuis L8a, les BARRES de cette carte ont migré dans l'ancre (vue « Barres »). Cette
 * carte ne garde QUE le tableau ; elle réutilise `projeterSurGrille` (axe continu,
 * réduction à la devise de base) depuis le module NEUTRE `flux-projection.ts` — ce
 * Server Component ne peut PAS importer de `flux-bars.tsx` (client) — pour ne PAS
 * dupliquer la logique de projection.
 *
 * Présentationnel PUR (UI_GUIDELINES) : reçoit la SÉRIE mensuelle DÉJÀ agrégée en SQL
 * (`syntheseParMois` → une ligne par (mois, devise)) + la GRILLE des mois attendus
 * (`grilleMois`) + la devise de base. NE recalcule aucun total, NE fetch rien. Montants
 * formatés via `formatMontant` sur les chaînes décimales (zéro float — règle 8).
 *
 * ⚠️ Multi-devises (CLAUDE.md règle 8) : on n'additionne JAMAIS des devises. La carte est
 * MONO-AFFICHÉE (décision PO 2026-06-22) : pour chaque mois on lit la ligne de la devise
 * de BASE ; s'il existe d'autres devises ce mois-là, on le SIGNALE (« + autres devises »)
 * sans rien sommer. La conversion FX est un chantier séparé (DASH-FX1).
 *
 * Couleurs (§3.1) : vert/rouge réservés à la DONNÉE — entrées `inflow` / sorties
 * `outflow`. `tabular-nums` (§0) pour aligner les chiffres du tableau.
 */
import { formaterMoisAnnee } from "@/lib/format-date";
import { formatMontant } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";
import {
  projeterSurGrille,
  type MoisAffiche,
} from "@/components/dashboard/flux-projection";
import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

export function MonthlyCashflow({
  serie,
  grille,
  devise = "MUR",
  libellePeriode,
}: {
  /** Série mensuelle à plat (mois × devise), agrégée en SQL (`syntheseParMois`). */
  serie: SyntheseMensuelle[];
  /** Mois attendus, du plus ancien au plus récent (`grilleMois`) — axe continu. */
  grille: string[];
  /** Devise de base du workspace (affichage mono-devise, cf. note multidevise). */
  devise?: string;
  /**
   * Libellé de la fenêtre appliquée, fourni par la page (source unique). ⚠️ Ne PAS le
   * dériver de `grille.length` (« N derniers mois ») : sous une PLAGE précise passée, la
   * fenêtre n'est pas « les N derniers mois » — et les mois d'extrémité sont PARTIELS.
   */
  libellePeriode?: string;
}) {
  const mois = projeterSurGrille(serie, grille, devise);
  // Vide = aucun mouvement sur toute la fenêtre dans la devise de base.
  const aucunMouvement = mois.every(
    (m) => m.entrees === "0" && m.sorties === "0",
  );
  const ilExisteAutresDevises = mois.some((m) => m.autresDevises);

  return (
    <StateCard>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text">Évolution mensuelle</h2>
        <span className="text-xs text-text-muted">
          {libellePeriode ?? `${mois.length} derniers mois`}
        </span>
      </div>

      {aucunMouvement ? (
        <p className="mt-6 mb-2 text-center text-sm text-text-muted">
          Pas encore de mouvement sur la période.
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          {/* min-w : sous ~620px de conteneur (sidebar ouverte <1024), les colonnes
              gardent leur largeur et le conteneur scrolle — jamais un montant
              écrasé/coupé en plein chiffre (règle 8 : un montant ne tronque pas). */}
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-text-muted">
                <th className="py-2 pr-3 font-medium">Mois</th>
                <th className="py-2 px-3 text-right font-medium">Entrées</th>
                <th className="py-2 px-3 text-right font-medium">Sorties</th>
                <th className="py-2 pl-3 text-right font-medium">Variation</th>
              </tr>
            </thead>
            <tbody>
              {mois.map((m) => (
                <LigneMois key={m.libelleMois} mois={m} devise={devise} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Note multi-devises : présente dès qu'un mois porte une autre devise. */}
      {ilExisteAutresDevises && (
        <p className="mt-3 text-[11px] text-text-faint">
          Certains mois comportent aussi des mouvements dans d’autres devises, non
          additionnés ici (affichage en {devise}).
        </p>
      )}
    </StateCard>
  );
}

/** Une ligne du tableau : mois + entrées (vert) + sorties (rouge) + variation. */
function LigneMois({ mois, devise }: { mois: MoisAffiche; devise: string }) {
  const variationNegative = mois.variation.trim().startsWith("-");
  const variationNulle = mois.variation === "0" || mois.variation === "0.00";
  const couleurVariation = variationNulle
    ? "text-text"
    : variationNegative
      ? "text-outflow-700"
      : "text-inflow-700";

  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="py-2 pr-3 whitespace-nowrap text-text">
        {formaterMoisAnnee(mois.libelleMois)}
        {mois.autresDevises && (
          <span
            className="ml-1.5 align-middle text-[10px] text-text-faint"
            title="Mouvements aussi dans d’autres devises (non additionnés)"
          >
            + autres devises
          </span>
        )}
      </td>
      <td className="py-2 px-3 text-right whitespace-nowrap tabular-nums text-inflow-700">
        {formatMontant(mois.entrees, devise, { signeExplicite: true })}
      </td>
      <td className="py-2 px-3 text-right whitespace-nowrap tabular-nums text-outflow-700">
        {formatMontant(mois.sorties, devise)}
      </td>
      <td
        className={`py-2 pl-3 text-right font-medium whitespace-nowrap tabular-nums ${couleurVariation}`}
      >
        {formatMontant(mois.variation, devise, { signeExplicite: true })}
      </td>
    </tr>
  );
}
