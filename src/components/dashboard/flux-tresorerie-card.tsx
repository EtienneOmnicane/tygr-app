"use client";

/**
 * Carte ANCRE du dashboard (UI_GUIDELINES §1.1/§4.2) : « Flux de trésorerie ». Feature
 * CLIENTE INTERACTIVE (PLAN-graphs-fygr) — elle porte l'état d'AFFICHAGE et RE-FETCHE la
 * série via une Server Action ; elle ne touche jamais la DB ni ne connaît le workspace.
 *  - L1 · TOGGLE graphique ↔ tableau : une même série, deux représentations (invariant :
 *    les deux reçoivent la MÊME donnée). La légende NOMMÉE masque/affiche entrées ou
 *    sorties (jamais les deux), en vue graphique seulement.
 *  - L2 · PÉRIODICITÉ jour / semaine / mois : re-fetch de `cashflowParDevise` à la
 *    granularité choisie (`chargerFluxAction`). La FENÊTRE ne change pas — elle reste celle
 *    de la période globale (barre de vue), re-dérivée à Maurice côté serveur depuis le
 *    descripteur d'URL (`periodeParams`) : le client n'impose jamais une date brute.
 *  - L3 · SÉLECTEUR DE DEVISE : une série à la fois (jamais d'addition cross-devise), visible
 *    seulement en multi-devise. Ferme DASH-CASHFLOW-MULTISERIE.
 *
 * ⚠️ REMONTAGE sur la FENÊTRE (`key={cleFenetre}` posé par la page) : l'état (granularité,
 * données re-fetchées) dérive des props du premier paint ; sans `key`, un changement de
 * période globale laisserait `useState` PÉRIMÉ (piège connu). Le remontage repart proprement
 * en « mois » sur la nouvelle fenêtre.
 *
 * 100 % RÉALISÉ depuis FLUX-PREV-AXE1 : aucune prévision ici (échéances → `echeances-encart`).
 * Couleurs (§3.1) : vert/rouge n'apparaît que dans les barres, le tableau et la légende.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import type { SyntheseMensuelle } from "@/server/repositories/dashboard";
import type {
  LigneVendor,
  PartCategorie,
  PointCashflow,
} from "@/server/insights/types";

import {
  chargerFluxAction,
  detailBucketAction,
  type DetailBucket,
} from "@/app/(workspace)/(dashboard)/actions";
import { StateCard } from "@/components/dashboard/states/primitives";
import { FluxBarres } from "@/components/dashboard/flux-bars";
import { TableauEvolution } from "@/components/dashboard/monthly-cashflow";
import { Select } from "@/components/ui/select/select";
import { ControleSegmente } from "@/components/ui/controle-segmente";
import { Modal } from "@/components/ui/modal/modal";
import { LegendeSeries } from "@/components/charts/legende-series";
import { ToggleVue, type VueFlux } from "@/components/charts/toggle-vue";
import { PanneauDetailPeriode } from "@/components/charts/panneau-detail-periode";
import { etiquetteBucket } from "@/components/charts/etiquette-bucket";
import type { GranulariteBucket } from "@/components/charts/grille-buckets";
import {
  SERIES_FLUX,
  TOUTES_SERIES_VISIBLES,
  basculerVisibilite,
  type IdSerieFlux,
  type VisibiliteSeries,
} from "@/components/charts/series-types";

/** Descripteur d'URL de la période (renvoyé tel quel à la Server Action). */
export interface PeriodeParams {
  periode?: string;
  du?: string;
  au?: string;
}

/** Options de granularité (fin → grossier), libellés FR. */
const GRANULARITES: Array<{ valeur: GranulariteBucket; label: string }> = [
  { valeur: "jour", label: "Jour" },
  { valeur: "semaine", label: "Semaine" },
  { valeur: "mois", label: "Mois" },
];

