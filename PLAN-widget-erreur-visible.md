# PLAN — Rendre visible l'échec du widget natif Omni-FI

Branche : `fix/widget-erreur-visible` (depuis `origin/main` @ 9e5f442)
Date : 2026-07-13
Statut : **figé** (arbitrage §3 rendu par l'humain avant implémentation)

---

## 1. Symptôme

Le widget natif Omni-FI se ferme **sans message** quand une banque renvoie une
erreur. L'utilisateur ne sait ni que ça a échoué, ni pourquoi, ni quoi faire.

## 2. Causes — deux, pas une

### C1 — L'objet d'erreur est jeté (cause de l'invisibilité)

`src/components/widget/omnifi-link-launcher.tsx:104-106` :

```ts
onExit: onClose,
onError: onClose,   // ← l'objet OmniFIError { code, message } est ignoré
```

Les deux callbacks sont aliasés sur le **même** handler `onClose`, qui ne prend
aucun argument. Une **annulation** (l'utilisateur ferme le widget — silence
légitime) et un **échec** (la banque refuse — doit parler) sont donc traités de
façon identique : démonter le launcher, ne rien dire.

### C2 — Le 2e clic rouvre le widget sur un LinkToken déjà consommé (cause de l'échec lui-même)

`src/components/widget/bank-connect-widget.tsx` :

- ligne 125 : `const tokenActif = !ferme && !repair ? demarrage.linkToken : null;`
- lignes 252-255 (form action) : `setFerme(false)` **puis** `demarrer(fd)`.

`useActionState` **conserve l'état précédent pendant le pending** : entre le clic
et la réponse de la Server Action, `demarrage.linkToken` vaut encore **l'ancien
LinkToken — qui est à usage unique et déjà consommé**. `setFerme(false)` suffit
donc à remonter le launcher immédiatement, qui appelle `open()` sur ce jeton mort.

Le CDN répond `LINK_TOKEN_USED` / `LINK_TOKEN_EXPIRED` → `onError` → `onClose` →
**fermeture silencieuse**. C'est le scénario le plus probable du bug rapporté :
ce n'est pas la banque qui plante, c'est notre réarmement qui rouvre sur un jeton
périmé. Aggravant : le launcher n'a pas de `key`, donc quand le nouveau token
arrive, React réutilise l'instance et **`open()` n'est jamais rappelé** (l'effet
dépend de `[isReady, open]`, tous deux stables) — le widget reste ouvert sur
l'ancien token.

> Corriger C1 seul transformerait un bug silencieux en bug **bruyant** : « ce lien
> a expiré » à chaque 2e tentative, sans réparer le parcours.

### C3 — Le script CDN qui ne charge pas : attente infinie et muette (trouvé en cross-review)

`omnifi-link-launcher.tsx` consommait `const { open, isReady } = useOmniFILink(…)` et
**jetait `error`**, que le hook expose pourtant (`vendor/…/dist/index.js:120`).

Quand le `<script>` CDN échoue (`handleError → setError`, `dist/index.js:73`), le hook
**ne met jamais `isReady` à `true`**. En chaîne :

- le launcher rend « Ouverture de la connexion bancaire… » **indéfiniment** ;
- `onError` **n'est jamais appelé** — c'est le CDN qui l'appellerait, or il n'est pas là ;
- `tokenActif` reste truthy → « Connecter une banque » **et** « Synchroniser mes comptes »
  restent **tous deux désactivés**.

Cul-de-sac total, rechargement obligatoire, zéro mot : **le bug d'origine par une
troisième porte** — et la plus probable en production. Preuve :

```
https://cdn.omni-fi.co/v1/omni-fi-connect.js          → HTTP 403   (prod NON déployée)
https://staging-cdn.omni-fi.co/v1/omni-fi-connect.js  → HTTP 200
```

Or `.env.prod:39` porte `NEXT_PUBLIC_OMNIFI_ENV="production"` (alors que le fichier
versionné `.env.prod.example:49` porte bien `"staging"`). Le repo **connaissait** déjà ce
mode de défaillance — `scripts/dev-server.sh:84` : « mettre "production" chargerait le
mauvais CDN → widget jamais initialisé » — et le masquait en forçant la variable. Tout
chemin de déploiement qui ne passe pas par ce script (Dockerfile, hébergeur) tombe dedans.
Hors de ce cas : bloqueur de pub, CSP, hors-ligne, panne CDN ouvrent le même cul-de-sac.

#### Pourquoi relayer `error` NE SUFFIT PAS (2ᵉ tour de cross-review)

Le hook **n'enlève jamais le `<script>` du `<head>`** : son cleanup ne fait que
`removeEventListener` (`dist/index.js:78-96` — vérifié, aucun `script.remove()`). Au montage
SUIVANT, son `querySelector` **retrouve le script mort** et lui attache ses écouteurs : or un
`<script>` qui a déjà émis `error` **n'émettra plus jamais rien**. Donc `isReady` reste `false`
ET `error` reste `null` → le relais ne se déclenche **plus**.

Conséquence : un correctif limité au relais ne parle qu'**une fois par chargement de page**.
Le message disait « Réessayez » → l'utilisateur réessaie → **retour à l'attente infinie et
muette**, au moment précis où il suit notre consigne. Le bug était repoussé d'un clic.

**Le remède est un WATCHDOG** (timeout sur `!isReady`) : la seule garde qui ne dépende
d'**aucun** événement amont. Il couvre quatre cas, dont deux qu'aucun relais n'attrape :

| cas | relais `error` | watchdog |
|---|---|---|
| 403, 1ᵉʳ essai | ✅ (parle vite) | ✅ |
| 403, **réessai** (script mort en `<head>`) | ❌ | ✅ |
| requête **gelée** (ni `load` ni `error`, jamais) | ❌ | ✅ |
| bloqueur qui drop sans émettre `error` | ❌ | ✅ |

Et le message dit désormais « **Rechargez la page** », pas « Réessayez » : tant que le script
mort est dans le `<head>`, un réessai **ne peut pas** aboutir. Le message doit nommer la seule
action qui marche.

#### C5 — `open()` jette quand le SDK est absent malgré un « load » (portail captif)

`isReady` passe à `true` sur l'événement **`load`**. Un `<script>` dont la réponse **arrive**
mais ne contient pas le SDK — **portail captif** (wifi d'hôtel/entreprise servant sa page de
login en HTTP **200**), proxy d'entreprise — émet bien `load`. D'où `isReady === true` avec
`window.OmniFI === undefined` → `open()` **jette** (`dist/index.js:104`) depuis un `useEffect`
→ remonte à l'**error boundary** : l'écran entier casse. `try/catch` → même issue utilisateur
que l'indisponibilité du SDK.

### C4 — Le `key` ressuscitait le LinkToken mort par le chemin RÉPARATION (trouvé en cross-review)

`lancerReparation()` démonte le launcher d'onboarding (via `tokenActif`) **sans que le
widget n'émette `onExit`** → `ferme` n'est jamais posé. Refermer la réparation faisait donc
**réapparaître** `demarrage.linkToken` (déjà consommé) → le `key` provoquait un remontage →
`open()` sur un jeton mort → un rouge « session expirée » **surgi d'une simple annulation**.
Pire : si c'est la RÉPARATION qui avait échoué, la résurrection écrasait aussitôt son
message par le mauvais — le correctif détruisait le diagnostic qu'il prétendait établir.

Le `key` n'a pas créé ce trou : il l'a **rendu observable** (sans lui, le changement de
branche du ternaire réutilisait l'instance en place et `open()` n'était pas rappelé).
Deux gardes le ferment : `setFerme(true)` dans `lancerReparation()`, et « Reconnecter »
désactivé tant qu'un widget est ouvert (`Boolean(tokenActif)`).

## 3. Arbitrage humain (rendu le 2026-07-13)

**Question** : inclure le correctif C2 dans ce PR ?
**Décision** : **oui** — C1 + C2 dans le même PR. Le « réarmement » demandé n'a de
sens que s'il rouvre sur un token frais.

## 4. Contrat runtime du CDN — **vérifié, pas supposé**

Le SDK vendoré (`vendor/omni-fi-react-link/dist/index.js`) passe `config` **tel
quel** à `window.OmniFI.connect(...)` : il ne normalise **aucun** callback. C'est
donc le **loader CDN** qui appelle `onError`. Extrait du bundle réellement déployé
(`https://staging-cdn.omni-fi.co/v1/omni-fi-connect.js`, HTTP 200 ; la prod
`cdn.omni-fi.co` répond **403** — non déployée, cf. mémoire projet) :

```js
onError({code: t.code || "UNKNOWN", message: t.message || "An error occurred"})
onExit()
onSuccess(t.connections)   // ← confirme la divergence historique (tableau nu)
```

Trois conséquences **qui contredisent le `.d.ts`** :

1. **`OmniFIErrorCode` est un faux type « fermé »**. Le runtime peut émettre
   `"UNKNOWN"`, qui **n'appartient pas à l'union**. Un `switch` exhaustif sur
   l'union compilerait, passerait `tsc`, et renverrait **`undefined` en
   production** → retour au bug d'origine. → le mapping prend un `string` (pas
   `OmniFIErrorCode`) et **exige une branche par défaut**.
