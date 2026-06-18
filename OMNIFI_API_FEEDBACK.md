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
| 8 | `GET /connections` → `403 FORBIDDEN` (permission/scope) malgré des credentials valides → **le contournement du #5 est lui-même bloqué** | **Critique** | **Non contournable côté TYGR — fix attendu côté API** |

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

> ⚠️ **Mise à jour 2026-06-18 — ce contournement est désormais lui-même BLOQUÉ.** Lors d'un test de bout en bout, `GET /connections` renvoie **`403 FORBIDDEN`** pour notre client sandbox (voir **§8**), alors que nos credentials sont valides. Les **deux** voies de finalisation sont donc inopérantes : le flux nominal (`onSuccess`, bloqué par `parentOrigin`) **et** le repli serveur (`GET /connections`, bloqué par le 403). L'intégration ne peut plus rien rattraper de son côté tant que ces deux points ne sont pas corrigés côté Omni-FI.

**Recommandation (prioritaire).**
1. **Permettre au widget d'établir le `parentOrigin`** pour les origines légitimes (au minimum `https://localhost:3000` en développement, et les domaines de production des intégrateurs). Documenter **comment** une origine parente est autorisée (allowlist, paramètre, etc.).
2. **Garantir l'émission de `onSuccess`** une fois la connexion réussie, indépendamment des appels de nettoyage (ex. `revoke`).
3. **Ne pas laisser le widget bloqué ouvert** en cas d'échec du canal de retour.
4. Documenter le **contrat d'événements** (`omni-fi:connection-linked` vs `omni-fi:success`, ordre, payloads) et la **compatibilité de version** SDK npm ↔ widget CDN (le `README` du SDK mentionne un couplage de versions, sans procédure claire).

---

## 8. `GET /connections` → `403 FORBIDDEN` malgré des credentials valides (le repli du #5 est bloqué)

**Symptôme (CRITIQUE).** L'endpoint **`GET /connections`** — celui sur lequel repose notre contournement du #5 (re-synchronisation serveur) — renvoie systématiquement **`403 Forbidden` / `FORBIDDEN`** (« You do not have permission to perform this action »), **quel que soit le `clientUserId`**. Nos credentials `ApiKey` sont pourtant **valides** : d'autres routes authentifiées avec exactement le même en-tête répondent normalement (un `405 Method Not Allowed`, et non un `403/401`), ce qui prouve que l'authentification passe et que le rejet est bien une question de **permission/scope sur cette route**, pas d'identifiants.

