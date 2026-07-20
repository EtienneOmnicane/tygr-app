# NOTE DE DÉCISION — `categorySummary` : consommer l'amont Omni-FI vs recalculer en interne

**Date :** 2026-07-17 · **Décideur :** Etienne (Human-in-the-Loop, règle 10) ·
**Auteur :** agent (recommande, ne tranche pas).

> **DÉCISION ACTÉE (Etienne, 2026-07-17)** — les trois recommandations sont retenues :
> **D1 = A** (dérivation interne depuis `transactions_cache`, frontière
> `mapDepuisOmniFi`/`INSIGHTS_SOURCE` + déclencheur INSIGHTS-AMONT1 conservés) ·
> **D2 = c** (hybride ; repli `a → c` en deux lots autorisé si le coût de v1 doit
> baisser, le DTO restant taillé pour c) · **D3 = annoter en v1** + préparer la
> neutralisation par catégorie dédiée « Virements internes » (identification
> structurelle = incrément séparé, hors chemin critique). L'implémentation peut démarrer
> selon §10 du `PLAN-categorysummary-axe-categorie.md` (PR backend d'abord, zéro UI).

**Chantier :** PROD-GRAPHS-FYGR1 (TODOS.md:3053) — pré-requis transverse de la roadmap
prévisionnel/scénarios (`PLAN-cadrage-scenario-previsionnel-fygr.md` §4/§6).
**Plan de conception associé :** `PLAN-categorysummary-axe-categorie.md` (le contrat y
est écrit pour SURVIVRE à ce choix : l'UI ne voit jamais la source).

---

## 0. Le fait qui cadre tout (vérifié au runtime AUJOURD'HUI)

Audit rejoué le **2026-07-17** contre `api-stage.omni-fi.co` (même discipline que
`PLAN-cadrage-graphs-fygr.md` §1/§7 — codes HTTP + forme des clés, aucune valeur) :
`GET /insights/cashflow|vendors|alerts` et `GET /dashboard/insights` (avec et sans
`granularity=monthly`) répondent tous **501 NOT_IMPLEMENTED** ; le témoin `/health/`
répond 200. C'est le TROISIÈME audit concordant (2026-06-24, 2026-07-02, 2026-07-17).

> **« Consommer l'amont » n'est pas une option disponible aujourd'hui** : il n'existe
> aucun payload de succès observable contre lequel figer un contrat. La question posée
> est donc en réalité : *construire la Voie A catégorie×mois maintenant, ou attendre
> l'amont ?* — et, si on construit, garder ou non une frontière de bascule.

---

## 1. Option B — consommer `GET /dashboard/insights` (CategorySummary amont)

**Ce que dit la doc** (`docs/documentation_api.md:1171-1190`) : auth `ApiKey` serveur +
`clientUserId` (snake_case au runtime), query `granularity/fromDate/toDate`, réponse
`CategorySummary: [{ Category, Amount, TransactionCount, Share }]`. Pas de pagination
documentée.

**Coût de build (si le module passait 200 demain)** : ~2-4 j CC — client + DTO +
`mapDepuisOmniFi` + gestion des DEUX enveloppes d'erreur (singulière `{Error:{…}}` vs
OBIE plurielle) + état nommé `OMNIFI_FEATURE_UNAVAILABLE` + N appels fenêtrés par rendu
(cf. ci-dessous) + tests. **Aujourd'hui : coût infini** (501, contrat fantôme — piège
déjà payé deux fois : `/v1`, `Enrichment` imbriqué).

**Quatre défauts STRUCTURELS, indépendants du 501** (ils resteraient au passage à 200
tel que documenté) :

1. **Pas de dimension mois** : `CategorySummary` est un agrégat PLAT sur la fenêtre.
   Une matrice 12 mois = **12 appels réseau** par devise de rendu, par sens. Fragile et
   lent là où l'interne fait UNE requête SQL.
