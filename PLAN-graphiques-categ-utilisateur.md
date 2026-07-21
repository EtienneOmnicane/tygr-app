# PLAN — GRAPHIQUES-CATEG-UTILISATEUR1 : le donut sur la catégorie effective

**Date** : 2026-07-21 · **Phase** : CONCEPTION STRICTE (aucune ligne de code applicatif) ·
**Branche** : `plan/graphiques-categ-utilisateur` ·
**Statut** : ✅ **ARBITRÉ** (Etienne, 2026-07-21 — §9) — périmètre verrouillé (§9bis), prêt à implémenter

---

## 0. Verdict & pushback (règle 10)

**La demande est saine, le diagnostic du brief est exact — mais il est incomplet sur trois
points, dont un qui casserait le donut s'il était ignoré.**

### 0.1 La prémisse est vérifiée

`repartitionParCategorie` (`src/server/repositories/insights.ts:301`) groupe bien sur
`primary_category` seule (`insights.ts:366`, `:445`) et n'ouvre jamais
`transaction_categorizations`. Les catégories utilisateur (« Loyer »…) sont donc
structurellement invisibles sur `/graphiques`. Confirmé, confiance 10/10.

### 0.2 ⚠️ Pushback 1 — la décision est DÉJÀ tranchée, ne pas la rouvrir

`DECISION-categorysummary-amont-vs-interne.md:6-10` porte l'arbitrage d'Etienne du
**2026-07-17** : **D1 = A** (dérivation interne), **D2 = c** (hybride : splits TYGR
priment, reste sur `primary_category`), **D3 = annoter**. Le présent chantier **est**
l'application de D2=c au donut. Il ne se re-litige pas (règle 10, dernier alinéa) — ce
plan l'exécute.

**Conséquence structurante** : `PLAN-categorysummary-axe-categorie.md` planifie la même
notion d'axe pour la matrice catégorie × mois. Deux implémentations parallèles de
« catégorie effective » produiraient deux écrans qui se contredisent sur les mêmes
données — le pire défaut possible sur un outil de trésorerie.
→ **Décision D-a (§5)** : un fragment SQL unique partagé, pas deux.

*État du chantier concurrent, vérifié* : la branche `feat/graphs-categorysummary` ne
porte **qu'un commit de documentation** (`3fb42bc`, conception), **zéro code**, et n'a
**aucune branche distante**. Son worktree
(`/sessions/gracious-sharp-brahmagupta/…`) est un **fantôme** (session disparue, chemin
inexistant). Aucune collision de code à craindre ; la collision est *conceptuelle* et se
règle par D-a.

### 0.3 ⚠️ Pushback 2 — « manuel > règle > banque » décrit une priorité qui n'existe pas à la lecture

Le brief demande de résoudre une cascade à trois niveaux. **Elle n'a pas lieu d'être** :
le modèle garantit à l'ÉCRITURE qu'une transaction ne porte jamais `MANUAL` et `RULE`
simultanément.

- Le moteur de règles **skippe** toute transaction ayant déjà un split, sous verrou :
  `regles-categorisation.ts:514-524` (« Re-vérification SOUS VERROU […] MANUAL prime et
  on skip ») + `NOT EXISTS` en sélection des candidates (`:406-410`).
- L'édition manuelle **purge tout** puis réinsère en `MANUAL` :
  `categorisation.ts:379-414`.

La cascade réelle est donc **binaire** : `splits` (quelle que soit leur source) **>**
`primary_category`. Un `CASE` à trois niveaux serait du code mort, et coûterait un
`JOIN` supplémentaire pour rien.

**Réserve à ne pas balayer** : cette garantie est **conventionnelle, pas structurelle**.
`ajouterSplit` accepte `source` et `ruleId` en paramètres libres
(`categorisation.ts:45-52, 133-137`) — un futur appelant pourrait mêler MANUAL et RULE
sur une même transaction. Comme le tri de la catégorie dominante ignore déjà `source`
(`transactions.ts:557-558`), l'agrégat retomberait silencieusement sur le plus gros
montant. → **Décision D-c (§5)** : la doctrine coûte un `order by source='MANUAL' desc`
(≈ 0 €), on la pose sans en dépendre.

### 0.4 🔴 Pushback 3 — LE défaut absent du brief : le « reste non ventilé »

C'est le point qui décide de la faisabilité, et il n'est **pas** dans le brief.

`transaction_categorizations` est une table de **SPLITS avec montants**
(`amount numeric(15,2)`, `> 0` — `schema.ts:620, 650`), et l'invariant est une
**inégalité** : `Σ splits ≤ |montant transaction|`. Verbatim `schema.ts:598-602` :

