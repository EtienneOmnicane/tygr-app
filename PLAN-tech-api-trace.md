# PLAN — [P1] [TECH-API-TRACE] Capture des métadonnées de classification

> Phase **conception** (CLAUDE.md règle 1). Ticket : `TODOS.md:1224`. Effort S,
> gardien **Backend** (zéro surface Front). Branche : `feat/tech-api-trace-classification`
> (depuis `origin/main` à jour). Prolongement direct de PR #101 (Enrichment imbriqué)
> et PR #107 (`is_auto_categorized`).

## 1. Problème (le fait, prouvé)

Le bloc `Enrichment{}` du payload Omni-FI (`server/omnifi/types.ts:94`) porte **6
champs**. L'ingestion en mappe **3** (`CleanMerchantName`/`PrimaryCategory`/`SubCategory`,
`orchestrateur.ts:115-122`) et **jette** les 3 autres :
- `ConfidenceLevel` — fiabilité de l'auto-catégo amont (défaut serializer = `"Low"`).
- `ClassificationSource` — source amont (`USER_RULE>SYSTEM_RULE>ML`, cf. doc API).
- `RuleIdMatch` — id de la règle amont qui a matché (le cas échéant).

Aucune colonne ne les reçoit (`transactions_cache`, `schema.ts:382-394`). Donnée reçue,
perdue — même pathologie que le bug Enrichment imbriqué (PR #101).

**Valeur** : distinguer une auto-catégo fiable d'une douteuse + tracer la source amont.
Pré-requis bloquant de `GAP-CATEG-NATIVE1` (P2) : sans ces colonnes peuplées, pas de
score à exploiter pour la file de revue / la chaîne de priorité.

## 2. Périmètre (et hors-périmètre STRICT)

**DANS** (Back uniquement, 3 étapes du ticket) :
1. Migration **expand-only** : +3 colonnes varchar nullable sur `transactions_cache`.
2. Étendre `TransactionAUpserter` (`repositories/ingestion.ts:43`) + l'INSERT **et** le
   SET du `onConflictDoUpdate` de `upsertTransactions`.
3. Mapper les 3 champs dans `versLignePersistee` (`orchestrateur.ts:92`) via `chaineOuNull`.

**HORS** (ne PAS faire ici — relève de `GAP-CATEG-NATIVE1` P2) :
- Aucune exposition lecture / UI (pas de SELECT de ces colonnes côté Front, pas de DTO).
- Aucune chaîne de priorité, aucun seuil de bascule en file de revue, aucun arbitrage.
- Aucun backfill **obligatoire** (cf. §6 — décision à acter).

## 3. Décisions de conception

### 3.1 `ClassificationSource` fait-il doublon avec `category_source` (déjà là) ? — NON
`category_source` (PR #107, borné `'OMNIFI'`) répond à « **quel système TYGR** a posé la
catégorie » (ici : l'ingestion Omni-FI). `classification_source` répond à « **quelle
sous-source AMONT** chez Omni-FI » (`USER_RULE`/`SYSTEM_RULE`/`ML`). Granularités
différentes, non redondantes. On NE touche pas `category_source`. On NE borne PAS
`classification_source` par un CHECK de liste fermée : les valeurs amont ne sont pas sous
notre contrôle et la doc ne fige pas l'énumération — un CHECK trop strict ferait échouer
une ingestion sur une valeur amont nouvelle (fail-closed inapproprié pour de la donnée
descriptive). On stocke la chaîne normalisée telle quelle (varchar nullable).

### 3.2 `ConfidenceLevel` : ne pas confondre défaut serializer et vraie mesure
Le serializer amont pose `ConfidenceLevel → "Low"` PAR DÉFAUT quand il n'a rien
(`types.ts:88-89`), comme il pose `PrimaryCategory → "Uncategorized"`. **Mais** : ici on
se contente de **tracer** la valeur reçue (pas de décision dérivée dans ce ticket). On
persiste donc `chaineOuNull(e?.ConfidenceLevel)` SANS la nullifier sur `"Low"` :
neutraliser `"Low"` serait une **décision d'exploitation** (seuil), qui appartient à
`GAP-CATEG-NATIVE1`. Distinction tracée pour ne pas reproduire le sur-filtrage. On garde
juste `chaineOuNull` (un `""` amont → NULL, comme les autres champs — jamais `""` brut).

### 3.3 Cohérence avec `is_auto_categorized` ?
Les 3 champs ne sont signifiants que si une catégo auto existe. MAIS on NE conditionne PAS
leur persistance à `categorieValide` : `ConfidenceLevel`/`ClassificationSource` peuvent
décrire une classification amont qui a abouti à "Uncategorized" (info utile pour la file
de revue future). On persiste donc la valeur normalisée **indépendamment** du marqueur,
et on NE pose **aucun CHECK de cohérence** entre ces colonnes et `is_auto_categorized`
(au contraire de la paire source/marqueur, elle structurellement liée). Justification
écrite ici pour la revue (règle 6).

### 3.4 Type de colonne
`varchar(120)` nullable, comme `primary_category`/`sub_category` (`schema.ts:383-384`).
`RuleIdMatch` : un id ; 120 couvre large. Pas de FK (la règle vit chez Omni-FI, pas chez
nous). Aligné sur le pattern existant, pas de `text` (réservé au libellé brut PII).

## 4. Modifications fichier par fichier

### 4.1 `src/server/db/schema.ts` (≈ +3 lignes dans `transactionsCache`)
Après `subCategory` (ligne 384), 3 colonnes :
```ts
confidenceLevel: varchar("confidence_level", { length: 120 }),
classificationSource: varchar("classification_source", { length: 120 }),
ruleIdMatch: varchar("rule_id_match", { length: 120 }),
```
**Aucun CHECK** ajouté (cf. §3.1/§3.3 — données descriptives amont non bornées).

### 4.2 `drizzle/migrations/0012_classification-metadata.sql` (NEUF, écrit À LA MAIN)
⚠️ **Dette DB-MIGRATE3** (`migration-hors-journal-drizzle`) : `0009` est ABSENT du
`_journal.json` → `drizzle-kit generate` peut re-collisionner la numérotation. On écrit
donc la migration à la main sur le **modèle exact de `0011`** (`ALTER TABLE … ADD COLUMN`
sur la table mère partitionnée se propage à toutes les partitions — UN seul ALTER chacun,
PAS de répétition par partition, PAS de RLS à répéter). Expand-only, 3 `ADD COLUMN`
nullable, aucun `DROP`, aucun CHECK. Puis ajouter l'entrée correspondante au `_journal.json`
(en suivant le format des entrées existantes ; vérifier `idx`/`tag`/`when`).
> Alternative : lancer `drizzle-kit generate` PUIS vérifier/renommer en 0012 et contrôler
> le journal. Risque de bruit (cf. dette). **Choix : écriture manuelle**, plus sûre ici.

### 4.3 `src/server/repositories/ingestion.ts`
- `TransactionAUpserter` (ligne 43) : +3 champs `… : string | null`.
- `upsertTransactions` : ajouter les 3 dans le `.values({…})` (l.176-192) ET dans le
  `set:` du `.onConflictDoUpdate` (l.195-210) — un re-sync reflète toujours l'état amont
  courant (déterministe/idempotent, comme les autres champs).

### 4.4 `src/server/ingestion/orchestrateur.ts`
Dans `versLignePersistee` (après l.122), 3 lignes via le serializer EXISTANT :
```ts
confidenceLevel: chaineOuNull(e?.ConfidenceLevel),
classificationSource: chaineOuNull(e?.ClassificationSource),
ruleIdMatch: chaineOuNull(e?.RuleIdMatch),
```

## 5. Tests (règle 3 : heureux + échec + limite)

- **Unitaire `versLignePersistee`** (fichier de test orchestrateur existant) : un
  `Enrichment` complet → les 3 champs mappés ; `""` amont → `null` (les 3) ; objet
  `Enrichment` absent → `null` (les 3, via `e?.`) ; `ConfidenceLevel:"Low"` → conservé
  `"Low"` (NON nullifié — prouve §3.2).
- **Isolation / append-only** : la migration n'ajoute que des colonnes → le trigger
  `BEFORE DELETE` et la RLS restent intacts. Vérifier que la suite
  `tombstone-delete-isolation` passe toujours (aucune régression — colonnes additives).
  Pas de nouveau cas d'isolation requis (pas de nouvelle table, pas de nouveau chemin RLS).
- **Idempotence upsert** : un 2e sync de la même transaction avec un `ConfidenceLevel`
  changé met la colonne à jour (couvre le `set:` du onConflict).

## 6. Question ouverte à acter (backfill)

`0011` a livré un `scripts/backfill-auto-categorized.mjs` pour les lignes déjà en base.
Pour TECH-API-TRACE, les lignes existantes auront `NULL` sur les 3 colonnes (correct :
on n'a pas re-stocké le payload). **Décision proposée** : PAS de backfill — ces métadonnées
n'existent que dans le payload, qu'on ne conserve pas ; un re-sync naturel les peuplera
pour les transactions encore renvoyées par l'API. Le noter en commentaire de migration
(comme `0011` note son backfill hors-migration). À confirmer avant impl.

## 7. Exit criteria

- [ ] lint + typecheck verts ; suite complète verte (hook pre-commit).
- [ ] suite `tombstone-delete-isolation` verte (non-régression append-only).
- [ ] migration expand-only (3 ADD COLUMN, 0 DROP, 0 CHECK), journal cohérent.
- [ ] tests `versLignePersistee` (mapping + `""`→null + objet absent + `"Low"` conservé).
- [ ] entrée TODOS.md cochée + mention DB-MIGRATE3 si le journal a dû être édité main.
- [ ] commit sur la branche, STOP à la PR (Human-in-the-Loop : feat/ + migration DB).
