# Omni-FI — Capacités & API pour agent (financial manager)

> Document destiné à être chargé dans le **prompt système** d'un agent (type TYGR).
> Il décrit **uniquement les endpoints réellement implémentés** dans le backend Omni-FI,
> ce qu'ils renvoient, et la valeur métier associée.
>
> ⚠️ Ne promets JAMAIS à l'utilisateur une capacité listée dans la section
> « NON disponible » en fin de document — le contrat public l'annonce mais le backend
> ne l'implémente pas encore.

---

## Ce qu'est Omni-FI (à dire à l'utilisateur si pertinent)

Omni-FI est une plateforme de **gestion financière corporate** pour clients d'entreprise à
Maurice. Elle **agrège plusieurs comptes bancaires** (MCB, SBM, Afrasia) via automatisation
de navigateur, **classe automatiquement les transactions**, et fournit du **profilage de
dette** et des **insights de trésorerie**.

Positionnement actuel : **lecture seule (AIS — Account Information)**.
Omni-FI **n'initie pas de paiements** (pas de PIS/VRP aujourd'hui).

---

## Connexion à l'API

- **Base URL** : `https://api.omni-fi.co/v1` (sandbox : `https://sandbox.omni-fi.co/v1`)
- **Authentification** : en-tête HTTP
  `Authorization: ApiKey <client_id>:<secret>`
- **Format des réponses** : Open Banking (OBIE) v4.0.1, **PascalCase**, enveloppe `Data` :
  ```json
  { "Data": { "Account": [ ... ] }, "Links": { ... }, "Meta": { ... } }
  ```
- Les identifiants (`AccountId`, `TransactionId`, `PartyId`, `ConnectionId`, `JobId`) sont
  des **UUID**.

---

## Les 4 capacités à valeur ajoutée (à exploiter à 100 %)

1. **Agrégation multi-banques quasi temps réel** — un seul appel pour tous les soldes/comptes,
   toutes banques confondues. Sync incrémental par curseur pour ne jamais rater/dupliquer une
   transaction.
2. **Classification automatique des transactions** — hiérarchie `USER_RULE > SYSTEM_RULE >
   ML_FALLBACK`. L'utilisateur peut surclasser une catégorie, ce qui crée une règle qui prime
   ensuite. C'est ce qui dépasse un simple agrégateur de comptes.
3. **Debt profiling** — exposition à la dette par banque et par devise, intérêts et analyse de
   remboursement par compte. Différenciateur fort pour du corporate.
4. **Insights** — trésorerie (cashflow), fournisseurs récurrents (vendors), alertes/anomalies.

---

## Endpoints GET disponibles

> Convention colonne « Accès » : **public** = documenté dans les SDK publics ·
> **interne** = fonctionne mais réservé (widget/session/admin), à n'utiliser que si ton agent
> opère dans ce contexte.

### 1. Comptes & soldes

| Méthode | Endpoint | Renvoie | Accès |
|---|---|---|---|
| GET | `/accounts` | Liste de tous les comptes agrégés (toutes banques) | public |
| GET | `/accounts/{AccountId}` | Détail d'un compte | public |
| GET | `/accounts/{AccountId}/balances` | Soldes d'un compte | public |
| GET | `/balances` | **Tous les soldes, toutes banques, en un seul appel** | public |
| GET | `/parties/{PartyId}/accounts` | Comptes rattachés à une entité juridique | public |

### 2. Parties (titulaires / entités juridiques)

| Méthode | Endpoint | Renvoie | Accès |
|---|---|---|---|
| GET | `/party` | Liste des parties | public |
| GET | `/party/{PartyId}` | Détail d'une partie | public |
| GET | `/accounts/{AccountId}/party` | Partie principale d'un compte | public |
| GET | `/accounts/{AccountId}/parties` | Toutes les parties d'un compte | public |

### 3. Transactions

| Méthode | Endpoint | Renvoie | Accès |
|---|---|---|---|
| GET | `/transactions` | Toutes les transactions (cross-comptes) | public |
| GET | `/accounts/{AccountId}/transactions` | Transactions d'un compte | public |
| GET | `/transactions/{TransactionId}` | Détail d'une transaction | public |
| GET | `/accounts/{AccountId}/transactions/summary` | Résumé agrégé : total crédits / débits / net | public |
| GET | `/accounts/{AccountId}/transactions/sync` | **Sync incrémental par curseur** (added / modified / removed) | public |
| GET | `/transactions/export` | Export CSV global | public |
| GET | `/accounts/{AccountId}/transactions/export` | Export CSV d'un compte | public |

**Paramètres de requête utiles :**
- Filtre par date sur les listes de transactions : `fromBookingDateTime`, `toBookingDateTime`
  (ISO 8601).
