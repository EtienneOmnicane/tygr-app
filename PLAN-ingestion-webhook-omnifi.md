# PLAN — Ingestion pilotée par webhook Omni-FI (`/api/webhooks/omnifi`)

> **Phase : CONCEPTION (règle 1)** — zéro code applicatif dans cette PR.
> Rédigé le 2026-07-17, branche `feat/ingestion-webhook`.
>
> **Rattachements** : `GAP-WEBHOOK1` (P1, TODOS.md) · `WEBHOOK-TENANT-FIRST1` (P1) ·
> `SYNC-WEBHOOK-INGEST1` (P1) · `DASH-AUTOSYNC1` (P1, pistes a/b) ·
> `SYNC-INCOMPLET-DURABLE1` (option (b) déjà arbitrée, PR dédiée — interaction §6.4).
> Cahier des charges v2.1 : §1 (architecture), §2.4 (ordre de traitement webhook),
> FEAT-1.2, §3.ter (stratégie anti-sur-ingénierie), §4.1/§4.3 (modèle + critères).
>
> **Statut : EN ATTENTE d'arbitrage humain (décisions D1→D4, §10). NE PAS CODER avant.**
> Surface sécurité (HMAC + rôle `tygr_service`) ⇒ **cross-review OBLIGATOIRE à chaque
> lot d'implémentation** (règle 6), gravé en §8.5.

---

## 0. Pushback règle 10 — push amont vs cron pull (décision D1)

Le brief demande le webhook (push). Avant de le dessiner, l'analyse exigée : le cahier
porte DEUX textes qui coexistent — §1/§2.4/FEAT-1.2 font du webhook « le cœur de
l'architecture d'ingestion », mais **§3.ter (décision utilisateur, interviews Accountant
Omnicane/OL du 2026-06-11)** dit : *« le temps réel n'est PAS requis… synchronisation
par batchs/crons quotidiens (Inngest)… le webhook `sync.completed` reste le déclencheur
d'ingestion QUAND il arrive, mais le produit ne dépend pas d'une fraîcheur
infra-quotidienne »*. Ce n'est donc pas une re-litigation : c'est un **séquençage** que
le cahier lui-même appelle.

### 0.1 Risques concrets du « webhook d'abord, seul »

