# PLAN — Epic 1 : Auth.js + consent flow + audit trail + révocation

> **Phase** : CONCEPTION. Aucune ligne de code applicatif n'a été écrite pour produire
> ce document (règle 1). L'implémentation référencera ce fichier.
> **Date** : 2026-07-10 · **Auteur** : agent (Staff Engineer)
> **Statut** : **FIGÉ** — les six décisions ouvertes ont été arbitrées le 2026-07-10 (§9).
> **Human-in-the-Loop** : chaque lot s'arrête à la **PR poussée** sur une branche
> `feature/*` créée depuis `origin/main` à jour. L'agent n'ouvre pas la PR, ne merge
> jamais (CLAUDE.md § Human-in-the-Loop, règles 2 et 4). Aucun auto-merge : ce chantier
> touche schéma, RLS, sécurité → **applicatif**, donc validation humaine obligatoire.

## Journal des décisions (2026-07-10, arbitrage humain)

| # | Décision actée | Effet sur le plan |
|---|---|---|
| **Q1** | Journal d'audit + export = **ADMIN seul** (`peutAdministrer`), surface cachée aux autres. Vision Entité verrait toutes les BU → fuite intra-groupe. **Fail-closed.** | §5.4, §8 cas 19. Ouverture élargie → dette P2 (§10) |
| **Q2** | **Retirer** les FK `connection_id` et `granted_by` de `consent_records`. **Condition non négociable** : dénormaliser l'identité et le contexte **à l'instant T** (snapshot). Principe généralisé : *partout où une FK vers une table éditable est retirée, l'append-only doit devenir auto-suffisant.* | §5.1 (schéma), §6/P1, **§2.4 (nouveau : principe de snapshot)** |
| **Q3** | Purge **LOGIQUE** (`is_removed=true`). Soupape levée : **aucun engagement RGPD art. 17 écrit n'existe** (vérification §6/P5) | §5.3, §6/P5 |
| **Q4** | **UNIQUE composite** `(workspace_id, omnifi_event_id)` dès `0021` | §5.1, §6/P2 |
| **Q5** | Ordre **nominal** : L3.3 (révocation) avant L3.4 (panneau). Aucune contrainte de date Innov8 identifiée dans les sources | §3 |
| **Q6** | **PR 2′ livrée** (lot court). La PR 2 n'est pas close. La modal re-login est un **bloquant du consent flow**, pas du polish | §4 |

**Vérification de la soupape Q3 (exigée par l'arbitrage).** Recherche `RGPD|GDPR|art. 17|
droit à l'effacement|erasure|DPA` sur `docs/` + `*.md` : **aucun engagement d'effacement
physique** vis-à-vis de BOM/Innov8. Les trois occurrences d'« offboarding RGPD » portent
**exclusivement** sur le DELETE de **tables normales** (`users`, `workspace_members`,
`bank_connections`), jamais sur l'append-only financier :
- `docs/specs/provisioning-tygr-app.md:68` — *« L'append-only n'est JAMAIS concerné (il ne
  reçoit DELETE à aucun moment) ; le seul effet est que l'offboarding RGPD (DELETE sur
  tables normales) attend ce re-provision. »*
