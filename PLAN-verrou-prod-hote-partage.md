# Plan — Réconcilier le verrou Omni-FI avec un hôte partagé sandbox/prod

> Phase : **conception** (CLAUDE.md règle 1). Aucune ligne de code applicatif tant
> que ce plan n'est pas validé + cross-review. Surface de SÉCURITÉ → revue obligatoire.
> Date : 2026-06-26. Demandeur : Etienne (user). Contexte mémoire : voir
> `BASCULE-PRODUCTION-OMNIFI.md` et la mémoire `verrou-prod-omnifi-hote-partage`.

## 1. Problème (fait nouveau du 2026-06-26)

Information donnée par le user, qui **invalide une hypothèse du code** :
> « c'est la même URL pour le sand et la prod » → `api-stage.omni-fi.co` sert pour le
> sandbox ET la production. Ce qui distingue « vraie donnée » de « donnée bac à sable »,
> ce sont **les clés ApiClient** (`prod_…` vs `sand_…`) et **l'EndUser** rattaché à ces
> clés — **pas l'hôte**.

Or `src/server/omnifi/config.ts` suppose l'inverse : il déduit l'environnement de
l'HÔTE (`HOTES_PRODUCTION = {api.omni-fi.co}`). Conséquence, deux gardes bloquent la
config légitime « clés prod + URL stage » :

- **Garde de cohérence env↔hôte** (`config.ts:160`) : `OMNIFI_ENV="production"` + hôte
  stage → `OmniFiConfigError("Incohérence…")`, l'app refuse de démarrer.
- **Verrou sandbox** (`config.ts:134`) : `OMNIFI_AUTORISER_PRODUCTION="1"` n'autorise
  que l'hôte `api.omni-fi.co` (NXDOMAIN, inexistant).

**État actuel constaté** (`.env`) : `OMNIFI_ENV="sandbox"` avec des clés prod. Ça
« marche » mais c'est un **faux étiquetage dangereux** : l'app croit être en bac à
sable alors qu'elle traite de la VRAIE donnée bancaire → les garde-fous « pas de donnée
réelle hors prod » (CLAUDE.md règle 8) sont endormis, les logs/observabilité ne savent
pas qu'on manipule du réel.

## 2. Objectif