> « La somme des `amount` des lignes d'une transaction doit rester **≤** |montant de la
> transaction| (invariant appliqué côté repository en transaction — un CHECK SQL ne peut
> pas agréger d'autres lignes) »

**L'état PARTIEL est donc légal et déjà rendu ailleurs** (`transactions.ts:275-281`
dérive `NON_CATEGORISE` / `COMPLET` / `PARTIEL`).

**Mode de défaillance concret** : une sortie de 1 000 Rs ventilée à 300 Rs sur « Loyer »
laisse 700 Rs non imputés. Un donut qui sommerait naïvement les splits afficherait un
total de 300 Rs pour une période où 1 000 Rs sont réellement sortis. Pire : le total
central du donut vient d'une window `sum(sum(amount)) over (partition by currency)`
(`insights.ts:419-420`) — il divergerait du KPI « Sorties » du dashboard, sur le même
écran, sans aucun message. **Un donut de trésorerie dont les parts ne somment pas au
flux réel est un défaut de correction, pas d'ergonomie.**

→ **Décision D-b (§5)** : `UNION ALL` à deux branches, le reste imputé explicitement.
L'exhaustivité (`Σ parts = Σ flux`) devient un **invariant testé**, pas un espoir.

### 0.5 Pushback 4 — un quick win indépendant est probablement 50 % de ce qu'Etienne voit

Le brief dit « seulement les catégories bancaires **brutes** d'Omni-FI ». *Brutes* est
littéral : **le donut affiche l'ANGLAIS**. `insights.ts:370` produit
`coalesce(<clé>, 'Non catégorisé')` sur `primary_category` — valeur OBIE non traduite
(« Utilities », « Housing », « Bank fees »).

Or le dictionnaire FR **existe et est utilisé partout ailleurs** : `src/lib/categories-fr.ts`
(28 entrées, sonde runtime 2026-06-23), consommé par `/transactions`
(`adapter.ts:47`) et le dashboard (`transactions-table.tsx:18`) — **jamais par
`/graphiques`**. C'est une régression de cohérence, isolée, corrigeable en ~15 lignes
sans toucher à l'axe.

→ **Lot 0 (§8)**, livrable seul, avant tout le reste. Avec un piège documenté en D-d.

### 0.6 Ce que le brief demande de résoudre et qui est **déjà résolu**

Le brief demande comment le plan traitera le multi-devise (« une répartition par devise ?
un donut par devise ? »). **C'est déjà fait, correctement, depuis l'origine** :

- `GROUP BY … , transactions_cache.currency` (`insights.ts:445`), totaux par
  `over (partition by currency)` (`insights.ts:419-420`) ;
- le DTO porte `devises: RepartitionDevise[]`, chacune avec son `total` (`types.ts:111-137`) ;
- l'UI monte **une carte par devise** (`graphiques-feature.tsx:221-223`) ;
- aucune addition cross-devise nulle part, et le test le verrouille
  (`tests/isolation/graphiques-repartition-isolation.test.ts:125`).

**Aucune action.** Le seul point de vigilance est de ne pas *casser* cette propriété en
introduisant l'`UNION ALL` (§7, invariant I2).

**Conclusion** : demande saine, à exécuter — après avoir traité le reste non ventilé
(0.4), qui n'était pas au cahier des charges et qui en conditionne la correction.

---

## 1. Diagnostic — la chaîne de données actuelle

```
page.tsx:45          chargerAnalyseCategories()                    [RSC]
 └─ actions.ts:103   exigerSessionWorkspace() → bornesPeriodeMaurice() → withWorkspace
     └─ actions.ts:114  repartitionParCategorie(tx, {sens, from, to, fromPrecedent, toPrecedent})
         └─ insights.ts:301                                        [repository]
             ├─ :380-403  requête FENÊTRE PRÉCÉDENTE (L4, séparée)
             └─ :406-453  requête COURANTE  ── GROUP BY primary_category, currency
 └─ graphiques-feature.tsx:221  → RepartitionDeviseCard (1/devise)
      ├─ donut-categories.tsx:66     parts[] → secteurs SVG
      └─ legende-categories.tsx:91   parts[] → lignes + BadgeVariation
```

| Maillon | Fichier:ligne | Constat |
|---|---|---|
| Clé de groupe | `insights.ts:366` | `case when <estNonCat> then null else primary_category end` — **seule source d'axe** |
| Label | `insights.ts:370` | `coalesce(<clé>, 'Non catégorisé')` — **anglais OBIE non traduit** (défaut B) |
| Sentinelles | `insights.ts:357-361` | NULL / `''` / `unclassified` / `uncategorized` collapsés (retour Etienne 2026-07-08) |
| Isolation | `insights.ts:388, 431` | `innerJoin(bankAccounts)` sur les **deux** requêtes (ENTITY-READ-JOIN1) |
| Tombstones | `insights.ts:434` | `is_removed = false` ✅ |
| Bornes | `insights.ts:438-442` | `>= from` et `< to + 1 jour` en SQL, params liés — haute inclusive ✅ |
| Fuseau | `periode-analyse.ts:66` → `format-date.ts:98,124` | `Intl` `timeZone: Indian/Mauritius`, `en-CA` → `YYYY-MM-DD` ✅ |
| Splits | — | **jamais lus** ← le défaut A |
| Couleurs | `palette-categories.ts:21-26` | par **rang** (`cat-1..8`), neutre au-delà et si `estNonCategorise` |
| Consommateurs | — | `/graphiques` **uniquement** (aucun autre appelant) |

