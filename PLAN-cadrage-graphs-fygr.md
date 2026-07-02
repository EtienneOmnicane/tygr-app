# PLAN — Cadrage graphes FYGR (PROD-GRAPHS-FYGR1)

**Phase :** Cadrage / Décision d'architecture — **LECTURE SEULE, aucun code applicatif,
aucun graphe construit.**
**Date :** 2026-07-02 · **Env audité :** Staging (`api-stage.omni-fi.co`), prod Omni-FI
non déployée (cf. `docs/BASCULE-PRODUCTION-OMNIFI.md`).
**Objet :** préparer LA décision « consommer `/insights` Omni-FI **vs** recalculer en
interne » (rattache TECH-API-INSIGHTS) en alignant/challengeant nos graphes sur FYGR.
**Ne tranche pas** : liste les décisions et **recommande**. L'humain arbitre.

---

## 0. TL;DR (la décision d'abord)

> **L'audit amont re-joué aujourd'hui donne le MÊME verdict qu'au 24 juin : le module
> Insights d'Omni-FI répond `501 NOT_IMPLEMENTED` sur tous ses endpoints, même sans
> authentification.** « Consommer `/insights` » n'est donc **pas un choix disponible** :
> il n'existe aucun payload de succès observable contre lequel figer un contrat. La
> réponse à la question consume-vs-recompute est, à ce jour, **forcée : recompute
> (dérivation interne, Voie A)** — déjà livrée et alignée sur les invariants TYGR.

Ce qui reste à décider n'est **pas** la source de données (imposée), mais **quels
graphes FYGR reproduire** et **avec quelles conventions** (multi-devise, virements
internes, multi-série, format des montants). Ces décisions sont listées au §5.

---

## 1. Audit amont §1 rejoué — preuves runtime (2026-07-02)

**Méthode.** Requêtes `fetch` (Node 25) via `--env-file=.env` (secret jamais affiché,
lu depuis l'env). On n'imprime QUE la méthode, le chemin, le **code HTTP** et la **forme
des clés** de l'enveloppe JSON — **jamais une valeur** (aucun montant, aucun secret,
aucune PII). Base = `https://api-stage.omni-fi.co`, auth `ApiKey <client_id>:<secret>`.

### 1.1 Résultats bruts (reproductibles)

| Appel | HTTP | Forme des clés de réponse (valeurs masquées) |
|---|---|---|
| `GET /health/` (témoin vivant) | **200** | `status` |
| `GET /insights/cashflow` (auth) | **501** | `Error.Code`, `Error.Message` |
| `GET /insights/vendors` (auth) | **501** | `Error.Code`, `Error.Message` |
| `GET /dashboard/insights` (auth) | **501** | `Error.Code`, `Error.Message` |
| `GET /insights/cashflow` **sans auth** | **501** | `Error.Code`, `Error.Message` |
| `OPTIONS /insights/cashflow` | **200** | `name`, `description`, `renders.[](1)`, `parses.[](3)` |
| `POST /insights/cashflow` | **405** | `Code`, `Message`, `Errors.[].ErrorCode`, `Errors.[].Message` |
| `GET /v1/insights/cashflow` | **404** | (corps non-JSON, 179 car.) |
| `GET /insights/alerts` (auth) | **501** | `Error.Code`, `Error.Message` |
| `GET /connections?client_user_id=…` (snake, témoin B2B) | **200** | `Data.Connections.[](20).{ConnectionId, InstitutionId, InstitutionName, CustomerType, Status, CreatedAt, NextSyncAvailableAt}`, `Links.*`, `Meta.TotalPages`, `Meta.TotalRecords` |

### 1.2 Lecture des preuves (faits durs)

