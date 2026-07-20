# PLAN — Granularité de synchronisation (par banque) · SYNC-GRANULARITE-BANQUE1

**Phase :** Cadrage / Décision d'architecture — **LECTURE SEULE, aucun code applicatif.**
**Date :** 2026-07-16 · **Auteur :** clawdy (conception, règle 1)
**Objet :** challenger la demande « permettre à l'enduser de synchroniser à la bonne
granularité (par banque, par compte) » et poser le design backend + frontend.
**Ne tranche pas l'implémentation** : liste les faits, challenge, recommande. L'humain arbitre.

---

## 0. TL;DR (la décision d'abord)

> **Aujourd'hui, un seul bouton « Synchroniser » rafraîchit TOUTES les connexions du
> workspace d'un coup.** L'hypothèse de départ est confirmée par le code.
>
> **« Par banque » est faisable et bon marché** : la primitive scopée-connexion
> `resynchroniserConnexion` **existe déjà** (elle sert la réparation MFA) ; il « suffit »
> de l'exposer hors du cas réparation + de câbler une UI par carte de banque.
>
> **« Par compte » (déclencher un refresh d'un seul compte) est IMPOSSIBLE côté Omni-FI** :
> l'unité atomique de scraping est la **Connexion** (`POST /sync/{ConnectionId}`), jamais
> le compte. Il n'existe aucun `POST /sync/account/{id}`. Ce qui EST possible « par
> compte » : (a) le drapeau `is_selected` (déjà en base) qui décide quels comptes on
> INGÈRE ; (b) la lecture curseur `GET /accounts/{AccountId}/transactions/sync` — une
> LECTURE, pas un déclenchement. Ne pas promettre à l'utilisateur un « rafraîchir ce
> compte » qui n'existe pas dans l'API amont.
>
> **Bénéfice réel du par-banque (pas cosmétique) : le cooldown.** Amont impose **1 sync /
> 15 min / connexion** (429). Le sync global tire `POST /sync` sur CHAQUE connexion → il
> **verrouille 15 min TOUTES les banques**, même si l'utilisateur ne voulait rafraîchir
> qu'Absa. Le par-banque ne consomme le cooldown que de la banque visée.

---

## 1. État actuel — ce que fait TYGR aujourd'hui (faits, code lu)

### 1.1 Un seul point d'entrée, portée « toutes les connexions »

`synchroniserConnexionsAction()` — `src/app/(workspace)/banques/actions.ts:276` — est une
Server Action **sans argument**. Elle appelle
`synchroniserConnexionsDepuisOmnifi(client, executer)`
(`src/server/widget/orchestration.ts:1026`) qui :

1. lit le `clientUserId` du workspace (frontière tenant, jamais un paramètre client) ;
2. **liste TOUTES les connexions** de cet EndUser via `GET /connections` (paginé) ;
3. **filtre** à celles déjà présentes dans `bank_connections` de CE workspace (LOT 1 —
   une banque vue amont mais absente de la base est ignorée, jamais créée par le sync) ;
4. pour **chacune** : déclenche un sync gardé par le cooldown (`declencherEtAttendre`,
   orchestration.ts:735) **puis** ingère ses transactions.

Conséquence directe : **1 clic = N syncs**, un par connexion du workspace. Il n'existe
aucune sélection de banque ni de compte au déclenchement.

### 1.2 Les deux surfaces qui appellent cette action unique

- **Dashboard** : `SyncButton` (`src/components/dashboard/sync-button.tsx`) — bouton
  « Synchroniser » dans l'en-tête, à côté de la pastille de fraîcheur. Appelle
  `synchroniserConnexionsAction()` (zéro argument).
- **/banques** : même action à la fermeture du widget (le widget a déjà persisté la
  connexion côté Omni-FI ; on relit l'état serveur car le `postMessage` du widget est
  cassé en sandbox, cf. OMNIFI_API_FEEDBACK.md §5/§6).

### 1.3 La primitive « par connexion » existe DÉJÀ — mais réservée à la réparation MFA

`resynchroniserConnexion(client, executer, connectionIdOmnifi)`
(`orchestration.ts:1557`) fait **exactement** un sync ciblé sur UNE connexion :
(a) re-découvre + persiste ses comptes, (b) `declencherEtAttendre` (cooldown-gardé),
(c) ingère les transactions des comptes `is_selected`. Idempotente, gating MANAGER/ADMIN,
**anti-IDOR** (la connexion doit appartenir au workspace scopé RLS, sinon
`ReparationContexteInvalideError`).

Elle n'est aujourd'hui câblée QUE par `resynchroniserConnexionApresReparationAction`
(`actions.ts:493`), appelée par le widget après une saisie OTP
(`bank-connect-widget.tsx:228`). **Le chemin scopé-banque existe donc en production ;
il n'est simplement pas offert comme action utilisateur « normale ».**

### 1.4 Ce que `is_selected` fait déjà (axe « par compte » existant)

`bank_accounts.is_selected` gouverne DÉJÀ quels comptes sont ingérés
(`orchestration.ts:1650` — l'ingestion filtre `isSelected = true`). C'est le seul levier
« par compte » réellement disponible : il ne rafraîchit rien de plus vite, mais il exclut
un compte du périmètre d'ingestion.

---

## 2. Contrainte amont Omni-FI (vérifiée, source : agent lecture-seule du repo widget + doc)

| Capacité souhaitée | Endpoint amont | Verdict |
|---|---|---|
| Déclencher le sync d'**une connexion** | `POST /sync/{ConnectionId}` (ApiKey) | ✅ **seule** granularité de déclenchement |
| Déclencher le sync d'**un compte** | *(n'existe pas)* | ❌ impossible — le compte n'est pas une unité de scraping |
| Déclencher **tous les comptes d'un enduser** en un appel | *(n'existe pas)* | ❌ — il faut boucler connexion par connexion (ce que fait TYGR) |
| **Lire** les transactions d'un compte (curseur) | `GET /accounts/{AccountId}/transactions/sync` | ⚠️ LECTURE type Plaid, PAS un déclenchement |
| Onboarding d'une connexion | `POST /sync/{ConnectionId}/onboarding` (SessionToken, ApiKey rejeté) | widget-only |

