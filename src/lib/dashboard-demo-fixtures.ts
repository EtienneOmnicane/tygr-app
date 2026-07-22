/**
 * Fixtures de DÉMO du dashboard côté UI (Epic 3) — données 100 % FICTIVES,
 * dédiées au rendu de prévisualisation / Visual QA (`/demo/dashboard`).
 *
 * Pourquoi une copie ici plutôt que d'importer `server/repositories/
 * dashboard.fixtures.ts` : la barrière anti-accès-DB (CLAUDE.md règle 2,
 * `no-restricted-imports`) confine `@/server/repositories/*` — une page UI ne
 * peut pas l'importer en valeur. Les TYPES, eux, viennent de `dashboard.ts` /
 * `insights/types.ts` via `import type` (effacé au build, autorisé).
 *
 * ⚠️ JAMAIS importé dans un chemin servant des données réelles. Démo uniquement.
 */
import type { DonneesDashboard } from "@/components/dashboard/dashboard-content";

/** Mois courant de la démo (libellé des cartes de synthèse). */
export const DEMO_MOIS = "2026-06";

/**
 * Signal de périmètre NEUTRE (NUDGE-VISION-ENTITE1) : lecteur non borné, tenant pourvu
 * d'au moins une connexion. C'est le cas par défaut de toutes les fixtures qui exposent
 * des comptes — pour elles ces deux drapeaux sont inertes (`comptes.length > 0`
 * court-circuite la sélection d'état). Factorisé pour que l'état « hors périmètre »
 * n'ait qu'UN endroit où être posé volontairement : sa propre fixture, ci-dessous.
 */
const PERIMETRE_NEUTRE = {
  aDesConnexionsTenant: true,
  lecteurBorne: false,
} satisfies Pick<DonneesDashboard, "aDesConnexionsTenant" | "lecteurBorne">;

/**
 * État SUCCÈS : dashboard complet. Multi-devise (MUR + USD) pour exercer la
 * synthèse ventilée et la pile de soldes ; flux mensuel AVEC un mois NÉGATIF
 * (mai) pour valider la ligne de zéro et l'aire en-dessous.
 *
 * TITULAIRES (accordéon L3/L5) : 2 groupes (« Omnicane Energy Ltd » à 2 comptes,
 * « Omnicane Sugar Estates Ltd » à 1) + 1 compte SANS titulaire (bucket « Non
 * regroupé » en dernier). Les sommes par devise restent alignées sur
 * `soldesParDevise` (MUR 5 230 000 + 1 961 000 + 500 000 = 7 691 000 ;
 * USD 179 200). Le cas MONO-groupe (repli liste plate) vit sur l'état PARTIEL.
 */
