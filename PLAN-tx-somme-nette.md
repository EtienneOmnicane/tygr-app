# PLAN — Somme nette des résultats filtrés (/transactions)

Ticket : **TX-RECHERCHE-SOMME-NETTE1** (P2, FEATURE, TODOS.md:218). Branche
`feat/tx-somme-nette`. Rédigé 2026-07-14 (règle 1 : plan AVANT toute ligne de code).

## 1. Besoin

Sur `/transactions`, quand un filtre est actif (recherche / statut / bornes de date),
afficher la **somme nette des résultats filtrés** : `net = entrées − sorties`.

**Contrainte d'architecture (piège TX-FILTRE1)** : la pagination est en KEYSET → le
client ne détient qu'UNE page. Sommer côté client ne totaliserait que la page visible.
⇒ **agrégat SERVEUR** scopé `withWorkspace`/RLS, appliquant les **mêmes prédicats** que
la liste. Une ligne **par devise** (jamais d'addition cross-devise, règle 8).

## 2. ⚠️ Correction d'une hypothèse FAUSSE du brief (le point dur de ce chantier)

Le brief demandait : *« `amount` est SIGNÉ (Debit négatif) → `net = sum(amount)`,
`entrees = sum(amount) filter (where amount >= 0)`, `sorties = … amount < 0 »`*.

**C'est faux en production.** Vérifié à la source :

- `src/server/ingestion/conversion.ts:31` — `normaliserMontant()` valide le montant OBIE
  avec la regex `/^\d{1,13}(\.\d+)?$/` : **aucun signe accepté**, un montant négatif est
  rejeté (`OmniFiInvalidResponseError`). Elle renvoie toujours un décimal **positif**.
- `src/server/repositories/ingestion.ts` (`upsertTransactions`) est le **seul** chemin
  d'écriture applicatif de `transactions_cache.amount` — il persiste cette sortie.
- `transactions_cache.amount` n'a **aucun CHECK de signe** ; `credit_debit`, lui, porte un
  CHECK `IN ('Credit','Debit')` (schema.ts:477) → **c'est le seul champ faisant autorité
  sur le sens**.

⇒ En base, `amount` est une **valeur ABSOLUE** ; le sens vit sur `credit_debit`.
Avec le SQL du brief, en prod : `sorties` vaudrait toujours `0` (aucun amount < 0) et
`net = sum(amount)` **additionnerait** entrées et sorties (total faux, toujours positif)
sur un écran financier.

**Pourquoi le piège est vicieux** : le fichier qu'on me demandait de calquer,
`tests/isolation/transactions-isolation.test.ts`, sème des montants **négatifs**
(`'-500.00','Debit'`) — convention qui n'existe QUE dans cette fixture (elle n'y somme
jamais `amount`, elle ne le lit qu'à travers `abs()` pour le statut de ventilation).
Semer comme ce fichier aurait rendu le test d'isolation **vert sur un agrégat faux**.
Les suites qui testent réellement des flux sèment, elles, comme la production :
`dashboard-synthese-mensuelle.test.ts:71` → `('500.00','MUR','Debit')`, positif.

**Convention retenue** (= celle, déjà en production et déjà testée, de
`cashflowParDevise`, `src/server/repositories/insights.ts:136-142`, et de
`syntheseMoisParDevise`, `dashboard.ts:503-508`) :

```sql
entrees = coalesce(sum(amount) filter (where credit_debit = 'Credit'), 0)::numeric(15,2)::text  -- magnitude ≥ 0
sorties = coalesce(sum(amount) filter (where credit_debit = 'Debit'),  0)::numeric(15,2)::text  -- magnitude ≥ 0
net     = (entrees_expr - sorties_expr)::numeric(15,2)::text                                    -- SIGNÉ
nb      = count(*)::int
```

- Sens dérivé de `credit_debit` (champ sous CHECK), **jamais** du signe de `amount`.
- `::numeric(15,2)::text` (et pas `::text` nu) : fige l'échelle à 2 décimales même quand
  le `coalesce` retombe sur le littéral `0` — sinon `"0"` vs `"0.00"` selon la présence de
  données, ce qui casserait l'alignement des virgules (contrat « chaîne décimale »).
- Zéro float : tout le calcul est en `numeric` SQL, la sortie est une chaîne.
- **Une seule convention dans l'app** : `entrees`/`sorties` sont des magnitudes positives
  partout (dashboard, insights, ici). Introduire ici un `sorties` négatif aurait créé une
  2ᵉ convention contradictoire pour le même mot, sur la même table.

## 3. Garanties d'identité liste ↔ somme (le total DOIT correspondre aux lignes vues)

Trois divergences possibles, neutralisées **par construction** (pas par vigilance) :

1. **Filtres** — `sommeNetteSchema` et `listerTransactionsSchema` dérivent d'un MÊME objet
   Zod de base (`filtresTransactions`) ; la liste l'`.extend()` de `curseur`/`limite`. Un
   futur filtre ajouté à la base atterrit mécaniquement dans les deux. Pas de copier-coller.
2. **Prédicats SQL** — `listerTransactions` et `sommeNetteParDevise` partagent les mêmes
   helpers : `conditionsFiltres()` (isRemoved, bankAccountId, ILIKE échappé `[\\%_]`,
   gte/lte dates), `aggregatVentilation()` + `jointureAggregat()` (table dérivée anti-N+1),
   `predicatStatut()`. La somme n'a **pas** le prédicat de curseur (elle porte sur TOUT le
   jeu filtré, pas sur une page) et **pas** de `limit`.
