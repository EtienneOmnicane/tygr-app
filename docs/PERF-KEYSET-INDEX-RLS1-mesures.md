# PERF-KEYSET-INDEX-RLS1 — rapport de mesure

> Phase : **mesure**. 2026-07-23, branche `fix/perf-keyset-index-rls1`.
> Base : stack docker locale (`tygr_postgres`, PostgreSQL 16), workspace « Omni-FI HQ »
> (`33c1cbaa-…`), **9 857 transactions / 510 splits**, toutes en partition
> `transactions_cache_2026` (428 pages, 3,4 Mo). Sous `SET ROLE tygr_app` (non-owner,
> sans BYPASSRLS) avec les GUC de `withWorkspace`, **Vision Globale**.
> Harnais reproductible : `scripts/perf/page-transactions.sql`.

## Résumé — ce que cette session établit

1. **La prémisse du ticket est fausse.** Le prédicat RLS `workspace_id =
   current_setting(…)` n'est **pas** opaque à l'estimateur : mesuré seul, il donne
   `rows=9857` — l'estimation **exacte** — et l'index couvrant **est** emprunté.
2. Les vrais verrous sont **trois**, et ils sont **cumulatifs** : un ordre de tri qui ne
   peut pas correspondre à l'index, une estimation effondrée par les clauses `OR` des
   policies de **périmètre** (pas de tenancy), et les jointures de provenance qui
   pilotent le plan.
3. **Les trois pistes proposées par le ticket sont écartées par la mesure**, ainsi que
   quatre pistes complémentaires. Aucun correctif n'est livré : le seul levier qui
   atteint le plan cible sur la page (`enable_sort=off`, ×10,5) **détruit la requête
   réelle** (6,9 ms → 1 164 ms). Détail chiffré en §4.
4. Un obstacle **sémantique** (et non de performance) bloque le seul chemin qui
   resterait ouvert — il est décrit en §5 et relève de l'isolation, pas de la perf.

## 1. Mesure AVANT (état de `main`)

`EXPLAIN (ANALYZE, BUFFERS)`, requêtes dérivées ligne à ligne de `listerTransactions`
(`src/server/repositories/transactions.ts`), page 1, `limit 51`.

| # | Chemin | Temps | Buffers | Plan observé |
|---|---|---|---|---|
| Q1 | résolution de page seule (étage 1) | **7,48 ms** | 2 891 | Nested Loop + top-N heapsort |
| Q2 | requête complète (étage 1 + LATERAL) | **6,89 ms** | 2 993 | idem + agrégat `loops=51` |
| Q3 | `?statut=COMPLET` | **41,85 ms** | — | Nested Loop Semi Join, `loops=29 571` |
| Q4 | `?statut=NON_CATEGORISE` | **13,70 ms** | — | Nested Loop Anti Join |
| Q5 | `?statut=PARTIEL` | **52,40 ms** | — | Nested Loop Semi Join |
| Q6 | page 2 (curseur keyset) | **5,28 ms** | — | Nested Loop + top-N heapsort |

Q1 varie de 5,8 à 9,3 ms selon les passes (cache chaud, base vivante) ; le tableau
retient la passe enregistrée dans le harnais. Toute comparaison doit être **appariée** :
rejouer avant et après dos à dos, jamais deux passes séparées.

**Le plan n'est pas celui que décrit le ticket.** Le ticket annonce « `Seq Scan` sur la
partition + top-N heapsort ». Observé (passe à 9,25 ms) : un **Nested Loop piloté par
les jointures de provenance** —

```
Limit (actual time=9.100..9.104 rows=51)
  Sort (top-N heapsort)
    Nested Loop                              (cost … rows=1) (actual rows=9857)
      Nested Loop                            (cost … rows=1) (actual rows=157)
        Index Scan on bank_connections       (rows=1 estimé)  (actual rows=3)
        Bitmap Heap Scan on bank_accounts    (rows=1 estimé)  (actual rows=52, loops=3)
      Append                                 (rows=5 estimé)  (actual rows=63, loops=157)
        Bitmap Heap Scan on transactions_cache_2026
              using transactions_cache_2026_bank_account_id_idx
```

`bank_connections` (3 lignes) et `bank_accounts` (157) sont mis **en tête**, et les
9 857 transactions sont ramenées par `bank_account_id_idx` — **157 boucles** — avant
d'être intégralement triées. Le mode de défaillance annoncé par le ticket (coût `O(N)`,
index de pagination jamais emprunté) est **confirmé** ; sa cause ne l'est pas.

## 2. Diagnostic corrigé — trois verrous cumulatifs

### V0 (réfuté) — le prédicat tenant est parfaitement estimé

Décomposition clause par clause, GUC posés, sur `transactions_cache_2026` (réel : 9 857) :

| Prédicat | `rows` estimé | Plan |
|---|---|---|
| A. `workspace_id = current_setting(…)` **seul** | **9 857** ✅ | Index Only Scan `…workspace_id_transaction_date_idx` |
| B. + `is_removed = false` | **9 857** ✅ | Seq Scan |
| C. + clause `OR` de `account_scope` | **49** ❌ | Seq Scan |
| D. + clause `OR` de `view_filter` | **1** ❌ | Seq Scan |