export const DEMO_DASHBOARD: DonneesDashboard = {
  ...PERIMETRE_NEUTRE,
  comptes: [
    {
      bankAccountId: "demo-acc-mcb-4521",
      accountName: "MCB — Compte courant business",
      institutionName: "The Mauritius Commercial Bank",
      currency: "MUR",
      currentBalance: "5230000.00",
      lastSyncedAt: new Date("2026-06-12T08:00:00Z"),
      holderId: "demo-party-sugar",
      holderName: "Omnicane Sugar Estates Ltd",
    },
    {
      bankAccountId: "demo-acc-sbm-0937",
      accountName: "SBM — Compte opérations",
      institutionName: "State Bank of Mauritius",
      currency: "MUR",
      currentBalance: "1961000.00",
      lastSyncedAt: new Date("2026-06-12T07:00:00Z"),
      holderId: "demo-party-energy",
      holderName: "Omnicane Energy Ltd",
    },
    {
      bankAccountId: "demo-acc-sbm-5512",
      accountName: "SBM — Compte épargne",
      institutionName: "State Bank of Mauritius",
      currency: "MUR",
      currentBalance: "500000.00",
      lastSyncedAt: new Date("2026-06-12T07:00:00Z"),
      holderId: "demo-party-energy",
      holderName: "Omnicane Energy Ltd",
    },
    {
      bankAccountId: "demo-acc-mcb-usd-8804",
      accountName: "MCB — Compte USD",
      institutionName: "The Mauritius Commercial Bank",
      currency: "USD",
      currentBalance: "179200.00",
      lastSyncedAt: new Date("2026-06-12T08:00:00Z"),
      // Sans titulaire → bucket « Non regroupé » (D7).
      holderId: null,
      holderName: null,
    },
  ],
  soldesParDevise: [
    { currency: "MUR", total: "7691000.00" },
    { currency: "USD", total: "179200.00" },
  ],
  // Flux net mensuel (base_currency MUR) — mai négatif (sorties > entrées).
  flux: [
    { bucket: "2026-01", currency: "MUR", entrees: "3800000.00", sorties: "3450000.00", net: "350000.00", nbTransactions: 42 },
    { bucket: "2026-02", currency: "MUR", entrees: "4120000.00", sorties: "3980000.00", net: "140000.00", nbTransactions: 38 },
    { bucket: "2026-03", currency: "MUR", entrees: "4560000.00", sorties: "4210000.00", net: "350000.00", nbTransactions: 45 },
    { bucket: "2026-04", currency: "MUR", entrees: "5010000.00", sorties: "4880000.00", net: "130000.00", nbTransactions: 51 },
    { bucket: "2026-05", currency: "MUR", entrees: "4790000.00", sorties: "5120000.00", net: "-330000.00", nbTransactions: 47 },
    { bucket: "2026-06", currency: "MUR", entrees: "5200000.00", sorties: "4474000.00", net: "726000.00", nbTransactions: 49 },
  ],
  // Synthèse du mois courant PAR DEVISE (MUR + USD) — jamais additionnées.
  synthesesMois: [
    { currency: "MUR", entrees: "5200000.00", sorties: "4474000.00", variation: "726000.00" },
    { currency: "USD", entrees: "118000.00", sorties: "92500.00", variation: "25500.00" },
  ],
  // Top contreparties (dépenses) — multi-devise pour exercer le groupement.
  topVendors: {
    direction: "outflow",
    lignes: [
      { contrepartie: "Ebène Cybercity", currency: "MUR", montant: "1850000.00", part: "0.41", nbTransactions: 3 },
      { contrepartie: "CEB", currency: "MUR", montant: "1120000.00", part: "0.25", nbTransactions: 6 },
      { contrepartie: "Mauritius Telecom", currency: "MUR", montant: "624000.00", part: "0.14", nbTransactions: 4 },
      { contrepartie: "Vivo Energy", currency: "MUR", montant: "388000.00", part: "0.086", nbTransactions: 5 },
      { contrepartie: "AWS EMEA", currency: "USD", montant: "62400.00", part: "0.67", nbTransactions: 2 },
    ],
  },
  // Tendance 6 mois (MUR) ; mars porte aussi de l'USD. Série à plat (mois × devise).
  serieMensuelle: [
    { mois: "2026-01", currency: "MUR", entrees: "3800000.00", sorties: "3450000.00", variation: "350000.00" },
    { mois: "2026-02", currency: "MUR", entrees: "4120000.00", sorties: "3980000.00", variation: "140000.00" },
    { mois: "2026-03", currency: "MUR", entrees: "4560000.00", sorties: "4210000.00", variation: "350000.00" },
    { mois: "2026-03", currency: "USD", entrees: "42000.00", sorties: "18000.00", variation: "24000.00" },
    { mois: "2026-04", currency: "MUR", entrees: "5010000.00", sorties: "4880000.00", variation: "130000.00" },
    { mois: "2026-05", currency: "MUR", entrees: "4790000.00", sorties: "5120000.00", variation: "-330000.00" },
    { mois: "2026-06", currency: "MUR", entrees: "5200000.00", sorties: "4474000.00", variation: "726000.00" },
  ],
  grilleMensuelle: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
  /**
   * Zone PRÉVISIONNELLE (C1) : le mois d'ancrage (2026-06) porte ses échéances RESTANTES,
   * empilées sur son réalisé (D2), puis 3 mois projetés (D3). Un loyer mensuel de 850 000
   * court sur les trois — c'est l'occurrence RÉCURRENTE qui doit peser CHAQUE mois (le
   * constat d'origine : elle n'était comptée qu'une fois).
   */
  prevision: {
    moisCourant: {
      libelleMois: "2026-06",
      entrees: "1200000.00",
      sorties: "850000.00",
      variation: "350000.00",
      autresDevises: false,
    },
    moisFuturs: [
      {
        libelleMois: "2026-07",
        entrees: "2400000.00",
        sorties: "850000.00",
        variation: "1550000.00",
        autresDevises: false,
      },
      {
        libelleMois: "2026-08",
        entrees: "0.00",
        sorties: "850000.00",
        variation: "-850000.00",
        autresDevises: false,
      },
      {
        // Mois qui porte AUSSI une échéance en USD : signalée par le drapeau, JAMAIS
        // additionnée aux MUR (règle 8 / DASH-FX1) — la note multi-devises doit sortir.
        libelleMois: "2026-09",
        entrees: "0.00",
        sorties: "3150000.00",
        variation: "-3150000.00",
        autresDevises: true,
      },
    ],
  },
  transactionsRecentes: [
    {
      omnifiTxnId: "demo-tx-0008",
      transactionDate: "2026-06-11",
      amount: "1530000.00",
      currency: "MUR",
      creditDebit: "Credit",
      cleanLabel: "Beachcomber Resorts",
      primaryCategory: "Income",
      subCategory: "Client Payments",
      isAutoCategorized: true,
      categorySource: "OMNIFI",
      bankLabelRaw: null,
      bankAccountId: "demo-acc-sbm-0937",
    },
    {
      omnifiTxnId: "demo-tx-0007",
      transactionDate: "2026-06-09",
      amount: "1290000.00",
      currency: "MUR",
      creditDebit: "Credit",
      cleanLabel: "Ciel Textile",
      primaryCategory: "Income",
      subCategory: "Client Payments",
      isAutoCategorized: true,
      categorySource: "OMNIFI",
      bankLabelRaw: null,
      bankAccountId: "demo-acc-sbm-0937",
    },
    {
      omnifiTxnId: "demo-tx-0006",
      transactionDate: "2026-06-05",
      amount: "384250.00",
      currency: "MUR",
      creditDebit: "Debit",
      cleanLabel: "CEB",
      primaryCategory: "Utilities",
      subCategory: "Electricity",
      isAutoCategorized: true,
      categorySource: "OMNIFI",
      bankLabelRaw: null,
      bankAccountId: "demo-acc-mcb-4521",
    },
    {
      omnifiTxnId: "demo-tx-0005",
      transactionDate: "2026-06-01",
      amount: "950000.00",
      currency: "MUR",
      creditDebit: "Debit",
      cleanLabel: "Ebène Cybercity",
      primaryCategory: "Rent",
      subCategory: "Office Rent",
      isAutoCategorized: true,
      categorySource: "OMNIFI",
      bankLabelRaw: null,
      bankAccountId: "demo-acc-mcb-4521",
    },
  ],
};

