# PLAN — Filtre par catégorie sur /transactions (TX-QA-FILTRE-CAT1)

> Dette : **TX-QA-FILTRE-CAT1 (P2)**, TODOS.md 2026-07-01. Branche :
> `feat/transactions-filtre-categorie` (depuis `main`). Phase : plan → implémentation
> (règle 1). Commits locaux uniquement, pas de push, pas de PR (Human-in-the-Loop).

## 1. Besoin

Restreindre la liste `/transactions` (et son total « somme nette ») à une catégorie
donnée du **référentiel TYGR**, comme on filtre déjà par recherche / statut de
ventilation / période. Le filtre s'ajoute dans le groupe FILTRES (gauche) de la
toolbar, en `Select`.

**Aucune nouvelle route ni Server Action** : on étend la LECTURE existante
(`listerTransactionsAction` + `sommeNetteTransactionsAction`), dont le schéma zod
est la source unique partagée (`filtresTransactions`, `src/lib/transactions-schema.ts:81`).
Un filtre ajouté là atterrit MÉCANIQUEMENT dans la liste ET la somme — c'est la
garantie structurelle qui interdit qu'un total diverge des lignes.

## 2. Arbitrage sémantique (règle 10) — TRANCHÉ : option (a)

Une transaction peut être VENTILÉE sur plusieurs catégories (splits). « Filtrer par
catégorie X » a trois sémantiques candidates :

| Option | Sémantique | Verdict |
|---|---|---|
| **(a) EXISTS un split de catégorie X** | La transaction porte AU MOINS un split sur X, quelle que soit sa part | **RETENUE** |
| (b) catégorie DOMINANTE = X | X est la part au plus gros montant | écartée |
| (c) `primaryCategory` OBIE = X | catégorie AUTO de la banque (chaîne amont) | écartée |

**Pourquoi (a)** :
- C'est la sémantique d'**appartenance** : « montre-moi tout ce qui touche à X ».
  Une transaction ventilée 80 % Loyer / 20 % Électricité EST une écriture
  d'électricité — l'option (b) la cacherait du filtre « Électricité » alors que le
  split existe réellement (les splits minoritaires deviendraient introuvables).
