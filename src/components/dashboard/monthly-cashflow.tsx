/**
 * `TableauEvolution` — TABLEAU récapitulatif des entrées/sorties/variation par mois sur
 * la fenêtre. Vue « Tableau » de l'ancre « Flux de trésorerie » (toggle L1,
 * `flux-tresorerie-card.tsx`) : le graphe donne la FORME (barres), ce tableau donne les
 * VALEURS exactes par mois. Les DEUX consomment la MÊME série (invariant anti-divergence).
 *
 * Depuis L1 (PLAN-graphs-fygr), le tableau vit SOUS le toggle de l'ancre : il ne porte
 * donc plus sa propre carte ni son propre titre (l'hôte les fournit) — d'où l'extraction
 * du wrapper `MonthlyCashflow`/`StateCard`, qui aurait imbriqué deux cartes. Il réutilise
 * `projeterSurGrille` (axe continu, réduction à la devise choisie) depuis le module NEUTRE
 * `flux-projection.ts`.
 *
 * Présentationnel PUR (UI_GUIDELINES) : reçoit la SÉRIE mensuelle DÉJÀ agrégée en SQL
 * (`syntheseParMois` → une ligne par (mois, devise)) + la GRILLE des mois attendus
 * (`grilleMois`) + la devise affichée. NE recalcule aucun total, NE fetch rien. Montants
 * formatés via `formatMontant` sur les chaînes décimales (zéro float — règle 8).
 *
 * ⚠️ Multi-devises (CLAUDE.md règle 8) : on n'additionne JAMAIS des devises. MONO-AFFICHÉ
 * sur la devise choisie (sélecteur L3) ; s'il existe d'autres devises un mois donné, on le
 * SIGNALE (« + autres devises ») sans rien sommer. Conversion FX = chantier séparé (DASH-FX1).
 *
 * Couleurs (§3.1) : vert/rouge réservés à la DONNÉE — entrées `inflow` / sorties
 * `outflow`. `tabular-nums` (§0) pour aligner les chiffres du tableau.
 */
import { formatMontant } from "@/lib/format-montant";
import {
  projeterSurGrille,
  type MoisAffiche,
} from "@/components/dashboard/flux-projection";
import { etiquetteBucket } from "@/components/charts/etiquette-bucket";
import type { GranulariteBucket } from "@/components/charts/grille-buckets";
import type { SyntheseMensuelle } from "@/server/repositories/dashboard";

/** En-tête de la première colonne selon la granularité (L2). */
const ENTETE_BUCKET: Record<GranulariteBucket, string> = {
  jour: "Jour",
  semaine: "Semaine",
  mois: "Mois",
};

export function TableauEvolution({
  serie,
  grille,
  devise = "MUR",
  granularite = "mois",
}: {
  /** Série à plat (bucket × devise), agrégée en SQL (`syntheseParMois`/`cashflowParDevise`). */
  serie: SyntheseMensuelle[];
  /** Buckets attendus, du plus ancien au plus récent (grille) — axe continu. */
  grille: string[];
  /** Devise affichée (sélecteur L3 ; défaut = devise de base). */
  devise?: string;
  /** Granularité des buckets (en-tête + format de la 1re colonne). Défaut « mois ». */
  granularite?: GranulariteBucket;
}) {
  const mois = projeterSurGrille(serie, grille, devise);
  // Vide = aucun mouvement sur toute la fenêtre dans la devise affichée.
  const aucunMouvement = mois.every(
    (m) => m.entrees === "0" && m.sorties === "0",
  );
  const ilExisteAutresDevises = mois.some((m) => m.autresDevises);

  if (aucunMouvement) {
    return (
      <p className="mt-6 mb-2 text-center text-sm text-text-muted">
        Pas encore de mouvement sur la période.
      </p>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        {/* min-w : sous ~620px de conteneur (sidebar ouverte <1024), les colonnes
            gardent leur largeur et le conteneur scrolle — jamais un montant
            écrasé/coupé en plein chiffre (règle 8 : un montant ne tronque pas). */}
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-text-muted">
              <th className="py-2 pr-3 font-medium">
                {ENTETE_BUCKET[granularite]}
              </th>
              <th className="py-2 px-3 text-right font-medium">Entrées</th>
              <th className="py-2 px-3 text-right font-medium">Sorties</th>
              <th className="py-2 pl-3 text-right font-medium">Variation</th>
            </tr>
          </thead>
          <tbody>
            {mois.map((m) => (
              <LigneMois
                key={m.libelleMois}
                mois={m}
                devise={devise}
                granularite={granularite}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Note multi-devises : présente dès qu'un mois porte une autre devise. */}
      {ilExisteAutresDevises && (
        <p className="mt-3 text-[11px] text-text-faint">
          Certains mois comportent aussi des mouvements dans d’autres devises, non
          additionnés ici (affichage en {devise}).
        </p>
      )}
    </div>
  );
}

// Zéro = absence de donnée, pas une donnée verte/rouge : rendu `text-faint`
// (§4.1 — le vert/rouge sémantique est réservé aux mouvements réels ; un mois
// vide coloré est du bruit).
function estNul(montant: string): boolean {
  return montant === "0" || montant === "0.00";
}

/** Une ligne du tableau : bucket + entrées (vert) + sorties (rouge) + variation. */
function LigneMois({
  mois,
  devise,
  granularite,
}: {
  mois: MoisAffiche;
  devise: string;
  granularite: GranulariteBucket;
}) {
  const variationNegative = mois.variation.trim().startsWith("-");
  const couleurVariation = estNul(mois.variation)
    ? "text-text-faint"
    : variationNegative
      ? "text-outflow-700"
      : "text-inflow-700";
  const couleurEntrees = estNul(mois.entrees)
    ? "text-text-faint"
    : "text-inflow-700";
  const couleurSorties = estNul(mois.sorties)
    ? "text-text-faint"
    : "text-outflow-700";

  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="py-2 pr-3 whitespace-nowrap text-text">
        {etiquetteBucket(granularite, mois.libelleMois).complet}
        {mois.autresDevises && (
          <span
            className="ml-1.5 align-middle text-[11px] text-text-faint"
            title="Mouvements aussi dans d’autres devises (non additionnés)"
          >
            + autres devises
          </span>
        )}
      </td>
      <td
        className={`py-2 px-3 text-right whitespace-nowrap tabular-nums ${couleurEntrees}`}
      >
        {formatMontant(mois.entrees, devise, { signeExplicite: true })}
      </td>
      <td
        className={`py-2 px-3 text-right whitespace-nowrap tabular-nums ${couleurSorties}`}
      >
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