2. **`message` est un texte amont, en anglais**, potentiellement porteur de PII
   (libellé bancaire) → **jamais affiché**, jamais loggé (règle 8). On mappe le
   **code**.
3. C'est exactement le piège déjà payé sur `onSuccess` (PR #61) : **suivre les
   types au lieu du runtime**. D'où le mandat : fonction **pure et défensive**,
   calquée sur `publicTokensDepuisPayload`.

## 5. Lots

| Lot | Fichier | Contenu |
|-----|---------|---------|
| L1 | `omnifi-link-launcher.tsx` | `messageErreurWidget(erreur: unknown): ErreurWidget` — fonction **pure**, exportée, défensive (jamais de throw, jamais de fuite du message amont) |
| L2 | `omnifi-link-launcher.tsx` | Sépare `onExit` (silencieux) de `onErreur` (parle). Logge le **code seul** en console (`console.warn`) — jamais l'identifiant banque, jamais le message amont |
| L3 | `bank-connect-widget.tsx` | État `erreurWidget` dédié ; onboarding : démonte + pose le message + réarme le bouton |
| L4 | `bank-connect-widget.tsx` | Réparation : démonte, **garde** la connexion dans `reparation` (bouton « Reconnecter » recliquable) + pose le message |
| L5 | `bank-connect-widget.tsx` | **C2** : `tokenActif` conditionné à `!demarrageEnCours` + `key={tokenActif}` sur le launcher |
| L6 | `widget-feedback.tsx` | Prop `erreurWidget` → `role="alert"` (canal distinct de `erreurDemarrage` / `erreurFinalisation` : origines et rescues différentes) |
| L7 | `demo/banque-connexion/page.tsx` | État « erreur widget » figé → Visual QA (Gate 4) hors auth/DB |
| L8 | `tests/unit/omnifi-link-erreur.test.ts` | Chemin heureux (chaque famille) + échec + limites (`UNKNOWN`, dégénérés, null) + **anti-fuite du message amont** |
| **L9** | `omnifi-link-launcher.tsx` | **C3** : trois chemins vers UN seul point de sortie `signalerSdkIndisponible` (garde `useRef`, une notification par montage) — relais `error` (parle vite) + **watchdog 15 s** (le seul qui tienne au 2ᵉ essai) + `catch` autour d'`open()` (**C5**) |
| **L10** | `bank-connect-widget.tsx` | **C4** : `setFerme(true)` dans `lancerReparation()` + « Reconnecter » désactivé si un widget est ouvert |
| **L11** | `bank-connect-widget.tsx` | `setErreurWidget(null)` dans `synchroniser()` — 3ᵉ point d'entrée d'un nouvel essai (sinon rouge d'échec **à côté** du vert de succès) |
| **L12** | `widget-feedback.tsx` | Prop `widgetOuvert` **distincte** de `reparationEnCours` : l'une DÉSACTIVE, l'autre pilote le libellé « Ouverture… ». Les fondre faisait afficher « Ouverture… » alors que rien ne s'ouvrait |

### Pourquoi un état `erreurWidget` dédié plutôt que réutiliser `finalisation.erreur`

`finalisation` n'est nettoyé qu'au démarrage d'un parcours ou dans
`lancerReparation`. Y écrire l'erreur du widget la ferait **survivre** aux cycles
de réparation et **écraserait** un éventuel succès partiel affiché. Un état dédié
se nettoie explicitement aux deux seuls points d'entrée (nouveau parcours, nouvelle
réparation), et sépare trois origines que le registre S2 distingue déjà.