3. **Jeu de lignes / RLS** — `innerJoin(bank_accounts)` (ENTITY-READ-JOIN1) : fait hériter
   la policy `entity_scope` (étage 2), qui vit sur `bank_accounts`. `transactions_cache`
   porte déjà `tenant_isolation` + `account_scope` (0017). **`bank_connections` n'est PAS
   joint** : vérifié, il ne porte QUE `tenant_isolation` (0003:91) — aucune policy
   entity/account → dans un tenant donné, toutes ses lignes sont visibles, et
   `bank_accounts.connection_id` est NOT NULL vers le même workspace. La jointure de la
   liste ne peut donc écarter aucune ligne : l'omettre est **prouvablement neutre** sur le
   jeu de lignes (elle n'existe côté liste que pour PROJETER `institution_name`), et garde
   l'agrégat à la même forme que ses frères (`cashflowParDevise`, `syntheseMoisParDevise`).

L'agrégat de ventilation est **toujours** joint (même quand `statut` est absent) : le
brancher conditionnellement ferait diverger les types du builder Drizzle, et la liste paie
déjà ce coût à chaque page (un scan groupé, pas un N+1).

## 4. Lots

| # | Fichier | Contenu |
|---|---|---|
| L1 | `src/lib/transactions-schema.ts` | objet de base `filtresTransactions` ; `listerTransactionsSchema` = base `.extend({curseur, limite})` (comportement INCHANGÉ) ; `sommeNetteSchema` = base `.strict().refine(du ≤ au)` ; `SommeNetteInput` |
| L2 | `src/server/repositories/transactions.ts` | helpers partagés (§3.2) + `sommeNetteParDevise(tx, ctx, params)` → `SommeNetteDevise[]`, GROUP BY + ORDER BY `currency` |
| L3 | `src/server/db/index.ts` | ré-export (frontière P0-a : les Server Actions n'importent jamais `@/server/repositories/*` en direct) |
| L4 | `src/app/(workspace)/transactions/actions.ts` | `sommeNetteTransactionsAction(filtres)` → Zod → `withWorkspace` → `ResultatAction<SommeNetteDevise[]>`, échec via `echec()` (log sans PII ni montant) |
| L5 | `src/app/(workspace)/transactions/adapter.ts` | `versFiltresSommeNette(filtres)` = `versInputBackend(filtres, null)` **moins** curseur/limite (source unique de la projection de filtres) |
| L6 | `src/components/transactions/types-transactions.ts` | type `SommeNetteDevise` (UI) + méthode **OPTIONNELLE** `sommeNette?` sur `ActionsTransactions` — optionnelle pour ne PAS casser le stub `app/demo/transactions` |
| L7 | `src/components/transactions/transactions-somme-nette.tsx` | composant PUR : une ligne/devise, `net` coloré par le signe (`inflow`/`outflow`), virgules alignées (`indicateurDevise` + `montantNu`), `tabular-nums`, formatage via `@/lib/format-montant` |
| L8 | `src/components/transactions/transactions-feature.tsx` | fetch de l'agrégat DANS `rechargerPremierePage`, **uniquement si un filtre est actif** ; **jamais** au « Charger plus » |
| L9 | `src/app/(workspace)/transactions/page.tsx` | closure `"use server"` de câblage |
| L10 | `tests/isolation/transactions-somme-nette-isolation.test.ts` | preuve (§5) |
| L11 | `TODOS.md` | entrée close |

**Fraîcheur (L8)** : liste et somme sont demandées dans le **même** `await Promise.all` à
partir du **même** instantané de filtres → le total affiché correspond toujours aux lignes
affichées. Filtre retiré ⇒ somme remise à `null` (jamais de total périmé qui traîne).
Échec de l'agrégat ⇒ `null` (fail-closed : **pas de chiffre** plutôt qu'un chiffre faux) ;
la liste, elle, reste servie.

## 5. Preuve — `tests/isolation/transactions-somme-nette-isolation.test.ts`

Socle identique aux autres suites (PGlite + migrations réelles + `tygr_app.sql` +
`set role tygr_app`). **Le semis reproduit la PRODUCTION** : montants POSITIFS, sens sur
`credit_debit` (§2).

1. **Cross-tenant** — A ne somme jamais les transactions de B (et réciproquement).
2. **GROUP BY devise** — MUR + USD semés → 2 lignes distinctes, aucune addition
   cross-devise (le MUR ignore l'USD et inversement).
3. **Signe / convention** (le test qui pin le §2) — Credit 1000 + Debit 300 ⇒ `net = 700`,
   pas `1300`. Un `sum(amount)` nu renverrait `1300` : ce cas **échoue** si quelqu'un
   « re-corrige » l'agrégat vers l'hypothèse du brief.
4. **`net = entrées − sorties`** — vérifié en **centimes entiers (BigInt)** sur les chaînes
   décimales renvoyées ; aucun `parseFloat` (règle 8), y compris dans le test.
5. **Tombstone** — `is_removed = true` exclu de la somme.
6. **Filtres** — recherche (ILIKE), bornes de date, statut de ventilation : la somme
   bouge exactement comme la liste (assertion croisée sur `listerTransactions`).
7. **Contre-preuve rôle** — sous l'**owner**, un `SUM` brut voit les deux tenants (la RLS
   ne filtre pas) ; sous `tygr_app`, non. Prouve que c'est bien la RLS qui protège
   l'agrégat, pas un `WHERE` applicatif.

## 6. Exit criteria (règle 3)

- [x] Authz `withWorkspace` — `workspace_id` jamais un paramètre client.
- [x] Zod strict en frontière (`.strict()`, bornes, refine `du ≤ au`), rejet `INVALID_PARAMS`.
- [x] Isolation : nouvelle lecture financière ⇒ suite d'isolation dédiée (bloquante CI).
- [x] Erreur nommée → message UI mappé (`echec()`), pas de catch-all silencieux.
- [x] Logs corrélés sans PII ni montant.
- [x] Montants : DECIMAL/chaînes de bout en bout, zéro float (SQL → action → UI → test).