/**
 * État PARTIEL (décision revue) : comptes + solde présents, MAIS flux, synthèse,
 * vendors et transactions vides — workspace fraîchement connecté, données pas
 * encore synchronisées. La synthèse vide se replie sur « 0 dans la devise de base ».
 *
 * Sert AUSSI de cas MONO-groupe pour l'accordéon titulaire (L5) : titulaires
 * retirés → tous les comptes tombent dans le même bucket → repli LISTE PLATE
 * historique (pas d'accordéon à un seul volet).
 */
export const DEMO_DASHBOARD_PARTIEL: DonneesDashboard = {
  ...PERIMETRE_NEUTRE,
  comptes: DEMO_DASHBOARD.comptes.map((c) => ({
    ...c,
    holderId: null,
    holderName: null,
  })),
  soldesParDevise: DEMO_DASHBOARD.soldesParDevise,
  flux: [],
  synthesesMois: [],
  topVendors: { direction: "outflow", lignes: [] },
  serieMensuelle: [],
  grilleMensuelle: [],
  // Aucune échéance saisie → AUCUNE zone prévisionnelle (pas de colonnes fantômes à
  // zéro : une prévision vide n'est pas une prévision nulle, §5.3).
  prevision: null,
  transactionsRecentes: [],
};

/** État VIDE : workspace connecté mais aucun compte (empty global + CTA). */
export const DEMO_DASHBOARD_VIDE: DonneesDashboard = {
  comptes: [],
  soldesParDevise: [],
  flux: [],
  synthesesMois: [],
  topVendors: { direction: "outflow", lignes: [] },
  serieMensuelle: [],
  grilleMensuelle: [],
  prevision: null,
  transactionsRecentes: [],
  // Le tenant n'a AUCUNE connexion : c'est ce qui rend l'empty global honnête ici.
  aDesConnexionsTenant: false,
  lecteurBorne: false,
};

