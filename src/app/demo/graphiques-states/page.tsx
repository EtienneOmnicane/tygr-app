"use client";

/**
 * Démo / Visual QA du domaine « Analyse par catégorie » (camembert). NON destinée à
 * la production : monte `GraphiquesFeature` avec des répartitions FICTIVES et une
 * action STUB (aucun serveur, aucune DB). Sert à capturer hors auth/DB (Quality
 * Gate 4) :
 *   - le donut multi-devises (une carte par devise, total mono-devise au centre) ;
 *   - la palette : 8 teintes distinctes + queue neutre (>8 catégories) + « Non
 *     catégorisé » toujours gris, trié en dernier ;
 *   - le cas mono-catégorie (anneau plein, pas de secteur dégénéré) ;
 *   - les sélecteurs sens (sorties/entrées) et période, et le lien survol donut↔légende ;
 *   - les KPI d'en-tête par devise (moyenne/op, couverture, poste dominant, top 3) ;
 *   - la variation vs période précédente dans la légende (flèche neutre ▴/▾, « nouv. »,
 *     « – » stable) — jeux calibrés pour exercer les 4 sens ;
 *   - les deux états vides (aucune banque → CTA ; banque sans données sur la période).
 */
import type {
  RepartitionCategories,
  RepartitionDevise,
} from "@/server/insights/types";

import { GraphiquesFeature } from "@/components/graphiques";
import type {
  ActionsGraphiques,
  SelectionGraphique,
} from "@/components/graphiques";

const SELECTION_INITIALE: SelectionGraphique = {
  sens: "outflow",
  periode: "mois-courant",
};

// MUR — 10 catégories réelles + « Non catégorisé » : démontre les 8 teintes puis la
// queue neutre (frais bancaires / marketing, rangs ≥ 8) et le non-catégorisé en gris.
// `montantPrecedent` calibré pour exercer les 4 sens de variation (L4) :
// hausse (Salaires +12 %), baisse (Fournisseurs −10 %), stable (Loyer/Assurances),
// nouveau (Énergie, Marketing : absents de la période précédente).
// `montantMoyen` = 4500000 / 214 = 21028.04 (SQL en prod ; ici en dur, cohérent).
const MUR_SORTIES: RepartitionDevise = {
  currency: "MUR",
  total: "4500000.00",
  montantMoyen: "21028.04",
  nbTransactions: 214,
  parts: [
    { categorie: "Loyer & locaux", estNonCategorise: false, montant: "1200000.00", montantPrecedent: "1200000.00", part: "0.266667", nbTransactions: 12 },
    { categorie: "Salaires", estNonCategorise: false, montant: "980000.00", montantPrecedent: "875000.00", part: "0.217778", nbTransactions: 46 },
    { categorie: "Fournisseurs", estNonCategorise: false, montant: "720000.00", montantPrecedent: "800000.00", part: "0.16", nbTransactions: 58 },
    { categorie: "Énergie", estNonCategorise: false, montant: "430000.00", montantPrecedent: "0.00", part: "0.095556", nbTransactions: 9 },
    { categorie: "Matériel", estNonCategorise: false, montant: "360000.00", montantPrecedent: "300000.00", part: "0.08", nbTransactions: 21 },
    { categorie: "Transport & logistique", estNonCategorise: false, montant: "250000.00", montantPrecedent: "275000.00", part: "0.055556", nbTransactions: 30 },
    { categorie: "Assurances", estNonCategorise: false, montant: "180000.00", montantPrecedent: "180000.00", part: "0.04", nbTransactions: 6 },
    { categorie: "Taxes & impôts", estNonCategorise: false, montant: "140000.00", montantPrecedent: "100000.00", part: "0.031111", nbTransactions: 4 },
    { categorie: "Frais bancaires", estNonCategorise: false, montant: "90000.00", montantPrecedent: "120000.00", part: "0.02", nbTransactions: 18 },
    { categorie: "Marketing", estNonCategorise: false, montant: "60000.00", montantPrecedent: "0.00", part: "0.013333", nbTransactions: 8 },
    { categorie: "Non catégorisé", estNonCategorise: true, montant: "90000.00", montantPrecedent: "150000.00", part: "0.02", nbTransactions: 2 },
  ],
};

// USD — 3 catégories + non-catégorisé (petite part → « <1 % » n'apparaît pas ici mais
// la mécanique de repli est testée sur MUR).
const USD_SORTIES: RepartitionDevise = {
  currency: "USD",
  total: "128000.00",
  montantMoyen: "3121.95",
  nbTransactions: 41,
  parts: [
    { categorie: "Fournisseurs étrangers", estNonCategorise: false, montant: "72000.00", montantPrecedent: "60000.00", part: "0.5625", nbTransactions: 15 },
    { categorie: "Logiciels & SaaS", estNonCategorise: false, montant: "34000.00", montantPrecedent: "34000.00", part: "0.265625", nbTransactions: 19 },
    { categorie: "Déplacements", estNonCategorise: false, montant: "15000.00", montantPrecedent: "0.00", part: "0.117188", nbTransactions: 5 },
    { categorie: "Non catégorisé", estNonCategorise: true, montant: "7000.00", montantPrecedent: "9000.00", part: "0.054688", nbTransactions: 2 },
  ],
};

