# SPEC — Pilier 1 : couche Data de catégorisation manuelle (ventilation)

> Statut : **EN ATTENTE DE VALIDATION** — aucune migration/code avant feu vert.
> Branche d'exécution prévue : `feat/pilier1-categorisation-data`.
> Casquette : **Backend** (schéma + migration + Zod + RLS). UI hors périmètre.
> Source produit : brief PO 2026-06-17 + mémoire revue CEO 2026-06-17. ⚠️
> `ROADMAP.md` introuvable au moment de la rédaction → hypothèses signalées `[H]`,
> à confronter à la roadmap.

## 1. Objectif

Permettre la **catégorisation manuelle** des transactions, avec **ventilation**
(répartir le montant d'une transaction sur plusieurs catégories). Toute la logique
vit dans une **nouvelle table** ; `transactions_cache` reste **strictement
Read-Only** (intouchable, append-only — cf. trigger 0004 / #3bis).

## 2. Contraintes non négociables (du brief)

1. **`transactions_cache` Read-Only** : aucune écriture de catégorisation dans
   cette table. Les colonnes existantes `primary_category` / `sub_category` sont
   le **hint de l'amont Omni-FI** (conservées, non modifiées) ; la **vérité
   manuelle** vit dans la nouvelle table. Coexistence assumée : un consommateur
   lit la catégorie manuelle si elle existe, sinon retombe sur le hint amont.
2. **Traçabilité `source`** : distinction **`MANUAL`** vs **règle** (`RULE_ID`).
   Décision d'architecture actée → champ présent dès la migration.
3. **Ventilation** : 1 transaction → N splits. **Somme des splits ≤ |montant| de
   la transaction** (reste « non catégorisé » implicite ; catégorisation
   progressive permise). Décidé 2026-06-17.
4. **Isolation tenant** : RLS forcée par `workspace_id` (pattern `tenant_isolation`
   identique aux tables Epic 3), montants en DECIMAL (règle 8), montants jamais
   en float.

## 3. Le piège central : FK vers une table partitionnée

`transactions_cache` a une **PK composite `(id, transaction_date)`** (clé de
partition obligatoirement dans la PK). PostgreSQL n'autorise une FK que vers la
**PK entière** → la table de splits DOIT dénormaliser **`transaction_id` ET
`transaction_date`** pour poser la FK composite. Une FK sur le seul `id` est
impossible.

Conséquence : `transaction_date` est dupliquée dans la table de splits (porte la
FK). Acceptable et nécessaire ; indexée pour les jointures.

## 4. Schéma proposé — `transaction_categorizations`

Nom retenu : `transaction_categorizations` (plus explicite que `transaction_splits` ;
chaque ligne = une part de catégorisation d'une transaction).

| Colonne | Type | Notes |
|---|---|---|
| `id` | uuid PK | `defaultRandom()` |
| `workspace_id` | uuid NOT NULL | FK → workspaces ; **clé d'isolation RLS** |
| `transaction_id` | uuid NOT NULL | + `transaction_date` → FK composite vers `transactions_cache(id, transaction_date)` |
| `transaction_date` | date NOT NULL | dénormalisée pour la FK partitionnée (cf. §3) |
| `category` | varchar(120) NOT NULL | `[H]` chaîne libre au MVP (pas de table référentielle — voir §6 Q1) |
| `sub_category` | varchar(120) | optionnelle |
| `amount` | numeric(15,2) NOT NULL | montant de CETTE part ; > 0 ; même devise que la txn |
| `source` | varchar(10) NOT NULL | CHECK IN (`'MANUAL'`,`'RULE'`) |
| `rule_id` | uuid | NULL si `MANUAL` ; renseigné si `source='RULE'` (FK molle au MVP, pas de table rules encore) |
| `created_by` | uuid NOT NULL | FK → users (qui a catégorisé) ; traçabilité |
| `created_at` | timestamptz NOT NULL default now() | |
| `updated_at` | timestamptz NOT NULL default now() | |

**Contraintes :**
- `CHECK (amount > 0)` — une part ne peut être nulle ou négative (le signe
  débit/crédit vit sur la transaction, pas sur la part).
- `CHECK (source IN ('MANUAL','RULE'))`.
- `CHECK ((source = 'MANUAL' AND rule_id IS NULL) OR (source = 'RULE' AND rule_id IS NOT NULL))`
  — cohérence source/rule_id (le « double verrou » : on ne peut pas avoir une
  part MANUAL avec un rule_id, ni une part RULE sans rule_id).
- FK composite `(transaction_id, transaction_date)` → `transactions_cache(id, transaction_date)`,
  `ON DELETE CASCADE` **interdit** ici (transactions_cache n'est jamais supprimée
  → cascade jamais déclenchée ; mais `ON DELETE NO ACTION` par cohérence, et de
  toute façon le trigger 0004 empêche tout DELETE de txn).
- **La contrainte « somme ≤ |montant| » N'est PAS un CHECK SQL** (un CHECK ne peut
  pas agréger sur d'autres lignes). Elle est appliquée **applicativement dans une
  transaction SQL** (lecture du total existant + montant txn + verrou), avec un
  test d'intégrité. Documenté comme invariant repository, couvert par test.

**Index :**
- `(workspace_id, transaction_id, transaction_date)` — récupérer les splits d'une txn.
- `(workspace_id, category)` — agrégats par catégorie (futurs dashboards).

**RLS :** `ENABLE` + `FORCE ROW LEVEL SECURITY` + policy `tenant_isolation`
(USING+WITH CHECK sur `workspace_id`, pattern nullif fail-closed identique aux
autres tables tenant). Table **NON partitionnée** (volume modéré : quelques
splits par txn) → pas le piège partition de RLS.

**DELETE :** cette table N'est PAS append-only — une correction de catégorisation
manuelle peut supprimer/remplacer un split. Donc `tygr_app` GARDE DELETE dessus
(à ajouter à la **liste blanche** de `tygr_app.sql` — cf. #3bis, étape qui touche
le provisioning). À NE PAS confondre avec `transactions_cache` qui reste interdite.

## 5. Surface applicative (Backend uniquement)

- **Repository scopé** `src/server/repositories/categorisation.ts` :
  `listerSplitsDeTransaction(tx, txnId, txnDate)`, `ajouterSplit(...)`,
  `supprimerSplit(...)`, `remplacerSplits(...)` — tous via `withWorkspace`.
- **Schéma Zod** co-localisé (convention du projet) : validation stricte
  (montant décimal borné, category longueur max, source enum, cohérence
  source/rule_id). Pas de Server Action UI dans ce lot (Backend pur) — juste le
  contrat de données + repository, prêts pour l'UI.
- **Invariant montant** appliqué dans le repository (transaction SQL avec
  `SELECT … FOR UPDATE` sur les splits de la txn pour éviter la course
  read-decide-write : deux ajouts concurrents ne doivent pas dépasser ensemble
  le montant).

## 6. Décisions actées (PO, 2026-06-17)

- **Q1 → table référentielle `categories`.** +1 table par workspace
  (Nature/Sous-nature structurées), FK depuis les splits. Aligne sur FEAT-8.1 et
  prépare les règles RULE_ID. (Voir §8 pour le schéma `categories`.)
- **Q2 → audit append-only DÈS MAINTENANT.** +1 table `categorization_audit`
  append-only (immuable), avec trigger `BEFORE DELETE`/`BEFORE UPDATE` no-op
  (interdit), RLS forcée — modèle #3bis. Chaque catégorisation/correction écrit
  un événement. (Voir §9.)
- **Q3 → tous les membres (dont VIEWER) peuvent catégoriser.** ⚠️ **DÉROGATION
  ASSUMÉE** au modèle de rôles (VIEWER = lecture seule partout ailleurs). Pushback
  sécurité émis par l'agent (un compte read-only altère les agrégats financiers ;
  incohérence de modèle qu'un audit relèverait) — **arbitrage PO maintenu** :
  catégorisation = action collaborative ouverte. Implémentation : la policy RLS
  `tenant_isolation` (WITH CHECK sur `workspace_id`) suffit — AUCUN filtre de rôle
  sur l'écriture. À re-questionner si un rôle `CATEGORIZER` dédié émerge.

## 7. Périmètre final : 3 tables (un seul lot)

1. `categories` — référentiel par workspace.
2. `transaction_categorizations` — les splits (cœur ventilation).
3. `categorization_audit` — journal append-only immuable des changements.

Réconciliation **1:1 ET 1:N** (mémoire roadmap) : le modèle N-splits couvre les
deux (un seul split = cas 1:1 ; plusieurs = 1:N).

## 8. Table `categories`

| Colonne | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL | FK workspaces ; clé RLS |
| `name` | varchar(120) NOT NULL | Nature |
| `parent_id` | uuid | NULL = catégorie racine ; sinon FK → categories.id (même workspace) → Sous-nature |
| `is_active` | boolean NOT NULL default true | désactivation sans suppression |
| `created_at` | timestamptz default now() | |

- `UNIQUE (workspace_id, name, parent_id)` — pas de doublon de nom au même niveau.
- RLS `tenant_isolation` + FORCE. DELETE autorisé (référentiel éditable) → liste
  blanche `tygr_app.sql`. Hiérarchie 2 niveaux (Nature/Sous-nature) via `parent_id`.

## 9. Table `categorization_audit` (append-only, modèle #3bis)

| Colonne | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL | FK ; clé RLS |
| `transaction_id` + `transaction_date` | uuid + date NOT NULL | la txn concernée (pas de FK dure : append-only, on garde la trace même si…) |
| `action` | varchar(16) NOT NULL | CHECK IN (`CREATE`,`UPDATE`,`DELETE`) — l'opération sur un split |
| `category` | varchar(120) | snapshot lisible |
| `amount` | numeric(15,2) | snapshot du montant de la part |
| `source` | varchar(10) | MANUAL/RULE au moment de l'action |
| `actor_id` | uuid NOT NULL | FK users — qui a agi |
| `occurred_at` | timestamptz NOT NULL default now() | |

- **Append-only STRICT** : ni UPDATE ni DELETE (comme `audit_events`/`consent_records`).
  Migration pose trigger `BEFORE UPDATE OR DELETE` qui lève (réutilise le motif
  `tygr_refuser_delete_append_only`, étendu à UPDATE). `tygr_app` n'a NI DELETE NI
  UPDATE dessus (liste blanche : INSERT/SELECT seulement sur cette table).
- RLS `tenant_isolation` + FORCE.

## 10. Questions résiduelles (non bloquantes — défauts raisonnables retenus)

- `categories` seedées par workspace : aucun seed au MVP (le workspace crée ses
  catégories). `[H]` — à confirmer si un jeu par défaut est voulu.
- `updated_at` sur `transaction_categorizations` : pas de chemin d'UPDATE au MVP
  (correction = delete + ré-ajout). Conservé pour l'édition in-place future
  (UI). Vaut `created_at` tant qu'aucun UPDATE n'existe (MINEUR cross-review,
  assumé).

## 11. Correctifs cross-review (Sécurité + QA, 2026-06-17)

Cross-review contradictoire (contexte frais). 1 BLOQUANT + 1 MAJEUR **corrigés**,
2 MINEURS traités :

- **BLOQUANT (race ventilation) — CORRIGÉ (en 2 temps).** `ajouterSplit` posait
  un `SELECT … FOR UPDATE` sur les SPLITS : sur une transaction sans split (1er
  ajout, ou après suppression totale), l'ensemble est vide → AUCUN verrou →
  deux ajouts concurrents pouvaient lire `SUM=0` et dépasser ensemble |montant|
  (prouvé par l'auditeur, aucun CHECK agrégat en filet). 1re tentative de
  correctif (`FOR SHARE` sur la ligne `transactions_cache`) **insuffisante** : la
  2e cross-review l'a réfutée — dans la matrice des row-level locks PostgreSQL,
  `FOR SHARE` NE conflit PAS avec lui-même → deux ajouts concurrents prenaient
  tous deux le verrou partagé sans s'attendre, race non corrigée. Correctif
  RETENU : **`FOR UPDATE`** sur la ligne `transactions_cache` (objet STABLE, qui
  existe toujours) — `FOR UPDATE` conflit avec lui-même → le 2e ajout attend le
  commit du 1er puis relit la somme à jour et rejette. `FOR UPDATE` n'ÉCRIT PAS
  la ligne → `transactions_cache` reste READ-ONLY.
  Limite de test : PGlite est mono-backend → la course n'est PAS reproductible en
  CI (validé par l'auditeur) ; le correctif repose sur la sémantique de verrou
  PostgreSQL (déterministe), à éprouver en intégration multi-backend (même
  classe que les races CSO).
- **MAJEUR (FK category cross-workspace) — CORRIGÉ.** `category_id` (et
  `parent_id`) étaient des FK SIMPLES vers `categories.id` → on pouvait
  référencer une catégorie d'un AUTRE workspace (référence cross-tenant ;
  l'audit mettait `categoryName=NULL`, pas d'exfiltration, mais incohérence
  d'isolation). Correctif : UNIQUE `(id, workspace_id)` sur `categories` + FK
  COMPOSITES `(category_id, workspace_id)` et `(parent_id, workspace_id)` →
  garantie EN BASE qu'une catégorie référencée appartient au même workspace.
  Test d'isolation ajouté (CAT d'un autre workspace → rejeté).
- **MINEURS** : ordre des `when` du `_journal.json` corrigé (0005 > 0004) ;
  `updated_at` documenté ci-dessus.

## 7. Plan d'exécution (après validation)

1. `schema.ts` : table `transactionCategorizations` (+ types, CHECKs, policy).
2. Migration `0005_*.sql` : CREATE TABLE + ENABLE/FORCE RLS + policy + index
   (DDL custom comme 0003/0004 ; FK composite vers la table partitionnée).
3. `tygr_app.sql` : ajouter `transaction_categorizations` à la liste blanche
   DELETE (table non append-only) — touche le provisioning, cross-review sécurité.
4. Repository scopé + schéma Zod + invariant montant + tests (heureux / échec /
   limite concurrence) + **cas isolation IDOR ajouté à la suite bloquante**.
5. Quality Gates : lint/typecheck/tests/IDOR ; cross-review Sécurité + QA
   (contexte frais) ; STOP à la PR poussée.

## 12. Server Actions (surface d'appel UI, 2026-06-17)

Branche `feat/pilier1-categorisation-actions`. 5 Server Actions
(`src/app/(workspace)/transactions/actions.ts`, `"use server"`) honorant le
contrat UI `src/components/ui/category/types.ts` :
- `remplacerSplitsAction(ref, splits)` — remplace ATOMIQUEMENT l'état complet
  (DELETE+INSERT dans la transaction `withWorkspace` = tout-ou-rien), somme ≤
  |montant| revérifiée serveur sous `FOR UPDATE`. Liste vide = tout
  dé-catégoriser. Splits toujours MANUAL.
- `listerCategoriesAction()` / `creerCategorieAction` / `renommerCategorieAction`
  / `archiverCategorieAction` (is_active=false, jamais de DELETE).

Toutes : `exigerSessionWorkspace` + `withWorkspace`, Zod strict (`src/lib/
categorisation-schema.ts` — déplacé hors `repositories/` pour être importable par
`app/`), retour `ResultatAction` non-énumérant (erreurs nommées mappées en
code+message, jamais de détail technique/PII au client).

**Gating** : catégorisation ET CRUD référentiel ouverts à TOUS les membres
(VIEWER inclus) — décision PO, cohérente splits/référentiel. La RLS `WITH CHECK`
+ FK composites bornent toute écriture au tenant courant, indépendamment du rôle.

Cross-review Sécurité+QA (contexte frais) : **feu vert, aucun BLOQUANT/MAJEUR**.
Atomicité prouvée empiriquement y compris l'échec POST-DELETE (FK invalide sur un
INSERT du milieu → rollback complet, état d'avant intact) — cas ajouté à la suite.
2 MINEURS non bloquants : (1) la sérialisation `FOR UPDATE` n'est pas couvrable
en CI (PGlite mono-backend) — dette de test concurrentiel à éprouver en
intégration multi-backend ; (2) `listerCategoriesAction` ne normalise pas en
`ResultatAction` (lecture RSC : l'exception remonte à l'error boundary) — à garder
en tête au câblage du picker. Tests : 265 au total. lint/typecheck/build OK.