**Tests existants** : `tests/isolation/graphiques-repartition-isolation.test.ts`, 14 cas
sous PGlite + `set role tygr_app` (isolation, sentinelles, L4, bornes, contre-preuves R1a/R1b).
Base solide à étendre — pas à réécrire.

---

## 2. Le modèle de catégorisation réel

Trois espaces distincts, à ne jamais fusionner :

| Source | Où | Nature | Langue |
|---|---|---|---|
| **Banque (OBIE/Omni-FI)** | `transactions_cache.primary_category` (`schema.ts:436`) | étiquette plate, `varchar(120)`, nullable | **anglais** (pivot) |
| **Règle TYGR** | split `source='RULE'` + `rule_id` (`schema.ts:625-628`) | 1 split à **100 %** de `abs(amount)` (`regles-categorisation.ts:528-537`) | FR (référentiel) |
| **Manuel TYGR** | split `source='MANUAL'`, `rule_id NULL` | N splits, montants libres, **Σ ≤ |amount|** | FR |

- `CATEGORIZATION_SOURCES = ["MANUAL","RULE"]` (`schema.ts:545`) — **il n'existe pas de
  source `BANK`** : la catégorie bancaire n'est jamais matérialisée en split.
- `transactions_cache` est **READ-ONLY** pour toute la catégorisation (`schema.ts:539-543`) ;
  le `FOR UPDATE` n'y sert que de verrou de sérialisation (`regles-categorisation.ts:495-498`).
- Hiérarchie TYGR : `categories.parent_id` — Nature racine (NULL) / Sous-nature
  (`schema.ts:554-595`). Les splits pointent **toujours une feuille ou une racine**,
  indifféremment → l'axe doit choisir un niveau (**D-e**).
- **Catégorie effective : matérialisée nulle part.** Aucune vue, aucune vue matérialisée,
  aucune fonction SQL (grep `CREATE VIEW|MATERIALIZED|FUNCTION` sur `drizzle/` → 0 hors
  triggers append-only). Ce qui existe à la lecture est la **catégorie DOMINANTE**
  (`transactions.ts:550-563`), une notion différente (part au plus gros montant), utilisée
  par `/transactions` seulement.

**Quand les règles s'appliquent** — toujours en ÉCRITURE, jamais à la lecture :
1. post-sync, best-effort, borné au compte (`ingestion/orchestrateur.ts:209-221`) ;
2. bouton « Ré-analyser » (`(workspace)/regles/actions.ts:205-222`), en session
   **volontairement amputée** du périmètre (sinon l'`INNER JOIN bank_accounts` ne
   catégoriserait que le filtre courant — repro `tests/isolation/perimetre-amputation-gestion-isolation.test.ts:190-202`).

---

## 3. Les trois défauts, séparés

| # | Défaut | Portée | Lot |
|---|---|---|---|
| **A** | Le donut ignore les splits (règles + manuel) | axe de groupement | 1-2 |
| **B** | Le donut affiche l'anglais OBIE, seul écran de l'app à le faire | libellé | **0** |
| **C** | Aucun traitement du reste non ventilé → parts ≠ flux réel | correction | **1 (bloquant)** |

C est **la** contrainte : il naît au moment où l'on lit les splits (donc avec A) et rend
le donut faux s'il n'est pas traité dans le même lot.

---

## 4. Contrat cible

Signature **inchangée** (aucun appelant à migrer, `actions.ts:114` et `:142` intacts) ;
le DTO gagne deux champs, additifs :

```ts
export interface PartCategorie {
  categorie: string;            // libellé affiché (FR)
  estNonCategorise: boolean;
  montant: string;              // chaîne décimale SQL
  part: string;                 // fraction 0..1 de SA devise
  nbTransactions: number;
  montantPrecedent: string;
  // ── ajouts D2=c ─────────────────────────────────────────────
  origine: "TYGR" | "AMONT" | "AUCUNE";   // espace de noms de la clé
  categorieId: string | null;             // categories.id si origine=TYGR
}
```