Permettre `OMNIFI_ENV="production"` sur l'hôte partagé `api-stage.omni-fi.co`, **via
l'opt-in explicite `OMNIFI_AUTORISER_PRODUCTION="1"`**, SANS affaiblir les autres
protections (anti-fuite de secret, fail-closed par défaut, allow-list d'hôtes).

Non-objectif : changer la sémantique du widget (`NEXT_PUBLIC_OMNIFI_ENV` pilote le CDN,
reste `staging` tant que l'API jointe est staging — piège n°2 du bilan). Hors scope :
création de l'EndUser prod (étape opérationnelle séparée), base de données dédiée
(chantier infra séparé).

## 3. ⚠️ Pushback obligatoire (règle 10) — à trancher AVANT le code

1. **Le verrou est une exigence explicite du tuteur** (mémoire `verrou-sandbox-omnifi`,
   « exigence tuteur 2026-06-22 »). L'assouplir est une décision de gouvernance, pas un
   simple refactor. → Le user a choisi « adapter le verrou (plan + revue) ». On trace
   ici que la décision est assumée ; **mentionner au tuteur** reste recommandé (le
   filet ne disparaît pas : la prod reste fail-closed par défaut, opt-in inchangé).

2. **Vraie donnée bancaire sur base Docker locale** (réponse user). Contredit la règle 8
   (« pas de dump de prod en local »). Risque : pas de chiffrement au repos garanti, pas
   de backup, donnée en clair via `.env`. **Tolérable pour démo/test ponctuel, PAS comme
   usage durable.** → Dette à consigner dans TODOS.md (P1, déclencheur : premier usage
   durable de donnée réelle). N'EST PAS bloquant pour ce plan, mais doit être écrit.

3. **Alternative plus simple écartée** : « laisser env=sandbox ». Rejetée par le user et
   déconseillée (faux étiquetage). On garde l'option d'un 3ᵉ état d'env ? → NON : deux
   valeurs (`sandbox`/`production`) suffisent ; ajouter `staging` casserait le type union
   et le test ligne 170. La distinction se fait par clés, l'env dit l'INTENTION.

## 4. Conception retenue

**Principe directeur** : sur un hôte partagé, l'hôte ne peut plus arbitrer
sandbox-vs-prod. C'est l'opt-in `OMNIFI_AUTORISER_PRODUCTION="1"` qui devient le signal
d'intention prod ; l'hôte ne sert plus qu'à la sécurité (allow-list anti-fuite).

### 4.1 Notion d'« hôte partagé »

Introduire un 3ᵉ ensemble dans `config.ts` :
```
HOTES_PARTAGES = { "api-stage.omni-fi.co", "stage.omni-fi.co" }
```
Un hôte partagé accepte LES DEUX environnements. `HOTES_PRODUCTION = {api.omni-fi.co}`
reste « prod-only » (le jour où il existera). Un hôte ni partagé ni prod (cas théorique
futur) reste « sandbox-only ».

### 4.2 Garde de cohérence env↔hôte — assouplie pour les hôtes partagés

Logique cible :
- hôte **prod-only** + env sandbox → refus (incohérence) — INCHANGÉ.
- hôte **sandbox-only** + env production → refus (incohérence) — INCHANGÉ.
- hôte **partagé** + env sandbox → OK.
- hôte **partagé** + env production → **OK uniquement si le verrou est levé** (cf 4.3).

### 4.3 Verrou sandbox — devient « verrou production » au sens large

Tant que `OMNIFI_AUTORISER_PRODUCTION != "1"` :
- `OMNIFI_ENV="production"` refusé (quel que soit l'hôte, partagé inclus) — RENFORCÉ :
  aujourd'hui un hôte partagé + env prod tombe sur l'incohérence ; demain c'est le
  verrou qui doit mordre EN PREMIER, avec le message « poser le drapeau ».
- hôte prod-only refusé — INCHANGÉ.

Drapeau levé (`="1"`) :
- `OMNIFI_ENV="production"` sur hôte **partagé** → **autorisé** (le cas voulu).
- `OMNIFI_ENV="production"` sur hôte **prod-only** → autorisé — INCHANGÉ.
- Cohérence toujours vérifiée (un env=production sur un hôte sandbox-only reste refusé).

### 4.4 Ce qui NE change PAS (invariants de sécurité préservés)

- `validerBaseUrl` : https obligatoire, pas de userinfo, hôte dans `HOTES_AUTORISES`.
- Fail-closed PAR DÉFAUT : sans le drapeau, aucune prod.
- Secret jamais loggé.
- `OMNIFI_ENV` ∈ {sandbox, production} (pas de 3ᵉ valeur).
- Lecture paresseuse + `_reinitialiserConfigOmniFi`.

## 5. Fichiers touchés

| Fichier | Nature | Détail |
|---|---|---|
| `src/server/omnifi/config.ts` | code | `HOTES_PARTAGES`, refonte des branches verrou + cohérence (§4) |
| `tests/unit/omnifi-config.test.ts` | test | **transformer** le cas l.128-137 (« refuse prod sur hôte sandbox même déverrouillé ») en sa version correcte pour un hôte PARTAGÉ : prod+stage+drapeau → ACCEPTÉ. Garder le refus pour un futur hôte sandbox-only s'il en existe. + nouveaux cas (cf §6) |
| `.env.prod.example` | doc | corriger : URL = `api-stage.omni-fi.co` (pas `api.omni-fi.co`), expliquer « hôte partagé, l'env se décide par les clés » |
| `docs/BASCULE-PRODUCTION-OMNIFI.md` | doc | acter le fait nouveau « 1 URL sand+prod » + la nouvelle sémantique du verrou |
| `TODOS.md` | dette | entrée P1 « vraie donnée bancaire sur base Docker locale » (déclencheur : usage durable) ; entrée « EndUser prod à créer/inscrire en base » |

## 6. Tests (exit criteria, règle 3 + 5)

Le contrat actuel (15 cas) doit rester vert SAUF le cas l.128-137 explicitement
retourné. Cas à AJOUTER :
- ✅ prod + hôte **partagé** (`api-stage`) + drapeau `"1"` → **accepté**, `environment==="production"`.
- ✅ prod + hôte partagé SANS drapeau → refus `/Verrou/` (le verrou mord en premier, pas l'incohérence).
- ✅ sandbox + hôte partagé + drapeau → toujours sandbox (le flag n'impose pas la prod) — déjà couvert l.122, revérifier.
- ✅ prod + hôte **prod-only** (`api.omni-fi.co`) + drapeau → accepté — INCHANGÉ (l.110).
- ✅ prod + hôte prod-only SANS drapeau → refus verrou — INCHANGÉ (l.79).
- ✅ Anti-fuite : evil host / userinfo / http → refus — INCHANGÉ (l.151+).
- ✅ Cas limite : `OMNIFI_AUTORISER_PRODUCTION` ∈ {"true","0","",…} → verrouillé — INCHANGÉ (l.96).

`npm run lint` + `npm run typecheck` + suite complète verts avant tout commit (règle 5).

## 7. Cross-review (règle 6) — mandat au réviseur frais

Chercher activement :
- Un chemin où `OMNIFI_ENV="sandbox"` + clés prod passerait SANS signal (faux étiquetage résiduel).
- Un trou où le drapeau levé autoriserait un hôte HORS allow-list (régression anti-fuite).
- Une asymétrie verrou/cohérence : ordre des `if` (le verrou doit mordre AVANT la cohérence).
- Confiance /10 + `fichier:ligne` par constat. Pas de constat fabriqué.

## 8. Livraison (Human-in-the-Loop)

Branche `feat/verrou-prod-hote-partage` depuis `origin/main` à jour. Commit → push →
`gh pr create` → URL fournie au user. **STOP à la PR** : c'est une PR applicative +
sécurité → merge MANUEL par le user après Visual QA non requis (pas d'UI) mais revue
sécurité humaine OUI (règle 3 nuancée). Donner la commande de test exacte.

## 9. Étapes opérationnelles APRÈS merge (hors code, à documenter, pas dans cette PR)

1. Créer l'EndUser prod : `POST /clients/end-users` avec les **clés prod**.
2. Inscrire sa valeur en base : `UPDATE workspaces SET omnifi_client_user_id='…' WHERE …`
   (le code lit la colonne, pas `.env` — `orchestration.ts:109`).
3. Régler `.env` : `OMNIFI_ENV="production"` + `OMNIFI_AUTORISER_PRODUCTION="1"` +
   clés prod. URL reste `api-stage.omni-fi.co`. `NEXT_PUBLIC_OMNIFI_ENV="staging"` (CDN).
4. (P1 différé) Migrer la vraie donnée hors base Docker locale vers une base dédiée.
