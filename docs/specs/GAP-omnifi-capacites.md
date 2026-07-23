# GAP — capacités Omni-FI exposées vs consommées par TYGR

**Date** : 2026-07-23 · **Branche** : `plan/omnifi-gap` (base `origin/main` @ `bc51e14`)
**Phase** : CONCEPTION / INVESTIGATION (CLAUDE.md règle 1) — **aucune ligne de code applicatif**, aucune écriture en base, aucun appel amont (ni GET ni POST).
**Question posée** : que paie-t-on chez Omni-FI que TYGR n'exploite pas, quelle valeur métier, quel effort ?

---

## 0. Verdict en une page

**La surface réseau de TYGR est close et vérifiable** : `src/server/omnifi/client.ts` est le **seul** point d'appel amont de tout le dépôt (grep exhaustif sur `src/` et `scripts/` — aucun `fetch` vers `omni-fi.co` ailleurs). Ce qui n'y figure pas n'est pas consommé, point.

Sur **~40 endpoints documentés**, le client en implémente **18**, dont **4 sont du code mort** (zéro appelant). Le vrai gisement n'est cependant **pas** dans les endpoints manquants — c'est dans **les champs déjà reçus et jetés**, et dans **deux paramètres jamais transmis**.

| Constat | Portée |
|---|---|
| **A. Trois prémisses du cadrage sont périmées** — l'`Enrichment{}` imbriqué est corrigé, les Parties SONT ingérées, `/balances/history` est **404** (pas 501) | §2 |
| **B. Le plus gros gisement = des champs reçus et jetés** : `RunningBalance`, `Status`, `ValueDateTime`, `TransactionReference`, `AccountTypeCode`, `IsAsset` | §4.4, §4.6 |
| **C. Deux capacités « achetées » à valeur haute et effort S** : `GET /accounts/{id}/transactions/summary` (preuve de complétude) et `GET /sync/account/{id}/jobs` (diagnostic par compte) | §4.3, §4.5 |
| **D. Un risque de MONTANT non tracé** : rien ne distingue un compte de prêt/carte d'un compte courant → le « Solde Total » peut agréger de la dette avec de la trésorerie | §5.1 |
| **E. Une hypothèse de défaillance à trancher en priorité** : si `/balances/history` 404 toujours, **chaque run de sync meurt au premier compte** — explication candidate des « 35 % de comptes à zéro transaction » | §5.2 |
| **F. Le seul levier d'historique >92 j disponible AUJOURD'HUI est le Document Upload** — `POST /sync?fromDate=` existe mais est neutralisé par l'extracteur `_pro` | §4.8, §6 |

**Priorisation recommandée** (détail §7) : 3 tickets à ouvrir, 5 à raccrocher, 1 vérification runtime à faire **avant** tout code.

---

## 1. Méthode et périmètre

**Sources croisées, dans cet ordre de préséance :**

| Rang | Source | Ce qu'elle établit |
|---|---|---|
| 1 | **Runtime constaté** (`DIAGNOSTIC-profondeur-historique.md`, `OMNIFI_API_FEEDBACK.md`, `CONSTAT-metadonnees-comptes.md`) | Ce que l'API fait **vraiment** |
| 2 | **Code TYGR** (`src/server/omnifi/`, `src/server/ingestion/`, `src/server/widget/orchestration.ts`, `src/server/inngest/`) | Ce que TYGR consomme **vraiment** |
| 3 | **`docs/documentation_api.md`** (aligné Fern) | Ce qui est **vendu** — et donc ce qu'on paie |

La doc est la source de vérité du **contrat**, jamais du **comportement** : l'écart doc↔réel est documenté ×4 sur ce projet (`/v1`, `Enrichment`, `/transactions/sync`, `client_user_id`). Toute capacité citée « d'après la doc » et non prouvée au runtime est marquée **⚠️ non vérifié**.

**Légende des statuts.** `exploitée` = appelée ET la donnée atterrit en base ou à l'écran · `partiellement` = appelée mais une partie du contrat est ignorée · `achetée-inexploitée` = exposée au contrat, zéro appel · `non pertinente` = hors modèle TYGR (dashboard interne Omni-FI, ou flux géré par le SDK drop-in).

**Effort** : `S` ≤ 1 j · `M` 2–5 j · `L` > 1 semaine / chantier dédié avec cross-review.

---

## 2. Correction de trois prémisses du cadrage

Le brief demandait de confirmer par la doc et le code plutôt que de présumer. Trois points du cadrage ne tiennent plus :

