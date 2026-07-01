# Plan — Gestion des Entités (Option B : multi-entités sous Workspace « Groupe »)

> **Phase : PLANIFICATION UNIQUEMENT** (CLAUDE.md règle 1). Aucun code de production
> ni test n'est produit par ce document. Il attend une **validation formelle** avant
> la phase d'Implémentation.
>
> **Historique** : réécrit le 2026-06-22 (remplace la version de conception du
> 2026-06-19). La réécriture **aligne le plan sur les arbitrages PO du 2026-06-22**
> et **retient la meilleure idée de la version précédente** : le filtre de périmètre
> entité est une **garde RLS structurelle** (3ᵉ GUC), pas un filtre applicatif.

- **Auteur** : Architecte Back-end (frontière gouvernance : serveur + contrat + DB).
- **Décision amont** : Option B actée (`ROADMAP-OMNICANE.md` §1-2) — UN workspace
  « Groupe Omnicane », entités = niveau SOUS le workspace. Contrainte structurante :
  **1 connexion bancaire = N entités** (confirmée par la donnée sandbox : un EndUser
  a un fan-out connexion→comptes qui ne respecte aucune frontière d'entité).

### Arbitrages tranchés avec le PO (2026-06-22)

1. **Entité = découpage interne pur.** `entities` est propriété TYGR. On **ignore
   `PartyId`/`PartyName` Omni-FI au MVP** (découverte doc API §0.1). Pré-remplissage
   via les Parties = **dette P2** (ENTITY-PARTY1), PAS une dette d'isolation.
2. **Liaison membre↔entité en N:N** : table `member_entity_scopes`. Un membre borné
   peut couvrir **plusieurs** entités ; **aucune ligne = Vision Globale**.
3. **Filtre de périmètre entité = policy RLS structurelle + GUC** (PO 2026-06-22) :
   `withWorkspace` pose un 3ᵉ GUC `app.current_entity_scope` ; une policy RLS
   `entity_scope` sur `bank_accounts` l'applique (fail-closed — un oubli de `WHERE`
   ne crée pas de fuite intra-groupe). **Conséquence** : le filtrage des lectures
   entre dans CE chantier (pas de découpage en 2 incréments).

### Recommandation Backend en attente d'arbitrage (un seul point ouvert)

- **Rôle « Vision Globale » : ne PAS créer `GROUP_AUDITOR` au MVP** (recommandé,
  §3.3). Cohérent avec l'arbitrage « Vision Entité = un membre scopé, pas un rôle » :
  un membre **sans** ligne de scope = Vision Globale. Créer un rôle toucherait l'enum
  `WORKSPACE_ROLES`, le CHECK constraint, la suite IDOR et le JWT — surface plus large
  pour un bénéfice nul au MVP. Si une « lecture seule globale stricte » devient
  nécessaire (auditeur qui ne doit RIEN modifier), c'est un incrément ultérieur balisé
  (§3.3). **À confirmer en validation.**

---

## 0. Pushback & angles morts traités AVANT le plan (règle 10)

### 0.1 — Omni-FI a une notion de « Partie » (TRANCHÉ → ignorée au MVP)
`docs/documentation_api.md` l.797-810 : `GET /parties/{PartyId}/accounts`, « Entités
légales (sociétés, individus) regroupant plusieurs comptes ». `OBReadAccount6`
(l.777-780) porte `PartyId`, `PartyName`, `OwnershipType` (`BUSINESS`, `TRUST`…).

- **Risque si on s'y alignait** : coupler le socle Entités à une garantie API **non
  vérifiée en sandbox** (PartyId potentiellement null/incohérent → comptes non
  assignés en masse). Même classe de piège que les hypothèses d'unicité
  `omnifi_connection_id`/`omnifi_account_id` déjà documentées dans le schéma.
- **Décision PO** : **découpage interne pur**. Assignation `compte → entité` MANUELLE
  (sas, §1.4). On **ne lit pas** `PartyId` au MVP.
- **Dette P2 (ENTITY-PARTY1)** : persister `party_id`/`party_name` à l'ingestion pour
  **pré-proposer** un regroupement au sas plus tard. Déclencheur : retour terrain
  « trop de saisie » + preuve sandbox que les Parties sont peuplées de façon fiable.

### 0.2 — `bank_accounts.entity_id` NULLABLE (TRANCHÉ → oui, expand-safe)
Les 260+ transactions / les comptes déjà ingérés sont sans entité. Une colonne
`NOT NULL` casserait la migration et l'ingestion existante (`upsertCompte`,
`ingestion.ts:101`). → `entity_id` **nullable** = « compte non assigné », dégradé
proprement par l'UI (même pattern que `institution_name` nullable). Backward-
compatible code N-1 (expand-contract, règle 9).

### 0.3 — DEUX étages d'isolation, à ne jamais inverser (cadrage structurant)
```
Étage 1 — TENANT (dur, INCHANGÉ)  : RLS workspace_id (POLITIQUE_TENANT).
                                     Anti-IDOR cross-client. Une fuite ici = critique.
Étage 2 — ENTITÉ (nouveau, scopé) : policy RLS entity_scope sur bank_accounts via le
                                     GUC app.current_entity_scope (posé par
                                     withWorkspace depuis member_entity_scopes, JAMAIS
                                     un paramètre client). Une fuite ici = intra-groupe
                                     (grave, pas cross-client).
```
**L'entité ne remplace pas le tenant, elle s'ajoute dessous.** On ne relâche RIEN de
l'étage 1 ; la suite IDOR existante continue de passer inchangée.

