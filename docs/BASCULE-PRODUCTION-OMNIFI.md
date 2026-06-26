# Bascule production Omni-FI — état & checklist (constat 2026-06-24)

> Note de bilan après une tentative réelle de démarrage en mode production. À lire
> AVANT de retenter la bascule prod. Source de vérité du verrou : `src/server/omnifi/config.ts`.

> ## ⚠️ MISE À JOUR 2026-06-26 — l'URL est PARTAGÉE sandbox↔prod (confirmé tuteur)
>
> **Le « il n'existe pas d'API de prod » ci-dessous n'est PAS un blocage** : Omni-FI
> n'a pas d'hôte de prod *distinct*. `api-stage.omni-fi.co` sert pour le sandbox ET la
> production. Ce qui fait la « vraie donnée », ce sont les **clés ApiClient** (`prod_…`)
> + l'**EndUser** rattaché aux clés — **PAS l'hôte**. On reste donc sur `api-stage`.
>
> Conséquence code (livré, `feat/verrou-prod-hote-partage`) : `config.ts` connaît
> désormais des **hôtes PARTAGÉS** (`HOTES_PARTAGES`). Sur un hôte partagé,
> `OMNIFI_ENV="production"` est autorisé **dès que `OMNIFI_AUTORISER_PRODUCTION="1"`**
> (l'env porte l'INTENTION ; la garde de cohérence n'arbitre plus par l'hôte). Le
> fail-closed par défaut et l'anti-fuite de secret sont INCHANGÉS.
>
> **Pour traiter de la vraie donnée maintenant** : suivre `.env.prod.example`
> (URL `api-stage`, `OMNIFI_ENV="production"`, drapeau `"1"`, clés prod,
> `NEXT_PUBLIC_OMNIFI_ENV="staging"`) + créer/inscrire l'EndUser prod (piège n°3).
> Les sections « API de prod absente » plus bas restent vraies pour le jour où Omni-FI
> ouvrira un hôte de prod *dédié* (il rejoindra alors `HOTES_PRODUCTION`).

## TL;DR

**Notre plomberie de bascule est correcte ET prouvée runtime (modale bancaire ouverte
avec les clés de PRODUCTION le 2026-06-24).** Deux nuances à ne JAMAIS oublier :

1. **Il n'existe pas (encore) d'API de prod.** `api.omni-fi.co` = NXDOMAIN. Ce qu'on a
   fait fonctionner, ce sont les **clés ApiClient de prod (`prod_…`) contre l'API
   _staging_** (`api-stage.omni-fi.co`), pas contre un backend de prod. Le « mode prod »
   réel reste bloqué côté Omni-FI tant qu'ils n'ont pas déployé l'hôte.
2. **Le déblocage du 2026-06-24 ne venait NI des clés NI de l'hôte** : il venait du
   **`RedirectOrigin` qui doit être en HTTPS** (Omni-FI rejette tout http en `400`).
   Voir la section « Déblocage prouvé » plus bas — c'est le tribal knowledge central.

> ⚠️ Le « Trio Cohérent » à retenir : **Clés (sandbox|prod) + URL de l'API
> correspondante + `NEXT_PUBLIC_OMNIFI_ENV` (CDN du widget) correspondant + un EndUser
> qui existe POUR CES CLÉS**. Mélanger un cran (ex. clés prod + EndUser sandbox) → l'API
> refuse. **Mais** un trio cohérent ne suffit pas si le `RedirectOrigin` est en http.

## Ce qui a été prouvé (runtime, 2026-06-24)

| Test | Résultat | Interprétation |
|---|---|---|
| `nslookup api.omni-fi.co` | **NXDOMAIN** | L'hôte de prod **n'existe pas** dans le DNS |
| `curl https://api.omni-fi.co/v1/` | HTTP 000 (pas de connexion) | Rien à joindre — `/v1` n'y change rien |
| `curl https://api-stage.omni-fi.co/health/` | **HTTP 200** | Le staging fonctionne |
| Notre app démarrée en mode prod | « Cible : production @ https://api.omni-fi.co » puis `OmniFiNetworkError` | **La bascule marche** ; l'échec est réseau (hôte absent), PAS config/clés/code |

### Confirmation d'Omni-FI (texte du tuteur/équipe, 2026-06-24)
> « We're still **pre-production with staging backend** […] We'll publish the docs
> publicly once the SDK ships to NPM **alongside a production backend**. »

⇒ Le backend de production **n'existe pas encore**, c'est assumé et volontaire. La doc
est un preview privé Fern (non public).

## Déblocage prouvé runtime — tribal knowledge (2026-06-24)

Récit du déblocage qui a permis d'ouvrir la modale bancaire avec les **clés de prod**.
Trois pièges, dans l'ordre où on les a rencontrés. **À lire avant toute manip d'env Omni-FI.**

### Piège n°1 (LE bon) — `RedirectOrigin` DOIT être en HTTPS, sinon `400`