// EUR — UNE seule catégorie : cas de l'anneau PLEIN (pas de secteur 360° dégénéré).
const EUR_SORTIES: RepartitionDevise = {
  currency: "EUR",
  total: "24500.00",
  montantMoyen: "8166.67",
  nbTransactions: 3,
  parts: [
    { categorie: "Conseil & audit", estNonCategorise: false, montant: "24500.00", montantPrecedent: "21000.00", part: "1", nbTransactions: 3 },
  ],
};

// Entrées (sens inflow) : jeu plus resserré, une part minuscule pour exercer « <1 % ».
const MUR_ENTREES: RepartitionDevise = {
  currency: "MUR",
  total: "5120000.00",
  montantMoyen: "58181.82",
  nbTransactions: 88,
  parts: [
    { categorie: "Ventes clients", estNonCategorise: false, montant: "3900000.00", montantPrecedent: "3500000.00", part: "0.761719", nbTransactions: 52 },
    { categorie: "Subventions", estNonCategorise: false, montant: "820000.00", montantPrecedent: "0.00", part: "0.160156", nbTransactions: 4 },
    { categorie: "Produits financiers", estNonCategorise: false, montant: "360000.00", montantPrecedent: "400000.00", part: "0.070313", nbTransactions: 9 },
    { categorie: "Remboursements", estNonCategorise: false, montant: "22000.00", montantPrecedent: "22000.00", part: "0.004297", nbTransactions: 21 },
    { categorie: "Non catégorisé", estNonCategorise: true, montant: "18000.00", montantPrecedent: "30000.00", part: "0.003516", nbTransactions: 2 },
  ],
};

// Fenêtre précédente (L4) : même longueur (8 j), contiguë, finissant la veille de
// `from` — 2026-06-23..2026-06-30 (règle uniforme de `bornesPeriodePrecedente`).
const SORTIES: RepartitionCategories = {
  sens: "outflow",
  from: "2026-07-01",
  to: "2026-07-08",
  fromPrecedent: "2026-06-23",
  toPrecedent: "2026-06-30",
  devises: [MUR_SORTIES, USD_SORTIES, EUR_SORTIES],
};

const ENTREES: RepartitionCategories = {
  sens: "inflow",
  from: "2026-07-01",
  to: "2026-07-08",
  fromPrecedent: "2026-06-23",
  toPrecedent: "2026-06-30",
  devises: [MUR_ENTREES],
};

const VIDE: RepartitionCategories = {
  sens: "outflow",
  from: "2026-07-01",
  to: "2026-07-08",
  fromPrecedent: "2026-06-23",
  toPrecedent: "2026-06-30",
  devises: [],
};

// Action STUB : renvoie le jeu correspondant au SENS choisi (la période est ignorée
// en démo). Retour déjà normalisé `ResultatAnalyse`.
const ACTIONS_RICHES: ActionsGraphiques = {
  analyser: async (sel) => ({
    ok: true,
    data: sel.sens === "inflow" ? ENTREES : SORTIES,
  }),
};

const ACTIONS_VIDES: ActionsGraphiques = {
  analyser: async (sel) => ({ ok: true, data: { ...VIDE, sens: sel.sens } }),
};

export default function GraphiquesStatesDemoPage() {
  return (
    <div className="min-h-screen bg-surface-page">
      <header className="flex h-16 items-center gap-4 bg-ink px-6 text-text-onink">
        <span className="text-lg font-bold tracking-tight">Dodo</span>
        <span className="rounded-full bg-surface-inset px-3 py-1 text-xs font-medium text-ink">
          Démo · Analyse par catégorie
        </span>
      </header>

      <div className="bg-warning-bg px-6 py-2 text-xs font-medium text-warning">
        Domaine Graphiques — données fictives, action inerte. Donut multi-devises,
        palette (8 teintes + queue neutre + « Non catégorisé »), anneau plein
        (mono-catégorie), sélecteurs sens/période, survol donut↔légende, états vides.
      </div>

      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <section className="mb-10">
          <h1 className="text-xl font-semibold text-text">Analyse par catégorie</h1>
          <p className="mt-1 mb-6 text-sm text-text-muted">
            Répartition des sorties (défaut) sur trois devises : MUR (queue neutre +
            non-catégorisé), USD, EUR (anneau plein). Basculez le sens pour voir les
            entrées.
          </p>
          <GraphiquesFeature
            initiale={SORTIES}
            selectionInitiale={SELECTION_INITIALE}
            aucuneBanque={false}
            actions={ACTIONS_RICHES}
          />
        </section>

        <section className="mb-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-muted">
            État vide — aucune banque connectée
          </h2>
          <GraphiquesFeature
            initiale={VIDE}
            selectionInitiale={SELECTION_INITIALE}
            aucuneBanque
            actions={ACTIONS_VIDES}
          />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-muted">
            État vide — banque connectée, aucun mouvement sur la période
          </h2>
          <GraphiquesFeature
            initiale={VIDE}
            selectionInitiale={SELECTION_INITIALE}
            aucuneBanque={false}
            actions={ACTIONS_VIDES}
          />
        </section>
      </main>
    </div>
  );
}