PostgreSQL **évalue les fonctions `STABLE` au moment de la planification**
(`estimate_expression_value`) : il connaît donc la valeur du GUC et applique une vraie
sélectivité par MCV. `SET STATISTICS`, comme une « fonction `STABLE` encapsulant le
GUC », visent donc un problème **qui n'existe pas**.

> ⚠️ Piège de méthode rencontré : une mesure d'estimation faite **sans poser les GUC**
> donne `rows=1` sur A et fait croire à l'opacité du prédicat tenant — parce que
> l'expression s'évalue alors à `NULL`. Toute mesure d'estimation sous RLS doit poser
> les GUC, sinon elle mesure le mauvais phénomène. C'est probablement l'origine du
> diagnostic erroné du ticket.

### V1 — l'ordre de tri ne peut pas correspondre à l'index

`ORDER BY transaction_date DESC` signifie `DESC NULLS FIRST` (défaut SQL). L'index est
`(workspace_id, transaction_date DESC NULLS LAST)`. Les *pathkeys* ne correspondent
donc **jamais** : cet index ne peut structurellement pas satisfaire l'ORDER BY, quelle
que soit la qualité de l'estimation.

Preuve, à levier égal (`enable_seqscan=off`, table seule) :

| Ordre demandé | Temps | Buffers | Plan |
|---|---|---|---|
| `DESC` (= NULLS FIRST) | 4,24 ms | 430 | Sort complet, index `…omnifi_txn_id…` |
| `DESC NULLS LAST` | **0,152 ms** | **42** | Index Scan `…workspace_id_transaction_date_idx` + Incremental Sort |

`transaction_date` étant `NOT NULL`, les deux ordres sont **rigoureusement
équivalents** en résultat : c'est un changement de forme, pas de sémantique.

### V2 — l'estimation est effondrée par les clauses de PÉRIMÈTRE

La policy `account_scope` (migrations 0016/0017) porte deux clauses de la forme :

```sql
(NULLIF(current_setting('app.current_account_scope', true), '') IS NULL)
OR (bank_account_id = ANY (string_to_array(current_setting(…), ',')::uuid[]))
```

Aucune des deux branches n'est estimable : le `NullTest` porte sur une **expression**
(pas une `Var`) → `DEFAULT_UNK_SEL`, et le `= ANY(…)` porte sur un tableau non
constant. Chaque clause est donc estimée à ~0,5 %, alors qu'en Vision Globale elle est
**neutre** (GUC non posé ⇒ toujours vraie). Deux clauses sur `transactions_cache`, trois
sur `bank_accounts` (avec `entity_scope`) : le produit s'effondre à `rows=1`.

Conséquence décisive : **avec `rows=1`, le `LIMIT 51` ne réduit plus aucun coût** — le
planificateur calcule le coût fractionné `51/rows_estimées`, donc il facture 100 % du
plan. Tout plan paraît gratuit, et le parcours ordonné n'a plus aucun avantage.

### V3 — les jointures de provenance pilotent le plan

`bank_accounts` et `bank_connections` souffrent du même effondrement (`rows=1` contre
157 et 3 réels). Le planificateur les met en tête et matérialise les 9 857 lignes avant
le tri. **C'est ce verrou qui fait échouer toutes les corrections portant sur la seule
table `transactions_cache`.**

## 3. Le plan cible, et ce qu'il coûte de l'atteindre

Atteint en levant V1 + V2 sur la table seule (`0,48 ms`, index ordonné, 53 buffers) et
sur la requête complète via `enable_sort=off` (`0,88 ms`) :

```
Limit                                          (actual time=0.590..0.717 rows=51)
  Incremental Sort
    Index Scan using transactions_cache_2026_workspace_id_transaction_date_idx
```

228 buffers au lieu de 2 891. Le parcours s'arrête après ~88 lignes lues au lieu de
9 857 : `O(log N)` au lieu de `O(N)`. **Mais aucun des chemins pour y parvenir ne
survit à la requête réelle** (§4).

## 4. Les sept pistes testées — toutes écartées, avec chiffres