/**
 * État HORS PÉRIMÈTRE (NUDGE-VISION-ENTITE1) : mêmes données VIDES que ci-dessus —
 * c'est tout l'intérêt du cas. Ce qui change n'est pas la donnée mais le DROIT du
 * lecteur : le tenant a une connexion, et ce membre est borné (Vision Entité ou droit
 * par compte) sans qu'aucun compte lui soit rattaché.
 *
 * À comparer côte à côte avec `DEMO_DASHBOARD_VIDE` au Visual QA : deux écrans
 * identiques en données, deux messages qui doivent être opposés. Afficher l'empty
 * global ici revenait à NIER une banque que /banques montre dans la même session.
 */
export const DEMO_DASHBOARD_HORS_PERIMETRE: DonneesDashboard = {
  ...DEMO_DASHBOARD_VIDE,
  aDesConnexionsTenant: true,
  lecteurBorne: true,
};

/**
 * État « UN SEUL MOIS PEUPLÉ » sur une fenêtre de 6 mois — le cas qui EFFONDRAIT la
 * courbe (fix « courbe effondrée »). Comptes/soldes/vendors/transactions réalistes
 * (état complet), mais la SÉRIE mensuelle n'a qu'un mois de mouvement (2026-01) tandis
 * que la GRILLE couvre 6 mois. Attendu : la courbe trace 6 points (mois vides à zéro,
 * axe pleine largeur) + le bandeau info « dernières données : Janvier 2026 » ; les barres
 * restent inchangées. `flux` porte 1 point (cohérent avec l'état « complet »).
 */
export const DEMO_DASHBOARD_UN_MOIS: DonneesDashboard = {
  ...PERIMETRE_NEUTRE,
  comptes: DEMO_DASHBOARD.comptes,
  soldesParDevise: DEMO_DASHBOARD.soldesParDevise,
  flux: [
    { bucket: "2026-01", currency: "MUR", entrees: "3800000.00", sorties: "3450000.00", net: "350000.00", nbTransactions: 42 },
  ],
  synthesesMois: DEMO_DASHBOARD.synthesesMois,
  topVendors: DEMO_DASHBOARD.topVendors,
  serieMensuelle: [
    { mois: "2026-01", currency: "MUR", entrees: "3800000.00", sorties: "3450000.00", variation: "350000.00" },
  ],
  grilleMensuelle: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
  prevision: null,
  transactionsRecentes: DEMO_DASHBOARD.transactionsRecentes,
};

/**
 * État PRÉVISIONNEL « SANS RÉALISÉ » — le cas critique du plan (§5.2, défaut n°1) :
 * workspace neuf, comptes connectés, AUCUNE transaction synchronisée, mais des échéances
 * DÉJÀ saisies.
 *
 * Attendu DEPUIS FLUX-PREV-AXE1 (option E) — l'attente a changé avec la structure, lire
 * attentivement avant de déclarer une régression :
 *  - le GRAPHE affiche « Aucun mouvement sur la période ». C'est CORRECT et voulu : il ne
 *    rend que le réalisé, et il n'y a effectivement aucune transaction. Ce n'est plus le
 *    faux constat d'avant (où la donnée saisie disparaissait), puisque…
 *  - …l'ENCART « Échéances à venir » porte les échéances, à son échelle propre.
 * Une donnée saisie reste donc visible — dans la carte qui correspond à sa nature. Ne
 * SURTOUT PAS « réparer » en rebranchant la prévision sur l'axe du réalisé : c'est le
 * défaut que ce lot supprime.
 *
 * C'est exactement le parcours de démo : on saisit une échéance, la trésorerie
 * prévisionnelle doit bouger même sans historique bancaire.
 */
export const DEMO_DASHBOARD_PREVISION_SANS_REALISE: DonneesDashboard = {
  ...PERIMETRE_NEUTRE,
  comptes: DEMO_DASHBOARD.comptes,
  soldesParDevise: DEMO_DASHBOARD.soldesParDevise,
  flux: [],
  synthesesMois: [],
  topVendors: { direction: "outflow", lignes: [] },
  serieMensuelle: [],
  grilleMensuelle: ["2026-04", "2026-05", "2026-06"],
  prevision: {
    moisCourant: {
      libelleMois: "2026-06",
      entrees: "0.00",
      sorties: "850000.00",
      variation: "-850000.00",
      autresDevises: false,
    },
    moisFuturs: [
      {
        libelleMois: "2026-07",
        entrees: "1500000.00",
        sorties: "850000.00",
        variation: "650000.00",
        autresDevises: false,
      },
      {
        libelleMois: "2026-08",
        entrees: "0.00",
        sorties: "850000.00",
        variation: "-850000.00",
        autresDevises: false,
      },
      {
        libelleMois: "2026-09",
        entrees: "0.00",
        sorties: "850000.00",
        variation: "-850000.00",
        autresDevises: false,
      },
    ],
  },
  transactionsRecentes: [],
};

