# Cartographie de l'existant — TYGR (état des lieux, 2026-06-23)

> **Nature** : document d'état des lieux (Staff Engineer / Architecte Produit). Décrit
> ce qui est **réellement implémenté et mergé sur `main`** au 2026-06-23 — pas ce qui
> vit sur les ~24 branches / 10 worktrees en vol (signalé comme tel quand pertinent).
> **Périmètre** : logique métier et opérationnel uniquement (sécurité & CI/CD exclus
> par la commande d'audit ; l'isolation tenant n'est mentionnée que là où elle change
> la lecture fonctionnelle).
> **Sources** : `src/` (code full-stack), `docs/documentation_api.md` (contrat Omni-FI,
> via le clone de référence `omni-fi-core/`), `docs/cahier_des_charges.md` (spec v2.1).
> **Méthode** : croise trois plans — (A) ce que l'**UI affiche**, (B) la **Server Action /
> repository** qui la sert, (C) l'**intégration Omni-FI** sous-jacente.

---

## 0. Résumé exécutif

TYGR est un **outil de trésorerie multi-tenant** opérationnel sur son chemin critique :
un Financial Manager se connecte, lie ses banques via le widget natif Omni-FI (avec
parcours MFA complet), synchronise comptes + transactions, et lit un dashboard de
trésorerie multi-devises, une liste de transactions ventilable, et un référentiel de
catégories + règles de catégorisation automatique. Le socle **multi-entités (BU sous le
Workspace, Option B)** est livré côté données et Server Actions ; il manque surtout son
UI d'administration pour être activable en pratique.

**Ce qui est solide et de bout en bout** : connexion bancaire (widget + MFA), ingestion
comptes/transactions, dashboard soldes par devise, page transactions + ventilation
manuelle, moteur de règles, administration des membres.

**Ce qui est partiel ou absent** (détaillé en §6 et porté en gap analysis dans `TODOS.md`) :
la **synchronisation automatique** (tout est sur clic manuel — pas de webhook ni de cron),
les **soldes EOD / la courbe historique** (source amont `/balances/history` non peuplée en
sandbox → courbe vide), et toute la famille **valeur-ajoutée analytique** qu'Omni-FI offre
mais que TYGR n'appelle pas encore : **Debt Profiling**, **Financial Insights**
(anomalies, vendors, récurrents), **Parties**.

---

## 1. Surface applicative (ce que l'UI expose)

Routing Next.js App Router. Segment `(workspace)` = tout derrière l'authentification et la
résolution de tenant ; `demo/` = maquettes hors auth/DB pour le Visual QA (non productif).

| Route | Écran | Ce qu'il affiche |
|---|---|---|
| `/login` | Authentification | Formulaire email/mot de passe (Auth.js JWT). |
| `(workspace)/(dashboard)` `/` | **Dashboard trésorerie** | Side-panel KPI (SOLDE par devise + pastille de fraîcheur, carte DÉTAILS Cash In/Out, carte Comptes connectés avec provenance bancaire), courbe de trésorerie, table des transactions récentes, bouton « Synchroniser mes comptes ». |
| `(workspace)/transactions` | **Liste des transactions** | Table dense paginée (keyset), provenance par ligne, badge de statut de ventilation, ouverture de la modale de ventilation (`SplitAllocationModal`). |
| `(workspace)/regles` | **Règles de catégorisation** | CRUD des règles (motif → catégorie), application en masse (FYGR-style). |
| `(workspace)/banques` | **Banques connectées** | Lancement du widget natif Omni-FI, finalisation de connexion, écran MFA, repli « Une banque n'apparaît pas ? ». |
| `(workspace)/admin/membres` | **Administration membres** | Provisioning d'un membre (rôle ADMIN/MANAGER/VIEWER). |
| `(workspace)/admin/entites` | **Administration entités** *(Server Actions livrées ; UI = dette `ENTITY-UI1`)* | Référentiel d'entités, sas d'assignation compte→entité, sélecteur de périmètre par membre. |
| `(workspace)/selection` | Sélecteur de workspace | Bascule de workspace actif (Suspense + `loading.tsx`). |
| `(workspace)/graphiques`, `/echeances` | Sections | Empty States (pages présentes, contenu à venir — Epics 3.2/8.2). |
| `demo/*` | Maquettes Visual QA | États loading/vide/erreur/succès de chaque domaine, hors auth/DB. |

