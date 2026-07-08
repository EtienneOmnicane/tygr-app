# PLAN — Bandeau & sélecteur groupés par TITULAIRE (Omni-FI Party)

> Phase : **CONCEPTION** (CLAUDE.md règle 1). Ce document est le plan de référence.
> AUCUNE ligne de code applicatif ne sera écrite avant validation humaine de ce plan
> + revue indépendante (règle 6). L'implémentation est une requête SÉPARÉE.
>
> Statut : proposé — 2026-07-07. Auteur : agent (Cowork). À valider : Etienne.

## 0. Demande

Le bandeau gauche du dashboard (« COMPTES CONNECTÉS ») est un scroll plat de ~87
comptes ; le sélecteur de périmètre en tête (« Vue Groupe ») liste ces 87 comptes à
plat dans son onglet « Par compte ». Etienne veut **grouper les deux par entité**,
en accordéon, en **dérivant le nom du groupe du titulaire remonté avec chaque compte**
(champ `PartyName` d'Omni-FI).

### Décision d'axe (arbitrée avec Etienne, 2026-07-07)

Groupement par **TITULAIRE Omni-FI (Party)** — PAS par l'entité/BU TYGR.

Distinction critique (deux « entités » homonymes dans le code) :
- **Party (titulaire)** = détenteur légal du compte, remonté à chaque sync via
  `OmniFiAccount.PartyId` / `PartyName`. Auto-ingéré, **descriptif**, aucune portée
  sécurité.
- **Entité (BU) TYGR** = regroupement business OPTIONNEL au-dessus des parties, avec
  son propre scoping RLS (`entity_scope`) et un sas d'assignation ADMIN. C'est l'axe
  de l'onglet « Par entité » (vide chez Etienne car aucun compte n'est assigné).