- `TODOS.md:1751` — même formulation, dette de runbook.
- `TODOS.md:1826` (dette #6) — *« supprimer un user qui a créé une `bank_connection` est
  bloqué par la FK → offboarding RGPD heurte une erreur FK »*, parade proposée :
  `SET NULL` sur `created_by`, **« traçabilité via `audit_events` »**.

→ **La purge logique est confirmée.** La contrainte réglementaire portée par les sources
est l'inverse de l'effacement : c'est la **conservation** de la trace.

> ⚠️ **La dette #6 renforce Q2 par un chemin indépendant.** Elle envisage `created_by →
> SET NULL` pour débloquer l'offboarding RGPD. Si `consent_records.granted_by` était une
> FK vers `users`, ce `SET NULL` **viderait de son sens l'enregistrement réglementaire**
> le jour où l'employé qui a consenti quitte l'entreprise. Le snapshot d'identité exigé
> par Q2 n'est donc pas une précaution : c'est la seule chose qui rend la dette #6
> résoluble sans détruire l'audit.

---

## 0. Constat préalable — le brief est périmé sur la PR 2

Le brief décrit la PR 2 comme « à concevoir/implémenter ». **Vérification faite sur la
base de code, elle est livrée à environ 90 %.** Ce plan ne peut pas prescrire de
reconstruire ce qui existe : il redéfinit la PR 2 comme un **delta de finition**, et
concentre l'effort sur la PR 3, qui est effectivement un chantier vierge.

Ce qui existe **déjà** (preuves fichier:ligne) :

| Item du brief PR 2 | Statut | Preuve |
|---|---|---|
| `activeWorkspaceId` dans le JWT | ✅ livré | `src/server/auth/config.ts:88` |
| Bascule par `session update` | ✅ livré | `unstable_update` exporté `config.ts:25`, appelé `src/app/(workspace)/actions.ts:60` |
| Double barrière anti-IDOR à la bascule | ✅ livré | barrière 1 : `validerBascule` (`server/auth/workspace-switch.ts`) ; barrière 2 : callback `jwt` trigger `update` (`config.ts:97-109`) |
| Sélecteur de workspace — état LOADING | ✅ livré | `src/app/(workspace)/selection/loading.tsx` (Suspense RSC) |
| Sélecteur — état EMPTY (« contactez votre administrateur ») | ✅ livré | `selection/page.tsx:44-51` |
| Sélecteur — état ERROR | ✅ livré | `selection/liste-workspaces.tsx` (`role="alert"`, message générique) |
| Sélecteur — SUCCESS / skip auto si 1 seul | ✅ livré | `selection/page.tsx:29-31` + `workspace-switcher.tsx:34` (badge si mono) |
| Provisioning ADMIN | ✅ livré | `admin/membres/actions.ts` (zod strict, argon2) → `server/repositories/provisioning.ts:87` (`ctx.role !== "ADMIN"` → `ProvisioningNonAutoriseError`) |
| Gating VIEWER — serveur | ✅ livré | `peutModifier` / `peutAdministrer` (`src/lib/permissions.ts`), appliqué dans 8 repositories/actions (règles, échéances, banques, widget, transactions, entités, périmètres) |
| Gating VIEWER — surfaces ADMIN cachées | ✅ livré | `components/shell/app-sidebar.tsx`, `transactions/page.tsx` (absentes du DOM, pas grisées) |
| `role` re-résolu à chaque requête (E14) | ✅ livré | `server/db/tenancy.ts:212-226` puis `ctx.role` posé `:422`. **Le rôle n'est PAS dans le JWT** — choix correct, un membre rétrogradé perd ses droits immédiatement. |

Ce qui **manque réellement** au périmètre PR 2 (trois trous, dont un seul est du D2) :

1. **La modal re-login sans perte de contexte** — D2 ligne « Transverse » : *« session
   expirée en plein flow : modal re-login SANS perte du contexte (retour à l'étape) »*.
   Aucune trace au repo (`grep "session expir\|re-login"` → 0 résultat).
2. **Le tooltip VIEWER** — D2 décision #37 : *« VIEWER : actions désactivées + tooltip
   "réservé aux managers" »*. Aujourd'hui les composants **cachent** l'action au lieu de
   la **désactiver + expliquer** (`echeances-list.tsx:13`, `sync-button.tsx`, `bank-cta.tsx`).
   La convention D2 dit : *désactivé+tooltip* pour les actions de modification,
   *caché* pour les surfaces admin. La moitié « désactivé+tooltip » n'est pas appliquée.
3. **Le bootstrap du premier ADMIN** — le plan approuvé ne le spécifie pas
   (Open Question 4, ligne 444 : *« Qui est l'ADMIN TYGR côté société mère ? »*).
   `scripts/seed-admin.mjs` existe mais n'est pas documenté comme la réponse.

**Conséquence sur le découpage** : la « PR 2 » telle qu'écrite au brief n'existe plus
comme lot. Je la remplace par un lot **PR 2′** court (finition D2), et je fais porter
le poids sur PR 3, découpée en 4 lots.

---

## 1. Vocabulaire — lever trois ambiguïtés du brief

Avant de figer quoi que ce soit, trois désalignements entre le brief et les sources :

**(a) « D2 » est ambigu dans le plan approuvé.** Il désigne deux choses :
- **D2 design** (ligne 743) = *matrice écrans × états* (LOADING/EMPTY/ERROR/SUCCESS/PARTIAL).
  C'est ce que le brief veut dire par « les 4 états D2 » — en réalité **5 colonnes**,
  dont PARTIAL, souvent `—`.
- **D2 décision** (ligne 1121) = une ré-priorisation business, **annulée par D3**
  (ligne 1143). Sans objet ici.

Ce plan emploie **D2 = la matrice design**, et cite la ligne exacte à chaque fois.

**(b) « activeWorkspaceId » n'est pas dans le plan approuvé.** Le plan dit « workspace
actif stocké en session serveur » (ligne 352). Le nom `activeWorkspaceId` est une
invention (correcte) du code. Pas de conflit — je garde le nom du code.

**(c) « Révocation » recouvre DEUX endpoints Omni-FI radicalement différents**, et le
brief les confond. C'est le point le plus dangereux du chantier :

| Endpoint | Auth | Effet | Est-ce « la révocation » d'Epic 1 ? |
|---|---|---|---|
| `POST /widget/session/revoke` | SessionTokenAuth | Invalide un **SessionToken de widget** (best-effort, appelé au `unload` de l'onglet) | **NON.** C'est de l'hygiène de session widget. Zéro valeur réglementaire. |
| `DELETE /connections/{ConnectionId}` | ApiKeyAuth | **Supprime la connexion et purge les credentials du vault chiffré.** `204` ; `409` si un sync est en cours | **OUI.** C'est ce que le plan appelle « révocation de consentement » (plan ligne 366) |

Le plan approuvé est sans ambiguïté (ligne 366) : *« Révocation de consentement :
`DELETE /connections/{ConnectionId}` + record `REVOKED` + purge des données du cache
local (cycle de vie complet visible par le régulateur) »*.

⚠️ Construire `widget/session/revoke` en croyant faire la révocation de consentement
livrerait une démo Innov8 **vide** : le régulateur verrait un événement `REVOKED` alors
que la banque reste connectée et que TYGR continue de synchroniser. Les deux sont à
construire, mais ce sont deux lots distincts (L3.3 et une dette P2).

---

## 2. Architecture cible — les trois décisions de fond

### 2.1 `audit_events` : une table, deux producteurs, un seul écrivain

Le plan prévoit `audit_events.omnifi_event_id VARCHAR(64) UNIQUE` pour la **déduplication
des webhooks**. Or **la route `/api/webhooks/omnifi` n'existe pas** (`src/app/api/` ne
contient que `auth/[...nextauth]`). La colonne serait donc morte à la livraison.

Décision retenue : **on crée la colonne (nullable, unique), on ne crée pas le webhook.**
- `omnifi_event_id IS NULL` → événement **applicatif** (consentement, révocation, login).
- `omnifi_event_id IS NOT NULL` → événement **webhook** (à venir, Epic « pipeline sync »).

La contrainte `UNIQUE` sur une colonne nullable en PostgreSQL autorise N lignes NULL —
c'est exactement le comportement voulu, mais **ce n'est pas évident** et sera commenté
dans le schéma. Une contrainte `UNIQUE` naïve sur `(omnifi_event_id)` seul est
**cross-tenant** ; scoper à `(workspace_id, omnifi_event_id)` casserait l'idempotence si
un même EventId arrivait mal routé. → voir **Pushback P2** §6.

### 2.2 Append-only strict : trois gardes, pas une

`consent_records` et `audit_events` sont append-only **stricts** (règle 8 : aucun UPDATE
**ni** DELETE, contre `transactions_cache` qui autorise l'UPDATE tombstone). Le repo a
déjà exactement ce pattern sur `categorization_audit`. On le copie **intégralement** :

| Garde | Mécanisme | Fichier | Pourquoi elle ne suffit pas seule |
|---|---|---|---|
| **1. Privilège DELETE** | absence de la liste blanche | `drizzle/provisioning/tygr_app.sql` étape 5 | Une **cascade FK** supprime les lignes filles sans re-vérifier le privilège (leçon #3bis, CLAUDE.md) |
| **2. Privilège UPDATE** | `REVOKE UPDATE, DELETE` explicite | `tygr_app.sql` étape 6 (comme `categorization_audit:171`) | L'étape 3 accorde `UPDATE ON ALL TABLES` en bloc — il faut le **retirer** après |
| **3. Trigger** | `BEFORE UPDATE OR DELETE` → `RAISE` | migration `0021`, réutilise `tygr_refuser_mutation_append_only()` (déjà créée en `0005`) | Seule défense **indépendante du privilège et du chemin** : mord même sous l'owner, même en cascade, même en migration de réparation |

La fonction `tygr_refuser_mutation_append_only()` existe déjà (`0005:74`) — on ne la
recrée pas, on pose deux triggers qui l'appellent. **Corollaire de gouvernance** : ces
tables sont de l'append-only financier → **dette interdite** (règle 9). Pas de
« on posera le trigger plus tard ».

### 2.3 La machine du consent flow : où les événements sont émis

Le consentement n'est pas un état stocké et muté : c'est une **suite d'événements
immuables** dont l'état courant se **dérive** (`MAX(created_at)` par `connection_id`).
C'est ce qui rend le narratif Innov8 défendable devant un régulateur.

```
                     ┌──────────────────────── consent_records (append-only) ───────┐
                     │                                                              │
  [widget]           │  action='GRANTED'            action='ACCOUNTS_SELECTED'      │  action='REVOKED'
  link-exchange ─────┼──▶ scope={requestedScopes}   ──▶ scope={accountIds:[...]}    ┼──▶ scope={reason}
  (ConnectionId OK)  │         │                              │                     │        │
                     └─────────┼──────────────────────────────┼─────────────────────┘        │
                               ▼                              ▼                              ▼
                     audit_events                    audit_events                    audit_events
                     'consent.granted'               'consent.accounts_selected'     'consent.revoked'
```

Trois transitions, trois points d'émission **serveur** (jamais depuis le client) :

| Transition | Émise depuis | Déclencheur | Écrit |
|---|---|---|---|
| → `GRANTED` | `src/server/widget/orchestration.ts`, **dans la transaction** qui persiste `bank_connections` après `link-exchange` | le `ConnectionId` permanent est obtenu | `consent_records(GRANTED)` + `audit_events(consent.granted)` |
| → `ACCOUNTS_SELECTED` | Server Action `selectionnerComptesAction` (nouvelle) | l'utilisateur valide sa sélection de comptes → `PUT /connections/{id}/accounts` | `consent_records(ACCOUNTS_SELECTED, scope={accountIds})` + `audit_events` |
| → `REVOKED` | Server Action `revoquerConsentementAction` (nouvelle) | double confirmation UI → `DELETE /connections/{ConnectionId}` | `consent_records(REVOKED)` + `audit_events(consent.revoked)` + purge locale |

**Invariant d'ordonnancement (non négociable)** : l'écriture du `consent_record` et
l'appel Omni-FI ne sont **pas** dans la même transaction (l'un est une DB, l'autre un
réseau — pas de transaction distribuée). L'ordre est imposé :

- **GRANTED / ACCOUNTS_SELECTED** : *appel Omni-FI d'abord, écriture ensuite.* Si l'appel
  échoue, rien n'est écrit — on ne consigne pas un consentement qui n'existe pas chez le
  fournisseur.
- **REVOKED** : *écriture d'abord (intention), appel ensuite, puis événement de résultat.*
  Un `DELETE /connections` qui réussit chez Omni-FI mais dont on perd la trace locale
  est le pire scénario réglementaire. On accepte donc un `REVOKED` consigné pour un
  appel qui a échoué — **et on écrit un événement correctif** (`consent.revoke_failed`
  dans `audit_events`), jamais un UPDATE ni un DELETE (règle 8). C'est précisément le
  cas d'usage que la règle 8 prévoit.

### 2.4 Principe d'auto-suffisance de l'append-only (acté Q2, 2026-07-10)

**Règle générale, applicable partout où une FK vers une table éditable est retirée d'une
table append-only :**

> Un enregistrement réglementaire append-only doit être **auto-suffisant**. Il ne pointe
> jamais vers une donnée qui peut changer ou disparaître ; il **copie**, à l'instant de
> l'événement, tout ce qui est nécessaire pour être relu et compris dix ans plus tard,
> sans jointure et sans la ligne d'origine.

Trois raisons **indépendantes** rendent la FK intenable ici (une seule suffirait) :

1. **La révocation supprime la connexion** — c'est le lot L3.3. Une FK `RESTRICT` la
   bloque ; une FK `CASCADE` tente d'effacer l'audit (le trigger `0004` lève, message
   incompréhensible). Cf. Pushback P1.
2. **L'offboarding RGPD modifie l'utilisateur** — dette #6 (`TODOS.md:1826`) envisage
   `created_by → SET NULL`. Une FK `granted_by → users(id)` transformerait « Alice a
   consenti le 3 mars » en « ␀ a consenti le 3 mars » le jour de son départ.
3. **Un audit qui exige une jointure vers une table vivante n'est pas un audit** — il est
   réfutable : la ligne jointe a pu être modifiée après coup. Le snapshot est ce qui rend
   l'enregistrement opposable.

**Ce qui est snapshoté**, et pourquoi chaque champ (rien de superflu — chaque colonne est
une surface PII à justifier, règle 8) :

| Colonne | Type | Pourquoi | Sans elle |
|---|---|---|---|
| `granted_by_user_id` | `UUID` **nu** | corréler avec `users` **si** la ligne existe encore | — |
| `granted_by_email` | `VARCHAR(254)` | identifier la personne qui a consenti | l'audit dit « un utilisateur supprimé » |
| `granted_by_name` | `VARCHAR(120)` | lisibilité humaine du journal | il faut requêter `users` |
| `connection_id` | `UUID` **nu** | corréler `consent_records` ↔ `audit_events` ↔ `bank_connections` | on ne peut plus relier les 3 événements d'un même cycle |
| `institution_name` | `VARCHAR(140)` | **quelle banque** a été consentie/révoquée | après révocation : « une banque » |
| `scope` | `JSONB` | comptes/scopes consentis, **masqués** (voir ci-dessous) | on ne sait pas *à quoi* on a consenti |

**Masquage des comptes dans `scope` (PII bancaire, règle 8).** `scope.accountIds` porte
des UUID internes — inoffensifs. Le snapshot ajoute `scope.accountsLabels[]` sous la forme
`{ accountId, masked }` où `masked` est **produit par une fonction unique**
`masquerCompte()` (nouveau, `src/lib/masquage.ts`) : quatre derniers caractères précédés de
`••••`. **Jamais** l'IBAN, jamais le numéro complet, jamais le libellé bancaire brut.
Un `accountId` qui n'a plus de compte correspondant reste lisible : `••••4321 (Absa)`.

> **Frontière à ne pas franchir** : le snapshot est un compromis entre auto-suffisance et
> minimisation. On copie **l'identité de l'acteur** et **la désignation de l'objet**, pas
> la donnée financière. Aucun montant, aucun solde, aucune transaction n'entre jamais dans
> `consent_records` ni `audit_events`.

Le même principe s'applique à `audit_events` : `actor_user_id` (UUID nu) est accompagné de
`actor_email` dans `payload`, sous la liste blanche du repository (§5.2).

**Précédent au repo** : `categorization_audit` (`schema.ts:666-700`) fait exactement cela —
`transaction_id` sans FK, plus les snapshots `category_name`, `amount`, `source`. Le
commentaire du schéma dit : *« Pas de FK dure vers la transaction (on garde la trace quoi
qu'il arrive). »* On ne fait qu'appliquer une décision déjà prise et déjà testée.

---

## 3. Découpage en lots

Ordre imposé. Chaque lot = une branche `feature/*` depuis `origin/main` à jour, une PR,
un arrêt. Ne pas paralléliser L3.1 et L3.2 (le second dépend du schéma du premier).

| Lot | Titre | Branche | Effort | Dépend de |
|---|---|---|---|---|
| **PR 2′** | Finition D2 : modal re-login + tooltip VIEWER + runbook bootstrap ADMIN | `feature/epic1-d2-finition` | M | — |
| **L3.1** | Schéma append-only : `consent_records` + `audit_events` (migration 0021) | `feature/epic1-schema-audit` | M | — |
| **L3.2** | Émission : `GRANTED` + `ACCOUNTS_SELECTED` + repository d'audit | `feature/epic1-consent-emission` | L | L3.1 |
| **L3.3** | Révocation : `DELETE /connections` + `REVOKED` + purge locale | `feature/epic1-revocation` | L | L3.2 |
| **L3.4** | Surfaces : panneau Journal d'audit + export JSON | `feature/epic1-audit-ui` | M | L3.2 |

> L3.4 est **livrable indépendamment de L3.3** (le panneau lit `audit_events`, qui existe
> dès L3.2). Si le calendrier Innov8 serre, L3.4 peut passer avant L3.3 — mais la démo
> régulateur exige le **cycle complet**, donc L3.3 avant la démo.

---

## 4. PR 2′ — Finition D2 (branche `feature/epic1-d2-finition`)

### 4.1 Modal re-login sans perte de contexte

**Le problème réel.** Session JWT expirée (`maxAge` Auth.js) pendant que l'utilisateur
est au milieu du widget MFA ou d'un formulaire de règle. Aujourd'hui : la Server Action
lève `NonAuthentifieError` → l'utilisateur est éjecté vers `/login` → au retour, le
contexte est perdu (OTP à re-demander, formulaire vidé). Sur le widget MFA c'est pire
qu'une gêne : le `SessionToken` Omni-FI meurt avec la session, et le job de sync est perdu.

**Le mécanisme retenu** (pas de nouvelle dépendance, règle 9) :

- Un composant client `<GardeSession/>` monté dans `(workspace)/layout.tsx`.
- Il ne **poll pas**. Il écoute l'événement `visibilitychange` + un `setTimeout` calé sur
  `session.expires` (déjà exposé par Auth.js) moins 60 s.
- À l'échéance : ouvre une modale **par-dessus** l'écran courant (`<dialog>` natif,
  `role="dialog"` — cf. leçon QA « uppercase CSS + Échap dans portail »), avec les seuls
  champs email + mot de passe. **Le DOM sous-jacent n'est jamais démonté** — c'est là
  toute la définition de « sans perte de contexte ».
- Soumission → `signIn("credentials", { redirect: false })`. Succès → fermeture de la
  modale, l'écran reprend là où il en était. Échec → message générique non-énumérant
  (registre S2 : *« identifiants invalides »*), **pas** de compte à rebours de lockout
  affiché (E18 ligne 936 supersède D2 ligne 746 sur ce point précis — contradiction du
  plan tranchée en faveur d'E18, anti-énumération).

**Angle mort à couvrir dans les tests** : un re-login **sous une autre identité**. Si
Alice laisse sa session expirer et que Bob se re-logue dans la modale, l'écran
sous-jacent affiche encore les données d'Alice. → **La modale doit comparer le `userId`
retourné au `userId` précédent ; s'ils diffèrent, `router.refresh()` forcé + purge du
`viewFilter`.** Sans cela on fabrique une fuite intra-workspace visuelle.

**Critères de sortie (§3 CLAUDE.md)**
- [ ] Authz : la modale n'appelle que `signIn` ; aucune donnée n'est lue tant que la
      session n'est pas rétablie.
- [ ] Validation zod : réutilise le schéma de `/login` (pas de duplication).
- [ ] Erreur nommée : `SESSION_EXPIRED` (nouveau, §7) ; message générique au refus.
- [ ] Tests : (heureux) re-login même utilisateur → l'état de l'écran est intact ;
      (échec) mauvais mot de passe → message générique, modale reste ouverte, contexte
      intact ; (limite) re-login sous une **autre identité** → refresh forcé, pas de
      donnée d'Alice visible pour Bob.
- [ ] Visual QA (Gate 4) : capture de la modale ouverte au-dessus du widget MFA et
      au-dessus d'un formulaire de règle rempli.
- [ ] Secrets : le mot de passe ne transite ni par un log ni par une `cause` d'erreur.

### 4.2 Tooltip VIEWER (convention D2 #37)

Appliquer la convention **complète** : *action de modification → désactivée + tooltip
« réservé aux managers » ; surface d'administration → cachée*. Aujourd'hui la moitié
« désactivée + tooltip » manque : les composants **cachent** les actions de modification
(`echeances-list.tsx`, `sync-button.tsx`, `bank-cta.tsx`).

Livrable : une primitive `<ActionProtegee role= …>` (pure, zéro fetch — cf. convention
des composants d'affichage) qui rend soit l'enfant actif, soit un enfant `disabled` +
`title`/`aria-describedby`. Substitution dans les 4 composants listés.

**Ce n'est pas cosmétique** : cacher l'action prive le VIEWER de l'information « cette
capacité existe, demandez-la à votre manager ». C'est la décision #37 du plan.

**Critères de sortie** : composant pur (aucun état interne, aucun fetch) ; tokens
`UI_GUIDELINES` uniquement ; focus visible conservé sur l'élément désactivé
(`aria-disabled` plutôt que `disabled` nu, sinon le tooltip est inatteignable au clavier) ;
Visual QA des 4 écrans sous rôle VIEWER.

### 4.3 Runbook bootstrap du premier ADMIN

Aucun code. `scripts/seed-admin.mjs` existe déjà : le documenter comme **la** réponse à
l'Open Question 4 du plan (ligne 444), dans `docs/DEMARRAGE-SANDBOX-PROD.md`, avec la
rotation du mot de passe initial. Ferme aussi la dette `AUTH-MDP-TEMPO1` référencée dans
`admin/membres/actions.ts:30`.

> **Sortie de scope explicite** : le changement de mot de passe par l'utilisateur reste
> une dette (`AUTH-MDP-TEMPO1`, P1, déclencheur = premier déploiement production).
> Entrée TODOS.md à créer (règle 9).

---

## 5. PR 3 — Consent flow, audit, révocation

### 5.1 L3.1 — Schéma append-only (migration `0021`)

**Numéro** : `0021` (dernier appliqué : `0020`). ⚠️ **Vérifier avant de générer** :
`0009_entity-write-scope.sql` est un **orphelin volontaire** (sur disque, absent du
`_journal.json`) ; le test `tests/isolation/migrations-journal-coherence.test.ts` le
whiteliste. Ne pas « réparer » cet orphelin. Vérifier `grep journal` vs `ls` avant tout
`db:generate` (dette connue, cf. mémoire *migration-hors-journal-drizzle*).

**Backward-compatibilité N-1** : la migration est **purement additive** (deux `CREATE
TABLE`, deux triggers, RLS). Le code N-1 ignore ces tables. Aucune fenêtre
expand/contract nécessaire.

```sql
-- consent_records : le cycle de vie du consentement, immuable et AUTO-SUFFISANT (§2.4).
-- Aucune FK vers une table éditable (bank_connections, users) : voir P1 + dette #6.
-- Seule FK conservée : workspace_id → workspaces (le tenant ne disparaît jamais sans
-- que TOUT disparaisse ; et la RLS s'appuie de toute façon sur le GUC, pas sur la FK).
CREATE TABLE consent_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL REFERENCES workspaces(id),

    -- Objet du consentement : UUID nu + snapshot de désignation (Q2).
    connection_id       UUID NOT NULL,                 -- PAS de FK (P1)
    institution_name    VARCHAR(140),                   -- snapshot : « Absa Internet Banking »

    -- Acteur : UUID nu + snapshot d'identité (Q2, dette #6).
    granted_by_user_id  UUID NOT NULL,                  -- PAS de FK (dette #6 : SET NULL)
    granted_by_email    VARCHAR(254) NOT NULL,          -- snapshot à l'instant T
    granted_by_name     VARCHAR(120),                   -- snapshot à l'instant T

    action              VARCHAR(30) NOT NULL
                        CHECK (action IN ('GRANTED','ACCOUNTS_SELECTED','REVOKED')),

    -- { requestedScopes:[…] } | { accountIds:[…], accountsLabels:[{accountId,masked}] }
    -- | { reason }.  Comptes MASQUÉS (••••4321), jamais d'IBAN ni de libellé brut.
    scope               JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX consent_records_ws_connection_idx
    ON consent_records (workspace_id, connection_id, created_at DESC);
-- ↑ sert la dérivation de l'état courant : dernier événement par connexion.

-- audit_events : le journal. omnifi_event_id NULL = événement applicatif.
CREATE TABLE audit_events (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id             UUID NOT NULL,          -- pas de FK : voir P3 (intentionnel)
    event_type               VARCHAR(60) NOT NULL,
    omnifi_event_id          VARCHAR(64),            -- NULL = événement applicatif
    connection_id            UUID,                   -- pas de FK (P1)
    actor_user_id            UUID,                   -- NULL si système/webhook ; pas de FK
    hmac_signature_truncated VARCHAR(8),             -- 8 hex = 32 bits, non rejouable
    payload                  JSONB NOT NULL DEFAULT '{}',  -- liste blanche par event_type
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Q4 : unicité COMPOSITE, jamais globale (oracle d'existence cross-tenant).
    -- Repose sur WEBHOOK-TENANT-FIRST1 (schema.ts:36) : le futur résolveur webhook
    -- résout le TENANT d'abord (ClientUserId → workspace), la connexion ensuite.
    CONSTRAINT audit_events_workspace_omnifi_event_unique
        UNIQUE (workspace_id, omnifi_event_id)
);

CREATE INDEX audit_events_ws_created_idx
    ON audit_events (workspace_id, created_at DESC);   -- pagination keyset du panneau
```

**Note PostgreSQL sur `UNIQUE (workspace_id, omnifi_event_id)`** : une contrainte UNIQUE
n'est **jamais violée par des NULL** — N lignes applicatives (`omnifi_event_id IS NULL`)
coexistent sans conflit dans le même workspace. C'est exactement le comportement voulu,
mais ce n'est pas évident : **à commenter dans le schéma Drizzle**, sinon une revue future
« corrigera » en `NOT NULL` et cassera l'émission applicative.

Écarts vs le plan approuvé (lignes 249-272), **actés** :
- FK `connection_id` et `granted_by` **retirées** → décision **Q2** (fait nouveau : le
  trigger `0004`, postérieur au plan ; renforcé par la dette #6). Compensées par les
  snapshots (§2.4).
- `UNIQUE(omnifi_event_id)` global → **composite** (décision **Q4**).
- `audit_events.workspace_id` sans FK : **conforme** au plan (ligne 264), et intentionnel
  (P3) — à commenter pour qu'on ne le « répare » pas.

**RLS** (répliquer le pattern `POLITIQUE_TENANT` de `schema.ts`) :
```sql
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_records
  USING      (workspace_id = nullif(current_setting('app.current_workspace_id', true),'')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.current_workspace_id', true),'')::uuid);
-- idem audit_events
```

**Append-only** (les trois gardes de §2.2) :
```sql
CREATE TRIGGER consent_records_no_mutation BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION tygr_refuser_mutation_append_only();   -- fonction créée en 0005
CREATE TRIGGER audit_events_no_mutation    BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION tygr_refuser_mutation_append_only();
```

**`tygr_app.sql`** (même PR, sinon le privilège dément le trigger) :
- Étape 5 : **ne PAS ajouter** `consent_records` ni `audit_events` à la liste blanche DELETE.
- Étape 6 : ajouter deux blocs `DO`/`to_regclass` → `REVOKE UPDATE, DELETE ON … FROM tygr_app`
  (copie conforme du bloc `categorization_audit`, `tygr_app.sql:168-174`).

**Ces deux tables ne portent PAS `entity_id`** (invariant CLAUDE.md : `entity_id` vit
uniquement sur `bank_accounts`). Elles ne sont donc pas soumises à l'étage 2 (scope
entité) : un membre scopé « Vision Entité » y verrait les événements de toutes les BU.
**Décision Q1 : l'accès au journal est réservé à l'ADMIN** (`peutAdministrer`), surface
cachée aux autres. Fail-closed. L'ouverture élargie est une dette P2 (§10). Voir P4.

**Critères de sortie L3.1**
- [ ] Migration `0021` additive ; rollback = `DROP TABLE` (aucune donnée à préserver au
      lot 1, les tables naissent vides).
- [ ] **Aucune FK** vers `bank_connections` ni `users` (Q2). Vérifié par le cas
      d'isolation n°5 (cascade).
- [ ] Colonnes de snapshot présentes et `NOT NULL` là où §2.4 l'exige
      (`granted_by_email`, `granted_by_user_id`).
- [ ] `UNIQUE (workspace_id, omnifi_event_id)` composite (Q4) + commentaire sur le
      comportement des NULL.
- [ ] Les **trois gardes** append-only posées (§2.2) : hors liste blanche DELETE,
      `REVOKE UPDATE, DELETE`, trigger `BEFORE UPDATE OR DELETE`.
- [ ] `npm run db:provision && migrate && db:provision` (ordre non négociable) rejoué à
      neuf : les REVOKE mordent (ils ne mordent qu'au **re-provision post-migrate**).
- [ ] Test d'isolation `tests/isolation/audit-append-only-isolation.test.ts` (§8).
- [ ] `migrations-journal-coherence.test.ts` reste vert (0021 présent des deux côtés ;
      ne pas « réparer » l'orphelin `0009`, whitelisté).
- [ ] Aucune ligne applicative n'écrit encore dans ces tables (c'est le lot L3.2).
- [ ] `lint` + `tsc --noEmit` + build verts avant tout commit (stop-loss, règle 5).

### 5.2 L3.2 — Émission des événements

**Repository** `src/server/repositories/audit.ts` — **seul écrivain autorisé** :
```ts
consigner(tx, ctx, { eventType, connectionId?, payload })      // audit_events
enregistrerConsentement(tx, ctx, { connectionId, action, scope }) // consent_records + consigner()
```
Les deux prennent le `tx` de `withWorkspace` : **jamais de connexion propre**, jamais
d'accès DB hors `src/server/` (règle 2). `workspace_id` et `actor_user_id` viennent de
`ctx`, **jamais d'un paramètre client**.

**Le repository est le SEUL endroit qui construit les snapshots (§2.4).** Il lit — dans
la même transaction, sous RLS — l'email/nom de l'acteur (`users`) et le nom de
l'institution (`bank_connections`), puis les **copie** dans la ligne. Aucun appelant ne
fournit ces champs : sinon un appelant pourrait falsifier l'identité consignée. Les
comptes sont masqués par `masquerCompte()` (`src/lib/masquage.ts`, fonction pure, source
unique — même discipline que `format-montant.ts`).

> **Invariant de test** : après `DELETE FROM bank_connections` et `UPDATE users SET
> email='…'`, une relecture de `consent_records` doit rendre **exactement** la même chaîne
> lisible qu'à l'écriture. C'est le cas d'isolation n°5 (§8).

**`payload` : discipline anti-PII (règle 8).** `payload` est un JSONB libre → c'est le
vecteur d'exfiltration le plus probable du chantier. Le repository **liste blanche** les
clés autorisées par `event_type` (schéma zod par type d'événement) et rejette le reste
avec `AUDIT_PAYLOAD_INVALID`. Interdits absolus, quel que soit l'événement : libellé
bancaire brut, IBAN, `SessionToken`, `SECRET`, mot de passe bancaire, montant nominatif.
Un `accountId` (UUID) est autorisé ; un numéro de compte ne l'est pas.

**Points d'émission** :
1. `GRANTED` — dans `src/server/widget/orchestration.ts`, **dans la transaction** qui
   persiste `bank_connections` après `link-exchange` réussi. Même `tx` → si l'insertion
   de la connexion échoue, aucun consentement fantôme.
2. `ACCOUNTS_SELECTED` — nouvelle Server Action `selectionnerComptesAction`
   (`(workspace)/banques/actions.ts`). Ordre : `PUT /connections/{id}/accounts` **puis**
   écriture (§2.3). `409 ACCOUNT_NOT_FOUND` → `CONSENT_ACCOUNT_UNKNOWN`, rien d'écrit.

**Critères de sortie L3.2** (par Server Action, §3 CLAUDE.md)
- [ ] Authz `withWorkspace` ; connexion d'un autre tenant → **404** (`ConnexionNonAutoriseeError`
      existe déjà, ne pas en créer une seconde).
- [ ] Gating : `peutModifier(ctx.role)` — un VIEWER ne consent pas. Garde **dans** la
      transaction (pattern `regles-categorisation.ts`).
- [ ] Zod strict : `{ connectionId: uuid, accountIds: uuid[].max(200) }` `.strict()`.
- [ ] Codes d'erreur nommés (§7) ; aucun catch-all.
- [ ] Tests : (heureux) sélection → 1 `consent_record` + 1 `audit_event` ; (échec)
      `409 ACCOUNT_NOT_FOUND` amont → **0 ligne écrite** ; (limite) double soumission
      concurrente → 2 événements (append-only : c'est **correct**, l'audit consigne les
      deux intentions ; c'est l'état **dérivé** qui doit être idempotent).
- [ ] Logs structurés `workspace_id` + `connection_id` + code machine. **Zéro PII.**
- [ ] Cas ajoutés à la suite d'isolation (§9).

### 5.3 L3.3 — Révocation (le lot à risque)

**Client Omni-FI** : ajouter `supprimerConnexion(connectionId, clientUserId)` →
`DELETE /connections/{ConnectionId}` (ApiKeyAuth). Mapper `409` (sync en cours) sur
`CONSENT_REVOKE_SYNC_IN_PROGRESS` — **retryable**, message UI explicite (« une
synchronisation est en cours, réessayez dans quelques minutes »). Ne **pas** confondre
avec `POST /widget/session/revoke` (§1.c).

**Server Action** `revoquerConsentementAction` — la séquence, dans cet ordre :

```
1. withWorkspace + peutModifier(ctx.role)         (VIEWER exclu)
2. INSERT consent_records(REVOKED)   ─┐  transaction 1 : l'INTENTION est consignée
   INSERT audit_events(consent.revoke_requested) ─┘  AVANT tout appel réseau
3. DELETE /connections/{id}  ────────────  appel Omni-FI (hors transaction)
   ├─ 204 → transaction 2 : audit_events(consent.revoked) + purge locale
   ├─ 409 → transaction 2 : audit_events(consent.revoke_failed, {reason:'sync_in_progress'})
   │         → l'UI propose « réessayer ». Le REVOKED de l'étape 2 reste. C'est voulu.
   └─ 5xx → idem revoke_failed, code CONSENT_REVOKE_UPSTREAM_ERROR
```

**Pourquoi l'intention est écrite avant l'appel** : si l'appel réussit chez Omni-FI mais
que le processus meurt avant l'écriture, l'utilisateur a révoqué et TYGR n'en a **aucune
trace** — la banque est déconnectée, l'audit dit « consenti ». Inacceptable devant un
régulateur. L'inverse (trace d'une révocation qui a échoué) est **réparable par un
événement correctif**, ce que la règle 8 prescrit explicitement. On choisit l'erreur
réparable.

**« Purge des données du cache local »** (plan ligne 366) — c'est **le piège du lot** :
`transactions_cache` et `balance_history` sont **append-only au DELETE**, gardés par un
trigger `BEFORE DELETE` qui mord *même sous l'owner, même en cascade*. Il est donc
**physiquement impossible** de purger, et c'est **voulu**.

Ce que « purge » signifie concrètement, et c'est à arbitrer (§8, Q3) :
- **(a) Purge logique** : `UPDATE transactions_cache SET is_removed = true` (autorisé —
  l'UPDATE tombstone reste permis) + `bank_connections.status = 'revoked'`. Les données
  sortent de toute lecture applicative, l'historique reste en base. **Recommandé.**
- **(b) Purge physique** : exigerait de désarmer le trigger append-only → **interdit**
  (règle 9 : dette d'append-only = interdite). Écarté d'office.

⚠️ La formule du plan « purge des données du cache local » et l'invariant append-only
de CLAUDE.md sont **en contradiction frontale**. Ce plan tranche pour (a) et le consigne
ici. Si l'exigence réglementaire est une vraie effacement physique (RGPD art. 17), c'est
un **changement d'architecture** (chiffrement par connexion + destruction de clé), pas
un lot — voir Pushback **P5**.

**Critères de sortie L3.3**
- [ ] `409` amont → aucune donnée purgée, `consent.revoke_failed` consigné, UI retryable.
- [ ] Double confirmation UI (D2 ligne 751 : « action destructive, double confirmation »)
      puis écran « preuve de purge » : récap + événement `REVOKED` visible dans l'audit.
- [ ] Idempotence : révoquer deux fois → 2e appel `404` amont → traité comme succès
      (la connexion n'existe plus), `consent.revoke_noop` consigné.
- [ ] Tests : heureux (204 → tombstones posés, status='revoked') ; échec (409 → 0
      tombstone, événement correctif) ; limite (révocation d'une connexion d'un autre
      tenant → **404**, aucun événement écrit dans **aucun** workspace).
- [ ] Le trigger append-only n'est **jamais** désarmé, même en test.

### 5.4 L3.4 — Panneau audit + export JSON

- Page `(workspace)/audit` — lecture `audit_events` sous `withWorkspace`, keyset
  (jamais `OFFSET` — leçon `transactions-lecture-paginee`), **tronquée à 200 lignes**
  (D2 ligne 748 : état PARTIAL + « Exporter pour tout voir »).
- États D2 (ligne 748) : LOADING = 3 lignes skeleton ; EMPTY = « En attente du premier
  événement… » ; ERROR = bandeau ; PARTIAL = troncature + CTA export.
- Export JSON scopé RLS (plan ligne 365). Route `GET`, pas de Server Action (téléchargement).
  D2 ligne 752 : 0 ligne → **fichier vide valide avec en-têtes**, jamais un 404.
- **Qui voit le journal ?** → **ADMIN seul** (`peutAdministrer`), décision **Q1**. Surface
  **cachée** aux non-ADMIN (absente du DOM, convention D2 #37) ; accès direct à `/audit`
  ou à la route d'export → **404**, jamais 403 (pas d'oracle d'existence).
- Le journal se lit **sans jointure** (grâce aux snapshots §2.4) : l'export reste lisible
  après révocation d'une connexion ou départ d'un utilisateur. C'est le test de
  l'auto-suffisance — si l'export a besoin de `JOIN users`, le snapshot a échoué.

**Critères de sortie L3.4**
- [ ] Garde `peutAdministrer(ctx.role)` **serveur** (dans la transaction), + surface
      absente du DOM côté non-ADMIN. Les deux, pas l'un ou l'autre.
- [ ] Pagination **keyset** (jamais `OFFSET`), troncature à 200 lignes + CTA export.
- [ ] Les 5 états D2 ligne 748 (LOADING / EMPTY / ERROR / SUCCESS / PARTIAL) livrés et
      capturés au Visual QA (Gate 4).
- [ ] Export 0 ligne → `[]` valide + en-têtes HTTP, jamais 404 (D2 ligne 752).
- [ ] `AUDIT_EXPORT_TOO_LARGE` au-delà du seuil (pas de dump illimité).
- [ ] Cas d'isolation 17–19 (§8).

---

## 6. Pushback (règle 10) — cinq points, **tous arbitrés le 2026-07-10**

> Conservés intégralement : ils documentent *pourquoi* le plan approuvé a été amendé.
> Règle 10 : le pushback vit **avant** la décision. Elle est prise — l'exécution est
> désormais totale, sans re-litige.

### P1 — 🔴 BLOQUANT · La FK `consent_records.connection_id → bank_connections(id)` détruit l'audit à la révocation

**Risque concret.** `bank_connections` est dans la **liste blanche DELETE** de
`tygr_app.sql` (ligne 137-158). Le jour où quelqu'un écrit `DELETE FROM bank_connections`
(reconnexion, ménage, ou simplement le lot L3.3 s'il choisit de supprimer la ligne au
lieu de la marquer `revoked`), PostgreSQL doit résoudre la FK :
- FK en `ON DELETE RESTRICT` (défaut) → **le DELETE échoue** → la révocation est
  impossible dès qu'un consentement existe. Le lot L3.3 est mort-né.
- FK en `ON DELETE CASCADE` → **les `consent_records` sont supprimés physiquement**. Le
  trigger `BEFORE DELETE` append-only lève → le DELETE échoue quand même, mais avec une
  erreur incompréhensible. Et si quelqu'un « répare » en retirant le trigger : **l'audit
  réglementaire s'efface silencieusement**. C'est exactement le scénario #3bis
  (cascade FK contournant le REVOKE) déjà rencontré sur ce projet.

Le plan approuvé écrit `connection_id UUID NOT NULL REFERENCES bank_connections(id)`
(ligne 253) **sans clause `ON DELETE`** — c'est-à-dire le premier cas. Le plan approuvé
prescrit aussi, deux pages plus loin, de supprimer la connexion à la révocation. **Les
deux exigences sont incompatibles.**

**Alternative.** Aucune FK dure vers `bank_connections` : `connection_id UUID NOT NULL`
nu, exactement comme `categorization_audit.transaction_id` (`schema.ts:673`, dont le
commentaire dit : *« Pas de FK dure vers la transaction (on garde la trace quoi qu'il
arrive) »*). L'intégrité référentielle est garantie **applicativement** (le repository
n'écrit que sous `withWorkspace`, après avoir lu la connexion) ; l'audit survit à la
disparition de son objet — ce qui est **la définition d'un audit trail**.

**Coût comparé.**
- Garder la FK : 0 h maintenant, puis **blocage complet de L3.3** (~1 j de re-conception
  + une migration corrective sur une table append-only, c'est-à-dire un `DROP CONSTRAINT`
  autorisé mais pénible), plus un risque d'effacement silencieux de l'audit.
- Retirer la FK : **~15 min** (une ligne de schéma + un commentaire), aucun risque, un
  précédent identique déjà validé au repo (`categorization_audit`).

**✅ ACTÉ (Q2) : les deux FK sont retirées.** `connection_id` et `granted_by_user_id` en
UUID nus. **Condition attachée à l'arbitrage** : `consent_records` doit devenir
**auto-suffisant** — snapshot de l'identité de l'acteur (email + nom à l'instant T) et
de la désignation de l'objet (banque, comptes masqués). Le principe est généralisé en
**§2.4** et s'applique à toute FK retirée d'une table append-only.

**Confirmation par un chemin indépendant** (trouvée à la vérification de Q3) : la dette
**#6** (`TODOS.md:1826`) envisage `created_by → SET NULL` pour débloquer l'offboarding
RGPD, en s'appuyant explicitement sur la *« traçabilité via `audit_events` »*. Sans
snapshot, ce `SET NULL` transformerait « Alice a consenti » en « ␀ a consenti ». La FK
`granted_by` était donc condamnée même sans le lot L3.3.

### P2 — 🔴 BLOQUANT · `audit_events.omnifi_event_id UNIQUE` global vs unicité cross-tenant

**Risque concret.** `UNIQUE(omnifi_event_id)` est une contrainte **globale**, non scopée
tenant. Deux conséquences :
1. **Oracle d'existence cross-tenant** : un attaquant qui contrôle un workspace A et
   devine un `EventId` du workspace B peut tenter de l'insérer ; la violation d'unicité
   lui révèle l'existence de l'événement chez B. C'est un canal auxiliaire, faible mais
   réel — et le projet a **déjà rencontré exactement ce problème** sur
   `omnifi_connection_id` (dette 1.1/1.2 TODOS, migration `0018` EXPAND des composites).
2. **DoS d'ingestion** : une collision d'`EventId` entre tenants fait échouer un
   `onConflictDoUpdate` — mode de défaillance décrit tel quel dans TODOS 1.2.

Mais **scoper à `(workspace_id, omnifi_event_id)`** casse l'idempotence si un webhook
arrive mal routé (le même EventId traité dans deux workspaces).

**La contradiction n'est levable que parce que le webhook n'existe pas encore.** Le repo
a déjà tranché le garde-fou, il est écrit noir sur blanc dans `schema.ts:36` :
`WEBHOOK-TENANT-FIRST1` — *« tout futur résolveur webhook DOIT résoudre le TENANT
d'abord (ClientUserId→workspace, unique global conservé) PUIS la connexion DANS ce
workspace »*. Si le tenant est résolu **avant** l'insertion, un `EventId` ne peut par
construction atterrir que dans un seul workspace, et l'unicité composite suffit.

**✅ ACTÉ (Q4) : `UNIQUE(workspace_id, omnifi_event_id)` dès `0021`**, plus une note
bloquante dans le schéma renvoyant à `WEBHOOK-TENANT-FIRST1`. Pas de fenêtre
EXPAND/CONTRACT à gérer plus tard sur une table append-only — on ne peut pas `UPDATE`
pour migrer.

**Coût comparé.** Composite dès maintenant : ~10 min. Globale puis correction : une
migration sur table append-only pleine, avec une contrainte à `DROP`/`CREATE` sous
charge, dans le lot qui construira le webhook (~0,5 j) — et entre-temps l'oracle existe.

### P3 — 🟡 `audit_events.workspace_id` sans FK : c'est intentionnel, il faut le dire

Le plan approuvé met une FK sur `consent_records.workspace_id` (ligne 252) mais **pas**
sur `audit_events.workspace_id` (ligne 264). Ce n'est pas une coquille : un webhook peut
arriver avant que le workspace soit résolu, et l'audit doit pouvoir consigner
l'anomalie. Mais tel quel, la RLS `tenant_isolation` protège quand même (elle compare au
GUC, pas à une FK).

**✅ ACTÉ** : garder l'absence de FK, **avec un commentaire de schéma** expliquant
pourquoi — sinon la prochaine revue « corrigera » l'oubli et rouvrira le problème P1 sur
`audit_events`. Le coût est un commentaire. Cohérent avec Q2, qui généralise ce choix
(§2.4).

### P4 — 🟡 Le journal d'audit ignore l'étage 2 (scope entité)

`audit_events` et `consent_records` ne portent pas `entity_id` (invariant CLAUDE.md :
`entity_id` vit uniquement sur `bank_accounts`). Un membre en **Vision Entité** (scopé sur
la BU « Omnicane Sugar ») verrait donc, s'il a accès au panneau audit, les événements de
**toutes** les BU du groupe : quelle banque a été connectée par quelle autre BU, quand,
par qui. Ce n'est pas une fuite cross-**client** (étage 1 intact) mais une fuite
**intra-groupe** — que CLAUDE.md traite explicitement comme *« grave, gate bloquant »*.

**✅ ACTÉ (Q1) : panneau audit et export réservés à l'ADMIN** (`peutAdministrer`),
surface **cachée** aux autres (absente du DOM, convention D2 #37), accès direct à la
route → **404** (pas d'oracle d'existence). **Fail-closed.** Le plan approuvé va dans ce
sens (D1 ligne 732 : *« section Admin … visible ADMIN uniquement »*). Coût : 0 (garde de
rôle, pattern existant).

**Ouverture élargie = dette P2 tracée** (§10). Le jour où l'on ouvre l'audit aux MANAGER
scopés, il faudra dériver le scope par **jointure** `connection_id → bank_accounts.entity_id`
— jamais dénormaliser `entity_id` dans l'append-only (invariant CLAUDE.md). Effort : ~1 j
+ une policy RLS `entity_scope` supplémentaire. Déclencheur : demande client explicite.

### P5 — 🟡 « Purge du cache local » vs append-only : contradiction du plan approuvé

Détaillée en §5.3. Le plan dit « purge des données du cache local » ; CLAUDE.md rend la
suppression physique **impossible par construction** (trigger + privilège), et classe
toute dette d'append-only comme **interdite**.

**✅ ACTÉ (Q3) : purge LOGIQUE** (`is_removed = true`, `status = 'revoked'`). C'est
défendable devant un régulateur : *« les données ne sont plus accessibles, la trace de
leur existence et de leur retrait est immuable »* — c'est même **plus fort** qu'un
DELETE, qui ne prouve rien.

**Soupape levée par vérification documentaire** (exigée par l'arbitrage, exécutée le
2026-07-10 avant de figer) : recherche `RGPD|GDPR|art. 17|droit à l'effacement|erasure|DPA`
sur `docs/` + `*.md`. **Aucun engagement d'effacement physique** vis-à-vis de BOM/Innov8.
Les trois occurrences d'« offboarding RGPD » visent **exclusivement** le DELETE de tables
**normales** ; `docs/specs/provisioning-tygr-app.md:68` est explicite : *« L'append-only
n'est JAMAIS concerné (il ne reçoit DELETE à aucun moment). »* Ce que les sources exigent
est l'**inverse** de l'effacement : la conservation de la trace (plan ligne 366, « cycle
de vie complet visible par le régulateur »).

⚠️ **Condition de réouverture** (règle 10 : une décision ne se rouvre qu'en citant un
fait nouveau). Si un engagement RGPD art. 17 écrit apparaît (DPA signé, exigence BOM
formelle), **STOP immédiat** : ce n'est plus un lot mais une refonte — chiffrement des
transactions par clé dérivée de la connexion, révocation = destruction de la clé
(*crypto-shredding*). Effort ~1 semaine, impact sur toute la chaîne d'ingestion. Ne pas
tenter de le traiter comme une case à cocher dans L3.3.

---

## 7. Nouveaux codes d'erreur (extension du registre S2)

Le « registre S2 » du plan (lignes 546-565) est une **convention**, pas un fichier : le
repo co-localise les erreurs (`readonly code = "…"`) près de leur domaine (~41 codes
existants). On suit cette convention — **on ne crée pas de fichier registre central**
(ce serait un refactor hors scope, règle 7).

| Code | Levé par | HTTP / UI | Message utilisateur |
|---|---|---|---|
| `SESSION_EXPIRED` | `<GardeSession/>` (PR 2′) | modale | « Votre session a expiré. Reconnectez-vous pour continuer. » |
| `CONSENT_ACCOUNT_UNKNOWN` | `selectionnerComptesAction` (409 amont `ACCOUNT_NOT_FOUND`) | 400 | « Un des comptes sélectionnés n'est plus disponible. Rechargez la page. » |
| `CONSENT_SELECTION_DISABLED` | idem (400 amont `ACCOUNT_SELECTION_NOT_ENABLED`) | 400 | « La sélection de comptes n'est pas activée pour cette connexion. » |
| `CONSENT_REVOKE_SYNC_IN_PROGRESS` | `revoquerConsentementAction` (409 amont) | 409 | « Une synchronisation est en cours. Réessayez dans quelques minutes. » |
| `CONSENT_REVOKE_UPSTREAM_ERROR` | idem (5xx amont) | 502 | « La révocation n'a pas pu être transmise à votre banque. Réessayez. » |
| `CONSENT_NOT_FOUND` | consentement d'un autre tenant | **404** (jamais 403) | « Ressource introuvable. » |
| `AUDIT_PAYLOAD_INVALID` | `repositories/audit.ts` (liste blanche `payload`) | 500 | *(jamais affiché — bug applicatif, log + alerte)* |
| `AUDIT_SNAPSHOT_INCOMPLET` | `repositories/audit.ts` : impossible de résoudre l'identité de l'acteur au moment de l'écriture (§2.4) | 500 | *(jamais affiché)* — **fail-closed : on n'écrit PAS un consentement anonyme.** Un enregistrement réglementaire sans acteur est pire que pas d'enregistrement |
| `AUDIT_EXPORT_TOO_LARGE` | export JSON > seuil | 413 | « Journal trop volumineux. Filtrez par période. » |

Codes existants **réutilisés, à ne pas dupliquer** : `WORKSPACE_ACCESS_DENIED` (→ 404),
`CONNEXION_NOT_AUTHORIZED`, `FORBIDDEN_ROLE`, `NOT_AUTHENTICATED`, `OMNIFI_API_ERROR`,
`OMNIFI_TIMEOUT`, `OMNIFI_NETWORK_ERROR`.

Événements `audit_events.event_type` créés (VARCHAR(60), pas d'enum SQL — extensible
sans migration) : `consent.granted`, `consent.accounts_selected`,
`consent.revoke_requested`, `consent.revoked`, `consent.revoke_failed`,
`consent.revoke_noop`.

---

## 8. Cas à ajouter à la suite d'isolation (bloquante en CI)

Fichiers nouveaux sous `tests/isolation/`. Structure imposée par les existants : PGlite
+ migrations lues **depuis le dossier** + `drizzle/provisioning/tygr_app.sql` (source
unique) + `set role tygr_app` + assertion préalable `current_user = 'tygr_app'` (sans
elle, le test prouve du vide).

**`audit-append-only-isolation.test.ts`** (lot L3.1)
1. `UPDATE consent_records` sous `tygr_app` → refusé (trigger **et** privilège).
2. `DELETE consent_records` sous `tygr_app` → refusé.
3. Idem `audit_events` (4 cas).
4. **Sous l'owner** (`reset role`) : UPDATE et DELETE refusés **quand même** (le trigger
   est la défense indépendante du privilège). ← le cas qui prouve la garde n°3.
5. **Cascade + auto-suffisance (le cas qui prouve P1 et Q2)** : insérer un
   `consent_record`, puis `DELETE FROM bank_connections` **et** `UPDATE users SET
   email='autre@x.co'` → le DELETE **réussit** (pas de FK), le consentement **survit**,
   et sa relecture rend **exactement** la même chaîne lisible qu'à l'écriture
   (`institution_name`, `granted_by_email`, `granted_by_name` inchangés). Un `JOIN` n'est
   requis nulle part.
6. `INSERT` autorisé, `SELECT` autorisé (contre-preuve : le REVOKE n'a pas tout cassé).
7. Idempotence du script de provisioning (rejouer `tygr_app.sql` 2×).
7bis. `INSERT` de deux lignes applicatives (`omnifi_event_id IS NULL`) dans le même
   workspace → **autorisé** (les NULL ne violent pas UNIQUE). Cas de non-régression du
   commentaire de schéma Q4.

**`consent-tenant-isolation.test.ts`** (lot L3.2)
8. Workspace A lit `consent_records` sans `WHERE` sous `tygr_app` → **0 ligne** de B.
9. `enregistrerConsentement` avec un `connectionId` de B depuis le contexte A → la RLS
   `WITH CHECK` refuse l'INSERT (le `workspace_id` vient de `ctx`, pas du client).
10. `selectionnerComptesAction` sur une connexion de B → **404**, jamais 403 ; **aucun
    événement écrit** dans A ni dans B (vérifier `COUNT(*) = 0` **dans les deux**).
11. VIEWER de A → `FORBIDDEN_ROLE`, 0 ligne écrite.
12. `omnifi_event_id` : le même EventId inséré dans A puis dans B → **doit passer**
    (unicité composite, P2) ; deux fois dans A → **doit échouer** (idempotence).

**`revocation-isolation.test.ts`** (lot L3.3)
13. Révoquer une connexion de B depuis A → 404, aucun tombstone posé dans B.
14. `409` amont → **0 tombstone**, `consent.revoke_failed` présent, `REVOKED` présent
    (l'intention reste — c'est le contrat §2.3).
15. La purge logique ne franchit pas la frontière : `is_removed` posé **uniquement** sur
    les transactions de la connexion révoquée, jamais sur les autres comptes du workspace.
16. Aucun `DELETE` physique n'est tenté (le trigger `BEFORE DELETE` de `0004` ne lève
    jamais pendant le parcours de révocation — s'il lève, le code est faux).

**`audit-export-isolation.test.ts`** (lot L3.4)
17. Export JSON du workspace A ne contient **aucune** ligne de B (grep sur les UUID de B).
18. Export avec 0 événement → fichier JSON valide `[]` + en-têtes HTTP (D2 ligne 752),
    jamais 404.
19. Non-ADMIN sur `/audit` → 404 (surface cachée, pas 403 : pas d'oracle d'existence).

---

## 9. Séquence d'implémentation figée (attente du go, lot par lot)

Les six décisions sont arbitrées (journal en tête de fichier). **Le plan est figé.**
L'implémentation démarre au **go explicite de l'humain, lot par lot** — pas de
déclenchement en chaîne.

Rappel de discipline pour **chaque** lot, sans exception :

1. `git fetch` puis branche **depuis `origin/main` à jour** (jamais depuis une branche de
   feature — leçon *incident-branche-base-perimee*). Vérifier `git branch --show-current`
   **avant chaque commit** (leçon *branche-bascule-entities-lot*).
2. Vérifier les **branches concurrentes** avant de coder (`git branch -r`,
   `git worktree list`) : recouvrement → STOP + arbitrage (règle 7).
3. Commits **par unité logique**, jamais `git add -A`.
4. **Stop-loss (règle 5)** : aucun commit si `lint`, `tsc --noEmit` ou le build échouent.
   Rappel de terrain : `lint` + `tsc` ne voient **ni** les erreurs de rendu `"use server"`,
   **ni** les casses de build — exécuter la vraie suite d'isolation **et** `next build`
   (leçon *sandbox-vitest-build-marchent*).
5. **Cross-review contradictoire** (règle 6) par un contexte frais avant de pousser.
6. **STOP à la PR poussée.** L'agent n'ouvre pas la PR, ne merge pas (Human-in-the-Loop,
   règles 2 et 4). Ce chantier est **applicatif** (schéma, RLS, sécurité) → aucun
   auto-merge, dans aucun cas.

| Ordre | Lot | Branche | Effort | Dépend de | Contenu |
|---|---|---|---|---|---|
| **1** | **PR 2′** | `feature/epic1-d2-finition` | M | — | Modal re-login (bloquant du consent flow), tooltip VIEWER (D2 #37), runbook premier ADMIN |
| **2** | **L3.1** | `feature/epic1-schema-audit` | M | — | Migration `0021` : `consent_records` + `audit_events`, snapshots (§2.4), UNIQUE composite, **trois gardes** append-only, `tygr_app.sql` |
| **3** | **L3.2** | `feature/epic1-consent-emission` | L | L3.1 | `repositories/audit.ts` (seul écrivain), émission `GRANTED` + `ACCOUNTS_SELECTED`, `masquerCompte()` |
| **4** | **L3.3** | `feature/epic1-revocation` | L | L3.2 | `DELETE /connections/{ConnectionId}`, `REVOKED`, purge **logique**, événements correctifs |
| **5** | **L3.4** | `feature/epic1-audit-ui` | M | L3.2 | Panneau `/audit` **ADMIN seul** + export JSON, 5 états D2 |

**Pourquoi PR 2′ passe en premier** (décision Q6). Ce n'est pas du polish : une session
JWT qui expire pendant le widget MFA fait perdre le `SessionToken` Omni-FI, et le job de
sync avec. Sans la modal re-login, **le consent flow d'Epic 1 casse sur expiration de
session** — c'est-à-dire la démo elle-même. Le lot doit précéder tout ce qui s'appuie sur
le widget.

**Pourquoi L3.1 est indépendant de PR 2′.** Les deux peuvent être menés en parallèle par
deux agents (worktree isolé + `npm install` réelle — Turbopack rejette le symlink, leçon
*protocole-collaboration-deux-agents*). Ils ne partagent aucun fichier. Si un seul agent
travaille : ordre nominal ci-dessus.

**Pourquoi L3.3 avant L3.4** (décision Q5). La démo régulateur exige le **cycle de vie
complet** (consentement → sélection → révocation), pas seulement un journal qui s'affiche.
Aucune contrainte de date Innov8 n'a été trouvée dans les sources qui justifierait
d'inverser. Si une telle date apparaît, l'inversion est possible (L3.4 ne dépend que de
L3.2) — au prix d'un jalon intermédiaire « démo sans révocation », à assumer explicitement.

### Points de STOP obligatoires pendant l'implémentation (règle 7)

- **Q3 rouverte** : découverte d'un engagement RGPD art. 17 écrit → **STOP immédiat**,
  remonter. Ce n'est plus un lot mais une refonte crypto-shredding (§6/P5).
- **3 tentatives échouées** sur le même problème → STOP + synthèse tenté/écarté/reco.
- **Découverte qui change le périmètre** (schéma, sécurité, comportement de l'API amont)
  → STOP + question. Expansion de scope silencieuse interdite ; tout différé devient une
  entrée TODOS.md.
- **Le trigger append-only lève pendant le parcours de révocation** → le code est faux,
  ne jamais désarmer le trigger pour « faire passer » (règle 9 : dette d'append-only
  interdite).

---

## 10. Ce que ce plan n'entreprend PAS (dettes à consigner dans TODOS.md, règle 9)

Chaque entrée porte **priorité + déclencheur** (l'événement qui la rend due), jamais
« un jour » (règle 9). À créer dans TODOS.md au premier lot, datées 2026-07-10.

| Item | Priorité | Déclencheur |
|---|---|---|
| **Ouverture du journal d'audit hors ADMIN** (Vision Entité → jointure `connection_id → bank_accounts.entity_id`, + policy RLS `entity_scope`). Décision **Q1** : fail-closed ADMIN-only en attendant. Effort ~1 j | **P2** | demande client explicite |
| Route `/api/webhooks/omnifi` (+ HMAC, quarantaine `webhook_events_pending`). ⚠️ **DOIT** résoudre le tenant d'abord (`WEBHOOK-TENANT-FIRST1`) — l'unicité composite Q4 en dépend | P1 | Epic « pipeline sync durable » |
| `POST /widget/session/revoke` au `unload` du widget (**hygiène de session**, ≠ révocation de consentement — cf. §1.c) | P2 | polish du widget |
| Changement de mot de passe utilisateur (`AUTH-MDP-TEMPO1`) | P1 | premier déploiement production |
| **Dette #6** (`TODOS.md:1826`) : `created_by → SET NULL` pour l'offboarding RGPD. **Débloquée par Q2** — les snapshots (§2.4) rendent le `SET NULL` sans danger pour l'audit | P1 | premier offboarding réel |
| Purge périodique de `login_attempts` | P2 | branchement des crons |
| Table `sync_runs` (observabilité) | P1 | Epic pipeline sync |
| CONTRACT des UNIQUE composites (`0018` EXPAND livré, cf. TODOS 1.1) | P1 | release suivante |

**Hors dette, à ne jamais différer** (règle 9 : dette interdite sur l'isolation tenant,
l'append-only et les montants) : les trois gardes append-only de §2.2, les cas
d'isolation de §8, et le `404 jamais 403` de chaque nouvel endpoint.