**États d'affichage** : convention à deux mécanismes (UI_GUIDELINES §6.5) — `loading.tsx`
natif pour l'attente RSC, composants `<…State/>` présentationnels (`states/`) pour les
états pilotés client. Couverts pour dashboard et transactions.

---

## 2. Server Actions (la frontière client → serveur)

Toutes passent par `withWorkspace` (résolution tenant + RLS). Inventaire réel :

| Fichier | Server Actions | Rôle |
|---|---|---|
| `login/actions.ts` | `connecter` | Authentification (rate-limit IP, lockout). |
| `(workspace)/actions.ts` | `basculerWorkspace` | Change le workspace actif (session update). |
| `(dashboard)/actions.ts` | `syntheseParMoisAction` | Série mensuelle Cash In/Out pour la courbe/cartes. |
| `banques/actions.ts` | `demarrerConnexionAction`, `finaliserConnexionDropinAction`, `synchroniserConnexionsAction` | Démarrage widget, finalisation (échange PublicToken + découverte comptes), synchro manuelle des connexions. |
| `banques/widget-runtime.ts` | `pollJobAction`, `submitMfaAction`, `resendMfaAction` | Pont navigateur → client Omni-FI serveur pour le **parcours MFA** (polling job, soumission OTP, resend). |
| `transactions/actions.ts` | `listerTransactionsAction`, `listerSplitsAction`, `remplacerSplitsAction`, `listerCategoriesAction`, `creerCategorieAction`, `renommerCategorieAction`, `archiverCategorieAction` | Lecture paginée + ventilation + CRUD du référentiel de catégories. |
| `regles/actions.ts` | `listerReglesAction`, `creerRegleAction`, `modifierRegleAction`, `archiverRegleAction`, `appliquerReglesAction` | Moteur de règles de catégorisation. |
| `admin/membres/actions.ts` | `provisionnerMembre` | Création d'un membre + rôle. |
| `admin/entites/actions.ts` | `creerEntiteAction`, `renommerEntiteAction`, `archiverEntiteAction`, `assignerCompteAction`, `definirScopesAction` | Gestion entités + assignation compte→entité + périmètre membre (tous ADMIN-only). |

---

## 3. Couche données (repositories scopés)

`src/server/repositories/` — accès DB confiné ici (règle lint P0-a). Toutes les lectures
financières joignent `bank_accounts` pour hériter du scope entité (étage 2).

