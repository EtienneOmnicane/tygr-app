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

**Recommandation (prioritaire).**
1. **Permettre au widget d'établir le `parentOrigin`** pour les origines légitimes (au minimum `https://localhost:3000` en développement, et les domaines de production des intégrateurs). Documenter **comment** une origine parente est autorisée (allowlist, paramètre, etc.).
2. **Garantir l'émission de `onSuccess`** une fois la connexion réussie, indépendamment des appels de nettoyage (ex. `revoke`).
3. **Ne pas laisser le widget bloqué ouvert** en cas d'échec du canal de retour.
4. Documenter le **contrat d'événements** (`omni-fi:connection-linked` vs `omni-fi:success`, ordre, payloads) et la **compatibilité de version** SDK npm ↔ widget CDN (le `README` du SDK mentionne un couplage de versions, sans procédure claire).

---

## Annexe — Contexte technique

- **Environnement testé :** sandbox / staging (`api-stage.omni-fi.co` pour l'API REST, `staging-cdn.omni-fi.co` pour le widget).
- **Auth utilisée :** `ApiKey <client_id>:<secret>` (schéma serveur). NB : le `client_id` attendu par l'en-tête est l'identifiant `client_…` de l'ApiClient (le « Issuing for »), **pas** l'« APICLIENT ID » UUID affiché à côté — distinction non triviale qui a aussi coûté du temps (un `401 Invalid client credentials` peu explicite).
- **EndUser :** doit être **créé au préalable** via `POST /clients/end-users` ; un `ClientUserId` arbitraire renvoie `404 End user not found` (comportement correct mais à documenter dans le parcours de démarrage).
- **Identifiants sandbox utilisés pour le widget :** `sandbox@example.com` / `sandbox_password` (happy path, sans MFA).

*Document rédigé à l'usage de l'équipe API Omni-FI. Toutes les valeurs sensibles (secrets, jetons) sont volontairement omises.*