2. **Pas de champ devise** : impossible de prouver que `Amount` n'additionne pas
   MUR+USD+EUR en interne. Tant que ce point n'est pas observable sur un payload réel,
   consommer ce champ **violerait DASH-FX1 en aveugle** (interdit, règle 8).
3. **Mauvais axe catégorie** : l'amont ne connaît que SA classification
   (`primary_category`). Nos ventilations MANUAL/RULE (`transaction_categorizations`,
   moteur de règles PR #95, doctrine « MANUAL prime » `schema.ts:446-453`) sont
   **invisibles de l'amont** — et la correction manuelle est purement locale
   (DECISION-PRODUIT-OVERRIDE, TODOS). Une matrice FYGR sur NOS catégories est
   **impossible par l'amont**, quel que soit son statut HTTP.
4. **Étage 2 d'isolation inapplicable** : l'amont connaît l'EndUser (= le workspace),
   pas nos scopes entité/compte/`view_filter`. Ses agrégats sont GROUPE ENTIER : les
   servir à un membre scopé = **fuite intra-groupe** (dette d'isolation INTERDITE,
   règle 9). Le contournement — re-filtrer par compte côté TYGR — revient à recalculer
   en interne, c'est-à-dire à payer les deux options.

**Fraîcheur** : dépend du cycle de sync amont, identique à la nôtre (mêmes données
synchronisées) — aucun gain.

## 2. Option A — recalculer en interne depuis `transactions_cache` (Voie A)

**Coût de build** : ~1 PR backend (Effort S/M, ~1-2 j CC) — le patron existe déjà à
trois exemplaires dans `src/server/repositories/insights.ts` (`cashflowParDevise`,
`vendorsParConcentration`, et surtout `repartitionParCategorie` qui EST déjà le donut
catégorie×devise ; il ne manque que la dimension mois). Tests d'isolation calqués sur
la suite existante (10/10 du chantier Voie A).

**Couplage** : zéro dépendance amont. Dépend de la qualité de NOTRE ingestion (déjà
testée) et de la classification amont UNIQUEMENT comme repli d'affichage (D2).

**Cohérence catégories** : accès direct aux DEUX sources (splits TYGR + repli
`primary_category`) — la seule voie qui permette la matrice sur NOS catégories
(hiérarchie Nature/Sous-nature comprise).

**Invariants** : tous respectés par construction — `withWorkspace` + JOIN
`bank_accounts` (ENTITY-READ-JOIN1, étendu à la chaîne des splits — plan §1.2),
par-devise strict, chaînes décimales, fuseau Maurice posé à l'ingestion (E20).

**Réversibilité** : la frontière `mapDepuisOmniFi` + flag `INSIGHTS_SOURCE`
(`PLAN-tech-api-insights.md:175-179`, défaut `derive`) reste provisionnée : au passage
501→200 (déclencheur INSIGHTS-AMONT1), on rejoue l'audit, on observe le schéma RÉEL et
on peut réconcilier dérivé↔amont AVANT toute bascule. **L'option A n'est pas un
cul-de-sac.**

## 3. Tableau comparatif

| Critère | A — interne (Voie A) | B — amont `/insights` |
|---|---|---|
| Disponibilité | ✅ immédiate | ❌ 501 (3 audits concordants) |
| Coût de build | ~1-2 j CC (patron existant) | ~2-4 j CC **quand** 200, + re-travail au 1er payload réel |
| Catégorie × mois | ✅ 1 requête SQL | ❌ N appels fenêtrés (12/mois affichés) |
| Multi-devise (DASH-FX1) | ✅ GROUP BY currency prouvé | ❓ champ devise non documenté — inauditable |
| Nos catégories (splits MANUAL/RULE) | ✅ source directe | ❌ invisibles de l'amont |
| Isolation étage 2 (entité/compte/view_filter) | ✅ RLS + jointures | ❌ agrégats groupe entier (fuite si servis scopés) |
| Fraîcheur | = (mêmes données sync) | = |
| Couplage | aucun | qualité analytique amont + `clientUserId` + dérive d'enum/enveloppes |
| Réversibilité | frontière `INSIGHTS_SOURCE` provisionnée | — |

## 4. Recommandation (à confirmer ou infirmer par Etienne)

> **Option A — dérivation interne**, en étendant la famille `insights.ts` avec
> `ventilationCategorieParMois` (contrat : plan §2). Conserver la frontière
> `mapDepuisOmniFi`/`INSIGHTS_SOURCE` et le déclencheur INSIGHTS-AMONT1 (501→200) pour
> réévaluer l'amont **sur pièces** le jour où il existe. C'est la même conclusion que
> le cadrage du 2026-07-02 (`PLAN-cadrage-graphs-fygr.md` §6), re-vérifiée au runtime
> aujourd'hui, et renforcée par les 4 défauts structurels du §1 (qui, eux, survivraient
> au passage à 200).