| Repository | Fonctions clés | Domaine |
|---|---|---|
| `dashboard.ts` | `listerComptes`, `soldeConsolideCourant`, `soldesCourantsParDevise`, `courbeTresorerie`, `syntheseMois`(@deprecated), `syntheseMoisParDevise`, `syntheseParMois`, `transactionsRecentes` | Agrégats dashboard. **Soldes par devise** (jamais d'addition cross-devise). La courbe et `soldeConsolideCourant` reposent sur `balance_history` (EOD), aujourd'hui vide (cf. §6). |
| `transactions.ts` | `listerTransactions` | Liste paginée keyset + provenance (joint `bank_accounts` + `bank_connections`). |
| `categorisation.ts` | `listerSplits`, `ajouterSplit`, `supprimerSplit`, `remplacerSplits` (atomique), `ecrireAudit`, `listerCategories`, `creerCategorie`, `renommerCategorie`, `archiverCategorie` | Ventilation manuelle (splits) + référentiel de catégories + audit append-only. |
| `regles-categorisation.ts` | `listerRegles`, `creerRegle`, `modifierRegle`, `archiverRegle`, `appliquerRegles`, `echapperLike` | Moteur de règles (split 100 % si non catégorisé, MANUAL prime). |
| `entites.ts` | `listerEntites`, `listerScopesMembre`, `listerMembresWorkspace`, `creerEntite`, `renommerEntite`, `archiverEntite`, `assignerCompteEntite`, `definirScopesMembre` | Multi-entités (Option B). |
| `identite.ts`, `provisioning.ts` | (auth, membership, provisioning rôle) | Identité & multi-tenant. |
| `ingestion.ts` | `upsertConnexion`, `upsertCompte`, `upsertTransactions`, `marquerSynchronise` | Persistance idempotente de l'ingestion (upserts `onConflictDoUpdate`). |

---

## 4. Intégration Omni-FI (le contrat consommé)

`src/server/omnifi/` (client `client.ts`, auth multi-schéma `auth.ts`, config fail-closed
`config.ts`, erreurs `erreurs.ts`) + orchestrateur `src/server/ingestion/`.

**Méthodes du client réellement implémentées** (ce que TYGR appelle) :

| Méthode client | Endpoint Omni-FI | Usage TYGR |
|---|---|---|
| `creerLinkToken` | `POST /connections/link-token` | Bootstrap du widget. |
| `echangerSessionToken` | `widget/session/exchange` | LinkToken → SessionToken. |
| `contexteLinkToken` | `link-token/context` | Contexte de session widget. |
| `connecter` | `link-connect` | Soumission des identifiants bancaires (PII, jamais journalisée). |
| `getSyncJob` / `getSyncJobServeur` | `GET /sync/job/{JobId}` (Bearer / ApiKey) | **Polling du parcours de sync + MFA**. |
| `soumettreMfa` | `POST /sync/{JobId}/input` | Soumission OTP (watermark strict). |
| `resendMfa` | `POST /sync/{JobId}/resend` | Renvoi OTP (cooldown, max 3). |
| `getSyncJobAccounts` | `GET /sync/job/{JobId}/accounts` | **Découverte des comptes** d'une connexion. |
| `echangerPublicToken` | `POST /connections/link-exchange` | PublicToken éphémère → ConnectionId permanent. |
| `listerComptesConnexion` | (comptes d'une connexion) | Rattachement comptes. |
| `listerTransactionsPage` / `resumeTransactions` | `GET /accounts/{id}/transactions` (page-based) | **Ingestion des transactions** (pagination par page `Links.Next`, pas par curseur). |

**Schémas d'authentification** : les 4 schémas Omni-FI sont gérés par endpoint
(`ApiKey` serveur, `LinkToken` bootstrap, `Bearer SessionToken` widget). `ClientUserId` =
`workspaces.omnifi_client_user_id` (frontière tenant).

**Flux d'ingestion** (orchestrateur) : à la finalisation (`finaliserConnexionDropinAction`),
les comptes sont découverts et rattachés automatiquement ; le bouton « Synchroniser » ingère
les transactions de chaque compte sélectionné (boucle paginée → `upsertTransactions`,
idempotent). Modèle **par page** (le `/sync` par curseur est une extension amont non
déployée, cf. `OMNIFI_API_FEEDBACK.md` §10).

---

## 5. Tableau de correspondance Épiques (cahier des charges) → état réel

| Épique / FEAT | Spec | État sur `main` |
|---|---|---|
| **FEAT-1.1** Connexion widget + MFA | Epic 1 | ✅ **Livré** (widget natif, machine MFA pure + hook, parcours OTP/resend complet). |
| **FEAT-1.2** Ingestion idempotente | Epic 1 | 🟡 **Partiel** : ingestion idempotente OK, mais **déclenchée manuellement** (pas de webhook ni de cron — cf. §6 / `DASH-AUTOSYNC1`). Modèle page, pas curseur. |
| **FEAT-1.3** Import OCR PDF/CSV | Epic 1 | ❌ Absent (P3, `/documents/*` non câblé). |
| **FEAT-2.1** Arborescence budgétaire | Epic 2 | 🟡 Référentiel de catégories **plat** livré (CRUD) ; arborescence hiérarchique + drag&drop non faits. |
| **FEAT-2.2** Surcharge manuelle + audit | Epic 2 | ✅ **Livré** (ventilation manuelle `remplacerSplits` atomique + audit append-only). L'override vers `POST /transactions/override` côté amont n'est pas câblé (local-only). |
| **FEAT-3.1** Courbe de trésorerie | Epic 3 | 🟡 **Composant livré**, mais **données EOD vides** (`/balances/history` 404 sandbox) → courbe en attente de source (cf. §6). |
| **FEAT-3.2** Matrice de flux pivot | Epic 3 | ❌ Différé (P2, gate CEO). |
| **FEAT-3.3** Console mur de la dette | Epic 3 | ❌ Absent (P3) — alors que l'API **Debt Profiling** est riche (cf. §6). |
| **Epic 8.1** Catégorisation auto | Epic 8 | 🟡 **Moteur de règles déterministe livré** (motif→catégorie). Le scoring/ML et l'usage de la catégorisation Omni-FI native ne sont pas faits. |
| **Epic 8.2** Dettes & échéanciers | Epic 8 | ❌ Absent (P2). |
| **Epic 8.3** Alertes proactives | Epic 8 | ❌ Absent (P2) — l'API expose pourtant `CategoryAnomalies` / `insights/alerts`. |
| **Multi-entités (Option B)** | Roadmap | 🟡 **Données + RLS + Server Actions livrés** ; **UI d'admin manquante** (`ENTITY-UI1`). |
| **Epics 4, 5, 6, 7** | — | ❌ Différés intégralement (le schéma v2.1 les anticipe). |

---

## 6. Lecture d'architecte — les écarts structurants

Ces écarts alimentent la **gap analysis** (`TODOS.md`). Ils sont classés par impact métier
pour le persona **Financial Manager multi-BU**.

1. **Synchronisation manuelle (pas d'automatisation)** — le cœur de la promesse FEAT-1.2
   (« mise à jour automatique en arrière-plan ») n'est pas tenu : aucun **webhook** Omni-FI
   n'est reçu (pas de route `/api/webhooks/omnifi` malgré l'architecture v2.1 du cahier des
   charges) et aucun **cron** Inngest ne rejoue la synchro. Les données « gèlent » entre deux
   clics. → `DASH-AUTOSYNC1` (déjà tracé), + nouvelle dette **webhook** (§ gap analysis).

2. **Soldes EOD / courbe historique sans source** — toute la courbe et l'ancien
   `soldeConsolideCourant` dépendent de `balance_history`, vide car `/balances/history` n'est
   pas peuplé côté sandbox. Le solde courant a été dérivé des `current_balance` (bonne
   décision), mais l'**historique** reste un trou fonctionnel visible (« en cours de
   synchronisation »).

3. **Valeur analytique Omni-FI non exploitée** — l'API offre, prêts à l'emploi et alignés sur
   des besoins déjà au cahier des charges (Epic 8, Epic 3.3) :
   - **Financial Insights** (`/dashboard/insights`, `/insights/*`) : `CashflowRibbon`,
     `TopVendors`, `CategorySummary`, **`CategoryAnomalies`**, `RecurringPayments`,
     `IncomeInsights`, `Alerts`. C'est **exactement** FEAT-8.3 (alertes : liquidités
     dormantes, frais anormaux) + une partie de FEAT-3.1, livrables sans moteur interne.
   - **Debt Profiling** (`/dashboard/debt`, `/debt/instruments`, `/debt/exposure/*`,
     repayment prediction) : c'est **FEAT-3.3** (mur de la dette) clé en main.
   - **Parties** (`/parties/{PartyId}/accounts`, `PartyId`/`PartyName`/`OwnershipType` sur les
     comptes) : pré-remplissage du **sas d'assignation entité** (multi-entités), déjà identifié
     `ENTITY-PARTY1`.

