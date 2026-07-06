# PLAN — Contraintes UNIQUE composites scopées `workspace_id`

> **Phase** : CONCEPTION (règle 1). Ce document est le plan de référence ; aucune
> ligne de code / migration n'est produite ici.
> **Branche / worktree** : `fix/unique-composites` (`C:\Users\EtienneNardou\tygr-worktrees\unique-composites`).
> **Items TODOS traités** : **1.1** (Cross-review PR-W4, TODOS.md:1383) **et 1.2**
> (Cross-review PR-W2, TODOS.md:1459) — DOUBLONS déclarés du même sujet, fusionnés ici.
> **Adjacents explicitement HORS scope** : `#5` (FK non composites, TODOS.md:1669) et
> `#6` (TODOS.md:1676) — cf. §9.
> **Sources lues** : `src/server/db/schema.ts` (intégral), `drizzle/migrations/0003_epic3-financial-core.sql`,
> `src/server/repositories/ingestion.ts`, `src/server/widget/orchestration.ts`,
> `tests/isolation/ingestion-isolation.test.ts`, `tests/isolation/transactions-isolation.test.ts`,
> `tests/isolation/migrations-journal-coherence.test.ts`, `drizzle/migrations/meta/_journal.json`,
> `src/app/api/**`.

---

## 0. Résumé exécutif

Trois contraintes UNIQUE portent une clé Omni-FI **globale** (non préfixée par
`workspace_id`) alors que la donnée est scopée tenant :

| # | Table | Contrainte actuelle | Cible composite |
|---|-------|---------------------|-----------------|
| 1 | `bank_connections` | `UNIQUE(omnifi_connection_id)` | `UNIQUE(workspace_id, omnifi_connection_id)` |
| 2 | `bank_accounts` | `UNIQUE(omnifi_account_id)` | `UNIQUE(workspace_id, omnifi_account_id)` |
| 3 | `transactions_cache` | `UNIQUE(omnifi_txn_id, transaction_date)` | `UNIQUE(workspace_id, omnifi_txn_id, transaction_date)` |

Le durcissement se fait en **expand → contract** (2 migrations, `0018` puis `0019`)
avec mise à jour **en lock-step** des 3 cibles `onConflictDoUpdate` de l'ingestion,
et une suite d'isolation qui **prouve par inversion** qu'un même identifiant Omni-FI
peut désormais coexister dans deux workspaces sans se percuter — tout en restant
idempotent **dans** un workspace.

