# Retour d'intégration — API & SDK Omni-FI (Link Widget)

**Émetteur :** équipe TYGR (intégration trésorerie multi-tenant)
**Période :** Epic 3 — connexion bancaire via le Link Widget, environnement **sandbox / staging**
**Objet :** anomalies bloquantes ou coûteuses rencontrées sur l'API, le SDK et la documentation, avec preuves et recommandations.

Ce document est factuel et constructif : chaque point indique le **symptôme observé**, l'**impact** sur l'intégration, la **preuve** (réponse HTTP / message exact) et une **recommandation**. L'objectif est d'aider l'équipe API à fiabiliser l'expérience d'intégration pour les prochains clients.

---

## Synthèse

| # | Anomalie | Sévérité | Statut côté TYGR |
|---|----------|----------|------------------|
| 1 | URL de base sandbox erronée dans la doc (hôte mort) | Bloquant | Contourné (deviné `api-stage.omni-fi.co`) |
| 2 | Package SDK non publié → vendoring manuel obligatoire | Bloquant | Contourné (clone + build + vendoring) |
| 3 | Nom du package erroné dans la doc (`@omnifi/react`) | Élevé | Contourné (corrigé en `@omni-fi/react-link`) |
| 4 | Exigence HTTPS du widget non documentée | Élevé | Contourné (HTTPS local + allowlist) |
| 5 | Widget CDN : `postMessage` bloqué (« parentOrigin not established ») → `onSuccess` jamais émis | **Critique** | **✅ Résolu côté Omni-FI** (handshake `ready`/`ready-ack`, vérifié runtime 2026-06-19 — voir §9). Doublon de #9 |
| 6 | Auth : confusion `client_id` (« Issuing for ») vs « APICLIENT ID » UUID ; message `401` peu explicite | Moyen | Contourné (deviné le bon identifiant) |
| 7 | EndUser non auto-créé : `ClientUserId` arbitraire → `404`, non documenté dans le parcours | Moyen | Contourné (`POST /clients/end-users`) |
| 8 | Nom du query param `client_user_id` (snake_case) — non documenté, et `GET /connections` répond `403` (param ignoré) au lieu d'un `400`/`404` explicite | Moyen | **Résolu côté TYGR** (notre bug : on envoyait `clientUserId`) — suggestion d'amélioration côté API |
| 9 | Widget : `parentOrigin` jamais établi → `onSuccess` jamais émis | **Critique** | **✅ Résolu côté Omni-FI** (handshake `ready`/`ready-ack`, vérifié runtime 2026-06-19) |
| 10 | Routes documentées mais **non déployées** sur staging : `GET /accounts/{id}/transactions/sync` et `GET /accounts/{id}/balances/history` → `404`. De plus la pagination réelle (`page`) diverge de la doc (curseur `NextCursor`/`HasMore`) | **Élevé** | **⏳ Confirmé « extensions futures » par Omni-FI (2026-06-19)** — TYGR construit sur les routes par PAGE |
| 11 | SDK : CDN passe à `onSuccess` un **tableau nu**, mais types + README promettent `{ connections }` → `TypeError .map` | **Critique** | **✅ Contourné côté TYGR** (normalisation des 2 formes + tests) ; alignement SDK recommandé |
| 12 | Widget iframe cross-origin (`postMessage`) — compatibilité **Safari / WebKit** non documentée ni testée (ITP, stockage partitionné, cookies tiers) ; risque de blocage du handshake et de l'OTP | **À investiguer** | ⏳ Non vérifié côté TYGR (testé seulement sous Chrome) — demande de confirmation côté Omni-FI |
| 13 | **Deux vocabulaires de statut** pour un même sync (machine `SyncJob` `PENDING→…→COMPLETED` ≠ 12 `EventType` webhook `sync.retrieving_*`), sans table de correspondance ni séparation claire « login interactif » vs « ingestion serveur » | Moyen | ⏳ Confusion documentaire — clarification demandée |
| 14 | `sync.completed` (webhook) non mis en avant comme **signal de fin propre** : la doc pousse au polling alors qu'un webhook éviterait l'attente active | Mineur | Suggestion |

---

## 1. URL de base du sandbox erronée (hôte inexistant)

**Symptôme.** La documentation indique un hôte sandbox qui **ne résout pas** (DNS `NXDOMAIN`). Aucun appel n'était possible.

**Impact.** Blocage total au démarrage de l'intégration : impossible d'atteindre l'API. Temps perdu à suspecter notre réseau / VPN avant de comprendre que l'hôte documenté n'existait pas.

**Preuve.**
- Hôte documenté → `NXDOMAIN` (résolution DNS échoue).
- Hôte réel trouvé par déduction → `https://api-stage.omni-fi.co` → `GET /health/` répond `HTTP 200`.
- À noter : un autre hôte (`stage.omni-fi.co`) répond aussi mais correspond au **CDN du widget**, pas à l'API REST — source de confusion supplémentaire.

**Recommandation.** Corriger l'URL de base sandbox dans la documentation et la spec OpenAPI. Distinguer explicitement **l'hôte de l'API REST** du **CDN du widget**. Idéalement, exposer un endpoint `/health` documenté pour permettre un test de connectivité immédiat.

---

## 2. Package SDK introuvable publiquement → vendoring manuel obligatoire

**Symptôme.** Le package SDK n'est publié sur **aucun registre npm** (public ou privé accessible). `npm install` échoue en `404`. Le dépôt GitHub existe mais **ne versionne pas le dossier `dist/`** (généré par `tsup`), si bien qu'une installation directe depuis GitHub récupère une coquille **non importable** (pas de build).

