# Cahier des Charges — Interface TYGR

> **v2.1 (2026-06-10)** — Mise à jour approuvée via /autoplan : TYGR est un MVP de
> production **multi-tenant** (concept agnostique de **Workspace** : aujourd'hui
> 1 workspace = 1 BU interne de la société mère, demain 1 client SaaS externe).
> Isolation stricte des données à 3 étages (middleware applicatif + PostgreSQL RLS +
> ClientUserId Omni-FI). Le Consent Flow (Epic 1) reste la porte d'entrée du narratif
> réglementaire Innov8 ; le Dashboard (Epic 3) et la synchronisation API sont de
> qualité production. Plan détaillé et registres de revue :
> `~/.gstack/projects/tygr-app/clawdy-unknown-design-20260610-120713.md`.

## 1. Architecture Globale (v2.1)

+-----------------------------------------------------------------------+
|                            INTERFACE TYGR                             |
|       (Next.js App Router + Tailwind CSS + shadcn/ui + Tremor)        |
|     Auth.js (JWT) — contexte { userId, workspaceId, role } ;          |
|     badge workspace permanent ; bandeau DEMO non fermable             |
+----------------------------------+------------------------------------+
|
1. Initialise Link Widget   |   2. Échange PublicToken
& Poll SyncJob Status       |   & Appels Data API (Pull, scopés clientUserId)
v
+----------------------------------+------------------------------------+
|                         API OMNI-FI CORE                              |
|           (Moteur de Scraping & Pipelines d'Enrichissement)           |
|        1 workspace TYGR = 1 EndUser Omni-FI (ClientUserId)            |
+----------------------------------+------------------------------------+
|
| 3. Événements de Synchronisation (Push, HMAC SHA-256)
v
+----------------------------------+------------------------------------+
|                      BACK-END TYGR (Next.js + Inngest)                |
|  Webhook : HMAC dual-env → résolution workspace (tygr_service) →      |
|  dédup EventId → enqueue. Connexion inconnue → quarantaine rejouée    |
|  après link-exchange. Worker durable : curseur atomique, upserts      |
|  idempotents, concurrency=1/connexion. Crons : sync 4h, reconcile     |
|  06:00, partitions année+1.                                           |
+----------------------------------+------------------------------------+
|
| Persistance (Drizzle, rôle tygr_app soumis à RLS, SET LOCAL/txn)
v
+-----------------------------------------------------------------------+
|                  BASE DE DONNÉES POSTGRESQL (Neon)                    |
|   ROW-LEVEL SECURITY forcée sur toutes les tables tenant              |
|   (workspace_id) — cache transactions, soldes EOD, consentements,     |
|   audit append-only, sync_runs                                        |
+-----------------------------------------------------------------------+

## 2. Cycle d'échange et d'ingestion des flux (v2.1)

1.  **Enrôlement (par workspace) :** À la création d'un workspace, TYGR crée un
    EndUser Omni-FI via `POST /clients/end-users` et stocke le `ClientUserId`
    (1 workspace = 1 EndUser — 3e étage d'isolation).
2.  **Liaison :** Le Front-End instancie le Link Widget en consommant un `LinkToken`
    à usage unique (`LinkTokenAuth` → `SessionTokenAuth`). Pendant le widget, le
    panneau audit est alimenté par polling `GET /sync/job/{JobId}` (les webhooks du
    premier sync arrivent avant que la connexion existe en base — voir 4).
3.  **Autorisation et Capture :** `PublicToken` éphémère échangé côté serveur via
    `POST /connections/link-exchange` contre un `ConnectionId` permanent ; insertion
    `bank_connections` + `consent_records`, rejeu de la quarantaine webhook, et
    enqueue d'un job de sync de rattrapage (idempotent).
4.  **Notification :** Webhooks signés HMAC SHA-256 (`x-omnifi-signature`, secrets
    distincts sandbox/production). Ordre de traitement : vérification HMAC
    constant-time → résolution `connection → workspace_id` (rôle `tygr_service`,
    lecture limitée) → dédup `omnifi_event_id` (audit append-only) → enqueue.
    Connexion inconnue → table de quarantaine `webhook_events_pending`. TOUS les
    `EventType` sont tracés ; `sync.failed` passe la connexion en erreur (CTA Repair).
5.  **Aspiration (worker durable Inngest, concurrency=1 par connexion) :**
    `GET /accounts/{AccountId}/transactions/sync` (curseur, `count=500`,
    `clientUserId`) dans une transaction SQL avec `SET LOCAL app.current_workspace_id` :
    `Added[]` en `ON CONFLICT (omnifi_txn_id, transaction_date)` ; `Modified[]` /
    `Removed[]` par lookup `omnifi_txn_id` (date déplacée = DELETE+INSERT) ;
    le curseur n'avance que dans la même transaction que les upserts. Puis
    `GET /accounts/{id}/balances/history` (paginé, type CLBD, recouvrement -3 jours).
    Crons : sync toutes les 4h (si pas de scheduler amont), reconcile 06:00 MUT,
    création de partition année+1.

---

## 3. Analyse Fonctionnelle Détaillée (Les 7 Épiques)

### Epic 1 : Ingestion, Agrégation Bancaire et Hybridation Documentaire
Ce module supervise l'alimentation continue de la plateforme en données réelles ou simulées.

* **FEAT-1.1 : Authentification et Connexion via Widget Embarqué**
    * **User Story :** En tant que dirigeant d'entreprise, je veux lier mes comptes bancaires professionnels en quelques clics afin d'automatiser la collecte de mes flux financiers.
    * **Critères d'Acceptation (BDD) :**
        * *Given* l'utilisateur est sur l'écran "Banques connectées" et clique sur "Ajouter une institution",
        * *When* le serveur génère un token court via `/connections/link-token` et injecte le Link Widget Omni-FI,
        * *Then* l'utilisateur peut s'authentifier de façon sécurisée (Identifiants Sandbox : `sandbox@example.com`), valider son parcours MFA (OTP: `123456`) et l'application récupère un `ConnectionId` valide.
    * **Composant UI :** `<BankConnectionWidget />` — Overlay modal hébergeant l'iframe ou le composant SDK d'authentification Omni-FI, avec gestionnaire d'état de chargement et d'erreur.

* **FEAT-1.2 : Ingestion Asynchrone Idempotente par Curseur (Webhook Driven)**
    * **User Story :** En tant que DAF, je veux que mes soldes et relevés se mettent à jour automatiquement en arrière-plan sans interrompre mes analyses quotidiennes.
    * **Critères d'Acceptation (BDD) :**
        * *Given* l'API Omni-FI émet un webhook de type `sync.completed` pour une connexion donnée,
        * *When* l'application TYGR intercepte le payload et valide le header `x-omnifi-signature`,
        * *Then* le Worker TYGR appelle l'endpoint de synchronisation incrémentale par curseur, applique une clause d'Upsert (Insert ou Update sur conflit de clé immuable) et notifie l'UI via une invalidation de cache globale.

* **FEAT-1.3 : Module de Secours OCR par Import de Fichiers Plats**
    * **User Story :** En tant que gestionnaire, je veux pouvoir téléverser manuellement un relevé bancaire PDF ou CSV en cas de dysfonctionnement momentané des API de ma banque.
    * **Critères d'Acceptation (BDD) :**
        * *Given* l'utilisateur glisse-dépose un relevé de compte au format PDF (max 25 Mo),
        * *When* le système appelle séquentiellement `POST /documents/upload-url`, téléverse vers S3, puis invoque `POST /documents/submit`,
        * *Then* un SyncJob est instancié. L'utilisateur suit le traitement par polling jusqu'à l'extraction complète.
    * **Composant UI :** `<DocumentDropZone />` — Zone interactive de glisser-déposer.

---

### Epic 2 : Plan Analytique Customisé et Surcharge Heuristique
Ce module gère le typage sémantique des flux comptables bruts.

* **FEAT-2.1 : Éditeur d'Arborescence Budgétaire Dynamique**
    * **User Story :** En tant que CEO, je veux structurer mes comptes sous forme de catégories personnalisées.
    * **Critères d'Acceptation (BDD) :**
        * *Given* l'écran de configuration du plan analytique,
        * *When* l'utilisateur réorganise l'arborescence via Drag & Drop,
        * *Then* le système applique les modifications immédiatement (Optimistic UI) et met à jour les relations hiérarchiques.

* **FEAT-2.2 : Surcharge Manuelle de l'Imputation Algorithmique (Audit Trail)**
    * **User Story :** En tant que comptable, je veux corriger manuellement une mauvaise interprétation de la catégorisation automatique.
    * **Critères d'Acceptation (BDD) :**
        * *Given* une transaction enrichie automatiquement,
        * *When* l'utilisateur modifie l'imputation depuis le tableau de bord,
        * *Then* le système persiste la modification en local et transmet la directive via `POST /accounts/{AccountId}/transactions/override`.

---

### Epic 3 : Reporting Graphique et Tableaux de Bord de Performance

* **FEAT-3.1 : Courbe de Ligne de Trésorerie Continue (Hybridation Temporelle)**
    * **User Story :** En tant que dirigeant, je veux visualiser l'historique de mes liquidités fusionné avec mes projections futures.
    * **Critères d'Acceptation (BDD) :** Affiche une ligne continue pour le passé et une ligne pointillée pour le futur.
    * **Composant UI :** `<CashflowMainChart />` (Tremor).

* **FEAT-3.2 : Matrice de Flux Pivot Dentelée (Accordion Pivot Table)**
    * **User Story :** En tant que DAF, je veux analyser mes flux via un tableau croisé dynamique mensuel.

* **FEAT-3.3 : Console de Pilotage du Mur de la Dette (Debt Consolidation)**
    * **User Story :** Agréger l'ensemble des lignes de crédit pour suivre le taux d'utilisation.

---

### Epic 4 : Moteur de Modélisation Prévisionnelle (Cashflow Engine Interne)

* **FEAT-4.1 : Saisie Directe Matricielle et Occurrences Récurrentes**
    * Planifier manuellement une dépense ou un encaissement à venir directement dans la matrice budgétaire.

* **FEAT-4.2 : Moteur de Calcul Linéaire de TVA Décalée**
    * Calcul et projection automatique des décaissements de TVA sur le mois M+1.

---

### Epic 5 : Scénarisation Hypothétique et Analyse d'Écarts (What-If & Variance)

* **FEAT-5.1 : Ramification Graphique de Scénarios Multiples**
    * Modéliser un scénario optimiste et un scénario pessimiste par rapport à la courbe de trésorerie de référence.

* **FEAT-5.2 : Matrice de Variance Budgétaire (Budget vs Actual)**
    * Mesurer l'écart précis entre les prévisions et les flux bancaires réels.

---

### Epic 6 : Comptabilité d'Engagement et Rapprochement Assisté (Lettrage)

* **FEAT-6.1 : Injection Chronologique du Grand Livre des Factures**
    * Importer le catalogue de factures en attente pour projeter automatiquement les encaissements/décaissements.

* **FEAT-6.2 : Interface de Rapprochement Bancaire en Écran Scindé**
    * Associer une facture en attente à une ligne bancaire réelle pour acter son paiement (`<SplitScreenReconciliation />`).

---

### Epic 7 : Consolidation de Groupe et Gestion Multilingue

* **FEAT-7.1 : Agrégation de Holding et Neutralisation Inter-Compagnies**
    * Consolider la trésorerie de plusieurs entités juridiques avec conversion de devises.

* **FEAT-7.2 : Localisation Intégrale de l'Interface Utilisateur**
    * Support i18n complet.

---

## 4. Modèle de Données Multi-Tenant et Persistance (PostgreSQL, v2.1)

> Remplace l'ancien modèle COMPANIES/COMPANY_USERS. Le tenant est le **Workspace**
> (agnostique : BU interne, client SaaS externe, démo, ou consolidation). Toute
> table métier porte `workspace_id UUID NOT NULL` et est protégée par
> Row-Level Security **forcée**. L'application se connecte avec le rôle `tygr_app`
> (soumis à RLS, `SET LOCAL app.current_workspace_id` à chaque transaction).
> Le rôle `tygr_service` (résolution webhook) n'a PAS `BYPASSRLS` : uniquement
> `SELECT (id, omnifi_connection_id, workspace_id)` sur `bank_connections`.

### 4.1 Schéma Logique

```
WORKSPACES (tenant)             USERS                    WORKSPACE_MEMBERS
| id PK                         | id PK                  | user_id PK,FK
| name                          | email UNIQUE (citext)  | workspace_id PK,FK
| kind: INTERNAL_BU |           | full_name              | role: ADMIN |
|   EXTERNAL_CLIENT |           | password_hash (NULL    |   MANAGER | VIEWER
|   DEMO | CONSOLIDATION        |   si SSO)              +------------------
| base_currency                 | is_active
| omnifi_client_user_id UNIQUE  | failed_login_count     WORKSPACE_GRANTS
| omnifi_environment:           | locked_until           | (consolidation, v2 —
|   sandbox | production        +------------------      |  conçu, build différé)
+------------------

BANK_CONNECTIONS ─< BANK_ACCOUNTS ─< TRANSACTIONS_CACHE (partitionnée par date)
(workspace_id,      (workspace_id,    (workspace_id, omnifi_txn_id,
 omnifi_connection   sync_cursor,      UNIQUE(omnifi_txn_id, transaction_date),
 _id, status,        is_selected,      is_removed tombstone)
 next_sync_at)       last_synced_at)
                          └────────< BALANCE_HISTORY (EOD, type CLBD)

CONSENT_RECORDS (append-only)   AUDIT_EVENTS (append-only,    SYNC_RUNS
GRANTED | ACCOUNTS_SELECTED |   omnifi_event_id UNIQUE =      (observabilité,
REVOKED, scope JSONB            dédup webhook)                 trigger, compteurs)

WEBHOOK_EVENTS_PENDING (quarantaine : webhooks reçus avant link-exchange)
LOGIN_ATTEMPTS (rate-limit IP, fenêtre glissante)
```

### 4.2 Script de Génération DDL (extraits structurants)

```sql
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'INTERNAL_BU'
         CHECK (kind IN ('INTERNAL_BU','EXTERNAL_CLIENT','DEMO','CONSOLIDATION')),
    base_currency CHAR(3) NOT NULL DEFAULT 'MUR',
    omnifi_client_user_id VARCHAR(64) NOT NULL UNIQUE,
    omnifi_environment VARCHAR(10) NOT NULL DEFAULT 'sandbox'
         CHECK (omnifi_environment IN ('sandbox','production')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cache transactions : partitionnée par date. La contrainte unique DOIT inclure
-- la clé de partition. Stratégie d'upsert : Added[] via ON CONFLICT
-- (omnifi_txn_id, transaction_date) DO UPDATE (is_removed = FALSE inclus) ;
-- Modified[]/Removed[] par lookup omnifi_txn_id seul (index ci-dessous) ;
-- changement de date = DELETE + INSERT dans la même transaction.
CREATE TABLE transactions_cache (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    omnifi_txn_id VARCHAR(255) NOT NULL,
    transaction_date DATE NOT NULL,   -- BookingDateTime converti en heure de Maurice
    amount DECIMAL(15,2) NOT NULL,
    credit_debit VARCHAR(6) NOT NULL CHECK (credit_debit IN ('Credit','Debit')),
    bank_label_raw TEXT NOT NULL,
    clean_label VARCHAR(255),
    primary_category VARCHAR(120),
    sub_category VARCHAR(120),
    is_removed BOOLEAN NOT NULL DEFAULT FALSE,  -- tombstone (jamais de DELETE physique)
    PRIMARY KEY (id, transaction_date),
    UNIQUE (omnifi_txn_id, transaction_date)
) PARTITION BY RANGE (transaction_date);

-- Partitions initiales [année-2 .. année+1] (le 1er pull couvre jusqu'à 18 mois)
-- + partition DEFAULT alertée si non vide ; cron annuel crée année+1.
CREATE TABLE transactions_cache_default PARTITION OF transactions_cache DEFAULT;
CREATE TABLE transactions_cache_y2024 PARTITION OF transactions_cache
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE transactions_cache_y2025 PARTITION OF transactions_cache
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE transactions_cache_y2026 PARTITION OF transactions_cache
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE transactions_cache_y2027 PARTITION OF transactions_cache
    FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

CREATE INDEX idx_txn_cache_ws_date
    ON transactions_cache (workspace_id, transaction_date DESC);
CREATE INDEX idx_txn_cache_omnifi_id
    ON transactions_cache (omnifi_txn_id);  -- lookup Modified/Removed

-- RLS : activée + FORCÉE sur toutes les tables tenant, politique répliquée
-- par migration sur : bank_connections, bank_accounts, transactions_cache,
-- balance_history, consent_records, audit_events, sync_runs, workspace_members.
ALTER TABLE transactions_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transactions_cache
    USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
    WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);
```

### 4.3 Garanties d'isolation et de fiabilité (critères d'acceptation v2.1)

* **Isolation prouvée par les tests (CI bloquante)** : suite IDOR cross-workspace
  sur chaque endpoint (pages, exports, webhook, admin) → 404 systématique ; requête
  sans WHERE sous `tygr_app` → 0 ligne hors tenant ; `tygr_service` hors périmètre
  → permission denied.
* **Sync idempotente** : rejeu du même webhook x5 → 1 traitement (dédup
  `omnifi_event_id`) ; arrêt du worker en plein sync → reprise sans perte ni doublon.
* **Curseur atomique** : `sync_cursor` n'avance que dans la transaction des upserts
  (`SELECT … FOR UPDATE`, concurrency Inngest = 1 par connexion).
* **Audit append-only** : `consent_records` et `audit_events` sans UPDATE/DELETE
  pour le rôle applicatif ; export JSON par workspace (narratif Innov8).
* **SLO de fraîcheur** : solde < 6h, 95% du temps — instrumenté
  (`now - last_synced_at`) ; badge UI vert < 6h / ambre < 24h / rouge ≥ 24h.
* **Driver DB** : connexion TCP/WebSocket via pooler Neon en mode transaction
  (jamais le driver HTTP — `SET LOCAL` exige une vraie transaction multi-statements).