C'était la **vraie cause** de l'`OMNIFI_API_ERROR` qu'on a chassée longtemps. Le serveur
TYGR appelle `POST /connections/link-token` avec un `RedirectOrigin` = `window.location.origin`
du navigateur. En dev sur `http://localhost:3000`, ce champ part en **http** → Omni-FI répond :

```
HTTP 400  {"Code":"400 BadRequest",
           "Message":"RedirectOrigin: Value error, RedirectOrigin must use HTTPS scheme."}
```

Prouvé par deux `curl` identiques SAUF le scheme du RedirectOrigin (mêmes clés prod, même
API staging, même EndUser) :

| `RedirectOrigin` envoyé | Réponse Omni-FI |
|---|---|
| `https://your-app.example.com` | **HTTP 201** + LinkToken valide ✅ |
| `http://localhost:3000` | **HTTP 400** « must use HTTPS scheme » ❌ |

**Conséquences pratiques :**
- **Le widget natif n'est PAS testable sur `http://localhost`**, quel que soit l'env ou les
  clés. Il faut du **HTTPS local** : `node_modules/.bin/next dev --experimental-https`
  (certificat auto-signé) → l'origine devient `https://localhost:3000`, Omni-FI accepte.
  Penser à mettre `APP_ALLOWED_ORIGINS="https://localhost:3000"` (notre allow-list interne).
- ⚠️ **Piège QA** : le navigateur headless `gstack/browse` REJETTE le certificat auto-signé
  (`ERR_CERT_AUTHORITY_INVALID` → `chrome-error://`). Pour un test visuel du widget, l'ouvrir
  dans un **vrai navigateur** (« Continuer vers localhost ») ou installer `mkcert` (CA de
  confiance). Le headless ne suffit pas pour ce parcours précis.
- 🐛 **Incohérence de code repérée** : `APP_ALLOW_INSECURE_LOCALHOST="1"` laisse `http://localhost`
  passer NOTRE garde `autoriserRedirectOrigin` (`src/server/widget/redirect-origin.ts`) —
  mais ça ne sert À RIEN pour le widget, puisque Omni-FI rejette http en `400` en amont. Ce
  flag ne valide que le *démarrage* de l'action serveur, jamais une vraie ouverture de widget.
  (Dette UI tracée — cf. TODOS, ne pas le présenter comme « permet de tester le widget en http ».)

### Piège n°2 — le « Trio Cohérent » : clés + URL + CDN widget + EndUser alignés

L'env doit être cohérent sur **quatre** axes, sinon `OMNIFI_API_ERROR` (ou 401/403) :

