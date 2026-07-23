# PLAN — Refonte des graphiques TYGR au niveau FYGR (GRAPHS-FYGR-V2)

> **Phase : CONCEPTION UNIQUEMENT** (CLAUDE.md règle 1). Aucune ligne de code applicatif,
> aucune migration, aucun composant écrit. Ce document est le livrable ; l'implémentation
> suivra dans un fil séparé, après arbitrage humain des décisions du §9.
>
> **Date** : 2026-07-23 · **Branche** : `plan/graphs-fygr` · **Chantier** : rattaché à
> `PROD-GRAPHS-FYGR1` (TODOS.md) dont il est la suite opérationnelle.
> **Prédécesseurs lus (non dupliqués ici)** : `PLAN-cadrage-graphs-fygr.md` (2026-07-02,
> décision consume-vs-recompute), `PLAN-cadrage-scenario-previsionnel-fygr.md` (2026-07-16,
> prévisionnel/scénarios A→D), `PLAN-prod-treso-eod.md` (branche `plan/treso-eod`, gate
> `RunningBalance`), `PLAN-flux-previsionnel-lisibilite.md` (option E, FLUX-PREV-AXE1).
> **Sources de vérité** : `CLAUDE.md`, `docs/UI_GUIDELINES.md`, tokens `src/app/globals.css`.

---

## 0. TL;DR — ce qui est faisable, ce qui ne l'est pas, et pourquoi

Le brief liste 7 observations FYGR. Après lecture du code réel et des captures
(`docs/benchmarks/FYGR/1_dashboard/`), elles se répartissent en **trois familles** :

| # | Observation du brief | Verdict | Bloqueur |
|---|---|---|---|
| 6 | Barres entrées/sorties mensuelles | **Déjà livré** (`flux-bars.tsx`) | — |
| 5 | Bascule graphique / tableau | **Livrable immédiatement** — les deux vues existent, elles ne sont pas sous un toggle | — |
| 3 | Légendes nommées cliquables | **Livrable immédiatement** — légende existante non interactive | — |
| 2a | Filtre par périodicité (jour/semaine/mois) | **Livrable** — le repo le sert déjà, l'UI ne l'expose pas | — |
| 2b | Filtre par devise | **Livrable** — mais c'est un besoin TYGR, pas FYGR (mono-€) | — |
| 7 | Panneau de détail mensuel | **Livrable** — forme à trancher (D6) | — |
| 2c | Filtre par compte | **À NE PAS construire tel quel** — doublonnerait le `PerimetreSwitcher` global | §1.2 |
| 1 | Sélecteur de séries | **Requalifié** — chez FYGR ce n'est pas un sélecteur de séries (§1.1) | §1.1 |
| 4 | Overlay de scénarios (prévisionnel superposé) | **BLOQUÉ ×2** — rouvre une décision tranchée, et la donnée n'existe pas | §1.3, §1.4 |

> **Le cœur du message** : ~70 % de l'écart avec FYGR se comble **sans nouvelle donnée
> ni nouvelle table** — c'est de l'exposition d'agrégats déjà calculés et de l'interaction
> UI. Les 30 % restants (position de trésorerie, prévisionnel superposé, scénarios nommés)
> sont **bloqués par des dépendances amont réelles**, pas par du travail d'UI, et deux
> d'entre eux rouvrent des décisions déjà arbitrées. Livrer les 70 % d'abord est le seul
> découpage honnête.

---

## 1. Pushback (règle 10) — quatre points à trancher AVANT toute ligne de code

### 1.1 Le « sélecteur de séries » de FYGR n'est pas un sélecteur de séries

**Fait, pas opinion.** Capture `accueil-4.png` : le dropdown « Sélectionner les séries »
ouvert affiche un champ « Rechercher une série », un titre **« MES ARCHIVES »**, l'état vide
**« Aucune sauvegarde enregistrée »** et un bouton **« + Sauvegarde »**. En vue tableau
(`accueil-6.png`, `accueil-7.png`) le même contrôle affiche **« Central »** — le nom du
scénario par défaut.

C'est donc un **gestionnaire de jeux de données sauvegardés** (archives/scénarios), pas un
filtre « quelles courbes afficher ». Le vrai contrôle « masquer/afficher une courbe » est la
**légende** (`— Position de trésorerie` / `— Prévisionnel`, `accueil.png`).

**Conséquence** : construire « un sélecteur de séries » à partir de la lecture littérale de
la capture reviendrait à construire un système de **persistance de vues nommées** (table,
migration, CRUD, RLS) en croyant faire un filtre d'affichage. Les deux besoins sont
séparés dans ce plan : **légende interactive** (L1, immédiat) et **vues sauvegardées**
(hors périmètre, cf. §11).

### 1.2 Un filtre « par compte » in-page recréerait un doublon déjà supprimé deux fois

Le périmètre de comptes/entités vit dans le **`PerimetreSwitcher` global**
(`src/components/shell/perimetre-switcher.tsx`), et ce n'est **pas un filtre d'affichage** :
c'est un prédicat RLS réel (`app.current_view_filter`, policy `account_scope` RESTRICTIVE,
migrations 0016/0017) porté par le JWT.

Le projet a **déjà retiré deux fois** un sélecteur de comptes in-page pour cette raison :
`/transactions` (« retrait feedback 0709 : doublon moche du sélecteur navbar ») puis les
dates in-page de la même toolbar (TX-TOOLBAR-DEDUP1, livré 2026-07-15). Le mode de
défaillance est documenté et concret : **deux filtres concurrents sur le même écran**, dont
un seul mord réellement sur la donnée, produisent un affichage qui ment.

