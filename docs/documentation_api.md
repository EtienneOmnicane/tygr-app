# Omni-FI Core API — Fiche Technique

**Version:** 1.0.0  
**Standard:** Open Banking OBIE v4.0.1 (PascalCase JSON)  
**Hosted docs:** `omni-fi.docs.buildwithfern.com`

---

## Environnements

| Environnement | Base URL |
|---|---|
| Production | `https://api.omni-fi.co/v1` |
| Staging | `https://api-stage.omni-fi.co/v1` |
| Sandbox (mock banks) | `https://sandbox.omni-fi.co/v1` |

---

## Authentification

L'API supporte quatre méthodes d'authentification selon le contexte appelant.

### 1. ApiKeyAuth — Clients B2B (principal)

Authentification serveur-à-serveur pour les partenaires API.

```
Authorization: ApiKey <client_id>:<secret>
```

- `client_id` : identifiant public de l'`ApiClient` (ex: `client_3f9f4a5e2c0d4b8a`)
- `secret` : clé secrète générée via `POST /clients/{ApiClientId}/keys/generate`
- Le secret n'est retourné qu'une seule fois à la génération (Display-Once / Hash / Mask)
- Les clés sont scoped par environnement (`sandbox` ou `production`)

### 2. BearerAuth — Dashboard interne

JWT standard pour le dashboard administrateur Omni-FI.

```
Authorization: Bearer <jwt_access_token>
```

- Obtenu via `POST /auth/login`
- Durée courte — renouveler via `POST /auth/token/refresh`
- Rôles : `OWNER`, `ADMIN`, `VIEWER`, `BOT`

### 3. LinkTokenAuth — Bootstrap widget (usage unique)

Token à usage unique pour initialiser la session du Link Widget.

```
Authorization: LinkToken <link_token>
```

- Obtenu via `POST /connections/link-token` (appel server-side avec ApiKey)
- Utilisé **uniquement** pour appeler `POST /widget/session/exchange`
- TTL court (~15 min), consommé atomiquement à l'échange

### 4. SessionTokenAuth — Link Widget (session active)

Token de session issu de l'échange du LinkToken.

```
Authorization: Bearer <session_token>
```

- Obtenu via `POST /widget/session/exchange`
- Expire : 30 min absolu ou 10 min d'inactivité
- **Toutes les requêtes widget** après l'échange utilisent ce token
- L'`Origin` HTTP doit correspondre au `RedirectOrigin` configuré sur le LinkToken

---

## Headers communs (FAPI / OBIE)

| Header | Requis | Description |
|---|---|---|
| `x-fapi-interaction-id` | Non | UUID RFC4122 de corrélation pour le traçage |
| `x-fapi-customer-ip-address` | Non | IP de l'utilisateur final (PSU) |
| `x-customer-user-agent` | Non | User-agent de l'utilisateur final |
| `x-idempotency-key` | Selon endpoint | Clé d'idempotence (max 40 chars, 24h TTL) |
| `x-omnifi-signature` | Webhooks entrants | Signature HMAC SHA-256 du payload |

---

## Pagination

Tous les endpoints de liste acceptent :

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `page` | integer | 1 | Numéro de page |
| `pageSize` | integer | 20 | Enregistrements par page |

Réponses paginées : enveloppe `{ Data, Links, Meta }` avec `Links.Next`, `Links.Prev`, `Meta.TotalPages`, `Meta.TotalRecords`.

---

## Format des erreurs

Toutes les erreurs suivent l'enveloppe OBIE :

```json
{
  "Id": "err-ref-audit",
  "Code": "400 BadRequest",
  "Message": "Description lisible",
  "Errors": [
    {
      "ErrorCode": "CODE_MACHINE_READABLE",
      "Message": "Détail de l'erreur",
      "Path": "$.FieldName",
      "Url": "https://docs.../remediation"
    }
  ]
}
```

> **Champs `Id` et `Errors[].Url` (préc. Fern 2026-06-15)** : `Id` est une
> référence d'erreur unique (audit) à logger côté TYGR ; `Url` (optionnel) pointe
> une page de remédiation. Le client mappe `Code` + `Errors[].ErrorCode`/`Path`
> vers ses erreurs nommées ; `Message` (PII potentielle) n'est jamais exposé brut.

---

## Modules & Endpoints

### Authentication

> Accès interne (dashboard). Utiliser `BearerAuth` pour les appels post-login.

---

#### `POST /auth/login`

Authentifie un utilisateur et retourne des tokens JWT.

**Auth:** Aucune  
**Body:**
```json
{ "Email": "user@example.com", "Password": "secret" }
```
**Réponse 200:**
```json
{
  "Data": {
    "AccessToken": "eyJ...",
    "RefreshToken": "eyJ...",
    "User": {
      "UserId": "uuid",
      "Email": "user@example.com",
      "FullName": "John Doe",
      "Role": "ADMIN",
      "IsActive": true,
      "CreatedAt": "2024-01-01T00:00:00Z"
    }
  }
}
```

---

#### `POST /auth/token/refresh`

Renouvelle l'AccessToken.

**Auth:** Aucune  
**Body:** `{ "RefreshToken": "eyJ..." }`  
**Réponse 200:** `{ "Data": { "AccessToken": "eyJ..." } }`

