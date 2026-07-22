# PLAN — PERF-VENTILATION-AGG1 (liste `/transactions`)

> Phase : **conception**. Écrit le 2026-07-22, branche `feat/perf-ventilation-agg1`.
> Base de mesure : stack docker locale (`tygr_postgres`), workspace `Omni-FI HQ`
> (`33c1cbaa-…`), **9 440 transactions / 510 splits**, page 1, sans filtre, `limit 51`,
> sous `SET ROLE tygr_app` avec les GUC de `withWorkspace`, Vision Globale.
>
> ⚠️ La base locale est **VIVANTE** : elle est passée de 480 à 510 splits pendant la
> session. Les chiffres ci-dessous datés de l'exploration ont été pris à 480 ; la mesure
> de livraison (§3.1) est **appariée** à 510. Toute re-mesure doit rejouer avant ET après
> dos à dos, sinon elle compare deux états différents.

## 0. Statut documentaire de la dette — À CORRIGER

Le brief d'implémentation renvoie à `TODOS.md` § « Performance /transactions », entrée
`PERF-VENTILATION-AGG1`, lignes ~74-142. **Cette entrée n'existe pas.** Vérifié :

- `grep -rn "PERF-VENTILATION-AGG1" --include="*.md"` ne remonte que le brief lui-même
  (`PROMPT-impl-perf-ventilation-agg1.md`, non suivi par git) ;
- il n'existe aucune section « Performance /transactions » dans `TODOS.md` ;
- les lignes 74-142 portent sur « Clarté du cycle de connexion » (`SYNC-NOM-BANQUE-DASHBOARD1`,
  `SYNC-LOADER-ETAPES1`, `WIDGET-REJET-TRANSPORT1`) ;
- `git log --all -S "PERF-VENTILATION-AGG1" -- TODOS.md` : aucun commit, aucun stash,
  aucun autre worktree.

**Le diagnostic technique, lui, est RÉEL et reproductible** (§1). Seule son inscription au
registre manque. La session de conception a produit le prompt sans écrire l'entrée. Ce lot
doit donc **créer** l'entrée dans `TODOS.md`, pas la « mettre à jour ».

## 1. Cause racine — CONFIRMÉE par re-mesure

`EXPLAIN (ANALYZE, BUFFERS)` de la requête actuelle (`listerTransactions`, sans filtre) :

```
Limit                                          actual time=1949.724..1949.731 rows=51
  Sort                                         (top-N heapsort)
    Nested Loop Left Join                      actual time=0.921..1947.283 rows=9440
      Rows Removed by Join Filter: 4 415 760
Planning Time: 26.686 ms
Execution Time: 1970.118 ms
```

Conforme au diagnostic du brief : l'agrégat `aggregatVentilation()` (`transactions.ts:550-562`)
est une table dérivée jointe en `.leftJoin(agg, jointureAggregat())` (`:333`). Sous RLS, tous les
prédicats passent par `current_setting(…)`, **opaque à l'estimateur** → `rows=1` estimé à chaque
étage contre 9 440 réels → **Nested Loop Left Join** qui rescanne l'agrégat par ligne externe.
Coût **O(N_transactions × N_splits)**. Les 4,4 M lignes rejetées ≈ 9 440 × 468.

**Nuance par rapport au brief** : le plan n'est PAS « fast-start ». Un `Sort` (top-N) coiffe la
jointure, donc le `LIMIT 51` ne pousse rien : les 9 440 lignes sont jointes puis triées. Sans
effet sur le correctif, mais la description « le LIMIT le pousse vers un plan fast-start » est
inexacte.

## 2. Ce que le brief impose et qui est FAUX — mesuré

> Brief, chemin `?statut=` : « Garder l'agrégat **global** mais forcer une **évaluation unique**
> via une CTE `WITH agg AS MATERIALIZED (…)` (barrière d'optimisation → un seul calcul,
> **Hash Left Join**, indépendant du planificateur). → variante B (`loops=1`). »

**Réfuté à la mesure.** La CTE `MATERIALIZED` fait bien ce qu'elle promet sur le *calcul*
(agrégat évalué une fois : `GroupAggregate … rows=480 loops=1`, 1,0 ms), mais **elle ne
choisit pas la méthode de jointure**. Le planificateur garde un Nested Loop et **rescanne la
CTE** par ligne externe :

