/**
 * Carte « Synthèse du mois » — vision Entrées / Sorties / Variation nette du mois
 * courant. Refonte Dodo (maquette Dodo.dc.html §Synthèse du mois).
 *
 * DISPOSITION (prop `disposition`, le conteneur décide — composant présentationnel pur) :
 *   - "empile" (défaut) : lignes empilées Entrées / Sorties / Variation, une pile par
 *     devise — format historique, adapté à une colonne étroite.
 *   - "bandeau" : posée PLEINE LARGEUR sous le graphe de flux (retrait de la carte
 *     « Comptes connectés », DASH-RETIRER-COMPTES-CONNECTES1). Mono-devise → 3 colonnes
 *     KPI Entrées | Sorties | Variation (symétrique, comble l'espace sous le graphe) ;
 *     multi-devise → repli sur les piles par devise disposées en grille bornée (évite
 *     l'étalement d'une pile unique sur toute la largeur).
 *
 * Présentationnel PUR : reçoit `synthesesMois` (sortie du service
 * `synthesePeriodeParDevise`, déjà agrégée EN SQL) + le mois courant, NE recalcule
 * rien. Montants formatés via `formatMontant` (chaînes décimales, zéro float — règle 8).
 *
 * ⚠️ Multi-devises (CLAUDE.md règle 8) : `synthesePeriodeParDevise` renvoie UNE entrée
 * PAR devise (GROUP BY currency). On affiche donc un groupe Entrées/Sorties/Variation
 * PAR devise — JAMAIS d'addition cross-devise, aucune conversion FX (chantier DASH-FX1).
 * Mois sans transaction → tableau vide → 0 dans la devise de base (repli
 * `replierSynthesesMois`).
 *
 * Couleurs (§3.1) : vert/rouge réservés à la DONNÉE — entrées `inflow-700` / sorties
 * `outflow-700`, variation colorée par son signe. `tabular-nums` (§0) pour l'alignement
 * des chiffres. La note « aucune entrée » n'apparaît que si le flux d'entrées est nul
 * (aide contextuelle vers les échéances), en tokens neutres.
 */
import Link from "next/link";

import type { SynthesePeriodeDevise } from "@/server/repositories/dashboard";

import { replierSynthesesMois } from "@/lib/synthese-mois";
import { formatMontant, estNegatif, estZero } from "@/lib/format-montant";
import { StateCard } from "@/components/dashboard/states/primitives";

export function CashFlowSummary({
  synthesesMois,
  titre = "Synthèse du mois",
  libelle,
  devise = "MUR",
  disposition = "empile",
}: {
  /** Entrées/sorties/variation de la période PAR DEVISE (chaînes décimales, déjà agrégées). */
  synthesesMois: SynthesePeriodeDevise[];
  /**
   * Titre de la carte. « Synthèse du mois » sous un preset ; « Synthèse de la période »
   * quand une PLAGE PRÉCISE (`?du`/`?au`) borne l'écran — la carte agrège alors la plage,
   * pas un mois (TOOLBAR-DATE-PRECISE1). Le titre DOIT suivre ce qu'on agrège.
   */
  titre?: string;
  /** Ce que la carte agrège vraiment : « Juin 2026 » ou « 3 mars → 17 avr. 2026 ». */
  libelle: string;
  /** Devise de base du workspace (repli quand aucune transaction sur la période). */
  devise?: string;
  /**
   * Mise en page — le CONTENEUR décide (composant pur) : "empile" (colonne étroite,
   * défaut historique) ou "bandeau" (pleine largeur sous le graphe, mono-devise en
   * 3 colonnes KPI).
   */
  disposition?: "empile" | "bandeau";
}) {
  // Repli : aucune donnée le mois → 0 dans la devise de base (jamais une carte vide).
  const lignes = replierSynthesesMois(synthesesMois, devise);
  const multi = lignes.length > 1;
  // Aide contextuelle : aucune ENTRÉE sur la 1re devise → on oriente vers les échéances.
  const aucuneEntree = estZero(lignes[0]!.entrees);
  const bandeau = disposition === "bandeau";

  return (
    <StateCard className="flex flex-col">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-text">{titre}</h2>
        <span className="text-xs text-text-muted">{libelle}</span>
      </div>

      {bandeau ? (
        <div className="mt-5">
          {multi ? (
            /* Multi-devise : piles par devise en grille bornée — évite l'étalement
               d'une pile unique sur toute la largeur (jamais d'addition cross-devise). */
            <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
              {lignes.map((s) => (
                <BlocDevise key={s.currency} synthese={s} afficherDevise />
              ))}
            </div>
          ) : (
            /* Mono-devise : bandeau 3 colonnes KPI (symétrique) ; empile sous `sm`. */
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              <ColonneKpi
                label="Entrées"
                valeur={formatMontant(lignes[0]!.entrees, lignes[0]!.currency, {
                  signeExplicite: true,
                })}
                couleur={couleurSens(lignes[0]!.entrees, "text-inflow-700")}
              />
              <ColonneKpi
                label="Sorties"
                valeur={formatMontant(lignes[0]!.sorties, lignes[0]!.currency)}
                couleur={couleurSens(lignes[0]!.sorties, "text-outflow-700")}
              />
              <ColonneKpi
                label="Variation nette"
                valeur={formatMontant(lignes[0]!.variation, lignes[0]!.currency, {
                  signeExplicite: true,
                })}
                couleur={couleurVariation(lignes[0]!.variation)}
              />
            </div>
          )}

          {aucuneEntree && <NoteAucuneEntree className="mt-6" />}
        </div>
      ) : (
        /* Disposition empilée (défaut historique — colonne étroite, inchangée). */
        <div className="mt-4 flex flex-1 flex-col gap-6">
          {lignes.map((s) => (
            <BlocDevise key={s.currency} synthese={s} afficherDevise={multi} />
          ))}

          {aucuneEntree && <NoteAucuneEntree className="mt-auto" />}
        </div>
      )}
    </StateCard>
  );
}

