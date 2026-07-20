# PLAN — Loader de synchro à étapes + clarté du cycle de vie d'une connexion

**Phase :** Conception / cadrage (règle 1) — **LECTURE SEULE, aucun code applicatif.**
**Date :** 2026-07-20 · **Auteur :** clawdy (conception)
**Déclencheur :** demande utilisateur — « messages plus clairs sur quelle banque n'est pas
connectée ; à la connexion, indiquer qu'il faut synchroniser ; ajouter un loader » +
retour de l'agent lecture-seule du repo API (mécanique job + polling `GET /sync/job/{JobId}`).
**Objet :** poser le design des DEUX améliorations réellement neuves (loader à étapes, nudge
post-connexion) et raccorder la 3ᵉ (statut nommé par banque) au plan déjà écrit.
**Ne tranche pas l'implémentation** : faits, challenge, recommandation, triage démo. L'humain arbitre.

---

## 0. TL;DR

> La demande = **un seul chantier** : le *cycle de vie d'une connexion* — *connecter →
> « il faut synchroniser » → sync en cours (loader) → statut par banque*. Elle se découpe
> en trois lots dont **deux seulement sont neufs** :
>
> 1. **Statut nommé par banque** → **DÉJÀ CADRÉ** dans `PLAN-sync-granularite-par-banque.md`
>    (cartes par connexion + pastille de fraîcheur + cooldown sur `/banques`). Ne PAS
>    re-planifier : séquencer ce plan-là. Le seul ajout ici : nommer la banque dans l'UI
>    est légitime (non-énumération = protection *cross-tenant*, pas *intra-workspace*).
>
> 2. **Nudge post-connexion** (« Banque connectée — lancez une première synchronisation »)
>    → **NEUF**, bon marché, surtout présentationnel. Démo-safe.
>
> 3. **Loader à étapes** mappé sur `Status` → **NEUF et coûteux** : le sync du dashboard est
>    aujourd'hui **serveur-synchrone** (le client attend tout le lot, ne voit qu'un
>    spinner binaire). Un loader à étapes exige de rendre la **progression du job visible
>    côté client** — un vrai changement de contrat. **Post-démo** (ou version dégradée
>    honnête pour la démo).
>
> Contrainte cardinale (confirmée code + agent API) : **pas de %**, seulement des
> transitions de statut. Un loader à paliers, jamais une fausse barre de progression.

---

## 1. État actuel — ce que fait TYGR aujourd'hui (faits, code lu 2026-07-20)

### 1.1 Le sync du dashboard est SERVEUR-SYNCHRONE

`SyncButton` (`src/components/dashboard/sync-button.tsx`) → `useSynchro().synchroniser`
(`src/components/sync/sync-contexte.tsx`) → Server Action `synchroniserConnexionsAction()`
(`banques/actions.ts`) → `synchroniserConnexionsDepuisOmnifi` (`orchestration.ts:1026`).

Le client **await tout le lot** : pour chaque connexion le SERVEUR déclenche le sync ET
**poll le job jusqu'à COMPLETED** (`attendreFinSync`, orchestration.ts:594), ingère, puis
renvoie un `EtatFinalisation` récapitulatif. Le client ne voit donc que deux états :
`enCours` (spinner « Synchronisation… ») puis le compte rendu. **Aucune progression
intermédiaire ne franchit la frontière serveur.**

### 1.2 La machine de statuts complète existe DÉJÀ — mais pour le widget Link, pas le dashboard

`src/components/widget/machine-mfa.ts` modélise **tout** le cycle
(`PENDING→…→RETRIEVING→PARSING→ENRICHING→COMPLETED|FAILED`) et le mappe en phases UI
(`initialisation | mfa_requis | mfa_validation | synchronisation | termine | echec`).
`useOmniFiWidget` (`use-omnifi-widget.ts`) la pilote par polling client (2 s, plafond
`MAX_POLLS=300`, arrêt propre en état terminal). **Mais ce circuit ne sert que le widget de
connexion/MFA** — le bouton « Synchroniser » du dashboard ne l'emprunte pas.

### 1.3 Les endpoints amont sont déjà tous câblés dans le client

