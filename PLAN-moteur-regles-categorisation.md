# PLAN — Moteur de règles de catégorisation (FYGR-style)

> Phase : **conception** (règle 1). Implémentation séparée référencera ce fichier.
> Décisions PO (2026-06-22, AskUserQuestion) :
> - **Match** : `clean_label` prioritaire, fallback `bank_label_raw` (serveur, jamais loggé).
> - **Portée** : une règle crée un split à **100% du montant**, **uniquement** si la
>   transaction n'a **aucun split** (MANUAL prime, jamais écrasé).
> - **PR isolée** (PR #2), après le fix workspace (PR #1).

## 0. Ce qui existe DÉJÀ (ne pas recréer)

- **Catégories manuelles : COMPLET.** Repo `categorisation.ts` (`creerCategorie`,
  `renommerCategorie`, `archiverCategorie`, `listerCategories`) + Server Actions
  (`creerCategorieAction`, etc.) + schémas Zod (`categorisation-schema.ts`). La
  mission « créer/modifier/supprimer des catégories à la main » est livrée.
- **Le modèle a anticipé les règles** : `transaction_categorizations.ruleId` (uuid,
  NULL si MANUAL) + `source ∈ {MANUAL, RULE}` + CHECK de cohérence
  `(MANUAL ⟺ ruleId NULL) ET (RULE ⟺ ruleId NOT NULL)` (schema.ts:536). Un split
  `RULE` DOIT donc porter un `ruleId` réel → la FK `categorization_rules` est requise.
- `ajouterSplit` accepte déjà `source` + `ruleId` (categorisation.ts:38-45) — mais
  applique l'invariant « somme ≤ |montant| » ligne par ligne. Le service de règles
  pose UN split à 100% sur une transaction VIDE → invariant trivialement respecté.

## 1. Modèle de données — table `categorization_rules`

### 1.1. Colonnes (schema.ts, après `categorizationAudit`)

```
categorization_rules
  id            uuid PK default gen_random_uuid()
  workspace_id  uuid NOT NULL → workspaces.id           (tenant)
  pattern       varchar(255) NOT NULL                    (texte à chercher)
  match_type    varchar(16) NOT NULL                     (CHECK IN ('contains','starts_with'))
  category_id   uuid NOT NULL                            (cible)
  is_active     boolean NOT NULL default true            (désactivation sans perte)
  priority      integer NOT NULL default 0               (ordre d'éval ; petit = prioritaire)
  created_by    uuid NOT NULL → users.id
  created_at    timestamptz NOT NULL default now()
```

Contraintes / index :
- **FK COMPOSITE scopée workspace** vers `categories(id, workspace_id)` (pattern
  obligatoire CLAUDE.md) : `foreignKey([categoryId, workspaceId] →
  [categories.id, categories.workspaceId])`. Une `category_id` d'un autre tenant
  devient impossible. ON DELETE : par défaut `no action`/RESTRICT — on n'efface pas
  une catégorie référencée (cohérent avec l'archivage logique des catégories).
- CHECK `match_type IN ('contains','starts_with')`.
- CHECK `length(trim(pattern)) > 0` (pas de pattern vide qui matcherait tout).
- `unique(workspace_id, pattern, match_type, category_id)` : pas de règle en double.
- `index(workspace_id, is_active, priority)` : couvre la lecture ordonnée des
  règles actives à l'application.
- `pgPolicy("tenant_isolation", POLITIQUE_TENANT)` + `.enableRLS()`.

### 1.2. Migration Drizzle (0010)

- `npm run db:generate` → génère `0010_*.sql` (CREATE TABLE + ENABLE RLS + FK +
  index + policy PERMISSIVE tenant_isolation, comme 0008).
- **Complément MANUEL** (drizzle-kit n'émet pas FORCE RLS) à ajouter au .sql, en
  calquant 0008 : `ALTER TABLE "categorization_rules" FORCE ROW LEVEL SECURITY;`.
- Pas de policy `entity_scope` ici : une règle est une config de workspace, pas un
  objet scopé par entité (cohérent avec `categories`).
- **Backward-compat N-1 (règle 9)** : table NOUVELLE, additive, expand-safe. Aucun
  code N-1 ne la lit. La colonne `transaction_categorizations.rule_id` existe déjà.

### 1.3. Provisioning — liste blanche DELETE

`categorization_rules` est **éditable** (config utilisateur, comme `categories` et
`member_entity_scopes`), **NON append-only**. → l'AJOUTER à la liste blanche DELETE
de `drizzle/provisioning/tygr_app.sql` (étape 5, array). Mettre à jour le commentaire
de la liste. **NE PAS** toucher l'append-only. Le test d'idempotence du provisioning
doit rester vert.

> ⚠️ Gouvernance (règle 9) : cette table NE touche NI l'isolation tenant (elle a sa
> RLS standard), NI l'append-only, NI les montants → pas une dette interdite, mais
> elle suit les mêmes invariants (RLS forcée, FK composite scopée).

## 2. Repository — `src/server/repositories/regles-categorisation.ts`

Toutes les fonctions s'exécutent DANS `withWorkspace(session, fn)` (tx scopé).
Montants : aucun ici (la règle ne porte pas de montant ; le split à 100% lit le
montant de la transaction). Erreurs nommées (registre S2).

### 2.1. Types & erreurs

```ts
export interface RegleLue { id; pattern; matchType; categoryId; isActive; priority }
export interface RegleACreer { pattern; matchType: 'contains'|'starts_with'; categoryId; priority? }
export class RegleIntrouvableError extends Error { code = "RULE_NOT_FOUND" }
```
(Réutiliser `CategorieIntrouvableError` de `categorisation.ts` si la FK échoue —
ou laisser la FK lever et mapper en INVALID_PARAMS côté action.)

### 2.2. CRUD (scopé RLS, jamais de DELETE physique applicatif au MVP → archivage)

- `listerRegles(tx, ctx)` : règles du workspace (actives + archivées pour l'écran
  d'admin ; un flag `actives` optionnel filtre). `where workspace_id = ctx` (RLS +
  défense en profondeur) `order by priority asc, created_at asc`.
- `creerRegle(tx, ctx, input)` : INSERT (WITH CHECK RLS + FK composite garantissent
  workspace & catégorie cohérents). Retourne `{ ruleId }`.
- `modifierRegle(tx, ctx, { ruleId, pattern?, matchType?, categoryId?, priority?, isActive? })` :
  UPDATE scopé `where id = ruleId AND workspace_id = ctx` ; 0 ligne →
  `RegleIntrouvableError`.
- `archiverRegle(tx, ctx, ruleId)` : `is_active=false` (idempotent ; cohérent avec
  `archiverCategorie`). On préfère l'archivage à la suppression pour tracer quelles
  règles ont produit des splits (les splits RULE portent `rule_id`). **Le DELETE
  physique est autorisé au provisioning** (table éditable) mais l'app archive.
  > Décision : exposer `archiverRegle` (logique). Un vrai DELETE physique pourra
  > être ajouté plus tard si besoin produit ; pas au MVP (anti-scope-creep).

### 2.3. Service d'application — `appliquerRegles`

**Cœur de la mission.** Signature :
```ts
appliquerRegles(tx, ctx, opts?: { bankAccountId?: string }):
  Promise<{ transactionsCategorisees: number; splitsCrees: number }>
```
Logique (tout dans la transaction `withWorkspace`) :

1. Charger les règles **actives** du workspace, triées `priority asc, created_at asc`.
   Si aucune → retour `{0,0}` (no-op).
2. Sélectionner les transactions **candidates** : `transactions_cache` du workspace
   (RLS), `is_removed = false`, **SANS aucun split** (anti-LEFT-JOIN :
   `WHERE NOT EXISTS (SELECT 1 FROM transaction_categorizations tc WHERE
   tc.transaction_id = t.id AND tc.transaction_date = t.transaction_date)`).
   Filtre optionnel `bank_account_id = opts.bankAccountId` (pour l'appel post-sync
   ciblé). **Borne** : on traite par lots (ex. LIMIT raisonnable + boucle) pour ne
   pas charger un volume non borné en mémoire — au MVP les volumes sont faibles,
   mais on borne (filet anti-explosion, règle 7).
3. ⚠️ **ISOLATION ENTITÉ (ENTITY-READ-JOIN1)** : `transactions_cache` n'hérite du
   scope entité QUE par jointure sur `bank_accounts`. Le service écrit (crée des
   splits) — il DOIT tourner en **Vision Globale** (ingestion = GUC entité vide,
   cf. `upsertCompte`). On documente cet invariant : `appliquerRegles` est appelé
   par l'ingestion (Vision Globale) ou par un déclenchement ADMIN. **On joint
   `bank_accounts`** dans la sélection des candidates (même en Vision Globale,
   neutre) pour cohérence avec la règle « jamais de lecture des filles sans joindre
   bank_accounts ». Cela évite aussi de catégoriser un compte hors scope si un jour
   le service tourne sous un scope.
4. Pour chaque transaction candidate, dans l'ordre, trouver la **PREMIÈRE règle qui
   matche** :
   - Texte de match = `coalesce(nullif(trim(clean_label), ''), bank_label_raw)`
     (clean_label prioritaire, fallback brut). Match **insensible à la casse**.
   - `contains` → `texte ILIKE '%' || pattern || '%'` ; `starts_with` →
     `texte ILIKE pattern || '%'`. **Pattern PARAMÉTRÉ** (anti-injection ; échapper
     `%`/`_` du pattern via `ESCAPE` ou `like_escape` — un `%` dans un pattern
     utilisateur ne doit pas devenir un joker). Cf. §5 sécurité.
   - Si aucune règle ne matche → transaction laissée non catégorisée (skip).
5. Créer **un split à 100%** : `amount = abs(transaction.amount)`, `source='RULE'`,
   `rule_id = <règle>`, `created_by = ctx.userId`. Respecte le CHECK de cohérence.
   - Réutiliser une écriture cohérente avec `ajouterSplit` (verrou FOR UPDATE sur la
     ligne transactions_cache → sérialise vs une éventuelle catégorisation manuelle
     concurrente ; si un split MANUAL est apparu entre la sélection et l'écriture,
     l'invariant `NOT EXISTS` est re-vérifié sous verrou et on **skip** — anti-course,
     MANUAL prime). **Re-vérifier `NOT EXISTS` sous le verrou** avant d'insérer.
6. Écrire l'**audit** (`categorization_audit`, action `CREATE`, source `RULE`) — la
   table est append-only, déjà gérée par `ecrireAudit`. Réutiliser/extraire la
   fonction (ou dupliquer proprement — `ecrireAudit` est privée à `categorisation.ts` ;
   l'**exporter** ou la déplacer dans un module partagé). Décision : **exporter
   `ecrireAudit`** depuis `categorisation.ts` (changement minimal, source unique).

> **Concurrence (règle 3)** : deux exécutions concurrentes de `appliquerRegles`
> (ex. deux syncs) pourraient viser la même transaction. Le verrou FOR UPDATE sur la
> ligne `transactions_cache` + la re-vérification `NOT EXISTS` sous verrou
> sérialisent : la 2e voit le split de la 1re et skip. Pas de double catégorisation.
> ⚠️ PGlite (mono-backend) ne prouve pas la race — invariant validé par la sémantique
> PostgreSQL (même statut que `ajouterSplit`, cf. categorisation.ts:139).

## 3. Server Actions — `src/app/(workspace)/regles/actions.ts`

`"use server"`. Même squelette que `transactions/actions.ts` :
`exigerSessionWorkspace` → `withWorkspace` → repo. Retour `ResultatAction<T>`
normalisé (jamais d'exception au client). Schémas Zod stricts dans
`src/lib/regles-schema.ts`.

### 3.1. Gating de rôle — À TRANCHER mais défaut posé

Le CRUD de **catégories** est ouvert à tous les membres (décision PO 2026-06-17,
cf. transactions/actions.ts:16). Par cohérence, le CRUD de **règles** suit la même
règle : **ouvert aux membres** (la RLS WITH CHECK workspace suffit). **MAIS**
`appliquerRegles` écrit des splits en masse → on le réserve à **MANAGER/ADMIN**
(comme l'ingestion/synchro `peutModifier`). À confirmer ; défaut retenu :
- `listerReglesAction`, `creerRegleAction`, `modifierRegleAction`,
  `archiverRegleAction` : membres (cohérent avec catégories).
- `appliquerReglesAction` (déclenchement manuel « Ré-analyser ») : `peutModifier`
  (MANAGER/ADMIN) — réutiliser la garde de rôle existante.

> Vérifier le helper de rôle existant (`peutModifier`) avant de coder ; ne pas en
> inventer un nouveau.

### 3.2. Actions

- `listerReglesAction(): Promise<RegleDTO[]>` (tableau direct, comme
  `listerCategoriesAction`).
- `creerRegleAction(input): ResultatAction<{ ruleId }>`.
- `modifierRegleAction(input): ResultatAction`.
- `archiverRegleAction(ruleId): ResultatAction`.
- `appliquerReglesAction(opts?): ResultatAction<{ transactionsCategorisees, splitsCrees }>`
  (garde `peutModifier`).

## 4. Branchement à l'ingestion (application auto)

Décision PO : appliquer auto **aux transactions sans catégorie**. Point d'ancrage :
après l'ingestion des transactions d'un compte. Deux endroits possibles :
- `orchestrateur.ts::synchroniserCompte` (après la boucle de pages, avant/après
  `marquerSynchronise`).
- l'orchestrateur de synchro global (`synchroniserConnexionsDepuisOmnifi`, cité
  TODOS) qui boucle sur les comptes.

**Décision** : appeler `appliquerRegles(tx, ctx, { bankAccountId })` **une fois par
compte** à la fin de `synchroniserCompte`, dans une transaction `executer`. Ainsi
chaque nouvelle transaction ingérée est catégorisée si une règle matche, sans
toucher les transactions déjà catégorisées. **Idempotent** (le `NOT EXISTS` skip les
déjà-catégorisées). **Coût** : borné au compte synchronisé.

> ⚠️ Le service tourne en **Vision Globale** (ingestion, GUC entité vide) — invariant
> à respecter (cf. §2.3.3). Vérifier que `synchroniserCompte`/son `executer` n'impose
> pas de scope entité. Si l'ingestion est déjà gardée `peutModifier` + Vision Globale
> (cf. ENTITY-WRITE-SCOPE1 « l'ingestion tourne en Vision Globale »), aucun risque.

## 5. Exit criteria & sécurité (règles 3 + 8)

- [ ] **Authz** : toutes les actions via `exigerSessionWorkspace` + `withWorkspace` ;
      ressource d'un autre tenant → 0 ligne (RLS), jamais 403/oracle.
      `appliquerReglesAction` gardée `peutModifier`. `workspace_id`/`created_by`
      jamais des paramètres client (dérivés de ctx).
- [ ] **Validation Zod stricte** : `pattern` (1..255, trim non vide), `matchType`
      enum, `categoryId` uuid, `priority` entier borné. Rejet nommé `INVALID_PARAMS`.
- [ ] **Injection (ASVS)** : pattern **toujours paramétré** (jamais interpolé dans le
      SQL). Échapper les méta-caractères LIKE (`%`, `_`, `\`) du pattern utilisateur
      via `ESCAPE` — un pattern « 50% » ne doit pas devenir un joker. Match `ILIKE`
      avec valeur liée.
- [ ] **PII (règle 8)** : `bank_label_raw` est PII. Le match le LIT (serveur) mais ne
      le LOGGE JAMAIS (ni `clean_label`, ni le pattern dans un message d'erreur
      énumérant). Logs = `{ evt, action, workspaceId, code }` + compteurs, jamais le
      texte. Les messages d'erreur ne révèlent pas le libellé.
- [ ] **IDOR** : cas ajouté à la suite isolation (une règle/un split RULE d'un autre
      tenant n'est jamais visible/modifiable).
- [ ] **Append-only intact** : le service écrit dans `transaction_categorizations`
      (éditable) et `categorization_audit` (INSERT only) — jamais de DELETE sur
      l'append-only. `categorization_rules` n'est PAS append-only.
- [ ] **Montants (règle 8)** : split = `abs(amount)` de la transaction, en **numeric
      côté SQL** (jamais de float TS). L'invariant somme ≤ |montant| est trivial
      (un seul split à 100% sur une txn vide) mais on s'appuie sur le même chemin
      verrouillé que `ajouterSplit`.
- [ ] **Erreurs nommées** : `RULE_NOT_FOUND`, `INVALID_PARAMS`, `SERVICE_UNAVAILABLE`,
      réutiliser `CATEGORY_NOT_FOUND` si la FK catégorie échoue. Catch-all interdit.
- [ ] **Tests (isolation PGlite, BLOQUANTS)** :
  - `contains` matche une txn par `clean_label` → 1 split RULE à 100%, source/rule_id
    cohérents, audit écrit.
  - `starts_with` matche par fallback `bank_label_raw` quand `clean_label` est NULL.
  - **fallback** : `clean_label` présent ET `bank_label_raw` présent → c'est
    `clean_label` qui décide (priorité prouvée).
  - **MANUAL prime** : une txn déjà ventilée manuellement n'est JAMAIS touchée par
    `appliquerRegles` (NOT EXISTS).
  - **ordre/priorité** : deux règles matchent → la `priority` la plus basse gagne ;
    une seule règle appliquée (pas deux splits).
  - **échappement LIKE** : pattern « 50% » ne matche que le littéral « 50% », pas
    n'importe quoi.
  - **idempotence** : ré-exécuter `appliquerRegles` ne crée pas de doublon (les déjà
    catégorisées sont skippées).
  - **isolation tenant** : une règle du workspace A ne catégorise jamais une
    transaction du workspace B ; une règle référençant une catégorie d'un autre
    tenant est rejetée par la FK composite.
  - **règle archivée** : `is_active=false` n'est pas appliquée.
  - **CRUD** : créer/modifier/archiver scopé ; règle d'un autre tenant → introuvable.
  - **idempotence provisioning** : le script reste idempotent après ajout de la table
    à la liste blanche DELETE.
- [ ] **Logs structurés corrélés** : `workspace_id` + code + compteurs, sans PII.

## 6. Hors périmètre (anti-scope-creep, règle 7) → dettes TODOS si besoin

- Pré-remplissage via les « Parties » Omni-FI (déjà tracé ENTITY-PARTY1).
- UI des règles (écran d'admin) : **frontière Front** — je livre les Server Actions
  contract-first ; l'UI est une dette tracée (comme ENTITY-UI1). Une PR Backend
  livre data + actions + service ; le Front câble.
- Application auto en arrière-plan périodique (cron) : lié à DASH-AUTOSYNC1 (déjà
  tracé). Le branchement post-sync (§4) couvre l'auto « à l'ingestion » demandé.
- Réécriture des splits RULE existants quand une règle change (option « écraser RULE »
  écartée par le PO) → dette future si besoin.
- DELETE physique d'une règle (au MVP : archivage logique).

## 7. Découpage & livraison

- Branche `feat/moteur-regles-categorisation` depuis `main` à jour (après PR #1).
- WIP commits par unité (schéma+migration+provisioning ; repo+service ; actions ;
  branchement ; tests) — jamais `git add -A`.
- Stop-loss (lint + typecheck + tests, isolation incluse) avant commit. Push + PR.
  STOP à la PR (code applicatif → Human-in-the-Loop, jamais d'auto-merge).
- Cross-review (règle 6) : contexte frais sur l'isolation/IDOR/concurrence/PII avant
  de demander le merge.

## 8. Fichiers touchés (récap)

| Fichier | Action |
|---|---|
| `src/server/db/schema.ts` | + table `categorizationRules` (+ export type `MatchType`) |
| `drizzle/migrations/0010_*.sql` | généré + complément FORCE RLS manuel |
| `drizzle/provisioning/tygr_app.sql` | + `categorization_rules` à la liste blanche DELETE |
| `src/server/repositories/regles-categorisation.ts` | **NOUVEAU** (CRUD + `appliquerRegles`) |
| `src/server/repositories/categorisation.ts` | exporter `ecrireAudit` (source unique d'audit) |
| `src/lib/regles-schema.ts` | **NOUVEAU** (Zod) |
| `src/app/(workspace)/regles/actions.ts` | **NOUVEAU** (Server Actions) |
| `src/server/db/index.ts` | exporter le nouveau repo (si barrel) |
| `src/server/ingestion/orchestrateur.ts` | appel `appliquerRegles` post-sync par compte |
| `tests/isolation/regles-categorisation.test.ts` | **NOUVEAU** (suite bloquante) |