/**
 * Couleur d'un montant de VARIATION selon son signe (§3.1) : excédent → inflow,
 * déficit → outflow, nul → `text-faint` (zéro = donnée absente, pas une donnée
 * verte/rouge — même règle que l'Évolution mensuelle, FINDING-007). Source UNIQUE
 * de la règle, partagée par `BlocDevise` (empilé) ET le bandeau mono-devise.
 */
function couleurVariation(variation: string): string {
  if (estZero(variation)) return "text-text-faint";
  return estNegatif(variation) ? "text-outflow-700" : "text-inflow-700";
}

/** Couleur de SENS (entrées/sorties) : zéro = donnée absente → `text-faint` (§4.1). */
function couleurSens(montant: string, couleur: string): string {
  return estZero(montant) ? "text-text-faint" : couleur;
}

/**
 * Colonne KPI du bandeau (mono-devise) : label de section au-dessus, montant coloré
 * dessous — échelle KPI (§2.1 : label 11px uppercase, montant 18px/600 tabular).
 */
function ColonneKpi({
  label,
  valeur,
  couleur,
}: {
  label: string;
  valeur: string;
  couleur: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {label}
      </span>
      {/* Montant jamais tronqué (chiffre clé, règle 8) : `whitespace-nowrap tabular-nums`. */}
      <span
        className={`whitespace-nowrap text-lg font-semibold tabular-nums ${couleur}`}
      >
        {valeur}
      </span>
    </div>
  );
}

/** Aide contextuelle « aucune entrée » → lien vers les échéances (tokens neutres). */
function NoteAucuneEntree({ className = "" }: { className?: string }) {
  return (
    <p
      className={`rounded-control bg-surface-page px-3.5 py-3 text-[13px] leading-relaxed text-text-muted ${className}`}
    >
      {/* « sur cette période » et non « ce mois-ci » : sous une plage précise, la carte
          n'agrège pas un mois (TOOLBAR-DATE-PRECISE1). */}
      Aucune entrée enregistrée sur cette période.{" "}
      <Link
        href="/echeances"
        className="font-semibold text-primary underline-offset-2 hover:underline
          focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
          focus-visible:ring-offset-2 rounded-[2px]"
      >
        Voir les échéances à venir
      </Link>
    </p>
  );
}

/** Groupe de synthèse pour UNE devise : lignes empilées Entrées / Sorties / Variation. */
function BlocDevise({
  synthese,
  afficherDevise,
}: {
  synthese: SynthesePeriodeDevise;
  afficherDevise: boolean;
}) {
  const devise = synthese.currency;

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
        couleur={couleurSens(synthese.entrees, "text-inflow-700")}
      />
      <LigneSynthese
        label="Sorties"
        valeur={formatMontant(synthese.sorties, devise)}
        couleur={couleurSens(synthese.sorties, "text-outflow-700")}
      />
      <LigneSynthese
        label="Variation nette"
        valeur={formatMontant(synthese.variation, devise, {
          signeExplicite: true,
        })}
        couleur={couleurVariation(synthese.variation)}
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
