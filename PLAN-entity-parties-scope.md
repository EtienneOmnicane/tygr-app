# PLAN — ENTITY-PARTIES-SCOPE1 : périmètre étage 2 des tables de liaison party

**Date** : 2026-07-21 · **Phase** : CONCEPTION SEULEMENT (règle 1) · **Branche** : `feat/entity-parties-scope`
**Base** : `origin/main` @ `cacb9fe` · **Statut** : plan posé, **3 décisions EN ATTENTE d'arbitrage humain**

> Aucune migration, aucun code applicatif dans ce lot. L'implémentation est une phase
> séparée, sur ce plan approuvé.

---

## 0. Verdict — requalification honnête du ticket

> **Le défaut est RÉEL mais ce n'est PAS celui que le ticket décrit.**
> Il n'existe **aucune fuite de périmètre active** aujourd'hui : les 4 chemins de lecture
> recensés sont tous bornés. Ce qui manque est la **défense complémentaire en RLS** —
> le périmètre étage 2 de `account_party_role` et `parties` tient à 100 % sur une
> **convention de code** (`ENTITY-READ-JOIN1`) et sur des **gardes de rôle applicatives**.
> **Confiance : 9/10.**

Deux requalifications qui changent le chantier, à acter avant toute migration :

**(a) Ce n'est pas un oubli de 0017 — c'est une décision documentée.** Le ticket suppose
que « 0017 était censée ajouter le périmètre et ne l'a pas fait ». C'est faux, et le code le
dit explicitement à deux endroits :

- `drizzle/migrations/0017_account-scope-filles-l5.sql` (bloc COEXISTENCE, avant-dernier
  paragraphe) : « entity_scope n'existe QUE sur bank_accounts (les filles héritaient déjà du
  scope entité par jointure — ENTITY-READ-JOIN1) : L5 ne pose PAS d'entity_scope sur les
  filles ».
- `src/server/db/schema.ts:936-937` : « Le scope de périmètre (account_scope, L4) s'hérite
  ICI par JOINTURE sur bank_accounts — **jamais une policy séparée**. »

La décision a donc été prise et tracée. Ce plan ne la traite pas comme un bug mais comme un
**arbitrage à rouvrir** (règle 10 : on rouvre en citant la décision + le fait nouveau).
Le fait nouveau est en §1.3. **Confiance 10/10.**

**(b) Le vrai défaut est plus large que `account_party_role`.** `parties` est dans le même
état, et l'écart y est plus net : `src/server/db/schema.ts:1001-1002` annonce que la policy
`account_scope` du lot L4 devait porter la « Vision restreinte effective sur
`bank_accounts`/**`parties`** ». La migration `0016_account-scope-l4.sql` ne l'a posée que sur
`bank_accounts` (grep `CREATE POLICY` : une seule occurrence, ligne 66). **`parties` est un
écart plan↔livré**, pas une décision. **Confiance 9/10** (9 et non 10 : la formulation de
schema.ts est une annonce de lot, pas une spec normative).

---

## 1. Preuve de l'état — chemins de lecture, fichier:ligne

### 1.1 Matrice des policies (relevé exhaustif sur `drizzle/migrations/*.sql`)

| Table | `bank_account_id` | tenant_isolation | étage 2 (entity/account_scope) |
|---|---|---|---|
| `bank_accounts` | (id) | ✅ | ✅ `entity_scope` (0014) + `account_scope` (0016) |
| `transactions_cache` (+5 partitions) | ✅ `schema.ts:415` | ✅ | ✅ `account_scope` (0017) |
| `balance_history` | ✅ `schema.ts:521` | ✅ | ✅ `account_scope` (0017) |
| `transaction_categorizations` | — (via txn) | ✅ | ✅ `account_scope` EXISTS (0017) |
| `categorization_audit` | — (via txn) | ✅ | ✅ `account_scope` EXISTS (0017) |
| `echeances` | — (`entity_id` propre) | ✅ | ✅ `entity_scope` direct (0019:63) |
| **`account_party_role`** | ✅ `schema.ts:945` | ✅ `0013:71` | ❌ **AUCUNE** |
| **`parties`** | — (via liaison) | ✅ `0013:70` | ❌ **AUCUNE** |
| `user_scopes` | ✅ `schema.ts:1032` | ✅ (0015) | ❌ AUCUNE — **et c'est CORRECT**, cf. §2.3 |

**Confiance 10/10** (relevé mécanique, reproductible :
`grep -rh "CREATE POLICY" drizzle/migrations/*.sql | sed -E 's/.*"([a-z_]+)" ON "([a-z_0-9]+)".*/\2 -> \1/' | sort -u`).