/**
 * État PRÉVISIONNEL « FAIBLE MONTANT » — LE CAS QUI MANQUAIT (PLAN-flux-previsionnel
 * -lisibilite.md §0.2, lot 0).
 *
 * ⚠️ Fixture d'INTÉGRITÉ DE TEST, pas de décoration : sans elle, le défaut « la zone
 * prévisionnelle paraît vide » n'était pas CAPTURABLE en Visual QA, donc la Gate 4 du
 * prévisionnel C1 (#226) est passée au vert sans mentir — toutes les fixtures d'alors
 * portaient un rapport ~1:6 (barres de 17 à 72 px, parfaitement visibles).
 *
 * Ici : réalisé 5 200 000 MUR contre des échéances de 10 000 MUR, soit le rapport RÉEL
 * observé en production (~1:520). Sur l'axe PARTAGÉ d'alors, la barre projetée rendait
 * **0,23 px** — sous-pixel, invisible.
 *
 * ⚠️ Ce qu'elle démontre DEPUIS FLUX-PREV-AXE1 (option E) : ce rapport n'écrase plus rien,
 * puisqu'il n'y a plus d'axe partagé. Dans l'encart, à son échelle propre, sa plus petite
 * barre vaut 4 000/25 000 = **16 %** — parfaitement lisible. Elle est devenue le témoin que
 * sortir la prévision de l'axe SUFFIT sur ce cas ; ce n'est donc plus elle que la garde de
 * couverture retient comme cas extrême, ce rôle revenant à
 * `DEMO_DASHBOARD_PREVISION_CONTRASTEE` (écart INTERNE à la prévision).
 *
 * Ne PAS « adoucir » ces montants : elle vaut par son rapport au réalisé.
 */
export const DEMO_DASHBOARD_PREVISION_FAIBLE: DonneesDashboard = {
  ...DEMO_DASHBOARD,
  prevision: {
    // Mois pivot : part projetée minuscule EMPILÉE sur un réalisé de 5,2 M (D2).
    moisCourant: {
      libelleMois: "2026-06",
      entrees: "0.00",
      sorties: "4000.00",
      variation: "-4000.00",
      autresDevises: false,
    },
    moisFuturs: [
      {
        libelleMois: "2026-07",
        entrees: "0.00",
        sorties: "10000.00",
        variation: "-10000.00",
        autresDevises: false,
      },
      {
        // Le mois du constat d'origine : « Sorties Rs 10 000 / Net −Rs 10 000 » au survol,
        // et RIEN à l'écran.
        libelleMois: "2026-08",
        entrees: "0.00",
        sorties: "10000.00",
        variation: "-10000.00",
        autresDevises: false,
      },
      {
        // Une entrée AUSSI faible : le défaut n'est pas propre aux sorties.
        libelleMois: "2026-09",
        entrees: "25000.00",
        sorties: "10000.00",
        variation: "15000.00",
        autresDevises: false,
      },
    ],
  },
};

/**
 * État PRÉVISIONNEL « CONTRASTÉ » — le cas dur de l'ENCART (FLUX-PREV-AXE1, option E).
 *
 * ⚠️ Fixture d'INTÉGRITÉ DE TEST, comme `DEMO_DASHBOARD_PREVISION_FAIBLE`, mais contre un
 * défaut DIFFÉRENT — et c'est tout l'objet de ce lot.
 *
 * Sortir la prévision de l'axe du réalisé supprime l'écrasement CONTRE LE RÉALISÉ (1:520).
 * Il ne supprime pas l'écart d'ordre de grandeur INTERNE à la prévision : une échéance de
 * Rs 10 000 posée à côté d'un règlement fournisseur de Rs 3 150 000 donne 1:315 — dans
 * l'encart, à son échelle propre. Aucune fixture du corpus ne l'exposait (leur écart
 * interne plafonnait à ~1:6), donc l'encart aurait été validé en Gate 4 sur des cas
 * uniquement favorables : exactement l'angle mort que le lot 0 avait fermé pour le graphe.
 *
 * Attendu dans l'encart : la barre de Juillet est irreprésentable et se réduit à un TICK
 * de présence, MAIS son montant reste écrit en toutes lettres — le montant est le canal
 * principal, la barre n'est que l'appui comparatif. Aucune valeur ne doit disparaître.
 *
 * Ne PAS « équilibrer » ces montants pour faire joli : cette fixture est censée être rude.
 */
