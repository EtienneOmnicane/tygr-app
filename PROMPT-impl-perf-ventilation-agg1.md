# Prompt d'implémentation — PERF-VENTILATION-AGG1 (page /transactions)

> # ⛔ DOCUMENT PÉRIMÉ — NE PAS EXÉCUTER (annoté le 2026-07-22)
>
> Le lot est **LIVRÉ** (branche `feat/perf-ventilation-agg1`). Sources de vérité :
> `TODOS.md` § « Performance /transactions » et `PLAN-perf-ventilation-agg1.md`.
> Ce fichier est conservé pour l'audit trail, avec ses DEUX erreurs :
>
> 1. **Il renvoie à une entrée `TODOS.md` qui n'existait pas.** « Le diagnostic est
>    déjà fait et consigné … lignes ~74-142 » : aucune section « Performance
>    /transactions » n'existait, et les lignes 74-142 portaient sur « Clarté du cycle
>    de connexion ». La session de conception a produit CE prompt sans jamais écrire
>    l'entrée — ce que la règle 9 interdit. Le diagnostic technique, lui, était réel
>    (re-mesuré à ~1,85 s).
> 2. **Sa « conception imposée » pour le chemin `?statut=` est FAUSSE** — réfutée à la
>    mesure. Détail au § correspondant plus bas et dans `TODOS.md`.
>
> **Leçon de procédure** : un prompt d'implémentation n'est pas un registre. Tant que
> le diagnostic n'est pas dans `TODOS.md` (suivi par git, priorisé, revu en fin
> d'epic), il n'existe pas — et le lot suivant part sur des chiffres invérifiables.

## Objectif

La liste `/transactions` met **~1,75 s côté base** (mesuré : 1748/1759/1763 ms, base
locale 9 056 transactions / 480 splits, page 1, sans filtre, `limit 51`). Cible :
**< 10 ms** sur le même jeu, avec un plan **robuste** (indépendant du hasard du
planificateur — `enable_nestloop=off` est un diagnostic, PAS une solution livrable).

> ⛔ **Cible partiellement irréaliste.** Tenue sur le chemin dominant (**8,4 ms** livrés).
> Hors d'atteinte sur le chemin `?statut=` (**~14,4 ms**), et l'agrégat n'y est pour rien :
> la seule résolution de page, sans jointure ni agrégat, coûte déjà **5,1 ms** parce que
> l'index couvrant n'est jamais emprunté sous opacité RLS (estimateur à `rows=5`). Ce
> plancher est un foyer SÉPARÉ → dette `PERF-KEYSET-INDEX-RLS1` (P2).

## Cause racine (déjà établie — ne pas ré-instruire)

Dans `listerTransactions` (`src/server/repositories/transactions.ts`), l'agrégat de
ventilation `aggregatVentilation()` (`:550-562`) est une **table dérivée** jointe en
`.leftJoin(agg, jointureAggregat())` (`:333`). Sous RLS, tous les prédicats passent par
`current_setting('app.current_*')`, opaque à l'estimateur → il estime `rows=1` à chaque
étage (réel : 9 056), choisit un **Nested Loop Left Join**, et le `LIMIT 51` le pousse
vers un plan « fast-start » qui **recalcule l'agrégat entier à chaque ligne externe**
(`GroupAggregate … loops=9056`, ~4,23 M lignes rejetées par le Join Filter). Modèle de
coût **O(N_transactions × N_splits)** — les deux axes grossissent en prod.

Variantes mesurées (READ ONLY) déjà dans la dette :
| Variante | Temps | Plan |
|---|---|---|
| A — actuelle | 1751 ms | Nested Loop, agrégat `loops=9056` |
| B — `enable_nestloop=off` | 7,9 ms | Hash Left Join, agrégat `loops=1` |
| C — agrégat borné à la page (les 51 ids) | 6,7 ms | agrégat `loops=51`, par index |

## Conception imposée (levier (a) de la dette, robuste)