`origine` **n'est pas cosmétique** : « Loyer » (TYGR) et un hypothétique « Loyer » amont
sont deux clés différentes. La clé de groupe et la clé de merge L4 sont donc
`(devise, origine, catégorie)` — jamais le label seul, sous peine de fusionner deux
espaces de noms (piège nommé dans `DECISION-…:135`, colonne « Contre »).

### SQL de principe (à valider en implémentation)

```sql
WITH bornes AS (…),                       -- params liés, from / to+1j
     splits_periode AS (                  -- branche 1 : ventilation TYGR
       SELECT t.currency, 'TYGR' AS origine, c.id AS cat_id, c.name AS cat_label,
              tc.amount, t.id AS txn_id
       FROM transactions_cache t
       JOIN bank_accounts   ba ON t.bank_account_id = ba.id      -- ENTITY-READ-JOIN1
       JOIN transaction_categorizations tc
            ON (tc.transaction_id, tc.transaction_date) = (t.id, t.transaction_date)
       JOIN categories c
            ON (c.id, c.workspace_id) = (tc.category_id, tc.workspace_id)
       WHERE t.is_removed = false AND <filtreSens> AND <bornes>
     ),
     reste AS (                           -- branche 2 : le NON ventilé (défaut C)
       SELECT t.currency,
              CASE WHEN <estNonCat> THEN 'AUCUNE' ELSE 'AMONT' END AS origine,
              NULL::uuid AS cat_id,
              <cleAmontNormalisee> AS cat_label,
              abs(t.amount) - coalesce(v.montant_ventile, 0) AS amount
       FROM transactions_cache t
       JOIN bank_accounts ba ON t.bank_account_id = ba.id
       LEFT JOIN (  SELECT transaction_id, transaction_date, sum(amount) AS montant_ventile
                    FROM transaction_categorizations
                    WHERE transaction_date >= $from AND transaction_date < $to1  -- borner la dérivée
                    GROUP BY 1,2 ) v
              ON (v.transaction_id, v.transaction_date) = (t.id, t.transaction_date)
       WHERE t.is_removed = false AND <filtreSens> AND <bornes>
         AND abs(t.amount) - coalesce(v.montant_ventile, 0) > 0   -- rien à imputer si COMPLET
     )
SELECT currency, origine, cat_id, cat_label,
       sum(amount)::numeric(15,2)::text                                   AS montant,
       count(DISTINCT txn_id)::int                                        AS nb_transactions,
       (sum(sum(amount)) over (partition by currency))::numeric(15,2)::text AS total_devise,
       …
FROM (SELECT * FROM splits_periode UNION ALL SELECT * FROM reste) u
GROUP BY currency, origine, cat_id, cat_label
ORDER BY currency, (origine = 'AUCUNE') ASC, sum(amount) DESC, cat_label;
```

**Points d'attention SQL** (dette déjà payée ailleurs, à réutiliser) :
- borner la table dérivée `v` **par la période** — le patron de `transactions.ts:250-268`
  ne la borne pas (page de 50 lignes, coût nul) ; sur 12 mois c'est un scan complet des
  splits du workspace ;
- `count(DISTINCT txn_id)` sur la branche splits : une transaction ventilée sur 3
  catégories ne compte **pas** 3 transactions. Sur la branche `reste`, 1 ligne = 1
  transaction. Un même `nbTransactions` de devise devient donc la somme de deux
  cardinalités disjointes — **à définir explicitement** (**D-f**) ;
- pièges Drizzle connus : `42803` sur `sql.raw`, `::numeric(15,2)::text` obligatoire pour
  figer l'échelle (cf. `insights-derives-livres-bloques-concurrence`) ;
- la table dérivée plutôt qu'une sous-requête scalaire : en `rowMode:"array"` Drizzle mappe
  par POSITION, une scalaire de tête désaligne le mapping (symptôme observé,
  `transactions.ts:256-262`).

---

## 5. Décisions tranchées