**① `types.ts:97-99` lirait les champs marchand à plat — FAUX depuis la PR #101.**
`OmniFiEnrichment` existe (`src/server/omnifi/types.ts:94-101`, 6 champs) et `versLignePersistee` lit bien `t.Enrichment?.CleanMerchantName` (`src/server/ingestion/orchestrateur.ts:114,133`). Mieux : la normalisation `""` → `null` est en place (`chaineOuNull`, `orchestrateur.ts:66-69`) et les 3 champs de traçabilité sont persistés (TECH-API-TRACE livré, PR #110). **Ce qui reste de `PROD-MERCHANT1` est donc purement de l'AFFICHAGE**, pas de l'ingestion.
⚠️ En revanche **`docs/documentation_api.md:908-911` montre toujours `PrimaryCategory`/`SubCategory`/`CleanMerchantName` À PLAT** — la doc n'a jamais été corrigée. C'est un point à remonter (§6, R1).

**② Les Parties ne sont pas « ignorées au MVP » — elles sont ingérées.**
`versPartie` (`src/server/repositories/ingestion.ts:323-331`) mappe `PartyId`/`PartyName`/`OwnershipType` ; `upsertPartieEtRole` alimente `parties` + `account_party_role` dans une transaction séparée. Preuve prod (TODOS `ENTITY-PARTY1`, 2026-07-02) : **28 parties, 100 % nommées, 77 liens**. Ce qui manque est le **pont `Party → entities → bank_accounts.entity_id`**, pas l'ingestion. La phrase de CLAUDE.md (« Parties volontairement IGNORÉES au MVP ») décrit l'intention de 2026-06-22, plus l'état du code.

**③ `/balances/history` est en 404, pas en 501.**
`OMNIFI_API_FEEDBACK.md §10` : `404` **page HTML générique**, pas une enveloppe OBIE ; `grep` sur le code Django `staging` ne trouve la route nulle part. Le 501 concerne les **Insights** (`INSIGHTS-AMONT1`). La distinction n'est pas cosmétique : un 501 est une route branchée non implémentée, un 404 HTML est une route **inexistante** — et surtout, **un 404 lève une `OmniFiApiError` non attrapée dans le chemin d'ingestion** (§5.2). Deux entrées TODOS écrivent « 501 » pour `/balances/history` (`DASH-COURBE-SOLDE-EOD`, ligne 2435 ; renvoi `DASH-SOLDE2`) — à corriger.

---

## 3. Ce que TYGR consomme réellement (inventaire prouvé)

18 méthodes au client. Comptage des appelants hors `client.ts` :

| Méthode | Endpoint | Appelants | Statut |
|---|---|---:|---|
| `creerLinkToken` | `POST /connections/link-token` | 2 | ✅ ONBOARD + REPAIR |
| `echangerPublicToken` | `POST /connections/link-exchange` | 2 | ✅ |
| `listerConnexions` | `GET /connections` | 2 | ✅ |
| `listerComptesConnexion` | `GET /accounts?connectionId=` | 3 | ✅ (route **non documentée**) |
| `definirComptesAutorises` | `PUT /connections/{id}/accounts` | 1 | ✅ |
| `declencherSync` | `POST /sync/{id}` | 2 | ⚠️ sans `fromDate`/`toDate` |
| `getLatestSyncJob` | `GET /sync/{id}/latest-job` | 4 | ✅ |
| `getSyncJobServeur` | `GET /sync/job/{id}` (ApiKey) | 2 | ✅ |
| `getSyncJob` | `GET /sync/job/{id}` (Bearer) | 1 | ✅ widget |
| `getSyncJobAccounts` | `GET /sync/job/{id}/accounts` | 1 | ✅ |
| `soumettreMfa` | `POST /sync/{id}/input` | 1 | ✅ widget custom |
| `resendMfa` | `POST /sync/{id}/resend` | 1 | ✅ widget custom |
| `listerTransactionsPage` | `GET /accounts/{id}/transactions` | 1 | ✅ (route **non documentée**) |
| `historiqueSoldes` | `GET /accounts/{id}/balances/history` | 1 | ⛔ **appelée, route 404** (§5.2) |
| `resumeTransactions` | `GET /accounts/{id}/transactions/summary` | **0** | 💀 code mort |
| `echangerSessionToken` | `POST /widget/session/exchange` | **0** | 💀 code mort (SDK drop-in) |
| `contexteLinkToken` | `GET /connections/link-token/context` | **0** | 💀 code mort (SDK drop-in) |
| `connecter` | `POST /connections/link-connect` | **0** | 💀 code mort (SDK drop-in) |

**Lecture** : les 3 derniers morts sont le **prix de la bascule widget custom → SDK drop-in** (`@omni-fi/react-link` gère session/connect/context en interne). Ce n'est pas une capacité perdue, c'est de la dette de code. `resumeTransactions`, lui, est une **vraie capacité achetée et jamais branchée** (§4.3).

---

## 4. Tableau de gap — capacité par capacité

### 4.1 Developer Platform & Institutions

| Capacité | Statut | Endpoint / champ | Valeur métier | Effort | Dette liée |
|---|---|---|---|---|---|
| Création d'EndUser | **achetée-inexploitée** | `POST /clients/end-users` | **Onboarding self-service d'un workspace.** Aujourd'hui `omnifi_client_user_id` est posé à la main (seed) ; sans EndUser créé côté Omni-FI → `403` en boucle (cf. `diag-sync-403-enduser-prod`). Bloque la mission « SaaS-ready » du cahier | **S** | aucune → **à ouvrir** |
| Catalogue de banques | achetée-inexploitée | `GET /institutions`, `/{id}` | Logo, `BrandColour`, `MfaType`, `CustomerTypes` dans `/banques` et l'écran de choix. Faible : le widget drop-in porte déjà le catalogue ; `institution_name` est persisté (DASH-INST1) | S | `META-COMPTE3` (affichage institution) |
| Demande de banque non supportée | non pertinente | `POST /institution-requests` | SessionToken widget uniquement → géré par le drop-in | — | — |
| Gestion des clés API | non pertinente | `/clients/*/keys/*` | BearerAuth dashboard Omni-FI, hors surface applicative | — | — |

### 4.2 Link Widget & Connections

| Capacité | Statut | Endpoint / champ | Valeur métier | Effort | Dette liée |
|---|---|---|---|---|---|
| LinkToken ONBOARD + REPAIR | **exploitée** | `POST /connections/link-token` | — | — | — |
| ↳ `RequestedScopes` | **partiellement** | paramètre omis (`orchestration.ts:152-158`) | On accepte les **scopes par défaut** de l'amont. Tant qu'`insights`/`alerts` ne sont pas consommés c'est sain ; **à re-vérifier le jour où on branche `/insights/*`** (un scope absent = 403 tardif) | S | raccrocher à `INSIGHTS-AMONT1` |
| ↳ `AppName` / `AppLogoUrl` | achetée-inexploitée | paramètres omis | **White-label du widget** aux couleurs TYGR — argument de démo BOM Innov8 / sales enablement | S | aucune → mineure |
| ↳ `WebhookUrl` | achetée-inexploitée | paramètre omis | Router `connection.created` par session vers une URL de test — utile au lot W4 | S | `GAP-WEBHOOK1` |
| ↳ `Documents.*` | achetée-inexploitée | `RequiredHistoryDays`, `MaxFiles`, `AcceptedFormats`, `FraudStrictness` | **Porte d'entrée du Document Upload** (§4.8) | (voir 4.8) | — |
| Échange PublicToken | exploitée | `POST /connections/link-exchange` | — | — | — |
| Account Selection | exploitée | `PUT /connections/{id}/accounts` | — | — | — |
| **Révocation de connexion** | **achetée-inexploitée** | `DELETE /connections/{ConnectionId}` | **Purge des credentials du vault chiffré côté Omni-FI.** Mission 1 du produit = narratif réglementaire *consent flow + audit trail* : on sait accorder un consentement (`enregistrerConsentement` GRANTED) mais **pas le révoquer chez le fournisseur**. C'est un trou de conformité, pas de confort | **S** | `SYNC-REVOCATION1` (P2) — **à remonter P1**, cf. §7 |
| Session widget (exchange / connect / context / revoke) | non pertinente | `/widget/session/*`, `/link-connect` | Géré par le SDK drop-in ; nos 3 méthodes sont mortes | S (suppression) | aucune → dette de code mort |

### 4.3 Transactions

| Capacité | Statut | Endpoint / champ | Valeur métier | Effort | Dette liée |
|---|---|---|---|---|---|
| Liste paginée | **exploitée** | `GET /accounts/{id}/transactions` | — | — | dette A du DIAGNOSTIC (`\|\|` sur `Links.Next`) |
| ↳ bornes `fromBookingDateTime` / `toBookingDateTime` | **achetée-inexploitée** | query **non documentée**, **prouvée fonctionnelle** (DIAGNOSTIC §5) | **Ingestion par fenêtres de dates** — seul remède connu à l'instabilité de la pagination offset (≈ 5 % de lignes omises par passe isolée, DIAGNOSTIC §7-B). Contre-preuve : fenêtre d'un jour → `TotalRecords: 54`, 54 ids distincts, 54 en base | **M** | constat B — **à ouvrir** |
| **Résumé agrégé** | **achetée-inexploitée** | `GET /accounts/{id}/transactions/summary` (`resumeTransactions`, **0 appelant**) | **Preuve de complétude et de justesse** : comparer `TotalCredits`/`TotalDebits`/`TransactionCount` amont à nos agrégats par période. C'est le contrôle qui aurait fait tomber les constats B, C et D du DIAGNOSTIC **automatiquement**. Le code existe déjà — il ne manque que l'appelant | **S** | aucune → **à ouvrir** |
| Détail d'une transaction | non pertinente | `GET /transactions/{TransactionId}` | Ingestion en masse — aucun besoin unitaire | — | — |
| Surcharge de catégorie | achetée-inexploitée | `POST /accounts/{id}/transactions/override` | Propager nos corrections en amont (audit immuable côté Omni-FI, priorité `USER_RULE`). **Décision produit avant tout code** | S (dev) | `DECISION-PRODUIT-OVERRIDE` (P2) |
| **Export CSV** | **achetée-inexploitée** | `GET /transactions/export`, `/accounts/{id}/transactions/export` | **TYGR n'a AUCUN export** (grep : zéro `text/csv`). Filtres serveur riches : `partyId`, `category`, `merchant`, `creditDebit`, `minAmount`, `search`, `sort`. Besoin de base d'un Financial Manager (rapprochement, transmission au comptable) | S (proxy) / M (export interne) | aucune → **à ouvrir** |
| Sync par curseur | non pertinente | `GET /transactions/sync` | **404** — « extension future » confirmée par Omni-FI (2026-06-19). ⚠️ La colonne `bank_accounts.sync_cursor` existe et n'est **jamais écrite** : dette de schéma morte | — | — |

### 4.4 Champs de transaction reçus et jetés

Contrat `OmniFiTransaction` (`types.ts:103-133`) vs `versLignePersistee` (`orchestrateur.ts:110-155`). **C'est le plus gros gisement du rapport** : la donnée est déjà dans le payload, déjà payée, déjà typée.

| Champ | Statut | Valeur métier | Effort | Dette liée |
|---|---|---|---|---|
| **`RunningBalance`** | **achetée-inexploitée** (typé `types.ts:120`, jamais mappé) | **Reconstruire la courbe EOD sans attendre `/balances/history`** : dernier `RunningBalance` de chaque jour comptable (`AT TIME ZONE 'Indian/Mauritius'`, E20). Lève la décision DR-F3 et alimente le prévisionnel. ⚠️ Souvent `null` en sandbox — mesurer le taux de remplissage en **prod** avant de s'engager | **M** | **`PROD-TRESO-EOD1` (P1)** |
| **`Status`** (`Booked`/`Pending`) | achetée-inexploitée | Un `Pending` **n'est pas un débit acquis**. Aujourd'hui il est agrégé comme un mouvement définitif → un solde projeté peut être faux à la baisse | **S** | aucune → **à ouvrir** |
| **`ValueDateTime`** | achetée-inexploitée | Date de valeur ≠ date comptable. Le *float* bancaire est un sujet de trésorerie corporate à part entière (un virement comptabilisé le 30 mais valeur le 2 ne finance pas la fin de mois) | S | aucune → à ouvrir |
| **`TransactionReference`** | achetée-inexploitée | Référence de virement = **clé de rapprochement bancaire** manuelle. Directement lié au trou « pas d'identifiant de compte » (CONSTAT §5.2-①) | S | aucune → à ouvrir |
| `IsDuplicate` | achetée-inexploitée | L'amont signale **ses** doublons métier. ⚠️ À ne pas confondre avec les doublons de **pagination** (constat B) : ce sont deux phénomènes distincts | S | — |
| `PartyId` (niveau transaction) | achetée-inexploitée | Attribution directe d'une écriture à une entité légale, sans passer par le compte | S | `ENTITY-PARTY1` |
| `NormalizedDescription` | achetée-inexploitée | 3ᵉ cran possible de la cascade de libellé, entre `CleanMerchantName` et `TransactionInformation` | S | `PROD-MERCHANT1` |
| `ManuallyOverridden`, `IsActive` | achetée-inexploitée | N'ont de sens que si `/transactions/override` est branché | S | `DECISION-PRODUIT-OVERRIDE` |
| `Enrichment.ConfidenceLevel` / `ClassificationSource` / `RuleIdMatch` | **partiellement** | **Capturés en base** (TECH-API-TRACE, PR #110) mais **jamais lus** : ni UI, ni file de revue, ni arbitrage de priorité | M | `GAP-CATEG-NATIVE1` (P2) |

### 4.5 Sync Engine

| Capacité | Statut | Endpoint / champ | Valeur métier | Effort | Dette liée |
|---|---|---|---|---|---|
| Déclenchement manuel | **partiellement** | `POST /sync/{id}` — **`fromDate`/`toDate` jamais transmis** (`client.ts:386-395`, la signature ne les accepte même pas) | Historique profond (**548 j / 18 mois**, `apps/sync_engine/views.py:48`). **Neutralisé en amont** pour nos 3 connexions (§4.8) | S | §6, R4 |
| Polling job | **exploitée** | `GET /sync/job/{id}` | — | — | — |
| ↳ `PersistenceStats` | **partiellement** | loggé au chemin manuel (`orchestration.ts:727`), **non persisté, non comparé** | `TransactionsCreated/Updated/Duplicated` amont vs nos compteurs = **détection de désync base↔amont** (leçon #201). Aujourd'hui l'info passe dans un `console.info` et meurt | S | raccrocher à `sync_runs` (lot W2) |
| ↳ `Attempts`, `Source`, `Metadata` | achetée-inexploitée | typés, jamais lus | Observabilité fine (scrape vs upload, nb de tentatives) | S | idem |
| MFA (input / resend) | exploitée | `POST /sync/{id}/input`, `/resend` | — | — | — |
| **Historique de jobs par compte** | **achetée-inexploitée** | `GET /sync/account/{AccountId}/jobs` (filtre `status`, paginé) | **L'outil exact du constat D non résolu** : « 55 comptes sur 157 (35 %) ont zéro transaction » et « 32 comptes s'arrêtent net au 30/06 ». Cet endpoint dit, **par compte**, quand un job a échoué et pourquoi. Aujourd'hui on ne sait diagnostiquer qu'au niveau connexion | **S** | DIAGNOSTIC §7-D → **à ouvrir** |
| Enveloppe `Meta.TotalRecords` | **partiellement** | exploitée sur `/connections` (`orchestration.ts:1198,1247`), **jamais sur `/transactions` ni `/balances`** | La garde de complétude qui a résolu #201 n'a **pas** été propagée à l'ingestion. C'est la moitié manquante de la dette A | S | DIAGNOSTIC §7-A |
| `Errors[].Id` (réf. d'audit) | achetée-inexploitée | `extraireDetails` (`client.ts:129-133`) ne garde que `ErrorCode`/`Path` | La doc demande explicitement de **logger `Id`** : c'est la clé de corrélation avec le support Omni-FI. Sans elle, un incident amont n'est pas traçable de bout en bout | **XS** | aucune → à ouvrir (quick win) |

### 4.6 Comptes & soldes

| Capacité | Statut | Endpoint / champ | Valeur métier | Effort | Dette liée |
|---|---|---|---|---|---|
| Découverte de comptes | exploitée | `GET /sync/job/{id}/accounts`, `GET /accounts` | — | — | — |
| **`AccountTypeCode`, `AccountCategory`, `IsAsset`, `Status`** | **achetée-inexploitée** | jetés au mapping (`orchestration.ts:490-496`) — **aucune colonne d'accueil** | **Risque de MONTANT** (§5.1) : rien ne distingue `LOAN`/`CARD` de `CACC`. ⚠️ `OwnershipType` est le précédent qui impose la prudence : exposé au contrat, **vide sur 100 %** des 30 parties → « exposé » ≠ « peuplé ». Faire confirmer avant de migrer | **S** (migration expand + mapping) | **`META-COMPTE1`** (CONSTAT §7) |
| `Balances[].Type` | **partiellement** | `soldeCourant` prend `ITAV`, **sinon `balances[0]`** (`orchestration.ts:304-308`) | Le repli sur le premier élément est **arbitraire** : `CLAV`, `ITBD`, `FWAV` ont des sens distincts (disponible vs comptable vs prévisionnel). Un repli silencieux sur le mauvais type fausse le solde | S | aucune → à ouvrir |
| `Nickname` / `PartyName` | **partiellement — bug** | `??` ne neutralise pas `""` → 78/157 comptes sans nom | **Trou TYGR à 100 %**, prouvé sans payload live | **S** (≤ 20 lignes) | **`META-COMPTE2` (P1)** |
| Préférences de compte | **achetée-inexploitée** | `PATCH /accounts/{AccountId}` (`Nickname`, `IsActive`) | `Nickname` = **1er choix du nom TYGR** → renommer côté amont réglerait « 78 comptes SBM indistinguables » à la source. `IsActive:false` **exclut un compte des syncs** = moins de scrape, moins de rate-limit. ⚠️ Décision produit : source de vérité du nom amont ou locale ? | **S–M** | `META-COMPTE1`/`3` |
| Historique de soldes EOD | ⛔ **appelée mais 404** | `GET /accounts/{id}/balances/history` | Voir §5.2 — **à trancher avant tout autre chantier** | — | `DASH-COURBE-SOLDE-EOD`, `DASH-SOLDE2` |
| Solde courant | non documentée mais réelle | `GET /accounts/{id}/balances` (existe, `FEEDBACK §10`) | Non appelée : les soldes arrivent **inline** dans `GET /accounts`. Rafraîchir un solde sans re-scraper resterait utile | S | — |

### 4.7 Parties, Webhooks, Insights, Debt

| Capacité | Statut | Endpoint / champ | Valeur métier | Effort | Dette liée |
|---|---|---|---|---|---|
| Ingestion des parties | **exploitée** | `OmniFiAccount.PartyId/PartyName/OwnershipType` | 28 parties / 77 liens en prod | — | — |
| Comptes d'une partie | achetée-inexploitée | `GET /parties/{PartyId}/accounts` | Sens **inverse** de ce qu'on ingère (party → comptes). Valeur faible : l'info est déjà en base par compte. Utile seulement pour contrôler la complétude d'un rattachement | S | `ENTITY-PARTY1` (P2) |
| Pont Party → entité | **manquant côté TYGR** | — | 77 comptes prod à assigner à la main. `parties.entity_id` **existe déjà** au schéma : le pont est structurellement prêt. ⚠️ Frontière d'isolation : **PRÉ-REMPLIR, jamais créer/assigner automatiquement** (1 credential = N entités → fuite intra-groupe) | M | **`ENTITY-PARTY1` (P2, mûre)** |
| **Webhooks temps réel** | **achetée-inexploitée** | `PUT /dev/webhooks/config`, `POST /rotate-secret`, `POST /test`, **12 `EventType`** | **La synchro ne se déclenche jamais d'elle-même.** État réel : socle **W1 livré** (`executerPourWorkspaceSysteme`, worker `omnifi-sync-ingest` durable). **Manquent : W2** (cron — aucun `cron:` dans `src/server/inngest/`), **W3** (rôle `tygr_service` — absent du provisioning), **W4** (route `/api/webhooks/omnifi` — absente). Conception déjà écrite (`PLAN-ingestion-webhook-omnifi.md`) | **L** | **`GAP-WEBHOOK1` (P1)** + `DASH-AUTOSYNC1` |
| Insights financiers | achetée-**indisponible** | `/dashboard/insights`, `/insights/{cashflow,vendors,alerts}` | **501 sur les 4**, même sans auth → module non branché. Voie A (dérivation interne) livrée. **Ne PAS coder de client** : un 501 ne révèle aucun payload → on figerait un parseur contre un contrat fantôme | M (le jour du 200) | `INSIGHTS-AMONT1` (P2), `TECH-API-INSIGHTS` |
| Debt Profiling | achetée-inexploitée ⚠️ non vérifié | `/dashboard/debt`, `/debt/instruments`, `/debt/*/repayment`, `/debt/exposure/*` | Couvre FEAT-3.3 (mur de la dette) et une partie de FEAT-8.2 (échéanciers) **sans saisie manuelle** ; `repayment` fournit une **prédiction** qui alimenterait le prévisionnel. Peuplement sandbox **jamais testé** | M–L | `TECH-API-DEBT` (P3) |

### 4.8 Document Upload — le levier d'historique oublié

| Capacité | Statut | Endpoint / champ | Valeur métier | Effort |
|---|---|---|---|---|
| Import de relevés (PDF/OFX/QFX/CSV) | **achetée-inexploitée** | `POST /documents/upload-url` → S3 → `/analyze` → `/submit` → poll `GET /sync/job/{id}` ; + `Documents.*` au link-token | **Le seul chemin disponible AUJOURD'HUI pour obtenir de l'historique au-delà de 92 j** sur les variantes `_pro`, sans dépendre d'un correctif amont. `RequiredHistoryDays` cadre l'exigence ; `Coverage`/`Period`/`Confidence` valident la couverture avant traitement ; 5 codes d'erreur nommés (malware, format, période insuffisante, OCR faible, timeout) | **L** |

Point favorable établi (DIAGNOSTIC §6) : **aucune rétention/purge côté Omni-FI** — `cleanup_old_jobs` ne touche que `raw_scraper_output`, `Transaction.account` est en `on_delete=PROTECT`. **Un backfill est un one-shot permanent** : le coût est payé une fois.

---

## 5. Deux risques identifiés en cours d'analyse

### 5.1 Risque de montant — aucune typologie de compte n'est persistée

`bank_accounts` porte `currency`, `current_balance`, `account_name` — **et rien qui dise ce qu'est le compte**. `soldeCourant` prend l'`ITAV` de **n'importe quel** compte, y compris un `LOAN` ou une `CARD` (le contrat expose `AccountTypeCode ∈ CACC|CARD|LOAN|SVGS|…` et `IsAsset`, tous deux jetés).

**Mode de défaillance concret** : un encours de prêt ou de carte de crédit remonté comme solde positif est **additionné à la trésorerie** dans les agrégats de comptes. Le montant affiché n'est alors ni faux au sens arithmétique, ni juste au sens métier — et rien dans le système ne permet de le détecter.

**Ce qui n'est PAS établi** : que ces comptes existent dans le parc actuel, ni que `AccountTypeCode` soit réellement peuplé (précédent `OwnershipType`, vide à 100 %). C'est précisément l'objet de la question ③ du brouillon de message Omni-FI (CONSTAT §8). **Ne pas migrer avant la réponse** — mais ne pas non plus considérer le sujet comme cosmétique : c'est la seule ligne de ce rapport qui touche la règle 8.

### 5.2 Hypothèse à trancher AVANT tout chantier — le 404 de `/balances/history`

**Le fait, établi par lecture de code :** `synchroniserCompteComplet` (`src/server/ingestion/index.ts:88-103`) appelle `client.historiqueSoldes(...)` **sans aucun `try/catch`**. Un `404` lève `OmniFiApiError` qui traverse toute la pile jusqu'au `step.run("ingerer-compte-…")` du worker (`sync-ingest.ts:405-415`).

**La conséquence, si le 404 de juin vaut encore :**

1. les transactions du compte sont **déjà commitées** (upsert par page + `marquerSynchronise`) — la donnée n'est pas perdue ;
2. mais l'exception **casse la boucle `for (const compte of comptes)`** → **les comptes suivants de la connexion ne sont jamais ingérés** ;
3. le run part en retry ×3 puis meurt `FAILED` au dashboard Inngest.

Sur une connexion à 78 comptes, **un seul compte serait ingéré par run**. Cela constitue une **explication candidate — non prouvée —** du constat D du DIAGNOSTIC : « 55 comptes sur 157 (35 %) ont zéro transaction », « 32 comptes s'arrêtent net au 2026-06-30 ».

**Hypothèse concurrente, tout aussi plausible** : l'endpoint répond aujourd'hui `200 { HistoricalBalances: [] }` — auquel cas tout va bien, et c'est la mention « 404 » de nos notes de juin qui est périmée.

**Test discriminant (lecture seule, 2 minutes, aucun POST) :**

```bash
# 1. la route répond-elle encore 404 ?
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: ApiKey <client_id>:<secret>" \
  "$OMNIFI_BASE_URL/accounts/<un_account_id>/balances/history"

# 2. corroboration sans réseau : des runs `omnifi-sync-ingest` en FAILED,
#    avec des comptes ingérés « 1 sur N », au dashboard Inngest.
```

**Pourquoi c'est la première action du plan** : le résultat change la nature de trois autres chantiers. Si le 404 est vivant, `PROD-TRESO-EOD1` cesse d'être une amélioration de courbe pour devenir un **correctif de complétude d'ingestion**, et le constat D est refermé sans investigation supplémentaire.

⚠️ Conformément au mandat : **aucun contournement n'est proposé ici en code.** Le rapport nomme le risque et le test ; le correctif appartient à un ticket dédié.

---

## 6. À remonter à Omni-FI (écarts doc ↔ comportement réel)

Aucun de ces points n'appelle un contournement côté TYGR. Six sont **nouveaux** ou **non encore transmis** ; les autres complètent `OMNIFI_API_FEEDBACK.md`.

| # | Écart | Preuve | Impact intégrateur |
|---|---|---|---|
| **R1** | **`Enrichment{}` toujours documenté À PLAT.** La doc montre `PrimaryCategory`/`SubCategory`/`CleanMerchantName` à la racine de `Transaction` ; le serializer les niche sous `Enrichment{}` | `documentation_api.md:908-911` vs `serializers.py get_Enrichment` ; corrigé côté TYGR par la PR #101 | **Déjà payé une fois** : 100 % des libellés en fallback « Opération bancaire ». Tout nouvel intégrateur suivant la doc reproduira le bug |
| **R2** | **Champs de transaction absents de la doc** : `TransactionInformation` (le narratif OBIE réel — la doc annonce `Description`), `RunningBalance` | vérifié runtime + audit serializer | La doc envoie lire un champ qui n'existe pas dans le contrat HTTP public |
| **R3** | **Défauts en chaîne vide au lieu de `null`.** `get_Enrichment` pose `""`, `Nickname`/`PartyName` aussi | CONSTAT §3.3 : le repli `??` ne s'est **jamais** déclenché sur 157 comptes | `??` ne neutralise pas `""` → 78 comptes sans nom. Piège systémique pour tout intégrateur TypeScript. **Documenter la convention, ou renvoyer `null`** |
| **R4** | **`history_from_date` accepté puis ignoré** par `mcb_pro_extractor` (fenêtre 92 j en dur) ; idem `absa_pro`. Seule la variante **personnelle** `inst_mcb` l'honore | `mcb_pro_transactions.py:54-62`, `mcb_pro.py:170-184`, `mcb.py:475-483` | **Aucune donnée avant avril 2026 n'existera jamais**, quoi que fasse TYGR. Un paramètre accepté-puis-ignoré est pire qu'un paramètre refusé : il donne l'illusion du contrôle |
| **R5** | **Pagination offset instable** : 1 923 lignes servies pour 1 821 ids distincts (102 doublons) sur 20 pages ; tri non déterministe sur `-booking_date_time` avec ex æquo | DIAGNOSTIC §7-B | Une passe isolée perd ≈ 5 % des lignes. Correctif attendu : **tri stable** (clé secondaire sur l'id) ou pagination par curseur |
| **R6** | **`OwnershipType` exposé, vide sur 100 %** des comptes (3 banques, 157 comptes) | CONSTAT §5.2-⑤ | « Exposé » ≠ « peuplé ». Question ouverte : alimenté un jour, ou à retirer du contrat ? |
| **R7** | **Aucun identifiant bancaire au contrat** — ni `Identification`, ni `SchemeName`, ni IBAN, là où OBIE `OBReadAccount6` les prévoit | CONSTAT §5.2-① | 78 comptes, une seule party, aucun discriminant humain. Un **masque** (`••••4321`) suffirait |
| **R8** | **Routes documentées non déployées** (`/transactions/sync`, `/balances/history` → **404 HTML**, pas une enveloppe OBIE) ; **routes déployées non documentées** (`/accounts/{id}/transactions` paginé, `/accounts/{id}/balances`, bornes `fromBookingDateTime`) | FEEDBACK §10 + DIAGNOSTIC §5 | Déjà transmis (§10). **Reste ouvert** ; à re-tester à chaque sprint. Le 404 HTML casse la désérialisation JSON de l'intégrateur |
| **R9** | **Casse des query params incohérente** : `client_user_id` en snake_case, `pageSize`/`institutionId` en camelCase ; un nom mal cassé est **silencieusement ignoré** → `403` opaque | FEEDBACK §8 + annexe | Déjà transmis. À uniformiser |

---

## 7. Recommandation de priorisation

### 7.1 Avant tout code — 2 vérifications, ~1 h

| # | Action | Pourquoi d'abord |
|---|---|---|
| **V1** | **Trancher le 404 de `/balances/history`** (§5.2) | Change la nature de `PROD-TRESO-EOD1` et referme potentiellement le constat D |
| **V2** | **Envoyer le message Omni-FI** (CONSTAT §8, brouillon prêt) + questions R1/R4/R6 | Les réponses conditionnent `META-COMPTE1` et le sort de l'historique profond |

### 7.2 Chantiers dédiés (spec propre, cross-review)

| Chantier | Ticket | Pourquoi un chantier et pas une PR de feature |
|---|---|---|
| **Ingestion pilotée par webhook** — lots W3 (rôle `tygr_service`) + W4 (route HMAC, dédup, quarantaine) | **`GAP-WEBHOOK1` (P1)** | Surface sécurité (HMAC constant-time, rôle privilégié, résolution de tenant depuis un payload externe). Conception **déjà écrite** ; W1 déjà livré → le chantier est cadré, pas exploratoire |
| **Complétude d'ingestion** — fenêtres de dates + assertion `Meta.TotalRecords` + branchement de `/transactions/summary` + propagation de la dette A aux 6 boucles | **à ouvrir : `INGEST-COMPLETUDE1` (P1)** | Trois constats convergents (A, B, C du DIAGNOSTIC) ont **la même racine** : on ne vérifie jamais que ce qu'on a ingéré correspond à ce que l'amont annonce. Les traiter séparément revient à payer trois fois la même mise en place |
| **Document Upload** | **à ouvrir : `GAP-DOCUPLOAD1` (P2)** | Seul levier d'historique >92 j maîtrisé côté TYGR (§4.8). **Conditionné à V2/R4** : si Omni-FI câble `history_from_date` sur les extracteurs `_pro`, ce chantier devient inutile — d'où l'ordre |

### 7.3 À raccrocher à un ticket existant

| Capacité inexploitée | Raccrocher à | Ajustement proposé |
|---|---|---|
| `RunningBalance` → courbe EOD | **`PROD-TRESO-EOD1` (P1)** | Ajouter au ticket : **mesurer le taux de remplissage en prod avant de s'engager** (souvent `null` en sandbox, `types.ts:120`) |
| `Status`, `ValueDateTime`, `TransactionReference`, `IsDuplicate`, `NormalizedDescription`, `PartyId` | **`PROD-TRESO-EOD1`** (même migration `transactions_cache`, expand-only) | Un seul passage de migration sur une table partitionnée append-only plutôt que six |
| `AccountTypeCode`, `AccountCategory`, `IsAsset`, `Status` compte | **`META-COMPTE1` (P1)** | Ajouter le **risque de montant** (§5.1) comme justification — le ticket est aujourd'hui motivé par l'ergonomie seule |
| `Nickname` vide + `PATCH /accounts/{id}` | **`META-COMPTE2` (P1)** | Trancher la source de vérité du nom (amont vs local) dans le même ticket |
| `ConfidenceLevel` / `ClassificationSource` / `RuleIdMatch` en lecture | **`GAP-CATEG-NATIVE1` (P2)** | Pré-requis satisfait depuis PR #110 — le ticket est **débloqué**, à re-prioriser |
| Pont Party → entité | **`ENTITY-PARTY1` (P2)** | Les deux déclencheurs sont levés (retour terrain + parties peuplées) → **mûre pour planification** |
| `PersistenceStats`, `Attempts`, `Source` | **lot W2 (`sync_runs`)** | L'observabilité de sync a déjà sa table prévue au plan |
| `RequestedScopes` explicites | **`INSIGHTS-AMONT1` (P2)** | À poser le jour où un scope `insights`/`alerts` devient nécessaire, pas avant |
| `GET /sync/account/{id}/jobs` | **à ouvrir : `DIAG-COMPTES-MUETS1` (P2)** | Répond au constat D (35 % de comptes à zéro) — **sauf si V1 le referme**, d'où l'ordre |
| `Errors[].Id` en log | **quick win XS** | À glisser dans la prochaine PR touchant `client.ts` — ne mérite pas son ticket |

### 7.4 À NE PAS faire maintenant (décisions explicites, pas des oublis)

| Capacité | Raison de ne pas y aller |
|---|---|
| `/insights/*`, `/dashboard/insights` | **501 sur les 4.** Coder un client contre un 501 = figer un parseur sur un contrat fantôme. Piège déjà payé ×2 (`/v1`, `Enrichment`). Re-tester chaque sprint, ne rien écrire |
| `/debt/*` | Aucun écran dette n'existe : c'est un chantier produit neuf (P3), pas une dette d'intégration. **Prouver d'abord** que les endpoints sont peuplés en sandbox |
| `POST /transactions/override` | Bloqué sur une **décision produit** (moteur local vs propagation amont) — règle 10 : l'arbitrage précède le code |
| Suppression des 4 méthodes mortes du client | Nettoyage sain mais **sans valeur métier** ; à faire opportunément, jamais en PR dédiée |
| `GET /institutions` | Le SDK drop-in porte déjà le catalogue ; `institution_name` est persisté. Valeur marginale |

---

## 8. Ce qui n'a pas pu être vérifié

- **Aucun appel amont** (mandat lecture seule) : les statuts `404`/`501` sont ceux **constatés en juin 2026** et **peuvent avoir changé** — d'où V1 en tête de plan.
- **Peuplement réel** de `AccountTypeCode`, `AccountCategory`, `IsAsset`, `Status`, et taux de remplissage de `RunningBalance` en **prod** : indéterminables depuis nos tables (jamais persistés → aucune trace secondaire, contrairement au cas `PartyName` tranché par la couche Parties).
- **Peuplement des endpoints `/debt/*`** : jamais testé, même en sandbox.
- **Les refs locales de `omni-fi-core` dataient du 2026-06-17** au moment du DIAGNOSTIC (~5 semaines) ; le `staging` déployé a pu bouger. Les citations `mcb_pro.py`/`views.py` en héritent.
- **Le comportement runtime des extracteurs n'a pas été exécuté** — lecture de code uniquement (R4 : confiance 8/10 selon le DIAGNOSTIC).
- **Un seul workspace en base** : les proportions par banque reflètent **un** client, pas le parc.

---

## 9. Références

| Document | Apport |
|---|---|
| `docs/documentation_api.md` | Contrat vendu (source de vérité du gap) |
| `OMNIFI_API_FEEDBACK.md` §8, §10, §11 | Écarts doc↔réel déjà transmis à Omni-FI |
| `DIAGNOSTIC-profondeur-historique.md` | Fenêtre 92 j, pagination instable (B), comptes muets (D) |
| `CONSTAT-metadonnees-comptes.md` (worktree `investig/metadonnees-comptes`, **non commité**) | Métadonnées de comptes, tri amont/TYGR, brouillon de message |
| `PLAN-ingestion-webhook-omnifi.md` | Conception des lots W1→W4 |
| `TODOS.md` | `PROD-MERCHANT1`, `PROD-TRESO-EOD1`, `GAP-WEBHOOK1`, `ENTITY-PARTY1`, `GAP-CATEG-NATIVE1`, `TECH-API-INSIGHTS`, `TECH-API-DEBT`, `SYNC-REVOCATION1`, `INSIGHTS-AMONT1` |

> **Note de traçabilité** — `CONSTAT-metadonnees-comptes.md` vit dans un worktree non commité (`tygr-metacomptes`). Ce rapport en dépend sur §4.6 et §5.1 : à committer, sans quoi les tickets `META-COMPTE*` perdent leur preuve.