`src/server/omnifi/client.ts` expose `declencherSync` (POST /sync/{ConnectionId}),
`getLatestSyncJob`, `getSyncJob` (SessionToken), `getSyncJobServeur` (ApiKey — GET
/sync/job/{JobId}), `getSyncJobAccounts`. Le serveur lit déjà `PersistenceStats`
(orchestration.ts:564, 619) — la forme **imbriquée réelle** est donc déjà gérée côté TYGR.

### 1.4 Les désyncs sont déjà remontées (registre `info`)

`PLAN-sync-spinner-sans-resultat.md` (livré) : `EtatFinalisation.info` + compteurs
`nonRattachees`/`inutilisables` disent déjà « X banques connectées non rattachées »,
« banques qui ne répondent plus ». C'est le bandeau ambre que tu vois. **Ce qui manque
n'est pas le signal, c'est le NOM de la banque et l'action par ligne** — cf. lot 1.

---

## 2. Contraintes amont (agent API 2026-07-20, recoupées avec le code)

| Fait amont | Conséquence design |
|---|---|
| `POST /sync/{ConnectionId}` → `201` + `JobId`, puis poll `GET /sync/job/{JobId}` jusqu'à statut terminal | Loader piloté par les **transitions de statut**, pas un compteur |
| Statuts : `PENDING→STARTED→LOGGING_IN→[OTP_*]→RETRIEVING→PARSING→ENRICHING→COMPLETED` ; terminaux `COMPLETED / FAILED / INTERRUPTED` | Mapper en **3 paliers lisibles** : « Connexion… » / « Récupération… » / « Traitement… » |
| **Aucun compteur incrémental** (« 45/200 »). Total seulement à la fin dans `PersistenceStats.Transactions.Inserted` (null tant que ≠ COMPLETED) | **Interdit** de simuler un %. Le total ne s'affiche qu'à COMPLETED |
| `INTERRUPTED` **absent de l'enum OpenAPI** mais émis par le backend | ⚠️ **Trou réel** : `machine-mfa.ts` ne mappe PAS `INTERRUPTED` → il retombe sur `initialisation`, `pollingActif` reste vrai → le loader tournerait jusqu'à `MAX_POLLS`. À corriger si on réutilise la machine (cf. §4.2) |
| `POST /sync` throttlé : **1 sync / 15 min / connexion**, `400` si un job tourne déjà ; `NextSyncAvailableAt` dit quand c'est de nouveau permis | Bouton désactivé pendant le job + libellé « prochaine synchro possible dans X ». Déjà collecté (`rateLimited[]` dans `EtatFinalisation`) |
| `PersistenceStats` **imbriqué** (`.Transactions.Inserted`), ≠ spec plat | Déjà géré côté serveur (§1.3). **À VÉRIFIER** que le type `OmniFiSyncJob["PersistenceStats"]` colle bien à la forme imbriquée — sinon 1 ligne de correctif |
| `GET /accounts/{AccountId}/transactions/sync` = **route fantôme (404)** | Ne jamais l'utiliser. Déjà acté dans `PLAN-sync-granularite-par-banque.md` §2 |
| Webhooks `sync.completed/failed` sans compteur ; événements intermédiaires `sync.retrieving_*` **sans émetteur** | Un loader basé sur les webhooks intermédiaires **n'avancerait jamais** → rester sur le polling |

**Ticket backend suggéré par l'agent API** (2 incohérences spec/code : `PersistenceStats`
imbriqué, endpoint fantôme `transactions/sync`) : utile pour fiabiliser un SDK généré, mais
**TYGR écrit son client à la main** → non bloquant pour nous. À consigner en dette externe
(`OMNIFI-SPEC-DRIFT1`, P2) si on veut le tracer, sans en dépendre.

---

## 3. Challenge (règle 10 — Staff Engineer)

