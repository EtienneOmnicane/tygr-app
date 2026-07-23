/**
 * Corps du PANNEAU DE DÉTAIL d'un bucket (drill L4) — rendu DANS une `Modal`. PUR : il
 * ne va rien chercher, reçoit tout résolu (synthèse déjà calculée côté client depuis la
 * barre cliquée + catégories/contreparties fetchées + un href pré-filtré).
 *
 * Montants formatés par `formatMontant` sur les chaînes décimales (zéro float, règle 8) ;
 * `tabular-nums` ; aucun montant tronqué (seuls les LIBELLÉS tronquent). Couleurs (§3.1) :
 * vert/rouge réservés à la SYNTHÈSE (entrées `inflow` / sorties `outflow`) ; les listes de
 * détail (magnitudes de dépenses) restent NEUTRES pour ne pas saturer l'œil.
 */
import { formatMontant, estNegatif } from "@/lib/format-montant";
import type { LigneVendor, PartCategorie } from "@/server/insights/types";

export function PanneauDetailPeriode({
  synthese,
  devise,
  categories,
  contreparties,
  hrefTransactions,
  chargement = false,
}: {
  /** Entrées/sorties/net du bucket — issus de la BARRE cliquée (identité avec le graphe). */
  synthese: { entrees: string; sorties: string; net: string };
  devise: string;
  /** Top catégories de SORTIES (déjà filtrées à `devise` et bornées côté conteneur). */
  categories: PartCategorie[];
  /** Top contreparties de SORTIES (déjà filtrées à `devise`). */
  contreparties: LigneVendor[];
  /** Lien vers /transactions pré-filtré sur la fenêtre du bucket. */
  hrefTransactions: string;
  /** Détail (catégories/contreparties) encore en cours de chargement ? La synthèse, elle,
   * vient de la barre — elle s'affiche IMMÉDIATEMENT, sans attendre le fetch. */
  chargement?: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* Synthèse — la seule zone colorée (donnée inflow/outflow). */}
      <dl className="flex flex-col gap-1.5">
        <LigneSynthese
          label="Entrées"
          valeur={formatMontant(synthese.entrees, devise, { signeExplicite: true })}
          couleur="text-inflow-700"
        />
        <LigneSynthese
          label="Sorties"
          valeur={formatMontant(synthese.sorties, devise)}
          couleur="text-outflow-700"
        />
        <LigneSynthese
          label="Net"
          valeur={formatMontant(synthese.net, devise, { signeExplicite: true })}
          couleur={estNegatif(synthese.net) ? "text-outflow-700" : "text-text"}
        />
      </dl>

      {chargement ? (
        <p className="text-sm text-text-muted" aria-busy>
          Chargement du détail…
        </p>
      ) : (
        <>
          {contreparties.length > 0 && (
            <SectionDetail titre="Principales sorties">
              {contreparties.map((l, i) => (
                <LigneDetail
                  key={`${l.contrepartie}-${i}`}
                  libelle={l.contrepartie}
                  valeur={formatMontant(l.montant, devise)}
                />
              ))}
            </SectionDetail>
          )}

          {categories.length > 0 && (
            <SectionDetail titre="Par catégorie">
              {categories.map((p, i) => (
                <LigneDetail
                  key={`${p.categorie}-${i}`}
                  libelle={p.categorie}
                  valeur={formatMontant(p.montant, devise)}
                  attenue={p.estNonCategorise}
                />
              ))}
            </SectionDetail>
          )}

          {contreparties.length === 0 && categories.length === 0 && (
            <p className="text-sm text-text-muted">
              Aucune sortie sur cette période dans cette devise.
            </p>
          )}

          <a
            href={hrefTransactions}
            className="inline-flex w-fit items-center gap-1 rounded-control text-sm font-medium text-primary
              transition-colors hover:underline
              focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Voir les transactions
            <span aria-hidden>→</span>
          </a>
        </>
      )}
    </div>
  );
}

/** Une rangée de synthèse : libellé discret + montant tabular coloré. */
function LigneSynthese({
  label,
  valeur,
  couleur,
}: {
  label: string;
  valeur: string;
  couleur: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className={`text-base font-semibold tabular-nums ${couleur}`}>{valeur}</dd>
    </div>
  );
}

/** Bloc « titre + liste » d'une section de détail. */
function SectionDetail({
  titre,
  children,
}: {
  titre: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
        {titre}
      </p>
      <ul className="flex flex-col gap-1.5">{children}</ul>
    </div>
  );
}

/** Une ligne de détail : libellé (tronquable) + montant NEUTRE (jamais tronqué). */
function LigneDetail({
  libelle,
  valeur,
  attenue,
}: {
  libelle: string;
  valeur: string;
  attenue?: boolean;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span
        className={`min-w-0 truncate text-[13px] ${attenue ? "text-text-muted" : "text-text"}`}
        title={libelle}
      >
        {libelle}
      </span>
      <span className="whitespace-nowrap text-[13px] font-medium tabular-nums text-text">
        {valeur}
      </span>
    </li>
  );
}