## 6. Registre S2 — codepath « Widget natif (CDN) »

Le `Record` de L1 **est** le registre exécutable. Aucun catch-all : tout code non
listé tombe dans la branche par défaut (message générique + code loggé).

```
CODE                                         | RESCUE                          | USER VOIT
---------------------------------------------|---------------------------------|----------------------------------
SDK_SCRIPT_LOAD_FAILED (INTERNE — le CDN ne  | réarmer ; si persiste, support   | « le module n'a pas pu se charger »
  peut PAS le signaler : il n'a pas chargé)  |                                  |
LINK_TOKEN_INVALID / _EXPIRED / _USED        | réarmer → nouveau LinkToken      | « session expirée, recommencez »
SESSION_TOKEN_* (4 codes)                    | réarmer → nouveau parcours       | « session expirée (inactivité) »
PUBLIC_TOKEN_INVALID / _USED / _EXPIRED      | réarmer → réessayer              | « finalisation impossible, réessayez »
PUBLIC_TOKEN_CLIENT_MISMATCH                 | réarmer + log (frontière tenant) | message générique, **non-énumérant**
INSTITUTION_LOCKED                           | attendre                         | « accès bloqué (trop de tentatives) »
INSTITUTION_NOT_FOUND / _REQUIRED            | réarmer                          | « banque indisponible »
INSTITUTION_SANDBOX_ONLY / SANDBOX_CREDS_REQ | env de test                      | message d'environnement de test
ORIGIN_NOT_ALLOWED                           | config (RedirectOrigin https)    | « connexion non autorisée d'ici »
VALIDATION_ERROR                             | réarmer                          | erreur technique générique
UNKNOWN + tout code inconnu (défaut)         | réarmer                          | « échec, réessayez dans un instant »
```

