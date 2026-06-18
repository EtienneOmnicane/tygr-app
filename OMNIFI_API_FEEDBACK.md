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
| 5 | Widget CDN : `postMessage` bloqué (« parentOrigin not established ») → `onSuccess` jamais émis | **Critique** | Contourné (re-sync serveur `GET /connections`) — **fix attendu côté API** |
| 6 | Auth : confusion `client_id` (« Issuing for ») vs « APICLIENT ID » UUID ; message `401` peu explicite | Moyen | Contourné (deviné le bon identifiant) |
| 7 | EndUser non auto-créé : `ClientUserId` arbitraire → `404`, non documenté dans le parcours | Moyen | Contourné (`POST /clients/end-users`) |
| 8 | `GET /connections` → `403 FORBIDDEN` au lieu d'un `404` : l'EndUser ciblé n'existe pas encore (jamais provisionné), mais le code renvoie un `403` trompeur | **Élevé** | **Résolu côté TYGR** (provisioning via `POST /clients/end-users`) — **code de statut à corriger côté API** |
| 9 | Widget : `parentOrigin` jamais établi → `onSuccess` jamais émis (cause-racine confirmée par lecture du code, cf. #5) | **Critique** | **Non contournable côté TYGR — fix attendu côté widget** |

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

**Contournement retenu côté TYGR (temporaire, indépendant du postMessage).** Plutôt que d'attendre `onSuccess`, nous **relisons l'état réel côté serveur** via `GET /connections?clientUserId=…` (auth ApiKey), puis `GET /accounts?connectionId=…`, et nous rattachons les comptes — **sans dépendre du canal `postMessage`**. Ce chemin est exposé comme une action de **re-synchronisation manuelle** (bouton « Synchroniser mes connexions »). Le flux nominal `onSuccess` reste en place : dès que le widget sera corrigé, il fonctionnera sans changement de notre côté.

> **Mise à jour 2026-06-18 — précisions après investigation.**
> - **Le repli `GET /connections` est désormais RÉSOLU côté intégrateur** : le `403` n'était pas un blocage de permission mais un EndUser non provisionné (cf. **§8**). Après `POST /clients/end-users`, le repli fonctionne.
> - **Le flux nominal (`onSuccess`) reste bloqué** par le `parentOrigin` (cf. **§9** ci-dessous) — c'est le seul point réellement bloquant restant, et il est côté widget.

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

## 8. `GET /connections` → `403 FORBIDDEN` au lieu de `404` (EndUser non provisionné) — code de statut trompeur

**Symptôme.** `GET /connections?client_user_id=<id>` renvoie systématiquement **`403 Forbidden`** (« You do not have permission to perform this action »), **quel que soit le `client_user_id`**, alors que nos credentials `ApiKey` sont valides.

**Preuve que l'authentification est valide.** Le même en-tête `ApiKey` sur une autre route renvoie `405`, pas `401/403` :
```
GET https://api-stage.omni-fi.co/clients/end-users   → HTTP 405 (Method Not Allowed)
GET https://api-stage.omni-fi.co/connections?client_user_id=<id>   → HTTP 403 (Forbidden)
```
Un `405` (mauvaise méthode) et non un `401/403` ⇒ l'auth passe ; seule `GET /connections` refuse.

**Cause-racine (confirmée par lecture du code source — accès en lecture seule au dépôt `omni-fi-core`, branche `staging`).** Le `403` n'est **ni un scope, ni une permission manquante** : c'est que **l'EndUser ciblé n'existe pas**, et la couche d'autorisation renvoie un `403` à la place d'un `404`.

- Route : `apps/institutions/urls.py` → `GetConnectionsView` (`apps/institutions/views.py:240`), avec `permission_classes = [ResolveEndUser]` et `sandbox_supported = True`.
- `ResolveEndUser._resolve_for_api_client` (`apps/clients/authentication.py:156`) tente :
  ```python
  request.end_user = EndUser.objects.get(
      client_user_id=client_user_id,
      api_client=request.user,        # doit appartenir à l'ApiClient appelant
      is_sandbox=(env == "sandbox"),  # doit matcher l'environnement de la clé
  )
  except EndUser.DoesNotExist:
      return False        # → DRF traduit `has_permission() == False` en HTTP 403
  ```
- Notre `client_user_id` n'avait **jamais été provisionné** comme `EndUser` (placeholder côté intégrateur, sans appel `POST /clients/end-users`). `DoesNotExist` → `403`.

**Le vrai problème (côté API).** Un `EndUser` **inconnu** est traité comme un **refus de permission** (`403`) plutôt qu'une **ressource introuvable** (`404`). C'est incohérent avec d'autres vues du même module : `DeleteConnectionView` (`views.py:300`) renvoie correctement un `404 CONNECTION_NOT_FOUND` quand la ressource n'appartient pas à l'appelant. Le `403` de `GetConnectionsView` masque la vraie nature du problème et envoie l'intégrateur chercher un scope/permission inexistant.

**Résolution côté intégrateur (TYGR).** Provisionner l'EndUser **avant** toute lecture, via la route officielle :
```
POST https://api-stage.omni-fi.co/clients/end-users
  Authorization: ApiKey <client_id>:<secret>
  {"ClientUserId": "<id>"}
```
`CreateEndUserView` (`views.py:60`) pose `is_sandbox=True` automatiquement selon l'environnement de la clé et rattache l'EndUser à l'ApiClient appelant — exactement les conditions qu'exige `ResolveEndUser`. Après provisioning, `GET /connections` renvoie `200`.

**Recommandation (côté API).**
1. **Renvoyer `404` (ressource introuvable) plutôt que `403`** lorsqu'un `client_user_id` ne correspond à aucun `EndUser` de l'ApiClient — comme le fait déjà `DeleteConnectionView`. Réserver le `403` aux vrais refus de permission.
2. **Documenter explicitement le pré-requis de provisioning** (`POST /clients/end-users`) dans le parcours de démarrage : un `client_user_id` arbitraire n'est pas auto-créé (lié au #7).

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

---

## Conclusion — état de l'intégration côté TYGR

**L'intégration TYGR du Link Widget est terminée et prête.** Le code (flux nominal `onSuccess` → finalisation serveur, repli de re-synchronisation `GET /connections`, allowlist d'origines HTTPS, gestion multi-connexions, isolation tenant) est en place, testé et mergé. Après investigation (tests `curl` hors navigateur + lecture du code source `omni-fi-core`), l'état des blocages est désormais clarifié :