export const DEMO_DASHBOARD_PREVISION_CONTRASTEE: DonneesDashboard = {
  ...DEMO_DASHBOARD,
  prevision: {
    moisCourant: {
      // Le cas SOUS-PIXEL : une petite cotisation résiduelle, 1:1260 face au règlement de
      // septembre → ~0,08 % de la piste, soit moins d'un pixel. C'est ELLE qui prouve que
      // l'encart ne perd aucune valeur : sa barre se réduit au tick, son montant s'écrit.
      libelleMois: "2026-06",
      entrees: "0.00",
      sorties: "2500.00",
      variation: "-2500.00",
      autresDevises: false,
    },
    moisFuturs: [
      {
        // Le cas LIMITE mais représentable : 1:315 → ~2,5 px. Il garde la borne haute, pour
        // qu'« étiqueter tout, tout le temps » ne puisse pas passer la garde inaperçu.
        libelleMois: "2026-07",
        entrees: "0.00",
        sorties: "10000.00",
        variation: "-10000.00",
        autresDevises: false,
      },
      {
        libelleMois: "2026-08",
        entrees: "120000.00",
        sorties: "0.00",
        variation: "120000.00",
        autresDevises: false,
      },
      {
        // Le gros règlement qui fixe l'échelle de l'encart.
        libelleMois: "2026-09",
        entrees: "0.00",
        sorties: "3150000.00",
        variation: "-3150000.00",
        autresDevises: false,
      },
    ],
  },
};

/**
 * État PRÉVISIONNEL « ZÉRO » (§5.4) : la zone prévisionnelle EXISTE (la fenêtre atteint le
 * mois courant, il y a des échéances dans le workspace) mais AUCUNE ne tombe sur ces mois —
 * toutes les colonnes sont à zéro, dans la devise de base ET ailleurs.
 *
 * À ne pas confondre avec les deux voisins, que le rendu doit DISTINGUER :
 *  - `prevision: null` (D4, fenêtre passée) → aucune zone du tout ;
 *  - `DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE` → colonnes à zéro AUSSI, mais parce que les
 *    échéances sont dans une autre devise (`autresDevises: true`) — dire « aucune
 *    échéance » y serait un FAUX constat.
 *
 * Attendu : un message explicite dans la zone, jamais un aplat beige muet (qui se lit
 * comme « la donnée n'a pas chargé »).
 */
export const DEMO_DASHBOARD_PREVISION_ZERO: DonneesDashboard = {
  ...DEMO_DASHBOARD,
  prevision: {
    moisCourant: {
      libelleMois: "2026-06",
      entrees: "0.00",
      sorties: "0.00",
      variation: "0.00",
      autresDevises: false,
    },
    moisFuturs: ["2026-07", "2026-08", "2026-09"].map((libelleMois) => ({
      libelleMois,
      entrees: "0.00",
      sorties: "0.00",
      variation: "0.00",
      autresDevises: false,
    })),
  },
};

/**
 * État PRÉVISIONNEL « AUTRE DEVISE SEULE » (§5.3) : les mois futurs ne portent QUE des
 * échéances en devise ≠ base. Attendu : colonnes à ZÉRO + note multi-devises — jamais le
 * montant étranger affiché à la place, jamais une conversion inventée (DASH-FX1).
 */
export const DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE: DonneesDashboard = {
  ...DEMO_DASHBOARD,
  prevision: {
    moisCourant: {
      libelleMois: "2026-06",
      entrees: "0.00",
      sorties: "0.00",
      variation: "0.00",
      autresDevises: true,
    },
    moisFuturs: [
      {
        libelleMois: "2026-07",
        entrees: "0.00",
        sorties: "0.00",
        variation: "0.00",
        autresDevises: true,
      },
      {
        libelleMois: "2026-08",
        entrees: "0.00",
        sorties: "0.00",
        variation: "0.00",
        autresDevises: true,
      },
      {
        libelleMois: "2026-09",
        entrees: "0.00",
        sorties: "0.00",
        variation: "0.00",
        autresDevises: true,
      },
    ],
  },
};