**Coût CC estimé** : ~0,75 j (schéma + 2 migrations générées + code ingestion + 1 suite
d'isolation + Visual QA nul). **Coût humain** : revue schéma contradictoire + 2 merges
(expand, puis contract au release suivant).

---

## 1. Cadrage sécurité & sévérité réelle (règle 10 — sans théâtre)

**Ce que le trou EST** : un **couplage de disponibilité cross-tenant** + un **oracle
d'énumération faible**. Parce que la contrainte est globale, un même `omnifi_connection_id`
/ `omnifi_account_id` / `omnifi_txn_id` ne peut exister **qu'une fois sur toute la base**.
Si deux workspaces reçoivent le même identifiant (hypothèse 1.1 : Omni-FI ne garantit
peut-être pas l'unicité globale entre `ClientUserId`), le 2ᵉ ingère → `INSERT … ON CONFLICT
DO UPDATE` cible une ligne **d'un autre tenant, invisible sous RLS** → **échec dur**
(violation d'unicité `23505` ou violation de politique RLS `42501`). L'ingestion / la
finalisation de connexion du 2ᵉ tenant **plante** (DoS), et l'échec révèle indirectement
qu'un identifiant existe ailleurs (oracle).

**Ce que le trou N'EST PAS** : ce n'est **pas** une fuite de confidentialité ni un IDOR
silencieux. La RLS `tenant_isolation` (étage 1, PERMISSIVE `workspace_id`) **tient** :
l'`upsert` ne peut ni lire ni écrire la ligne de l'autre tenant — il **échoue**, il ne
fuit pas. Preuve en base : `tests/isolation/ingestion-isolation.test.ts` (R1a/R1b, WITH
CHECK partitions incluses).

**Conséquence de classification (règle 9)** : la dette « isolation tenant » stricte est
INTERDITE de report. Celle-ci est un **couplage/oracle intra-plateforme**, adjacent mais
distinct d'une fuite — c'est pourquoi elle a pu être différée en P1 depuis 2026-06-15 sans
violer la règle. **On la ferme maintenant** parce que le **déclencheur est mûr**, pas parce
qu'elle serait devenue une fuite :

- Prod est passée **multi-connexions / donnée réelle** (77 comptes, multi-devise — TODOS
  PROD-ENDUSER1, §Sync).
- La roadmap prévoit **plusieurs tenants** (`workspaces.kind` inclut `EXTERNAL_CLIENT` —
  schema.ts:66 ; sales enablement de l'API — CLAUDE.md). **Le jour où un 2ᵉ tenant réel
  existe**, une collision d'identifiant Omni-FI devient un DoS d'ingestion pour l'un des
  deux. Le corriger **avant** l'onboarding du 2ᵉ tenant est le bon moment ; ce n'est pas
  une urgence pour le mono-tenant présent.

**Verdict** : hardening défensif **cheap et propre**, à faire avant la bascule multi-tenant,
pas un hotfix de fuite. Le plan livre la fermeture ET la preuve.

---

## 2. INVENTAIRE exhaustif des contraintes d'unicité (schema.ts intégral)

### 2.1 EN SCOPE — global/non-scopé → à rendre composite (les 3 cibles)

| Constrainte (nom réel) | Table | Colonnes actuelles | schema.ts | DDL 0003 | Nature |
|---|---|---|---|---|---|
| `bank_connections_omnifi_connection_id_unique` | `bank_connections` | `(omnifi_connection_id)` | 238–240 (`.unique()` inline) | 0003:35 | **Global** |
| `bank_accounts_omnifi_account_id_unique` | `bank_accounts` | `(omnifi_account_id)` | 283–285 (`.unique()` inline) | 0003:22 | **Global** |
| `transactions_cache_omnifi_txn_unique` | `transactions_cache` | `(omnifi_txn_id, transaction_date)` | 428–431 (`unique(...)`) | 0003:55 | **Non scopé `workspace_id`** (partition-key incluse) |

> Le n°3 inclut déjà `transaction_date` (obligatoire : c'est la **clé de partition** —
> toute UNIQUE d'une table partitionnée DOIT la contenir, 0003:58). Il manque uniquement
> `workspace_id` en tête.

### 2.2 DOIVENT RESTER GLOBALES (correctes — HORS scope, documenté pour la revue)

| Constrainte | Table | Colonnes | schema.ts | Pourquoi global est CORRECT |
|---|---|---|---|---|
| `workspaces_omnifi_client_user_id_unique` | `workspaces` | `(omnifi_client_user_id)` | 53–55 | C'est **l'identité du tenant** (`ClientUserId` = frontière tenant, CLAUDE.md ; mismatch → `403 PUBLIC_TOKEN_CLIENT_MISMATCH`). `workspaces` n'a **pas** de colonne `workspace_id` (elle *est* le workspace). Composer serait impossible et faux (autoriserait 2 workspaces au même `ClientUserId` = confusion de tenant). |
| `users_email_lower_unique` | `users` | `lower(email)` | 91 | `users` est une **méta-table d'identité cross-workspace** (un user ∈ N workspaces via `workspace_members`). Unicité d'email **plateforme** requise ; pas de `workspace_id` à composer. |

### 2.3 DÉJÀ COMPOSITES / SCOPÉES (aucune action — servent de PRÉCÉDENT)

`entities_id_workspace_unique` (214), `entities_workspace_name_unique` (216),
`bank_accounts_id_workspace_unique` (321), `categories_id_workspace_unique` (516),
`categories_workspace_name_parent_unique` (525), `categorization_rules_workspace_unique` (715),
**`parties_workspace_omnifi_party_unique` (852)**, `parties_id_workspace_unique` (848),
`user_scopes_user_party_unique` (988, partielle), `user_scopes_user_account_unique` (992, partielle).

> ⭐ **`parties_workspace_omnifi_party_unique` (schema.ts:852) est le patron exact** de ce
> chantier : son commentaire (850–851) dit explicitement « **on ne refait pas le pari
> d'unicité globale d'`omnifi_connection_id`/`omnifi_account_id`** (cf. schema.ts:233) ».
> La cible party a été faite dès l'origine en `(workspace_id, omnifi_party_id)` ; ce plan
> **rattrape** les 3 tables antérieures sur ce même patron.

### 2.4 PKs / clés — PAS des surfaces de collision client (HORS scope)

- Surrogates `id uuid defaultRandom()` (PK simple) : `workspaces`, `users`, `login_attempts`,
  `entities`, `bank_connections`, `bank_accounts`, `categories`, `transaction_categorizations`,
  `categorization_audit`, `categorization_rules`, `parties`, `user_scopes`. → id **généré DB**,
  jamais une clé naturelle fournie par le client ; pas de rattachement cross-tenant possible.
- Composites déjà scopées : `workspace_members(user_id, workspace_id)` (135),
  `member_entity_scopes(workspace_id, user_id, entity_id)` (751),
  `account_party_role(workspace_id, bank_account_id, party_id)` (896).
- `transactions_cache(id, transaction_date)` (PK, 427) : `id` = UUID **aléatoire DB** →
  collision cross-tenant ≈ 0 ; non client. Laisser tel quel.
- `balance_history(bank_account_id, balance_date)` (PK, 472) : `bank_account_id` est une FK
  vers `bank_accounts.id` (UUID DB), **appartenant à un seul workspace** → la PK est
  **implicitement scopée** (un `bank_account_id` ne peut exister dans 2 tenants). Aucun
  risque de percussion cross-tenant ; laisser tel quel. (L'upsert soldes cible déjà
  `[bankAccountId, balanceDate]`, ingestion.ts:251 — inchangé.)

**Conclusion inventaire : exactement 3 contraintes en scope (§2.1). L'« et autres » de la
demande = la n°3 (`transactions_cache`).**

---

## 3. Contraintes cibles (spécification — PAS la migration)

Noms alignés sur le précédent `parties_workspace_omnifi_party_unique` :

1. `bank_connections_workspace_omnifi_connection_unique` **UNIQUE(`workspace_id`, `omnifi_connection_id`)**
2. `bank_accounts_workspace_omnifi_account_unique` **UNIQUE(`workspace_id`, `omnifi_account_id`)**
3. `transactions_cache_workspace_omnifi_txn_unique` **UNIQUE(`workspace_id`, `omnifi_txn_id`, `transaction_date`)**

`workspace_id` en **tête** (colonne meneuse de l'index → sert aussi les scans `WHERE
workspace_id = ?`). Ordre sans effet sur l'inférence `ON CONFLICT` (Postgres matche
l'**ensemble** de colonnes), mais décisif pour l'efficacité de l'index.

**Forme schema.ts cible** (illustratif, à produire en implémentation) : retirer le
`.unique()` **inline** des colonnes `omnifiConnectionId` (240) / `omnifiAccountId` (285),
remplacer le `unique("transactions_cache_omnifi_txn_unique")` (428) ; déclarer les 3
composites dans le **callback de table** via `unique(nom).on(t.workspaceId, …)` — même
style que `entities_id_workspace_unique` (214) ou `parties_workspace_omnifi_party_unique`
(852). Actualiser les **commentaires d'HYPOTHÈSE** (233–237, 279–282) : l'hypothèse
d'unicité globale est désormais **abandonnée**, remplacée par l'unicité **par tenant**.

---

## 4. Couplage code OBLIGATOIRE — `onConflictDoUpdate` (le point sensible)

Une migration seule casse l'ingestion : les cibles `ON CONFLICT` doivent bouger **avec** le
schéma. Trois sites, tous dans `src/server/repositories/ingestion.ts` :

| Site | Ligne | Cible actuelle | Cible après |
|---|---|---|---|
| `upsertConnexion` | 95–96 | `target: bankConnections.omnifiConnectionId` | `target: [bankConnections.workspaceId, bankConnections.omnifiConnectionId]` |
| `upsertCompte` | 131–132 | `target: bankAccounts.omnifiAccountId` | `target: [bankAccounts.workspaceId, bankAccounts.omnifiAccountId]` |
| `upsertTransactions` | 204–205 | `target: [transactionsCache.omnifiTxnId, transactionsCache.transactionDate]` | `target: [transactionsCache.workspaceId, transactionsCache.omnifiTxnId, transactionsCache.transactionDate]` |

**Règle de séquence Postgres** : `ON CONFLICT (cols)` exige qu'une contrainte/index unique
existe **exactement** sur `cols`. Donc le code composite ne peut tourner que **si la
contrainte composite existe déjà** → il se déploie **après** l'expand (§6). Le pré-UPDATE
tombstone de `upsertTransactions` (172–180, marque `is_removed` sur date changée) est un
`UPDATE` scopé RLS **sans** `ON CONFLICT` → **inchangé**.

**Aucun autre couplage** :
- Les lectures par `omnifi_connection_id` (`orchestration.ts:199`, `:1199`) et par
  `omnifi_account_id` (`orchestration.ts:966,972,1265,1271`) tournent **DANS `executer`**
  (RLS, workspace courant) — filtrées tenant, **indifférentes** au caractère composite de
  la contrainte. Le commentaire `orchestration.ts:872–874` **interdit** déjà tout lookup
  non scopé. Rien à changer.
- **Aucun résolveur global** (hors `withWorkspace`) par ces clés n'existe : `src/app/api/`
  ne contient que `auth/[...nextauth]/route.ts` — **pas de route webhook**. (Cf. §9 pour le
  garde-fou à imposer le jour où elle sera créée.)
- **Provisioning INTOUCHÉ** : une UNIQUE ne requiert **aucun GRANT** ; la liste blanche
  DELETE et le trigger append-only (`transactions_cache`) sont **orthogonaux**. `tygr_app.sql`
  ne bouge pas.

---

## 5. RISQUE MIGRATION — données existantes & spécificités partition

### 5.1 Sûreté des données : preuve que l'expand ne peut PAS casser

Passer d'une UNIQUE **globale** `(X)` à une composite `(workspace_id, X)` est **strictement
plus permissif** : tout jeu de lignes unique globalement l'est **a fortiori** par workspace.
Donc **ajouter** la composite **réussit toujours** sur la donnée actuelle — garanti par la
contrainte globale (plus stricte) qui tient encore au moment de l'expand. Idem n°3 :
`(omnifi_txn_id, transaction_date)` unique globalement ⇒ `(workspace_id, omnifi_txn_id,
transaction_date)` trivialement satisfait.

**Corollaire** : **aucun cas de donnée existante ne casse** (ni en prod 77 comptes, ni en
local). Le seul « risque données » classique — des doublons préexistants que la nouvelle
contrainte refuserait — **ne peut pas exister ici**, puisque la nouvelle contrainte est plus
lâche que l'ancienne. Le `DROP` (contract) ne peut pas échouer non plus (on retire une
contrainte, on n'en valide pas une).

> **À vérifier tout de même avant contract** (paranoïa saine, coût nul) : requête de
> contrôle owner `SELECT omnifi_connection_id, count(*) FROM bank_connections GROUP BY 1
> HAVING count(*) > 1` (et équivalents comptes/txn) → doit renvoyer **0 ligne** tant que la
> globale existe. Sert de garde-fou au cas où un environnement aurait été provisionné hors
> pipeline.

### 5.2 Spécificités table partitionnée (`transactions_cache`)

- La composite n°3 **inclut** la clé de partition `transaction_date` → **légale** sur table
  partitionnée (contrainte satisfaite). `ALTER TABLE transactions_cache ADD CONSTRAINT …
  UNIQUE(workspace_id, omnifi_txn_id, transaction_date)` crée un **index partitionné** sur le
  parent + un index enfant par partition (2024–2027 + `default`). `DROP CONSTRAINT` retire le
  parent **et** les enfants. Coût I/O réel mais négligeable au volume actuel (dizaines de
  milliers de lignes).
- **⚠️ Point de vérification drizzle-kit** : 0003 a **posé à la main** la clause
  `PARTITION BY` (drizzle-kit ne l'émet pas). Il faut **VÉRIFIER** que `npm run db:generate`
  émet bien un `ALTER TABLE … ADD/DROP CONSTRAINT` propre pour le parent partitionné (et non
  un DDL cassé). Boucle de contrôle : la suite d'isolation applique les `.sql` **réels** sur
  PGlite (`beforeAll` split `--> statement-breakpoint`) → un DDL invalide **plante le
  `beforeAll`** immédiatement. Si drizzle-kit produit un SQL inadéquat pour le parent
  partitionné, **retoucher à la main** la migration générée (précédent assumé : 0003).

### 5.3 Fenêtre de déploiement (le vrai risque, non-données)

`migrate` PUIS `deploy` (règle 9). Entre les deux, l'ancien code (N-1) sert encore.

- **Expand (0018)** : ajoute la composite, **garde** la globale. Le N-1 (`ON CONFLICT` mono
  colonne) **fonctionne toujours** (globale intacte). ✅ backward-compat N-1.
- **Contract (0019)** : `DROP` la globale. S'il tourne **avant** que le code composite soit
  déployé, un `ON CONFLICT (omnifi_connection_id)` du N-1 lève « no unique constraint
  matching ON CONFLICT specification » → ingestion `500` pendant la fenêtre. ❌ **Interdit de
  jouer 0019 tant que le code composite n'est pas la version N-1 courante.**

C'est **la** raison d'un expand/contract séparé en deux releases (§6) — détaillé et arbitré
en §11.

---

## 6. Séquencement migrations (expand/contract, numérotation, journal)

**Prochain fichier disque** : `0018` (disque va `0000…0017`). **Prochain `idx` journal** :
`18` (le journal saute `idx 9` — `0009` est un **orphelin volontaire** listé dans
`ORPHELINS_AUTORISES`, `migrations-journal-coherence.test.ts:50`).

### Migration `0018_unique-composites-expand.sql` (idx 18)
`ALTER TABLE … ADD CONSTRAINT` des **3 composites**. Ne touche PAS les globales.

### Migration `0019_unique-composites-contract.sql` (idx 19)
`ALTER TABLE … DROP CONSTRAINT` des **3 globales** :
`bank_connections_omnifi_connection_id_unique`, `bank_accounts_omnifi_account_id_unique`,
`transactions_cache_omnifi_txn_unique` (noms réels, 0003:35/22/55).

### Contraintes de production (non négociables)
- **Générer via `npm run db:generate`** (drizzle-kit) — PAS à la main — pour que
  `meta/_journal.json` **et** les snapshots `meta/00xx_snapshot.json` restent cohérents
  (sauf retouche partition §5.2, à re-tester). Chaque `.sql` **doit** avoir son entrée
  journal, sinon `migrations-journal-coherence.test.ts` **rougit** (orphelin = appliqué par
  les tests, jamais par la prod = faux-vert structurel). **Ne PAS** ajouter 0018/0019 à
  `ORPHELINS_AUTORISES` : ce sont de vraies migrations, elles se journalisent.
- **Ordre pipeline** : `db:provision → migrate → deploy` (CLAUDE.md). Le provisioning ne
  change pas (§4), mais l'ordre reste.
- **Drift** : après 0019, `schema.ts` (composite only) == snapshot du journal → `db:check`
  vert.

---

## 7. Lots numérotés (unités de commit, règle 7)

> Les **lots L1–L3** forment le **PR expand** (release 1). **L4** = **PR contract** (release
> 2, après L1–L3 déployés & vérifiés). Découpage justifié en §5.3 / §11.

### L1 — Schéma : ajouter les 3 composites (sans retirer les globales)
- `schema.ts` : ajouter les 3 `unique(...)` composites en callback de table, **conserver**
  les `.unique()` inline / le `unique(...)` existant. Actualiser les commentaires
  d'hypothèse (233–237, 279–282).
- `npm run db:generate` → **`0018`**. Vérifier le SQL émis (partition §5.2). Journaliser.
- **Sortie** : `0018` applique 3 `ADD CONSTRAINT` ; les 6 contraintes coexistent ; `tsc`,
  `lint`, `db:check` verts.

### L2 — Code ingestion : basculer les 3 `onConflictDoUpdate` en inférence composite
- `ingestion.ts` : les 3 `target` du §4. **Rien d'autre** (les `set` restent identiques).
- **Sortie** : ingestion tourne sur la contrainte composite (elle existe depuis L1) ;
  idempotence intra-tenant préservée ; suites `ingestion-isolation` + `transactions-isolation`
  **vertes** (elles réappliquent 0018 depuis le disque).

### L3 — Preuve : suite d'isolation cross-tenant collision (§8)
- Nouveau fichier `tests/isolation/unique-composites-isolation.test.ts`.
- **Sortie** : la suite est **verte sur 0018+L2** et **rouge si on retire 0018** (preuve
  d'inversion). CI isolation bloquante passe.

> **PR expand = L1 + L2 + L3.** Human-in-the-Loop : **applicatif** (schéma/DB/RLS-adjacent)
> → l'agent s'arrête à la PR poussée, l'humain revoit (revue schéma contradictoire, règle 6)
> et merge. `migrate 0018` PUIS `deploy` code composite.

### L4 — Contract : retirer les 3 globales (release SUIVANTE)
- `schema.ts` : retirer `.unique()` inline (240, 285) + remplacer le `unique(...)` global
  (428) — ne laisser que les composites.
- `npm run db:generate` → **`0019`** (3 `DROP CONSTRAINT`). Journaliser.
- Contrôle pré-merge §5.1 (0 doublon). Test §8 **cas C4** (ré-activé/renforcé) : après
  contract, la collision cross-tenant **réussit** toujours (plus de globale résiduelle).
- **Sortie** : seules les composites subsistent ; `db:check` vert ; suites vertes.

> **PR contract = L4.** À merger **uniquement après** que le PR expand est **déployé et
> vérifié** en prod (le code composite est alors la version N-1 → 0019 est backward-compat,
> §5.3). Applicatif → Human-in-the-Loop.

---

## 8. Tests d'isolation — spécification de la preuve (BLOQUANT CI, règle 2/3)

**Fichier** : `tests/isolation/unique-composites-isolation.test.ts`. **Patron** : copier le
montage de `tests/isolation/ingestion-isolation.test.ts` (PGlite, migrations réelles depuis
le disque, seed 2 workspaces `WS_A`/`WS_B` + 2 membres, `tygr_app.sql`, `set role tygr_app`,
helper `prerequisCompte`, préconditions L7a + contre-preuve R1). La suite **réapplique
automatiquement `0018`/`0019`** (glob `.sql` trié).

### Cas à prouver

- **C1 — Collision CONNEXION cross-tenant AUTORISÉE.** `prerequisCompte(sessionA, "conn-X",
  "acc-A")` **puis** `prerequisCompte(sessionB, "conn-X", "acc-B")` → **les deux réussissent**
  (aujourd'hui le 2ᵉ lève `23505`/`42501` — c'est l'inversion). Puis : A ne voit **qu'une**
  `bank_connections` (la sienne), B **qu'une** (RLS) — jamais celle de l'autre.
- **C2 — Collision COMPTE cross-tenant AUTORISÉE.** Même `omnifi_account_id` sous A et B →
  deux lignes distinctes, chacune scopée ; `count` par tenant = 1.
- **C3 — Collision TRANSACTION cross-tenant AUTORISÉE.** `upsertTransactions` du **même**
  `omnifi_txn_id` **même** `transaction_date` sous A et B → deux lignes ; chaque tenant en
  voit exactement une (RLS partitions incluses).
- **C4 — Idempotence intra-tenant PRÉSERVÉE (garde-fou anti-régression).** Sous A
  uniquement : ré-`upsert` du même `omnifi_connection_id` / `omnifi_account_id` /
  `(omnifi_txn_id, transaction_date)` → **1 seule ligne**, champs **mis à jour** (réplique de
  l'assertion `DASH-DEDUP1`, `ingestion-isolation.test.ts:171`). Prouve que la composite
  **contraint toujours** par tenant (la permissivité ajoutée est *uniquement* cross-tenant).
- **C5 — Contre-preuve owner (R1).** Reprendre R1a/R1b : sous l'owner la RLS ne filtre pas ;
  sous `tygr_app` elle filtre. Garantit que C1–C3 ne « réussissent » pas par contournement RLS.
- **C6 — Précondition L7a** : `current_user = tygr_app` (anti faux-vert sous owner).

### Valeur d'inversion
C1/C2/C3 **échouent** sur le schéma **actuel** (globale) et ne passent qu'**après 0018+L2**
— exactement le patron « tests 13/14 inversés » du projet (TODOS §Entités). C4 empêche la
sur-correction (perte d'idempotence). **Aucun désaccord fabriqué** (règle 6) : la suite
teste un comportement réel et vérifiable.

---

## 9. Risques sécurité, angles morts & garde-fous

1. **[FUTUR — à graver] Résolveur webhook global.** Aujourd'hui **aucun** chemin ne résout
   `omnifi_connection_id → workspace_id` **hors** `withWorkspace` (pas de route webhook,
   §4). CLAUDE.md décrit pourtant un futur `/api/webhooks/omnifi` (rôle `tygr_service`,
   RLS-bypass, « SELECT 3 colonnes »). **Le jour où il sera écrit** : après le contract,
   `omnifi_connection_id` n'est plus unique **globalement** → un lookup par ce seul champ
   pourrait matcher **N workspaces** → mauvais routage de webhook (cross-tenant). **Garde-fou
   obligatoire** à imposer dès ce chantier : résoudre **d'abord** le tenant (via
   `ClientUserId`→workspace, unique global conservé §2.2) **puis** la connexion **dans** ce
   workspace — jamais `omnifi_connection_id` seul. **À consigner en tête du futur plan
   webhook + en commentaire de la colonne.** (Ne rien coder ici — anti-scope-creep.)
2. **[Fenêtre déploiement]** §5.3 — géré par l'ordre expand→(deploy)→contract. **Ne jamais
   collapser 0019 avant déploiement du code composite.**
3. **[drizzle-kit / partition]** §5.2 — DDL partitionné à vérifier ; filet = `beforeAll` des
   suites d'isolation (plante si SQL invalide).
4. **[Oracle résiduel]** tant que la globale existe (entre expand et contract), le DoS/oracle
   cross-tenant persiste. C'est **acceptable** (mono-tenant présent) mais **borne la valeur
   sécurité au contract** → ne pas laisser traîner L4 « un jour » : le raccrocher à la
   **bascule multi-tenant** (déclencheur nommé, règle 9).
5. **[PII/logs]** aucun changement de surface de log ; les identifiants Omni-FI ne sont pas
   des secrets bancaires, mais rester sur les codes machine existants (règle 8). Néant à faire.

---

## 10. HORS scope (frontières explicites — règle 7)

- **`#5` FK non composites** (TODOS.md:1669) : `bank_accounts.connection_id →
  bank_connections.id` (FK simple, non `(workspace_id, id)`). **Lié mais distinct.**
  Remarque utile : `bank_connections` **n'a pas** de `UNIQUE(id, workspace_id)** (contrairement
  à `bank_accounts`/`entities`/`categories`/`parties`) → une future FK composite
  `bank_accounts(connection_id, workspace_id) → bank_connections(id, workspace_id)`
  nécessiterait **d'abord** d'ajouter ce `UNIQUE(id, workspace_id)` sur `bank_connections`.
  **Non fait ici** (scope = les 3 uniques Omni-FI). Batchable avec ce chantier **si** l'humain
  le décide — je **recommande de garder le PR serré** (revue schéma plus simple).
- **`#6` `ON DELETE no action` sur `created_by`/`workspace_id`** (TODOS.md:1676) : sans
  rapport avec l'unicité.
- **Nettoyage d'index redondants** (P3, optionnel) : après la composite meneuse `workspace_id`,
  `bank_connections_workspace_id_idx` (0003:86) et `bank_accounts_workspace_id_idx` (0003:84)
  deviennent **couverts par préfixe** → suppressibles. **Non fait** (gain marginal, risque de
  perf à mesurer, hors sécurité). À tracer en P3 si on y touche.
- **`workspaces.omnifi_client_user_id` / `users.email`** : §2.2 — **restent globales** par
  correction, pas par oubli.
- **Élargir la clé txn à `bank_account_id`** : non — on garde `omnifi_txn_id` comme clé
  naturelle intra-workspace (préserve la sémantique d'idempotence #2) ; on ne fait qu'ajouter
  `workspace_id` en tête.

---

## 11. Arbitrages ouverts (l'humain tranche — règle 10)

**A. Découpage expand/contract : 2 PRs/2 releases (recommandé) vs 1 PR/2 migrations.**

- **Recommandé — 2 PRs** (L1–L3 puis L4) : élimine **totalement** la fenêtre §5.3. Coût :
  la globale redondante survit **une release** (bénéfice sécurité activé au contract). Aucun
  écart fonctionnel entre-temps (aucune collision cross-tenant réelle au mono-tenant présent).
- **Alternative — 1 PR, `0018`+`0019` ensemble + code** : plus court, mais `migrate` joue les
  deux (globale **droppée**) **avant** `deploy` → fenêtre de secondes où le N-1 (mono-colonne
  `ON CONFLICT`) plante toute ingestion. Probabilité **quasi nulle** au scale actuel
  (ingestion = clic manuel, mono-utilisateur), mais **viole** « backward-compat N-1 » à la
  lettre. **Non recommandé.**

→ **Ma reco : 2 PRs.** Confirmer, ou accepter la fenêtre.

**B. Inclure `#5` (FK composite `bank_accounts→bank_connections` + `UNIQUE(id, workspace_id)`
sur `bank_connections`) dans CE chantier ?** Reco : **non** (garder le PR serré) ; ouvrir un
chantier `fix/fk-composites` séparé qui **réutilisera** le `UNIQUE(id, workspace_id)` posé là.

**C. Timing du contract (L4).** Reco : le **raccrocher au déclencheur « onboarding du 2ᵉ
tenant »** (ou à la prochaine passe anti-dette) plutôt que de le jouer immédiatement — mais
**avant** toute mise en prod multi-tenant. À acter dans TODOS avec ce déclencheur.

---

## 12. Definition of Done

- [ ] `schema.ts` : 3 composites déclarées (L1) ; globales retirées (L4) ; commentaires
      d'hypothèse actualisés.
- [ ] `0018` (expand) et `0019` (contract) **générés par drizzle-kit**, journalisés
      (`migrations-journal-coherence` vert), DDL partition vérifié (§5.2).
- [ ] 3 `onConflictDoUpdate` mis à jour (L2) ; ingestion idempotente intra-tenant.
- [ ] `tests/isolation/unique-composites-isolation.test.ts` : C1–C6 verts ; **rouge** si on
      retire `0018` (preuve d'inversion) ; CI isolation bloquante passe.
- [ ] Suites existantes vertes (`ingestion-isolation`, `transactions-isolation`,
      `tombstone-delete-isolation`, `migrations-journal-coherence`).
- [ ] `lint` + `tsc --noEmit` + `build` verts (stop-loss, règle 5).
- [ ] Provisioning **inchangé** confirmé (aucun GRANT ajouté).
- [ ] Garde-fou webhook (§9.1) **consigné** (TODOS + commentaire) pour le futur `/api/webhooks/omnifi`.
- [ ] TODOS.md : 1.1 + 1.2 cochées (expand) ; L4/contract tracé avec déclencheur (arbitrage C).
- [ ] Human-in-the-Loop respecté : agent **s'arrête aux PRs poussées** (applicatif), humain
      revoit (revue schéma contradictoire) et merge ; `migrate` avant `deploy`.
```
