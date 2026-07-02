# Chantier — consignation (2026-07-02)

Journal de tout ce qui est en cours ou en attente, hors le diagnostic
« transactions manquantes » (voir `DIAGNOSTIC-transactions-manquantes.md`).

## 1. Branches livrées, en attente de push / PR / merge

Trois branches prêtes, testées **vertes** sur ta machine (12/12 checks). Coupées
depuis `main` (HEAD `d70e719`, #165). Les agents ne poussent pas — tu pushes, tu
ouvres les PR, tu fais la QA visuelle, tu merges.

Ordre de merge conseillé : **ci/bump → fix/403 → entity-party1** (chaque suivante
recoupée sur main à jour).

| Branche | Contenu | QA visuelle |
|---|---|---|
| `ci/bump-checkout-setup-node-v5` | CI : `actions/checkout@v4→v5`, `actions/setup-node@v4→v5` (node 22 inchangé). | CI verte sur la PR. |
| `fix/omnifi-403-reconnect-surface` | Fail-soft 403 : bucket `aReconnecter`, garde `estDesalignementEndUser`, message FR « à reconnecter », event `omnifi_sync_connexion_a_reconnecter`. | `/demo/banque-connexion` bloc 7. |
| `feat/entity-party1-bridge` | Pont Party→entité : `listerPropositionsPartyEntite` (ADMIN), `confirmerPropositionAction`, UI `propositions.tsx`. | `/admin/entites`. |

## 2. Décisions techniques en attente

- **Durcissement de la garde 403** (`orchestration.ts`, `estDesalignementEndUser`).
  Elle s'ouvre sur `status===403` avec `obieCode` préféré mais élargi par
  `obieCode !== ""`. À trancher : resserrer sur le seul `PUBLIC_TOKEN_CLIENT_MISMATCH`
  ou garder l'élargissement (risque : classer en « à reconnecter » des 403 qui
  n'en sont pas). **Bloqué par** le diagnostic : on saura quels 403 reviennent
  vraiment en prod.
- **Résilience per-account** `INGEST-RESILIENCE-COMPTE1` : `try/catch` par compte
  dans la boucle d'ingestion pour qu'un compte en échec n'abandonne pas les
  suivants. **Bloqué par** le diagnostic (ne coder qu'une fois la cascade confirmée).

## 3. UI / UX

- **Styling ENTITY-PARTY1** : `propositions.tsx` est minimal (fonctionnel, pas
  fignolé). Passe de style à prévoir après merge.
- **Accordéon comptes par entité** `UI-ACCOUNTS-ACCORDEON-ENTITE1` : débloqué par
  ENTITY-PARTY1 (les comptes ont enfin un `entity_id` assignable). À planifier.
- **Donut FYGR** :
  - Placement : **décidé** → onglet « graphique » de la nav (comme FYGR).
  - **2 décisions produit en attente** : (a) quelle catégorie agréger dans le
    donut ; (b) traitement des virements internes (les inclure fausse les totaux —
    à exclure ? à isoler dans une part « transferts » ?).

## 4. Reframe EndUser

L'ancien diagnostic « désalignement EndUser » pour les transactions MCB manquantes
est **abandonné** : prod + 3 banques réelles + bon EndUser + données réelles le
réfutent. Le travail fail-soft 403 (branche `fix/omnifi-403-reconnect-surface`)
reste utile (il gère un VRAI reconsentement quand il survient), mais ce n'est pas
la cause des transactions manquantes.

## 4bis. Transactions manquantes — VERDICT (2026-07-02)

Diagnostic **clos** côté analyse (voir `DIAGNOSTIC-transactions-manquantes.md`, bandeau
en tête). Cause probable : **staleness amont, pas un bug TYGR**. Prouvé par le code :
`last_synced_at` posé (06:06) ⟹ la boucle de pages est allée au bout sans lever ⟹ tout
ce qui a été lu a été upserté ; la base ayant 40 lignes (avril), l'amont ne rendait que
~40 à 06:06. Le job de scrape Omni-FI a approfondi mai/juin **après**, et l'ingestion
n'a pas été re-déclenchée depuis.

- **Livrable read-only :** `DIAGNOSTIC-dryrun-transactions.ts` (rejoue lecture +
  `versLignePersistee`, 0 écriture) — tranche staleness (attendu) vs conversion (bug).
- **Confirmation = re-sync réel d23196 (ÉCRITURE, donc toi)** → attendu base 40 → 162,
  `created ≈ 122` dans le log `omnifi_sync_completed`.
- **Dette de robustesse (≠ cause, requalifiée depuis « cause racine ») :** clé unique
  `transactions_cache` sans `bank_account_id` (0 collision sur la donnée actuelle) ;
  une transaction DB **par page** (un throw sur page N laisse pages<N committées).
  À traiter hors urgence — voir tâche #6.
- Fail-soft 403 (branche `fix/omnifi-403-reconnect-surface`) : conservée, utile pour un
  VRAI reconsentement, orthogonale à ce verdict.

**Résultat dry-run (confirmé, read-only) :** 9 pages · pageSize 20 · `total_brutes`=162,
`total_converties`=162, `exceptions`=0, dates **3 avril → 2 juillet** (des tx d'aujourd'hui,
impossibles à 06:06). ⟹ H2 (staleness amont) prouvée, H1 (conversion) écartée. Détail :
`txn_ids_distincts`=161 pour 162 brutes ⟹ **1 TransactionId amont dupliqué sur 2 dates** ;
au re-sync, la pré-passe `upsertTransactions` marquera la date la plus ancienne
`is_removed=true` → **162 lignes physiques / 161 actives** (ne pas s'étonner du 161).

**Action HITL :** re-sync d23196 (bouton « Synchroniser mes comptes »). Attendu :
base 40 → 162 (161 actives), `created ≈ 122` dans `omnifi_sync_completed`.

**Leçon opérationnelle (nouvelle dette) :** un compte fraîchement connecté peut n'exposer
qu'une fraction de son historique à t0 ; l'agrégateur approfondit ensuite (heures/jours).
⟹ (a) note de runbook « re-sync différé après première connexion » ; (b) **candidat à
ré-ouvrir DASH-AUTOSYNC** (re-sync périodique automatique) — reste une dette ouverte.

## 4ter. Re-sync bloqué — VERDICT (2026-07-02, après HITL)

Le re-sync manuel de d23196 **n'a rien écrit** (base gelée à 40 / avril, `last_synced_at`
inchangé à 06:06, aucun `omnifi_sync_completed`). Cause **prouvée** : le POST
`declencherSync` a répondu **HTTP 429 `RATE_LIMIT_EXCEEDED`** (« available in 278 seconds »)
— throttle Omni-FI « 1 sync / 15 min ». Faits recoupés : connexion
`a4f78951-…-d23196`, `client_user_id` `tygr-prod-omnicane`, statut DB `active`,
`next_sync_available_at` NULL, latest-job COMPLETED, `ConsentStatus` vide (**pas** de
reconsentement requis). Le −122 reste de la **staleness** (§4bis) ; ce blocage-ci est
**orthogonal** : c'est la remédiation qui échoue, pas la cause.

Mécanique du blocage dans `orchestration.ts` (`declencherEtAttendre`) — **précisée à la
relecture du code réel** (le résumé « la 429 throw » était imprécis) : une **vraie 429**
était déjà rattrapée en douceur (branche `estRateLimit` → `RATE_LIMITED`, pas de throw).
Le vrai défaut : l'amont a renvoyé le throttle sous forme de **400 générique** (`obieCode`
« 400 BadRequest ») dont l'enveloppe OBIE portait pourtant `details[].errorCode =
RATE_LIMIT_EXCEEDED`. Ce 400 **échouait** `estSyncDejaEnCours` (qui ne matche que
`obieCode`) → `throw` final → échec dur → `synchroniserCompte`/`marquerSynchronise`
**jamais atteints** → connexion abandonnée, `last_synced_at` gelé.

**Action HITL immédiate (0 code) :** attendre la **fin du cooldown** (~5 min après la
DERNIÈRE tentative, **sans re-cliquer** entre-temps — chaque clic re-arme le throttle),
puis déclencher le sync de d23196 **UNE seule fois** via l'UI. Attendu : job COMPLETED →
base 40 → 162 (161 actives / 1 `is_removed`), `omnifi_sync_completed` avec `created ≈ 122`.

**Correctif LIVRÉ — branche `fix/omnifi-sync-throttle-handling`** (coupée de `main` d70e719,
`typecheck` vert 0 erreur ; suite vitest **à lancer par toi** — sandbox sans binding
`@rolldown`). Champs vérifiés sur `erreurs.ts` : `status`, `obieCode` (générique, **non
fiable**), `details[].errorCode` (code machine, fiable), `retryAfterSeconds` (429 seulement).
Contenu :
- (a) nouveau `estThrottleAmont(erreur)` : throttle reconnu si `estRateLimit` **OU**
  `details.some(d => d.errorCode === "RATE_LIMIT_EXCEEDED")` → couvre le 429 ET la 400
  générique. La branche catch route vers `RATE_LIMITED` (soft, lecture du cache), jamais
  en échec dur.
- (b) `nextSyncApresRetryAfter(retryAfterSeconds)` : sur 429, `nextSyncAt` déduit du
  retry-after ; fallback `nextSyncDepuisLatest` sinon (cas 400, où retry-after est absent).
- (c) `detailErreurSure` expose en plus `errorCodes` (codes machine OBIE, non-PII) dans
  `echecsDetail` + le log `omnifi_sync_connexion_echec` — l'opaque « 400 BadRequest » ne
  serait plus le seul signal.
- `declencherEtAttendre` **exporté** pour testabilité ; test de régression
  `tests/unit/omnifi-sync-throttle.test.ts` (4 cas : 400-throttle→RATE_LIMITED,
  429+retry-after, cooldown amont, **400 hors-throttle reste un throw dur** = garde-fou).

**QA visuelle après merge :** `/dashboard` bouton « Synchroniser mes comptes » sur une
connexion en cooldown → message « à jour » (RATE_LIMITED), plus d'« échec ». **Ordre de
merge** : indépendante des 3 branches en §1 ; peut passer avant ou après.

## 4quater. CORRECTION MAJEURE (2026-07-02, recon read-only agent) — supersède 4bis/4ter/§3-fb1428

Une reconnaissance read-only (agent, accès prod) **invalide la prémisse « fb1428 =
fantôme à supprimer »** et déplace la cause racine. À lire avant 4bis/4ter.

**Faits établis (0 écriture) :**
- **fb1428** : `omnifi_connection_id` 301459e9-…fb1428 → `bank_connection_id` bcab8634-…915e7d.
  **77 comptes MCB, UUID valides, soldés, `last_synced_at` posé (sync_max 06:07), 0 tx**,
  0 solde EOD, 0 entité, 0 split. Créée 05:27. ⟹ **pas** un fantôme mort : de vrais comptes
  découverts+synchronisés qui n'ont juste remonté aucune transaction.
- **d23196** : omnifi a4f78951-…d23196 → `bank_connection_id` 523e6e45-…ff4987. 4 comptes MCB,
  **66 tx** (dont badc5f0b6337 = 40). Créée 06:01. ⟹ a **déjà** été ingérée avec succès.
- Total 77+4 = 81 (colle au « 81 comptes connectés »).

**Cause racine réelle = 403 sur l'EndUser prod.** Sonde API directe (read-only) :
`GET /connections?client_user_id=tygr-prod-omnicane` → **403 FORBIDDEN** ;
`…=tygr-demo-omnicane` → **200 OK**. ⟹ les clés ApiKey sont bonnes ; c'est l'EndUser
**tygr-prod-omnicane** (workspace « Omni-FI HQ ») qui n'a aucun droit amont. Aucun sync ne
peut aboutir pour ce workspace tant que ce 403 tient. Scénario connu « recréer l'EndUser si
nouvelles clés ». **Supprimer fb1428 ne débloquerait rien** (fb1428 ET d23196 partagent le
même EndUser 403) → **suppression ANNULÉE**.

**Ce que ça requalifie :**
- Le **400 en boucle** de §4ter n'était pas « connexion morte » : c'est le **rate-limit**
  (RATE_LIMIT_EXCEEDED en 400 générique) — le fix `fix/omnifi-sync-throttle-handling` le gère
  déjà en soft (test `omnifi-sync-throttle` 4/4 vert). Le fix reste **valide et utile**, mais
  ce n'était pas LE blocage. Le vieux `.next/dev/logs` est **antérieur au fix** → il ne
  reflète plus le comportement du code (d'où mon erreur de lecture).
- Le champ `errorCodes:["BAD_REQUEST"]` que j'avais lu comme décisif est l'**obieCode
  générique**, pas le vrai code machine (`Errors[].ErrorCode`) — trompeur.

**⚠ CONTRADICTION À TRANCHER avant de refaire confiance au verdict staleness (4bis) :**
le dry-run avait rapporté **162/162** en lisant `/accounts/…/transactions` pour l'EndUser
prod — or ce même EndUser est **403** aujourd'hui, et la base n'a que **66 tx** (pas 162).
Trois possibilités : (a) le dry-run tournait en réalité sur l'EndUser **démo** (200), pas prod ;
(b) le 403 est **postérieur** au dry-run (accès perdu depuis) ; (c) le 162 était mal attribué.
Le plan « re-sync 40→162 » ne vaut **rien** tant que ce point n'est pas élucidé. **NE PAS**
relancer de re-sync HITL sur cette base.

**Prochaine étape (en cours, agent, read-only) : investiguer le 403 EndUser** — jamais créé /
créé sous d'autres clés vs désactivé côté Omni-FI ; comment le recréer et avec quels
clés/RedirectOrigin. Aucun POST /sync, aucune suppression.

## 4nonies. 🎯 VERDICT FINAL — deux états AMONT distincts, aucun bug TYGR de persistance/timeout (2026-07-02 13:07 UTC, probe read-only prod)

`GET /sync/{id}/latest-job` sous secret prod, lecture seule. **Corrige l'hypothèse « timeout »
de 4octies (fausse).**

| | d23196 | fb1428 |
|---|---|---|
| Status | **FAILED** | **RETRIEVING** (bloqué) |
| StartedAt → FinishedAt | 12:59:55 → 13:01:52 (~1min57) | 05:18:26 → null (**~8 h**, jamais fini) |
| Attempts / MfaType | 1 / null | 1 / null |
| Cause | **Error.Type = LOGIN_FAILED** | Error null (job zombie) |

**d23196 — pas un timeout, pas un bug de persistance.** Le job a FINI en FAILED dans la fenêtre,
cause = **LOGIN_FAILED** (identifiants MCB refusés, sans MFA). Le code a fait FAILED →
SKIP_FAILED → continue **silencieux** ⟹ 0 ligne persistée ET 0 log d'échec dur (= exactement ce
qu'on observe). La durée 2,2 min de l'action = l'attente de ce job jusqu'à son FAILED.
**Correctif = REPAIR MCB (re-auth via widget), PAS du code de poll.** Les 66 tx du dashboard
sont le dernier snapshot bon (job précédent OK ce matin).

**fb1428 — job RETRIEVING zombie ~8 h.** Le 400 `BAD_REQUEST` à chaque POST = « job déjà en
cours ». `estSyncDejaEnCours` ne matche que l'obieCode texte → tombe en échec dur. Soft-classify
(piste 1) = valide mais **cosmétique** : ne débloque pas fb1428 tant que MCB n'expire/relance pas
ce job. 8 h = anormal → **escalade Omni-FI** ; aucune re-connexion possible tant qu'un job tourne.

**⚠ VRAI GAP PRODUIT (au-delà des 2 pistes de l'agent) :** un **LOGIN_FAILED via SKIP_FAILED est
avalé silencieusement** — l'utilisateur ne voit AUCUN signal que MCB a refusé le login. C'est
précisément pourquoi « ça ne marche pas et je ne comprends pas pourquoi ». La Task #2 (« fail-soft
403 → état *reconnecte cette banque* ») existe déjà : **il faut vérifier que le chemin
LOGIN_FAILED/SKIP_FAILED remonte bien vers cet état UI**, sinon le corriger. C'est LE correctif
qui change l'expérience (surface « reconnecte MCB » au lieu du silence).

**Actions (aucune entreprise sans feu vert Etienne) :**
1. **Immédiat** : REPAIR d23196 via widget (re-saisie identifiants MCB) — LOGIN_FAILED concret.
2. **fb1428** : escalade Omni-FI (job zombie 8 h) ; re-sonder latest-job plus tard (1 GET).
3. **Code/UX** : (a) surfacer LOGIN_FAILED → « reconnecte cette banque » (le vrai fix) ; (b) dette
   robustesse : soft-classify du 400 « déjà en cours » (piste 1, cosmétique).

## 4octies. ✅ CLÉ PROD CONFIRMÉE AU RUNTIME — le vrai bug est le COMPORTEMENT du sync (2026-07-02, terminal live)

`npm run start:prod` — bannière : `env: .env.prod`, `OMNIFI_ENV: production`, `secret: prod_`.
**Le runtime tourne bien sous la clé prod** (le 400 `BAD_REQUEST` observé n'est ni 403 ni
CONNECTION_NOT_FOUND → confirme que l'ApiClient est le bon ; sinon on aurait 403/404). Note :
Next affiche « Environments: .env » mais les vars prod sont **exportées avant `next dev`** par
`dev-server.sh` et gagnent (dotenv n'écrase pas un `process.env` déjà posé) — cohérent avec le
400 obtenu.

**Symptôme = le sync n'aboutit jamais à un COMPLETED qui persiste.** Terminal live :
- `omnifi_sync_connexion_echec` **fb1428** : status **400**, obieCode `400 BadRequest`,
  errorCodes `["BAD_REQUEST"]` → **échec DUR**. Or fb1428 est **RETRIEVING** amont (job déjà en
  cours) ⟹ ce 400 générique = « sync déjà en cours », mal classé en dur. `estSyncDejaEnCours`
  ne teste que l'`obieCode` texte (« already running/in progress/running ») → ne matche pas ce
  cas. **Angle mort identique au rate-limit d'avant le fix #166.**
- `synchroniserConnexionsAction()` **129 621 ms (2,2 min)**, **aucune ligne d23196** (ni
  completed ni echec). 2,2 min ≈ plafond **TIMEOUT poll ~120 s** (+ échec fb1428). ⟹ d23196
  déclenche un job, poll jusqu'au timeout **sans voir COMPLETED**, abandonne → **rien persisté**
  → dashboard figé « il y a 6 h ». (À confirmer : le job d23196 finit-il APRÈS l'abandon ? →
  timeout trop court ; ou reste-t-il bloqué PENDING/RETRIEVING ?)

**Deux pistes de correctif (à valider par un probe avant de coder) :**
1. **Classer le 400 « déjà en cours » en soft** (comme le rate-limit) : étendre
   `estSyncDejaEnCours`/le catch pour reconnaître un job déjà RETRIEVING (via latest-job) au lieu
   de throw. Évite l'échec dur de fb1428 quand un job tourne déjà.
2. **Timeout de poll** : si le job d23196 aboutit juste après 120 s, soit relever le plafond,
   soit ne PAS abandonner sans persister — relire latest-job au prochain Sync et ingérer un job
   COMPLETED déjà prêt plutôt que d'en redéclencher un.

**Probe read-only à lancer (sous `.env.prod`) :** `GET /sync/{id}/latest-job` pour d23196 ET
fb1428 MAINTENANT (statut + JobId + timestamps) → distingue « timeout trop court » de « job
réellement bloqué ». Aucun POST /sync.

## 4septies. ✅ CONFIRMÉ EN LECTURE SOUS CLÉ PROD — rien n'était cassé amont (2026-07-02, agent)

Sonde re-lancée sous le secret **prod** (`.env.prod`, préfixe `prod_`, hash vérifié avant
appel, jamais affiché). **Confirme 4sexies, clôt 4quater + 4quinquies (caducs).**

- `GET /connections?client_user_id=tygr-prod-omnicane` (secret prod) → **HTTP 200,
  TotalRecords = 7**. Les 2 MCB attendues sont **active** : a4f78951-…d23196 ✅ et
  301459e9-…fb1428 ✅. **+ 5 connexions non ingérées en base locale** : 3 Absa
  (daacd7fb / 146ecfa4 / bfd4b02b), 2 Bank One (e4e6a313 / c5662b92).
- `GET /sync/{id}/latest-job` (secret prod) → d23196 **COMPLETED**, `NextSyncAvailableAt: null` ;
  fb1428 **RETRIEVING**, `NextSyncAvailableAt: null` (job vivant côté amont, aucun cooldown).

**⟹ Aucun fantôme, aucun 403 amont, aucune orpheline.** Le « 403 » venait d'une sonde sous
`sand_` (`.env`) au lieu de `prod_` (`.env.prod`). Résidu : un EndUser `tygr-prod-omnicane`
**vide/parasite côté ApiClient sandbox** (créé par le POST 201 précédent) — inoffensif, à
nettoyer un jour côté Omni-FI, aucune action prévue.

**➡️ NOUVELLE PISTE POUR LE SYMPTÔME RÉEL (dashboard qui ne sync pas).** Puisque les connexions
sont saines sous `prod_`, le seul moyen que le bouton « Sync » échoue est que **le process de
l'app tourne sous la MAUVAISE clé** — même piège que la sonde. Indice fort : les logs d'échec
lus précédemment étaient dans **`.next/dev/logs/`** ⟹ l'app tournait en **`next dev`** =
`npm run dev` = **`.env` (secret `sand_`)**, pas `npm run start:prod` = `.env.prod` (`prod_`).
Une app en dev/sandbox appelant Omni-FI pour l'EndUser prod ⟹ 403/échecs exactement comme la
sonde. **À vérifier : relancer l'app avec `npm run start:prod` puis retester Sync.** (Le
throttle fix reste valide et orthogonal.)

## 4sexies. ⚠ LE 403 ÉTAIT UN FAUX POSITIF — mauvaise clé de test (2026-07-02, revue config)

**Invalide très probablement 4quater ET 4quinquies.** En comparant `.env` vs `.env.prod` :
- `OMNIFI_CLIENT_ID` **identique**, mais `OMNIFI_SECRET` **DIFFÉRENT** entre les deux fichiers.
- Les DEUX sont `OMNIFI_ENV="sandbox"` sur le même hôte partagé `api-stage.omni-fi.co`. Or
  `config.ts` (l.64-65) + `dev-server.sh` disent que **seule la CLÉ (`OMNIFI_SECRET`) distingue
  prod de démo** sur cet hôte partagé. Donc : secret `.env` = ApiClient qui possède
  `tygr-demo-omnicane` ; secret `.env.prod` = ApiClient qui possède `tygr-prod-omnicane` (+ les
  2 connexions MCB).
- `dev-server.sh` : `start:prod` → `ENV_FILE=.env.prod` ; défaut/sandbox → `.env`.

**Le résultat de l'agent (`demo→200`, `prod→403`) n'est possible QU'AVEC le secret `.env`
(sandbox).** Avec le secret `.env.prod`, `tygr-prod-omnicane` aurait renvoyé **200** (c'est son
propre EndUser). ⟹ La sonde read-only de l'agent a chargé `.env` (défaut dotenv), pas
`.env.prod`. Le **403 = « cet EndUser n'est pas à cet ApiClient »**, PAS « n'existe pas ». Le
`POST → 201` a créé un `tygr-prod-omnicane` **vide et parasite dans le namespace sandbox**
(ApiClient `.env`), sans jamais toucher au vrai EndUser prod (ApiClient `.env.prod`).

**Conséquence :** il n'y a probablement **aucun décrochage** ni connexion orpheline. Les 2
connexions MCB (81 comptes, 66 tx) sont vraisemblablement **intactes** sous `.env.prod`. Tout
4quinquies (« EndUser jamais créé », « re-onboarding nécessaire ») repose sur une sonde
authentifiée avec la MAUVAISE clé.

**TEST QUI TRANCHE (read-only, à lancer sous `.env.prod`) :** relancer la MÊME sonde
`GET /connections?client_user_id=tygr-prod-omnicane` mais en chargeant `.env.prod` (secret
prod) au lieu de `.env`.
- **200 + 2 connexions MCB** ⟹ rien n'était cassé ; le « diagnostic 403/orphelines » est un
  artefact de test-sous-mauvaise-clé. Le sync devrait marcher normalement via `npm run
  start:prod`. Reste juste un EndUser parasite vide côté sandbox (hygiène, non urgent).
- **403 à nouveau** ⟹ là seulement le secret prod manque vraiment de droits → escalade Omni-FI.

**Dette annexe confirmée quand même :** TYGR n'appelle jamais `POST /clients/end-users` à la
création d'un workspace (voir 4quinquies) — indépendant de ce faux positif.

## 4quinquies. DÉNOUEMENT 403 (2026-07-02 ~12:42Z, agent, 1 seule écriture amont validée) — ⚠ VOIR 4sexies : sonde faite sous la MAUVAISE clé (.env sandbox), diagnostic ci-dessous probablement caduc

Le 403 est **levé**, mais la réparation a révélé un **décrochage TYGR ↔ Omni-FI** plus profond,
et **tranche la contradiction de 4quater**.

**Action (feu vert Etienne) :** `POST /clients/end-users { "ClientUserId": "tygr-prod-omnicane" }`
sous les clés `.env` courantes. Aucune suppression, aucun POST /sync.

| Avant | Action | Après |
|---|---|---|
| `GET /connections` → 403 | `POST /clients/end-users` → **201** (`CreatedAt` = 12:42:33Z, maintenant) | `GET /connections` → **200** |

**Le 201 (et non 409) est décisif :** l'EndUser `tygr-prod-omnicane` **n'existait pas** côté
Omni-FI sous ces clés — il vient d'être créé. Confirmations en lecture :
- `GET /connections` → 200 mais **`Connections: []`, `TotalRecords: 0`** (EndUser vide).
- `GET /sync/{connId}/latest-job` sur bcab8634-…915e7d **et** 523e6e45-…ff4987 → **404
  CONNECTION_NOT_FOUND** pour les deux.

**Diagnostic final (invalide l'« asymétrie d'auth » avancée en cours de route) :**
l'onboarding widget de ce matin a écrit le **workspace + 81 comptes + 66 tx dans la base TYGR
locale uniquement**. Côté Omni-FI, les 2 connexions MCB sont **orphelines** — rattachées à un
autre ApiClient/EndUser (autres clés, ou LinkToken émis sous une autre config), **pas** au
`tygr-prod-omnicane` que l'agent vient de créer vide. C'est la **version forte de H1**.

**Ça tranche la contradiction 4quater :** le dry-run « 162 » lisait forcément un **autre
contexte d'auth** que les clés `.env` actuelles (démo, ou anciennes clés) — cohérent avec des
connexions orphelines. Le plan « re-sync 40→162 » reste **caduc**.

**Conséquences :**
- ✅ Symptôme 403 réparé (B2B répond pour cet EndUser).
- ❌ Le sync **ne repart pas** : EndUser vide amont ; un POST /sync sur les ConnectionId de la
  base renverrait CONNECTION_NOT_FOUND. Les lignes locales pointent vers du vide amont.
- 🔁 Vraie synchro ⟹ **re-onboarder les 2 banques MCB via le widget** (nouvelles connexions
  rattachées à `tygr-prod-omnicane`). Données locales actuelles → périmées, **purge à décider
  APRÈS** un re-onboarding réussi, pas avant.

**⚠ QUESTION À TRANCHER AVANT TOUT RE-ONBOARDING :** puisque le 201 prouve que l'EndUser
n'existait pas sous les clés `.env` courantes, **ces clés sont-elles bien l'ApiClient prod
voulu ?** Deux cas : (a) les clés `.env` ont **changé** depuis ce matin → il faudrait peut-être
**restaurer les anciennes clés** (qui « voient » les 2 connexions existantes) plutôt que tout
re-onboarder ; (b) le widget de ce matin a utilisé un LinkToken d'un **autre** ApiClient. Ne
pas re-onboarder sous des clés potentiellement fausses — vérifier d'abord l'identité de
l'ApiClient `.env`.

**Cause structurelle (dette) :** rien dans TYGR n'appelle `POST /clients/end-users` à la
création d'un workspace (noté « semaines 3-5 » dans `seed-admin.mjs`, jamais câblé) → un
workspace peut exister avec un `omnifi_client_user_id` que l'amont ne connaît pas. Fix =
enregistrer l'EndUser à la création du workspace (Server Action + migration éventuelle → plan +
PR + validation).

## 5. Reliquats d'environnement (pour mémoire)

- Sandbox agent : pas d'accès réseau git/npm, pas d'exécution du runner de tests
  (binding `@rolldown` manquant). Les agents écrivent le code + les tests ; **toi**
  tu lances la suite complète sur ta machine (darwin-arm64).
- 3 fichiers untracked avaient contaminé le typecheck → résolus via `git stash -u`
  puis `stash drop` après vérification byte-à-byte. `main` propre.
