# Plan technique — Modèle Entités (Option B) au sein du tenant Groupe

> **Phase : CONCEPTION** (règle 1). Aucun code applicatif n'est écrit tant que ce plan
> n'est pas validé. Document de référence pour l'implémentation à venir.
>
> **Décision actée** (2026-06-19, validée CEO) : **Option B**. Le Workspace devient
> « Groupe Omnicane » (tenant unique) ; les **Entités** (BU : Sucrière, Énergie…) sont
> un **attribut** porté par les comptes (`entity_id`), pas une frontière de tenant.
>
> **Pourquoi** : contrainte métier « **1 credential maître = comptes de N entités** ».
> Une seule connexion bancaire remonte d'un coup les comptes de plusieurs entités. Si
> l'entité était un workspace isolé (Option A), connecter Absa depuis « Sucrière »
> ferait atterrir les comptes d'« Énergie » dans Sucrière (pollution cross-entité), car
> la frontière d'accès bancaire (credential) ne coïncide pas avec la frontière
> d'isolation (workspace). En Option B, la connexion vit dans le tenant unique et
> chaque compte est étiqueté `entity_id` → « 1 connexion = N entités » devient naturel.
>
> **Confirmé par la donnée réelle** : 35 connexions / 99 comptes pour un seul EndUser
> sandbox — le fan-out connexion→comptes ne respecte aucune frontière d'entité.

---

## 0. Principe directeur — DEUX étages de protection, pas un seul

Aujourd'hui l'isolation est à **un étage** : la RLS par `workspace_id` (anti-IDOR
cross-tenant, règle 2). Ce plan **conserve cet étage intact** et en **ajoute un second
À L'INTÉRIEUR** : un scope par entité.

```
Étage 1 — TENANT (inchangé, dur)     : workspace_id = Groupe Omnicane.
                                        RLS WITH CHECK : on n'écrit JAMAIS hors tenant.
                                        Garde anti-IDOR existante, NON touchée.
Étage 2 — ENTITÉ (nouveau, scopé)    : entity_id sur bank_accounts (+ dérivé sur
                                        transactions/balances). Filtre la VUE selon
                                        le périmètre du membre. Pas une frontière de
                                        tenant : « Vision Globale » la lève légitimement.
```

Invariant à ne jamais inverser : **l'entité ne remplace pas le tenant, elle s'ajoute
dessous.** Un bug de scope entité = une fuite intra-Groupe (grave mais pas cross-client) ;
un bug de tenant resterait, lui, un IDOR cross-client. On ne relâche RIEN de l'étage 1.

---

## 1. Modèle de données & migrations

### 1.1 Nouvelle table `entities`

```
entities
  id            uuid PK default gen_random_uuid()
  workspace_id  uuid NOT NULL → workspaces(id)          -- étage 1 (RLS)
  name          varchar(140) NOT NULL                    -- « Sucrière BU », « Énergie BU »
  code          varchar(40)  NULL                        -- code interne Omnicane (optionnel, pour mapping)
  is_active     boolean NOT NULL default true            -- archivage logique (jamais de DELETE)
  created_at    timestamptz NOT NULL default now()
  CONSTRAINT entities_id_workspace_unique UNIQUE (id, workspace_id)   -- pour FK composite
  CONSTRAINT entities_workspace_name_unique UNIQUE (workspace_id, name)
  RLS: tenant_isolation (POLITIQUE_TENANT, identique aux autres tables)
  index (workspace_id)
```