**Impact.** Impossible d'installer le SDK par les moyens standard. Nous avons dû : cloner le dépôt, installer ses dépendances, **builder le `dist/` manuellement**, puis **vendorer** le résultat dans notre dépôt (`vendor/`, dépendance `file:`). Cela introduit une **dette de supply-chain** (code tiers buildé localement, non reproductible, non audité) que nous documentons et suivons de notre côté.

**Preuve.**
- `npm install <package>` → `404 Not Found`.
- Dépôt GitHub : « No packages published » ; `package.json` déclare `"files": ["dist", …]` mais `dist/` absent du dépôt.

**Recommandation (par ordre de préférence).**
1. **Publier le package** sur npm (public) ou sur un registre privé documenté, avec instructions d'authentification (`.npmrc`).
2. À défaut, ajouter un script `prepare` au `package.json` du SDK (build automatique à l'installation), pour qu'une install `github:` produise un `dist/` exploitable.
3. À défaut, **committer le `dist/`** dans le dépôt.

---

## 3. Nom du package erroné dans la documentation

**Symptôme.** La documentation référence le package sous le nom **`@omnifi/react`** (sans tiret). Le nom réel du package buildé est **`@omni-fi/react-link`** (avec tiret).

**Impact.** Tous nos imports, types et configuration de build calés sur le nom documenté **ne résolvaient pas**. Nous avons construit un module de typage temporaire (« stub ») sur le mauvais nom, puis dû tout réaligner une fois le vrai nom découvert dans le `package.json` du dépôt. Travail refait inutilement.

**Preuve.**
- Documentation : `import { … } from "@omnifi/react"`.
- `vendor/omni-fi-react-link/package.json` → `"name": "@omni-fi/react-link"`.
- Exports réels : `useOmniFILink`, `getScriptUrl`, `OMNIFI_EVENTS` + types (`OmniFIConfig`, `OmniFISuccessPayload`, `OmniFIConnection`, …). À noter aussi une divergence de **casse** par rapport à la doc/Fern (ex. `OmniFISuccessPayload`).

**Recommandation.** Aligner la documentation, les exemples et la spec OpenAPI sur le nom réel `@omni-fi/react-link`. Documenter la liste exacte des exports et leur casse.

---

## 4. Exigence HTTPS du widget non documentée

**Symptôme.** Le widget (et l'endpoint `link-token`) **exige une origine HTTPS** pour le `RedirectOrigin`. Toute origine `http://localhost` est rejetée. Cette contrainte n'est **pas documentée** ; elle n'apparaît qu'au moment de l'appel, sous forme d'erreur.

**Impact.** Blocage en développement local (où l'origine par défaut est `http://localhost:3000`). Nous avons dû mettre en place : un service local en **HTTPS** (certificat auto-signé) **et** notre propre **allowlist d'origines** côté serveur (avec un opt-in explicite pour le dev), pour éviter d'exposer le jeton d'échange (`PublicToken`) à une origine non maîtrisée.

**Preuve.**
- `POST /connections/link-token` avec `RedirectOrigin: "http://localhost:3000"`
  → `HTTP 400` — `"RedirectOrigin: Value error, RedirectOrigin must use HTTPS scheme."`
- Le même appel avec une origine `https://…` → `HTTP 201` (LinkToken émis).

**Recommandation.** Documenter explicitement l'exigence HTTPS du `RedirectOrigin` (et du widget en général), idéalement dès le guide de démarrage. Préciser la marche à suivre pour le développement local (HTTPS / tunnel). Documenter le mécanisme d'allowlist d'origines attendu côté `link-token`.

---

## 5. Plantage critique du widget en fin de parcours — `onSuccess` jamais émis

**Symptôme (CRITIQUE).** En sandbox, le parcours de connexion se déroule **entièrement et avec succès** côté Omni-FI (soumission des identifiants, découverte des comptes), **puis le widget plante en fin de parcours** : une requête réseau échoue, l'appel de fin (`revoke`) échoue, et surtout **l'événement de succès (`onSuccess`) n'est jamais émis** vers l'application hôte. Conséquences pour l'utilisateur :
- le widget **ne se ferme pas** automatiquement (il faut fermer manuellement) ;
- l'application hôte ne reçoit **jamais** la notification de succès → **aucune finalisation** (le `PublicToken` n'est pas remonté) → rien n'est rattaché au compte ;
- le `LinkToken` étant à usage unique (déjà consommé par l'échange de session), une nouvelle tentative repart de zéro et échoue tant que le widget reste dans cet état.

**Preuve (onglet Réseau du navigateur, parcours sandbox `sandbox@example.com`).** Séquence observée :
```
exchange → context → envelope → institutions → link-connect → accounts → accounts → [requête échouée] → revoke (échec)
```
- `link-connect` et `accounts` : **succès** (la banque est connectée, les comptes découverts ; réponses inspectées : `PublicToken`, `ConnectionId`, comptes + soldes bien présents).
- Le widget affiche l'écran final « Your account has been successfully connected » (clic « Finish » / « Continue »).
- `revoke` (fin de session widget) : **échec**.

**CAUSE RACINE (confirmée par la console navigateur).** Le widget hébergé **n'établit pas le canal `postMessage`** avec la page parente. Messages observés dans la console, de façon reproductible :
```
Blocked a frame with origin "https://staging-connect.omni-fi.co"
  from accessing a frame with origin "https://localhost:3000".
  Protocols, domains, and ports must match.

[omni-fi-link] Cannot send success message: parentOrigin is not established.
```
Conséquence : le widget **ne peut jamais envoyer le message de succès** à la page → `onSuccess` (et tout autre callback de retour, y compris `omni-fi:connection-linked`) **n'arrive jamais** côté hôte, **quel que soit** le bouton cliqué. La connexion est pourtant bien persistée côté Omni-FI.

**Analyse.** Le SDK React transmet correctement notre `onSuccess` au script CDN via `window.OmniFI.connect({...})`. Le blocage est **entièrement côté widget hébergé** : son iframe (`staging-connect.omni-fi.co`) échoue à « établir » l'origine parente (`https://localhost:3000`) et à lui parler via `postMessage`. Notre `RedirectOrigin` envoyé au `link-token` est pourtant bien `https://localhost:3000` (= l'origine réelle de la page) ; le canal de retour reste néanmoins bloqué.

**Pistes côté Omni-FI (à investiguer).**
- L'origine parente `https://localhost:3000` n'est peut-être pas autorisée par le widget (allowlist d'origines côté serveur/iframe, distincte du `RedirectOrigin`).
- Le handshake d'« établissement du parentOrigin » échoue (timing, vérification d'origine trop stricte, ou incompatibilité avec un certificat local de développement).

**Contournement retenu côté TYGR (temporaire, indépendant du postMessage).** Plutôt que d'attendre `onSuccess`, nous **relisons l'état réel côté serveur** via `GET /connections?client_user_id=…` (auth ApiKey), puis `GET /accounts?connectionId=…`, et nous rattachons les comptes — **sans dépendre du canal `postMessage`**. Ce chemin est exposé comme une action de **re-synchronisation manuelle** (bouton « Synchroniser mes connexions »). Le flux nominal `onSuccess` reste en place : dès que le widget sera corrigé, il fonctionnera sans changement de notre côté.

> **Mise à jour 2026-06-18 — précisions après investigation.**
> - **Le repli `GET /connections` est désormais RÉSOLU côté intégrateur** : le `403` venait d'un **bug dans notre client** (param envoyé en `clientUserId` au lieu de `client_user_id` ; cf. **§8**), pas d'un défaut d'autorisation côté API. Une fois le nom corrigé, le repli fonctionne (`200`, connexions listées).
> - ~~**Le flux nominal (`onSuccess`) reste bloqué** par le `parentOrigin`~~ → **RÉSOLU côté Omni-FI le 2026-06-19** (handshake `ready`/`ready-ack`, cf. addendum **§9**). Le flux nominal fonctionne désormais de bout en bout ; le repli `GET /connections` devient un filet optionnel. Une divergence de contrat SDK révélée au passage (forme du payload) est traitée au **§11**.

**Diagnostic complémentaire `parentOrigin` (cf. §9).** Après lecture du backend `omni-fi-core` (branche `staging`), nous confirmons que **`RedirectOrigin` et `WIDGET_ALLOWED_ORIGIN` ne sont PAS la cause** :
- `RedirectOrigin` (passé à `POST /connections/link-token`) est l'origine HTTPS du `postMessage` **de retour** (le `PublicToken`) — nous l'envoyons correctement (`https://localhost:3000`).
- `WIDGET_ALLOWED_ORIGIN` (`omni_fi_backend/settings.py:501`, vérifié par `_check_origin` dans `apps/institutions/authentication.py:30`) valide l'en-tête `Origin` des appels **SessionToken venant de l'iframe** ; sa valeur attendue est l'origine de l'**iframe** (`staging-connect.omni-fi.co`), pas celle de la page hôte.

Le `parentOrigin` (origine de la page hôte) est donc établi **ailleurs** : par le handshake `postMessage` interne au widget iframe (`link-app`), dépôt **non inclus** dans `omni-fi-core`. L'analyse du bundle CDN servi montre que l'iframe initialise `parentOrigin = null` puis ne le renseigne **qu'à la réception d'un message provenant du parent** ; or le SDK `@omni-fi/react-link` n'émet aucun message d'initialisation parent → iframe. `parentOrigin` reste donc `null`, et la garde interne du widget refuse d'émettre le message de succès. **Aucun paramètre côté intégrateur ne permet d'amorcer ce handshake** — le correctif est dans `link-app`.

**Recommandation (prioritaire).**
1. **Permettre au widget d'établir le `parentOrigin`** pour les origines légitimes (au minimum `https://localhost:3000` en développement, et les domaines de production des intégrateurs). Documenter **comment** une origine parente est autorisée (allowlist, paramètre, etc.).
2. **Garantir l'émission de `onSuccess`** une fois la connexion réussie, indépendamment des appels de nettoyage (ex. `revoke`).
3. **Ne pas laisser le widget bloqué ouvert** en cas d'échec du canal de retour.
4. Documenter le **contrat d'événements** (`omni-fi:connection-linked` vs `omni-fi:success`, ordre, payloads) et la **compatibilité de version** SDK npm ↔ widget CDN (le `README` du SDK mentionne un couplage de versions, sans procédure claire).

---

## 8. Query param `client_user_id` (snake_case) — non documenté, et `403` peu explicite quand il est mal nommé

> **Note d'honnêteté (mise à jour 2026-06-18).** Une version précédente de ce document attribuait le `403` sur `GET /connections` à un défaut d'autorisation côté API (EndUser non provisionné / statut trompeur). **C'était une erreur de notre part** : après vérification empirique, le `403` venait d'un **bug dans notre propre client** (mauvais nom de paramètre). Nous corrigeons ici le constat. Reste une **suggestion mineure** côté API (un code de statut plus parlant).

**Cause-racine réelle (bug côté intégrateur, corrigé).** L'endpoint `GET /connections` lit le paramètre de l'EndUser en **snake_case** : `ResolveEndUser` fait `request.query_params.get("client_user_id")` (`apps/clients/authentication.py:158`). Notre client l'envoyait en **camelCase** (`clientUserId`). Le paramètre était donc **silencieusement ignoré** → aucun `client_user_id` fourni → `ResolveEndUser` retourne `False` → **`403`**.

**Preuve empirique (runtime, même clé sandbox, même EndUser, même instant).**
```
GET https://api-stage.omni-fi.co/connections?clientUserId=tygr-demo-omnicane    → HTTP 403 Forbidden
GET https://api-stage.omni-fi.co/connections?client_user_id=tygr-demo-omnicane  → HTTP 200 OK (21 connexions)
```
Seul le **nom du paramètre** change. L'EndUser existait, les credentials étaient valides, l'environnement (sandbox) était correct.

**Correction côté TYGR.** Les 5 appels B2B du client (tous protégés par `ResolveEndUser`) envoient désormais `client_user_id`. NB : l'API Omni-FI est **mixte** sur la casse des params — `client_user_id` en snake_case, mais `pageSize` / `institutionId` / `accountId` en camelCase (vérifié dans leurs tests). C'est une source de confusion réelle.

**Suggestions (côté API, mineures mais utiles).**
1. **Uniformiser la casse des query params** (tout snake_case ou tout camelCase), ou à défaut la **documenter explicitement** par endpoint — le mélange actuel est un piège.
2. **Renvoyer un `400 Bad Request`** (« missing required parameter `client_user_id` ») plutôt qu'un `403 Forbidden` lorsque le paramètre requis est absent. Le `403` actuel laisse croire à un problème de permission/credentials et envoie l'intégrateur sur une fausse piste (ce qui nous est arrivé).

---

## 9. Widget : `parentOrigin` jamais établi → `onSuccess` jamais émis (cause-racine)

**Symptôme (CRITIQUE).** En fin de parcours, le clic « Finish » n'émet jamais `onSuccess` vers la page hôte. Console, de façon reproductible :
```
Blocked a frame with origin "https://staging-connect.omni-fi.co"
  from accessing a frame with origin "https://localhost:3000".
  Protocols, domains, and ports must match.
[omni-fi-link] Cannot send success message: parentOrigin is not established.
```

**Ce qui a été écarté (sources serveur lues dans `omni-fi-core`).**
- **`RedirectOrigin`** (envoyé à `POST /connections/link-token`, stocké via `apps/institutions/views.py:452`) est l'origine du `postMessage` **de retour** du `PublicToken`. Nous l'envoyons correctement (`https://localhost:3000`, origine réelle de la page, HTTPS). Ce n'est pas le canal d'établissement du `parentOrigin`.
- **`WIDGET_ALLOWED_ORIGIN`** (`omni_fi_backend/settings.py:501`, appliqué par `_check_origin`, `apps/institutions/authentication.py:30`) valide l'en-tête `Origin` des requêtes **SessionToken émises par l'iframe** ; sa valeur attendue est l'origine de l'**iframe** (`staging-connect.omni-fi.co`), pas celle de la page hôte. Sans rapport avec notre `parentOrigin`.

**Cause-racine (analyse du bundle CDN du widget — le dépôt `link-app` n'étant pas accessible, l'analyse porte sur l'artefact servi).** Le widget iframe initialise son état avec `parentOrigin = null` et ne le renseigne **qu'à la réception d'un message provenant de la page parente** (logique observée : au premier message reçu, il fixe `parentOrigin` = origine de l'émetteur ; les messages suivants d'une autre origine sont ignorés). Or le SDK `@omni-fi/react-link` (côté hôte) charge le script et appelle `window.OmniFI.connect({...})` **sans émettre de message d'initialisation parent → iframe**. En conséquence, `parentOrigin` reste `null`, et la fonction d'émission du succès court-circuite explicitement (`if (!parentOrigin) { … return; }`) — d'où le message « Cannot send success message: parentOrigin is not established » et l'absence totale de `onSuccess`.

**Conséquence.** La connexion est pourtant **bien persistée** côté Omni-FI (écran « Connected », `exchange`/`accounts` en succès), mais la page hôte n'en est **jamais notifiée**. Aucun paramètre d'URL, origine ou configuration **côté intégrateur** ne permet d'amorcer ce handshake : le correctif est nécessairement **dans le widget `link-app`**.

**Recommandation (prioritaire, côté widget).**
1. **Établir le `parentOrigin` de façon fiable** dès l'initialisation — soit en faisant émettre par le SDK un message d'init `parent → iframe` (handshake explicite), soit en dérivant l'origine parente du `RedirectOrigin` déjà fourni au `link-token`, soit via `document.referrer` / `window.location.ancestorOrigins`.
2. **Autoriser les origines légitimes** des intégrateurs (au minimum `https://localhost:3000` en développement, et leurs domaines de production) ; documenter **comment** une origine parente est déclarée.
3. **Garantir l'émission de `onSuccess`** une fois la connexion persistée, indépendamment des appels de nettoyage (`revoke`), et émettre un **`onError`** explicite dans les cas où la finalisation est réellement impossible (plutôt qu'un échec silencieux).

> **✅ RÉSOLU côté Omni-FI — vérifié runtime 2026-06-19.** Le widget établit désormais
> le `parentOrigin` via un **handshake `ready` / `ready-ack`** : au montage, l'iframe émet
> `omni-fi:ready` vers `window.parent` (`targetOrigin: "*"`) ; le loader CDN répond
> `omni-fi:ready-ack` (`case r.READY: … y(r.READY_ACK)`), ce qui amorce l'origine parente.
> Le code est présent et correct des deux côtés du bundle servi (loader `omni-fi-connect.js`
> + iframe `staging-connect.omni-fi.co/assets/index-*.js`, `last-modified` 2026-06-18 18:59).
> **Preuve de bout en bout** (Chrome, parcours Absa sandbox réel, `https://localhost:3000`) :
> plus aucun `parentOrigin is not established` ; `onSuccess` **est appelé** (stack
> `omni-fi-connect.js:48` → notre callback) ; `finaliserConnexionDropinAction` tourne
> côté serveur (1 PublicToken, échange + découverte comptes) ; redirection Dashboard
> effective. **Merci pour ce correctif — c'était bien le point bloquant.** ⚠️ Il a toutefois
> mis au jour une **divergence de contrat du SDK** sur la FORME du payload `onSuccess`,
> détaillée au **§11**.

---

## 10. Routes `/transactions/sync` et `/balances/history` documentées mais NON déployées + divergence de pagination

**Symptôme (ÉLEVÉ).** Deux endpoints décrits dans la doc Fern / la spec OpenAPI **n'existent pas** sur `api-stage.omni-fi.co` : ils renvoient un **`404` HTML générique** (« Not Found » — page serveur, pas une enveloppe d'erreur OBIE). Les **routes réelles** existent sous un autre chemin, **avec un modèle de pagination différent** de celui documenté.

**Preuve (runtime, `curl`, credentials sandbox, EndUser provisionné).**
```
# Documenté (Fern / OpenAPI) — ABSENT :
GET /accounts/{id}/transactions/sync   → HTTP 404 (page "Not Found")
GET /accounts/{id}/balances/history    → HTTP 404 (page "Not Found")

# Réel (déployé) — OK :
GET /accounts/{id}/transactions   → HTTP 200  { "Data": { "Transaction": [...] }, "Links": {...}, "Meta": { "TotalPages": 2, "TotalRecords": 38 } }
GET /accounts/{id}/balances       → HTTP 200  (soldes COURANTS / latest par type, PAS de série temporelle)
```

**Divergences précises.**
1. **Chemin.** Doc : `/transactions/sync` et `/balances/history`. Réel : `/transactions` et `/balances`.
2. **Pagination.** La doc décrit `/transactions/sync` comme un **delta incrémental par curseur** (`Added[]`, `Modified[]`, `Removed[]`, `NextCursor`, `HasMore`, paramètres `cursor`/`count`). La route réelle `/transactions` est une **liste paginée par page** (`page` / `Meta.TotalPages` / `Links.Next`) — **aucune notion de curseur ni de delta**. Ce ne sont pas deux variantes d'un même contrat : ce sont deux modèles de synchronisation incompatibles.
3. **Donnée historique manquante.** `GetHistoricalBalances` (série temporelle end-of-day, openapi.yml) **n'a aucune route déployée** — confirmé : `grep` sur le code Django de `omni-fi-core` (branche `staging`) ne trouve `balances/history` nulle part. Seul le **solde courant** est exposé. → Toute fonctionnalité de **courbe / tendance de trésorerie** est impossible à alimenter en l'état.

**Impact / décision côté TYGR.** Notre client a été écrit **fidèlement sur le contrat Fern** (sync par curseur + historique EOD). Plutôt que de réécrire toute notre couche d'ingestion (orchestrateur, modèle curseur, tests) pour épouser un staging temporairement non conforme — au risque de devoir **tout défaire** le jour où `/sync` sera déployé — **nous gelons ce code sur le contrat documenté** et attendons l'alignement serveur. Le rattachement des comptes (`GET /connections` + `GET /accounts`) fonctionne déjà ; seules les **transactions** et l'**historique des soldes** sont en attente.

**Recommandation (prioritaire).**
1. **Aligner staging sur la doc** : déployer `GET /accounts/{id}/transactions/sync` (delta par curseur) et `GET /accounts/{id}/balances/history` (série EOD) tels que spécifiés — **ou** mettre la doc/OpenAPI à jour pour refléter les routes réelles (`/transactions` paginé par page, pas d'historique).
2. **Choisir un modèle de pagination unique** pour les transactions et le documenter sans ambiguïté (curseur **ou** page, pas les deux selon la source).
3. Pour `404` sur une route inexistante, renvoyer une **enveloppe d'erreur OBIE JSON** cohérente avec le reste de l'API plutôt qu'une page HTML — un intégrateur qui parse du JSON reçoit sinon une erreur de désérialisation opaque.

---

## 11. SDK `@omni-fi/react-link` : le CDN passe à `onSuccess` un TABLEAU NU, mais types + README promettent `{ connections }`

**Contexte.** Découvert immédiatement après la résolution du `parentOrigin` (§9) : une fois
`onSuccess` enfin appelé, **notre intégration plantait** sur la première ligne du callback.

**Symptôme (runtime, Chrome, parcours sandbox réel).**
```
Uncaught TypeError: Cannot read properties of undefined (reading 'map')
    at OmniFiLinkLauncher.useOmniFILink [as onSuccess]   (omnifi-link-launcher.tsx)
    at F (omni-fi-connect.js:48)
```
Conséquence visible : le widget reste bloqué sur **« Finishing… »** indéfiniment, aucune
finalisation, aucune redirection — alors que la connexion est persistée côté Omni-FI.

**Cause-racine : divergence entre le contrat TYPÉ/documenté et le contrat RUNTIME du CDN.**
- **Types vendorés** (`@omni-fi/react-link`, `dist/index.d.ts:63-64`) :
  `interface OmniFISuccessPayload { connections: OmniFIConnection[] }` → un **objet**.
- **README vendoré** (mêmes lignes d'exemple) : `onSuccess({ connections }) { … }` → un **objet**.
- **Loader CDN déployé** (`omni-fi-connect.js`, ~ligne 48) :
  ```js
  case r.SUCCESS: e.onSuccess && n.connections && (e.onSuccess(n.connections))
  ```
  → il invoque `onSuccess` avec **le tableau nu** `n.connections`, **pas** `{ connections: … }`.

Autrement dit : **le SDK npm/vendoré et le CDN runtime sont désynchronisés sur la forme du
payload.** Un intégrateur qui suit les types (ce que TypeScript impose) écrit
`payload.connections.map(...)` → `payload.connections` vaut `undefined` → `TypeError`.
La forme des éléments, elle, est cohérente (`{ publicToken, connectionId, institutionId, … }`
en camelCase — conforme aux types).

**Contournement côté TYGR (livré, non bloquant).** Notre callback **normalise les deux formes**
(`Array.isArray(payload) ? payload : payload.connections`), couvert par 5 tests de
non-régression. On est donc robustes que le CDN se réaligne sur sa doc **ou** reste tel quel —
aucun redéploiement requis de notre part dans les deux cas.

**Recommandation.** Aligner les deux contrats, dans le sens qui vous convient :
1. soit **le CDN émet `{ connections }`** (conforme aux types/README publiés) ;
2. soit **les types + README passent à `OmniFIConnection[]`** (conformes au CDN réel).
L'essentiel est qu'un intégrateur TypeScript qui fait confiance à `OmniFISuccessPayload`
n'obtienne pas un `undefined` à l'exécution. C'est exactement le type de divergence qu'un
premier intégrateur peut révéler avant la publication npm — autant la régler avant que le
SDK ne soit figé sur le registre public.

---

## 12. Compatibilité Safari / WebKit du widget — non documentée, non garantie (à investiguer)

**Symptôme (À INVESTIGUER, non encore reproduit côté TYGR).** Notre validation de bout
en bout (§9, §11) a été faite **sous Chrome uniquement**. Le widget est une **iframe
cross-origin** (`staging-connect.omni-fi.co`) chargée dans la page hôte (origine TYGR),
et tout le flux de fin de parcours repose sur un **handshake `postMessage`**
(`omni-fi:ready` / `omni-fi:ready-ack`, cf. §9). Or **Safari / WebKit applique des
restrictions sur les iframes tierces que Chrome n'applique pas** (ou plus tard). Tant que
le parcours n'a pas été validé sous Safari (desktop **et** iOS), nous considérons la
compatibilité comme **non garantie** — c'est un risque réel pour une base d'utilisateurs
mauriciens où Safari/iOS est très présent.

**Mécanismes WebKit susceptibles de casser le parcours (à vérifier côté Omni-FI).**
1. **ITP / Storage Access** : Safari **partitionne (ou bloque) le stockage et les cookies
   des iframes tierces** par défaut. Si le widget (`staging-connect.omni-fi.co`) s'appuie
   sur un cookie de session, un `localStorage`/`sessionStorage`, ou un `SessionToken`
   conservé côté iframe pour porter l'état entre les étapes du SyncJob, cet état peut être
   **vidé ou isolé** sous Safari → session perdue en plein parcours (typiquement au moment
   du challenge MFA ou de la sélection de comptes).
2. **`postMessage` + vérification d'origine** : le handshake `ready`/`ready-ack` doit
   fonctionner à l'identique sous WebKit. À confirmer qu'aucune hypothèse propre à
   Blink (timing de chargement de l'iframe, `targetOrigin`, accès à `window.parent`)
   ne fait échouer l'amorçage du `parentOrigin` sous Safari — sinon on retombe sur le
   bug §9 (« `onSuccess` jamais émis »), mais cette fois **uniquement sous Safari**.
3. **Pop-ups / redirections d'auth bancaire** : si une banque ouvre une fenêtre ou
   redirige hors iframe, le **bloqueur de pop-ups** et la **politique de navigation
   cross-origin** de Safari sont plus stricts. À vérifier que le retour vers l'iframe
   (et l'émission de `onSuccess`) survit à ce détour sous WebKit.
4. **Certificat de développement local** : en dev, l'iframe HTTPS (`staging-connect`)
   imbriquée dans `https://localhost:3000` (certificat auto-signé) peut être traitée
   différemment par Safari (gestion plus stricte des certificats non fiables dans un
   contexte tiers).

**Impact.** Si l'un de ces points casse, l'utilisateur Safari **ne peut pas connecter sa
banque** (parcours interrompu, ou `onSuccess` jamais émis) — alors que tout fonctionne
sous Chrome. Le repli serveur `GET /connections` (§5) **limite** la casse côté données
(les comptes finissent rattachés par re-synchronisation manuelle), mais l'**expérience de
connexion in-widget reste cassée** pour ces utilisateurs.

**Ce que nous demandons / recommandons (côté Omni-FI).**
1. **Confirmer si le widget est officiellement supporté et testé sous Safari** (desktop +
   iOS) et, si oui, **documenter les versions minimales** et toute exigence (ex. recours à
   l'API **Storage Access**, en-têtes `Permissions-Policy`/`Content-Security-Policy:
   frame-ancestors` attendus côté hôte, `sandbox`/`allow` requis sur l'iframe).
2. **Ne pas dépendre d'un stockage d'iframe tierce** pour porter l'état du parcours sous
   Safari (préférer un état porté par le `postMessage` / le `SessionToken` passé
   explicitement), ou documenter le déclenchement de **Storage Access** au bon moment.
3. Indiquer le **comportement attendu en mode navigation privée Safari** (où les
   restrictions sont encore plus strictes).

> **Statut côté TYGR : non testé.** Nous signalons ce point **par prudence** (pas comme un
> bug constaté) : notre preuve runtime §9/§11 est Chrome-only. Nous prévoyons un passage QA
> Safari (desktop + iOS) de notre côté ; une confirmation de votre support Safari nous
> dirait si un échec éventuel relève du widget ou de notre intégration.

---

## 13. Statuts de synchronisation : DEUX vocabulaires pour un même job + confusion « phase login » / « phase ingestion »

**Symptôme (clarté documentaire).** La doc décrit l'avancement d'une synchronisation avec
**deux jeux de statuts distincts, dans deux sections différentes, sans aucune table de
correspondance** :

- **Machine à états du `SyncJob`** (`§ Sync Engine`) — 8 états, vocabulaire « technique » :
  ```
  PENDING → STARTED → LOGGING_IN → [OTP_REQUESTED → OTP_WAITING] → RETRIEVING → PARSING → ENRICHING → COMPLETED
                                                                                                      ↘ FAILED
  ```
- **`EventType` des webhooks** (`§ Payload Webhook`) — **12 événements**, vocabulaire
  « granulaire » et **différent** :
  ```
  sync.started · sync.mfa_required · sync.retrieving_data · sync.data_retrieved ·
  sync.retrieving_parties · sync.parties_retrieved · sync.retrieving_accounts ·
  sync.accounts_retrieved · sync.retrieving_transactions · sync.transactions_retrieved ·
  sync.completed · sync.failed
  ```

**En quoi c'est déroutant pour un intégrateur.**
1. **Aucune correspondance explicite.** Rien ne dit que `RETRIEVING` (poll) ⇄
   `sync.retrieving_data`/`sync.retrieving_transactions` (webhook), ni que `LOGGING_IN`/
   `OTP_REQUESTED` ⇄ `sync.mfa_required`, ni que `ENRICHING` mène à `PersistenceStats`. On
   doit **deviner** l'alignement entre la valeur lue dans `GET /sync/job/{JobId}.Status` et
   l'`EventType` reçu sur le webhook. Pour une UI qui affiche une progression, ces deux
   sources doivent pourtant être réconciliées.
2. **La frontière « interactif » vs « back-office » est implicite.** Le parcours a en
   réalité **deux natures d'étapes** qu'un lecteur perçoit comme « phase 1 / phase 2 » mais
   que la doc présente comme une **seule séquence linéaire** :
   - une **phase interactive / temps réel** où l'utilisateur agit *dans le widget*
     (`LOGGING_IN`, `OTP_REQUESTED`/`OTP_WAITING`) — pilotée par le `SessionToken` (Bearer),
     polling de `GET /sync/job/{JobId}`, l'UI **doit** réagir (champ OTP, resend, cooldown) ;
   - une **phase d'ingestion serveur** (`RETRIEVING → PARSING → ENRICHING → COMPLETED`) qui
     se déroule **côté Omni-FI sans interaction** — l'utilisateur n'a plus rien à faire, et
     l'intégrateur peut soit **continuer à poller**, soit **attendre le webhook
     `sync.completed`** (cf. §14).
   La doc gagnerait à **nommer ces deux phases** et à dire explicitement, pour chaque état,
   *qui doit agir* (l'utilisateur dans le widget, ou personne / attente serveur).
3. **`OTP_REQUESTED` vs `OTP_WAITING` ré-emploient le mot « waiting » à contre-sens
   intuitif.** La doc le précise (`OTP_REQUESTED` = code envoyé, en attente de **saisie** ;
   `OTP_WAITING` = saisie reçue, **validation** en cours) — c'est bien, mais c'est
   contre-intuitif (« waiting » = on attend la banque, alors qu'on pourrait croire qu'on
   attend l'utilisateur). Ce point précis est déjà documenté ; à conserver bien visible.

**Recommandation (côté doc Omni-FI).**
1. **Une table unique de correspondance** `SyncJob.Status` ⇄ `EventType` webhook (une ligne
   par état, colonnes : statut poll, événement(s) webhook équivalent(s), « qui agit »,
   « UI attendue »). C'est le livrable qui dissout la confusion.
2. **Nommer explicitement les deux phases** (ex. « Phase interactive — authentification &
   MFA » vs « Phase d'ingestion — récupération & persistance ») et placer la frontière
   exactement après `OTP_WAITING` / avant `RETRIEVING`. Indiquer que la phase d'ingestion
   ne requiert **aucune action utilisateur** et peut être suivie par **webhook** plutôt que
   par polling.
3. Rappeler que **tous les scrapers n'émettent pas chaque événement** (déjà noté pour les
   webhooks) — donc une UI de progression doit être **tolérante aux étapes manquées** et ne
   jamais supposer une séquence complète.

---

## 14. `sync.completed` : signal de fin propre sous-exploité (la doc pousse au polling)

**Observation (suggestion, mineure).** Pour savoir qu'un sync est terminé, la doc met en
avant le **polling** de `GET /sync/job/{JobId}` (« utilisé pour le polling »). Pourtant, le
webhook **`sync.completed`** (avec `ConnectionId` + `JobId`, signé HMAC-SHA256) est un
signal de fin **propre, fiable et sans attente active**. Pour la **phase d'ingestion**
(§13, où l'utilisateur n'a plus rien à faire), le polling est du gaspillage : un webhook
`sync.completed` permettrait de déclencher notre rafraîchissement de données **à l'instant
exact** où elles sont prêtes, sans boucle d'attente ni quotas de polling consommés.

**Recommandation.** Documenter **`sync.completed` comme le moyen recommandé** de détecter la
fin de la phase d'ingestion (le polling restant le fallback pour les intégrateurs sans
endpoint webhook public). Préciser la **garantie de livraison** (au-moins-une-fois ?
ré-essais ? ordre ?) et confirmer que `sync.completed` est **toujours** émis en fin de
succès (vs « tous les scrapers n'émettent pas chaque événement », qui ne doit s'appliquer
qu'aux événements **intermédiaires**, pas au terminal).

---

## Conclusion — état de l'intégration côté TYGR

**L'intégration TYGR du Link Widget est terminée, prête, et le parcours de connexion
fonctionne désormais DE BOUT EN BOUT** (vérifié runtime 2026-06-19 : clic « Finish » →
`onSuccess` → finalisation serveur → redirection Dashboard). Le code (flux nominal,
repli de re-synchronisation `GET /connections`, allowlist d'origines HTTPS, gestion
multi-connexions, isolation tenant) est en place, testé et mergé. État des points soulevés :

| # | Point | Cause-racine | Responsabilité | Statut |
|---|---------|--------------|----------------|--------|
| 8 | `GET /connections` → `403` | **Notre bug** : param envoyé en `clientUserId` au lieu de `client_user_id` (ignoré → `403`) | Intégrateur (corrigé) ; suggestion mineure API | **✅ Résolu** |
| 9 | `onSuccess` jamais émis | `parentOrigin` jamais établi (handshake non amorcé) | Omni-FI (widget) | **✅ Résolu côté Omni-FI** (handshake `ready`/`ready-ack`, vérifié runtime) |
| 11 | `onSuccess` → `TypeError .map` | CDN passe un **tableau nu** ; types + README promettent `{ connections }` | Omni-FI (SDK ≠ CDN) ; contourné côté TYGR | **✅ Contourné côté TYGR** (normalisation + tests) ; **alignement SDK recommandé** |
| 10 | Transactions + historique des soldes non récupérables | Routes `/transactions/sync` et `/balances/history` documentées mais **non déployées** (`404`) ; pagination réelle (`page`) ≠ doc (curseur) | **Omni-FI** (API ≠ doc) | **⏳ Confirmé « extensions futures » par Omni-FI (2026-06-19)** — base à construire sur les routes par PAGE |

Faits établis :
- nos **credentials sont valides** ; notre **`RedirectOrigin` est correct** (`https://localhost:3000`, HTTPS) ;
- le **parcours bancaire complet fonctionne** : connexion → `onSuccess` → échange `PublicToken` → découverte des comptes → redirection (preuve serveur : `finaliserConnexionDropinAction` appelée, 1 token, échange + comptes en ~2,3 s) ;
- **un seul point reste côté Omni-FI** : #10 — les routes `/transactions/sync` (delta par curseur) et `/balances/history` (série EOD) ; **Omni-FI confirme (2026-06-19) qu'il s'agit d'extensions futures non encore actées**. Conformément à ce retour, **TYGR construira l'ingestion des transactions sur les routes paginées par PAGE** (`/accounts/{id}/transactions`, `Data`+`Links`+`Meta.TotalPages`) — c'est le contrat actuel aligné OBIE ; la voie curseur reste un ajout futur côté API.

**Bilan : le Link Widget est pleinement opérationnel.** Reste à brancher l'ingestion des
transactions sur le modèle par page (chantier TYGR en cours), l'historique de soldes étant
différé tant qu'Omni-FI n'expose pas de série EOD.

---

## Annexe — Contexte technique

- **Environnement testé :** sandbox / staging (`api-stage.omni-fi.co` pour l'API REST, `staging-cdn.omni-fi.co` pour le widget).
- **Auth utilisée :** `ApiKey <client_id>:<secret>` (schéma serveur). NB : le `client_id` attendu par l'en-tête est l'identifiant `client_…` de l'ApiClient (le « Issuing for »), **pas** l'« APICLIENT ID » UUID affiché à côté — distinction non triviale qui a aussi coûté du temps (un `401 Invalid client credentials` peu explicite).
- **EndUser :** doit être **créé au préalable** via `POST /clients/end-users` (un `ClientUserId` arbitraire n'est pas auto-créé).
- **Casse des query params (piège) :** `client_user_id` en **snake_case**, mais `pageSize` / `institutionId` / `accountId` en **camelCase**. Un nom mal cassé est silencieusement ignoré ; sur `GET /connections` cela se traduit par un `403` peu explicite (cf. §8). À uniformiser/documenter côté API.
- **Identifiants sandbox utilisés pour le widget :** `sandbox@example.com` / `sandbox_password` (happy path, sans MFA).

*Document rédigé à l'usage de l'équipe API Omni-FI. Toutes les valeurs sensibles (secrets, jetons) sont volontairement omises.*
