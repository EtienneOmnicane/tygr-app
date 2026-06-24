# Bascule production Omni-FI — état & checklist (constat 2026-06-24)

> Note de bilan après une tentative réelle de démarrage en mode production. À lire
> AVANT de retenter la bascule prod. Source de vérité du verrou : `src/server/omnifi/config.ts`.

## TL;DR

**Notre configuration de prod est correcte. Le blocage est 100 % côté Omni-FI : l'API
de production n'est pas encore déployée.** Rien à corriger chez nous tant qu'Omni-FI
n'a pas mis l'hôte de prod en ligne.

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
- **Prod (test client, base locale)** : `set -a && . ./.env.prod && set +a && unset NODE_OPTIONS && node_modules/.bin/next dev`
  - ⚠️ `--env-file` est INCOMPATIBLE avec `NODE_OPTIONS` sur Node 25 (« --env-file= is not
    allowed in NODE_OPTIONS ») → utiliser le **sourcing** ci-dessus, pas `--env-file`.
  - ⚠️ accéder en **http://** localhost:3000 (le dev server ne fait pas de TLS ; Chrome
    force parfois https → `ERR_SSL_PROTOCOL_ERROR`, faux problème).