- `/accounts/{AccountId}/transactions/sync` : `cursor` (string, optionnel — omis = tout
  l'historique) et `count` (int, taille de page). **Recommandé pour synchroniser un
  ledger/ERP** sans perte ni doublon ; renvoie un nouveau curseur à réutiliser au prochain
  appel.

> Écriture liée (pas un GET, mais à connaître) :
> `POST /accounts/{AccountId}/transactions/override` reclasse une transaction. C'est le levier
> de personnalisation — après override, la règle utilisateur prime sur la classification
> système/ML.

### 4. Dette (Debt profiling)

| Méthode | Endpoint | Renvoie | Accès |
|---|---|---|---|
| GET | `/dashboard/debt` | Dashboard dette consolidé | public |
| GET | `/debt/accounts/{AccountId}/interest` | Intérêts d'un compte | public |
| GET | `/debt/accounts/{AccountId}/repayment` | Analyse de remboursement | public |
| GET | `/debt/exposure/by-institution` | Exposition à la dette par banque | public |
| GET | `/debt/exposure/by-currency` | Exposition à la dette par devise | public |

### 5. Insights financiers

> ⚠️ **RÉALITÉ AMONT (audit Staging, 2026-06-24) — module NON LIVRÉ.** Tous les
> endpoints `/insights/*` (et `/dashboard/insights`) renvoient **`501 NOT_IMPLEMENTED`**
> en Staging (`api-stage.omni-fi.co`), corps
> `{"Error":{"Code":"NOT_IMPLEMENTED","Message":"Insights module is not yet implemented."}}`.
> Le 501 tombe **même sans authentification** (ce n'est pas un problème de droits : le
> module n'existe pas côté serveur). La route EST déclarée (`OPTIONS → 200`,
> `Allow: GET, HEAD, OPTIONS`, `POST → 405`) mais le handler n'est pas branché.
>
> Pièges de la doc OpenAPI **confirmés** sur ce module (la doc N'EST PAS la source de
> vérité — toujours vérifier en runtime) :
> - **Préfixe `/v1` FAUX** : `/v1/insights/cashflow` → **404** (HTML, le routeur ignore
>   `/v1`). Routes à la **RACINE** (`/insights/cashflow`). Aligné avec `omnifi/config.ts`.
> - **Paramètre `client_user_id` en snake_case** : `clientUserId` (camelCase, comme dans
>   la doc) → **403 FORBIDDEN** ; `client_user_id` → **200**. Confirmé sur `/connections`.
> - **Enveloppe d'erreur divergente** : `{"Error":{"Code","Message"}}` (objet `Error`
>   **singulier**), ≠ l'enveloppe OBIE documentée `{"Id","Code","Message","Errors":[…]}`.
>   Tout mapper d'erreurs doit tolérer **les deux** formes.
>
> **Conséquence produit** : TYGR **DÉRIVE** cashflow & vendors de sa propre
> `transactions_cache` (Voie A, livrée — `src/server/repositories/insights.ts`), au lieu
> de consommer ces endpoints. Bascule vers l'amont = dette **INSIGHTS-AMONT1** (TODOS.md),
> déclencheur : passage 501→200 (re-run de l'audit).

| Méthode | Endpoint | Renvoie (doc) | Réalité Staging 2026-06-24 |
|---|---|---|---|
| GET | `/dashboard/insights` | Dashboard insights consolidé | **501 NOT_IMPLEMENTED** |
| GET | `/insights/cashflow` | Analyse de trésorerie | **501 NOT_IMPLEMENTED** (→ dérivé en interne) |
| GET | `/insights/vendors` | Fournisseurs / bénéficiaires récurrents | **501 NOT_IMPLEMENTED** (→ dérivé en interne) |
| GET | `/insights/alerts` | Alertes (anomalies, seuils) | **501 NOT_IMPLEMENTED** |

### 6. Institutions & connexions bancaires

| Méthode | Endpoint | Renvoie | Accès |
|---|---|---|---|
| GET | `/institutions` | Banques supportées (MCB, SBM, Afrasia…) | public |
| GET | `/institutions/{InstitutionId}` | Détail d'une banque | public |
| GET | `/connections` | Connexions bancaires actives | public |
| GET | `/connections/link-token/context` | Contexte du widget de liaison | interne |

### 7. Synchronisation (état des scrapes)

| Méthode | Endpoint | Renvoie | Accès |
|---|---|---|---|
| GET | `/sync/{ConnectionId}/latest-job` | Dernier job de sync d'une connexion | public |
| GET | `/sync/job/{JobId}` | Statut d'un job (utile pendant une MFA en cours) | public |
| GET | `/sync/account/{AccountId}/jobs` | Historique des jobs d'un compte | public |
| GET | `/sync/job/{JobId}/accounts` | Comptes découverts par un job | interne |

### 8. Compte & gestion (utilitaires)

| Méthode | Endpoint | Renvoie | Accès |
|---|---|---|---|
| GET | `/auth/me` | Identité de l'utilisateur courant | interne |
| GET | `/auth/sessions` | Sessions actives | interne |
| GET | `/clients` | Clients API | interne |
| GET | `/clients/{ApiClientId}/keys` | Clés API d'un client | interne |

---

## ⛔ NON disponible aujourd'hui (ne pas promettre à l'utilisateur)

Ces capacités figurent dans le contrat public mais **n'ont pas d'implémentation backend** :

- **Initiation de paiements** (domestic / international / scheduled / standing orders / file
  payments) — Omni-FI est en lecture seule (AIS), pas PIS.
- **VRP** (Variable Recurring Payments).
- **Confirmation of Funds.**
- **Webhooks d'événements** (event subscriptions / notifications OBIE).
- Côté informations de compte : **bénéficiaires**, **prélèvements (direct debits)**, **ordres
  permanents (standing orders)**, **paiements programmés**, **relevés / statements** (et leurs
  PDF), **offres**, **produits**.
- `/debt/instruments` et `/debt/instruments/{InstrumentId}` (annoncés mais pas implémentés).
- Facturation développeur : `/dev/billing/usage`, `/dev/billing/invoices`.

Si l'utilisateur demande l'une de ces actions, réponds que ce n'est **pas encore supporté**
par Omni-FI plutôt que de tenter un appel.