---

## 5. Deux décisions subordonnées (nécessaires au build, quelle que soit l'option)

### D2 — L'axe catégorie de la ventilation

| Option | Description | Pour | Contre |
|---|---|---|---|
| **a. `primary_category` seul** | Continuité exacte du donut actuel (`repartitionParCategorie`) | Le moins cher ; cohérent avec l'existant | Ignore le travail de catégorisation TYGR ; la matrice ne reflète jamais les corrections manuelles ni la hiérarchie Nature/Sous-nature |
| **b. Catégories TYGR seules** | Splits `transaction_categorizations` uniquement | Axe propre, hiérarchique | Un workspace qui vit sur l'auto-catégo amont verrait une matrice quasi 100 % « Non catégorisé » — valeur faible au départ |
| **c. Hybride (recommandée)** | Splits TYGR PRIMENT ; le reste non ventilé retombe sur `primary_category` normalisée, sinon « Non catégorisé » ; chaque ligne trace son `origine` | Applique la doctrine « MANUAL prime à l'agrégation » déjà écrite (`schema.ts:446-453`) ; valeur immédiate + s'améliore à mesure qu'on catégorise | La plus coûteuse (UNION ALL + calcul de reste par transaction — plan §3.2) ; deux espaces de noms à ne pas fusionner |

**Recommandation : c (hybride).** C'est le seul axe cohérent avec le prévisionnel à
venir (les échéances portent des catégories TYGR — la matrice réalisé/prévu doit
partager le même axe). Si le coût de v1 doit être réduit : **a** en premier lot avec le
DTO déjà taillé pour c (champs `categorieId`/`origine` posés), et c en second lot.

### D3 — Les virements internes (risque de sur-représentation, cadrage §5.2)

Un virement entre deux comptes du groupe gonfle Entrées ET Sorties (le net reste juste).
Options : **exclure** (filtre WHERE — exige de les identifier), **neutraliser**
(catégorie dédiée « Virements internes » assignée par le moteur de règles, rendue en
ligne séparée hors des totaux de flux), **annoter** (mention sous le graphe/la matrice,
données inchangées).

**Recommandation : annoter en v1 + préparer la neutralisation par catégorie dédiée**
(une Nature « Virements internes » + règles de catégorisation, ligne rendue à part) —
l'identification STRUCTURELLE (appariement automatique débit/crédit) est un incrément
séparé, non trivial, à ne pas mettre sur le chemin critique. Le contrat du plan est
neutre aux trois choix.

---

## 6. Ce qui est attendu d'Etienne

1. **D1** : Option A (interne) ou Option B (attendre/consommer l'amont) ? *(reco : A)*
2. **D2** : axe catégorie a / b / c ? *(reco : c ; repli a→c en deux lots si besoin)*
3. **D3** : virements internes — exclure / neutraliser / annoter en v1 ?
   *(reco : annoter + catégorie dédiée)*

Aucun code ne démarre avant ces trois réponses (règle 1 + règle 10). Le plan
`PLAN-categorysummary-axe-categorie.md` est écrit pour absorber n'importe quelle
combinaison sans réécriture du contrat.