```
CTE agg  ->  GroupAggregate  actual time=0.557..1.009 rows=480 loops=1     ← calcul unique ✅
Nested Loop Left Join        actual time=324.318..324.320
  Rows Removed by Join Filter: 4 530 720                                    ← rescan ❌
Execution Time: 324 ms
```

Le brief confond **matérialisation** (empêche le recalcul) et **méthode de jointure**
(reste au choix du planificateur). `enable_nestloop=off` agissait sur la seconde, pas la
première — d'où l'écart 7,9 ms *attendu* vs **324 ms** *mesuré*. Implémenter le brief à la
lettre livrerait une requête à 324 ms en croyant en livrer une à 7,9 ms.

Corollaire : **toute forme joignant un agrégat de cardinalité inconnue reste à la merci de
l'estimateur**. Deuxième contre-épreuve — piloter la jointure « depuis le petit côté »
(agrégat 480 lignes en tête, `inner join transactions_cache` sur la PK) : le planificateur
**réordonne** et retombe sur le rescan → **286 ms**. La robustesse ne s'obtient pas en
espérant un bon plan, mais en écrivant une forme que le planificateur **ne peut pas**
réordonner.

## 3. Conception retenue — sous-requête LATERAL corrélée

**Principe** : une sous-requête corrélée (`LEFT JOIN LATERAL … ON true`) est évaluée **par
ligne externe, par index**, et n'est **pas réordonnable**. Le plan devient indépendant du
hasard de l'estimateur — la propriété que le brief cherchait, obtenue par la bonne voie.

### 3.1 Chemin dominant (sans filtre de statut) — cible ATTEINTE

1. Résoudre la page d'abord (`conditionsFiltres` + keyset `:243-247` + `ORDER BY date desc,
   id desc` + `LIMIT 51`) dans une CTE `page AS MATERIALIZED` — la barrière est ici
   **légitime** : elle empêche l'inlining qui ré-exploserait le périmètre.
2. Calculer l'agrégat **uniquement pour les ≤51 lignes retenues**, via
   `LEFT JOIN LATERAL … ON true` corrélé sur `(page.id, page.transaction_date)`.

```
CTE page                                       rows=9440 (scan + top-N)
Nested Loop Left Join                          actual time=7.517..7.772 rows=51
  ->  Aggregate                                actual time=0.005 rows=1 loops=51   ← loops=51 ✅
        Index Scan using txn_categorizations_workspace_txn_idx