Invariants amont qui cadrent le design :
- **1 Connexion = 1 Institution** (ForeignKey côté amont) ; réciproquement 1 connexion =
  N comptes, **tous rafraîchis ensemble** (on ne choisit pas le sous-ensemble à scraper).
- **Cooldown : 1 sync / 15 min / connexion** → `429` + `NextSyncAvailableAt`. Plafond
  additionnel ~100 req/min/clé.
- Pas de champ « statut » fiable de connexion : les identifiants invalides ne se
  découvrent qu'au **runtime** (job `FAILED` / `LOGIN_FAILED`).
- Déclenchement → `201` + `JobId` ; suivi via `GET /sync/job/{JobId}` ou
  `GET /sync/{ConnectionId}/latest-job` ; OTP via `POST /sync/{JobId}/input`.

**Conclusion amont : la granularité maximale offerte est la CONNEXION. « Par banque »
= « par connexion » = le grain natif de l'API. « Par compte » au déclenchement n'existe
pas et ne doit pas être promis.**

---

## 3. Challenge (règle 10 — Staff Engineer)

**La demande « par banque, par compte » mélange deux granularités de nature différente.**
Il faut les séparer explicitement, sinon on livre une UI qui ment sur ce que l'API sait faire.

1. **Risque produit — promettre un refresh « par compte ».** Un bouton « rafraîchir ce
   compte » suggère que le compte est rafraîchi seul. Or l'amont rafraîchit **toute la
   connexion** (tous les comptes de la banque) ou rien. Mode de défaillance : l'utilisateur
   clique « rafraîchir compte A », voit le compte B (même banque) bouger aussi, et perd
   confiance dans la cohérence. → **Ne pas offrir de refresh par compte.** Le « par
   compte » se traite via `is_selected` (inclusion dans l'ingestion), pas via un
   déclenchement.

2. **Bénéfice réel et chiffrable du par-banque — le cooldown.** Aujourd'hui, rafraîchir
   « juste Absa » est **impossible** sans tirer `POST /sync` sur les 4 autres banques,
   qui passent alors 15 min en cooldown. Coût concret : un utilisateur qui veut vérifier
   une seule banque grille sa fenêtre de sync sur toutes les autres. Le par-banque
   supprime ce gaspillage. C'est l'argument POUR, et il est structurel, pas cosmétique.

3. **Coût faible côté implémentation.** La primitive `resynchroniserConnexion` existe,
   est testée (chemin réparation), scopée tenant et gardée par rôle. Le travail restant
   est : (a) une Server Action « normale » qui l'enveloppe (sans la sémantique réparation
   MFA), (b) une UI par carte de banque sur /banques, (c) l'affichage du cooldown
   (`NextSyncAvailableAt`). Estimation : ~1–1,5 j (backend ~0,5 j, front ~1 j).