- La **dominante est un choix d'AFFICHAGE** (élection `array_agg … order by amount
  desc` pour nommer le badge, FB0709-TX-CATEGORIE-VISIBLE1), pas un critère
  métier d'appartenance. Filtrer dessus coulerait une convention de rendu dans le
  contrat de lecture.
- Cohérence de MÉCANIQUE avec le filtre statut : `predicatStatut`
  (`src/server/repositories/transactions.ts:512`) est déjà un EXISTS corrélé sur
  `transaction_categorizations` — même table, même clé de corrélation, même index.
  (a) est le prolongement naturel, au même coût (O(log M) par ligne).
- (c) porte sur le **concept B** (classification AUTO amont OBIE, chaîne libre hors
  référentiel TYGR) — ce n'est pas ce que l'utilisateur appelle « catégorie » dans
  TYGR (concept A, ventilation manuelle). Écartée sans réserve.

### 2.1 Interaction avec le filtre statut — documentée, pas bloquée

- `categorieId` + `statut=NON_CATEGORISE` = **ensemble vide par construction**
  (avoir un split de X contredit « aucun split »). C'est un état LÉGITIME : liste
  vide propre (empty state standard « Aucune transaction pour ces critères »),
  somme nette `[]` (le bandeau se démonte). On ne plante pas, on ne désactive pas
  d'option, on n'affiche pas d'erreur — l'utilisateur voit simplement zéro
  résultat et retire l'un des deux filtres.
- `categorieId` + `statut=PARTIEL|COMPLET` : composition en **AND** normale
  (« les partiellement ventilées qui touchent X »), sémantique utile et voulue.

### 2.2 Périmètre volontairement STRICT (égalité sur `category_id`)

Filtrer par une **Nature** (catégorie racine) ne remonte PAS les splits posés sur
ses **Sous-natures** (égalité stricte `z.category_id = X`, pas de sous-arbre).
Choix assumé au MVP : le référentiel est à 2 niveaux, la ventilation peut viser
l'un OU l'autre, et un filtre « sous-arbre » (X ou enfants de X) est une
sémantique différente qui mérite son propre arbitrage produit (et son propre
libellé UI). Différé → entrée TODOS **TX-FILTRE-CAT-SOUSARBRE1 (P2)**.

Corollaire : les options du Select = catégories **ACTIVES** (`listerCategories`
masque déjà les archivées, comme pour les pickers). Une catégorie archivée reste
techniquement filtrable par id (le schéma ne vérifie pas l'existence — un uuid
inconnu rend simplement 0 ligne, fail-safe non-énumérant), mais l'UI ne la
propose pas.

## 3. Implémentation (fichier par fichier)

### 3.1 Schéma — `src/lib/transactions-schema.ts`
Ajouter dans `filtresTransactions` (l.81) :
```ts
/** Restreint aux transactions portant AU MOINS un split de cette catégorie (référentiel TYGR). */
categorieId: z.string().uuid().optional(),
```
Rien d'autre ne bouge : `listerTransactionsSchema` et `sommeNetteSchema` DÉRIVENT
de cet objet → propagation mécanique aux deux contrats, `.strict()` intacts.

### 3.2 Repository — `src/server/repositories/transactions.ts`
Dans `conditionsFiltres` (l.548) — le helper PARTAGÉ liste ↔ somme — ajouter
`categorieId` aux params et le prédicat EXISTS corrélé, calqué sur
`predicatStatut` pour épouser l'index `txn_categorizations_workspace_txn_idx`
`(workspace_id, transaction_id, transaction_date)` :
```ts
if (categorieId) {
  conditions.push(sql`exists (
    select 1 from transaction_categorizations z
    where z.transaction_id = ${transactionsCache.id}
      and z.transaction_date = ${transactionsCache.transactionDate}
      and z.category_id = ${categorieId}
  )`);
}
```
- Paramètre **LIÉ** (template `sql` Drizzle) — jamais d'interpolation.
- **Aucun WHERE `workspace_id`** (règle 2) : la RLS scope. `transaction_categorizations`
  porte `tenant_isolation` (étage 1) ET `account_scope` RESTRICTIVE (étage 2,
  migration 0017) — le sous-EXISTS est borné quel que soit le chemin. La jointure
  `bank_accounts` existante des deux appelants reste la ceinture ENTITY-READ-JOIN1.
  Aucun nouveau chemin d'accès : l'isolation ne bouge pas.
- Pourquoi CORRÉLÉ et pas un JOIN : même raison que PERF-VENTILATION-AGG1 (sous
  RLS l'estimateur est aveugle ; le corrélé est robuste par construction) — et un
  JOIN sur les splits DUPLIQUERAIT les lignes multi-splits (fausserait pagination
  ET somme). L'EXISTS est insensible à la cardinalité des splits.

### 3.3 Contrat UI — `src/components/transactions/types-transactions.ts`
`FiltresTransactions` : ajouter `categorieId?: string` (uuid ; `undefined` = pas
de filtre — jamais de chaîne vide). `filtreActif` (transactions-feature) dérive
de `Object.values` → le bandeau somme nette s'active mécaniquement.

### 3.4 Adaptateur — `src/app/(workspace)/transactions/adapter.ts`
`versInputBackend` : passe-plat garde-falsy, comme `recherche` :
```ts
if (filtres?.categorieId) input.categorieId = filtres.categorieId;
```
`versFiltresSommeNette` dérive de `versInputBackend` → héritage mécanique.

### 3.5 Toolbar — `src/components/transactions/transactions-toolbar.tsx`
- Nouvelle prop `categories: Array<{ id, name, parentId }>` (options du filtre,
  fournies par le conteneur — la toolbar reste PURE, zéro fetch).
- `Select` « Toutes catégories » (valeur `""`) dans le groupe FILTRES, entre la
  recherche et le statut. Options via `groups` (hiérarchie visuelle, idiome
  `grouperParNature` du CategoryPicker) : un groupe par Nature (en-tête = nom),
  contenant la Nature elle-même (sélectionnable) puis ses Sous-natures ; enfants
  orphelins (parent absent de la liste active) regroupés en fin sans en-tête —
  fail-safe, aucune catégorie active ne disparaît des options.
- `onChange` fusionne comme le statut : `{ ...filtres, categorieId: v || undefined }`.
  Le parent (`appliquerFiltres`) recharge déjà la page 1 → reset curseur.
- Référentiel VIDE (aucune catégorie) → le Select n'est pas rendu (pas de contrôle
  mort à une seule option).

### 3.6 Conteneur — `src/components/transactions/transactions-feature.tsx`
Passe `categoriesLocales` (référentiel frais : suit créations/renommages/
archivages) à la toolbar, mappé au shape minimal `{id, name, parentId}`.
NB : la prop RSC `categories` alimente déjà le conteneur via `withWorkspace`
(`listerCategoriesAction`) — aucun nouveau fetch.

### 3.7 Démo Visual QA — `src/app/demo/transactions/page.tsx`
Le stub honore `categorieId` avec la MÊME sémantique EXISTS que le serveur, via la
fixture `SPLITS` (`SPLITS[tx]?.some(s => s.categoryId === f.categorieId)`) — pour
que les états « catégorie active / vide / effacement » soient capturables (Gate 4).
Cardinalité de `sommeNette` idem. Aucun montant calculé côté client (fixture
constante, piège TX-FILTRE1 respecté).

## 4. Tests (exit criteria règle 3, MÊME PR)

**Unitaires (non-DB)** :
- `tests/unit/transactions-schema.test.ts` : `categorieId` uuid ACCEPTÉ (liste +
  somme) ; non-uuid REJETÉ bruyamment (liste + somme).
- `tests/unit/transactions-adapter-filtres.test.ts` : passe-plat `categorieId` ;
  absent → clé ABSENTE (`.strict()`) ; cumul recherche + statut + catégorie +
  période ; héritage somme nette.
- Toolbar (pure) : test du groupeur d'options (Nature → sous-natures, orphelins).

**Isolation (PGlite, bloquants — règle 2 « tout nouvel endpoint y ajoute ses cas »,
appliquée ici au nouveau prédicat)** — `tests/isolation/transactions-somme-nette-isolation.test.ts`
(assertion croisée liste↔somme existante `verifierCoherenceListe`) :
- (heureux) `categorieId: CAT_A` → M2+M3 seuls ; totaux MUR
  `entrees 0.00 / sorties 500.00 / net −500.00 / nb 2` ; cohérence liste↔somme.
- (cumul) `categorieId + statut PARTIEL` → M2 seul (AND, pas OR).
- (limite) catégorie ACTIVE sans transaction (semer `CAT_SANS`) → liste vide ET
  somme `[]` sur le MÊME jeu (le vrai piège : le total doit se vider AVEC la liste).
- (contradiction documentée) `categorieId + statut NON_CATEGORISE` → `[]`.
- (isolation) catégorie du tenant B (`CAT_B`, split semé sur B1) filtrée par B →
  B1 ; filtrée par A → 0 ligne, sans oracle d'existence.

**Reset curseur** : déjà structurel (`appliquerFiltres` → `rechargerPremierePage`
→ `curseur: null`) — vérifié au Visual QA (changer de catégorie après « Charger
plus » repart page 1).

## 5. Sécurité / règles transverses

- Le filtre porte un **id**, jamais un libellé : rien de nouveau en log (les logs
  d'échec existants ne portent que `{evt, action, workspaceId, code}`). Aucune PII.
- Zod strict : `categorieId` non-uuid → `INVALID_PARAMS` (rejet bruyant existant).
- Non-énumérant : un uuid étranger/inexistant rend 0 ligne (404-équivalent de
  lecture), jamais une erreur « catégorie inconnue ».
- Montants : aucun nouveau calcul, aucune conversion — le prédicat ne touche pas
  aux montants.

## 6. Gates avant tout commit

`lint` + `tsc --noEmit` + `build` + vitest verts (stop-loss ; le hook pre-commit
rejoue la suite complète PGlite). Visual QA (Gate 4) sur la démo : catégorie
active / résultat vide / effacement, contre UI_GUIDELINES §1.1–2.3 (header ne
wrap jamais, condensation sous `lg` intacte — le groupe FILTRES reste
`overflow-x-auto`). Revue contradictoire à contexte frais avant de s'arrêter à la
branche. Clôture : cocher TX-QA-FILTRE-CAT1 dans TODOS.md + entrée
TX-FILTRE-CAT-SOUSARBRE1 (P2, différé §2.2).