### 1.2 Les 4 chemins de lecture de `account_party_role` — tous bornés

Recensement exhaustif (`grep -rn "accountPartyRole" src/`) :

| # | Chemin | Borné par | Fuite ? |
|---|---|---|---|
| 1 | `src/server/repositories/dashboard.ts:174-214` — `listerComptes`, sous-requête `titulaire_primaire` | `LEFT JOIN` **depuis** `bank_accounts` (`:208-211`) : seules les lignes de `bank_accounts` in-scope sortent ; le titulaire est un attribut porté, pas une ligne autonome | **Non** — 8/10 |
| 2 | `src/server/repositories/entites.ts:631-656` — `listerPropositionsPartyEntite` étape 2 | `innerJoin(bankAccounts, …)` (`:644-650`) + `exigerAdmin(ctx)` (`:600`) | **Non** — 9/10 |
| 3 | `src/server/repositories/ingestion.ts:373-385` — INSERT upsert | Écriture, tourne en Vision Globale | **Non** — 9/10 |
| 4 | `src/server/db/tenancy.ts:319-327` — résolution du DROIT (4a) | **Lecture DIRECTE, sans jointure** — mais **délibérée** et antérieure à la pose des GUC (`:363`) | **Non**, mais **fragile** — cf. §3.2 — 9/10 |

Le chemin 1 est déjà **prouvé en test** :
`tests/isolation/dashboard-titulaire-isolation.test.ts:157` — « Vision Entité : le compte hors
scope reste masqué AVEC son titulaire ». La borne par jointure n'est donc pas une hypothèse.

**Aucun chemin ne surface une ligne `account_party_role` hors périmètre. Confiance 8/10** —
8 et non 10 parce que la garantie est *syntaxique* (la forme de chaque requête), pas
*structurelle* : elle se re-vérifie à chaque nouvelle requête écrite, et rien ne la fait
échouer bruyamment si elle est omise.

### 1.3 Le fait nouveau — deux lectures DIRECTES de `parties`, sans jointure

C'est ce qui justifie de rouvrir la décision de §0(a) :

- `src/server/repositories/entites.ts:605-624` (`listerPropositionsPartyEntite` **étape 1**) :
  `.from(parties)` **nu**, sans aucune jointure à `bank_accounts`. Surface `parties.name`
  (nom de titulaire) pour **toutes** les parties actives du tenant.
- `src/server/repositories/user-scopes.ts:224-233` : `.from(parties)` **nu** (contrôle
  d'existence des cibles d'octroi).

Ces deux chemins **existent déjà** et ne sont bornés que par le tenant. Ils ne fuitent pas
aujourd'hui **uniquement** parce qu'ils sont `exigerAdmin(ctx)` et qu'un ADMIN est
structurellement non scopé — garde `AdminNonScopableError` posée sur les **deux** axes :
`src/server/repositories/entites.ts:1021-1024` (axe entité) et
`src/server/repositories/user-scopes.ts:212-216` (axe party/compte).

> **Mode de défaillance concret** : le jour où un écran de titulaires est ouvert à un
> MANAGER scopé (ou qu'une des deux gardes `AdminNonScopableError` est relâchée — elle est
> applicative, la RLS ignore le rôle par design), `entites.ts:612` surface les **noms de
> tous les titulaires du groupe** à un membre borné à une BU. Aucune erreur, aucun test
> rouge : la fuite est silencieuse et le nom de titulaire est de la donnée nominative.
> **Confiance 9/10.**

C'est exactement la classe de défaut que CLAUDE.md ferme par avance : « **le filtre de
périmètre vit dans la RLS (fail-closed), JAMAIS dans le .tsx** : un oubli de WHERE ne doit pas
pouvoir créer une fuite intra-groupe. » Ici l'oubli possible n'est pas un `WHERE` mais un
`JOIN` — même conséquence.

### 1.4 Ce que j'ai examiné sans rien trouver (règle 6 : « aucun constat » se justifie)

- Les 5 partitions de `transactions_cache` : `account_scope` posée sur chacune (0017) — la
  leçon « RLS non héritée » est appliquée. RAS.