Raisons du choix « titulaire » : la donnée est **déjà en base** (peuplée à chaque
sync), le groupement est **purement présentationnel** (zéro nouvelle surface
d'isolation), et il « nettoie » le scroll immédiatement sans exiger d'assignation
manuelle. Le pré-remplissage des BU depuis les parties (dette P2 **ENTITY-PARTY1**)
reste un chantier distinct, non couvert ici.

## 1. État existant (cartographie vérifiée)

### 1.1 Modèle de données (déjà en place — migration 0013)

- `parties` (`schema.ts:866`) : `id` uuid, `workspaceId`, `entityId` (nullable, lien
  BU), `omnifiPartyId` (dédup), `name` = `PartyName` (nullable), `isActive`.
  UNIQUE `(workspace_id, omnifi_party_id)`. Policy `tenant_isolation`.
- `account_party_role` (`schema.ts:918`) : liaison **N-N** compte↔party. PK
  `(workspace_id, bank_account_id, party_id)`, `ownershipType`, `isPrimary`. FK
  composite scopée workspace. Policy `tenant_isolation`.
- `bank_accounts.entity_id` (nullable) : lien BU direct — **non concerné** par ce plan.

### 1.2 Pipeline d'ingestion (déjà branché — tourne à CHAQUE sync)

- `versPartie(OmniFiAccount)` (`ingestion.ts:323`) → `PartieAUpserter | null`
  (null si `PartyId` absent).
- `upsertPartieEtRole(...)` (`ingestion.ts:~353`) : upsert `parties` +
  `account_party_role`, avec `isPrimary: true` (ingestion.ts:379 — **un compte a
  aujourd'hui 0 ou 1 party**, `PartyId` scalaire, DÉCISION 1 L3).
- `ingererPartiesDesComptes(...)` (`orchestration.ts:256`) : appelé APRÈS le commit
  des comptes, transaction séparée, best-effort fail-soft (une party malformée ne
  casse jamais l'ingestion bancaire ; les erreurs systémiques de tenancy re-throw).

**Conséquence** : pour les 87 comptes déjà synchronisés d'Etienne, `parties` +
`account_party_role` sont **déjà peuplés** (dans la mesure où l'amont fournit un
`PartyId`). Aucun travail d'ingestion requis. (À vérifier en L1 : compter les lignes
`account_party_role` du workspace — cf. §6 note de vérification.)

### 1.3 Lecture (à étendre)

- `CompteConnecte` (`dashboard.ts:42`) : `bankAccountId, accountName,
  institutionName, currency, currentBalance, lastSyncedAt`. **PAS de titulaire.**
- `listerComptes(tx)` (`dashboard.ts:145`) : SELECT FROM `bankAccounts` INNER JOIN
  `bankConnections`, WHERE `isSelected = true`, ORDER BY `accountName`. Tourne sous
  `withWorkspace` (RLS tenant + entity_scope + account_scope appliquées).

### 1.4 Points de montage (les DEUX consomment le MÊME `listerComptes`)

- **Bandeau gauche** : `ConnectedAccountsCard({ comptes })`
  (`connected-accounts-card.tsx`) ← `DashboardContent` (`dashboard-content.tsx:120`)
  ← `page.tsx:92` (`listerComptes(tx)`). Composant PUR, server-render, `<ul>` plat.
- **Sélecteur haut** : `PerimetreSwitcher({ comptes, entites, viewFilterActif })`
  (`perimetre-switcher.tsx`) ← `AppHeader` ← `layout.tsx:141` (`listerComptes` avec
  session SANS viewFilter, transaction séparée). `"use client"`. Onglet « Par
  compte » = listbox plat de checkboxes, poste `<input hidden name="bankAccountId">`
  via `definirViewFilter`. Onglet « Par entité » = axe BU (inchangé).

**Le seam** : ajouter le titulaire à `CompteConnecte` / `listerComptes` **une fois**
alimente les DEUX consommateurs sans duplication de lecture.

## 2. Invariants NON négociables

1. **Isolation (règle 2)** : le groupement est **display-only**. Chaque compte
   visible reste rendu ; AUCUN compte n'est masqué par le groupement. Le périmètre
   de sécurité reste 100 % dans la RLS. Le titulaire est un **libellé**, jamais un
   filtre. « Le filtre de périmètre vit dans la RLS, JAMAIS dans le .tsx ».
2. **Sélecteur = confort (règle 2)** : l'onglet « Par compte » continue de poster
   `bankAccountId` ; le serveur intersecte toujours DROIT ∩ filtre. Le groupement par
   titulaire est un simple sous-titre visuel dans la liste — **aucun nouveau champ
   posté, aucune nouvelle Server Action, aucune traduction titulaire→comptes**.
3. **Lecture sous RLS (règle 2)** : la lecture du titulaire JOINT `account_party_role`
   + `parties` mais reste **pilotée par `bank_accounts`** (le scope mord par la
   jointure — ENTITY-READ-JOIN1). `parties`/`account_party_role` portent en plus leur
   propre `tenant_isolation`. Pas de `workspace_id` en paramètre.
4. **Règle 8 (montants)** : v1 n'affiche AUCUN solde agrégé par groupe (voir D5) —
   on évite toute somme cross-devise / tout float. Les soldes par compte restent
   formatés via `format-montant.ts`, jamais tronqués.
5. **Zéro migration** : toutes les tables/colonnes existent. Ce plan est
   **lecture + UI uniquement**. Aucune modification de schéma, aucun risque DB.
6. **PII (règle 8)** : le nom du titulaire (potentiellement un nom de personne) est
   une donnée d'AFFICHAGE sous RLS — jamais loggé, jamais en télémétrie, jamais dans
   un message d'erreur. Même traitement que `accountName` aujourd'hui.

## 3. Décisions de conception

- **D1 — Champ ajouté à `CompteConnecte`** : `holderId: string | null` (=
  `parties.id`, clé de groupe stable) + `holderName: string | null` (= `parties.name`,
  libellé). Nullable = compte sans party exploitable → bucket « Non regroupé ».
  Optionnel côté type ⇒ les consommateurs existants qui l'ignorent restent valides.

- **D2 — Lecture 1:1 garantie (anti-multiplication de lignes)** : `listerComptes`
  doit rester **une ligne par compte**. Un LEFT JOIN nu sur `account_party_role`
  multiplierait les lignes le jour où un compte joint porte N parties (gonflant le
  « 87 »). Donc : récupérer la party **primaire** via sous-requête corrélée /
  `DISTINCT ON (bank_account_id) … ORDER BY is_primary DESC, name` (au choix
  d'implémentation), garantissant 0/1 titulaire par compte. Aujourd'hui (party
  scalaire) le résultat est trivialement la party unique ; le motif est déjà
  **joint-ready** pour demain sans re-toucher les consommateurs.

- **D3 — Groupement en composant (pas en SQL)** : `listerComptes` reste plat (retourne
  `CompteConnecte[]` enrichi de `holderId`/`holderName`) ; le groupement vit dans une
  **fonction pure** `grouperParTitulaire(comptes)` réutilisée par le bandeau ET le
  sélecteur. Motif : la lecture reste simple et partagée ; le groupement est une
  préoccupation de vue (règle 2 : présentationnel). Retour : liste ordonnée de
  `{ holderId, holderName, comptes }`, bucket null en DERNIER.

- **D4 — Bandeau en accordéon natif `<details>/<summary>`** : zéro dépendance
  (règle 9), garde `ConnectedAccountsCard` **server-render** (pas de `"use client"`).
  - `summary` = nom du titulaire (tronqué) + compteur `N comptes`.
  - Corps = les lignes compte ACTUELLES (banque + nom + solde), markup réutilisé tel
    quel (aucune régression de formatage montant).
  - Tri : titulaires par nom (locale « fr ») ; « Non regroupé » toujours en dernier.
  - **Repli mono-groupe** : si < 2 groupes (un seul titulaire, ou tous null), on
    retombe sur la **liste plate actuelle** (pas d'accordéon superflu à un seul volet).
  - Défaut : **tous repliés** (c'est l'objectif — nettoyer le scroll). Compteur visible
    sur chaque `summary` pour l'orientation.

- **D5 — Pas de solde agrégé par groupe en v1** : le `summary` porte le **compteur**,
  pas une somme. Un sous-total par devise (multi-devises, virgules alignées, décimal-
  string) est un **follow-up** explicite (§7) — hors périmètre v1 pour éviter le piège
  cross-devise/float (règle 8). Décision à confirmer avec Etienne.

- **D6 — Sélecteur « Par compte » : sous-titres titulaire, sémantique inchangée** :
  dans la listbox de l'onglet « Par compte », insérer des **sous-en-têtes titulaire**
  (non cliquables, ou avec un « cocher tout ce titulaire » optionnel) au-dessus des
  comptes correspondants. Les cases restent per-compte, la recherche inchangée, les
  `<input hidden name="bankAccountId">` inchangés. **Aucun** nouvel onglet, **aucune**
  nouvelle action, **aucun** nouveau champ. C'est l'interprétation minimale et sûre de
  « nettoyer le sélecteur ». L'onglet « Par entité » (axe BU) reste tel quel.

- **D7 — Bucket « Non regroupé »** : libellé sobre `text-muted` (« Non regroupé » /
  « Sans titulaire »), jamais un « null » brut. Rassemble les comptes sans `PartyId`
  exploitable. Toujours présent si ≥1 compte sans titulaire, toujours en dernier.

## 4. Découpage en lots (implémentation — requête séparée)

Chaque lot livre ses critères de sortie (règle 3) DANS le même PR.

- **L1 — Lecture titulaire** : étendre `CompteConnecte` (D1) + `listerComptes` (D2,
  party primaire, 1:1 garanti). Exit : type à jour ; les deux call sites (page.tsx,
  layout.tsx) compilent sans changement (champ additif) ; couverture répertoire
  (compte avec party → holderName ; sans → null) ; cas isolation ajouté (§5).

- **L2 — Helper pur** : `grouperParTitulaire(comptes)` (D3) + tests unitaires (tri,
  bucket null en dernier, repli mono-groupe, égalité de nom → désambiguïsation par
  `holderId`). Zéro React, testable en isolation.

- **L3 — Bandeau accordéon** : `ConnectedAccountsCard` en `<details>` (D4, D7),
  repli mono-groupe, markup compte réutilisé. Reste PUR/server. Visual QA (§5).

- **L4 — Sélecteur groupé** : sous-en-têtes titulaire dans « Par compte » (D6).
  Sémantique de sélection et champs postés **inchangés** (à prouver : le POST envoie
  toujours exactement les `bankAccountId` cochés). Visual QA.

- **L5 — Démo + QA + cross-review** : fixtures multi-titulaires dans
  `src/app/demo/dashboard/` (et démo sélecteur) couvrant : ≥2 groupes repliés,
  groupe déplié, mono-groupe (repli plat), bucket « Non regroupé ». Capture headless
  comparée à `UI_GUIDELINES.md` (Gate 4). Revue indépendante (règle 6).

## 5. Tests & Visual QA (règle 3 + Gate 4)

- **Unitaire** : `grouperParTitulaire` (déterminisme, null bucket, mono-groupe,
  homonymie via id).
- **Répertoire** : `listerComptes` renvoie `holderName` pour un compte avec party,
  `null` sinon ; **une seule ligne par compte** même avec 2 rôles party (anti-D2-
  régression).
- **Isolation (bloquant CI, règle 3)** : la lecture joint désormais 2 tables tenant
  supplémentaires. Ajouter/confirmer un cas : un `PartyName` d'un AUTRE workspace
  n'apparaît JAMAIS (parties.tenant_isolation + jointure pilotée bank_accounts).
  Confirmer aussi qu'en Vision Entité, un compte hors scope (et son titulaire)
  restent masqués (héritage par jointure).
- **Visual QA (Gate 4)** : états capturés via la démo hors auth/DB, comparés par
  vision à `UI_GUIDELINES.md` (accordéon, densités, `tabular-nums` des soldes,
  troncature libellés / jamais des montants, focus visibles, tokens sémantiques —
  aucun vert/rouge hors donnée).

## 6. Vérification préalable (avant L1, non bloquante pour ce plan)

Confirmer que la donnée titulaire est bien peuplée pour le workspace d'Etienne
(sinon L1 livre un groupement où tout tombe dans « Non regroupé »). Lecture SANS PII :
`COUNT(*)` et `COUNT(DISTINCT party_id)` sur `account_party_role` du workspace (jamais
`SELECT name`). Si le compte est ~0 alors que la sync a tourné, investiguer si l'amont
fournit `PartyId` (fail-soft `ingererPartiesDesComptes` a pu avaler des erreurs de
données) AVANT d'implémenter l'UI.

## 7. Hors périmètre / follow-ups (à consigner TODOS.md si retenus)

- **Sous-total de solde par groupe** (D5) : multi-devises, virgules alignées, décimal-
  string (règle 8). Décision produit + effort séparé.
- **« Cocher tout ce titulaire »** dans le sélecteur (D6) : ergonomie, optionnel.
- **Party joint N-N** : le jour où l'amont expose `Parties[]`, seul `versPartie` +
  la sélection de party primaire (D2) évoluent ; les consommateurs ne bougent pas.
- **Pré-remplissage BU depuis parties** (dette P2 **ENTITY-PARTY1**) : transformer les
  titulaires en entités TYGR pour allumer le vrai scoping RLS entité — chantier
  distinct, NON couvert ici.

## 8. Pushback (règle 10)

- **Risque** : interpréter « nettoyer le sélecteur » comme un changement de sémantique
  (nouvel axe « Par titulaire » posté au serveur) créerait une nouvelle surface de
  filtre à sécuriser pour un gain nul (le titulaire n'a pas de portée droit).
  **Alternative retenue (D6)** : sous-titres visuels only, sémantique et champs postés
  inchangés. Coût quasi nul, zéro surface sécurité.
- **Risque** : un LEFT JOIN nu multiplierait les comptes (joint futur) → « 87 » faux.
  **Alternative retenue (D2)** : party primaire, 1:1 garanti, joint-ready.
- **Risque** : agréger les soldes par groupe = piège cross-devise/float.
  **Alternative retenue (D5)** : compteur only en v1, sous-total = follow-up cadré.
- Si la demande d'Etienne était en réalité l'axe BU (scoping réel), ce plan ne le
  couvre pas → rouvrir sur ENTITY-PARTY1 (chantier plus lourd : modèle + sas + RLS).