**Recommandation** : `/graphiques` porte déjà `perimetre: true` (`toolbar-config.ts`). Le
filtre « Comptes » de FYGR est donc **déjà couvert** ; si la granularité manque (banque →
comptes), c'est la dette existante `UI-PERIMETRE-ACCORDEON1`, pas un nouveau contrôle.

### 1.3 « Prévisionnel superposé au réalisé » rouvre une décision tranchée le 2026-07-20

`FLUX-PREV-AXE1` (option E de `PLAN-flux-previsionnel-lisibilite.md`, direction retenue par
Etienne) a **sorti la prévision de l'axe du réalisé**, et la raison est de fond :

- le réalisé est une mesure **exhaustive** (`transactions_cache`) ;
- la prévision est un sous-ensemble **déclaré** (les seules échéances saisies à la main) ;
- rapport mesuré jusqu'à **1:520** → la barre projetée rendait 0,23 px et le lecteur
  concluait « la trésorerie s'effondre » : **un faux constat produit par la mise en regard
  elle-même**, qu'aucun habillage ne corrige (les lots 0-2 de #228 l'ont atténué sans le
  supprimer).

FYGR n'a pas ce problème : sa courbe superposée est une **position de trésorerie projetée**
(même nature, même ordre de grandeur), pas un sous-ensemble d'échéances.

**Recommandation** : ne PAS re-superposer les échéances. L'overlay ne devient légitime que
si la série prévisionnelle est une **projection du flux attendu** — commensurable au
réalisé — ce qui est exactement l'objet de la dette **`FLUX-PREV-BASELINE1`** (option F).
L'overlay est donc un lot **conditionné** (L6), pas un lot du MVP.

### 1.4 La courbe bleue de la capture n'est pas alimentable aujourd'hui

La série centrale de `accueil.png` est **« Position de trésorerie »** — un **stock**, pas un
flux. Côté TYGR :