4. **Multi-entités non activable faute d'UI** — le persona « FM gérant N BU » est la priorité
   démo n°1, le socle data+RLS+actions est là, mais sans les pages d'admin (référentiel, sas,
   sélecteur de périmètre), aucune Vision Entité n'est utilisable. → `ENTITY-UI1`.

5. **Catégorisation : déterministe seulement** — le moteur de règles (motif→catégorie) est
   livré et utile, mais la **catégorisation native Omni-FI** (`primary_category`/`sub_category`
   enrichies par l'amont, priorité `USER_RULE > SYSTEM_RULE > ML_FALLBACK`) n'est pas
   exploitée comme socle, et il n'y a pas de **score de confiance** pilotant une file de revue
   (FEAT-8.1).

6. **Surcharge non propagée à l'amont** — la ventilation manuelle est purement locale ;
   `POST /accounts/{id}/transactions/override` (FEAT-2.2) n'est pas appelé, donc l'amont ne
   ré-apprend pas des corrections de l'utilisateur.

---

> **Note de gouvernance** : les fonctionnalités manquantes ci-dessus sont portées dans
> `TODOS.md` (registre canonique, règle 9) avec priorité/date/effort/déclencheur. Cette
> cartographie n'est pas un backlog — c'est la photo de l'existant à un instant T.