1. **Le module Insights N'EST toujours PAS implémenté en Staging** (2026-07-02) : `501`
   uniforme sur `cashflow`, `vendors`, `alerts` et `dashboard/insights`, y compris
   **sans auth** (le 501 précède l'authz). → **Aucune intégration applicative possible
   aujourd'hui.** Le verdict du 24 juin **tient** — rien n'a bougé côté amont.
2. **La route existe, seul le handler manque** : `OPTIONS → 200` (renvoie même un
   descripteur `renders`/`parses`) + `POST → 405`. Si la route n'existait pas → `404`
   (cf. `/v1`). C'est un **stub câblé, logique métier absente** → le **schéma de succès
   reste inconnu** : un 501 ne montre aucun payload, on ne peut PAS figer un DTO fiable.
3. **La doc OpenAPI reste fausse (×2), re-confirmé** : préfixe **`/v1` → 404** (routes à
   la RACINE) ; paramètre **`client_user_id` snake_case → 200** (le camelCase donnait 403
   dans l'audit d'origine). Notre client a raison contre la doc.
4. **L'enveloppe d'erreur 501 diverge du contrat OBIE** : objet `Error` **singulier**
   (`{Error:{Code,Message}}`), là où le 405 renvoie la forme OBIE plurielle
   (`{Code,Message,Errors:[{ErrorCode,Message}]}`). Tout futur mapper amont devra
   **tolérer les deux formes** et traiter **501 comme un état nommé**
   (`OMNIFI_FEATURE_UNAVAILABLE`).

### 1.3 Conclusion de l'audit (verrou de la décision)

> **501 → la dérivation interne est IMPOSÉE**, ce n'est pas un vrai choix. Coder le
> client `/insights/*` maintenant reviendrait à écrire un parseur contre un **contrat
> fantôme** (piège `/v1` + `Enrichment` imbriqué déjà payé deux fois). La bascule vers
> « consommer » n'a de sens **qu'au passage 501 → 200** — qui reste le déclencheur de la
> dette **INSIGHTS-AMONT1**. Le témoin B2B (`/connections` en 200) prouve que **nos clés
> et la frontière tenant fonctionnent** : le blocage est **uniquement** l'absence du
> module Insights, pas notre configuration.

---

## 2. Inventaire FYGR (`docs/benchmarks/FYGR/2_graphics/`, description factuelle)

FYGR (produit de trésorerie français, interface EN dans ces captures, workspace
« ovnicame ») expose une page **Graphics** avec sélecteurs de période
(**Personalized / 3M / 6M / Exercise**) + un menu **Compare** (Previous month / quarter /
year) et un bouton **Add a report**. Les rapports affichés :

1. **Donut « Category analysis » (répartition par catégorie)** — `graphics.png`,
   `graphics_1.png`. Anneau unique avec un **montant total au centre** (ex. libellé
   « €… » — valeur non retenue) et une **légende `pourcentage + catégorie`**. Un
   **sélecteur de catégorie** (dropdown « Uncategorized ») filtre le périmètre analysé.
   Dans les captures, un seul segment « Uncategorized 100 % » (jeu de démo non catégorisé).
2. **Barres mensuelles « Category analysis »** — `graphics_3.png`, `graphics_4.png`.
   **Barres verticales, une par mois** (Jan → Dec 2026), axe Y en montant, pour la
   catégorie sélectionnée. C'est une **série temporelle mensuelle mono-catégorie**
   (montant par mois), distincte de notre courbe de **flux net**.
3. **Sélecteur de catégories hiérarchique** — `graphics_2.png`, `graphics_4.png`.
   Dropdown avec **recherche** + **arborescence** (Incomes › Main incomes / Others ;
   Suppliers › Goods purchases / Services…), **cases à cocher multi-sélection** +
   bouton **Validate**. Le graphe se recompose sur la sélection.
4. **Choix du type de graphe par rapport** — `graphics_8.png`. Petit menu **Pie chart /
   Bar chart** (cases cochées) + **Default graphics** : l'utilisateur choisit la
   représentation d'un même rapport.
5. **Créateur de rapport** — `graphics_5.png`. Modale **« Add a report »** avec un champ
   **Report name** : les rapports sont **nommés et persistés** par l'utilisateur.
6. **Moteur de formules (indicateurs personnalisés)** — `graphics_6.png`, `graphics_7.png`.
   Guide **« FORMULA GUIDE — CAPABILITIES & EXAMPLES »** : l'utilisateur **compose ses
   propres indicateurs** à partir de catégories + fonctions. Primitives documentées :
   - accès aux séries : `VAL("Path > Category", offset, fallback)`, `VALUES("path")`,
     `GET(arrOrPath, idx)` (index négatifs), réutilisation `IND("NomOuId")` (références
     circulaires détectées/bloquées) ;
   - logique : `SI(cond,a,b)`, `AND(...)`, `OR(...)` ;
   - math : `MAX/MIN`, `SUM(...)`, `SAFE_DIV(num,den,fallback=0)` ;
   - agrégats de séries : `SUMS`, `AVGS`…
   → FYGR n'est pas qu'un afficheur de graphes : c'est un **tableur d'indicateurs**
   au-dessus des catégories. **Hors périmètre d'un simple alignement de graphes** (noté
   comme ambition produit, pas comme cible de ce cadrage).