| Axe | Variable | Sandbox | « Prod » (testé via staging) |
|---|---|---|---|
| Secret ApiClient | `OMNIFI_SECRET` | `sand_…` | `prod_…` |
| URL de l'API | `OMNIFI_BASE_URL` | `https://api-stage.omni-fi.co` | idem (pas d'API prod réelle) |
| CDN du widget | `NEXT_PUBLIC_OMNIFI_ENV` | `staging` | `staging` (le CDN doit matcher l'API jointe) |
| EndUser (ClientUserId) | cf. piège n°3 | `tygr-demo-omnicane` | `tygr-prod-omnicane` |

⚠️ **`NEXT_PUBLIC_OMNIFI_ENV`** pilote le CDN du widget (`omnifi-link-launcher.tsx:69` :
« `staging` pour le sandbox »). Si on met `production` ici alors qu'on tape l'API staging,
le widget charge le mauvais CDN → il peut ne jamais s'initialiser. Pour un test local contre
staging, **forcer `staging`** même avec un `.env.prod` (override au lancement, sans modifier
le fichier).

### Piège n°3 — le ClientUserId vient de la BASE, et l'annuaire EndUser ne suit pas les clés

`ClientUserId` (= `workspaces.omnifi_client_user_id`) est lu **en base de données**
(`src/server/widget/orchestration.ts` — frontière tenant, JAMAIS depuis `.env`). Donc
changer `OMNIFI_DEMO_CLIENT_USER_ID` dans `.env.prod` **ne suffit pas** : il faut que la
colonne du workspace porte un EndUser **qui existe pour les clés utilisées**.

**Mécanique critique — `POST /clients/end-users` :** l'annuaire des EndUsers est
**rattaché à l'ApiClient**. Un **nouvel ApiClient (= nouvelles clés, ex. passage prod)
implique de RE-CRÉER l'EndUser** via `POST /clients/end-users` puis de l'inscrire en base
sur le workspace. Un EndUser sandbox (`tygr-demo-omnicane`) est **inconnu** des clés prod →
`link-token` échoue. L'annuaire **ne migre pas** d'un ApiClient à l'autre.

> Procédure d'alignement (base LOCALE de dev) utilisée le 2026-06-24 :
> `UPDATE workspaces SET omnifi_client_user_id='<EndUser-des-clés>' WHERE name='Omni-FI HQ'`.
> En vrai déploiement : créer l'EndUser via l'API (`POST /clients/end-users`) AVANT, puis
> renseigner sa valeur. Réversible : remettre `tygr-demo-omnicane` pour revenir au sandbox.

## Le piège du `/v1` — TRANCHÉ : routes à la RACINE, PAS de `/v1`

L'OpenAPI (`openapi/api.json`, bloc `servers`) annonce :
```json
[
  { "url": "https://api.omni-fi.co/v1",       "description": "Production" },
  { "url": "https://api-stage.omni-fi.co/v1", "description": "Staging" },
  { "url": "https://sandbox.omni-fi.co/v1",   "description": "Sandbox" }
]
```
**MAIS le serveur réel répond à la RACINE, pas sous `/v1`** — prouvé sur le staging :

| Chemin testé (staging) | HTTP | Verdict |
|---|---|---|
| `/connections/link-token` (racine) | **401** | ✅ bon chemin (401 = auth requise → l'endpoint existe) |
| `/v1/connections/link-token` | **404** | ❌ n'existe pas |
| `/health/` (racine) | 200 | ✅ |
| `/v1/health/` | 404 | ❌ |

⇒ **`OMNIFI_BASE_URL` doit être SANS `/v1`** (`https://api-stage.omni-fi.co`, et plus tard
`https://api.omni-fi.co`). Ajouter `/v1` casserait tout (404). La doc OpenAPI ment sur ce
point — déjà noté dans `config.ts:16`, ici re-prouvé par 401-vs-404.

## Hôtes — doc vs réalité (la doc n'est PAS fiable sur les noms d'hôtes)

| Environnement | URL doc/OpenAPI | Réalité vérifiée |
|---|---|---|
| Production | `api.omni-fi.co` | NXDOMAIN (pas déployé au 2026-06-24) |
| **Staging** | `api-stage.omni-fi.co` | ✅ **existe et fonctionne** (notre sandbox actuelle) |
| Sandbox | `sandbox.omni-fi.co` | NXDOMAIN (coquille — déjà notée `config.ts:41`) |

Leçon : pour les hôtes Omni-FI, **la source de vérité est le tuteur, pas la doc**. La doc
a déjà eu tort pour la sandbox (`sandbox.omni-fi.co` mort → `api-stage` fourni à la main).

## Checklist AVANT de retenter la bascule prod (le jour où Omni-FI déploie)

1. [ ] **Confirmer auprès d'Omni-FI/tuteur** : l'API de prod est-elle en ligne, et à quel
       hôte exact ? (Peut différer de `api.omni-fi.co`, comme `api-stage` ≠ `sandbox`.)
2. [ ] `nslookup <hôte prod>` doit résoudre + `curl https://<hôte>/health/` → 200.
3. [ ] **Vérifier la convention de chemin de la prod** : `/<endpoint>` (racine) attendu —
       confirmer par un 401 sur `/connections/link-token` (et NON 404). Si la prod exigeait
       `/v1` (peu probable, mais à vérifier), adapter `OMNIFI_BASE_URL` en conséquence.
4. [ ] Si l'hôte de prod réel ≠ `api.omni-fi.co`, l'ajouter à l'allow-list
       `HOTES_AUTORISES` **et** `HOTES_PRODUCTION` dans `config.ts` (PR dédiée, revue).
5. [ ] Renseigner les vraies clés de prod dans `.env.prod` (`OMNIFI_CLIENT_ID`/`SECRET`/
       `OMNIFI_DEMO_CLIENT_USER_ID`) + `OMNIFI_AUTORISER_PRODUCTION="1"` (lève le verrou).
6. [ ] Migration `0012` + suivantes appliquées sur la base de prod **par le pipeline CI/CD**
       (`migrate` PUIS `deploy`), jamais à la main depuis un poste.

## Comment lancer en local (rappels)

- **Staging (défaut)** : `npm run dev` (lit `.env` → `api-stage.omni-fi.co`, verrou actif).
- **Prod / clés prod (test client, base locale) — AVEC le widget** : il faut du HTTPS
  (piège n°1). Trio sourcé + override CDN staging + allow-list https + serveur TLS :
  ```bash
  set -a && . ./.env.prod && set +a && unset NODE_OPTIONS
  export NEXT_PUBLIC_OMNIFI_ENV=staging          # CDN du widget = staging (API jointe)
  export APP_ALLOWED_ORIGINS="https://localhost:3000"
  node_modules/.bin/next dev --experimental-https -p 3000   # certificat auto-signé
  ```
  - Aligner d'abord le ClientUserId en base sur l'EndUser des clés (piège n°3).
  - Ouvrir **https://**localhost:3000 dans un **vrai navigateur** (« Continuer ») : le
    headless `browse` rejette le cert auto-signé (utiliser `mkcert` si besoin de headless).
  - ⚠️ `--env-file` est INCOMPATIBLE avec `NODE_OPTIONS` sur Node 25 → **sourcer** (`set -a`),
    jamais `--env-file`.
- **Prod SANS toucher au widget** (juste naviguer l'app avec les clés/base prod) : même
  chose en `next dev` http suffit, mais « Connecter une banque » échouera en `400` (http).