| # | Décision | Retenu | Écarté (et pourquoi) | Coût |
|---|---|---|---|---|
| **D-a** | Une seule définition d'axe | **Fragment SQL partagé** `axeCategorieEffective()` dans `insights.ts`, consommé par le donut ET la future matrice catégorie × mois | Deux implémentations (donut + matrice) → deux écrans contradictoires sur la même donnée | +0,5 j maintenant, −2 j plus tard |
| **D-b** | Reste non ventilé | **`UNION ALL` : splits + reste imputé à l'amont** (D2=c littéral) | Sommer les splits seuls → donut faux (§0.4). Exclure les PARTIELS → biais silencieux pire | inclus lot 1 |
| **D-c** | Cascade de sources | **Binaire `splits > primary_category`** + `order by (source='MANUAL') desc` en départage défensif | `CASE` à 3 niveaux : code mort par construction (§0.3) | ≈ 0 |
| **D-d** | Traduction FR | **GROUP BY sur le libellé TRADUIT**, via une expression SQL `CASE` **générée** depuis `CORRESPONDANCE_FR` (source unique préservée) ; repli d'une clé non cartographiée = **le libellé OBIE lui-même** | Traduire au rendu seulement : `categorieFr` est **non injective** (§5.1) → secteurs homonymes **garantis**. Recopier les 28 paires en SQL à la main : duplication de source de vérité (règle 9) | lot 0 |
| **D-e** | Niveau de hiérarchie | **Feuille telle que saisie** (le nom du split). Fragment **paramétré `{niveau}` dès le lot 1**, figé à `"feuille"` à l'appel, **non exposé à l'UI** (Q3 tranché) | Remonter à la Nature écrase « Loyer » sous « Charges d'exploitation » — perte exacte de ce qu'Etienne cherche à voir. Sélecteur commutable = hors périmètre (§9bis) | ≈ 0 |
| **D-f** | `nbTransactions` | **Compte les transactions DISTINCTES contribuant à la part** ; `montantMoyen` de devise reste `total / nb transactions distinctes de la devise` | Compter les lignes de split gonflerait le nb et fausserait la moyenne | inclus lot 1 |
| **D-g** | Rétroactivité | **Le donut lit l'état PERSISTÉ des splits. Aucun calcul de règle à la lecture.** | Évaluer les règles au SELECT : coûteux (ILIKE sur N règles × M transactions), non déterministe vs `/transactions`, et divergerait de l'audit `categorization_audit` | ≈ 0, mais exige **Q2** |

### 5.1 D-d — pourquoi le rendu ne suffit PAS (piège vérifié)

`categorieFr` (`categories-fr.ts:71-75`) est une fonction **many-to-one**, pas un simple
relabel. Deux paires le prouvent dans le dictionnaire actuel :

```
income            → "Revenus"          revenue        → "Revenus"
banking & finance → "Frais bancaires"  bank charges   → "Frais bancaires"
```

Et toute clé inconnue **s'écrase** sur `CATEGORIE_FR_PAR_DEFAUT = "Non catégorisé"`
(`categories-fr.ts:74`) — or `OBIE-CATALOG1` (TODOS) rappelle que **96 % des transactions
étaient hors catalogue** avant la sonde du 2026-06-23 ; le catalogue est figé à la main et
l'amont émet librement.

**Conséquence si l'on traduit uniquement au rendu** (mon hypothèse initiale, écartée) :
un workspace ayant à la fois de l'`income` et du `revenue` obtient **deux secteurs
« Revenus »**, de couleurs différentes (rangs distincts → `palette-categories.ts:21-26`),
avec deux montants et deux pourcentages. Les fusionner côté JS exigerait d'additionner
deux chaînes décimales — **interdit règle 8**. Ce n'est donc pas un risque théorique mais
un défaut déterministe, reproductible dès la première fixture à deux clés synonymes.