Execution Time: 7.979 ms
```

**Mesure de livraison appariée (9 440 tx / 510 splits, 3 exécutions dos à dos) :
1947/1933/1952 ms → 8,47/8,55/8,64 ms, soit ≈ 227×. Cible < 10 ms tenue.**

Équivalence de sortie prouvée sur les 9 440 lignes (toutes colonnes dérivées) : 0
différence symétrique, 0 désaccord d'ordre, témoin 510 lignes COMPLET. Aucune ligne
PARTIEL dans ce jeu → ce chemin ne tient que par la fixture PGlite.

### 3.2 Chemin `?statut=…` — cible NON tenable, et pourquoi

`predicatStatut()` filtre **avant** la pagination : impossible de le borner à la page. Forme
retenue : remplacer le prédicat sur l'agrégat joint par des **prédicats corrélés** sur
`transaction_categorizations` (index `txn_categorizations_workspace_txn_idx`) —

- `NON_CATEGORISE` → `not exists (…)` (anti-jointure) — **16,5 ms**
- `COMPLET` → `(select coalesce(sum(z.amount),0) …) >= abs(tc.amount)` — **16,4 ms**
- `PARTIEL` → `exists (…) and (select coalesce(sum …)) < abs(tc.amount)` — **21,8 ms**

`O(N × log M)` au lieu de `O(N × M)`, et **non réordonnable**. Mais **< 10 ms est hors
d'atteinte sur ce chemin**, pour une raison qui n'est pas l'agrégat :

> **Plancher structurel mesuré à 5,1 ms.** Même *sans aucune jointure ni agrégat*, la seule
> résolution de page fait `Seq Scan` sur la partition 2026 + top-N heapsort des 9 440 lignes.
> L'index couvrant `(workspace_id, transaction_date DESC NULLS LAST)` **existe et n'est jamais
> emprunté** : l'opacité RLS fait estimer `rows=5`, donc tout plan paraît gratuit au
> planificateur. Le chemin statut ajoute ~9 440 sondes d'index à ce plancher.

Gain réel du chemin statut : **1970 ms → ~16-22 ms (≈ 100×)**. Honnête, mais à consigner
comme tel plutôt qu'à maquiller en « < 10 ms ».

### 3.3 Cohérence liste ↔ somme nette

`predicatStatut` reste un **fragment partagé** : réécrit une fois, il corrige
`sommeNetteParDevise` (`:403-460`) au même moment et garantit que le total continue de porter
exactement sur les lignes listées. `aggregatVentilation()` disparaît de la liste au profit du
LATERAL ; `sommeNetteParDevise` n'a **pas besoin** de ses colonnes (elle ne projette que des
sommes par devise) — le `.leftJoin(aggregatVentilation(), …)` de `:454` n'y sert qu'au filtre
de statut et devient inutile une fois le prédicat corrélé. À supprimer **avec** son
commentaire justificatif, pas à laisser pendre.

## 4. Invariants préservés (contrôle explicite)

- **Isolation** : tout reste dans `withWorkspace` ; aucun `workspace_id` applicatif ajouté ;
  la RLS continue de s'appliquer à `transaction_categorizations` (policy `account_scope`
  RESTRICTIVE, `EXISTS` corrélé vers `transactions_cache`) **à l'intérieur** du LATERAL.
- **ENTITY-READ-JOIN1** : `.innerJoin(bankAccounts, …)` (`:328`) conservé dans la CTE `page`.
- **Clé composite** `(txn_id, txn_date)` : portée par la corrélation LATERAL.
- **Piège rowMode "array"** : le LATERAL expose des colonnes **nommées** — pas de
  sous-requête scalaire de tête. Drizzle 0.45.2 expose `leftJoinLateral` nativement
  (`node_modules/drizzle-orm/pg-core/query-builders/select.d.ts`), donc la réserve du brief
  (« LATERAL écarté : Drizzle préfixe un left join redondant ») **ne s'applique plus** : elle
  visait `.leftJoin()` avec fragment brut.
- **Catégorie dominante** : `array_agg(… order by amount desc, name, id)` inchangé.
- **Règle 8** : aucun float ; `numeric`/chaîne décimale de bout en bout.
- **Contrat de sortie identique** : mêmes lignes, même ordre, mêmes valeurs, même curseur.

## 5. Critères de sortie (règle 3)

- [ ] `EXPLAIN (ANALYZE, BUFFERS)` avant/après collés dans la PR, sous `tygr_app` + GUC.
- [ ] Tests : sans filtre ; `?statut=` × 3 ; transaction sans split (NULL → COALESCE →
      `NON_CATEGORISE`) ; **frontière keyset page 2** (zéro doublon / zéro trou) ; splits
      multiples (dominante correcte) ; **comparaison ancienne ↔ nouvelle sortie sur le même
      jeu, égalité stricte**.
- [ ] `tests/isolation/` vert + cas Vision Entité (l'agrégat borné ne doit pas fuiter hors
      périmètre : vérifier que le LATERAL reste soumis à `account_scope`).
- [ ] Erreurs nommées, logs structurés (`workspace_id`), aucun catch-all.
- [ ] `npm run lint`, `tsc --noEmit`, build verts.
- [ ] **Entrée `PERF-VENTILATION-AGG1` CRÉÉE dans `TODOS.md`** (§0) avec les chiffres réels.

## 6. Hors périmètre (règle 7)

- Dénormalisation `cat_dominante_id`/`nb_splits`/`montant_ventile` (levier b).
- Nouvel index (levier c) : `txn_categorizations_workspace_txn_idx` existe et suffit — **confirmé**.
- **Nouvelle dette à consigner** : le plancher de 5,1 ms (index couvrant ignoré pour cause
  d'opacité RLS) est un chantier distinct — il concerne la résolution de page, pas la
  ventilation. Candidat : `PERF-KEYSET-INDEX-RLS1`.