Pourquoi `UNIQUE (id, workspace_id)` : permet une **FK composite** depuis `bank_accounts`
garantissant qu'un compte ne référence qu'une entité **du même workspace** (même pattern
que `categories`/`transaction_categorizations` déjà en place, cf. cross-review #5).

### 1.2 Colonne `bank_accounts.entity_id`

```
ALTER TABLE bank_accounts ADD COLUMN entity_id uuid NULL;   -- NULL = « non assigné »
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_entity_workspace_fk
  FOREIGN KEY (entity_id, workspace_id) REFERENCES entities(id, workspace_id);
CREATE INDEX bank_accounts_entity_idx ON bank_accounts (workspace_id, entity_id);
```

- **`NULL` volontaire** (expand-safe) : à la découverte, un compte arrive **sans entité**
  (Omni-FI ne connaît pas les entités Omnicane). C'est un état légitime « à trier », pas
  une erreur. L'ingestion ne bloque jamais sur l'absence d'entité.
- **FK composite** `(entity_id, workspace_id)` : impossible de rattacher un compte à une
  entité d'un autre workspace (garanti en base, pas par convention).

### 1.3 transactions_cache / balance_history — PAS de colonne entity_id

Décision : **ne PAS dupliquer `entity_id` sur les transactions/soldes.** Le lien se fait
par **jointure** `transactions_cache.bank_account_id → bank_accounts.entity_id`. Raisons :
- Source unique de vérité (le rattachement compte→entité vit à UN endroit ; un compte
  réassigné ne demande pas un backfill massif des transactions).
- `transactions_cache` est append-only partitionné (#3bis) — y ajouter une colonne
  mutable (l'entité peut changer) serait à contre-courant de son immutabilité.
- Coût : une jointure de plus en lecture, indexée (`bank_accounts_entity_idx`). Acceptable.

### 1.4 Le mécanisme de TRI compte → entité (le cœur du sas)

Omni-FI ne fournit **pas** la ventilation par entité juridique. Trois sources de mapping,
par ordre de priorité, à câbler dans l'ingestion (`persisterConnexionEtComptes`) :

1. **Mapping automatique par règle** (si une convention fiable existe) : table
   `entity_mapping_rules (workspace_id, match_type, pattern, entity_id)` où `match_type ∈
   {account_name_prefix, iban_prefix, omnifi_account_id}`. À la découverte d'un compte, on
   applique la 1re règle qui matche → `entity_id` pré-rempli. **À confirmer avec toi** :
   existe-t-il une convention Omnicane (préfixe de nom, plage d'IBAN) fiable ? Sinon on
   saute cette source.
2. **Persistance de l'assignation manuelle** : une fois un compte assigné à une entité par
   un ADMIN (UI de tri), on **mémorise** `(omnifi_account_id → entity_id)` pour que les
   re-synchros futures conservent l'assignation (l'upsert ne réécrase PAS `entity_id` s'il
   est déjà posé — `onConflictDoUpdate` exclut `entity_id`).
3. **Fallback `NULL`** : aucun match → compte « non assigné », visible seulement par les
   ADMIN dans une file de tri. **Jamais** affiché dans une « Vision Entité » (un compte
   sans entité n'appartient à aucun périmètre d'entité).

**UI de tri (sas)** : un écran ADMIN « Comptes à assigner » listant les `entity_id IS NULL`,
avec un picker d'entité par compte. Server Action `assignerCompteEntiteAction` (gating
ADMIN, withWorkspace, valide que l'entité ∈ workspace). C'est le « sas » de ton Axe 1 —
mais **dans le tenant unique** (légal vis-à-vis de la RLS), pas entre workspaces isolés.

### 1.5 Migrations (ordre, expand-contract)

- `0008_entities.sql` : CREATE TABLE entities + RLS/FORCE/policy + index.
- `0009_bank-accounts-entity.sql` : ADD COLUMN entity_id (nullable) + FK composite + index.
- (optionnel selon réponse 1.4) `0010_entity-mapping-rules.sql`.
- Toutes **expand-safe** (colonnes nullable, tables neuves) → backward-compatible code N-1.
- Appliquées via `npm run db:migrate` (outillage livré #72). Sur base déjà migrée : direct.

### 1.6 Réponse explicite à tes deux axes

- **Axe 1 (sas hybride dans Option A)** : *écarté comme architecture de base.* Le sas est
  une bonne idée — on le GARDE (§1.4 UI de tri) — mais **dans le tenant unique d'Option B**,
  pas entre workspaces isolés. En Option A pure, le sas buterait sur : où vit la
  `bank_connection` (un seul credential pour N workspaces → duplication du secret), et
  comment un compte « passe » d'un workspace à l'autre sans violer le `WITH CHECK` RLS
  (impossible proprement). Donc : sas OUI, Option A NON.
- **Axe 2 (passage à Option B)** : *retenu.* C'est le « prix » correct — et il est plus
  faible qu'il n'y paraît : la RLS tenant **ne bouge pas**, on ajoute un scope, pas une
  refonte. Voir §2.

---

## 2. Sécurité & RLS — d'une isolation tenant à un scope entité intra-tenant

### 2.1 Ce qui NE change PAS (étage 1)

`POLITIQUE_TENANT` (`using`/`withCheck` sur `workspace_id` via
`current_setting('app.current_workspace_id')`) reste **identique** sur toutes les tables,
**y compris `entities`**. L'anti-IDOR cross-tenant est intact. La suite d'isolation IDOR
existante (bloquante CI) continue de passer sans modification.

### 2.2 Ce qui s'ajoute (étage 2) — un 3e GUC de scope entité

`withWorkspace` pose déjà 2 GUC transactionnels (`app.current_workspace_id`,
`app.current_user_id`). On en ajoute **un 3e** : `app.current_entity_scope`.

- **Valeur** : la liste des `entity_id` que le membre courant a le droit de voir, OU un
  sentinel « toutes » pour la Vision Globale. Concrètement, le plus simple et sûr en SQL :
  - Vision Globale (Group Auditor / ADMIN) : GUC **non posé / vide** → aucun filtre entité.
  - Vision Entité : GUC = liste d'UUID (CSV ou array littéral) → filtre actif.

- **Où le scope est-il défini ?** Nouvelle table de liaison membre↔entité :
  ```
  member_entity_scope
    workspace_id  uuid NOT NULL
    user_id       uuid NOT NULL
    entity_id     uuid NOT NULL → entities(id, workspace_id)  (FK composite)
    PRIMARY KEY (workspace_id, user_id, entity_id)
    RLS: tenant_isolation
  ```
  Un membre **sans** ligne dans `member_entity_scope` + rôle « global » = Vision Globale.
  Un membre **avec** des lignes = Vision Entité bornée à ces entités.

- **Comment le filtre s'applique** : deux options à trancher au moment de l'implémentation
  (les deux fonctionnent ; je recommande A pour la robustesse) :
  - **(A, recommandé) Policy RLS additionnelle « entity_scope »** sur `bank_accounts` :
    ```
    USING (
      entity_id IS NOT NULL AND (
        nullif(current_setting('app.current_entity_scope', true),'') IS NULL   -- Vision Globale
        OR entity_id = ANY (string_to_array(current_setting('app.current_entity_scope', true), ',')::uuid[])
      )
    )
    ```
    La RLS devient la garde **structurelle** du périmètre entité (même mécanisme éprouvé
    que le tenant). Un développeur qui oublie un `WHERE entity_id` ne crée PAS de fuite —
    la RLS rattrape. C'est l'invariant « fail-closed » appliqué à l'entité.
  - **(B) Filtre applicatif** dans les repositories (`WHERE entity_id = ANY(...)`). Plus
    simple à écrire mais repose sur la discipline du code (un oubli = fuite intra-Groupe).
    Écarté pour les lectures sensibles ; la RLS (A) est la bonne couche.

- **Transactions/soldes** : filtrés par jointure sur `bank_accounts` (qui porte la policy
  entity_scope) → le scope se propage **automatiquement** sans policy séparée sur les tables
  append-only. C'est l'avantage de ne pas dupliquer `entity_id` (§1.3).

### 2.3 Le piège à éviter (fail-closed)

- **Compte `entity_id IS NULL`** : en Vision Entité, la policy A ci-dessus le **masque**
  (le `entity_id IS NOT NULL` en tête). Un compte non trié n'apparaît dans AUCUN périmètre
  d'entité → pas de fuite par défaut. Seuls les ADMIN (Vision Globale) le voient, dans le sas.
- **GUC absent ≠ accès total par accident** : on doit décider que « GUC vide = Vision
  Globale » UNIQUEMENT pour les rôles autorisés. Sécurité : le GUC entity_scope est posé
  par `withWorkspace` à partir de `member_entity_scope` + rôle, **jamais** par un paramètre
  client. Un VIEWER sans scope explicite ne doit pas tomber en « voit tout » — voir §3.2.

### 2.4 Nouveaux cas pour la suite d'isolation (bloquante CI)

- Membre Vision Entité scopé sur Sucrière → lecture des comptes Énergie = **0 ligne**.
- Membre Vision Globale → voit toutes les entités du Groupe.
- Compte `entity_id NULL` → invisible en Vision Entité, visible en Vision Globale.
- Tentative d'assigner un compte à une entité d'un autre workspace → rejet (FK composite).
- Le tout SANS jamais franchir l'étage 1 (cross-tenant reste 0 ligne).

---

## 3. Contrôle des accès (RBAC) — UI & rôles

### 3.1 Rôles : étendre `workspace_members.role`

Le `role` actuel ∈ `{ADMIN, MANAGER, VIEWER}` (check CHECK en base). Deux profils
demandés se mappent ainsi :
- **« Group Auditor » / Vision Globale** : un rôle voyant tout le tenant, **sans** scope
  entité (aucune ligne `member_entity_scope`). Peut être `ADMIN` (déjà global) ou un
  nouveau rôle `GROUP_AUDITOR` (lecture seule globale — à trancher : nouveau rôle propre,
  recommandé, pour ne pas donner les droits d'écriture ADMIN à un auditeur).
- **« Vision Entité »** : un `VIEWER` (ou `MANAGER`) **avec** des lignes
  `member_entity_scope` → borné à ses entités.

Migration : étendre le CHECK `workspace_members_role_check` pour inclure `GROUP_AUDITOR`
si on retient le nouveau rôle. (Décision à confirmer §3.4.)

### 3.2 Comment l'UI consomme le filtre (fail-closed)

Principe : **l'UI ne décide RIEN du périmètre.** Le périmètre est posé côté serveur par
`withWorkspace` (GUC entity_scope), et la RLS l'applique. L'UI ne fait que **refléter** ce
que les Server Actions renvoient (déjà filtré). Conséquence :
- Le dashboard, `/transactions`, les graphiques appellent les mêmes Server Actions
  qu'aujourd'hui ; elles renvoient **automatiquement** le périmètre du membre (la RLS a
  filtré). Zéro logique de filtrage dans le `.tsx` (sinon risque de fuite si contournée).
- **Sélecteur d'entité** (pour un membre multi-entités) : un membre scopé sur 3 entités
  peut vouloir voir « toutes mes entités » ou « juste Sucrière ». L'UI propose un picker
  qui **restreint** le GUC entity_scope à un sous-ensemble de son périmètre autorisé —
  jamais l'élargir (le serveur intersecte toujours avec `member_entity_scope`).
- **Vision Globale** : un badge « Consolidation Groupe », pas de picker restrictif (ou un
  picker « toutes les entités » + possibilité de filtrer par entité pour explorer).

### 3.3 Consolidation (Vision Globale)

La consolidation par devise existe déjà (`soldesCourantsParDevise`, DASH-SOLDE1). En
Vision Globale, GUC entity_scope vide → la requête agrège **tout le tenant** = somme de
toutes les entités, par devise. **Gratuit** : aucune logique de consolidation nouvelle, la
levée du filtre entité suffit. (Le total cross-devise unique reste DASH-FX1, séparé.)

En Vision Entité, la même requête agrège **uniquement** les comptes des entités du
périmètre (la RLS a filtré) → le solde affiché est celui de l'entité. Même code, scope
différent.

### 3.4 Points à trancher avant implémentation (RBAC)

- Nouveau rôle `GROUP_AUDITOR` (lecture seule globale) **vs** réutiliser `ADMIN` ?
  *Recommandé : nouveau rôle*, pour ne pas confondre « voit tout » et « peut tout modifier ».
- La catégorisation (splits) est aujourd'hui ouverte à tous les membres (décision PO
  2026-06-17). En Vision Entité, doit-on borner la catégorisation au périmètre entité ?
  (probablement oui — un membre Sucrière ne catégorise pas les transactions d'Énergie).

---

## 4. Texte pour CLAUDE.md (section Tribal Knowledge)

> À insérer dans `CLAUDE.md` après validation + implémentation (pas avant — le texte décrit
> un invariant qui doit être vrai dans le code). Proposition :

```markdown
## Architecture multi-entités — tenant Groupe + scope entité (2026-06-19)

Le Workspace = un GROUPE (« Omnicane »), pas une entité. Les ENTITÉS (BU) sont un
ATTRIBUT (`bank_accounts.entity_id`), jamais une frontière de tenant. Raison métier
NON négociable : **1 credential bancaire maître = comptes de N entités** (une connexion
remonte d'un coup les comptes de plusieurs BU). Faire de l'entité un workspace isolé
(Option A) polluerait un workspace avec les comptes d'autres entités à l'ingestion — la
frontière d'accès bancaire (credential) ne coïncide pas avec la frontière d'entité.

DEUX étages d'isolation, à ne JAMAIS confondre ni inverser :
- **Étage 1 — TENANT (dur)** : RLS `workspace_id` (POLITIQUE_TENANT). Anti-IDOR
  cross-client. INCHANGÉ par le multi-entités. Une fuite ici = cross-client (critique).
- **Étage 2 — ENTITÉ (scopé)** : policy RLS `entity_scope` sur `bank_accounts` via le GUC
  `app.current_entity_scope` (posé par `withWorkspace` depuis `member_entity_scope` + rôle,
  JAMAIS un paramètre client). « Vision Entité » = GUC = liste d'entités ; « Vision Globale »
  (Group Auditor) = GUC vide = tout le tenant. Une fuite ici = intra-Groupe (grave, pas
  cross-client). Les transactions/soldes héritent du scope par JOINTURE sur bank_accounts
  (pas de duplication d'entity_id sur l'append-only).

Invariants :
- Un compte `entity_id IS NULL` (non trié) est INVISIBLE en Vision Entité (fail-closed) ;
  seul l'ADMIN le voit dans le sas d'assignation. L'ingestion ne pose jamais entity_id
  automatiquement sans règle de mapping fiable — sinon NULL (à trier).
- Omni-FI ne fournit PAS la ventilation par entité : le rattachement compte→entité est
  posé par un SAS (UI ADMIN) ou une règle de mapping, et MÉMORISÉ (l'upsert de re-synchro
  ne réécrase jamais un entity_id déjà assigné).
- Le filtre de périmètre vit dans la RLS (fail-closed), JAMAIS dans le .tsx : un oubli de
  WHERE ne doit pas pouvoir créer une fuite intra-Groupe.
```

---

## 5. Découpage en PRs (implémentation à venir, après validation)

1. **PR-E1 — Schéma entités** : migrations 0008/0009 (table `entities` + `entity_id`
   nullable + FK composite + RLS) + repository `entities` + tests isolation (entité ∈
   workspace). Pas d'UI. Contract-first.
2. **PR-E2 — Scope RLS entité** : table `member_entity_scope`, GUC `app.current_entity_scope`
   posé dans `withWorkspace`, policy `entity_scope` sur `bank_accounts`, cas IDOR entité
   ajoutés à la suite bloquante. Le cœur sécurité.
3. **PR-E3 — Sas d'assignation** : UI ADMIN « Comptes à assigner » + `assignerCompteEntiteAction`
   + (optionnel) règles de mapping auto. Ingestion : `entity_id` préservé au re-sync.
4. **PR-E4 — RBAC & UI Vision Entité/Globale** : rôle `GROUP_AUDITOR`, sélecteur d'entité,
   badges, consolidation (réutilise soldesCourantsParDevise sous scope). Mise à jour CLAUDE.md.

Chaque PR : exit-criteria règle 3 (authz, zod, IDOR, tests, logs), Visual QA pour les PR UI,
cross-review contradictoire pour PR-E2 (sécurité). Migrations expand-safe, `db:migrate`.

---

## 6. Questions ouvertes (à trancher avec toi avant PR-E1)

1. **Règle de mapping auto compte→entité** : existe-t-il une convention Omnicane fiable
   (préfixe de nom de compte, plage IBAN, code) ? Si oui → on câble le mapping auto (§1.4.1).
   Si non → tout passe par le sas manuel au départ.
2. **Rôle Group Auditor** : nouveau rôle `GROUP_AUDITOR` (lecture seule globale, recommandé)
   ou réutiliser `ADMIN` ?
3. **Périmètre d'écriture en Vision Entité** : la catégorisation (splits) doit-elle être
   bornée au périmètre entité du membre ? (recommandé : oui).
4. **Un compte peut-il appartenir à PLUSIEURS entités ?** — **TRANCHÉ (2026-06-19,
   provisoire) : 1 compte → 1 entité** (ou NULL). Le cas multi-entités (trésorerie
   mutualisée / cash-pooling) n'est pas confirmé côté métier ; on ne surdimensionne pas.
   `entity_id` reste une **colonne** sur `bank_accounts` (§1.2). **Voie d'évolution
   balisée** si le besoin apparaît : migration colonne → table de liaison `account_entity`
   (N-N) ; comme `entity_id` est nullable et lu via la policy/jointure, le passage est
   localisé (la colonne devient dérivée d'une vue, ou on migre les lignes existantes vers
   la table de liaison 1:1 puis on autorise le N). À RE-trancher AVANT PR-E1 seulement si
   tu confirmes entre-temps que des comptes mutualisés existent. **Action : valider le cas
   réel auprès d'Omnicane.**
```