---

## 1. Architecture de la base de données (Option B)

### 1.1 Vue d'ensemble
```
workspaces (UN tenant « Groupe Omnicane », frontière RLS inchangée)
├─ workspace_members (user ↔ workspace, rôle)                  [existant, RLS]
│   └─ member_entity_scopes (user ↔ entity, NOUVEAU, RLS)      ← Vision Entité (N:N)
├─ entities (NOUVEAU, RLS scopée workspace)                    ← Sucrière, Énergie…
├─ bank_connections (1 credential = 1 banque)                 [existant, RLS]
│   └─ bank_accounts (+ entity_id NULLABLE, NOUVELLE colonne + policy entity_scope)
│       ├─ transactions_cache  (hérite le scope par JOINTURE)  [existant, partitionné]
│       └─ balance_history     (hérite le scope par JOINTURE)  [existant]
```
**`entity_id` vit UNIQUEMENT sur `bank_accounts`.** Transactions et soldes héritent de
l'entité **par jointure** sur leur compte — on ne dénormalise PAS `entity_id` dans
`transactions_cache`/`balance_history` : (1) elles sont append-only/partitionnées,
(2) réassigner un compte ne doit pas réécrire l'historique. Le scope entité se propage
donc **automatiquement** aux transactions/soldes via la policy posée sur
`bank_accounts` (jointure) — avantage direct de ne pas dupliquer la colonne (§2.4).

### 1.2 Table `entities` (NOUVELLE)
| Colonne        | Type                    | Contraintes / notes                                   |
|----------------|-------------------------|-------------------------------------------------------|
| `id`           | `uuid` PK               | `defaultRandom()`                                     |
| `workspace_id` | `uuid` NOT NULL         | FK → `workspaces.id` ; frontière tenant (étage 1)    |
| `name`         | `varchar(120)` NOT NULL | « Sucrière BU », « Énergie BU »                       |
| `code`         | `varchar(40)` NULL      | code interne Omnicane optionnel (mapping futur)       |
| `is_active`    | `boolean` NOT NULL      | `default true` — archivage logique (jamais de DELETE applicatif) |
| `created_at`   | `timestamptz` NOT NULL  | `defaultNow()`                                        |

- `UNIQUE (id, workspace_id)` → **cible des FK composites scopées** (pattern
  `categories_id_workspace_unique`, schema l.386). Obligatoire pour exiger en base
  qu'une entité référencée appartienne au même workspace.