---

#### `POST /auth/logout`

Révoque un RefreshToken.

**Auth:** BearerAuth  
**Body:** `{ "RefreshToken": "eyJ..." }`

---

#### `POST /auth/logout/all`

Révoque toutes les sessions de l'utilisateur.

**Auth:** BearerAuth

---

#### `GET /auth/sessions`

Liste les sessions actives.

**Auth:** BearerAuth  
**Réponse:** liste de `Session` `{ SessionId, IssuedAt, ExpiresAt, UserAgent, IpAddress, IsValid }`

---

#### `DELETE /auth/sessions/{SessionId}`

Révoque une session spécifique.

**Auth:** BearerAuth

---

### Institutions

> Catalogue global des banques supportées (Maurice).

---

#### `GET /institutions`

Liste toutes les institutions supportées.

**Auth:** ApiKeyAuth | SessionTokenAuth | BearerAuth  
**Query:** `page`, `pageSize`  
**Réponse 200:**
```json
{
  "Data": {
    "Institutions": [
      {
        "InstitutionId": "mcb",
        "Name": "MCB Group",
        "Branding": {
          "Square": "https://...",
          "Wide": "https://...",
          "BrandColour": "#E30613"
        },
        "MfaType": "sms",
        "CustomerTypes": ["PERSONAL", "CORPORATE"]
      }
    ]
  },
  "Links": { "Self": "...", "Next": "..." },
  "Meta": { "TotalPages": 1 }
}
```

> **Note SessionToken :** l'`Origin` de la requête doit correspondre à `WIDGET_ALLOWED_ORIGIN`.

---

#### `GET /institutions/{InstitutionId}`

Détail d'une institution.

**Auth:** ApiKeyAuth | SessionTokenAuth  
**Path:** `InstitutionId` (string)

---

#### `POST /institution-requests`

Soumet une demande pour une institution non supportée.

**Auth:** SessionTokenAuth  
**Body:** `{ "BankName": "XYZ Bank", "Email": "user@example.com" }`  
**Réponse 202:** `{ "Data": { "Status": "received" } }`

---

### Developer Platform

> Gestion des clients API et des clés. Réservé aux rôles OWNER/ADMIN.

---

#### `POST /clients/end-users`

Enregistre un utilisateur final (EndUser) lié au client API appelant.

**Auth:** ApiKeyAuth  
**Body:**
```json
{ "ClientUserId": "your-internal-user-id" }
```
**Réponse 201:**
```json
{
  "Data": {
    "EndUser": {
      "ClientUserId": "your-internal-user-id",
      "CreatedAt": "2024-01-01T00:00:00Z",
      "UpdatedAt": "2024-01-01T00:00:00Z"
    }
  }
}
```

> `ClientUserId` doit être unique dans le scope de l'ApiClient. À créer **avant** d'initier des connexions.

---

#### `GET /clients`

Liste les ApiClients de l'utilisateur authentifié.

**Auth:** BearerAuth

---

#### `POST /clients`

Crée un nouveau ApiClient.

**Auth:** BearerAuth (OWNER/ADMIN)  
**Body:** `{ "Name": "Acme Corp" }`

---

#### `POST /clients/{ApiClientId}/keys/generate`

Génère une clé API (Display-Once).

**Auth:** BearerAuth  
**Body:** `{ "Environment": "production", "Name": "Initial key" }`  
**Réponse 201:**
```json
{
  "Data": {
    "ApiKey": {
      "ApiKeyId": "uuid",
      "Secret": "prod_sk_8x9y...X4p7Q",
      "SecretMasked": "prod_sk_***p7Qx",
      "Environment": "production",
      "IsActive": true,
      "CreatedAt": "...",
      "ExpiresAt": null
    }
  }
}
```

> Le `Secret` en clair n'est **jamais** redonné. Stocker immédiatement.

---

#### `GET /clients/{ApiClientId}/keys`

Liste les clés (sans secret en clair).

**Auth:** BearerAuth

---

#### `POST /clients/{ApiClientId}/keys/{ApiKeyId}/rotate`

Remplace le secret d'une clé existante (Display-Once).

**Auth:** BearerAuth

---

#### `POST /clients/{ApiClientId}/keys/{ApiKeyId}/revoke`

Désactive une clé (soft-delete, audit conservé).

**Auth:** BearerAuth

---

### Link Widget — Flux de connexion bancaire

Le Link Widget est le composant frontend qui guide l'utilisateur final pour connecter sa banque. Flux en 5 étapes :

```
[Serveur B2B]  POST /connections/link-token          → LinkToken
[Widget]       POST /widget/session/exchange          → SessionToken
[Widget]       POST /connections/link-connect         → PublicToken + JobId
[Widget]       GET  /sync/job/{JobId}  (polling)      → suivi job
[Serveur B2B]  POST /connections/link-exchange        → ConnectionId permanent
```

---

#### `POST /connections/link-token`

Crée un LinkToken court-vécu pour initialiser le widget.