## 7. Exit criteria (règle 3 — surface d'erreur)

- [ ] Validation : entrée `unknown`, normalisation défensive, **aucun throw possible**
- [ ] Chaque erreur a un nom : code machine → message UI mappé (§6). **Pas de catch-all silencieux**
- [ ] Messages **non-énumérants**, **sans PII** : le `message` amont n'est ni affiché ni loggé
- [ ] Tests : chemin heureux + chemin d'échec + cas limite (`UNKNOWN`, objet dégénéré, `null`)
- [ ] Log structuré : **code seul**, jamais l'identifiant banque
- [ ] Câblé pour l'**onboarding ET la réparation**
- [ ] Gates : `lint` + `typecheck` + `test` + `build` verts
- [ ] Visual QA (Gate 4) : état d'erreur capturé sur `/demo/banque-connexion`
- [ ] Cross-review par contexte frais (règle 6)

## 8. Hors périmètre (dette tracée — règle 9)

- **Reprise transparente sur `LINK_TOKEN_EXPIRED`** : le registre S2 du plan
  d'origine promettait « régénérer le link-token, relancer le widget » sans clic.
  Ici on réarme et l'utilisateur reclique (rescue explicite). La reprise
  automatique est risquée (boucle de relance si le token expire immédiatement) →
  **TODOS P2**, à raccrocher à un chantier widget.
- **Télémétrie serveur des codes d'erreur widget** : on logge en console
  navigateur (le launcher est client-only). Une remontée serveur exigerait une
  Server Action dédiée (surface + rate-limit) → **TODOS P2**.