| # | Blocage | Cause-racine | Responsabilité | Statut |
|---|---------|--------------|----------------|--------|
| 8 | `GET /connections` → `403` | EndUser non provisionné (le code renvoie `403` au lieu de `404`) | Intégrateur (provisioning) + API (statut trompeur) | **Résolu côté TYGR** via `POST /clients/end-users` |
| 9 | `onSuccess` jamais émis | `parentOrigin` jamais établi (handshake `postMessage` non amorcé dans le widget `link-app`) | **Omni-FI** (widget) | **Bloquant — fix attendu côté widget** |

Faits établis :
- nos **credentials sont valides** (auth `ApiKey` acceptée — `405`, pas `401/403`, sur une autre route) ;
- notre **`RedirectOrigin` est correct** (`https://localhost:3000`, l'origine réelle de la page, en HTTPS) ;
- le **403 n'était pas une permission manquante** mais un EndUser absent — désormais provisionné de notre côté ;
- **il ne reste qu'un seul vrai bloquant** : le widget n'établit pas `parentOrigin`, et **aucun paramètre côté intégrateur ne permet de l'amorcer** (le correctif est dans le dépôt `link-app`).

**En attente d'un correctif côté widget.** Le jour où le widget établit le `parentOrigin` pour les origines légitimes (et émet `onSuccess`/`onError` en conséquence), l'intégration TYGR fonctionnera **sans aucune modification de notre code**.

---

## Annexe — Contexte technique

- **Environnement testé :** sandbox / staging (`api-stage.omni-fi.co` pour l'API REST, `staging-cdn.omni-fi.co` pour le widget).
- **Auth utilisée :** `ApiKey <client_id>:<secret>` (schéma serveur). NB : le `client_id` attendu par l'en-tête est l'identifiant `client_…` de l'ApiClient (le « Issuing for »), **pas** l'« APICLIENT ID » UUID affiché à côté — distinction non triviale qui a aussi coûté du temps (un `401 Invalid client credentials` peu explicite).
- **EndUser :** doit être **créé au préalable** via `POST /clients/end-users` ; sur `POST /connections/link-exchange` un `ClientUserId` inconnu renvoie un `404` explicite, mais sur **`GET /connections` il renvoie un `403` trompeur** (cf. §8) — à uniformiser et à documenter dans le parcours de démarrage.
- **Identifiants sandbox utilisés pour le widget :** `sandbox@example.com` / `sandbox_password` (happy path, sans MFA).

*Document rédigé à l'usage de l'équipe API Omni-FI. Toutes les valeurs sensibles (secrets, jetons) sont volontairement omises.*