**Auth:** ApiKeyAuth  
**Body:**
```json
{
  "ClientUserId": "uuid-de-votre-utilisateur",
  "RedirectOrigin": "https://your-app.example.com",
  "InstitutionId": "mcb",
  "RequestedScopes": ["accounts", "insights", "alerts", "data"],
  "AppName": "Mon App",
  "AppLogoUrl": "https://...",
  "AccountSelectionEnabled": true,
  "WebhookUrl": "https://your-server.com/webhooks/omnifi"
}
```

> **Précisions Fern 2026-06-15** : `ClientUserId` (**requis**, UUID) = NOTRE id
> interne d'EndUser (= `workspaces.omnifi_client_user_id`). `RedirectOrigin`
> (**requis**) = origine HTTPS (scheme+host, sans path/query/fragment) autorisée à
> recevoir le `PublicToken` par `postMessage`. `RequestedScopes` ∈
> `accounts|insights|alerts|data` — **un tableau vide déclenche `400
> VALIDATION_ERROR`** (omettre pour les défauts). `WebhookUrl` (optionnel) route le
> webhook `connection.created` de cette session vers une URL alternative.
> **Réponse 201** : `{ Data: { LinkToken, Expiration } }`.

Champs optionnels pour le mode **Repair** (re-connexion d'un compte en erreur) :

| Champ | Description |
|---|---|
| `ConnectionId` | UUID de la connexion défaillante |
| `JobId` | UUID du SyncJob en échec |
| `ResumeStep` | `CREDENTIALS` ou `MFA_CHALLENGE` |

Champ optionnel pour **Document Upload** :

| Champ | Description |
|---|---|
| `Documents.RequiredHistoryDays` | Couverture minimale exigée (défaut: 90) |
| `Documents.MaxFiles` | Nbre max de fichiers (défaut: 10, max: 50) |
| `Documents.MaxFileMb` | Taille max par fichier (défaut: 25 MB) |
| `Documents.AcceptedFormats` | `["pdf","ofx","qfx","csv"]` |
| `Documents.FraudStrictness` | `strict` / `standard` / `permissive` |
| `Documents.AllowedBankBrands` | Filtre par banque (ex: `["mcb","sbm-mu"]`) |

**Réponse 201:**
```json
{
  "Data": {
    "LinkToken": "lt_xxxxx",
    "Expiration": "2024-01-01T00:15:00Z",
    "Mode": "ONBOARD",
    "ResumeStep": null,
    "ConnectionId": null,
    "JobId": null,
    "InstitutionId": "mcb"
  }
}
```

---

#### `POST /widget/session/exchange`

Consomme le LinkToken et retourne un SessionToken (appelé par le widget au montage).

**Auth:** LinkTokenAuth  
**Body:** `{}` (vide)  
**Réponse 200:**
```json
{
  "Data": {
    "SessionToken": "st_xxxxx",
    "ExpiresAt": "2024-01-01T00:30:00Z",
    "ExpiresIn": 1800,
    "AccountSelectionEnabled": true
  }
}
```

Erreurs 401 spécifiques : `LINK_TOKEN_INVALID`, `LINK_TOKEN_EXPIRED`, `ORIGIN_NOT_ALLOWED`  
Rate-limit : max 10 échanges / IP / 60s (→ 429)

---

#### `POST /connections/link-connect`

Soumet les identifiants bancaires depuis le widget.

**Auth:** SessionTokenAuth  
**Body:**
```json
{
  "InstitutionId": "mcb",
  "Credentials": {
    "Email": "user@example.com",
    "Password": "bank_password"
  }
}
```

**Variantes de Credentials** (oneOf) :

| Variante | Champs requis | Usage |
|---|---|---|
| Email | `Email`, `Password` | Majorité des banques mauriciennes |
| Username | `Username`, `Password` | Certains portails |
| CorporateId | `CorporateId`, `Password` | MCB Pro, SBM Corporate |

**Réponse 201:**
```json
{
  "Data": {
    "PublicToken": "pt_xxxxx",
    "JobId": "uuid",
    "ConnectionId": "uuid",
    "CustomerType": "PERSONAL"
  }
}
```

Erreurs 400 : `INSTITUTION_REQUIRED`, `INSTITUTION_LOCKED`, `INSTITUTION_NOT_FOUND`, `INSTITUTION_SANDBOX_ONLY`, `SANDBOX_CREDENTIALS_REQUIRED`

---

#### `POST /connections/link-exchange`

Échange le PublicToken (côté serveur B2B) contre un ConnectionId permanent.

**Auth:** ApiKeyAuth  
**Body:** `{ "PublicToken": "pt_xxxxx", "ClientUserId": "uuid" }`  
**Réponse 200:**
```json
{
  "Data": {
    "ConnectionId": "uuid",
    "InstitutionId": "mcb",
    "CustomerType": "PERSONAL"
  }
}
```

Erreurs 400 : `PUBLIC_TOKEN_INVALID`, `PUBLIC_TOKEN_EXPIRED`, `PUBLIC_TOKEN_USED`  
Erreur 403 : `PUBLIC_TOKEN_CLIENT_MISMATCH`

---

#### `GET /connections/link-token/context`

Retourne les métadonnées du LinkToken (nom client, environnement, mode). Appelé par le widget au chargement.

**Auth:** SessionTokenAuth  
**Réponse 200 :** `{ ClientName, Environment, Mode, AccountSelectionEnabled, LockedInstitutionId, AppLogoUrl, RequestedScopes, ResumeStep, ConnectionId }`

---

#### `POST /widget/session/revoke`

Révoque le SessionToken (best-effort, à appeler au `unload`).

**Auth:** SessionTokenAuth  
**Réponse 204 :** révocation OK

---

### Connections

---

#### `GET /connections`

Liste les connexions bancaires actives.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId` (requis pour B2B), `page`, `pageSize`  
**Réponse 200:**
```json
{
  "Data": {
    "Connections": [
      {
        "ConnectionId": "uuid",
        "InstitutionId": "mcb",
        "InstitutionName": "MCB Group",
        "CustomerType": "CORPORATE",
        "Status": "active",
        "CreatedAt": "2024-01-01T00:00:00Z",
        "NextSyncAvailableAt": "2024-01-01T00:15:00Z"
      }
    ]
  }
}
```

---

#### `DELETE /connections/{ConnectionId}`

Supprime une connexion et purge les credentials du vault chiffré.

**Auth:** ApiKeyAuth  
**Réponse 204** | **409** si un sync est en cours

---

#### `PUT /connections/{ConnectionId}/accounts`

Définit la liste des comptes que l'utilisateur autorise le client à accéder (Account Selection).

**Auth:** ApiKeyAuth | SessionTokenAuth  
**Body:**
```json
{
  "Data": {
    "PermittedAccountIds": ["uuid1", "uuid2"]
  }
}
```

Idempotent. Remplace la sélection précédente.  
Erreur 400 : `ACCOUNT_SELECTION_NOT_ENABLED` si le LinkToken a été émis avec `AccountSelectionEnabled=false`  
Erreur 409 : `ACCOUNT_NOT_FOUND` si un ID est invalide

---

### Sync Engine

> Le moteur de scraping Playwright qui récupère les données bancaires.

**États d'un SyncJob :**

```
PENDING → STARTED → LOGGING_IN → [OTP_REQUESTED → OTP_WAITING] → RETRIEVING → PARSING → ENRICHING → COMPLETED
                                                                                                    ↘ FAILED
```

---

#### `POST /sync/{ConnectionId}`

Déclenche un sync manuel.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `fromDate` (ISO 8601, max 18 mois), `toDate`  
**Réponse 201:**
```json
{
  "Data": {
    "JobId": "uuid",
    "Status": "PENDING",
    "IsManual": true,
    ...
  }
}
```

Rate-limit : 1 sync / 15 min par connexion (→ 429). Erreur 400 si sync déjà en cours.

---

#### `GET /sync/{ConnectionId}/latest-job`

Statut du dernier job de sync pour une connexion.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`

---

#### `GET /sync/job/{JobId}`

Détail complet d'un job (utilisé pour le polling).

**Auth:** ApiKeyAuth | SessionTokenAuth  
**Réponse 200 — objet SyncJob complet :**

| Champ | Type | Description |
|---|---|---|
| `JobId` | uuid | |
| `InstitutionId` | string | |
| `Status` | enum | État courant |
| `Source` | `SCRAPE` \| `DOCUMENT_UPLOAD` | |
| `IsManual` | boolean | |
| `Attempts` | integer | Nb tentatives |
| `StartedAt` | datetime | |
| `FinishedAt` | datetime \| null | |
| `NextSyncAvailableAt` | datetime \| null | |
| `Error` | object \| null | `{ Type, Message, Payload }` |
| `MfaType` | `sms` \| `email` \| `totp` \| null | Canal MFA détecté |
| `MfaLength` | integer \| null | Longueur OTP attendue |
| `MfaCharset` | `numeric` \| `alphanumeric` \| null | |
| `DeliveryTargets` | array \| null | Destinations masquées (ex: `[{ "Kind": "phone", "Target": "+230 5*** 1234" }]`) |
| `MfaResendCooldownSeconds` | integer \| null | Cooldown banque entre resends |
| `MfaResendRequestedAt` | datetime \| null | Dernier resend accepté |
| `MfaResendCount` | integer | Compteur resends (0–3) ; le 4e est refusé |
| `UserInput` | string \| null | OTP soumis (visible si en attente) |
| `PersistenceStats` | object \| null | Peuplé après `ENRICHING` : `{ TransactionsCreated, TransactionsUpdated, TransactionsDuplicated, AccountsUpdated }` (entiers) |
| `Metadata` | object \| null | Contexte device/IP/localisation ; null si non capturé |

> **Authentification du polling (préc. Fern 2026-06-15)** : `GET /sync/job/{JobId}`
> accepte **ApiKeyAuth** (avec `clientUserId` en query, requis B2B) **OU**
> **SessionTokenAuth** (Bearer, pas de `clientUserId`). Le widget utilise le Bearer.
>
> **Détail des états MFA** : `OTP_REQUESTED` = code envoyé, en attente de saisie ;
> `OTP_WAITING` = saisie reçue, validation en cours. `MfaLength` ∈ 1–12 ;
> `MfaResendCooldownSeconds` ∈ 0–600. `DeliveryTargets[]` = `{ Kind: email|phone,
> Target: <masqué> }`. Tous les champs MFA sont `null` si le job se termine sans
> challenge.

---

#### `POST /sync/{JobId}/input`

Soumet le code OTP/MFA quand le job est en état `OTP_REQUESTED`.

**Auth:** ApiKeyAuth | SessionTokenAuth  
**Body:**
```json
{
  "UserInput": "123456",
  "MfaResendRequestedAt": "2024-01-01T00:00:00Z"
}
```

> `MfaResendRequestedAt` est **obligatoire** si un resend a déjà eu lieu sur ce job (watermark strict-equality). Omettre uniquement au premier OTP sans resend.

> **Contrat watermark (strict equality, préc. Fern 2026-06-15)** : le serveur
> compare la valeur soumise à `MfaResendRequestedAt` de la ligne **à l'identique** ;
> une valeur **absente, malformée, plus ancienne, ou un futur fabriqué** → rejet
> `409 STALE_INPUT`. Échoer VERBATIM la valeur lue dans `GET /sync/job/{JobId}`,
> sans reformatage. Si aucun resend (`MfaResendRequestedAt IS NULL`), le champ est
> optionnel. Le 3e mauvais code fait passer `Status → FAILED` avec erreur `LOGIN_FAILED`.

**Réponse 202 :**
```json
{ "Data": { "Status": "OTP_ACCEPTED", "JobId": "uuid" } }
```
**409** `JOB_NOT_RUNNING` (job hors `OTP_REQUESTED`) ou `STALE_INPUT` (watermark) ·
**400** entrée invalide · **404** job introuvable.

**Codes sandbox OTP :**

| Canal | Code |
|---|---|
| `sms` | `123456` |
| `email` | `abcdef` (case-insensitive) |
| `totp` | `123456` |

Comportement erreur : un mauvais code NE fail pas immédiatement — 3 tentatives max par job. Après un mauvais code : `UserInput` repasse à `null`, `Status` reste `OTP_REQUESTED`. Au 3ème mauvais code : `Status → FAILED`.

---

#### `POST /sync/{JobId}/resend`

Demande un renvoi de l'OTP (le scraper Playwright clique "Renvoyer" sur le portail bancaire).

**Auth:** ApiKeyAuth | SessionTokenAuth  
**Réponse 202:**
```json
{
  "Data": {
    "JobId": "uuid",
    "MfaResendRequestedAt": "2024-01-01T00:00:05Z",
    "MfaResendCount": 1
  }
}
```

**Rejets 409 :**

| Code | Condition |
|---|---|
| `MFA_RESEND_JOB_NOT_IN_OTP_STATE` | Job pas en `OTP_REQUESTED` ou UserInput déjà défini |
| `MFA_RESEND_COOLDOWN_ACTIVE` | Cooldown actif — réponse inclut `RetryAfterSeconds: int` |
| `MFA_RESEND_MAX_ATTEMPTS_EXCEEDED` | 3 resends déjà effectués |

---

#### `GET /sync/job/{JobId}/accounts`

Comptes associés au job (avec balances inline). Utilisé par le widget pour l'écran Account Selection. **Résout la découverte de comptes** (connexion → comptes) côté flux widget.

**Auth:** SessionTokenAuth (Bearer)  
**Réponse 200:** `{ "Data": { "Account": [ OmniFiAccount ] } }`

**Objet `OmniFiAccount` (préc. Fern 2026-06-15) :**

| Champ | Type | Description |
|---|---|---|
| `AccountId` | string | UUID Omni-FI du compte |
| `Status` | `Enabled` \| `Disabled` \| `Deleted` \| `Pending` \| `ProForma` | |
| `Currency` | string | ISO 4217 |
| `AccountCategory` | `Personal` \| `Business` | |
| `AccountTypeCode` | `CACC` \| `CARD` \| `LOAN` \| `SVGS` \| … | Type OBIE |
| `Balances` | `OBBalance[]` | `{ Type, Amount, DateTime, CreditDebitIndicator }` — au plus 1 entrée par type, snapshot le plus frais |
| `PartyId` | uuid \| null | Personne morale/physique |
| `PartyName` | string \| null | |
| `InstitutionId` | string \| null | |
| `OwnershipType` | `PRIMARY` \| `SECONDARY` \| `JOINT_OWNER` \| `TRUST` \| `BUSINESS` \| `POWER_OF_ATTORNEY` | |
| `IsAsset` | boolean \| null | |

> `Balances[].Type` ∈ `ITAV` `CLAV` `ITBD` `CLBD` `OPAV` `OPBD` `FWAV` `INFO`
> `PRCD` `XPCD`. **Erreurs** : 401, 404, 500.

---

#### `GET /sync/account/{AccountId}/jobs`

Historique paginé des jobs pour un compte.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `status` (filtre optionnel), `page`, `pageSize`

---

### Parties

> Entités légales (sociétés, individus) regroupant plusieurs comptes.

---

#### `GET /parties/{PartyId}/accounts`

Liste les comptes liés à une Partie, scoped à l'EndUser authentifié.

**Auth:** ApiKeyAuth  
**Path:** `PartyId` (uuid)  
**Query:** `clientUserId`, `page`, `pageSize`  
**Réponse 200 :** format OBIE `OBReadAccount6`

---

### Accounts

---

#### `PATCH /accounts/{AccountId}`

Met à jour les préférences d'affichage d'un compte.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`  
**Body:**
```json
{
  "Nickname": "Compte principal",
  "IsActive": false
}
```

`IsActive: false` masque le compte des dashboards et l'exclut des syncs.

---

#### `GET /accounts/{AccountId}/balances/history`

Historique des soldes end-of-day (série temporelle).

**Auth:** ApiKeyAuth  
**Query:** `fromStatementDateTime`, `toStatementDateTime`, `page`, `pageSize`  
**Réponse 200:**
```json
{
  "Data": {
    "HistoricalBalances": [
      {
        "Date": "2024-01-01",
        "Balance": { "Amount": { "Amount": "12500.00", "Currency": "MUR" }, "Type": "ITAV", ... }
      }
    ]
  }
}
```

---

### Transactions

---

#### `GET /accounts/{AccountId}/transactions/sync`

Sync incrémental par curseur (recommandé pour ERP/comptabilité).

**Auth:** ApiKeyAuth  
**Query:** `cursor` (omit pour historique complet), `count` (défaut: 100, max: 500), `clientUserId`  
**Réponse 200:**
```json
{
  "Data": {
    "Added": [ OmniFiTransaction ],
    "Modified": [ OmniFiTransaction ],
    "Removed": [ { "TransactionId": "uuid" } ],
    "NextCursor": "cursor_opaque_string",
    "HasMore": false
  }
}
```

> Stocker `NextCursor` en base. Si `HasMore: true`, relancer immédiatement avec ce curseur.

---

#### `GET /transactions/{TransactionId}`

Détail d'une transaction unique.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`  
**Réponse 200 :** enveloppe OBIE tableau à un élément :

```json
{
  "Data": {
    "Transaction": [{
      "TransactionId": "uuid",
      "AccountId": "uuid",
      "PartyId": "uuid",
      "TransactionReference": "REF123",
      "Description": "VIREMENT MCB",
      "NormalizedDescription": "MCB",
      "Amount": { "Amount": "1500.00", "Currency": "MUR" },
      "CreditDebitIndicator": "Debit",
      "Status": "Booked",
      "BookingDateTime": "2024-01-01T10:00:00Z",
      "ValueDateTime": "2024-01-01T10:00:00Z",
      "PrimaryCategory": "Banking & Finance",
      "SubCategory": "Bank Charges",
      "CleanMerchantName": "MCB",
      "IsDuplicate": false,
      "ManuallyOverridden": false,
      "IsActive": true
    }]
  }
}
```

---

#### `GET /accounts/{AccountId}/transactions/summary`

Résumé agrégé (total crédits/débits, net).

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `fromDate`, `toDate`  
**Réponse 200:**
```json
{
  "Data": {
    "Summary": {
      "TotalCredits": "50000.00",
      "TotalDebits": "35000.00",
      "NetAmount": "15000.00",
      "TransactionCount": 142
    }
  }
}
```

---

#### `POST /accounts/{AccountId}/transactions/override`

Surcharge manuellement la catégorisation IA d'une transaction. Crée un log d'audit immuable.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`  
**Body:**
```json
{
  "TransactionId": "uuid",
  "PrimaryCategory": "Utilities",
  "SubCategory": "Electricity",
  "CleanMerchantName": "CEB Mauritius",
  "ManualNote": "Facture mensuelle",
  "IsExcluded": false,
  "Tags": ["utilities", "recurring"]
}
```

---

#### `GET /transactions/export`

Export CSV de toutes les transactions (multi-comptes).

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `institutionId`, `partyId`, `fromDate`, `toDate`, `minAmount`, `maxAmount`, `currency`, `category`, `merchant`, `creditDebit` (`Credit`|`Debit`), `search`, `sort` (`booking_date_time` | `-booking_date_time` | `amount` | `-amount`)  
**Réponse 200:** `Content-Type: text/csv`

---

#### `GET /accounts/{AccountId}/transactions/export`

Export CSV filtré pour un compte spécifique.

**Auth:** ApiKeyAuth  
**Query:** mêmes filtres que ci-dessus

---

### Document Upload

> Flux alternatif : import de relevés bancaires (PDF, OFX, QFX, CSV) pour extraction OCR.

Le flux suit les étapes : issue URL → upload S3 direct → analyze → submit → poll job.

---

#### `POST /documents/upload-url`

Génère une pré-signature S3 POST (le fichier est uploadé directement depuis le browser vers S3).

**Auth:** SessionTokenAuth  
**Body:**
```json
{ "ContentType": "application/pdf", "SizeBytes": 245760 }
```
**Réponse 201:**
```json
{
  "Data": {
    "Url": "https://s3.amazonaws.com/...",
    "Fields": { "key": "raw/...", "AWSAccessKeyId": "...", "policy": "...", "signature": "..." },
    "Key": "raw/{session_id}/{uuid}.pdf",
    "ExpiresAt": "2024-01-01T00:15:00Z"
  }
}
```

URL valide 15 minutes. Upload via `multipart/form-data` directement à l'URL.

---

#### `POST /documents/analyze`

Analyse préliminaire des fichiers uploadés (période couverte, type, confiance).

**Auth:** SessionTokenAuth  
**Body:** `{ "Keys": ["raw/...", "raw/..."] }`  
**Réponse 200:**
```json
{
  "Data": {
    "Period": { "StartDate": "2024-01-01", "EndDate": "2024-03-31" },
    "AccountMask": "****1234",
    "DocType": "bank_statement",
    "Confidence": 0.97,
    "Coverage": {}
  }
}
```

---

#### `POST /documents/submit`

Soumet les fichiers pour traitement ETL complet (OCR, extraction, classification).

**Auth:** SessionTokenAuth  
**Header requis:** `x-idempotency-key`  
**Body:** `{ "Keys": ["raw/..."] }`  
**Réponse 202:**
```json
{
  "Data": {
    "JobId": "uuid",
    "Status": "accepted"
  }
}
```

Ensuite : poller `GET /sync/job/{JobId}` pour le statut.

**Codes d'erreur job (Error.Type) pour DOCUMENT_UPLOAD :**

| Code | Description |
|---|---|
| `DOCUMENT_MALWARE_DETECTED` | Fichier signalé par GuardDuty |
| `DOCUMENT_UNSUPPORTED_FORMAT` | Format non dans `AcceptedFormats` |
| `DOCUMENT_PERIOD_INSUFFICIENT` | Ne couvre pas `RequiredHistoryDays` |
| `DOCUMENT_LOW_CONFIDENCE` | Score OCR en dessous du seuil |
| `DOCUMENT_SCAN_TIMEOUT` | Scan GuardDuty timeout |

---

### Debt Profiling

---

#### `GET /dashboard/debt`

Dashboard d'exposition dette agrégée.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `partyId`  
**Réponse 200:**
```json
{
  "Data": {
    "Summary": {
      "TotalDebt": { "Amount": "250000.00", "Currency": "MUR" },
      "TotalCreditLimit": { "Amount": "500000.00", "Currency": "MUR" },
      "UtilizationRate": 0.50
    },
    "ExposureByInstitution": [...],
    "ExposureByCurrency": [...],
    "UpcomingPayments": [...]
  }
}
```

---

#### `GET /debt/instruments`

Liste tous les instruments de dette (Prêts, Lignes de crédit, Découverts).

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `partyId`, `institutionId`, `page`, `pageSize`

---

#### `GET /debt/instruments/{InstrumentId}`

Détail d'un instrument de dette.

**Auth:** ApiKeyAuth  
**Réponse 200 — champs clés de `DebtInstrumentSerializer` :**

| Champ | Type | Description |
|---|---|---|
| `InstrumentType` | string | Type d'instrument |
| `CreditLimit` | string | Limite de crédit |
| `InterestRate` | string | Taux d'intérêt |
| `InterestRateType` | `FIXED` \| `VARIABLE` | |
| `SourceAccountStatus` | `IN_REPAYMENT` \| `DEFAULTED` \| `DELINQUENCY` \| ... | Statut réel à la banque |
| `MinimumPaymentAmount` | string | Paiement minimum dû |
| `IsOverdue` | boolean | Paiement en retard |
| `PastDueAmount` | string | Montant en souffrance |
| `NextPaymentDate` | date | |
| `NextPaymentAmount` | string | |
| `UtilizationRate` | float | Taux d'utilisation |
| `YtdInterestPaid` | string | Intérêts payés YTD |
| `LeverageRatio` | float | |

---

#### `GET /debt/accounts/{AccountId}/interest`

Transactions d'intérêts détectées.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `days` (défaut: 90)

---

#### `GET /debt/accounts/{AccountId}/repayment`

Analyse des patterns de remboursement + prédiction du prochain paiement.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `months` (défaut: 6)  
**Réponse:** `{ Pattern: { TypicalDay, AverageAmount, ... }, Prediction: { PredictedDate, PredictedAmount, Confidence, ... } }`

---

#### `GET /debt/exposure/by-institution`

Exposition dette groupée par institution.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `partyId`

---

#### `GET /debt/exposure/by-currency`

Exposition dette groupée par devise.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `partyId`

---

### Financial Insights

---

#### `GET /dashboard/insights`

Dashboard analytique complet (cashflow, vendors, catégories, anomalies, revenus, risques).

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `partyId`, `granularity` (`daily`|`weekly`|`monthly`), `fromDate`, `toDate`  
**Réponse 200 — champs :**

| Champ | Description |
|---|---|
| `NetWorthSnapshot` | `{ TotalAssets, TotalLiabilities, NetWorth }` |
| `CashflowRibbon` | Série temporelle `{ Date, Inflow, Outflow, NetFlow, ... }` |
| `TopVendors` | `[{ Merchant, Amount, Share }]` |
| `CategorySummary` | `[{ Category, Amount, TransactionCount, Share }]` |
| `CategoryAnomalies` | `[{ Category, CurrentMonth, HistoricalAverage, Delta, DeltaPercent, Direction }]` |
| `RecurringPayments` | Paiements récurrents détectés |
| `RevenueInsights` | Revenus, top clients, tendance mensuelle |
| `IncomeInsights` | Sources de revenus, fréquence, prévisions |
| `RiskInsights` | Indicateurs de risque crédit |
| `Alerts` | Mouvements notables |

---

#### `GET /insights/cashflow`

Données cashflow pour graphique ribbon.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `partyId`, `granularity`

---

#### `GET /insights/vendors`

Concentration des dépenses et contreparties.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `partyId`, `direction` (`inflow`|`outflow`|`both`, défaut: `outflow`)

---

#### `GET /insights/alerts`

Mouvements inhabituels et activité suspecte.

**Auth:** ApiKeyAuth  
**Query:** `clientUserId`, `partyId`

---

## Webhooks

### Configuration

#### `PUT /dev/webhooks/config`

Enregistre ou met à jour l'URL webhook.

**Auth:** ApiKeyAuth  
**Body:** `{ "WebhookUrl": "https://your-server.com/webhooks/omnifi" }`  
**Réponse 200:**
```json
{
  "Data": {
    "WebhookUrl": "https://...",
    "WebhookSecret": "whs_xxxxxxx",
    "Status": "ACTIVE"
  }
}
```

> `WebhookSecret` est retourné **uniquement au premier appel**. Utiliser `POST /dev/webhooks/rotate-secret` pour renouveler.

---

#### `POST /dev/webhooks/rotate-secret`

Invalide et remplace le secret de signature.

**Auth:** ApiKeyAuth  
**Réponse 200:** `{ "Data": { "WebhookSecret": "whs_new_xxxxx" } }`

---

#### `POST /dev/webhooks/test`

Envoie un webhook mock `sync.completed` pour tester la réception.

**Auth:** ApiKeyAuth  
**Réponse 202**

---

### Payload Webhook

Chaque événement est envoyé en `POST` à votre URL avec :

**Header de signature :**
```
x-omnifi-signature: hmac_sha256_hex_digest
```

Vérification : `HMAC-SHA256(body_bytes, WebhookSecret)` → comparer avec l'entête.

**Body JSON :**
```json
{
  "EventId": "uuid",
  "EventType": "sync.completed",
  "ConnectionId": "uuid",
  "JobId": "uuid",
  "Timestamp": "2024-01-01T10:00:00Z",
  "Payload": {}
}
```

**Types d'événements (`EventType`) :**

| Événement | Description |
|---|---|
| `sync.started` | Job démarré |
| `sync.mfa_required` | Challenge MFA détecté |
| `sync.retrieving_data` | Récupération en cours |
| `sync.data_retrieved` | Données récupérées |
| `sync.retrieving_parties` | Parties en cours |
| `sync.parties_retrieved` | Parties récupérées |
| `sync.retrieving_accounts` | Comptes en cours |
| `sync.accounts_retrieved` | Comptes récupérés |
| `sync.retrieving_transactions` | Transactions en cours |
| `sync.transactions_retrieved` | Transactions récupérées |
| `sync.completed` | Job terminé avec succès |
| `sync.failed` | Job échoué |

> Tous les scrapers n'émettent pas chaque événement intermédiaire. Construire une logique tolérante aux étapes manquées.

---

## Sandbox

L'environnement sandbox (`https://sandbox.omni-fi.co/v1`) permet de tester sans toucher aux banques réelles.

### Credentials universels

Pour toute banque via le widget sandbox :

| Champ | Valeur |
|---|---|
| Email | `sandbox@example.com` |
| Password | n'importe quelle valeur |

Pour tester le flux MFA :

| Email | Password |
|---|---|
| `sandbox.mfa@example.com` | n'importe quelle valeur |

### Codes OTP sandbox

| Canal | Code |
|---|---|
| SMS | `123456` |
| Email | `abcdef` (insensible à la casse) |
| TOTP | `123456` |

---

## Architecture multi-tenant

```
ApiClient (partenaire B2B)
  └── EndUser (utilisateur final, identifié par ClientUserId)
        └── Connection (une connexion = une banque)
              └── Account (un ou plusieurs comptes)
                    └── Transaction (transactions)
                    └── SyncJob (historique des syncs)
```

- **`clientUserId`** : votre identifiant interne de l'utilisateur final, à passer en query param sur tous les appels B2B
- **`ConnectionId`** : ID Omni-FI de la connexion bancaire (permanent, obtenu après `link-exchange`)
- **`AccountId`** : UUID Omni-FI du compte bancaire (OBIE-compliant)
- **`PartyId`** : UUID de la personne morale ou physique regroupant des comptes

---

## Priorité de classification des transactions

```
USER_RULE > SYSTEM_RULE > ML_FALLBACK
```

La surcharge manuelle via `POST /accounts/{AccountId}/transactions/override` crée un enregistrement audit immuable et prend priorité permanente.

---

## Codes d'erreur fréquents

| Code HTTP | Signification |
|---|---|
| 400 | Validation / données invalides |
| 401 | Token absent, invalide ou expiré |
| 403 | Token valide mais non autorisé |
| 404 | Ressource introuvable (ou hors scope tenant) |
| 409 | Conflit d'état (sync en cours, token déjà consommé, etc.) |
| 429 | Rate limit dépassé — header `Retry-After` présent |
| 500 | Erreur interne serveur |
| 501 | Non implémenté (endpoints `beta/future`) |