4. **Anomalie à instruire AVANT de câbler (issue Absa du 2026-07-16).** Le diagnostic Absa
   a montré `next_sync_available_at = NULL` **alors qu'un sync avait tourné**, et un sync
   s'est déclenché **~7 min après la connexion sans déclenchement manuel**. Deux questions
   ouvertes qui touchent directement le par-banque : (a) l'onboarding auto-déclenche-t-il
   un premier sync ? (b) pourquoi le watermark cooldown n'est-il pas persisté ? Si le
   watermark n'est pas fiable, l'UI par-banque affichera un cooldown faux. → **Instruire
   cette anomalie avant de promettre un compte-à-rebours dans l'UI.**

**Verdict du challenge :** la demande est saine SI on la reformule en **« synchronisation
par banque »** (le grain natif), en **abandonnant explicitement le refresh par compte**
(remplacé par `is_selected`), et en **fiabilisant d'abord le watermark cooldown**.

---

## 4. Design proposé (à valider — NON implémenté)

### 4.1 Backend

- **Nouvelle Server Action** `synchroniserUneConnexionAction(connectionId)` dans
  `banques/actions.ts`, enveloppant `resynchroniserConnexion` **sans** la sémantique
  « réparation MFA » (ou en généralisant l'action existante avec un drapeau `origine`).
  Exit criteria (règle 3) : zod strict (`connectionId` = uuid), `withWorkspace` (RLS
  tenant), gating `peutModifier`, ressource d'un autre tenant → **404** (la primitive lève
  déjà `ReparationContexteInvalideError` sur connexion hors scope), erreurs nommées,
  logs structurés (`workspace_id`, `connection_id`, jamais de PII/libellé bancaire).
- **Conserver** `synchroniserConnexionsAction()` (« tout synchroniser ») en option.
- **Garde cooldown** : lire `NextSyncAvailableAt` par connexion (déjà collecté dans le
  listing amont) et le renvoyer à l'UI pour armer/désarmer le bouton, au lieu de laisser
  `declencherEtAttendre` absorber un `429` en silence.

### 4.2 Frontend

- **/banques** : chaque carte de connexion porte son propre bouton « Synchroniser » +
  sa pastille de fraîcheur (réutiliser `BalanceFreshnessPill`) + le compte-à-rebours de
  cooldown si `NextSyncAvailableAt` est futur. États repos/en cours/succès/erreur/
  réparation identiques au `SyncButton` existant (réutiliser `registreSynchro`, le module
  pur testé — jamais de vert sur une réserve).
- **Dashboard** : garder le `SyncButton` global (« tout synchroniser »).
- **Axe « par compte »** : NE PAS ajouter de bouton refresh. Documenter dans la copie que
  le rafraîchissement est **par banque**, et que l'inclusion/exclusion d'un compte se
  règle via `is_selected` (surface existante). Éviter toute affordance qui laisse croire
  à un scraping par compte.

### 4.3 Ce que le design N'inclut PAS (anti-scope-creep)

- Pas de refresh par compte (impossible amont).
- Pas de planification/auto-sync périodique (chantier distinct, cf. TODOS « Synchronisation
  automatique des soldes/transactions »).
- Pas de refonte de l'ingestion (couche `synchroniserCompte` inchangée).

---

## 5. Recommandation

**Reformuler la demande en « synchronisation PAR BANQUE » (grain natif Omni-FI), exposer
la primitive `resynchroniserConnexion` existante via une action utilisateur normale, et
abandonner explicitement le refresh par compte (remplacé par `is_selected`).**
**Pré-requis bloquant : instruire l'anomalie du watermark cooldown (Absa 2026-07-16)**
avant d'afficher un compte-à-rebours par banque, sous peine d'une UI qui ment.

**Déclencheur de mise en œuvre :** décision produit d'ouvrir le par-banque (ce chantier) —
consigné TODOS `SYNC-GRANULARITE-BANQUE1`. À séquencer APRÈS l'instruction de l'anomalie
cooldown (`SYNC-COOLDOWN-WATERMARK1`).
