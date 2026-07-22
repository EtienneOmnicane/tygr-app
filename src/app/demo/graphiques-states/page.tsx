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
 *   - les GROS montants (11-12 chiffres), mono ET multi-devises : le seul jeu capable
 *     d'attraper un débordement du total central (`DONUT-CENTRE-DEBORDE1`) ;
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
    // ⚠️ PAIRE HOMONYME VOLONTAIRE — c'est LE cas que le Lot 3 doit rendre lisible :
    // 800 000 ventilés par l'utilisateur sur SA catégorie « Loyer & locaux », et
    // 400 000 de reliquat non ventilé restés sur la catégorie BANCAIRE du même nom.
    // Deux lignes homonymes, dont une seule porte le badge « banque ». Sans cette paire,
    // la capture Gate 4 validerait un écran qui ne contient jamais le cas litigieux.
    { categorie: "Loyer & locaux", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000001", montant: "800000.00", montantPrecedent: "1200000.00", part: "0.177778", nbTransactions: 12 },
    { categorie: "Loyer & locaux", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "400000.00", montantPrecedent: "0.00", part: "0.088889", nbTransactions: 4 },
    { categorie: "Salaires", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000002", montant: "980000.00", montantPrecedent: "875000.00", part: "0.217778", nbTransactions: 46 },
    { categorie: "Fournisseurs", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000003", montant: "720000.00", montantPrecedent: "800000.00", part: "0.16", nbTransactions: 58 },
    { categorie: "Énergie", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "430000.00", montantPrecedent: "0.00", part: "0.095556", nbTransactions: 9 },
    { categorie: "Matériel", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000004", montant: "360000.00", montantPrecedent: "300000.00", part: "0.08", nbTransactions: 21 },
    { categorie: "Transport & logistique", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "250000.00", montantPrecedent: "275000.00", part: "0.055556", nbTransactions: 30 },
    { categorie: "Assurances", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000005", montant: "180000.00", montantPrecedent: "180000.00", part: "0.04", nbTransactions: 6 },
    { categorie: "Taxes & impôts", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "140000.00", montantPrecedent: "100000.00", part: "0.031111", nbTransactions: 4 },
    { categorie: "Frais bancaires", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "90000.00", montantPrecedent: "120000.00", part: "0.02", nbTransactions: 18 },
    { categorie: "Marketing", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000006", montant: "60000.00", montantPrecedent: "0.00", part: "0.013333", nbTransactions: 8 },
    { categorie: "Non catégorisé", estNonCategorise: true, origine: "AUCUNE", categorieId: null, montant: "90000.00", montantPrecedent: "150000.00", part: "0.02", nbTransactions: 2 },
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
    { categorie: "Fournisseurs étrangers", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000007", montant: "72000.00", montantPrecedent: "60000.00", part: "0.5625", nbTransactions: 15 },
    { categorie: "Logiciels & SaaS", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "34000.00", montantPrecedent: "34000.00", part: "0.265625", nbTransactions: 19 },
    { categorie: "Déplacements", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "15000.00", montantPrecedent: "0.00", part: "0.117188", nbTransactions: 5 },
    { categorie: "Non catégorisé", estNonCategorise: true, origine: "AUCUNE", categorieId: null, montant: "7000.00", montantPrecedent: "9000.00", part: "0.054688", nbTransactions: 2 },
  ],
};

// EUR — UNE seule catégorie : cas de l'anneau PLEIN (pas de secteur 360° dégénéré).
const EUR_SORTIES: RepartitionDevise = {
  currency: "EUR",
  total: "24500.00",
  montantMoyen: "8166.67",
  nbTransactions: 3,
  parts: [
    { categorie: "Conseil & audit", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000008", montant: "24500.00", montantPrecedent: "21000.00", part: "1", nbTransactions: 3 },
  ],
};

// Entrées (sens inflow) : jeu plus resserré, une part minuscule pour exercer « <1 % ».
const MUR_ENTREES: RepartitionDevise = {
  currency: "MUR",
  total: "5120000.00",
  montantMoyen: "58181.82",
  nbTransactions: 88,
  parts: [
    { categorie: "Ventes clients", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000009", montant: "3900000.00", montantPrecedent: "3500000.00", part: "0.761719", nbTransactions: 52 },
    { categorie: "Subventions", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "820000.00", montantPrecedent: "0.00", part: "0.160156", nbTransactions: 4 },
    { categorie: "Produits financiers", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "360000.00", montantPrecedent: "400000.00", part: "0.070313", nbTransactions: 9 },
    { categorie: "Remboursements", estNonCategorise: false, origine: "TYGR", categorieId: "c0000000-0000-4000-8000-000000000010", montant: "22000.00", montantPrecedent: "22000.00", part: "0.004297", nbTransactions: 21 },
    { categorie: "Non catégorisé", estNonCategorise: true, origine: "AUCUNE", categorieId: null, montant: "18000.00", montantPrecedent: "30000.00", part: "0.003516", nbTransactions: 2 },
  ],
};

// ── Gros montants (DONUT-CENTRE-DEBORDE1) ─────────────────────────────────────
// Les jeux ci-dessus plafonnent à 7 chiffres : le centre du donut y tient TOUJOURS,
// donc ils ne peuvent pas attraper le débordement observé en production. La réserve
// du lot précédent (`docs/qa/polish-front-demo/README.md` §3 — « aucune fixture ne
// couvre 10 chiffres et plus ») est levée ici : sans ces deux jeux, la Gate 4 passe
// au vert sans mentir, sur un écran qui n'expose simplement pas le défaut.
//
// MUR : le montant RÉEL relevé en prod (Rs 12 188 030 422,92 — 11 chiffres).
// GBP : pire cas de LARGEUR, et il ne vient pas du seul nombre de chiffres — devise
// inconnue de `SYMBOLES_PREFIXE`, donc repli code ISO en SUFFIXE (« … GBP »), qui
// ajoute 4 caractères LÀ où le symbole préfixe n'en coûtait que 2.
//
// Origine (#241) : toutes les parts sont `AMONT` — ce sont des totaux bancaires bruts,
// sans ventilation TYGR, donc `categorieId: null` (un id n'existe que pour `TYGR`). Le
// « Non catégorisé » porte `AUCUNE`, l'invariant du type étant
// `estNonCategorise === true ⟺ origine === "AUCUNE"`. Ces jeux servent à éprouver une
// LARGEUR de montant, pas la cascade d'origines : le cas homonyme TYGR/AMONT est déjà
// couvert par `MUR_SORTIES` ci-dessus, et le dupliquer ici brouillerait ce qu'ils
// prouvent.
const MUR_MILLIARDS: RepartitionDevise = {
  currency: "MUR",
  total: "12188030422.92",
  montantMoyen: "9829056.79",
  nbTransactions: 1240,
  parts: [
    { categorie: "Loyer & locaux", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "5000000000.00", montantPrecedent: "4800000000.00", part: "0.410237", nbTransactions: 310 },
    { categorie: "Salaires", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "4000000000.00", montantPrecedent: "4000000000.00", part: "0.328190", nbTransactions: 520 },
    { categorie: "Fournisseurs", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "3000000000.00", montantPrecedent: "3400000000.00", part: "0.246142", nbTransactions: 380 },
    { categorie: "Non catégorisé", estNonCategorise: true, origine: "AUCUNE", categorieId: null, montant: "188030422.92", montantPrecedent: "150000000.00", part: "0.015428", nbTransactions: 30 },
  ],
};

const GBP_MILLIARDS: RepartitionDevise = {
  currency: "GBP",
  total: "999888777666.55",
  montantMoyen: "11492974455.94",
  nbTransactions: 87,
  parts: [
    { categorie: "Fournisseurs étrangers", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "600000000000.00", montantPrecedent: "550000000000.00", part: "0.600066", nbTransactions: 40 },
    { categorie: "Investissements", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "300000000000.00", montantPrecedent: "300000000000.00", part: "0.300033", nbTransactions: 32 },
    { categorie: "Frais de structure", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "99888777666.55", montantPrecedent: "120000000000.00", part: "0.099899", nbTransactions: 15 },
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

// ── Cas DISCRIMINANT du seuil (à ne pas retirer) ──────────────────────────────
// Les deux devises portent ici la MÊME cardinalité — 8 chiffres — et doivent rendre
// DIFFÉREMMENT : « Rs 12 345 678,90 » en plein (il tient : 127,8 px pour 135,3 px de
// corde), « 12,3 M GBP » en compact (le suffixe ISO coûte ~16 px de plus et déborde).
// C'est le seul jeu capable de prouver que les DEUX seuils existent : avec des
// cardinalités différentes de part et d'autre, un seuil unique passerait le test sans
// qu'on le voie.
const MUR_HUIT_CHIFFRES: RepartitionDevise = {
  currency: "MUR",
  total: "12345678.90",
  montantMoyen: "205761.32",
  nbTransactions: 60,
  parts: [
    { categorie: "Loyer & locaux", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "8000000.00", montantPrecedent: "7500000.00", part: "0.647999", nbTransactions: 24 },
    { categorie: "Salaires", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "4345678.90", montantPrecedent: "4400000.00", part: "0.352001", nbTransactions: 36 },
  ],
};

const GBP_HUIT_CHIFFRES: RepartitionDevise = {
  currency: "GBP",
  total: "12345678.90",
  montantMoyen: "274348.42",
  nbTransactions: 45,
  parts: [
    { categorie: "Fournisseurs étrangers", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "8000000.00", montantPrecedent: "7000000.00", part: "0.647999", nbTransactions: 20 },
    { categorie: "Investissements", estNonCategorise: false, origine: "AMONT", categorieId: null, montant: "4345678.90", montantPrecedent: "4500000.00", part: "0.352001", nbTransactions: 25 },
  ],
};

const SEUIL: RepartitionCategories = {
  sens: "outflow",
  from: "2026-07-01",
  to: "2026-07-08",
  fromPrecedent: "2026-06-23",
  toPrecedent: "2026-06-30",
  devises: [MUR_HUIT_CHIFFRES, GBP_HUIT_CHIFFRES],
};

// Multi-devises à gros montants : deux cartes, deux largeurs de centre différentes
// (préfixe `Rs` court vs suffixe ` GBP` long) — c'est la comparaison qui compte.
const GROS_MULTI: RepartitionCategories = {
  sens: "outflow",
  from: "2026-07-01",
  to: "2026-07-08",
  fromPrecedent: "2026-06-23",
  toPrecedent: "2026-06-30",
  devises: [MUR_MILLIARDS, GBP_MILLIARDS],
};

// Mono-devise à gros montant : la carte occupe toute la largeur, mais le donut reste
// borné (`max-w-[220px]`) — donc le centre subit EXACTEMENT la même contrainte qu'en
// multi. Cas gardé pour le prouver plutôt que le supposer.
const GROS_MONO: RepartitionCategories = {
  sens: "outflow",
  from: "2026-07-01",
  to: "2026-07-08",
  fromPrecedent: "2026-06-23",
  toPrecedent: "2026-06-30",
  devises: [GBP_MILLIARDS],
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

const ACTIONS_SEUIL: ActionsGraphiques = {
  analyser: async (sel) => ({ ok: true, data: { ...SEUIL, sens: sel.sens } }),
};

const ACTIONS_GROS_MULTI: ActionsGraphiques = {
  analyser: async (sel) => ({ ok: true, data: { ...GROS_MULTI, sens: sel.sens } }),
};

const ACTIONS_GROS_MONO: ActionsGraphiques = {
  analyser: async (sel) => ({ ok: true, data: { ...GROS_MONO, sens: sel.sens } }),
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
        <section className="mb-10" id="courants">
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

        <section className="mb-10" id="seuil">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-muted">
            Seuil — même montant (8 chiffres), deux rendus : plein en Rs, compact en GBP
          </h2>
          <GraphiquesFeature
            initiale={SEUIL}
            selectionInitiale={SELECTION_INITIALE}
            aucuneBanque={false}
            actions={ACTIONS_SEUIL}
          />
        </section>

        <section className="mb-10" id="gros-multi">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-muted">
            Gros montants — multi-devises (MUR 11 chiffres, GBP 12 chiffres)
          </h2>
          <GraphiquesFeature
            initiale={GROS_MULTI}
            selectionInitiale={SELECTION_INITIALE}
            aucuneBanque={false}
            actions={ACTIONS_GROS_MULTI}
          />
        </section>

        <section className="mb-10" id="gros-mono">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-muted">
            Gros montants — mono-devise (GBP, repli code ISO en suffixe)
          </h2>
          <GraphiquesFeature
            initiale={GROS_MONO}
            selectionInitiale={SELECTION_INITIALE}
            aucuneBanque={false}
            actions={ACTIONS_GROS_MONO}
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