| # | Piste | Résultat | Verdict |
|---|---|---|---|
| P1 | `ALTER COLUMN workspace_id SET STATISTICS` *(ticket)* | `rows=1` inchangé, y compris après suppression des MCV | **Sans objet** — vise V0, qui n'existe pas |
| P2a | Fonction SQL `STABLE` encapsulant le GUC *(ticket)* | **inlinée** par le planificateur : clauses `OR` restaurées à l'identique, plan inchangé (5,72 ms) | Écartée |
| P2b | Idem, non inlinable (**PL/pgSQL**) | Estimation restaurée (`rows` 1 → 3 286). Page seule 5,44 → **0,20 ms**. Mais requête **complète : 11,25 ms** (régression vs 6,89) et scan complet **3,64 → 9,00 ms (+147 %)** | Écartée |
| P2c | Idem, non inlinable (**SQL + `SET search_path`**) | Page 0,54 ms mais scan complet **19,36 ms (+432 %)** | Écartée |
| P3 | `pg_hint_plan` *(ticket)* | Absent de l'image `postgres:16-alpine`, et **indisponible sur Neon** (cible de production) | Non testable |
| P4 | `enable_seqscan = off` | Requête complète : **8,73 ms** — le Nested Loop de provenance reste | Écartée |
| P5 | `join_collapse_limit = 1` | **16,78 ms** | Régression |
| P6 | `JOIN LATERAL` corrélé pour la provenance | **Aplati** par le planificateur (pas de `LIMIT` interne ⇒ pas de barrière) : 8,89 ms | Écartée |
| P7 | `enable_sort = off` + `NULLS LAST` | Page seule **0,88 ms** (×10,5, plan cible atteint) — mais requête **complète 6,89 → 1 164 ms**, `?statut=COMPLET` 41,9 → **81,9 ms**, `?statut=PARTIEL` 52,4 → **142,5 ms** | **Rejetée** |

**Pourquoi P7 explose** : `enable_sort=off` est un levier **de requête, pas de nœud**.
Il pénalise aussi le tri interne de `array_agg(… order by …)` du LATERAL de ventilation
(`Sort (cost=10000000033.45…)`, soit le `disable_cost`), exécuté 51 fois. Le levier qui
optimise l'étage 1 sabote l'étage 2 — et les deux vivent dans **la même requête SQL**,
donc aucun GUC ne peut les distinguer.

**Pourquoi P2b/P2c ne suffisent pas** : elles lèvent V2 mais pas V3. Le plan continue de
passer par `bank_account_id_idx` sous le pilotage des jointures, où le prédicat de
périmètre n'intervient même pas — et le surcoût d'appel de fonction (~0,55 µs × N) est
alors payé **sur toutes les requêtes agrégées** du produit, qui sont intrinsèquement
`O(N)` et n'ont rien à y gagner.

## 5. Le seul chemin restant — et pourquoi il n'est pas un lot de performance

Le plan cible exige de **résoudre la page sur `transactions_cache` seule** (barrière
`LIMIT`, comme PERF-VENTILATION-AGG1), puis de joindre la provenance sur les ≤ 51
lignes retenues. Ce déplacement est **sémantiquement incorrect en l'état** :

`withWorkspace` pose `account_scope` = (comptes des **parties**) ∪ (comptes des
**entités**), tandis que `bank_accounts` porte **en plus** `entity_scope` sur
`entity_id`. Un compte obtenu par une partie, mais dont l'entité est hors du scope
entité, est donc :

- **visible** dans `transactions_cache` (policy `account_scope` satisfaite) ;
- **masqué** dans `bank_accounts` (policy `entity_scope` refusée).

L'`innerJoin` élimine aujourd'hui ces lignes. Appliquer le `LIMIT` avant lui rendrait
des pages **amputées** (moins de 51 lignes, `hasMore` faux). Dans ce cas précis,
`ENTITY-READ-JOIN1` n'est donc **pas** une simple ceinture — contrairement à ce
qu'affirme `CLAUDE.md` § Entités — c'est la jointure qui porte l'invariant de l'axe
entité sur les tables filles.

**Constat remonté, non tranché** (règle 6) : soit `entity_scope` sur `bank_accounts`
est volontairement plus restrictif que `account_scope`, soit c'est une divergence à
corriger. Trancher cela est un **lot d'isolation**, pas un lot de performance — et il
conditionne toute optimisation ultérieure de ce chemin.

## 6. Recommandation

Ne rien changer aujourd'hui. Le déclencheur du ticket (« un workspace dépasse ~100 000
transactions ») reste le bon signal ; à 9 857 lignes le chemin nominal est à **6,9 ms**,
sans urgence. Quand il se déclenchera, l'ordre des travaux est :

1. Trancher la divergence `account_scope` / `entity_scope` (§5) — lot d'isolation.
2. Une fois la maille du périmètre unifiée : paginer sur `transactions_cache` seule
   (barrière `LIMIT`) + provenance en `LATERAL` corrélé — ce qui lève V3.
3. `ORDER BY … DESC NULLS LAST` — lève V1, indispensable, sans effet isolément
   (mesuré : 6,07/5,77/5,73 ms contre 8,09/5,83/5,94 ms — dans le bruit).
4. Ne rendre les clauses de périmètre opaques (V2) **que si** 1–3 ne suffisent pas, et
   en mesurant alors la régression sur les requêtes agrégées.

## 7. Reproduire

```bash
docker start tygr_postgres            # si la stack dort
docker exec -i tygr_postgres psql -U tygr_owner -d tygr \
  -f - < scripts/perf/page-transactions.sql
```

Le harnais pose `SET ROLE tygr_app` + les GUC de `withWorkspace` : sans cela, la RLS ne
mord pas et les plans mesurés sont faux. **PGlite ne prouve jamais un plan** — les
suites d'isolation tournent dessus, toute preuve de performance se fait ici.