- `UNIQUE (workspace_id, name)` → pas deux entités homonymes dans un groupe.
- `INDEX (workspace_id)`.
- **RLS** : `pgPolicy("tenant_isolation", POLITIQUE_TENANT)` + `.enableRLS()` ;
  `FORCE RLS` par migration custom (drizzle-kit ne l'émet pas, cf. 0001/0003).

### 1.3 Colonne `bank_accounts.entity_id` (NOUVELLE, table existante)
| Colonne     | Type            | Contraintes / notes                          |
|-------------|-----------------|----------------------------------------------|
| `entity_id` | `uuid` NULLABLE | NULL = « compte non assigné »                |

- **FK COMPOSITE scopée workspace** (cœur de l'isolation intra-groupe) :
  `FOREIGN KEY (entity_id, workspace_id) REFERENCES entities(id, workspace_id) ON DELETE RESTRICT`.
  Reproduit `txn_categorizations_category_workspace_fk` (schema l.453). Une `entity_id`
  d'un autre tenant devient **impossible** en base.
- `ON DELETE RESTRICT` (jamais cascade) : effacer une entité référencée échoue ;
  l'app **archive** (`is_active=false`).
- `INDEX (workspace_id, entity_id)`.
- **Migration expand** : `ADD COLUMN entity_id uuid` nullable d'abord, FK en
  `ADD CONSTRAINT` séparé. `bank_accounts` n'est **pas** partitionnée (seule
  `transactions_cache` l'est) → `ADD COLUMN` direct.

### 1.4 Table `member_entity_scopes` (NOUVELLE — N:N membre ↔ entité)
Borne un membre « Vision Entité » à ≥1 entités. **Aucune ligne pour un (user,
workspace) = Vision Globale** (voit tout le workspace = consolidation naturelle).

| Colonne        | Type            | Contraintes / notes                          |
|----------------|-----------------|----------------------------------------------|
| `workspace_id` | `uuid` NOT NULL | FK → `workspaces.id` ; frontière tenant + RLS |
| `user_id`      | `uuid` NOT NULL | (FK composite ci-dessous)                    |
| `entity_id`    | `uuid` NOT NULL | (FK composite ci-dessous)                    |

- `PRIMARY KEY (workspace_id, user_id, entity_id)` → idempotence, pas de doublon.
- **FK composite membership** : `(user_id, workspace_id) → workspace_members(user_id,
  workspace_id) ON DELETE CASCADE`. On ne scope QUE des membres réels ; retirer un
  membre **purge ses scopes** (cascade **légitime** : table de droits, NON append-only).
- **FK composite entité** : `(entity_id, workspace_id) → entities(id, workspace_id)
  ON DELETE RESTRICT`. Même garantie cross-tenant que §1.3.
- `INDEX (workspace_id, user_id)` → résolution du scope à la session.
- **RLS** : `tenant_isolation` (`POLITIQUE_TENANT`) + `.enableRLS()` + FORCE.

### 1.5 Le « sas » d'assignation compte → entité (MANUEL au MVP)
Omni-FI **ne connaît pas** les entités Omnicane (§0.1). L'assignation est explicite :
- `assignerCompteEntite(tx, ctx, { bankAccountId, entityId | null })` :
  `UPDATE bank_accounts SET entity_id = … WHERE id = … AND workspace_id = ctx.workspaceId`
  (RLS + filtre explicite, défense en profondeur). `entityId = null` → repasse le
  compte en « non assigné ». 0 ligne → `CompteIntrouvableError` (404). La **FK
  composite** garantit le bon workspace (inutile de re-vérifier en SQL applicatif).
- **Persistance au re-sync** : l'upsert d'ingestion (`upsertCompte`,
  `ingestion.ts:118`) **ne doit JAMAIS réécraser** `entity_id` (l'exclure du
  `onConflictDoUpdate.set`). Un compte assigné le RESTE après re-synchro.
  ⚠️ C'est une **modification ciblée de `ingestion.ts`** (le `set` actuel n'inclut pas
  `entity_id`, donc l'omission est déjà correcte — à **vérifier et garder** en
  implémentation, pas à introduire). Aucune pré-assignation automatique au MVP.
- **UI sas** (rôle Front) : écran ADMIN « Comptes à assigner » listant `entity_id IS
  NULL`, picker d'entité par compte → `assignerCompteEntite`.

### 1.6 Migration `0008_entities.sql` — séquencement (expand-contract, règle 9)
Générée par `drizzle-kit generate` puis **complétée à la main** (FORCE RLS + policy
`entity_scope` + ordre des contraintes — drizzle-kit ne sait pas émettre FORCE ni une
policy custom au GUC). Ordre **non négociable** :
1. `CREATE TABLE entities` + `ENABLE ROW LEVEL SECURITY`.
2. `CREATE TABLE member_entity_scopes` + `ENABLE ROW LEVEL SECURITY`.
3. `ALTER TABLE bank_accounts ADD COLUMN entity_id uuid;` (nullable, sans FK — N-1 OK).
4. `ADD CONSTRAINT` des trois FK composites.
5. `CREATE POLICY tenant_isolation` sur `entities` et `member_entity_scopes` (verbatim
   le `nullif` fail-closed des migrations existantes).
6. **`CREATE POLICY entity_scope ON bank_accounts`** (le 2ᵉ étage, §2.2) — policy
   PERMISSIVE additionnelle, en plus de `tenant_isolation` déjà présente.
7. `FORCE ROW LEVEL SECURITY` sur `entities` et `member_entity_scopes`.
8. **Index** (entities ws ; bank_accounts (ws, entity_id) ; member_entity_scopes (ws,
   user_id)).

Pas de partition, pas de trigger no-delete (aucune de ces tables n'est append-only).

### 1.7 Mise à jour `drizzle/provisioning/tygr_app.sql`
Ajouter `entities` et `member_entity_scopes` à la **liste blanche DELETE** (étape 5,
`FOREACH t IN ARRAY[...]`), avec justification inline : référentiel/droits éditables,
**NON append-only**. **Interdiction reconduite** (#3bis) : ne JAMAIS y ajouter
`transactions_cache`/`balance_history`/`categorization_audit`. Aucune nouvelle table
ne reçoit de trigger no-delete.

### 1.8 Récapitulatif des garanties d'isolation
| Table                   | RLS tenant | Policy entity_scope | FK composite scopée                          | DELETE |
|-------------------------|------------|---------------------|----------------------------------------------|--------|
| `entities`              | ✅ + FORCE | —                   | `UNIQUE(id, ws)` (cible)                     | liste blanche |
| `bank_accounts` (col.)  | ✅ (déjà)  | ✅ (NOUVELLE)       | `(entity_id, ws) → entities`                 | déjà   |
| `member_entity_scopes`  | ✅ + FORCE | —                   | `(user_id, ws)→members` + `(entity_id, ws)→entities` | liste blanche |

**Triple garantie** : (1) RLS tenant fail-closed `nullif`, (2) FK composites scopées
(entité/membre d'un autre tenant = impossible), (3) policy `entity_scope` fail-closed
pour le périmètre intra-groupe, pilotée par un GUC posé depuis le contexte serveur.

---

## 2. Sécurité & RLS — du tenant au scope entité intra-tenant

### 2.1 Ce qui NE change PAS (étage 1)
`POLITIQUE_TENANT` (using/withCheck sur `workspace_id`) **identique** sur toutes les
tables, y compris les nouvelles. La suite d'isolation IDOR existante (bloquante CI)
passe sans modification. L'anti-IDOR cross-tenant est intact.

### 2.2 Ce qui s'ajoute (étage 2) — 3ᵉ GUC + policy `entity_scope`
`withWorkspace` pose déjà 2 GUC transactionnels (`app.current_workspace_id`,
`app.current_user_id`). On ajoute **un 3ᵉ** : `app.current_entity_scope`.

- **Valeur** (posée par `withWorkspace`, JAMAIS par un paramètre client) :
  - **Vision Globale** : GUC **vide/non posé** → aucun filtre entité.
  - **Vision Entité** : GUC = liste d'UUID (CSV) = les entités autorisées du membre.
- **Policy RLS additionnelle `entity_scope` sur `bank_accounts`** (PERMISSIVE, en plus
  de `tenant_isolation`) :
  ```sql
  USING (
    nullif(current_setting('app.current_entity_scope', true), '') IS NULL          -- Vision Globale
    OR (
      entity_id IS NOT NULL
      AND entity_id = ANY (
        string_to_array(current_setting('app.current_entity_scope', true), ',')::uuid[]
      )
    )
  )
  ```
  La RLS devient la garde **structurelle** du périmètre entité (même mécanisme éprouvé
  que le tenant) : un développeur qui oublie un `WHERE entity_id` **ne crée pas de
  fuite** — la RLS rattrape (fail-closed).
- **`WITH CHECK`** : la policy `entity_scope` est en lecture (`FOR SELECT`) ; les
  ÉCRITURES sur `bank_accounts` (assignation) restent gouvernées par `tenant_isolation`
  (WITH CHECK workspace) + la garde ADMIN applicative. On ne veut PAS qu'un membre en
  Vision Entité restreinte puisse échapper au scope en écrivant — mais l'assignation
  est ADMIN-only (Vision Globale par construction), donc pas de conflit. **À acter en
  cross-review** : `entity_scope` en `FOR SELECT` uniquement.
- **Transactions/soldes** : filtrés **par jointure** sur `bank_accounts` (qui porte la
  policy) → le scope se propage sans policy séparée sur les tables append-only/
  partitionnées. C'est l'avantage de ne pas dupliquer `entity_id` (§1.1).

### 2.3 Pièges fail-closed
- **Compte `entity_id IS NULL`** : en Vision Entité, la policy le **masque** (le
  `entity_id IS NOT NULL` dans la branche scopée). Un compte non trié n'apparaît dans
  AUCUN périmètre d'entité → pas de fuite par défaut. Seuls les ADMIN (Vision Globale)
  le voient, dans le sas.
- **GUC absent ≠ accès total par accident** : « GUC vide = Vision Globale » n'est
  appliqué que parce que `withWorkspace` **a calculé** que ce membre n'a aucun scope
  (`member_entity_scopes` vide). Le GUC est dérivé du contexte (`ctx.userId`,
  `ctx.workspaceId`), **jamais** d'un paramètre. Un membre scopé reçoit toujours son
  CSV → il ne peut pas « tomber en Vision Globale » par omission.
- **Sélecteur d'entité côté UI** : un membre scopé sur 3 entités peut vouloir n'en voir
  qu'une. L'UI peut **restreindre** le GUC à un sous-ensemble de son périmètre autorisé
  — `withWorkspace` **intersecte toujours** la demande avec `member_entity_scopes`
  (jamais d'élargissement). Détail d'implémentation tracé, pas au MVP si non requis.

### 2.4 `withWorkspace` — modification ciblée (surface sensible, cross-review obligatoire)
- Après la pose des 2 GUC existants et la re-validation de la membership, ajouter :
  1. lecture de `member_entity_scopes` pour `(userId, activeWorkspaceId)` ;
  2. si ≥1 ligne → `set_config('app.current_entity_scope', <csv des entity_id>, true)` ;
     si 0 ligne → ne PAS poser le GUC (Vision Globale).
- **Paramétré** (`set_config(..., true)`), jamais d'interpolation de chaîne (règle 2).
- `WorkspaceContext` est enrichi d'un champ lisible (ex. `entityScope: string[] |
  "GLOBAL"`) pour les repositories qui veulent le connaître, **sans** que ce champ soit
  la source de l'autorité (l'autorité est la RLS).
- **Coût/risque** : `withWorkspace` est le point névralgique anti-IDOR — toute
  modification passe par une **cross-review contradictoire** (règle 6) + ajout de cas à
  la suite d'isolation (§4.3). C'est la raison du choix « policy RLS » : la garde reste
  dans la couche qui a déjà fait ses preuves.

### 2.5 Nouveaux cas pour la suite d'isolation (bloquante CI) — voir §4.3.

---

## 3. Contrôle d'accès (RBAC) — rôles & contrats

### 3.1 Pas de nouveau rôle au MVP (recommandé, à confirmer)
`WORKSPACE_ROLES` reste `{ADMIN, MANAGER, VIEWER}` (enum + CHECK inchangés).
- **Vision Globale** = un membre **sans** ligne `member_entity_scopes` (typiquement
  ADMIN/MANAGER, ou un VIEWER non scopé).
- **Vision Entité** = un membre (souvent VIEWER) **avec** des lignes `member_entity_scopes`.
- **Gestion des entités/scopes** = **ADMIN-only** (garde `ctx.role === "ADMIN"`, même
  pattern que le provisioning).

Justification du « pas de `GROUP_AUDITOR` » : créer un rôle toucherait l'enum, le CHECK
`workspace_members_role_check`, le JWT et la suite IDOR — surface large pour un bénéfice
nul au MVP (un VIEWER non scopé voit déjà tout en lecture). **Voie balisée** si une
« lecture seule globale stricte » est exigée plus tard : ajout d'un rôle dédié en
incrément séparé (migration enum + CHECK + cas IDOR), pas maintenant.

### 3.2 Périmètre d'ÉCRITURE en Vision Entité (à trancher — recommandé : oui, plus tard)
La catégorisation (splits) est aujourd'hui ouverte à tous les membres (décision PO
2026-06-17). Question : un membre Vision Entité doit-il être **empêché** de catégoriser
les transactions d'une autre entité ? En l'état, la policy `entity_scope` sur
`bank_accounts` **masque déjà en lecture** les transactions hors périmètre (par
jointure) — un membre scopé ne **voit** pas les transactions d'Énergie, donc ne peut
pas les cibler par l'UI. Le verrouillage en **écriture** dur (refus serveur même si
l'ID est forgé) est un **durcissement** recommandé mais **séparé** (dette
ENTITY-WRITE-SCOPE1, P1) — il touche `categorisation.ts`, hors périmètre du socle.

### 3.3 Arborescence des Server Actions (calquée sur `admin/membres`)
Frontière P0-a : les actions importent depuis `@/server/db` (ré-export), jamais
`@/server/repositories/*` en direct.
```
src/app/(workspace)/admin/entites/actions.ts   ("use server")
  • creerEntite(formData)            ADMIN
  • renommerEntite(formData)         ADMIN
  • archiverEntite(formData)         ADMIN
  • assignerCompteEntite(formData)   ADMIN   ← sas §1.5
  • definirScopesMembre(formData)    ADMIN   ← Vision Entité §1.4
  (page.tsx + UI sas/sélecteur = rôle Front)
```
Repository `src/server/repositories/entites.ts` (NOUVEAU) — fonctions `(tx, ctx, …)`
exécutées DANS `withWorkspace` :
```
listerEntites(tx, ctx)                                  → EntiteLue[]
creerEntite(tx, ctx, { name, code? })                   → { entityId }   [ADMIN]
renommerEntite(tx, ctx, { entityId, name })             → void           [ADMIN]
archiverEntite(tx, ctx, entityId)                       → void           [ADMIN]
assignerCompteEntite(tx, ctx, { bankAccountId, entityId|null }) → void   [ADMIN]
listerScopesMembre(tx, ctx, userId)                     → string[]       [ADMIN]
definirScopesMembre(tx, ctx, { userId, entityIds[] })   → void           [ADMIN]
```
Le rôle vient du **contexte** (re-résolu à chaque requête) ; `workspace_id` n'est
JAMAIS un paramètre (= `ctx.workspaceId`).

---

## 4. Contrats d'API & typage

### 4.1 Schémas Zod (stricts, règle 3) — bornes alignées sur le schéma DB
```ts
const entiteCreerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(40).optional(),
}).strict();

const renommerEntiteSchema = z.object({
  entityId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
}).strict();

const archiverEntiteSchema = z.object({ entityId: z.string().uuid() }).strict();

const assignerCompteSchema = z.object({
  bankAccountId: z.string().uuid(),
  entityId: z.string().uuid().nullable(),   // null = « non assigné »
}).strict();

const definirScopesSchema = z.object({
  userId: z.string().uuid(),
  entityIds: z.array(z.string().uuid()).max(200),   // [] = Vision Globale ; borne anti-abus
}).strict();
```

### 4.2 Sorties typées (contrats lus par le Front, possédés par le Backend)
```ts
export interface EntiteLue {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
  nbComptes: number;   // agrégat scopé (comptes assignés à cette entité)
}
/** Décrit le périmètre du membre courant (lisible ; l'autorité reste la RLS). */
export type ScopeEntite =
  | { mode: "GLOBALE" }
  | { mode: "ENTITES"; entityIds: string[] };
```

### 4.3 Registre d'erreurs nommées (règle 3, non-énumérantes → 404, jamais 403)
| Classe                     | `code`                   | Sens                                      |
|----------------------------|--------------------------|-------------------------------------------|
| `EntiteNonAutoriseError`   | `ENTITY_NOT_AUTHORIZED`  | acteur non-ADMIN (msg générique)          |
| `EntiteIntrouvableError`   | `ENTITY_NOT_FOUND`       | entité absente du workspace courant       |
| `CompteIntrouvableError`   | `BANK_ACCOUNT_NOT_FOUND` | compte absent du workspace courant        |
| `EntiteNomDupliqueError`   | `ENTITY_NAME_DUPLICATE`  | `UNIQUE(workspace_id, name)` violée       |
| `MembreNonScopableError`   | `MEMBER_NOT_IN_WORKSPACE`| userId visé n'est pas membre du workspace |

Catch-all silencieux **interdit** ; toute autre exception remonte (mappée 500, comme
`UnsafeDatabaseRoleError`).

---

## 5. Ajouts exacts à `CLAUDE.md` (savoir tribal)

À insérer **après** « Intégrité append-only des tables financières » et **avant**
« Tribal Knowledge & Quality Gates ». Bloc prêt à coller (le texte décrit un invariant
qui sera vrai après implémentation) :

```markdown
## Entités multi-tenant (Option B — entités sous le Workspace, 2026-06-22)

Le Workspace = un GROUPE (« Omnicane »), pas une entité. Les ENTITÉS (BU) sont un
niveau SOUS le workspace (`entities` + `bank_accounts.entity_id`), JAMAIS une frontière
de tenant. Raison métier non négociable : **1 credential bancaire = comptes de N
entités** (une connexion remonte d'un coup les comptes de plusieurs BU). L'Option A
(entité = workspace isolé) polluerait un workspace avec les comptes d'autres entités à
l'ingestion.

DEUX étages d'isolation, à ne JAMAIS confondre ni inverser :
- **Étage 1 — TENANT (dur)** : RLS `workspace_id` (POLITIQUE_TENANT). Anti-IDOR
  cross-client. INCHANGÉ par le multi-entités. Fuite ici = cross-client (critique).
- **Étage 2 — ENTITÉ (scopé)** : policy RLS `entity_scope` sur `bank_accounts` via le
  GUC `app.current_entity_scope` (posé par `withWorkspace` depuis `member_entity_scopes`,
  JAMAIS un paramètre client). « Vision Entité » = GUC = CSV d'entités ; « Vision
  Globale » = GUC vide = tout le tenant. Transactions/soldes héritent du scope par
  JOINTURE sur bank_accounts (pas de duplication d'entity_id sur l'append-only). Fuite
  ici = intra-groupe (grave, pas cross-client) — mais traitée comme un gate bloquant.

Invariants :
- `entity_id` vit UNIQUEMENT sur `bank_accounts` (NULLABLE = « non assigné »). Ne JAMAIS
  dénormaliser entity_id dans transactions_cache/balance_history (append-only/partitionné
  + réassignation ne doit pas réécrire l'historique).
- FK composites scopées workspace OBLIGATOIRES (pattern `categories`) :
  `bank_accounts(entity_id, workspace_id) → entities(id, workspace_id)` et
  `member_entity_scopes(entity_id, workspace_id) → entities`. Cible : `entities
  UNIQUE(id, workspace_id)`. ON DELETE RESTRICT vers les entités (jamais cascade) ;
  l'app archive (is_active=false). Cascade légitime uniquement
  `member_entity_scopes(user_id, ws) → workspace_members` (purge des droits).
- Un compte `entity_id IS NULL` est INVISIBLE en Vision Entité (fail-closed) ; seul
  l'ADMIN (Vision Globale) le voit, dans le sas. L'ingestion ne pose jamais entity_id
  automatiquement ; l'upsert de re-sync ne réécrase JAMAIS un entity_id déjà assigné.
- Vision Entité / Globale : `member_entity_scopes` (N:N user↔entity). AUCUNE ligne =
  Vision Globale. Le scope se résout depuis le CONTEXTE, jamais d'un paramètre client.
- Pas de nouveau rôle au MVP : Vision Entité = membre scopé (pas un rôle). Gestion
  entités/scopes/assignation = ADMIN-only.
- Omni-FI « Parties » volontairement IGNORÉES au MVP : assignation MANUELLE côté TYGR
  (sas). Pré-remplissage via PartyId = dette P2 (ENTITY-PARTY1), PAS une dette d'isolation.
- Provisioning : `entities` et `member_entity_scopes` dans la liste blanche DELETE de
  `tygr_app.sql` (éditables, NON append-only). Ne JAMAIS y ajouter une table append-only.
- Le filtre de périmètre vit dans la RLS (fail-closed), JAMAIS dans le .tsx : un oubli de
  WHERE entity_id ne doit pas pouvoir créer une fuite intra-groupe.
```

**3 entrées `TODOS.md`** (règle 9 — date + effort + déclencheur) :
- `ENTITY-PARTY1` (P2) : pré-remplir le sas via `PartyId`/`PartyName` Omni-FI. Effort M.
  Déclencheur : retour terrain « trop de saisie » + preuve sandbox que les Parties sont
  fiablement peuplées.
- `ENTITY-WRITE-SCOPE1` (P1) : borner l'ÉCRITURE (catégorisation) au périmètre entité du
  membre. Effort S. Déclencheur : socle Entités mergé + confirmation PO §3.2.
- `ENTITY-INGEST1` (P2) : pré-assignation `compte → entité` à l'ingestion. Effort S.
  Déclencheur : ENTITY-PARTY1 livrée.

---

## 6. Quality Gates — checklists de sortie (phase d'implémentation future)

### 6.1 Checklist SÉCURITÉ (rôle CSO — OWASP ASVS sur les routes Entités + `withWorkspace`)
Validée par un contexte FRAIS (règle 6) ; chaque ligne cite `fichier:ligne`.
- [ ] **A01 IDOR** : chaque action passe par `withWorkspace` ; `entityId`/
      `bankAccountId`/`userId` d'un autre tenant → **404, jamais 403** (cas ajoutés §6.3).
- [ ] **A01 Élévation de privilège** : garde `ctx.role === "ADMIN"` sur creer/renommer/
      archiver/assigner/definirScopes ; MANAGER/VIEWER → rejet nommé. Rôle issu du
      **contexte** (preuve : test avec JWT MANAGER).
- [ ] **A01 Scope intra-groupe (étage 2)** : un membre Vision Entité scopé Sucrière →
      lecture des comptes/transactions/soldes Énergie = **0 ligne** (via policy
      `entity_scope`, y compris par jointure transactions/soldes).
- [ ] **A01 Anti-élargissement** : `withWorkspace` ne pose le GUC entity_scope QUE depuis
      `member_entity_scopes` ; un paramètre/contournement client ne peut pas élargir le
      périmètre (preuve : tentative de forcer un entity_id hors scope → 0 ligne).
- [ ] **A03 Injection** : `set_config(..., true)` paramétré, zéro interpolation de chaîne
      ; tous les paramètres Drizzle liés (revue des `sql\`\``).
- [ ] **A04 Insecure Design** : FK composites scopées présentes ; `ON DELETE RESTRICT`
      vérifié (effacer une entité référencée échoue) ; pas de cascade vers les comptes ;
      policy `entity_scope` en `FOR SELECT` (l'écriture reste gouvernée par tenant + ADMIN).
- [ ] **A04 Cross-tenant en base** : INSERT `member_entity_scopes` / UPDATE
      `bank_accounts.entity_id` visant une entité d'un AUTRE workspace → refus FK.
- [ ] **A05 Misconfiguration** : RLS `ENABLE`+`FORCE` sur `entities` &
      `member_entity_scopes` ; policy `entity_scope` présente sur `bank_accounts` (vérif
      `pg_policies`) ; liste blanche DELETE correcte, **aucune** table append-only ajoutée.
- [ ] **A09 Logging** : logs corrélés (`workspace_id`, `entity_id`, `actor_id`) ;
      **aucune PII bancaire** dans messages/télémétrie (règle 8).
- [ ] **Validation** : Zod `.strict()`, bornes (120 nom, 40 code, uuid, array max 200) ;
      hors borne → rejet bruyant nommé.
- [ ] **Fail-closed entity_scope** : un membre scopé ne « tombe » jamais en Vision
      Globale par GUC omis ; compte `entity_id NULL` invisible en Vision Entité.
- [ ] **Garde rôle DB** : nouvelles tables sous `tygr_app` (non-owner) — couvert par
      `UnsafeDatabaseRoleError` (R1/C6).

### 6.2 Checklist QA — revue de régression (avant tout commit/déploiement)
- [ ] **Migration backward-compatible (N-1)** : le code N-1 (sans `entity_id`, sans 3ᵉ
      GUC) tourne sur la base migrée ; `bank_accounts.entity_id` nullable défaut NULL ;
      l'ingestion existante insère sans connaître la colonne.
- [ ] **Données existantes** : 260+ transactions / comptes ingérés apparaissent en « non
      assigné » (entity_id NULL) ; aucune ligne orpheline, aucune perte.
- [ ] **Compat policy entity_scope** : AVANT toute assignation (tous NULL + aucun scope),
      une session normale (Vision Globale, GUC vide) voit TOUS ses comptes comme
      aujourd'hui — la nouvelle policy ne régresse pas le dashboard existant.
- [ ] **Idempotence** : rejouer migration + `db:provision` ne dérive pas l'état.
- [ ] **Sas** : assigner → réassigner → désassigner (null) ; compte d'un autre tenant → 404.
- [ ] **Persistance re-sync** : un compte assigné conserve son `entity_id` après une
      nouvelle ingestion (l'upsert n'écrase pas entity_id).
- [ ] **Scope membre** : définir N entités → réduire → vider (= Vision Globale) ; retirer
      le membre (workspace_members DELETE) purge ses scopes (cascade) sans erreur.
- [ ] **Vision Entité de bout en bout** : un VIEWER scopé Sucrière ne voit, au dashboard
      ET dans /transactions, que les comptes/transactions/soldes Sucrière (preuve runtime).
- [ ] **Archivage entité** : archiver une entité référencée → disparaît des pickers, le
      compte garde son entity_id ; SUPPRESSION physique refusée (RESTRICT).
- [ ] **Stop-loss vert** : `lint`, `typecheck`, `test` (suite IDOR incluse) au vert.
- [ ] **Devises & fuseaux** : non impactés (entités sans montant) — confirmer qu'aucune
      agrégation existante n'est cassée par la jointure entity_scope.
- [ ] **Tests livrés (règle 3)** : heureux + échec (non-ADMIN, 404 cross-tenant) + limite
      (scope vide, entityId null, nom dupliqué, compte NULL en Vision Entité).

### 6.3 Ajouts à la suite d'isolation IDOR (bloquante CI, règle 2)
`tests/isolation/` — cas obligatoires (l'absence d'un = chantier incomplet) :
- Lecture/UPDATE d'une `entity` du workspace B depuis session A → 0 ligne.
- `assignerCompteEntite` visant un `bankAccountId` du workspace B depuis A → 404.
- INSERT `member_entity_scopes` avec un `entity_id` du workspace B → refus FK.
- Vision Entité scopée Sucrière → comptes/transactions/soldes Énergie = 0 ligne (étage 2).
- Vision Globale (scope vide) → voit toutes les entités du workspace.
- Compte `entity_id NULL` → invisible en Vision Entité, visible en Vision Globale.
- Tentative d'élargir le scope (entity_id hors `member_entity_scopes`) → 0 ligne.
- Contre-preuve : un ADMIN du workspace courant assigne/scope normalement (pas de faux positif).
- **Étage 1 préservé** : tous les cas cross-tenant existants restent à 0 ligne.

---

## 7. Hooks (stop-loss) — spécification pour l'implémentation future
Infrastructure existante à **renforcer**, pas à réinventer :
- `.husky/pre-commit` : `npm run lint && npm run typecheck && npm test`.
- `.claude/settings.json` → `PreToolUse`(Bash) → `.claude/hooks/stop-loss-commit.sh`.

Spécification stricte (à appliquer pendant l'implémentation) :
1. Le hook PreToolUse **bloque `git commit`** (exit ≠ 0) si `lint` → `typecheck` →
   `test` échoue (court-circuit au 1er échec). **Vérifier que `stop-loss-commit.sh`
   couvre bien les TROIS** (le `.husky` les a ; aligner le hook agent s'il diverge).
2. La **suite d'isolation IDOR** est dans `npm test` → un cas entité rouge **bloque le
   commit**. Ne pas introduire de chemin qui commit en contournant `npm test`.
3. **Garde migration** (recommandé) : refuser un `ADD COLUMN … NOT NULL` sans `DEFAULT`
   sur table existante (anti-casse expand) — au minimum en checklist QA §6.2 si non
   automatisable proprement.
4. **Aucun `.skip` silencieux** (règle 5) : un test isolé = entrée TODOS.md datée.
5. **Aucune désactivation de hook** dans ce chantier (pas de `--no-verify`, pas de
   retrait du matcher Bash).

> Ces hooks **forcent le passage du linter et de la compilation locale avant
> d'accepter toute implémentation ultérieure**. Ils ne sont pas modifiés en phase de
> planification ; cette section est leur cahier des charges.

---

## 8. Estimation & séquencement de l'implémentation (indicatif, post-validation)
| Lot | Contenu | Effort | Revue |
|-----|---------|--------|-------|
| L1  | Migration `0008` + schéma Drizzle (entities, entity_id, scopes, **policy entity_scope**) + provisioning | M | **cross-review DB** (FK composites, RLS, RESTRICT, policy GUC) |
| L2  | `withWorkspace` : 3ᵉ GUC entity_scope + enrichissement `WorkspaceContext` | S | **cross-review SÉCU contradictoire** (point névralgique anti-IDOR) |
| L3  | Repository `entites.ts` + erreurs nommées | M | cross-review IDOR |
| L4  | Server Actions `admin/entites/actions.ts` (CRUD + sas + scopes) ; garder `entity_id` hors upsert d'ingestion | S | cross-review sécu (gardes ADMIN) |
| L5  | Suite isolation IDOR (cas §6.3) + tests repository + **preuve runtime Vision Entité** | M | **bloquant CI** |
| —   | (Front : pages admin entités, sas, sélecteur — **rôle Front**) | — | Visual QA |

Périmètre de CE plan = **L1→L5** (socle + 2ᵉ étage RLS + admin + isolation). Le filtrage
des lectures est **inclus** (conséquence du choix policy RLS — il ne reste rien à
brancher côté repository pour la lecture, la RLS filtre). Durcissement écriture =
ENTITY-WRITE-SCOPE1 (P1, séparé).

---

## 9. Ce que ce plan NE fait PAS (anti-scope-creep, règle 7)
- Ne crée PAS de nouveau rôle (`WORKSPACE_ROLES` inchangé ; Vision Entité = membre scopé).
- Ne lit PAS les Parties Omni-FI (dette P2 assumée).
- Ne dénormalise PAS `entity_id` dans les tables append-only/partitionnées.
- Ne durcit PAS l'ÉCRITURE par entité (catégorisation) — dette ENTITY-WRITE-SCOPE1.
- Ne pré-assigne PAS à l'ingestion (compte neuf = non assigné, voulu).
- N'écrit AUCUN code de production ni test (phase planification, règle 1).

---

## 10. Points en attente de votre validation formelle
1. **Architecture DB §1** (entities + entity_id nullable + member_entity_scopes N:N +
   FK composites scopées + RESTRICT) ?
2. **2ᵉ étage RLS §2** (3ᵉ GUC `app.current_entity_scope` dans `withWorkspace` + policy
   `entity_scope` `FOR SELECT` sur bank_accounts) ?
3. **Pas de rôle `GROUP_AUDITOR` au MVP §3.1** (Vision Globale = membre non scopé) ?
4. **Durcissement écriture renvoyé à ENTITY-WRITE-SCOPE1 (P1) §3.2** — ou à inclure ici ?
5. **Ajouts CLAUDE.md §5 + 3 dettes TODOS** ?
6. **Quality Gates §6 + spec hooks §7** comme critères de sortie de l'implémentation ?

→ Sur votre **« go »**, j'ouvrirai une requête d'IMPLÉMENTATION distincte (règle 1)
référençant ce plan, en commençant par le lot **L1** (puis L2 sous cross-review sécu).