Deux chemins, selon qu'un filtre de statut est actif — c'est exactement ce que décrit la
dette (« le chemin sans filtre se borne trivialement ; le chemin `?statut=` demande un
agrégat global avec un plan sain »).

1. **Chemin dominant — SANS filtre de statut** (chargement initial) :
   la pagination ne dépend pas de l'agrégat. **Borner l'agrégat aux lignes de la page** :
   résoudre d'abord la page (keyset `:243-247` + `ORDER BY date desc, id desc` +
   `LIMIT 51`) via l'index couvrant, PUIS calculer l'agrégat uniquement pour les ≤51
   couples `(id, transaction_date)` de la page (CTE `MATERIALIZED` + LATERAL, ou
   `where tc.transaction_id in (<ids de la page>)`). → variante C (`loops=51`).

2. ~~**Chemin `?statut=…`** : `predicatStatut()` (`:471-482`) filtre sur l'agrégat, donc
   AVANT la pagination — impossible à borner à la page. Garder l'agrégat **global** mais
   forcer une **évaluation unique** via une CTE `WITH agg AS MATERIALIZED (…)` (barrière
   d'optimisation → un seul calcul, Hash Left Join, indépendant du planificateur). →
   variante B (`loops=1`).~~ NE PAS recourir à la dénormalisation (levier (b)) ici : c'est
   un chantier séparé, hors périmètre.

   ⛔ **FAUX — mesuré à 324 ms, pas 7,9 ms.** La CTE `MATERIALIZED` empêche bien le
   RECALCUL (agrégat en `loops=1`, 1,0 ms) mais **ne choisit pas la méthode de
   jointure** : le planificateur garde un Nested Loop et RESCANNE la CTE par ligne
   externe (`Rows Removed by Join Filter: 4 530 720`). Matérialisation et méthode de
   jointure ont été confondues — `enable_nestloop=off` agissait sur la seconde. Piloter
   la jointure « depuis le petit côté » ne marche pas non plus (le planificateur
   réordonne → 286 ms). **Ce qui marche** : des sous-requêtes **corrélées**, que le
   planificateur ne PEUT pas réordonner — elles s'évaluent par ligne, par index. Livré
   ainsi ; ~14,4 ms mesurés. Cf. `PLAN-perf-ventilation-agg1.md` §2 et §3.2.

Garde les **fragments partagés** (`conditionsFiltres` `:499-539`, `predicatStatut`
`:471-482`, corps de `aggregatVentilation` `:550-562`) pour que la liste et
`sommeNetteParDevise` restent strictement cohérentes. Si tu refactorises l'agrégat,
les DEUX appelants doivent continuer à consommer la MÊME définition.

## Invariants à préserver (ne rien casser)

- **Isolation** : tout reste dans la même transaction `withWorkspace` (RLS + GUC). La
  RLS s'applique à `transaction_categorizations` ET `transactions_cache` — ne l'inhibe
  jamais, n'ajoute pas de `workspace_id` en WHERE applicatif (règle 2).
- **ENTITY-READ-JOIN1** : garder `.innerJoin(bankAccounts, …)` (`:328`) — héritage de la
  policy `entity_scope` (étage 2) ET alignement du jeu de lignes. Ne pas la retirer.
- **Clé de jointure composite** `(txn_id, txn_date)` (`jointureAggregat` `:566-568`) —
  table partitionnée, la date fait partie de la clé.
- **Piège rowMode "array"** (commentaire `:256-261`) : pas de sous-requête scalaire de
  tête qui désaligne le mapping par position. Colonnes nommées de table dérivée, ou
  bascule assumée vers un `tx.execute(sql`…`)` renvoyant des objets (à valider en test).
- **Catégorie dominante** : logique d'élection `array_agg(… order by amount desc, name,
  id)` (`:557-558`) inchangée. `statutExpr` (`:275-281`) et `predicatStatut` doivent
  rester deux vues du même agrégat (COMPLET/PARTIEL/NON_CATEGORISE).
- **`sommeNetteParDevise`** (`:403-460`) : hypothèse « second point chaud » **INFIRMÉE**
  (ne pas rouvrir). Ne l'optimise pas ; assure juste qu'un changement de forme de
  `aggregatVentilation` ne la régresse pas (elle joint le même agrégat, `:454`).
- **Règle 8** : aucun float ; montants en `numeric`/chaîne décimale, du SQL à l'écran.
- **Contrat de sortie identique** : mêmes lignes, même ordre, mêmes valeurs
  `statut`/`nbSplits`/`montantVentile`/`categorieDominante*`, même curseur keyset.

## Critères de sortie (règle 3 — livrés dans la MÊME PR)

- [ ] **Preuve de perf** : `EXPLAIN (ANALYZE, BUFFERS)` avant/après sur la requête réelle,
      sous `tygr_app` avec les GUC de `withWorkspace`, Vision Globale, même jeu local
      (stack docker du README `Dev local`). Cible : agrégat en `loops=1` (chemin statut)
      ou `loops=51` (chemin dominant), temps < 10 ms. Colle les deux plans dans la PR.
- [ ] **Tests** (chemin heureux + échec spécifique + limite) : liste sans filtre ;
      liste `?statut=COMPLET|PARTIEL|NON_CATEGORISE` (le filtre porte toujours sur le bon
      agrégat) ; transaction SANS split (LEFT JOIN → NULL → COALESCE → NON_CATEGORISE) ;
      **frontière de pagination keyset** (page 2 via curseur : zéro doublon, zéro trou) ;
      transaction à splits multiples (dominante correcte). Compare l'ancienne et la
      nouvelle sortie sur le même jeu — elles doivent être identiques.
- [ ] **Isolation** : la suite `tests/isolation/` reste verte ; ajoute un cas si la forme
      de requête change le chemin d'accès (l'agrégat borné ne doit pas fuiter hors
      workspace/périmètre). Vérifie le cas Vision Entité (agrégat cohérent avec le jeu
      de lignes borné par `entity_scope`).
- [ ] **Erreurs nommées, logs structurés** (`workspace_id`), aucun catch-all muet.
- [ ] **Stop-loss** (règle 5) : `npm run lint`, `tsc --noEmit`, build verts avant commit.

## Discipline de phase (règles 1, 6, 7, Human-in-the-Loop)

1. **Plan d'abord** : ce n'est pas un correctif ≤20 lignes (ça touche un repository de
   la surface d'isolation). Écris d'abord un court plan sur disque (ex.
   `PLAN-perf-ventilation-agg1.md`) qui tranche : forme de requête retenue (CTE
   MATERIALIZED vs LATERAL vs `IN`), gestion des deux chemins, impact `sommeNette`.
   Référence la dette. PUIS implémente.
2. **Branche** `feat/perf-ventilation-agg1` créée depuis `main` à jour. WIP commits par
   unité logique (jamais `git add -A`).
3. **Cross-review** (règle 6) par un contexte FRAIS (subagent/Codex) : mandat de chercher
   les modes de défaillance (cohérence liste↔somme, fuite d'isolation via l'agrégat
   borné, régression du plan sur le chemin statut, keyset). Constat = `fichier:ligne` +
   mode de défaillance + confiance /10.
4. **Stop à la PR** : tu committes, tu pousses, tu t'ARRÊTES. C'est Etienne qui ouvre la
   PR et merge (code applicatif + surface d'isolation → Human-in-the-Loop absolu).
5. Mets à jour l'entrée **PERF-VENTILATION-AGG1** dans `TODOS.md` (cochée + note de
   résolution : forme retenue, mesure après, PR).

## Anti-scope (règle 7)

- Pas de dénormalisation `cat_dominante_id`/`nb_splits`/`montant_ventile` (levier (b)) :
  chantier séparé, seulement si (a) se révèle insuffisant à l'échelle — à re-mesurer,
  pas à supposer.
- Pas d'index nouveau : `txn_categorizations_workspace_txn_idx (workspace_id,
  transaction_id, transaction_date)` existe déjà et suffit (levier (c) = FAUX levier).
- Ne touche pas `sommeNetteParDevise` au-delà du strict nécessaire.