**Solution retenue** : le `CASE` SQL est **généré** au chargement du module depuis
`CORRESPONDANCE_FR` (paires liées, jamais d'interpolation de valeur amont), de sorte que
`categories-fr.ts` reste la source unique — ajouter une entrée au dictionnaire met à jour
`/transactions`, le dashboard **et** le donut d'un seul geste. Le `GROUP BY` porte alors
sur le libellé FR, la fusion se fait en SQL, et les invariants I1/I2 restent vrais.

*À vérifier en implémentation* : le fragment généré est bien un `sql` Drizzle à
paramètres liés (pas de `sql.raw` — piège `42803` déjà rencontré), et l'ordre des `WHEN`
est déterministe (les clés du `Record` sont itérées dans l'ordre d'insertion, stable).

### D-g — comportement précis attendu

Une règle créée aujourd'hui **ne modifie pas** le donut des mois passés tant que
« Ré-analyser » n'a pas tourné (`regles/actions.ts:205-222`) ou qu'un nouveau sync n'a pas
touché le compte (`orchestrateur.ts:209-221`, **borné au compte synchronisé**).

C'est **cohérent avec tout le reste de l'app** (`/transactions` affiche la même vérité
persistée) et c'est le bon choix. Mais c'est **invisible pour l'utilisateur** : il crée
« Loyer », revient sur `/graphiques`, ne voit rien changer, et conclut que la
fonctionnalité est cassée — exactement le ticket qui a produit ce brief.

**→ Tranché Q2 = (b), spécification du lot 3** : mention discrète sous le donut + lien
« Ré-analyser », **sans compteur**. Un compteur supposerait de détecter la
désynchronisation (évaluer les règles non appliquées = une requête de plus, variante (c)
explicitement exclue du périmètre v1). Le comportement silencieux (a) est écarté : c'est
le défaut qui a produit ce ticket.

---

## 6. Isolation & invariants (non négociables)

**Chaîne d'isolation des splits — vérifiée, pas supposée.**
`transaction_categorizations` ne déclare que `tenant_isolation` en Drizzle
(`schema.ts:671`), mais porte bien `account_scope` posée en SQL brut par la migration
**0017** (`0017_account-scope-filles-l5.sql:34-41`) sous forme de **prédicat EXISTS vers
`transactions_cache`** — la table ne portant pas de `bank_account_id` (et on ne le
dénormalise pas : `categorization_audit` est append-only, rétro-remplir violerait
l'immuabilité). L'EXISTS hérite donc récursivement du scope de la transaction parente, y
compris le `view_filter`, et garde la **forme obligatoire « court-circuit Vision Globale
OR EXISTS »** (`0017:44-49`).

Conséquence pour ce plan : la branche `splits_periode` est **doublement bornée** — par sa
propre policy `account_scope` ET par le `JOIN bank_accounts` exigé par ENTITY-READ-JOIN1
(ceinture + bretelles, conforme à `CLAUDE.md`). **Ne pas retirer la jointure** sous
prétexte que la policy existe : elle porte aussi la correction de l'agrégat.

`categories` n'a que `tenant_isolation` (`schema.ts:593`) — sans risque ici : la jointure
est en cardinalité 1:1 garantie (`category_id NOT NULL` + FK composite
`(category_id, workspace_id)`, PK unique), donc elle ne peut ni filtrer ni dupliquer de
lignes (même raisonnement que `transactions.ts:264-268`).

### Invariants à verrouiller par test

| # | Invariant | Pourquoi |
|---|---|---|
| **I1** | `Σ parts(devise) = Σ abs(amount)(devise) = **KPI Sorties(devise)**` sur le sens/période | Le cœur du défaut C, **verrouillé par Q5** : la comparaison au KPI dashboard fait partie du test, pas seulement l'auto-cohérence du donut. **Fixture obligatoire avec un PARTIEL** (500 ventilés sur 1 200) — sans elle le test passe au vert sans rien prouver |
| **I2** | Aucune addition cross-devise après `UNION ALL` | La branche `reste` réintroduit le risque |
| **I3** | `count(DISTINCT txn)` ≠ `count(lignes)` sur une transaction à 3 splits | D-f |
| **I4** | WS_B ne voit jamais un split de WS_A ; membre scopé ne voit pas hors périmètre | Étage 1 + étage 2, sous `set role tygr_app` |
| **I5** | Tombstone `is_removed=true` exclu **des deux branches** | Un split survit à son tombstone (pas de DELETE cascade) → la branche splits doit refiltrer |
| **I6** | Une transaction `COMPLET` ne produit **aucune** ligne `reste` | `> 0` strict ; sinon parts fantômes à 0,00 |
| **I7** | Deux clés OBIE synonymes (`income` + `revenue`) → **un seul** secteur « Revenus » | D-d / §5.1. Fixture avec les DEUX clés, sinon le test ne discrimine rien |
| **I8** | Une clé OBIE hors catalogue reste **distincte** et n'est pas absorbée par « Non catégorisé » | Repli D-d ; protège contre la régression que le `categorieFr` nu introduirait |

**I5 mérite une ligne de plus** : les splits ne sont pas supprimés quand la transaction
est tombstonée (append-only, aucune cascade). Sans le `is_removed = false` sur la branche
`splits_periode`, une transaction effacée logiquement **réapparaîtrait** dans le donut par
sa ventilation. La requête actuelle n'a qu'une branche, donc un seul filtre ; passer à
deux branches duplique le filtre — et un oubli sur une seule des deux est invisible au
lint, au typecheck et au build.

**Fixtures** (leçon `piege-fixture-demo-trop-favorable`) : écrire d'abord la fixture qui
FAIT ÉCHOUER — transaction PARTIELLE, transaction à 3 splits, transaction tombstonée
*avec* splits, catégorie TYGR homonyme d'une catégorie amont. Une fixture 100 % ventilée
rendrait I1 et I6 vrais par accident.

---

## 7. Lots & effort

| Lot | Contenu | Livrable | CC | Humain |
|---|---|---|---|---|
| **0** | **Traduction FR du donut** (défaut B). `CASE` SQL généré depuis `CORRESPONDANCE_FR` (D-d/§5.1), GROUP BY sur le libellé FR, repli non destructif. Tests I7/I8 + 3 tests unitaires des modules purs (`palette`/`pourcent`/`variation` n'en ont aucun aujourd'hui) | PR autonome, aucun changement de schéma | ~60k | **0,5–1 j** |
| **1** | **Axe effectif + reste non ventilé** (défauts A + C). Fragment partagé `axeCategorieEffective()` (D-a), `UNION ALL`, DTO `origine`/`categorieId`, requête L4 alignée sur la même clé | PR applicative, revue croisée obligatoire | ~180k | **2,5 j** |
| **2** | **Tests d'isolation & correction** : I1→I6, fixtures adverses, mutation-check sur la clé de groupe et sur `is_removed` de la branche splits | Extension de `graphiques-repartition-isolation.test.ts` | ~90k | **1 j** |
| **3** | **UI** : `origine` visible (pastille/infobulle « catégorie bancaire » vs « votre catégorie »), mention + lien « Ré-analyser » **sans compteur** (D-g/Q2 = b), Visual QA Gate 4 (4 états × 2 sens) | PR UI | ~70k | **1 j** |
| ~~4~~ | ~~Palette stable par catégorie~~ — **DIFFÉRÉ** (Q4, priorité basse post-démo). Couleur par rang conservée. Ne s'ouvre que si la condition §9.1 est remplie (deux donuts simultanés à l'écran) | — | — | — |

**Total lots 0-3 : ~5 j humain, ~380k CC.** Le lot 0 est décorrélé et **livrable en
premier** (Q1 tranché), en PR séparée.

**Ordre non négociable** : 0 → 1 → 2 → 3. Le lot 1 ne se merge pas sans le lot 2 (règle 9 :
la correction des montants ne se met pas en dette).

---

## 8. Ce qui reste hors périmètre (avec déclencheur)

| Sujet | Pourquoi dehors | Déclencheur de réouverture |
|---|---|---|
| Matrice catégorie × mois | `PLAN-categorysummary-axe-categorie.md`, chantier distinct | Après lot 1 — **doit** consommer `axeCategorieEffective()` (D-a) |
| Virements internes (D3) | Tranché « annoter en v1 » (`DECISION-…:6-10`) | Nature dédiée + règles, chantier séparé |
| Axe Nature/Sous-nature commutable | D-e fige la feuille ; Q3 tranché (pas de v1) | Retour d'usage — le paramètre `{niveau}` existe déjà, seule l'UI manque |
| Contrainte DB interdisant MANUAL+RULE coexistants | Aujourd'hui conventionnel (§0.3) | Si un 3ᵉ appelant d'`ajouterSplit` apparaît → entrée TODOS |
| Unicité `(transaction_id, category_id)` | Absente en base, gardée seulement par `remplacerSplits` (`categorisation.ts:354-357`) | Idem — deux splits même catégorie = deux parts homonymes dans le donut |
| `OBIE-CATALOG1` (catalogue FR figé, 28 entrées) | Dette tracée TODOS | Si l'amont émet de nouvelles catégories |

---

## 9. Arbitrage rendu (Etienne, 2026-07-21) — TRANCHÉ

Les cinq questions sont **closes**. Elles ne se rouvrent qu'en citant la décision et le
fait nouveau qui la remet en cause (règle 10).

| # | Sujet | **Décision** |
|---|---|---|
| **Q1** | Lot 0 (traduction FR) | **PR séparée, livrée en premier.** Ne bloque rien, ne dépend pas de l'axe |
| **Q2** | Signal de rétroactivité | **(b) mention + lien « Ré-analyser » sous le donut.** (a) silencieux **exclu** ; (c) détection active **hors périmètre v1** |
| **Q3** | Niveau hiérarchique | **Pas de sélecteur en v1.** Le fragment `axeCategorieEffective()` est **paramétré `niveau` dès le lot 1** ; l'UI n'expose rien |
| **Q4** | Palette stable | **Différée** (priorité basse, post-démo). Couleur par rang conservée. Condition de remontée : §9.1 |
| **Q5** | Invariant D-b | **Confirmé.** Reste imputé à la **catégorie bancaire** — jamais « Non catégorisé », **jamais abandonné**. La surprise de lecture se traite par un tooltip **plus tard**, pas par la math |

**Décisions structurantes actées — ne pas rouvrir** : **D-a** (fragment SQL unique partagé
entre ce donut et la matrice catégorie × mois — pas deux implémentations de « catégorie
effective »), **D-c** (`order by source='MANUAL' desc` posé **par prudence, sans en
dépendre** — la garantie reste conventionnelle, cf. §0.3), et **D1=A / D2=c / D3=annoter**
tels que tranchés le 2026-07-17.

### 9.1 Q4 — condition de remontée : évaluée, **non remplie**

La réserve d'Etienne était : *remonter la palette stable si une comparaison mois-à-mois du
donut entre dans le périmètre v1*. Fait vérifié : **une comparaison période-à-période est
déjà en v1** — `bornesPeriodePrecedente` est appelée **inconditionnellement**
(`actions.ts:111` et `:139`), et la variation est rendue par `BadgeVariation`
(`legende-categories.tsx:44-89`).

**La condition n'est pourtant pas remplie**, et voici pourquoi : cette comparaison se lit
sur **une ligne de légende qui porte déjà le nom de la catégorie** (libellé + montant + %
+ badge, `legende-categories.tsx:122-153`). La couleur n'est pas le canal de la
comparaison — le nom l'est. La palette instable ne gêne que si l'on met **deux donuts côte
à côte**, ce qui n'existe pas ici : il n'y a qu'un seul rendu, la période précédente n'est
qu'un nombre dans un badge.

→ **Q4 reste différée.** À rouvrir si un écran affichant **deux donuts simultanés** (ou une
petite série de donuts par mois) entre au périmètre — là, la couleur redevient le canal
d'identification et la palette par rang devient un défaut de lecture, pas un détail.

### 9.2 Répercussions sur les décisions du §5

- **D-e** est confirmée (feuille), **et complétée** : `axeCategorieEffective({ niveau })` est
  paramétré dès le lot 1, valeur figée `"feuille"` à l'appel. Le paramètre existe, l'UI ne
  l'expose pas. Aligne le fragment sur `PLAN-categorysummary-…` qui prévoit déjà `{niveau}`.
- **D-g** passe de « recommandation » à **spécification du lot 3** : mention + lien
  « Ré-analyser », **sans compteur de désynchronisation** (ce serait la variante (c),
  exclue).
- **D-b** est verrouillée par Q5 : l'invariant I1 devient **`Σ parts(devise) = Σ flux(devise)
  = KPI Sorties(devise)`** — la comparaison au KPI dashboard entre dans le test, elle n'est
  plus seulement une remarque de §0.4.

---

## 9bis. Périmètre verrouillé (lots 0 → 3)

**Dans le périmètre** — livré par les lots 0-3, rien de moins :

- traduction FR du donut, fusion des synonymes **en SQL** (lot 0) ;
- axe `splits TYGR > primary_category`, niveau feuille, `origine` + `categorieId` au DTO
  (lot 1) ;
- reste non ventilé imputé à la catégorie bancaire, `> 0` strict (lot 1) ;
- fragment partagé `axeCategorieEffective({ niveau })` (lot 1, D-a) ;
- invariants **I1 → I8** testés sous `tygr_app`, fixtures adverses (lot 2) ;
- `origine` visible + mention/lien « Ré-analyser », Visual QA Gate 4 (lot 3).

**Hors périmètre** — tout ajout ci-dessous est une **expansion de scope** (règle 7) et
devient une entrée TODOS, jamais un « pendant qu'on y est » :

- sélecteur Nature ⇄ Sous-nature dans l'UI (Q3) ;
- palette stable par catégorie (Q4 / lot 4, différé) ;
- tooltip explicatif du reste imputé (Q5 — « plus tard », pas v1) ;
- détection active de désynchronisation des règles (Q2 variante c) ;
- matrice catégorie × mois (chantier distinct, **doit** consommer le fragment D-a) ;
- virements internes (D3 = annoter, tranché) ;
- contrainte DB interdisant MANUAL+RULE coexistants, unicité
  `(transaction_id, category_id)` (§8, déclencheurs posés).

**Le lot 4 ne s'ouvre pas** sans la condition §9.1 remplie.

---

## 10. Résumé exécutif

1. Le diagnostic du brief est **exact** : le donut ignore les catégories utilisateur.
2. La décision qui gouverne ce chantier (**D2 = c**) est **déjà prise** (2026-07-17) — ce
   plan l'exécute, il ne la rouvre pas.
3. Le brief **omet le point décisif** : `Σ splits ≤ |montant|`, l'état PARTIEL est légal,
   et un donut qui somme les splits seuls **est faux**. Traité par `UNION ALL` + reste
   imputé (D-b), verrouillé par l'invariant I1.
4. La cascade « manuel > règle > banque » **n'existe pas à la lecture** — elle est
   garantie à l'écriture. Le SQL est binaire, pas ternaire (D-c).
5. Le multi-devise que le brief demande de résoudre **l'est déjà** ; il faut seulement ne
   pas le casser (I2).
6. Un défaut indépendant, non nommé, vaut probablement la moitié du ressenti : le donut
   est **le seul écran de l'app à afficher l'anglais OBIE**. Lot 0, ≤1 j — mais la
   traduction doit se faire **dans le GROUP BY**, pas au rendu : `categorieFr` est
   many-to-one et produirait des secteurs homonymes (§5.1).
7. **Les 5 questions sont tranchées** (Etienne, 2026-07-21, §9) et le périmètre des lots
   0→3 est **verrouillé** (§9bis). Le plan est prêt à implémenter : lot 0 en premier, en
   PR séparée ; le lot 1 ne se merge pas sans le lot 2.