- `echeances` : porte son propre `entity_id` → prédicat **direct** (0019:63), pas transitif.
  Ce n'est **pas** un précédent réutilisable pour `account_party_role`. RAS.
- `memberEntityScopes`, `categories`, `categorization_rules`, `bank_connections` : ne portent
  pas de `bank_account_id`, hors périmètre de cette classe. RAS.
- `consent_records`, `audit_events` : append-only, tenant seul, hors sujet ici. RAS.

---

## 2. Conception — options et coût comparé (règle 10)

### 2.1 Option A′ (recommandée) — policy `account_scope` transitive, calquée sur 0017

> ⚠️ Le ticket propose « `entity_scope` calquée sur 0009 ». **Je recommande contre**, et c'est
> le seul désaccord de fond de ce plan. Raison : depuis 0016/0017, l'axe entité est **déjà
> unifié en comptes** par le résolveur (`tenancy.ts:334-345` traduit `member_entity_scopes` →
> comptes). Une policy `entity_scope` transitive sur `account_party_role` serait à la fois
> **redondante** (l'axe entité est couvert par `account_scope`) et **insuffisante** : elle
> raterait l'axe `user_scopes` type COMPTE et **toute la clause `view_filter`**. Le calque
> correct est 0017, pas 0009. **Confiance 9/10.**

`account_party_role` ne porte ni `entity_id` ni la maille de filtrage : le périmètre est
**transitif** via `bank_account_id`. Deux formes de prédicat sont possibles — c'est la
**décision D1** ci-dessous.

**Forme (i) — prédicat DIRECT** (`bank_account_id = ANY(...)`, réplique exacte de 0017 sur
`balance_history`) :

```sql
DROP POLICY IF EXISTS "account_scope" ON "account_party_role";
CREATE POLICY "account_scope" ON "account_party_role" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK ( /* … expression IDENTIQUE, copiée caractère pour caractère … */ );
```

Avantages : prédicat indexé (`account_party_role_workspace_account_idx`, `schema.ts:983-986`),
aucun `EXISTS`, aucun risque de récursion RLS. C'est la forme des tables qui portent
`bank_account_id` en dur — ce qui est le cas ici (`schema.ts:945`).

**Forme (ii) — prédicat EXISTS vers `bank_accounts`** (calque des splits/audit de 0017) :
plus fidèle à « le périmètre vit sur `bank_accounts` », mais **inutilement coûteux** ici
puisque la colonne est présente en dur, et il introduit une évaluation RLS imbriquée sur
`bank_accounts` (qui porte elle-même 2 policies RESTRICTIVE). **Je recommande la forme (i).**

**Effet sur l'ingestion (INSERT `ingestion.ts:373`)** : l'ingestion tourne en **Vision
Globale** — le résolveur ne pose **aucun** GUC d'étage 2 quand le membre n'a aucune ligne de
scope (`tenancy.ts:301-307`, cas (a)). `nullif(...) IS NULL` ⇒ `TRUE` ⇒ le `WITH CHECK` passe
inchangé. **Backward-compatible code N-1 (règle 9), zéro régression d'ingestion. Confiance 9/10.**

**Effet sur `parties`** : `parties` ne porte **pas** `bank_account_id` → forme (i) impossible.
Le seul prédicat possible est un `EXISTS` vers `account_party_role` (elle-même scopée) — donc
une chaîne à 2 niveaux : `parties` → `account_party_role` → périmètre. **C'est la décision D2.**

**Roulement** : aucun. `account_party_role` et `parties` ne sont pas partitionnées → le piège
« RLS non héritée par les partitions » (0017, DÉCISION C) **ne s'applique pas**. Aucune clause
de roulement annuel à ajouter au runbook. **Confiance 10/10.**

**Append-only** : `account_party_role` est **éditable** et figure dans la liste blanche DELETE
de `drizzle/provisioning/tygr_app.sql`. Ce lot **n'y touche pas** — une policy RLS et un
privilège DELETE sont deux défenses orthogonales ; ajouter l'une n'autorise ni ne retire
l'autre. **Contrainte du ticket respectée.**

**Coût** : 1 migration manuelle (~120 lignes SQL avec l'en-tête de justification exigé par la
convention 0016/0017) + 1 suite d'isolation (~10 cas, §4) + mise à jour du bloc CLAUDE.md
« Entités multi-tenant » (l'invariant `ENTITY-READ-JOIN1` devient une ceinture, plus l'unique
défense). **Estimation : 1 session CC, ~0 h humain hors revue.**

### 2.2 Option B — garde structurelle (lint/architecture) au lieu de la RLS

Interdire par règle ESLint toute lecture de `accountPartyRole`/`parties` qui ne joint pas
`bankAccounts`.

**Pourquoi c'est insuffisant — trois raisons concrètes, pas de principe :**

1. **La règle ne peut pas exprimer la propriété qu'on veut.** Une règle de lint voit un
   `.innerJoin(bankAccounts, …)` ; elle ne sait pas dire si la jointure **borne** le résultat
   (`from(bankAccounts).leftJoin(role)` borne ; `from(role).leftJoin(bankAccounts)` **ne borne
   pas** — elle laisse sortir les lignes orphelines). Les deux passent le même lint. Le chemin
   1 (`dashboard.ts:174`) et un futur chemin fuyant sont **syntaxiquement indiscernables**.
2. **La frontière ESLint est elle-même faillible, c'est documenté au projet.** Un override de
   flat config a déjà **désactivé en silence** une frontière P0 sur ce dépôt (redéclarer une
   règle la remplace au lieu de la compléter). Une défense d'isolation qui repose sur un
   fichier de config que le prochain override peut neutraliser sans bruit n'est pas
   fail-closed.
3. **Elle ne couvre pas le hors-TypeScript** : `psql` en incident, script de migration de
   données, futur job Inngest, `tygr_service` du webhook. La RLS mord sur **tout accès**,
   quel que soit le chemin — c'est précisément l'argument qui a fait choisir la RLS native
   plutôt que la discipline de jointure en L5 (0017, « STRATÉGIE 1 — DÉCISION A »).

**Verdict** : Option B est un **complément** acceptable, **jamais un substitut**. CLAUDE.md
tranche déjà : « le filtre de périmètre vit dans la RLS, JAMAIS dans le code ».

### 2.3 Faux positif à écarter explicitement — `user_scopes`

Le ticket demande de vérifier `user_scopes` type ACCOUNT (`schema.ts:1032`). **Elle porte bien
`bank_account_id` sans policy d'étage 2 — et il faut la laisser ainsi.**

`user_scopes` est la table **de droits** qui *définit* le périmètre. La scoper par le périmètre
serait une **auto-référence circulaire** : le résolveur (`tenancy.ts:282-293`) la lit pour
calculer le GUC ; si elle était filtrée par ce même GUC, le droit se filtrerait par lui-même.
Elle est déjà correctement protégée : `tenant_isolation` + `exigerAdmin` sur ses deux seuls
chemins (`user-scopes.ts:124`, `:182`) + garde `AdminNonScopableError`.

> **Y poser une policy de périmètre serait un défaut, pas un correctif.** Le plan l'exclut
> explicitement pour qu'un futur lot « par symétrie » ne l'ajoute pas. **Confiance 9/10.**

### 2.4 Recommandation

**Option A′ forme (i) sur `account_party_role`**, + traitement de `parties` selon D2.
Option B **en plus**, si et seulement si elle est gratuite — pas à la place.

---

## 3. Décisions EN ATTENTE — à trancher par Etienne avant implémentation

### D1 — Quelle policy sur `account_party_role` ?
- **(a) `account_scope` transitive, forme directe** *(ma recommandation)* — couvre les 3 axes
  (entité, party, compte) + `view_filter`, prédicat indexé.
- (b) `entity_scope` transitive calquée sur 0009 — ce que demande le ticket ; couvre l'axe
  entité seul, rate `view_filter` et `user_scopes` type COMPTE.
- (c) Les deux (symétrie avec `bank_accounts`) — coût double, bénéfice nul tant que L9 n'a pas
  retiré `entity_scope` ; **ajoute une intersection** (dette ENTITY×ACCOUNT-DOUBLE-AXIS déjà
  ouverte, cf. 0016 bloc COEXISTENCE).

### D2 — Étend-on le lot à `parties` ?
`parties` est le vecteur du **vrai** risque (§1.3 : deux `.from(parties)` nus, données
nominatives). Mais son prédicat est une chaîne EXISTS à 2 niveaux, plus coûteuse à prouver.
- **(a) Oui, dans le même lot** *(ma recommandation)* — la classe se traite en une fois ;
  c'est ce que le ticket demande (« le plan traite la CLASSE du défaut »).
- (b) Non, lot séparé — livre plus vite, mais laisse le chemin le plus exposé ouvert.

⚠️ **Si (a) : point dur à valider en implémentation.** Une party dont **aucun** compte n'est
dans le périmètre deviendrait invisible à un membre scopé. C'est le comportement voulu — mais
il faut vérifier que `listerPropositionsPartyEntite` (ADMIN, Vision Globale) n'en dépend pas,
et décider du sort des parties **sans aucun compte** (`account_party_role` vide) : elles
disparaîtraient sous EXISTS nu. Le court-circuit « Vision Globale OR EXISTS » de 0017 les
protège pour l'ADMIN ; **à prouver par test, pas à supposer.**

### D3 — Ordre vs le lot L9 (retrait d'`entity_scope`)
Le bloc COEXISTENCE de 0016 prévoit un lot L9 qui retire `entity_scope` de `bank_accounts` une
fois `account_scope` prouvée en prod. Si L9 est proche, D1(b) et D1(c) sont à écarter d'office
(on poserait une policy destinée à être retirée). **Question à Etienne : L9 est-il planifié ?**

---

## 4. Preuve exigée — spécification de la suite d'isolation (à écrire, PAS dans ce lot)

Fichier : `tests/isolation/parties-scope-isolation.test.ts` (nouveau — ne pas gonfler
`parties-isolation.test.ts`, qui couvre l'étage 1 et doit rester lisible).

**Fixture** (calquée sur `account-scope-filles-isolation.test.ts`) : 1 workspace, 2 entités
(Sucrière / Énergie), 2 comptes (`compteS` → Sucrière, `compteE` → Énergie), 2 parties
(`partyS` liée à `compteS`, `partyE` liée à `compteE`), 1 membre scopé Sucrière.

> ⚠️ **Cardinalités DISTINCTES obligatoires** (leçon d'une fixture antérieure de ce dépôt qui
> corrélait deux clauses et ne testait ni l'une ni l'autre) : donner **2 lignes** à `partyS` et
> **3 lignes** à `partyE`, pour qu'un test qui compte puisse **discriminer quelle table** il a
> réellement comptée. Une fixture symétrique (2/2) rendrait plusieurs bugs indétectables.

| # | Cas | Attendu | Sans la policy (AUJOURD'HUI) |
|---|---|---|---|
| 0 | Précondition : requêtes sous `tygr_app`, pas l'owner | — | *(sinon toute la suite est un faux vert)* |
| 1 | **SELECT DIRECT** `account_party_role` sous scope Sucrière | 2 lignes (`partyS` seule) | **5 lignes → ROUGE** ✅ |
| 2 | SELECT DIRECT `account_party_role` en Vision Globale | 5 lignes | vert (non-régression) |
| 3 | `WHERE bank_account_id = compteE` forgé depuis un scope Sucrière | **0 ligne** | **3 lignes → ROUGE** ✅ |
| 4 | INSERT `account_party_role` visant `compteE` sous scope Sucrière | refus `42501` (WITH CHECK) | **accepté → ROUGE** ✅ |
| 5 | INSERT d'ingestion en **Vision Globale** | accepté | vert (non-régression, garde anti-fail-closed) |
| 6 | Sentinelle UUID-nul (`accountScope` = ∅) | **0 ligne**, jamais « tout » | à prouver |
| 7 | `view_filter` = `compteE` alors que le DROIT = `compteS` | 0 ligne (intersection vide) | à prouver |
| 8 | `listerComptes` sous scope Sucrière | `compteE` **et** son titulaire absents | déjà vert (`dashboard-titulaire-isolation.test.ts:157`) — **régression guard** |
| 9 | *(si D2=a)* SELECT DIRECT `parties` sous scope Sucrière | `partyE` invisible | **visible → ROUGE** ✅ |
| 10 | *(si D2=a)* party **sans aucun compte**, Vision Globale ADMIN | reste visible (court-circuit) | à prouver — cf. point dur D2 |

**Vérification par MUTATION — non négociable, c'est ce qui distingue une preuve d'un décor.**
Une suite qui passe ne prouve rien tant qu'on n'a pas vu chaque assertion **échouer** pour la
bonne raison. Protocole, à exécuter et à **consigner dans la PR d'implémentation** :

1. **Retirer la clause `account_scope`** de la policy (garder `view_filter` seule) → les cas
   1, 3, 4, 6 doivent rougir ; 7 doit rester vert.
2. **Retirer la clause `view_filter`** (garder `account_scope`) → le cas 7 doit rougir ; 1, 3,
   4, 6 restent verts. *(Prouve que les deux clauses sont testées séparément — le piège de la
   fixture qui corrèle deux clauses d'un `AND`/`OR`.)*
3. **Poser la policy en `PERMISSIVE`** au lieu de `RESTRICTIVE` → les cas 1 et 3 doivent
   rougir. *(Une PERMISSIVE s'OR'e avec `tenant_isolation` et ne filtre RIEN — c'est
   l'erreur la plus coûteuse et la plus invisible du lot.)*
4. **Confusion de table** : pointer le prédicat sur `bank_accounts` au lieu de
   `account_party_role` → au moins un cas doit rougir. *(Prouve que la suite mesure bien la
   table visée ; c'est ici que les cardinalités 2/3 de la fixture font leur travail.)*
5. **`FOR SELECT` au lieu de `FOR ALL`** → le cas 4 doit rougir. *(Piège historique du dépôt :
   0009 était `FOR SELECT`, les tests prouvaient `FOR ALL` — faux vert pendant tout un lot.)*

**Piège de faux vert à éviter** (leçon `0009`/`0014`) : les suites d'isolation appliquent les
migrations **par `readdir`/nom**, pas par `meta/_journal.json`. Une migration absente du
journal est **verte en test et jamais appliquée en prod**. La nouvelle migration DOIT être
inscrite au journal, et `tests/isolation/migrations-journal-coherence.test.ts` (déjà présent)
doit rester vert — **le vérifier explicitement, ne pas le supposer.**

---

## 5. Point dur d'implémentation — auto-référence du résolveur (à ne PAS rater)

`src/server/db/tenancy.ts:319-327` lit `account_party_role` **pour résoudre le DROIT** d'un
membre scopé par PARTY. Poser `account_scope` sur cette table crée une **auto-référence
potentielle**.

**Aujourd'hui c'est sûr**, et pour une raison précise et fragile : la résolution (`:310-345`)
se fait **avant** la pose des GUC (`:349-374`). Le commentaire `:246-251` documente cet ordre
comme intentionnel (« on lit donc `bank_accounts` AVANT que le moindre GUC d'étage 2 ne soit
posé »). La lecture voit l'état tenant brut. **Confiance 9/10.**

> **Mode de défaillance si l'ordre est inversé** (refactor, extraction de helper, réordonnancement
> pour « poser les GUC au plus tôt ») : un membre scopé par PARTY ne verrait plus les lignes
> `account_party_role` **qui définissent son propre droit** → `accountsAutorises` résout à ∅ →
> le résolveur pose la **sentinelle UUID-nul** (`:370-372`) → le membre ne voit **plus rien**.
> Fail-closed (aucune fuite), mais **déni d'accès total et silencieux** — l'utilisateur voit un
> dashboard vide, pas une erreur. C'est le pendant exact du bug d'auto-amputation déjà rencontré
> sur le sélecteur de périmètre. **Confiance 8/10.**

**Contre-mesure exigée dans le lot d'implémentation** : un **test de non-régression d'ordre**
— un membre scopé **par PARTY** (pas par compte, pas par entité) voit bien ses comptes après la
migration. Ce test échoue si l'ordre est inversé un jour ; le commentaire, lui, n'échoue jamais.

---

## 6. Ce que ce lot ne fait PAS

- Ne touche ni `tygr_app.sql` ni la liste blanche DELETE (append-only intact).
- Ne pose **aucune** policy sur `user_scopes` (§2.3 — ce serait un défaut).
- Ne retire pas `entity_scope` de `bank_accounts` (c'est L9, hors périmètre).
- Ne modifie **aucun** repository : si la policy est correcte, les 4 chemins existants
  continuent de fonctionner à l'identique (ils sont déjà plus restrictifs qu'elle).
- N'ouvre pas la règle ESLint de l'Option B (à arbitrer séparément, sans valeur de défense).

---

## 7. Prochaine étape

**Arbitrage D1/D2/D3 par Etienne.** Aucune ligne de SQL avant. Une fois tranché :
migration `0024_parties-scope.sql` + `tests/isolation/parties-scope-isolation.test.ts` +
mutation-check §4 consigné dans la PR, en **phase implémentation séparée**.