**Impact.** Les **deux** chemins de finalisation d'une connexion bancaire sont désormais inopérants :
- le **flux nominal** (`onSuccess` du widget) est bloqué par `parentOrigin not established` (**§5**) ;
- le **repli serveur** (relire l'état via `GET /connections`) est bloqué par ce **403**.

Résultat concret pour l'intégrateur : une banque connectée et persistée côté Omni-FI (vérifié : écran « Connected » du widget, requêtes `exchange`/`accounts` en succès) **ne peut être rapatriée par aucun moyen** dans l'application hôte. L'utilisateur voit « La connexion bancaire a échoué » alors que la connexion existe bel et bien côté Omni-FI.

**Preuve (reproduction hors navigateur, `curl`, credentials du `.env`).**

Repli serveur — la route du contournement, avec le `clientUserId` provisionné comme avec un `clientUserId` de démo :
```
GET https://api-stage.omni-fi.co/connections?clientUserId=<provisionné>&page=1&pageSize=50
  Authorization: ApiKey <client_id>:<secret>
→ HTTP 403
  {"Code":"403 Forbidden","Message":"You do not have permission to perform this action.",
   "Errors":[{"ErrorCode":"FORBIDDEN","Message":"You do not have permission to perform this action."}]}
```

Preuve que les credentials sont valides (même en-tête `ApiKey`, autre route) :
```
GET https://api-stage.omni-fi.co/clients/end-users?page=1&pageSize=10
  Authorization: ApiKey <client_id>:<secret>
→ HTTP 405
  {"Code":"405 MethodNotAllowed","Message":"Method \"GET\" not allowed.", … }
```
Un `405` (mauvaise méthode HTTP) et non un `403/401` ⇒ l'**authentification est acceptée** ; seule la route `GET /connections` refuse l'accès.

**Analyse.** Le `403` est spécifique à `GET /connections`. Deux hypothèses, à trancher côté Omni-FI :
1. le client sandbox ne dispose pas du **scope/permission de lecture des connexions** (à octroyer) ;
2. l'EndUser ciblé n'a jamais été **réellement provisionné** côté sandbox, et la route répond `403` (plutôt qu'un `404` explicite) pour un `clientUserId` inconnu — auquel cas le **code de statut est trompeur**.

**Recommandation (prioritaire).**
1. **Accorder au client d'intégration le droit de `GET /connections`** sur le sandbox (c'est l'endpoint pivot de toute re-synchronisation serveur).
2. Si le `403` masque en réalité un EndUser/`clientUserId` inconnu, renvoyer un **`404` explicite** (comme `POST /connections/link-exchange` le fait déjà, cf. #7) plutôt qu'un `403` générique — un code de statut juste fait gagner des heures de diagnostic.
3. Documenter, par endpoint, le **scope/permission requis** et le **schéma d'auth** attendu.

---

## Conclusion — état de l'intégration côté TYGR

**L'intégration TYGR du Link Widget est terminée et prête.** Le code (flux nominal `onSuccess` → finalisation serveur, repli de re-synchronisation `GET /connections`, allowlist d'origines HTTPS, gestion multi-connexions, isolation tenant) est en place, testé et mergé. Nous avons prouvé **empiriquement** que le blocage ne vient **pas** de notre côté :

- nos **credentials sont valides** (l'auth `ApiKey` est acceptée — un `405`, pas un `401/403`, sur une autre route) ;
- notre `RedirectOrigin` est correct (`https://localhost:3000`, l'origine réelle de la page, en HTTPS) ;
- les deux blocages restants sont **côté vendor** : le widget n'établit pas `parentOrigin` (#5) **et** `GET /connections` est refusé en `403` (#8).

| Blocage | Détail | Code/Trace | Responsabilité |
|---------|--------|-----------|----------------|
| Finalisation widget | `onSuccess` jamais émis | `parentOrigin is not established` + `Blocked a frame … must match` | **Omni-FI** (widget iframe) |
| Repli serveur | `GET /connections` refusé | `HTTP 403 FORBIDDEN` | **Omni-FI** (permission/scope) |

**En attente d'un correctif vendor.** Le jour où Omni-FI (a) permet au widget d'établir le `parentOrigin` pour les origines légitimes **et/ou** (b) accorde l'accès à `GET /connections`, l'intégration TYGR fonctionnera **sans aucune modification de notre code**. Nous ne déployons aucun palliatif supplémentaire pour compenser ces lacunes côté API.

---

## Annexe — Contexte technique

- **Environnement testé :** sandbox / staging (`api-stage.omni-fi.co` pour l'API REST, `staging-cdn.omni-fi.co` pour le widget).
- **Auth utilisée :** `ApiKey <client_id>:<secret>` (schéma serveur). NB : le `client_id` attendu par l'en-tête est l'identifiant `client_…` de l'ApiClient (le « Issuing for »), **pas** l'« APICLIENT ID » UUID affiché à côté — distinction non triviale qui a aussi coûté du temps (un `401 Invalid client credentials` peu explicite).
- **EndUser :** doit être **créé au préalable** via `POST /clients/end-users` ; un `ClientUserId` arbitraire renvoie `404 End user not found` (comportement correct mais à documenter dans le parcours de démarrage).
- **Identifiants sandbox utilisés pour le widget :** `sandbox@example.com` / `sandbox_password` (happy path, sans MFA).

*Document rédigé à l'usage de l'équipe API Omni-FI. Toutes les valeurs sensibles (secrets, jetons) sont volontairement omises.*