**Note transverse :** tout FYGR est **mono-devise (€)** et **orienté catégories** (la
brique d'analyse est la catégorie, pas la contrepartie). Deux différences structurelles
avec TYGR (multi-devise MUR/USD/EUR ; concentration par contrepartie déjà livrée).

---

## 3. État TYGR — ce qu'on produit DÉJÀ en interne (Voie A)

Tout est **dérivé de `transactions_cache`** (aucune dépendance au 501), scopé tenant +
entité, montants en chaînes décimales. Fichiers lus :

### 3.1 Couche données (dérivation, `src/server/repositories/insights.ts`)

- **`cashflowParDevise(tx, {granularite, from, to})`** → `SerieCashflow`. Agrège
  entrées (`Credit`) / sorties (`Debit`) / **net** et `nbTransactions` **par bucket
  temporel ET par devise** (`GROUP BY currency`). Granularité `jour|semaine|mois`
  (enum fermée mappée à une constante SQL `date_trunc` figée — garde anti-injection).
  Bornes calendaires validées (F1/F2), borne haute inclusive (`< to + 1 jour`).
- **`vendorsParConcentration(tx, {direction, topN})`** → `ConcentrationVendors`.
  Concentration **par contrepartie** (`clean_label`, repli `primary_category`,
  puis « (Sans libellé) ») **par devise**, avec `part` (fraction du total de SA
  devise, `nullif` anti-DIV/0), triée montant décroissant, `topN` borné. `direction`
  ∈ `inflow|outflow|both` (littéraux figés).

Invariants respectés (vérifiés dans le fichier) : `withWorkspace` (RLS tenant) ;
**JOIN `bank_accounts`** pour hériter du scope entité (ENTITY-READ-JOIN1) ; `is_removed`
exclus ; **jamais d'addition cross-devise, aucune conversion FX** ; buckets sur
`transaction_date` (déjà date comptable Maurice, E20) ; agrégats **en SQL → chaînes
décimales** (règle 8).

### 3.2 DTO internes (`src/server/insights/types.ts`)

`GranulariteCashflow`, `DirectionVendors`, `PointCashflow` (`bucket, currency, entrees,
sorties, net, nbTransactions`), `SerieCashflow`, `LigneVendor` (`contrepartie, currency,
montant, part, nbTransactions`), `ConcentrationVendors`. **Types NÔTRES**, pas un miroir
du schéma Omni-FI inconnu ; le jour où l'API livre, un `mapDepuisOmniFi` produira ces
MÊMES types (frontière prévue, non implémentée).

### 3.3 Couche rendu (composants purs, SVG inline zéro-dépendance)

- **`cash-flow-summary.tsx`** — carte « Synthèse du mois » : Entrées / Sorties /
  Variation nette **par devise** (un bloc par devise, jamais d'addition cross-devise).
- **`flux-tresorerie-card.tsx` (+ `flux-bars.tsx`, `flux-chart-trace.tsx`,
  `flux-projection.ts`, `flux-layout.ts`)** — carte d'ancre unifiée **toggle
  Barres / Courbe** du **flux net mensuel** :
  - `flux-bars.tsx` : barres entrées (haut, `inflow`) / sorties (bas, `outflow`)
    autour d'une ligne de base centrale ;
  - `flux-chart-trace.tsx` : courbe du **flux net** (aire fermée sur la ligne de zéro,
    tooltip entrées/sorties/net, viewBox dérivé de la taille réelle — anti-déformation) ;
  - `flux-projection.ts` : `projeterSurGrille` / `maxFenetre` / `projeterPointsCourbe`
    (module NEUTRE partagé serveur+client, réduit à la **devise de base**, mois vides à 0,
    drapeau `autresDevises`).
  - **Mono-série** : la page filtre sur `base_currency` (dette **DASH-CASHFLOW-MULTISERIE**).
- **`top-vendors-card.tsx`** — carte « Top contreparties » : lignes triées + barre de
  proportion (`part`), groupées par devise ; câblée en dur sur `outflow` (dette
  **DASH-VENDORS-DIRECTION** ; `both`/`inflow` déjà gérés côté composant).

**Bilan capacités internes** : cashflow (entrées/sorties/net) par mois·devise ✅ ;
synthèse mensuelle ✅ ; concentration par **contrepartie** ✅. **Répartition par
CATÉGORIE (donut / barres par catégorie) : PAS encore produite** — c'est le principal
manque vs FYGR (voir §4).

---

## 4. Mapping FYGR → données TYGR

Pour chaque graphe FYGR : la donnée requise, et la faisabilité **(a)** via `/insights`
amont si dispo, **(b)** via dérivation interne (Voie A), **(c)** manquant. **(a) est
partout NON aujourd'hui** (501) — colonne conservée pour la décision « au 501→200 ».

| Graphe FYGR | Donnée requise | (a) `/insights` amont | (b) Dérivation interne (Voie A) | Verdict |
|---|---|---|---|---|
| **Donut par catégorie** | montant agrégé **par `primary_category`** (+ devise), part du total | ✗ 501 | **Faisable** : `GROUP BY primary_category, currency` sur `transactions_cache` (JOIN `bank_accounts`), même patron que `vendorsParConcentration` mais clé = catégorie | **(c) à produire** — repo `categorySummary` inexistant à ce jour |
| **Barres mensuelles par catégorie** | série `(mois × montant)` pour une/des catégorie(s) | ✗ 501 | **Faisable** : `cashflowParDevise` + filtre catégorie, ou variante `date_trunc('month') × primary_category` | **(c) à produire** — la mécanique de bucket mensuel existe déjà (réutiliser `date_trunc`) |
| **Courbe cashflow (flux)** | entrées/sorties/net par bucket temporel × devise | ✗ 501 | **Déjà livré** : `cashflowParDevise` → `flux-chart-trace.tsx` | **(b) OK** — mono-série aujourd'hui (DASH-CASHFLOW-MULTISERIE) |
| **Sélecteur de catégories hiérarchique** | arbre catégories + multi-sélection | ✗ (hors Insights) | Table `categories` existe (seed 28 cat/ws) ; hiérarchie parent/enfant **à vérifier** dans le schéma | **(c) UI à produire** ; dépend de la profondeur du modèle `categories` |
| **Choix Pie/Bar par rapport** | pur front (représentation) | n/a | n/a | **(c) UI** — pattern « toggle » déjà maîtrisé (Barres/Courbe) |
| **Rapports nommés + persistés** | table de rapports définis par l'utilisateur | ✗ | **Nouvelle table** requise (persistance de config) | **(c)** — nécessite migration ; **hors MVP graphes** |
| **Moteur de formules (`VAL`/`SUM`/`SI`…)** | DSL d'indicateurs au-dessus des catégories | ✗ | Recompute possible mais **chantier majeur** (parseur + éval) | **(c) hors périmètre** — ambition produit, à isoler |
| **Concentration par contrepartie** *(TYGR en +)* | `clean_label × montant × part` | ✗ 501 | **Déjà livré** : `vendorsParConcentration` → `top-vendors-card.tsx` | **(b) OK** — TYGR devance FYGR ici |

**Lecture du mapping.** Tout ce qui est mappable l'est **par dérivation interne** ;
la colonne amont est intégralement fermée par le 501. Le **cœur du travail restant**
pour « ressembler à FYGR » est l'**axe CATÉGORIE** (donut + barres par catégorie), qui
est un **nouveau repository dérivé** de même facture que l'existant — **pas** une
dépendance API. Le moteur de formules et les rapports persistés sont hors du périmètre
« graphes » et doivent être tracés séparément.

---

## 5. Décisions à poser (à trancher par l'humain — NON tranchées ici)

Ces points sont **structurants** et impactent directement l'alignement sur FYGR.

1. **DASH-FX1 — aucune addition cross-devise sans taux annoté.** FYGR est mono-€ et
   « collapse » tout en une seule courbe / un seul donut. TYGR est multi-devise (MUR/USD/
   EUR) et interdit l'addition cross-devise sans taux+date annotés (CLAUDE.md, règle 8).
   **Impact direct** : reproduire tel quel un donut/une courbe « total unique » est
   **interdit** tant que DASH-FX1 (conversion FX annotée) n'est pas livré. → Décision :
   **une série/segment par devise** (défaut sûr) **ou** attendre DASH-FX1 pour un total
   converti. *Ne pas imiter le « une seule courbe » de FYGR par défaut.*

2. **Nettage des virements internes (double-comptage du flux).** Un virement entre deux
   comptes du même groupe apparaît en **sortie** sur l'un et en **entrée** sur l'autre :
   sommé naïvement, il **gonfle** entrées ET sorties (le net reste juste, les volumes non).
   FYGR mono-compte n'a pas ce problème ; TYGR agrège N comptes/N entités. **Impact
   limpidité** : donut catégorie et barres peuvent sur-représenter des flux « fantômes ».
   → Décision : **exclure/neutraliser les virements internes** (nécessite de les
   identifier — catégorie dédiée ? appariement debit/credit ?) **ou** les afficher avec
   une mention. *Pas de solution triviale ; à cadrer avant le donut catégorie.*

3. **MUR-first / multi-série (DASH-CASHFLOW-MULTISERIE).** Aujourd'hui la courbe filtre
   sur `base_currency` → un workspace majoritairement non-MUR voit une courbe muette.
   → Décision : **multi-série (une ligne/segment par devise)** vs **sélecteur de devise**
   au-dessus de la carte. S'applique **aussi** au futur donut/barres par catégorie
   (même arbitrage de présentation). *Cohérent avec la décision 1.*

4. **Montants = chaînes / centimes (règle 8).** Tout montant reste **chaîne décimale**
   (agrégat SQL), `parseFloat`/`Number()` réservé à la **géométrie** (hauteur de barre,
   angle de donut, largeur de barre de part) — **jamais réinjecté dans un montant
   affiché**. Le donut par catégorie devra calculer ses **angles** en géométrie pure et
   afficher les **montants/pourcentages** via `format-montant.ts`. → Décision : **acter
   ce garde-fou** pour tout nouveau graphe (non négociable, rappel plutôt qu'arbitrage).

*Décisions de périmètre (à acter aussi) :* le **moteur de formules** FYGR et les
**rapports nommés persistés** sont **hors MVP graphes** → à tracer en dettes P2 dédiées
(pas dans ce chantier). La **répartition par catégorie** (donut + barres) est le seul
manque data à combler pour l'alignement visuel de base.

---

## 6. Recommandation — consume vs recompute

**Recommandation : RECOMPUTE (dérivation interne, Voie A), et continuer d'étendre la
Voie A à l'axe CATÉGORIE. Ne PAS coder de client `/insights` amont.**

**Pourquoi (argumenté) :**

1. **Consume est indisponible, pas seulement déconseillé.** L'audit re-joué prouve un
   `501` uniforme, sans payload de succès observable. Écrire le client/DTO amont
   maintenant = parseur contre **contrat fantôme** — le projet a déjà payé ce piège deux
   fois (`/v1`, `Enrichment` imbriqué). Coût ~1 j **gaspillé** + re-travail garanti au
   premier 200 réel. La question consume-vs-recompute est donc **tranchée par le
   runtime**, pas par une préférence.

2. **Recompute est déjà livré, testé et conforme.** `cashflowParDevise` /
   `vendorsParConcentration` + leurs 4 cartes respectent tenant + scope entité + montants
   chaînes + multi-devise. La valeur est **immédiate** et **réconciliable** plus tard.

3. **L'écart avec FYGR est un écart de PÉRIMÈTRE interne, pas de source.** Le donut et
   les barres par catégorie se dérivent de `transactions_cache` (`GROUP BY
   primary_category`), exactement comme l'existant — **aucune** dépendance amont. Les
   produire en interne est cohérent, borné, et ne crée pas de dette d'intégration.

4. **La frontière de bascule est déjà pensée.** Le jour où `/insights` passe 200
   (déclencheur INSIGHTS-AMONT1), un `mapDepuisOmniFi` produira les **mêmes DTO** derrière
   un flag `INSIGHTS_SOURCE` (défaut `derive`), permettant **réconciliation** dérivé↔amont
   avant toute coupure. Recompute **n'est pas un cul-de-sac** : c'est la base sur laquelle
   consume viendra se brancher, sans réécrire l'UI.

**Ce que la recommandation N'inclut PAS (garde-fou anti-scope-creep) :** ni le moteur de
formules FYGR, ni les rapports persistés (chantiers produit majeurs, à isoler). Le
prochain incrément « graphes » raisonnable = **donut + barres par catégorie** (nouveau
repo dérivé `categorySummary`), en respectant les 4 décisions du §5 (surtout : **pas de
total cross-devise**, **traiter les virements internes**).

**Déclencheur de réouverture de la décision :** passage **501 → 200** de
`GET /insights/cashflow` en Staging → re-jouer l'audit §1, observer le **schéma de succès
réel**, alors seulement figer le DTO amont et brancher `mapDepuisOmniFi` (dette
INSIGHTS-AMONT1). **Pas avant.**

---

## 7. Annexe — reproductibilité de l'audit

Commande (secret jamais affiché ; imprime uniquement méthode/chemin/HTTP + forme des
clés, aucune valeur) :

```
node --env-file=.env <script d'audit>   # GET /health/, /insights/{cashflow,vendors,alerts},
                                        # /dashboard/insights, OPTIONS/POST /insights/cashflow,
                                        # /v1/insights/cashflow, /connections?client_user_id=…
```

Le script réduit chaque réponse JSON à la **liste de ses chemins de clés** (jamais les
valeurs) — voir §1.1 pour la sortie. Environnement : `OMNIFI_BASE_URL=
https://api-stage.omni-fi.co`, `OMNIFI_ENV=sandbox`, auth `ApiKey`. Aucune écriture en
base, aucune donnée bancaire manipulée.