1. **Le loader à étapes n'est pas « ajouter un spinner » : c'est re-découper le contrat de
   sync.** Aujourd'hui le serveur avale toute la progression. Pour un vrai loader il faut
   soit (A) que l'action rende les `JobId` **immédiatement** puis que le client poll par
   connexion, soit (B) garder le serveur-synchrone et assumer un loader **indéterminé
   honnête**. (A) touche une surface sensible (le sync est le cœur de l'ingestion).
   **Mode de défaillance à éviter** : un faux stepper qui déroule « Récupération… →
   Traitement… » sur un timer sans lien avec le vrai statut — il ment, et il ment
   précisément quand le job traîne ou échoue (le moment où l'utilisateur regarde le plus).

2. **Ne pas dupliquer le polling.** `machine-mfa.ts` + `useOmniFiWidget` savent déjà lire
   le cycle complet. Recoder un 2ᵉ poller pour le dashboard = deux vérités divergentes sur
   les mêmes statuts (le projet a explicitement une union OUVERTE pour absorber la dérive
   `SCRAPING`/`RETRIEVING` ; la refaire ailleurs, c'est ré-oublier ce piège). **Réutiliser,
   pas cloner** — en extrayant la partie « lifecycle » de la machine hors du MFA si besoin.

3. **Le trou `INTERRUPTED` est réel et silencieux.** Un job interrompu resterait affiché
   « Initialisation… » à l'infini côté loader. Ça n'a pas de conséquence sécurité (la
   vérité reste serveur) mais c'est exactement la frustration qu'on veut supprimer.

4. **La demande « quelle banque » est à 80 % déjà résolue** (`info` + plan granularité).
   Le risque ici est de **re-planifier** au lieu de séquencer l'existant. Le vrai delta
   utile : nommer la banque (légitime intra-workspace) et donner l'action par ligne.

**Verdict :** demande saine. Reformulée : **(lot 1) séquencer le plan granularité + nommer
la banque ; (lot 2) nudge post-connexion ; (lot 3) loader à étapes en réutilisant la
machine existante — post-démo, avec version dégradée honnête pour la démo.**

---

## 4. Design proposé (à valider — NON implémenté)

### Lot 1 — Statut nommé par banque *(raccord, pas de nouveau plan)*

- **Séquencer `PLAN-sync-granularite-par-banque.md`** (SYNC-GRANULARITE-BANQUE1) : cartes
  par connexion sur `/banques`, chacune avec sa pastille de fraîcheur (`BalanceFreshnessPill`),
  son bouton sync scopé (`resynchroniserConnexion` **existe déjà**) et son cooldown.
- **Ajout de ce plan** : afficher le **nom de la banque** dans ces cartes et dans les
  callouts de désync. La règle de non-énumération protège le *cross-tenant* ; nommer *tes*
  banques dans *ton* workspace est voulu. Le libellé bancaire reste hors **logs/erreurs**
  (règle 8) mais peut vivre dans l'UI authentifiée scopée.
- **Pré-requis bloquant hérité** : instruire l'anomalie du watermark cooldown (Absa,
  `SYNC-COOLDOWN-WATERMARK1`) avant d'afficher un compte-à-rebours — sinon l'UI ment.

### Lot 2 — Nudge post-connexion *(neuf, démo-safe)*

- À la fermeture réussie du widget, l'état « banque tout juste connectée » affiche une
  invite explicite : **« Banque connectée — lancez une première synchronisation pour
  importer vos transactions »** + CTA « Synchroniser ». Réutiliser la primitive `Callout`
  (`src/components/ui/states/callout.tsx`, livrée) — registre `info` (ni vert ni rouge).
- Donnée déjà disponible : `EtatFinalisation` distingue connexion établie vs synchro
  effectuée. Pas de nouvel appel amont.
- Exit criteria (règle 3) : composant d'affichage **pur** (zéro fetch), tokens sémantiques
  uniquement, 4 états couverts, capture Visual QA (Gate 4) sur la route démo.

### Lot 3 — Loader à étapes *(neuf, coûteux — post-démo)*

**Option A — vrai loader (recommandée pour la cible) :**
- `synchroniserConnexionsAction` renvoie les `{connectionId, jobId}` **dès le 201**, sans
  attendre `attendreFinSync`. Le client poll par connexion via `getSyncJob` (Server Action
  runtime, comme le widget) et dérive le palier via la **phase** de `machine-mfa.ts`
  (`synchronisation` couvre déjà RETRIEVING/PARSING/ENRICHING).
- **Corriger le trou `INTERRUPTED`** : l'ajouter à `OmniFiSyncStatusConnu` (types.ts) et le
  mapper en phase `echec` dans `PHASE_PAR_STATUT` ; garder le repli « statut inconnu →
  initialisation » pour la dérive amont, mais un terminal connu doit couper le polling.
- Loader à **3 paliers** (« Connexion… / Récupération… / Traitement… »), total affiché à
  COMPLETED depuis `PersistenceStats.Transactions.Inserted`, gestion OTP inline (rouvre le
  parcours MFA existant), bouton désarmé + `NextSyncAvailableAt` sur `400`/cooldown.
- Coût : moyen-élevé (change le contrat de l'action + réconciliation du récap final). Touche
  le cœur du sync → cross-review indépendante obligatoire (règle 6), suite isolation à
  étendre (règle 3).

**Option B — dégradé honnête (fallback démo) :**
- Garder le serveur-synchrone. Loader **indéterminé** + copie honnête : « Synchronisation en
  cours — cela peut prendre jusqu'à une minute. » **Pas** de faux paliers minutés. Le bouton
  reste désactivé pendant le vol (déjà le cas). ~2 h, zéro risque.

### Ce que le design N'inclut PAS (anti-scope-creep)

- Pas de refresh **par compte** (impossible amont — acté dans le plan granularité).
- Pas d'auto-sync périodique (chantier distinct).
- Pas de barre de progression en % (l'amont ne le permet pas).
- Pas de refonte de l'ingestion.

---

## 5. Triage démo (J-2) vs post-démo

| Lot | Coût | Démo (22/07) | Post-démo |
|---|---|---|---|
| 2 · Nudge post-connexion | Faible | ✅ faisable | — |
| 1 · Nom de banque dans callouts existants | Faible | ✅ faisable (sans le compte-à-rebours cooldown) | Cartes par banque complètes |
| 1 · Cartes sync par banque + cooldown | Moyen | ❌ (dépend de SYNC-COOLDOWN-WATERMARK1) | ✅ |
| 3 · Loader Option B (dégradé honnête) | Faible | ✅ si tu veux mieux que le spinner actuel | — |
| 3 · Loader Option A (vrai stepper) | Moyen-élevé | ❌ trop lourd à J-2 | ✅ cible |

**Recommandation démo :** lots 2 + « nom de banque » + loader Option B. Ça supprime
l'essentiel de la frustration (on sait quelle banque, on sait qu'il faut sync, le loader ne
ment plus) sans toucher le cœur du sync à 2 jours de l'échéance.
**Recommandation cible (post-démo) :** loader Option A + cartes par banque, après
l'anomalie cooldown.

---

## 6. Critères de sortie (règle 3) — pour chaque lot livré ultérieurement

- Authz via `withWorkspace` ; ressource d'un autre tenant → 404. Gating `peutModifier`
  côté UI (confort) + garde serveur réelle (barrière).
- Validation zod stricte des entrées (Option A : `jobId`/`connectionId` bornés).
- Erreurs nommées → messages non-énumérants (registre S2). `INTERRUPTED` traité, jamais un
  faux `termine`.
- Composants d'affichage purs, tokens sémantiques, 4 états, capture Visual QA (Gate 4).
- Tests : chemin heureux + échec (`FAILED`/`INTERRUPTED`) + limite (job bloqué → plafond de
  polling). Machine réutilisée = tests étendus, pas dupliqués.
- Logs structurés corrélés (`workspace_id`, `connection_id`) **sans PII** (jamais le libellé
  bancaire dans les logs, même s'il est affiché dans l'UI).

---

## 7. Dettes / TODOS à consigner

- `SYNC-COOLDOWN-WATERMARK1` (P1, pré-requis lot 1 complet) — instruire le watermark cooldown.
- `OMNIFI-SPEC-DRIFT1` (P2, externe) — 2 incohérences spec/code Omni-FI (PersistenceStats
  imbriqué, endpoint fantôme). Non bloquant (client écrit à la main). Ticket côté API amont.
- `SYNC-MACHINE-INTERRUPTED1` (P1, bloquant lot 3 Option A) — `INTERRUPTED` non mappé dans
  `machine-mfa.ts` : job interrompu → loader figé « Initialisation… ». À corriger avant tout
  loader qui réutilise la machine.

---

## 8. Prochaine étape

Ce fichier est la **conception** (règle 1). Aucune ligne de code applicatif tant qu'un lot
n'est pas choisi et sa branche `feature/*` ouverte depuis `main` à jour. Ordre suggéré pour
la démo : lot 2 → nom de banque → loader Option B, chacun sur sa branche, chacun revu.