export function FluxTresorerieCard({
  serieMensuelle,
  grilleMensuelle,
  devise,
  libellePeriode,
  periodeParams,
}: {
  /** Série MENSUELLE du premier paint (mois × devise) — vue « mois » sans re-fetch. */
  serieMensuelle: SyntheseMensuelle[];
  /** Axe continu des mois (comble les mois sans transaction). */
  grilleMensuelle: string[];
  /** Devise de BASE du workspace (défaut du sélecteur L3). */
  devise: string;
  /** Libellé de la fenêtre appliquée (source unique : la page). */
  libellePeriode?: string;
  /** Descripteur d'URL de la période (envoyé à la Server Action pour re-dériver [from,to]). */
  periodeParams: PeriodeParams;
}) {
  const [vue, setVue] = useState<VueFlux>("graphique");
  const [visibles, setVisibles] = useState<VisibiliteSeries>(
    TOUTES_SERIES_VISIBLES,
  );
  const [deviseSel, setDeviseSel] = useState<string>(devise);
  // Donnée COURANTE = série + grille + granularité affichées. Init = mensuel (props),
  // sans fetch. Une bascule de périodicité la remplace (« mois » = retour aux props).
  const [donnee, setDonnee] = useState<{
    serie: SyntheseMensuelle[];
    grille: string[];
    granularite: GranulariteBucket;
  }>(() => ({
    serie: serieMensuelle,
    grille: grilleMensuelle,
    granularite: "mois",
  }));
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  // Drill (L4) : bucket cliqué + détail fetché. `bucketDrill=null` ⇒ modale fermée.
  const [bucketDrill, setBucketDrill] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailBucket | null>(null);
  const [chargementDetail, setChargementDetail] = useState(false);
  const [erreurDetail, setErreurDetail] = useState<string | null>(null);

  const changerGranularite = useCallback(
    async (g: GranulariteBucket) => {
      if (g === donnee.granularite || chargement) return;
      setErreur(null);
      // « Mois » = la donnée du premier paint, déjà en props : aucun aller-retour serveur.
      if (g === "mois") {
        setDonnee({
          serie: serieMensuelle,
          grille: grilleMensuelle,
          granularite: "mois",
        });
        return;
      }
      setChargement(true);
      try {
        const res = await chargerFluxAction({ granularite: g, ...periodeParams });
        if (!res.ok) {
          setErreur(res.message);
          return;
        }
        setDonnee({
          serie: cashflowVersSynthese(res.data.points),
          grille: res.data.grille,
          granularite: g,
        });
      } catch {
        setErreur("Le chargement a échoué. Réessayez.");
      } finally {
        setChargement(false);
      }
    },
    [donnee.granularite, chargement, serieMensuelle, grilleMensuelle, periodeParams],
  );

  // Garde de requête (anti-réponse-périmée) : ouvrir vite le drill de B après A pourrait
  // laisser la réponse de A (plus lente) écraser celle de B → listes de A sous le titre de
  // B. On ignore toute réponse dont le bucket ≠ la DERNIÈRE demande.
  const demandeDrillRef = useRef<string | null>(null);

  const ouvrirDrill = useCallback(
    async (bucket: string) => {
      demandeDrillRef.current = bucket;
      setBucketDrill(bucket);
      setDetail(null);
      setErreurDetail(null);
      setChargementDetail(true);
      try {
        const res = await detailBucketAction({
          granularite: donnee.granularite,
          bucket,
          ...periodeParams,
        });
        if (demandeDrillRef.current !== bucket) return; // réponse périmée : ignorée
        if (!res.ok) {
          setErreurDetail(res.message);
          return;
        }
        setDetail(res.data);
      } catch {
        if (demandeDrillRef.current !== bucket) return;
        setErreurDetail("Le chargement du détail a échoué.");
      } finally {
        // Seule la DERNIÈRE demande pilote l'indicateur de chargement.
        if (demandeDrillRef.current === bucket) setChargementDetail(false);
      }
    },
    [donnee.granularite, periodeParams],
  );

  // Fermer annule aussi la demande en vol (une réponse tardive ne ré-ouvrira rien).
  const fermerDrill = useCallback(() => {
    demandeDrillRef.current = null;
    setBucketDrill(null);
  }, []);

  // Devises présentes dans la donnée COURANTE, devise de base en tête.
  const devisesDisponibles = useMemo(
    () => devisesPresentes(donnee.serie, devise),
    [donnee.serie, devise],
  );
  const multiDevise = devisesDisponibles.length > 1;
  const deviseAffichee = devisesDisponibles.includes(deviseSel)
    ? deviseSel
    : devisesDisponibles[0];

  const basculerSerie = (id: IdSerieFlux) =>
    setVisibles((v) => basculerVisibilite(v, id));

  // Détail du bucket cliqué (L4). La SYNTHÈSE vient de la barre (le point de la série
  // pour ce bucket + la devise affichée) → identité garantie avec le graphe, affichée
  // sans attendre le fetch. Catégories/contreparties filtrées à la devise + bornées.
  const pointDrill = bucketDrill
    ? donnee.serie.find(
        (s) => s.mois === bucketDrill && s.currency === deviseAffichee,
      )
    : undefined;
  const syntheseDrill = {
    entrees: pointDrill?.entrees ?? "0",
    sorties: pointDrill?.sorties ?? "0",
    net: pointDrill?.variation ?? "0",
  };
  const catsDrill: PartCategorie[] =
    detail?.categories.devises
      .find((d) => d.currency === deviseAffichee)
      ?.parts.slice(0, 6) ?? [];
  const contrepsDrill: LigneVendor[] =
    detail?.contreparties.lignes
      .filter((l) => l.currency === deviseAffichee)
      .slice(0, 5) ?? [];
  const hrefDrill = detail
    ? `/transactions?du=${detail.from}&au=${detail.to}`
    : "";
  const titreDrill = bucketDrill
    ? etiquetteBucket(donnee.granularite, bucketDrill).complet
    : "";

  return (
    <StateCard className="min-h-[380px]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">Flux de trésorerie</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Entrées − sorties · réalisé
          </p>
        </div>

        {/* Cluster de contrôles (contenu de carte — `flex-wrap` autorisé). Périodicité ·
            devise (multi) · toggle · légende (vue graphique). Désactivés pendant un fetch. */}
        <div className="flex flex-wrap items-center gap-3">
          <ControleSegmente<GranulariteBucket>
            label="Pas de temps"
            size="sm"
            valeur={donnee.granularite}
            onChange={(g) => void changerGranularite(g)}
            disabled={chargement}
            options={GRANULARITES}
          />
          {multiDevise && (
            <Select
              value={deviseAffichee}
              onChange={setDeviseSel}
              size="sm"
              disabled={chargement}
              ariaLabel="Devise affichée"
              options={devisesDisponibles.map((d) => ({ value: d, label: d }))}
            />
          )}
          <ToggleVue vue={vue} onChange={setVue} disabled={chargement} />
          {vue === "graphique" && (
            <LegendeSeries
              series={SERIES_FLUX}
              visibles={visibles}
              onBasculer={basculerSerie}
            />
          )}
        </div>
      </div>

      {/* Erreur (§3.4 : fond danger + role alert, jamais un simple rouge). */}
      {erreur && (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-control bg-danger-bg px-4 py-3 text-sm text-danger"
        >
          <span aria-hidden>⚠</span>
          <span>{erreur}</span>
        </div>
      )}

      {/* Corps : estompé + inerte pendant un re-fetch (données précédentes conservées,
          pas de saut de layout). */}
      <div
        aria-busy={chargement}
        className={
          chargement ? "pointer-events-none opacity-60 transition-opacity" : "transition-opacity"
        }
      >
        {vue === "graphique" ? (
          <FluxBarres
            serie={donnee.serie}
            grille={donnee.grille}
            devise={deviseAffichee}
            libellePeriode={libellePeriode}
            visibles={visibles}
            granularite={donnee.granularite}
            onSelectionnerBucket={(b) => void ouvrirDrill(b)}
          />
        ) : (
          <TableauEvolution
            serie={donnee.serie}
            grille={donnee.grille}
            devise={deviseAffichee}
            granularite={donnee.granularite}
          />
        )}
      </div>

      {/* Drill (L4) : détail du bucket cliqué en MODALE (primitive ui/modal — focus trap,
          Escape, scroll verrouillé). La synthèse s'affiche tout de suite ; les listes après
          le fetch. */}
      <Modal
        open={bucketDrill !== null}
        onClose={fermerDrill}
        title={titreDrill}
        size="sm"
      >
        {erreurDetail ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-control bg-danger-bg px-4 py-3 text-sm text-danger"
          >
            <span aria-hidden>⚠</span>
            <span>{erreurDetail}</span>
          </div>
        ) : (
          <PanneauDetailPeriode
            synthese={syntheseDrill}
            devise={deviseAffichee}
            categories={catsDrill}
            contreparties={contrepsDrill}
            hrefTransactions={hrefDrill}
            chargement={chargementDetail}
          />
        )}
      </Modal>
    </StateCard>
  );
}

/**
 * Convertit les points bruts de `cashflowParDevise` (bucket × devise, `net`) vers la
 * forme attendue par la projection (`SyntheseMensuelle` : `mois` = le bucket, `variation`
 * = `net`). Pas de calcul de montant — simple renommage de champs (règle 8).
 */
function cashflowVersSynthese(points: PointCashflow[]): SyntheseMensuelle[] {
  return points.map((p) => ({
    mois: p.bucket,
    currency: p.currency,
    entrees: p.entrees,
    sorties: p.sorties,
    variation: p.net,
  }));
}

/**
 * Devises présentes dans la série, devise de BASE en tête (toujours offerte même sans
 * mouvement — le graphe doit pouvoir revenir à la devise de référence), puis les autres
 * par ordre alphabétique STABLE (déterminisme du rendu). Pur.
 */
function devisesPresentes(serie: SyntheseMensuelle[], base: string): string[] {
  const autres = [
    ...new Set(serie.map((s) => s.currency).filter((c) => c !== base)),
  ].sort();
  return [base, ...autres];
}