- **Émission réelle non prouvée.** Seul `POST /dev/webhooks/test` (mock
  `sync.completed`) est garanti par la doc (`documentation_api.md:1255-1260`). Que
  l'amont émette réellement les 12 `EventType` sur un scrape sandbox est une hypothèse
  **à prouver au runtime** (leçon PR #202 : vérifier la prémisse d'un brief au runtime ;
  la prod Omni-FI n'est par ailleurs pas déployée). Mode de défaillance : 5-7 j de build
  sur un canal que l'amont n'alimente pas encore ⇒ données toujours figées.
- **Politique de retry amont NON documentée.** Si Omni-FI ne retente pas un POST
  échoué (déploiement Vercel au mauvais moment, 30 s d'indisponibilité), l'événement
  est **perdu sans trace côté TYGR**. Un webhook sans filet pull n'est donc jamais un
  canal suffisant — le cron reste obligatoire de toute façon.
- **URL publique requise** (config `PUT /dev/webhooks/config` par env) : rien à
  recevoir en dev local sans tunnel ; la preuve de bout en bout se fait sur un
  déploiement joignable.

### 0.2 Chiffrage des options

| Option | Contenu | Effort | Livre | Risque principal |
|---|---|---|---|---|
| **A — webhook d'abord** | socle Inngest + `tygr_service` + route HMAC + quarantaine + worker + rejeu | **~6,5-8 j** | GAP-WEBHOOK1, SYNC-WEBHOOK-INGEST1 | fiabilité d'émission amont non prouvée ; aucun filet si l'amont se tait |
| **B — cron pull seul** (DASH-AUTOSYNC1 piste a) | socle Inngest + primitive système + worker durable + cron 06:00 MUT | **~2,5-3,5 j** | DASH-AUTOSYNC1(a) **et** SYNC-WEBHOOK-INGEST1 (le worker durable attend un scrape > 120 s, ce qu'une Server Action ne peut pas) | fraîcheur bornée au cron — explicitement acceptée par §3.ter |
| **C — phasé convergent (RECOMMANDÉ)** | B d'abord (lots W1-W2), puis le webhook comme **2ᵉ déclencheur du même worker** (lots W3-W5) | ~2,5-3,5 j puis ~4-5 j | tout ; valeur dès W2 | aucun nouveau — le webhook devient additif |

Le point d'architecture décisif de l'option C : **le webhook n'est pas un chemin
d'ingestion à part, c'est un déclencheur de plus du même job Inngest idempotent**
(`omnifi/sync.ingest.requested`). Cron, clic manuel et webhook convergent vers un
worker unique — pas de logique dupliquée, et la panne d'un canal n'affame pas le
produit. Tout le présent plan est écrit pour l'option C ; si D1 retient A, seuls
l'ordre des lots (§9) change, pas leur contenu.

---

## 1. Faits vérifiés (contrat amont + état du code) et trous à prouver

### 1.1 Contrat webhook amont (`docs/documentation_api.md:1221-1304`)

- Header `x-omnifi-signature` = `HMAC-SHA256(body_bytes, WebhookSecret)` en hex.
- Body : `{ EventId (uuid), EventType, ConnectionId (uuid), JobId (uuid), Timestamp,
  Payload {} }`. **⚠️ Aucun `ClientUserId` dans le payload** — tension directe avec
  la lettre de WEBHOOK-TENANT-FIRST1, résolue en §3.
- 12 `EventType` (`sync.started` … `sync.completed`, `sync.failed`,
  `sync.mfa_required`) ; la doc avertit : *« tous les scrapers n'émettent pas chaque
  événement intermédiaire »* ⇒ logique tolérante, **union OUVERTE** côté types (leçon
  PR #202 : l'enum amont dérive).
- Config : `PUT /dev/webhooks/config` → `WebhookSecret` retourné **uniquement au
  premier appel** ; `POST /dev/webhooks/rotate-secret` ; `POST /dev/webhooks/test`
  (mock `sync.completed`, réponse 202).
- `GET /connections?clientUserId=…` (ApiKey) liste les connexions d'UN EndUser —
  utilisable comme **confirmation d'appartenance amont** (option D3).

### 1.2 État du code (vérifié sur `feat/ingestion-webhook`, base `2d245c6`)

- `src/app/api/` = `auth/[...nextauth]` **seul** — la route webhook n'existe pas
  (GAP-WEBHOOK1 confirmé).
- **Inngest n'est PAS installé** (`package.json` : aucune dépendance Inngest). Le
  stack CLAUDE.md/cahier le prévoit, mais le socle (client, route `/api/inngest`,
  1ʳᵉ fonction) est un lot à part entière (W1) avec justification de dépendance
  (règle 9 : Layer 1 éprouvé, pin exact si beta).
- `audit_events` existe (`src/server/db/schema.ts:1344-1391`) avec `omnifi_event_id`
  nullable + **unicité COMPOSITE `(workspace_id, omnifi_event_id)`** (décision Q4 :
  jamais d'unique globale — oracle d'existence cross-tenant + DoS). La colonne
  `hmac_signature_truncated` (8 hexa) existe déjà. La dédup webhook est donc **par
  tenant, après résolution** — l'ordre du cahier §2.4 (HMAC → résolution → dédup →
  enqueue) est structurellement obligatoire.
- `bank_connections.omnifi_connection_id` : unique **globale encore en place**
  (0018 expand ; le contract 0019 qui la droppe n'est pas déployé — PLAN-unique-composites).
  L'unique composite `(workspace_id, omnifi_connection_id)` coexiste. Le résolveur
  doit être écrit pour **survivre au drop** (§3.3).
- Le rôle **`tygr_service` n'existe nulle part** (`drizzle/`, `scripts/`, `src/` :
  zéro occurrence) — il est prévu par CLAUDE.md règle 2 et le cahier §4 (l.261-262)
  mais reste à provisionner (lot W3).
- `withWorkspace` (`src/server/db/tenancy.ts:174-226`) exige une **session
  utilisateur** (re-validation de membership à chaque transaction). Un worker/cron
  n'en a pas ⇒ il faut une primitive système (§6.1), surface sensible.
- Ingestion réutilisable telle quelle : `ingererConnexions` /
  `synchroniserCompteComplet` (`src/server/ingestion/index.ts`) — upserts idempotents,
  tournent en Vision Globale (GUC entité vide), `entity_id` jamais écrasé.
- Pas de curseur amont : `/transactions/sync` est une « extension future » confirmée
  par Omni-FI (OMNIFI_API_FEEDBACK #10) — l'ingestion reste sur les routes par PAGE.
  FEAT-1.2 dit « par curseur » : **hors périmètre** tant que l'amont ne le déploie pas.

### 1.3 À prouver au runtime (avant/pendant W4)

1. L'amont émet-il réellement les webhooks sur un scrape sandbox (au-delà du mock) ?
2. Retente-t-il sur non-2xx ? Avec quel backoff ?
3. `Payload{}` contient-il des champs utiles non documentés (un `ClientUserId` ?) ?

Ces trois questions alimentent le point OMNIFI_API_FEEDBACK à soumettre (D4).

---

## 2. Architecture cible — pipeline de réception

```
POST /api/webhooks/omnifi            (runtime Node, jamais Edge)
  │
  ├─ (0) Gardes transport : POST seul, body ≤ 64 Ko (413), secrets configurés
  │      sinon 503 nommé (fail-closed — route inerte sans secret)
  ├─ (1) HMAC SHA-256 constant-time sur les BYTES BRUTS, dual-env (§2.1)
  │      échec → 401 générique, AUCUN écrit DB, log sans PII
  ├─ (2) Validation zod stricte du body (§2.2) — échec → 400 code nommé
  ├─ (3) Résolution TENANT-FIRST sous tygr_service (§3)
  │      ├─ introuvable  → (4) quarantaine webhook_events_pending → 202
  │      ├─ AMBIGU (≥2)  → (4) quarantaine + alerte log            → 202
  │      └─ env mismatch → (4) quarantaine + alerte log            → 202
  ├─ (5) Dédup + audit : INSERT audit_events ON CONFLICT
  │      (workspace_id, omnifi_event_id) DO NOTHING, sous tygr_app + GUC
  │      système (§6.1) — conflit = rejeu → 200 sans enqueue
  ├─ (6) enqueue Inngest `omnifi/sync.ingest.requested` (§6.2)
  │      (seulement sync.completed / sync.failed / sync.mfa_required ;
  │       les intermédiaires sont tracés en audit, pas enqueués)
  └─ (7) 202 en < 1 s — tout le travail lourd vit dans le worker
```

**Aucun oracle** : une connexion inconnue ne répond JAMAIS 404 — c'est 202 +
quarantaine (l'émetteur légitime n'a pas besoin de savoir, un attaquant non plus ;
règle 3 « messages non-énumérants » appliquée à une surface non authentifiée par
session).

### 2.1 Vérification HMAC (constant-time, dual-env)

- Lire le body via `req.text()` **avant tout parse** — l'HMAC se calcule sur les
  bytes exacts reçus, pas sur un JSON re-sérialisé (un re-encodage change les bytes
  et casse la signature).
- Secrets : `OMNIFI_WEBHOOK_SECRET_SANDBOX` et `OMNIFI_WEBHOOK_SECRET_PRODUCTION`
  (env vars, jamais loggées, distincts — règle 8 déjà gravée). L'URL amont étant
  partagée sand+prod (mémoire projet : l'env se décide par les CLÉS), **l'env de
  l'événement se déduit du secret qui matche** : calculer l'HMAC attendu avec chaque
  secret configuré, comparer chacun via `crypto.timingSafeEqual` sur des Buffers
  décodés depuis l'hex. Longueurs différentes → rejet immédiat sans `timingSafeEqual`
  (il jette sur longueurs inégales ; la longueur d'un HMAC hex est publique, aucune
  fuite). Deux comparaisons constant-time bornées = coût fixe, pas de canal temporel.
- L'env résolu est porté dans tout le pipeline (log, quarantaine, cross-check §3.4).
- Audit : `hmac_signature_truncated` = 8 premiers hexa (colonne existante) — jamais
  la signature complète (rejouable).

### 2.2 Validation d'entrée (zod strict)

```
EventId    : uuid                     (longueur bornée)
EventType  : string 1..60             (union OUVERTE — pas d'enum fermé)
ConnectionId, JobId : uuid
Timestamp  : datetime ISO
Payload    : objet, taille sérialisée bornée (≤ 32 Ko), AUCUNE clé consommée au MVP
```

Rejet bruyant `WEBHOOK_PAYLOAD_INVALIDE` (registre S2). Le `Payload` est stocké en
quarantaine tel quel mais **filtré par liste blanche de clés** avant d'entrer dans
`audit_events.payload` (contrat existant du repository audit : zéro PII).

---

## 3. Résolution du tenant — WEBHOOK-TENANT-FIRST1 appliqué au payload réel

### 3.1 La règle gravée, et le fait nouveau

La règle (TODOS l.2269-2277, commentaire `schema.ts:244-247`) : *résoudre le TENANT
d'abord (`ClientUserId`→workspace, unique global conservé) PUIS la connexion DANS ce
workspace — JAMAIS `omnifi_connection_id` seul (routage cross-tenant sinon)*.

**Fait nouveau vérifié contre la doc** (règle 10 : on rouvre en citant le fait) : le
payload webhook **ne porte pas de `ClientUserId`** (`documentation_api.md:1276-1285`).
La lettre de la règle est inapplicable telle quelle ; son **esprit** — jamais de
routage par `omnifi_connection_id` sans garantie d'unicité tenant — est intégralement
conservé par le mécanisme suivant.

### 3.2 Mécanisme retenu (lookup borné + garde de multiplicité + cross-check env)

Sous `tygr_service` (§5), l'UNIQUE requête autorisée :

```sql
SELECT id, omnifi_connection_id, workspace_id
FROM bank_connections
WHERE omnifi_connection_id = $1
LIMIT 2;   -- LIMIT 2, jamais 1 : détecter la multiplicité est le but
```

- **0 ligne** → quarantaine (webhook avant `link-exchange`, cas nominal du premier
  sync — cahier §2.2/§2.3).
- **2 lignes** → `WEBHOOK_CONNEXION_AMBIGUE` : quarantaine + alerte log. **JAMAIS de
  choix arbitraire** — router au hasard est exactement le cross-tenant que la règle
  interdit.
- **1 ligne** → candidate ; passer au cross-check §3.4.

### 3.3 Pourquoi cette garde est structurelle, pas décorative

Aujourd'hui l'unique **globale** `bank_connections.omnifi_connection_id` (0018)
rend l'ambiguïté impossible. Le contract 0019 (PLAN-unique-composites) la droppera :
seul l'unique composite `(workspace_id, omnifi_connection_id)` restera, et deux
workspaces pourront porter le même `omnifi_connection_id`. Le résolveur est écrit
**dès le premier jour** pour ce monde-là. Tests : branche « ambiguë » couverte en
unitaire (le doublon est ininsérable tant que 0018 vit) + un test d'intégration
**raccroché à l'entrée TODOS du contract 0019** qui l'activera (2 tenants, même
`omnifi_connection_id`, événement → quarantaine, zéro ligne routée).

### 3.4 Cross-check d'environnement (défense en profondeur)

Le workspace résolu doit satisfaire `workspaces.omnifi_environment == env du secret
HMAC qui a validé la signature` (§2.1). Mismatch → quarantaine + alerte
(`WEBHOOK_ENV_MISMATCH`) : un événement signé sandbox ne route JAMAIS vers un
workspace production, et inversement. Nécessite que `tygr_service` lise AUSSI
`workspaces (id, omnifi_environment)` — **extension de la liste fermée de CLAUDE.md
règle 2 → décision D2** (sans elle, le cross-check env est impossible et on retombe
sur la foi dans le seul HMAC).

### 3.5 Renforcement optionnel — confirmation amont (décision D3)

Pour re-coller à la LETTRE de tenant-first : après résolution locale, confirmer via
`GET /connections?clientUserId=<workspaces.omnifi_client_user_id>` (ApiKey) que le
`ConnectionId` figure bien dans les connexions de CET EndUser. `omnifi_client_user_id`
est unique global et le restera — c'est l'ancre tenant que la règle visait. Coût :
1 appel API amont par événement, mitigeable en ne confirmant que le **premier**
événement de chaque connexion (marqueur local). Recommandation : différer à
l'activation du contract 0019 (aujourd'hui l'unique globale rend la confirmation
redondante), MAIS l'inscrire dans l'entrée TODOS du 0019 comme alternative si D4
(payload enrichi amont) n'a pas abouti d'ici là.

---

## 4. Modèle de données

### 4.1 Nouvelle table `webhook_events_pending` (quarantaine — migration Drizzle)

| Colonne | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `omnifi_event_id` | varchar(64) **UNIQUE** | dédup PRÉ-tenant. Unicité globale ACCEPTABLE ici (contrairement à Q4/audit_events) : table système invisible des tenants, jamais exposée par une API → pas d'oracle d'existence exploitable |
| `omnifi_connection_id` | varchar(64), index | clé de rejeu |
| `event_type` | varchar(60) | union ouverte |
| `omnifi_job_id` | varchar(64) NULL | |
| `omnifi_environment` | varchar(10) | env du secret qui a validé (§2.1) |
| `motif` | varchar(30) | `CONNEXION_INCONNUE` / `AMBIGUE` / `ENV_MISMATCH` |
| `payload` | jsonb | body validé zod, borné 32 Ko — le payload webhook ne porte pas de PII bancaire (ids techniques seulement) |
| `received_at` | timestamptz | |
| `replayed_at` | timestamptz NULL | NULL = en attente |
| `replay_count` | int default 0 | plafond anti-boucle (ex. 10) |

- **Pas de `workspace_id`** — par définition le tenant est inconnu. Pas de RLS
  tenant ; à la place : **deny-by-default pour `tygr_app`** (aucun GRANT), accès
  réservé à `tygr_service` (SELECT/INSERT/UPDATE/DELETE sur CETTE table seule).
  Table **système, non financière, non append-only** : le DELETE de purge est
  légitime et n'entre pas dans la liste blanche de `tygr_app` (qui ne la voit pas).
- Cycle de vie : rejeu (§6.3) → `replayed_at` posé ; purge TTL 30 j par le cron de
  rejeu (les non-rejouables expirés partent avec un log d'abandon — « no silent caps »).

### 4.2 Dédup post-résolution : `audit_events` (existant, AUCUNE migration)

`INSERT … ON CONFLICT (workspace_id, omnifi_event_id) DO NOTHING` — conflit = rejeu
amont → 200 sans enqueue. Écrite sous `tygr_app` + GUC système (§6.1), `actor_user_id`
NULL (événement système), `event_type` = `EventType` amont verbatim, **TOUS les
EventType tracés** (cahier §2.4) même ceux non enqueués. Append-only strict respecté :
on n'update ni ne delete jamais, un correctif = un événement de plus.

### 4.3 `sync_runs` (observabilité, cahier §4.1 — version minimale au lot W2)

Prévue par le cahier (« reste à venir avec son chantier », `schema.ts:8`) — ce
chantier est le sien. Version minimale : `id, workspace_id (RLS tenant), connection_id,
trigger (CRON|WEBHOOK|MANUAL), status, comptes_traites, transactions_upsertees,
erreur_code, started_at, finished_at`. Table normale (UPDATE de progression licite,
PAS append-only — ce n'est pas une table financière). Leçon `sync-fail-soft` : sans
trace en base, un cron qui échoue en silence est invisible en prod.

---

## 5. Rôle `tygr_service` (lot W3 — cross-review obligatoire)

Le cahier (l.261-262) le définit : *pas de BYPASSRLS, uniquement
`SELECT (id, omnifi_connection_id, workspace_id)` sur `bank_connections`*. Points de
conception que le cahier ne dit PAS et qui feront la cross-review :

1. **RLS forcée ⇒ policy dédiée obligatoire.** `bank_connections` est en
   `FORCE ROW LEVEL SECURITY` avec la seule policy `tenant_isolation` (comparaison au
   GUC). Sous `tygr_service` sans GUC, un SELECT renvoie **0 ligne** — le rôle serait
   inutilisable. Il faut une policy PERMISSIVE dédiée :
   `CREATE POLICY webhook_resolution ON bank_connections FOR SELECT TO tygr_service
   USING (true);` — acceptable PARCE QUE bornée par le GRANT column-level (3 colonnes,
   aucune donnée métier), par `FOR SELECT` (aucune écriture), et par l'absence de
   LOGIN applicatif large. C'est le compromis explicite : la résolution webhook est
   par nature cross-tenant (on cherche À QUI est l'événement) — on la confine par le
   privilège, pas par la RLS. Idem sur `workspaces (id, omnifi_environment)` si D2
   est actée (+ `omnifi_client_user_id` si D3).
2. **Provisioning** : bloc idempotent AJOUTÉ à `drizzle/provisioning/tygr_app.sql`
   (source unique des rôles, pipeline `db:provision → migrate → re-provision`
   inchangé) : `CREATE ROLE tygr_service NOLOGIN` sans mot de passe ; GRANT
   column-level ; GRANTs quarantaine (§4.1). LOGIN + mot de passe posés hors script
   (pattern C4 existant), rotation au runbook.
3. **Connexion dédiée** `DATABASE_URL_SERVICE` + module `src/server/db/service.ts` :
   client Neon/wsproxy séparé, **garde runtime miroir de C6** — refuse de servir si
   `current_user <> 'tygr_service'` (un `DATABASE_URL_SERVICE` pointant l'owner ou
   `tygr_app` fait échouer la route, fail-closed).
4. **Frontière d'import** : `service.ts` importable UNIQUEMENT par le module de
   résolution webhook — règle ESLint `no-restricted-imports` en constante RÉPÉTÉE,
   jamais un override qui remplace (leçon eslint-flat-config : redéclarer une règle
   l'écrase en silence).
5. **Tests isolation** (suite bloquante CI, cahier §4.3) : sous `tygr_service` —
   SELECT d'une colonne hors liste → `permission denied` ; SELECT sur toute autre
   table (transactions_cache, users…) → `permission denied` ; INSERT/UPDATE/DELETE
   `bank_connections` → `permission denied` ; la résolution voit les connexions des
   DEUX tenants de test (voulu, borné aux 3 colonnes) ; contre-preuve : la même
   requête sous `tygr_app` sans GUC → 0 ligne.

---

## 6. Worker Inngest & primitive système

### 6.1 `executerPourWorkspaceSysteme(workspaceId, fn)` (lot W2 — surface sensible)

Variante système de `withWorkspace` : transaction sous `tygr_app`, garde owner C6
conservée, `set_config('app.current_workspace_id', …)` posé, **PAS de
`app.current_user_id`**, **PAS de membership** (il n'y a pas d'utilisateur), aucun GUC
d'étage 2 (Vision Globale — exactement le mode dans lequel l'ingestion tourne déjà,
invariant `entity_id NULL jamais écrasé` inchangé). Gardes :

- Module `server-only`, exporté d'un fichier dédié, importable UNIQUEMENT par les
  fonctions Inngest et la route webhook (frontière ESLint, même mécanique que §5.4) —
  JAMAIS par une Server Action ou un composant : le `workspaceId` y vient d'une
  résolution serveur (`tygr_service` ou itération de cron), jamais d'un client.
- Le `workspaceId` accepté est validé `z.string().uuid()` et logué sur chaque appel.

C'est le point le plus sensible du chantier avec le HMAC : une fuite de cette
primitive vers une surface utilisateur serait un bypass de membership. La
cross-review W2 a mandat explicite de chercher ce mode de défaillance.

### 6.2 Job `omnifi/sync.ingest.requested`

- Données : `{ workspaceId, connectionId (id interne TYGR), declencheur:
  CRON|WEBHOOK|MANUAL, omnifiEventId?, omnifiJobId?, eventType? }`.
- **Idempotence Inngest** : clé = `omnifiEventId` quand présent (ceinture, la dédup
  DB §4.2 étant les bretelles) ; pour le cron, clé = `connectionId + date du run`.
- **`concurrency: 1` par `connectionId`** (cahier §4.3) — deux événements rapprochés
  sur la même connexion se sérialisent ; les upserts idempotents rendent le second
  inoffensif.
- Steps (retry unitaire par step, natif Inngest) :
  1. ouvrir `sync_runs` (trigger, statut RUNNING) ;
  2. selon `declencheur` : WEBHOOK `sync.completed` → lire directement (le scrape est
     FINI — c'est la vertu du push : l'attente disparaît) ; CRON/MANUAL →
     `POST /sync/{ConnectionId}` en respectant `NextSyncAvailableAt` + rate-limit
     1/15 min/connexion, puis **polling durable** `step.sleep` jusqu'à statut terminal
     (aucun plafond 120 s : c'est ici que SYNC-WEBHOOK-INGEST1 se referme) ;
  3. ingestion : réutiliser `ingererConnexions` / `synchroniserCompteComplet` sous
     `executerPourWorkspaceSysteme` — fail-soft avec **re-throw sélectif des gardes
     tenant** (leçon PR #123 : un catch large qui avale une garde d'isolation est un
     bug) ;
  4. `sync.failed` → statut d'erreur durable sur la connexion (consommera les
     colonnes de SYNC-INCOMPLET-DURABLE1, §6.4) + CTA Repair (registre existant) ;
     `sync.mfa_required` → statut MFA (adjacent à SYNC-MFA-COOLDOWN1, non absorbé) ;
  5. clore `sync_runs` + compteurs ; invalidation UI (`revalidateTag` — Inngest
     s'exécute dans la route `/api/inngest`, donc dans le runtime Next ; **à vérifier
     contre `node_modules/next/dist/docs` à l'implémentation**, Next 16 diverge).

### 6.3 Rejeu de la quarantaine

- **Au `link-exchange`** (cahier §2.3) : après l'INSERT `bank_connections`, enqueue
  `omnifi/webhook.replay.requested { omnifiConnectionId }` — le worker de rejeu relit
  les `webhook_events_pending` non rejoués de cette connexion (sous `tygr_service`),
  repasse CHAQUE événement par le pipeline normal (résolution → dédup → enqueue :
  aucun raccourci — le rejeu ne contourne jamais les gardes), pose `replayed_at`.
- **Cron filet** (quotidien) : rejoue les en-attente < TTL (les connexions peuvent
  apparaître par d'autres chemins), incrémente `replay_count`, purge > 30 j ou
  > plafond avec log d'abandon explicite.

### 6.4 Interaction SYNC-INCOMPLET-DURABLE1 (option (b), PR dédiée — NON absorbée)

Les colonnes `sync_partiel_depuis` / `sync_dernier_statut` (bank_connections) restent
livrées par LEUR PR. Contrat d'interface ici : le worker webhook/cron **écrit** ces
champs (statut terminal du job amont) et les remet à NULL sur COMPLETED — même
sémantique que le chemin manuel. Si la PR (b) n'est pas mergée quand W2 arrive, le
worker logue le statut sans le persister (aucun couplage d'ordre entre les deux PR).

---

## 7. Configuration, secrets, runbook

- **Env vars** : `OMNIFI_WEBHOOK_SECRET_SANDBOX`, `OMNIFI_WEBHOOK_SECRET_PRODUCTION`
  (+ `DATABASE_URL_SERVICE`). Jamais loggées, jamais en fixture ; `.env.example` /
  `.env.prod.example` mis à jour. Verrou prod existant inchangé
  (`OMNIFI_AUTORISER_PRODUCTION`).
- **Enrôlement** (runbook, par env) : `PUT /dev/webhooks/config { WebhookUrl }` →
  **copier le `WebhookSecret` immédiatement** (retourné une seule fois) → poser l'env
  var → `POST /dev/webhooks/test` → vérifier 202 + ligne `audit_events`.
- **Rotation** : `POST /dev/webhooks/rotate-secret` invalide l'ancien **immédiatement**
  ⇒ fenêtre de 401 entre la rotation et la pose de la nouvelle env var. Séquence
  runbook : rotation → mise à jour env + redéploiement DANS LA FOULÉE ; les événements
  de la fenêtre sont perdus côté TYGR → le cron filet (§6.3/§0) les rattrape. (Si
  l'amont supporte un jour la double validité, améliorer — à demander, D4.)
- **Dev local** : la réception ne se teste pas sans URL publique — tunnel éphémère ou
  environnement de staging déployé ; les tests automatisés couvrent le pipeline en
  in-process (requêtes forgées signées avec un secret de test).

---

## 8. Sécurité — exit criteria (règle 3) appliqués à la route

1. **Authz** : HMAC constant-time dual-env (§2.1) — c'est L'authentification de la
   route (pas de session). Ressource inconnue → 202 + quarantaine, **jamais 404**.
2. **Validation** : zod strict (§2.2), bornes de taille partout, codes nommés.
3. **Audit ASVS** : paramètres liés uniquement (aucune concaténation SQL) ; IDOR →
   garde de multiplicité §3.2 + cross-check env §3.4 + cas ajoutés à la suite
   isolation ; messages non-énumérants (§2) ; anti-abus : body ≤ 64 Ko, coût pré-HMAC
   borné (2 HMAC max), aucun écrit DB avant signature valide — un flood non signé ne
   touche jamais la base.
4. **Erreurs nommées** (registre S2) : `WEBHOOK_SIGNATURE_INVALIDE` (401),
   `WEBHOOK_PAYLOAD_INVALIDE` (400), `WEBHOOK_NON_CONFIGURE` (503),
   `WEBHOOK_CONNEXION_AMBIGUE` / `WEBHOOK_ENV_MISMATCH` (202 + quarantaine, motifs
   internes), `WEBHOOK_TROP_VOLUMINEUX` (413). Catch-all silencieux interdit.
5. **Tests** : chemin heureux (test amont mock → 202 → audit → job) ; échecs
   (signature fausse, secret absent, body malformé, taille) ; limites (rejeu ×5 → 1
   traitement ; ambiguïté simulée → quarantaine ; env croisé → quarantaine ;
   quarantaine rejouée après link-exchange ; concurrence : 2 événements même
   connexion → sérialisés).
6. **Logs structurés** : `event_id`, `event_type`, `env`, `workspace_id` (si résolu),
   `connection_id`, signature tronquée 8 hexa. Zéro PII (le payload amont n'en porte
   pas ; on ne logue jamais `Payload` brut).
7. **⚠️ CROSS-REVIEW OBLIGATOIRE** (gravé, GAP-WEBHOOK1) : chaque lot W2/W3/W4 passe
   une revue à contexte frais avec mandat explicite — W2 : fuite de la primitive
   système vers une surface user ; W3 : périmètre réel de `tygr_service` (policy
   USING(true) + GRANTs) ; W4 : bytes HMAC, canaux temporels, oracles, ordre du
   pipeline. Désaccord non résolu → remonté à l'humain (règle 6).

---

## 9. Découpage en lots (ordre = option C ; contenu identique si D1 retient A)

| Lot | Contenu | Estimation | Gates spécifiques |
|---|---|---|---|
| **W0** | Ce plan (docs-only) | — | la présente PR |
| **W1** | Socle Inngest : dépendance justifiée (règle 9, pin exact si beta), client, route `/api/inngest`, fonction healthcheck, CI | 0,5-1 j | build + lint |
| **W2** | `executerPourWorkspaceSysteme` + job `sync.ingest.requested` (worker durable) + cron quotidien 06:00 MUT (`Indian/Mauritius` explicite) + `sync_runs` minimal + frontière ESLint | 2-2,5 j | **cross-review** (§8.7) ; livre DASH-AUTOSYNC1(a) + SYNC-WEBHOOK-INGEST1 |
| **W3** | Provisioning `tygr_service` (+ policy `webhook_resolution`, GRANTs column-level, garde runtime, `DATABASE_URL_SERVICE`) + tests isolation + mise à jour CLAUDE.md règle 2 (si D2) | 1-1,5 j | **cross-review** ; suite isolation bloquante |
| **W4** | Migration `webhook_events_pending` + route `POST /api/webhooks/omnifi` (pipeline §2 complet) + tests + enrôlement sandbox + preuve `POST /dev/webhooks/test` | 2-2,5 j | **cross-review** ; réponses §1.3 documentées |
| **W5** | Rejeu quarantaine (post link-exchange + cron filet + purge TTL) | 1 j | revue standard |

Total : **~7-8,5 j**, valeur autonome dès W2 (données fraîches chaque matin sans clic).
Chaque lot = une PR applicative séparée, plan référencé, Human-in-the-Loop absolu
(aucun auto-merge — code + sécurité + DB).

---

## 10. Décisions demandées (l'humain tranche — rien ne se code avant)

- **D1 — Séquençage** : option **C recommandée** (pull d'abord, webhook additif —
  §0.2) vs A (webhook d'abord). Le contenu des lots est identique, seul l'ordre change.
- **D2 — Extension de la liste fermée (CLAUDE.md règle 2)** : autoriser
  `tygr_service` à lire AUSSI `workspaces (id, omnifi_environment)` pour le
  cross-check env (§3.4). Sans D2 : pas de cross-check, la foi repose sur le seul
  HMAC dual-env. **Recommandé : OUI** (défense en profondeur, 2 colonnes non métier).
- **D3 — Confirmation amont** (`GET /connections?clientUserId=`) au premier événement
  de chaque connexion (§3.5). **Recommandé : différé, inscrit dans l'entrée TODOS du
  contract 0019** (redondant tant que l'unique globale vit).
- **D4 — Feedback Omni-FI** (nouveau point OMNIFI_API_FEEDBACK) : demander (a) l'ajout
  de `ClientUserId` au payload webhook (alignerait la lettre de tenant-first, rendrait
  D3 inutile), (b) la documentation de la politique de retry, (c) la confirmation de
  l'émission réelle en sandbox. **Recommandé : OUI, avant W4** (les réponses
  conditionnent §1.3).

---

## 11. Hors périmètre (anti-scope-creep, entrées TODOS existantes)

- Colonnes de SYNC-INCOMPLET-DURABLE1 (PR dédiée, arbitrée) — seule l'interface §6.4.
- Curseur `/transactions/sync` amont (extension future, OMNIFI_API_FEEDBACK #10).
- UI MFA du widget, SYNC-MFA-COOLDOWN1, SYNC-FAILED-COOLDOWN1 (adjacents, non absorbés).
- Insights, reconcile 06:00, cron de partitions année+1 (cahier §2.5 — chantiers
  propres ; le socle Inngest W1 les rendra triviaux à ajouter).

## 12. Critères de sortie mesurables du chantier (règle 7)

1. `POST /dev/webhooks/test` (sandbox) → 202 + 1 ligne `audit_events` portant
   `omnifi_event_id` + signature tronquée.
2. Rejeu du même `EventId` ×5 → 1 seule ligne d'audit, 1 seul job exécuté
   (critère cahier §4.3 verbatim).
3. Signature invalide → 401, **zéro écrit en base** (prouvé par test).
4. Événement d'une connexion inconnue → 202 + quarantaine ; après `link-exchange`
   de cette connexion → rejoué et ingéré sans intervention.
5. Suite isolation : les cas `tygr_service` (§5.5) verts, bloquants en CI.
6. Scénario SYNC-WEBHOOK-INGEST1 : un scrape sandbox > 120 s aboutit à des
   transactions complètes en base **sans aucun clic** utilisateur.
7. Cron : à 06:15 MUT, `sync_runs` porte un run CRON terminé par connexion active,
   dans le respect de `NextSyncAvailableAt`.