- `balance_history` est **vide en permanence** (l'endpoint amont `/balances/history` est 404
  et n'est de toute façon jamais appelé dans le chemin de sync réel) ;
- `courbeTresorerie` (`dashboard.ts:466`) est **débranchée** (dette `DASH-COURBE-SOLDE-EOD`)
  et porte un **bug cross-devise connu** (somme sans `GROUP BY currency`) à corriger avant
  toute réactivation ;
- la voie de reconstruction (`RunningBalance`) est sous **gate bloquant non franchi**
  (`PLAN-prod-treso-eod.md` §1 : champ nullable, non documenté, jamais persisté).

**Conséquence à assumer** : à ce jour, « ressembler à FYGR » signifie livrer la partie
**FLUX** du graphe (barres entrées/sorties + net), **pas** la ligne de position. Annoncer
l'inverse serait promettre un écran qu'aucune donnée ne remplit.

**Corollaire** : le **double axe Y** de FYGR (position à gauche, flux à droite) est
déjà écarté par le plan lisibilité (option G) — deux échelles dans un seul graphe rendent
des hauteurs égales pour des montants sans rapport. Ne pas le réintroduire par mimétisme.

---

## 2. Cible FYGR — relecture factuelle des captures

Source : `docs/benchmarks/FYGR/1_dashboard/accueil*.png` (14 captures, workspace démo
« ovnicame », mono-€).

**Toolbar du graphe** (gauche → droite) :
`Comptes ▾` · `Périodicité ▾` ··· `Sélectionner les séries ▾` · `⭳ Exporter les données` ·
`[▮▮ graphique | ▤ tableau]` · `✎ Scénario` (primaire) · `⚙ Paramètres`.

- **Comptes** (`accueil-2.png`) : popover « **Consolider plusieurs entités** », une ligne par
  banque/entité avec **solde** et **case à cocher**, pied « + Ajouter une banque ».
  → équivalent TYGR = `PerimetreSwitcher` (§1.2).
- **Périodicité** (`accueil-3.png`) : **date de début** (`01/12/2025`) + **pas temporel**
  `Jours / Semaines / Mois`. Ce sont **deux axes distincts** : la FENÊTRE et le PAS.
- **Séries** (`accueil-4.png`) : archives/sauvegardes (§1.1).
- **Toggle graphique/tableau** (`accueil-6.png`, `accueil-7.png`) : la vue tableau est une
  **matrice** `catégories × mois`, avec bloc de synthèse haut (Position début, Entrées,
  Sorties, Variation, Position fin), lignes de catégories repliables `▸`, colonne
  `JUIN.26 — Réalisé à date` en `primary`, puis colonnes `Prévision` sur **fond grisé**.
- **Légende** (`accueil.png`) : deux entrées **nommées**, pastille + libellé —
  `Position de trésorerie` (bleu) et `Prévisionnel` (gris).
- **Graphe** : barres vertes (entrées) / rouges (sorties) par mois, courbe de position,
  **ligne de seuil horizontale** rouge, **zone future grisée**, navigation `‹ ›` sur l'axe X,
  double axe Y.
- **Paramètres** (`accueil-9.png`) : « Accéder aux formules », « Paramétrer l'usage des
  échéances » (`accueil-11.png`), « Importer un prévisionnel » (`accueil-12.png`, xls/xlsx).
- **Scénario** (`accueil-8.png`) : panneau « MES SCÉNARIOS » + modale « Ajouter un
  scénario » (champ *Nom du scénario*).

**Non observable dans les captures fournies** : le **panneau de détail mensuel** (item 7 du
brief). Aucune capture ne montre un drill-down sur un mois. Il est traité ici comme une
**exigence produit du brief** (donc conçu), avec sa forme laissée en décision ouverte (D6) —
et non comme une reprise de FYGR dont on pourrait copier le comportement.

**Deux différences structurelles à ne jamais perdre de vue** : FYGR est **mono-devise (€)**
et **mono-entité consolidée**. TYGR est **multi-devise (MUR/USD/EUR)** avec interdiction
d'addition cross-devise, et **multi-entités** sous un workspace-groupe.

---

## 3. Inventaire de l'existant TYGR (état réel, lu ce jour)

### 3.1 Couche données (dérivée — aucune dépendance à `/insights`, 501 amont)

| Fonction | Fichier | Ce qu'elle fait déjà |
|---|---|---|
| `cashflowParDevise(tx, {granularite, from, to})` | `src/server/repositories/insights.ts:118` | Entrées/sorties/net + `nbTransactions` **par bucket ET par devise**, granularité **`jour \| semaine \| mois`** (enum fermée → littéral SQL `date_trunc` figé) |
| `vendorsParConcentration` | `insights.ts:202` | Concentration par contrepartie, par devise, avec `part` |
| `repartitionParCategorie` | `insights.ts:644` | Répartition par catégorie **effective** (cascade splits › `primary_category`), multi-devise, + fenêtre précédente |
| `axeCategorieEffective` | `insights.ts:358` | Axe de catégorie (niveau `feuille \| nature`) |
| `syntheseParMois(tx, {from, to})` | `src/server/repositories/dashboard.ts:623` | Série `(mois × devise)` entrées/sorties/variation, bornes **jour inclusives** |
| `synthesePeriodeParDevise` | `dashboard.ts:558` | Synthèse de période par devise |
| `grilleMois` / `grilleMoisSuivants` | `dashboard.ts:668` / `:699` | Grille d'axe **mensuelle** continue (pure, arithmétique entière, sans dérive de fuseau) |
| `courbeTresorerie` | `dashboard.ts:466` | **Débranchée** (`balance_history` vide) **+ bug cross-devise** — cf. §1.4 |

Invariants déjà tenus par ces repos : `withWorkspace` (RLS tenant), **`innerJoin`
`bank_accounts`** (héritage du scope entité, ENTITY-READ-JOIN1), `is_removed` exclu,
agrégats **en SQL → chaînes décimales** (règle 8), buckets sur `transaction_date` (**déjà**
date comptable Maurice, E20 — aucune re-conversion de fuseau).

### 3.2 Couche rendu

| Composant | Fichier | État |
|---|---|---|
| Ancre « Flux de trésorerie » | `src/components/dashboard/flux-tresorerie-card.tsx:28` | Barres mensuelles, **100 % réalisé**, légende **statique** (Entrées/Sorties) |
| Barres SVG | `dashboard/flux-bars.tsx` | SVG inline, `ResizeObserver`, `echelleNice`, mono-devise (base) |
| Tableau « Évolution mensuelle » | `dashboard/monthly-cashflow.tsx:35` | **Le tableau existe déjà** : mois × Entrées/Sorties/Variation, `tabular-nums`, mention « + autres devises » |
| Projection d'axe | `dashboard/flux-projection.ts` | `projeterSurGrille`, `maxFenetre`, `ColonneFlux` (frontière réalisé/projection **intacte mais débranchée**) |
| Encart Échéances | `dashboard/echeances-encart.tsx` | Prévision **à échelle propre** (option E) |
| Donut catégories | `src/components/graphiques/donut-categories.tsx` | Multi-devise, palette `chart.cat`, total au centre (format compact au-delà d'un seuil mesuré) |
| Légende catégories | `graphiques/legende-categories.tsx` | Nommée, **survol partagé** donut↔légende, badge de variation vs période précédente — **mais pas de masquage** |
| Conteneur | `graphiques/graphiques-feature.tsx:107` | `useState` + Server Action injectée ; sélecteurs SENS + PÉRIODE ; 4 états |
| Contrôle segmenté | `graphiques-feature.tsx:63` | `ControleSegmente<T>` **privé au fichier** (radiogroup, focus ring) |

### 3.3 Chrome et filtres globaux

- `src/components/shell/barre-vue.tsx` + **matrice** `shell/toolbar-config.ts` :
  `/graphiques` → `{ periode: false, perimetre: true, cta: false }`.
  La période a été **retirée** de la barre pour `/graphiques` (le switcher ne filtrait rien) ;
  le vrai filtre vit in-page. Dette ouverte : **`GRAPHIQUES-PERIODE-DEDUP1`**.
- **Deux vocabulaires de période coexistent** :
  `src/lib/periode.ts` (URL, dashboard : `ce-mois / 3m / 6m / 12m / tout` + plage `?du`/`?au`)
  vs `src/lib/periode-analyse.ts` (in-page, graphiques : `mois-courant / 30-jours / 90-jours /
  12-mois`). **La barre n'a pas de fenêtre glissante ; les graphiques n'ont pas de « Tout ».**
- Garde CI existante : « une page qui **monte** la période doit la **lire** »
  (`tests/unit/toolbar-config.test.ts`) — toute évolution des filtres passe par là.

### 3.4 Formatage (source unique, non négociable)

`src/lib/format-montant.ts` — `formatMontant`, `formatMontantCompact`, `estNegatif`,
`estZero`, `symbolePrefixe`, `chiffresPartieEntiere`.
`src/lib/format-date.ts` — `formaterMoisCourt`, `formaterMoisAnnee`, `formaterDateComptable`,
`formaterIntervalleComptable`, `dateCouranteMaurice`, `moisCourantMaurice`.
**Interdit** de redéfinir un formateur local (dette C8 tuée par cette règle).

---

## 4. Gap analysis — brief FYGR vs existant

| Exigence du brief | Existant TYGR | Écart réel | Coût |
|---|---|---|---|
| **Sélecteur de séries** | aucun | Requalifié (§1.1) : ce qu'il faut, c'est une **légende cliquable** (ci-dessous) + éventuellement des vues sauvegardées (hors périmètre) | — |
| **Filtre par compte** | `PerimetreSwitcher` global (RLS) | **Aucun écart fonctionnel.** Écart d'ergonomie éventuel = `UI-PERIMETRE-ACCORDEON1` | 0 (ce plan) |
| **Filtre par devise** | Graphe figé sur `base_currency` (`flux-bars.tsx`) ; le donut, lui, est déjà multi-devise | **Écart réel** — dette `DASH-CASHFLOW-MULTISERIE` : un workspace majoritairement non-MUR voit une carte muette | S |
| **Filtre par périodicité (J/S/M)** | `cashflowParDevise` sert **déjà** les 3 granularités ; l'ancre est câblée en **mensuel dur** (`syntheseParMois`) | **Écart d'exposition UI**, pas de donnée. Manque : une **grille de buckets** non mensuelle | M |
| **Légende nommée cliquable** | Légende statique (`flux-tresorerie-card.tsx:70`) ; légende catégories interactive **au survol seulement** | **Écart réel** : nommage OK, masquage absent | S |
| **Overlay de scénarios** | `EcheancesEncart` (échelle propre, option E) ; `ColonneFlux` conservé mais débranché | **Bloqué** (§1.3 + §1.4). Scénarios nommés = table à créer (`PROD-SCENARIO-FYGR1` D) | L, conditionné |
| **Toggle graphique / tableau** | Les **deux vues existent** mais empilées comme deux cartes distinctes (ancre + « Évolution mensuelle ») | **Écart d'assemblage** : un toggle, pas un nouveau composant | S |
| **Barres entrées/sorties mensuelles** | **Livré** (`flux-bars.tsx`) | Aucun | 0 |
| **Panneau de détail mensuel** | Aucun (tooltip de barre uniquement) | **Écart réel**, forme à trancher (D6) | M |

---

## 5. Architecture de composants proposée

### 5.1 Principes (non négociables, rappel)

- **Composants d'affichage PURS** : zéro fetch, zéro état interne, handlers en props
  optionnelles et inertes ; le conteneur décide quel état monter.
- **Aucune couleur en dur** : tokens sémantiques uniquement. `inflow`/`outflow` = **donnée**
  (jamais une erreur, jamais un élément de chrome) ; séries neutres = `chart.donut` /
  `chart.cat[]` / `chart.catNeutral` ; prévisionnel = `surface-forecast` + `chart.forecastFill`
  **et** un label (jamais la couleur seule, §3.5) ; seuil = `chart.threshold`.
- **Zéro dépendance externe** (règle 9) : SVG inline + `cn` local, comme l'existant.
  Tremor est cité dans UI_GUIDELINES mais **n'est pas utilisé** par les graphes actuels —
  ne pas l'introduire par ce chantier.
- **Formatage** : `format-montant.ts` / `format-date.ts` **exclusivement**.
- **Le `parseFloat` est réservé à la GÉOMÉTRIE** (hauteur de barre, angle, largeur), jamais
  réinjecté dans un montant affiché.

### 5.2 Arborescence cible

```
src/components/charts/                     ← NOUVEAU, transverse et PUR
  series-types.ts                          types d'affichage (aucun import serveur)
  legende-series.tsx                       légende NOMMÉE + interactive (masquer/afficher)
  toggle-vue.tsx                           bascule graphique ↔ tableau
  panneau-detail-periode.tsx               drill-down d'un bucket (réutilise ui/modal)
  grille-buckets.ts                        axe continu jour/semaine/mois (PUR, Maurice)

src/components/ui/
  controle-segmente.tsx                    ← PROMU depuis graphiques-feature.tsx:63
  select/                                  (existant — filtres devise/périodicité)

src/components/dashboard/                  (existant, étendu)
  flux-tresorerie-card.tsx                 devient l'hôte du toggle + de la légende
  flux-bars.tsx                            accepte N séries visibles (au lieu de 2 figées)
  flux-projection.ts                       étendu : projection multi-devise/multi-granularité
```

**Pourquoi `src/components/charts/` et pas dans `dashboard/`** : ces briques servent
`/` **et** `/graphiques`. Les laisser sous `dashboard/` obligerait `/graphiques` à importer
du « dashboard », ce qui a déjà produit une contrainte réelle (`monthly-cashflow.tsx`, Server
Component, ne peut pas importer `flux-bars.tsx` qui est client → d'où l'extraction de
`flux-projection.ts`). Le module `charts/` porte la même discipline : **les modules de calcul
sont des `.ts` neutres, sans `"use client"`**, pour rester appelables depuis un RSC.

**Pourquoi promouvoir `ControleSegmente`** : il est aujourd'hui privé de
`graphiques-feature.tsx`. Le réutiliser pour la périodicité et le toggle sans le promouvoir
créerait une **deuxième implémentation** du même contrôle (radiogroup + focus ring + états
désactivés) — exactement le motif de dette que la règle « source unique » combat.

### 5.3 Contrats de composants (esquisse — aucune implémentation)

**`SerieAffichable`** (`series-types.ts`) — modèle d'affichage, **pas** un miroir de DTO
serveur :

```
id: string                  // stable, sert de clé de visibilité
libelle: string             // NOMMÉ, en français, affiché tel quel dans la légende
type: "barre" | "ligne"
tokenCouleur: string        // nom de token, jamais un hex
devise: string              // une série n'agrège JAMAIS deux devises
points: Array<{ bucket: string; valeur: string }>   // valeur = CHAÎNE décimale
```

**`LegendeSeries`** (pur, client uniquement pour le clic) :
- props : `series: SerieAffichable[]`, `visibles: ReadonlySet<string>`,
  `onBasculer?: (id: string) => void`.
- a11y : chaque entrée est un `<button aria-pressed>` (pas un `div` cliquable), libellé
  explicite (« Masquer la série Entrées »), focus ring `primary` visible.
- **Invariant produit** : on ne peut pas masquer **toutes** les séries (le graphe ne doit
  jamais devenir un cadre vide sans explication) — la dernière série visible n'est pas
  désactivable, et le bouton l'annonce (`aria-disabled` + `title`).
- Série masquée : opacité réduite + **texte barré ou pastille creuse** — jamais la couleur
  seule (WCAG 1.4.1).
- ⚠️ Piège mémorisé : un `title` posé sous un conteneur `pointer-events-none` est une
  infobulle **morte**. La légende reste interactive de bout en bout.

**`ToggleVue`** : `radiogroup` à 2 options (Graphique / Tableau), icônes + **libellé texte**
(pas d'icône seule), motif visuel de `ControleSegmente`.

**`PanneauDetailPeriode`** : reçoit un bucket déjà résolu (`libelle`, `entrees`, `sorties`,
`variation`, `nbTransactions`, top catégories, top contreparties, devise) et un
`href` vers `/transactions` pré-filtré. **Pur** : il ne va rien chercher.
⚠️ Piège mémorisé (`Modal`) : contenu haut inatteignable si double débordement, état qui
survit à la fermeture, focus d'un `useEffect` qui écrase l'ancre du handler, `Escape` dans un
portail. Ces 4 points sont des cas de test explicites (§8), pas des « points d'attention ».

**`grille-buckets.ts`** : `grilleBuckets(granularite, from, to): string[]` — pure, sans
horloge, arithmétique calendaire sur dates « nues » déjà en Maurice (même patron que
`grilleMois`). Étiquettes : `YYYY-MM-DD` (jour), lundi ISO `YYYY-MM-DD` (semaine, aligné sur
le `date_trunc('week')` du repo), `YYYY-MM` (mois) — **identiques** à celles produites par
`cashflowParDevise`, sinon la jointure grille↔série échoue en silence.

### 5.4 Conteneur et état

`/graphiques` a déjà le bon patron : conteneur client + **Server Action injectée** par la
page RSC (closure `"use server"`), état local, re-fetch au changement de sélecteur, données
précédentes conservées pendant le chargement (`aria-busy`, pas de saut de layout).

⚠️ Piège mémorisé : `"use server"` **capture** une fonction locale → plantage au **rendu**
(lint/tsc/build verts). La closure d'action reste **inline** dans la page, comme aujourd'hui
(`graphiques/page.tsx:60`).

**Visibilité des séries et périodicité** : état **client** (pas d'aller-retour serveur pour
masquer une courbe). **Fenêtre temporelle** : décision D1.
⚠️ Piège mémorisé : si un état initial dérive d'un filtre d'URL, le composant client doit
porter une `key` de remount, sinon `useState(initial)` reste **périmé**.

---

## 6. Modèle de données d'alimentation

### 6.1 Ce qui ne bouge pas

- **Source unique** : `transactions_cache` (Voie A). La décision consume-vs-recompute reste
  **forcée** par le `501` amont sur `/insights/*` (re-vérifié 2026-07-02) — ce plan ne la
  rouvre pas. Déclencheur de réouverture inchangé : passage **501 → 200**.
- **Fuseau** : les buckets s'appuient sur `transaction_date`, **déjà** date comptable
  Maurice (E20). Aucune re-conversion. Les **bornes** de fenêtre sont dérivées à Maurice
  côté serveur (`bornesPeriodeMaurice` / `resoudrePeriode`) — le client n'envoie jamais une
  date issue de son propre fuseau.
- **Multi-devise** : `GROUP BY currency` partout, **jamais** d'addition cross-devise, aucune
  conversion FX (`DASH-FX1` reste fermé). Une série = une devise.
- **Périmètre** : la RLS seule (`workspace_id` + `account_scope`/`entity_scope`).
  ⚠️ **Ne JAMAIS introduire un paramètre applicatif `accountIds`** dans ces repos pour
  « filtrer par compte » : ce serait un second chemin de périmètre, indiscernable du vrai
  au lint, et une garde qui compte sous la RLS se contourne. Le filtre compte = `viewFilter`.

### 6.2 Ce qui est à ajouter (data)

1. **Grille de buckets non mensuelle** (`grille-buckets.ts`, §5.3) — pur, testable, aucun SQL.
2. **Exposition de la granularité** jusqu'à l'UI : la chaîne
   `granularite` (déjà validée par `granulariteCashflowSchema`, enum fermée) → Server Action
   → `cashflowParDevise`. **Rien à écrire côté SQL.**
3. **Détail d'un bucket** (drill, L4) : une lecture dédiée
   `detailBucket(tx, {granularite, bucket, devise})` renvoyant synthèse + top catégories +
   top contreparties de CE bucket. Réutilise les patrons `repartitionParCategorie` et
   `vendorsParConcentration` (mêmes gardes, même forme de sortie).
4. **Borne de volumétrie** : `jour` × fenêtre 12 mois × N devises ≈ 365·N points.
   Plafond à poser **en zod ET dans le repo** (défense en profondeur, patron existant) :
   nombre de buckets max (proposition : 400) → au-delà, la granularité est **refusée**
   avec un code nommé (`GRANULARITE_TROP_FINE`), jamais tronquée en silence.

### 6.3 Vigilances de performance

- Les agrégats tournent **sous RLS**. Piège documenté : l'estimateur est opaque à une policy
  → plan `Nested Loop` sous `LIMIT`. Toute lecture nouvelle est **mesurée** (EXPLAIN
  ANALYZE sous le rôle `tygr_app`, jamais sous l'owner) avant livraison ; `MATERIALIZED` ne
  corrige rien (une sous-requête **corrélée** est la seule forme non réordonnable).
- Le drill (L4) ne doit pas dégénérer en N+1 : une lecture par ouverture de panneau, pas une
  par ligne affichée.

---

## 7. Découpage en lots

| Lot | Contenu | Dépend de | Effort | Nouvelle donnée ? |
|---|---|---|---|---|
| **L0** | Arbitrage des décisions §9 (D1, D2, D7, D8 au minimum) | humain | — | non |
| **L1** | **Légende nommée interactive** + **toggle graphique/tableau** sur l'ancre. Promotion de `ControleSegmente`. Le tableau monté est `MonthlyCashflow` (existant). | L0 (D8) | **S** | **non** |
| **L2** | **Périodicité J/S/M** : `grille-buckets.ts`, exposition de `granularite`, `flux-bars` sur bucket générique (axe X : `formaterMoisCourt` → étiquette selon granularité) | L0 (D1) | **M** | non (repo existant) |
| **L3** | **Filtre devise** : ferme `DASH-CASHFLOW-MULTISERIE`. Sélecteur ou séries parallèles selon D2. | L0 (D2) | **S/M** | non |
| **L4** | **Panneau de détail de bucket** (drill) + `detailBucket` | L0 (D6) | **M** | **oui** (1 lecture) |
| **L5** | *Conditionné* — série **Position de trésorerie** | **gate `PROD-TRESO-EOD1` franchi** + fix bug cross-devise de `courbeTresorerie` | L | oui |
| **L6** | *Conditionné* — **overlay prévisionnel** commensurable | `FLUX-PREV-BASELINE1` (option F) tranchée | L | oui |
| **L7** | *Hors périmètre de ce plan* — scénarios nommés persistés, vues sauvegardées, export, moteur de formules | `PROD-SCENARIO-FYGR1` C/D | XL | oui (migrations) |

**L1 seul comble 3 des 7 observations du brief sans toucher à la donnée.** C'est le premier
incrément à livrer.

---

## 8. Critères de sortie

### 8.1 Règle 3 — par nouvelle route / Server Action (L2, L3, L4)

Livrés dans le **même PR**, sinon le PR est incomplet :

- [ ] **Authz** via `withWorkspace` ; ressource d'un autre tenant → **404, jamais 403**.
- [ ] **Validation zod stricte** (dans `src/lib/insights-schema.ts`, importable client, qui
      ne dépend jamais de `src/server/**`) :
      `granularite` = enum fermée (déjà) ; `devise` = code ISO validé contre la liste
      **réellement présente** en base (jamais une chaîne libre injectée dans un `WHERE`) ;
      `bucket` = format calendaire strict **et** cohérent avec la granularité ;
      **plafond de buckets** (§6.2.4). Rejet bruyant avec code nommé.
- [ ] **Enum → littéral SQL figé** : la granularité ne touche jamais le SQL autrement que par
      la table de correspondance existante (`UNITE_TRUNC`, `insights.ts:85`). Aucune
      interpolation.
- [ ] **Audit ciblé (OWASP ASVS)** : injection (paramètres liés uniquement), **IDOR** (cas
      ajouté à la suite isolation), messages non énumérants.
- [ ] **Périmètre entité** : toute nouvelle lecture **joint `bank_accounts`**
      (ENTITY-READ-JOIN1) — ceinture, en plus des policies `account_scope`.
- [ ] **Codes d'erreur nommés** mappés UI (registre existant : `INVALID_PARAMS`,
      `SERVICE_UNAVAILABLE`, + `GRANULARITE_TROP_FINE`). Catch-all silencieux interdit.
- [ ] **Tests** : chemin heureux + chemin d'échec spécifique + cas limite (fenêtre vide,
      devise absente, bucket hors fenêtre, une seule série visible).
- [ ] **Logs structurés** corrélés (`workspace_id`), **sans PII** (aucun libellé bancaire).

### 8.2 Quality Gate 4 — Visual QA (bloquant)

Captures **localhost** (navigateur headless gstack) de **chaque état modifié** —
loading / vide / erreur / **partiel** — comparées par vision à `docs/UI_GUIDELINES.md` §6.

**Écarts objectifs = BLOQUANTS** :
- [ ] `inflow`/`outflow` **uniquement** sur la donnée ; erreurs = fond `danger-bg` + icône +
      message + `role="alert"` ; skeleton **neutre** (aucune couleur sémantique).
- [ ] **Aucune couleur en dur** dans les nouveaux fichiers (grep bloquant : `#`, `rgb(`).
- [ ] `tabular-nums` sur **tout** montant, axe et cellule ; **aucun montant tronqué**
      (`whitespace-nowrap`), seuls les libellés tronquent.
- [ ] Devise en **préfixe symbolique** + espace fine insécable ; virgule décimale ; `−`
      typographique. **Virgules décimales alignées** en multi-devise.
- [ ] Prévisionnel (si L6) : `surface-forecast`/opacité **ET** label — jamais la couleur seule.
- [ ] Focus ring visible sur **chaque** entrée de légende, segment, toggle, ligne cliquable.
- [ ] Header **jamais** en `flex-wrap` (condenser sous le breakpoint).

**Protocole de mesure** (pièges déjà payés, à ne pas repayer) :
- [ ] Mesurer sur la route **réelle** (`/`, `/graphiques`), **pas** sur `/demo/*` : la démo
      n'a pas la sidebar (232 px) et donne une largeur fausse.
- [ ] Le screenshot mobile pleine page **ment** → trancher au DOM
      (`getBoundingClientRect` + sélecteur), jamais à l'œil sur l'image.
- [ ] SVG en `w-full` : **viewBox étiré** → ne jamais dériver un px CSS de ses unités ;
      comparer les **HEX** des fonds pour prouver un token.
- [ ] Contraste d'une icône mesuré **sur son fond réel** (un fond teinté rabote le contraste),
      jamais sur blanc.
- [ ] QA sous `next start` en **HTTP** (le proxy HTTPS casse l'hydratation ; un `next dev`
      voisin partage `.next/`).
- [ ] Route de démo `src/app/demo/graphiques-states/` **étendue** aux nouveaux états (hors
      production) — mais elle sert à capturer les états, pas à mesurer les largeurs.

### 8.3 Règle 5 — stop-loss

`lint` + `tsc --noEmit` + `build` verts avant tout commit ; aucun test rouge commité.
⚠️ Piège mémorisé : Bash tourne dans le **cwd de session**, pas dans le worktree — un
`npm run lint` « vert » peut n'avoir rien validé. Vérifier le chemin avant de conclure.

---

## 9. Tests

### 9.1 Unitaires purs (`tests/unit/`)

| Cible | Cas |
|---|---|
| `grilleBuckets` | mois (parité avec `grilleMois`) ; semaines **alignées au lundi ISO** (= `date_trunc('week')`) ; jours ; fenêtre d'un seul jour ; passage d'année ; **fenêtre où la grille et la série ne se recouvrent pas** (doit produire des zéros, pas des trous) |
| Étiquettes d'axe | une étiquette par granularité, via `format-date.ts` uniquement (aucun mois en dur) |
| Visibilité de séries | bascule ; **impossible de masquer la dernière série visible** ; une série masquée ne participe plus au `max` d'échelle |
| Échelle | `echelleNice` sur série signée ; fenêtre vide → message neutre (et non des barres à plat) ; ⚠️ garde de **magnitude**, pas seulement `≤ 0` : un dénominateur minuscule fait exploser un ratio → borner le **résultat** |
| Projection multi-devise | aucune addition cross-devise ; drapeau « autres devises » ; devise absente de la fenêtre |
| Toggle vue | l'état de vue survit à un changement de filtre ; la vue tableau reçoit **exactement** la même série que le graphe (invariant anti-divergence) |

### 9.2 Repo / intégration (`tests/integration/`)

- `cashflowParDevise` sur les 3 granularités : bornes **inclusives** des deux côtés,
  tombstones exclus, `GROUP BY currency` respecté, tri stable.
- `detailBucket` : cohérence avec l'agrégat parent (le total du panneau = la valeur de la
  barre, **à la chaîne près**, sans recalcul JS).
- Plafond de buckets : au-delà → erreur nommée, jamais un résultat tronqué.
- ⚠️ Fixtures : **écrire d'abord la fixture qui fait échouer** (une fixture trop favorable
  rend le défaut non capturable) ; cardinalités **distinctes** par clause quand une
  condition en combine plusieurs (sinon une fixture corrèle deux clauses et prouve l'une
  pour l'autre) ; vérifier l'unicité des UUID après tout rebase (`uniq -d`).

### 9.3 Isolation (BLOQUANT CI, `tests/isolation/`)

- Cross-workspace sur chaque nouvelle Server Action → **404**.
- Lecture sous **Vision Entité** (GUC posé) : la série ne contient que le périmètre ;
  compte `entity_id IS NULL` invisible (fail-closed).
- Lecture sous **viewFilter** (`account_scope`) : idem, et la garde reste vraie quelle que
  soit la **forme** de la requête (`from(fille).leftJoin(bank_accounts)` inclus).
- Preuve par **mutation** : commiter avant de muter ; vérifier que la policy est bien
  `RESTRICTIVE` (une `PERMISSIVE` s'OR'erait et ne filtrerait rien).
- ⚠️ Un `42501` ne discrimine pas RLS et privilège manquant : asserter le **périmètre**, pas
  seulement le refus.

### 9.4 Gardes de configuration

- `tests/unit/toolbar-config.test.ts` : si D1 fait porter la fenêtre par l'URL, `/graphiques`
  passe à `periode: true` **et** sa page doit appeler `resoudrePeriode(searchParams)` — la
  garde CI le vérifie déjà, elle ne doit pas être contournée par une exemption nommée.
- Si une garde de périmètre CI est ajoutée : **liste blanche**, jamais un scan (un scan
  laisse passer ce qu'on a oublié d'amputer).

---

## 10. Décisions ouvertes (l'humain tranche — recommandation donnée, non appliquée)

| # | Décision | Options | Recommandation |
|---|---|---|---|
| **D1** | **Qui possède la fenêtre temporelle de `/graphiques` ?** | (a) barre de vue globale (URL `?periode`/`?du`/`?au`) ; (b) in-page (statu quo) ; (c) barre = FENÊTRE, in-page = PAS temporel | **(c)** — ce sont deux axes distincts chez FYGR aussi (date de début + périodicité). Ferme `GRAPHIQUES-PERIODE-DEDUP1` sans casser le contrat « le client n'envoie qu'un preset fermé ». Exige de trancher le conflit de vocabulaire (la barre n'a pas 30 j/90 j ; les graphiques n'ont pas « Tout ») |
| **D2** | **Multi-devise à l'écran** | (a) sélecteur de devise (une série à la fois) ; (b) séries parallèles sur un axe commun ; (c) petits multiples (un graphe par devise) | **(a) par défaut, (c) en option.** (b) est **exclue** : superposer MUR et USD sur un axe commun laisse lire un rapport de grandeur qui n'existe pas |
| **D3** | **Position de trésorerie** | (a) attendre le gate `PROD-TRESO-EOD1` ; (b) reconstruire par cumul rétrograde du solde courant | **(a)**. (b) dérive silencieusement dès qu'une transaction manque, et un solde faux est pire qu'un solde absent |
| **D4** | **Overlay prévisionnel** | (a) jamais sur l'axe du réalisé ; (b) seulement si série commensurable (`FLUX-PREV-BASELINE1`) ; (c) rouvrir FLUX-PREV-AXE1 | **(b)** — conditionné, lot L6 |
| **D5** | **Scénarios nommés** | (a) hors périmètre graphique ; (b) inclus | **(a)** — c'est une persistance (table + RLS + CRUD), tracée par `PROD-SCENARIO-FYGR1` D |
| **D6** | **Forme du drill mensuel** | (a) panneau latéral ; (b) modale ; (c) expansion sous le graphe | **(b) modale** — la primitive existe (`ui/modal`, échelle z-index cadrée), et l'écran n'a pas la largeur d'un panneau latéral en plus de la sidebar. À valider visuellement |
| **D7** | **Filtre par compte** | (a) `PerimetreSwitcher` seul ; (b) filtre in-page | **(a)** — cf. §1.2 |
| **D8** | **Quel tableau derrière le toggle ?** | (a) `MonthlyCashflow` existant (mois × E/S/V) ; (b) matrice catégories × mois façon FYGR | **(a) maintenant**, (b) plus tard = `PROD-SCENARIO-FYGR1` incrément A |
| **D9** | **Export des données** (bouton FYGR) | (a) hors périmètre ; (b) inclus | **(a)** — un export porte ses propres questions (PII, volumétrie, périmètre du fichier produit) |
| **D10** | **Virements internes** | (a) exclure ; (b) annoter ; (c) ignorer | À trancher : la catégorie amont `INTER_ACCOUNT_TRANSFER` (« Virements internes ») **existe** depuis la normalisation SCREAMING_SNAKE, donc l'identification est possible. Un virement inter-comptes gonfle entrées **et** sorties (le net reste juste, les volumes non) — visible dès qu'un workspace agrège N comptes. **Recommandation : (b) annoter au MVP**, (a) exclure derrière un interrupteur explicite |

---

## 11. Ce que ce plan n'inclut PAS (garde-fou anti-scope-creep)

- **Moteur de formules** FYGR (`VAL`, `SUM`, `SI`, `SAFE_DIV`…) : c'est un tableur
  d'indicateurs, chantier produit majeur — hors périmètre « graphiques ».
- **Rapports / vues / scénarios nommés et persistés** : exige table + migration + RLS +
  CRUD → `PROD-SCENARIO-FYGR1` (C/D).
- **Import d'un prévisionnel (xls/xlsx)** et **paramétrage de l'usage des échéances**.
- **Export CSV/XLS** (D9).
- **Conversion FX / total cross-devise** : `DASH-FX1` reste fermé — aucun taux inventé.
- **Consommation de `/insights` amont** : `501` re-confirmé ; déclencheur de réouverture
  inchangé (501 → 200), dette `INSIGHTS-AMONT1`.

## 12. Dettes TODOS.md touchées

| Dette | Effet de ce plan |
|---|---|
| `PROD-GRAPHS-FYGR1` | ce plan en est le volet exécutable ; à mettre à jour au premier lot livré |
| `GRAPHIQUES-PERIODE-DEDUP1` | **fermée par D1** si (a) ou (c) est retenu |
| `DASH-CASHFLOW-MULTISERIE` | **fermée par L3** |
| `DASH-VENDORS-DIRECTION` | non touchée (même patron de toggle réutilisable ensuite) |
| `DASH-COURBE-SOLDE-EOD` / `PROD-TRESO-EOD1` | **bloque L5** — inchangée |
| `FLUX-PREV-BASELINE1` | **bloque L6** — inchangée |
| `UI-PERIMETRE-ACCORDEON1` | seule voie légitime pour affiner le filtre « comptes » (§1.2) |
| `DASH-FX1` | reste fermée ; ce plan ne l'appelle jamais |
| Nouvelle dette à ouvrir | `GRAPHS-BUCKET-PLAFOND1` si le plafond de buckets (§6.2.4) est différé |

---

## 13. Prochaine étape

**STOP — fin de la phase conception.** Rien n'est codé, aucune branche applicative n'est
ouverte. L'implémentation ne démarre qu'après :

1. arbitrage humain des décisions **D1, D2, D7, D8** (les quatre qui conditionnent L1–L3) ;
2. confirmation du découpage L1 → L4 et de l'ordre de livraison ;
3. ouverture d'un fil **implémentation** distinct référençant ce plan (règle 1 : une requête
   = une phase).
