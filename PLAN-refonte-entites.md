# PLAN — Refonte de la page `/admin/entites`

> **Fichier canonique unique** de ce chantier, **mis à jour en place** (v1 → v2). Il n'y a
> pas de second plan à côté. La v1 (2026-07-08, mergée PR #182) reste intégralement
> traçable dans la **table de réconciliation** (§2) — aucune de ses décisions n'est
> abandonnée en silence.
>
> **Phase : conception (Règle 1).** Aucune ligne de code applicatif tant qu'Etienne n'a
> pas tranché les **questions ouvertes** (§9).
>
> - **v1** — 2026-07-08 · portée : le **sas de propositions** seul. Plan validé et mergé,
>   **implémenté à ~0 %** (PR #182 n'a mergé que le *document*).
> - **v2** — 2026-07-13 · portée élargie : **l'architecture de l'information de toute la
>   page**. Intègre les décisions Etienne du 2026-07-13 (§0) et les constats des **deux
>   cross-reviews indépendantes** (§11).
>
> **Ce qui NE bouge pas :** le modèle de données, les deux étages d'isolation, le
> placement de `entity_id`, et l'invariant « le sas n'écrit rien sans confirmation ».

---

## 0. Décisions actées — 2026-07-13 (Etienne)

| # | Décision | Effet sur ce plan |
|---|---|---|
| **Q1 — Langue** | **Destination = ANGLAIS** (utilisateurs mauriciens anglophones). Ne figer **aucun** libellé FR comme livrable. La **migration EN de toute l'app** = **chantier nommé À PART** (pas d'expansion de scope — règles 7/9) → entrée TODOS à ouvrir. Pour cette refonte : **zéro nouvelle copie FR en dur**. | Le volet « vocabulaire FR » des lots disparaît. **Mais aucun socle i18n n'existe** (vérifié : ni `next-intl`, ni `react-i18next`, ni `messages/`, ni `locales/`) → **remonté en Q-LANG**, non décidé seul. |
| **Q2 — Libellé de compte** | **UNE seule source : `libelleCompte()`**, utilisée par les **deux** surfaces (tableau **et** sas). Le repli du 8 juillet (« 4 derniers de l'id Omni-FI ») est **SUPERSÉDÉ**. | ⚠️ **Conséquence serveur non triviale** : unifier exige `institutionName` dans `CompteDeProposition` → **L4 n'est PAS « zéro serveur »** (§5-L4). |
| **Q2-bis — Principe métier** | Données Omni-FI prises **à l'exactitude**. **Jamais d'auto-fusion** : on **SURFACE** les doublons et on laisse l'admin **basculer** avec sa connaissance métier. | Structure la bannière/panneau (§5-L4) **et** recadre Q-CASSE (§9). |
| **Q3 — Action groupée** | **BATCH serveur confirmé** (atomique, un seul `revalidatePath`, un cas d'isolation propre). | Fige la voie (b) de L3. La cross-review impose d'**aller au bout du gabarit** : 1 `SELECT` + **1 `UPDATE` groupé**, pas 500 UPDATE en boucle (§5-L3). |
| **Q5 — Branche en vol** | **ABSORBER** `feat/entites-select-ui` (merge trivial, 0 conflit). Pas de séquencement lourd. | §8. À fermer **avant** que L4 ne démarre. |

### 0-bis. Réponse à la sous-question d'Etienne sur l'id Omni-FI

> *« Si l'"id Omni-FI" visé n'est PAS une donnée bancaire (réf interne stable),
> remonte-le en question ; sinon on garde le suffixe uuid interne. »*

**Je le remonte : `omnifi_account_id` n'est PAS une donnée bancaire.** C'est un **UUID
technique de l'API Omni-FI** (`docs/documentation_api.md:771` : « `AccountId` | string |
**UUID Omni-FI du compte** » ; `schema.ts:306` `varchar(64)`). Il n'existe **ni IBAN ni
numéro de compte** dans tout le schéma.

**Mais cela ne ressuscite pas D3 — et pour une raison plus forte que la règle 8 :**
1. Les « **4 derniers chiffres** » d'un UUID sont **4 caractères hexadécimaux opaques**.
   Ils n'identifient rien pour un humain, et sont **moins discriminants** que les 8
   caractères d'uuid TYGR déjà utilisés par `libelleCompte()`.
2. Surtout, la forme « …1234 » **mime un masque de numéro de compte** — un masque que la
   base **ne peut pas fournir**. On afficherait à un directeur financier ce qui *ressemble*
   aux 4 derniers chiffres de son compte bancaire, et qui n'en est pas.

**D3 demandait un masquage bancaire que la donnée ne permet pas.** → La décision Q2
(garder le suffixe uuid interne via `libelleCompte()`) **tient**, avec une justification
renforcée. Supersession tracée en §2.1.

---

## 1. Diagnostic — ce qu'on corrige

Cinq défauts d'**architecture de l'information**, aucun de logique :

1. **Organisée par verbe, pas par objet.** On rattache un compte à une entité à **deux
   endroits**, avec deux interactions → l'admin ne sait plus où est la vérité.
2. **L'ordre est à l'envers du geste réel.** Le rangement des comptes — le cœur — est la
   **dernière** section.
3. **Aucune vue d'état.** Impossible de savoir combien de comptes restent « non assignés »
   (donc **invisibles aux membres restreints**). C'est pourtant LE reste-à-faire.
4. **Le vocabulaire fuit la technique amont** (« Party », « sas », « Vision Globale »).
5. **Friction opérationnelle majeure** : ~87 comptes rattachés **un par un**
   (`ENTITY-ASSIGN-BULK1`, **P1**, déclencheur **levé**).

**Défaut n° 6 (révélé par la recon)** : la page est en `max-w-3xl` (`page.tsx:108`) alors
qu'`UI_GUIDELINES §1.1` prescrit pour l'Admin « la table pleine largeur EST l'écran ».
`/admin/membres` (`page.tsx:68`) a **le même défaut** → Q-PERIMETRE.

**Défaut n° 7 (révélé par la cross-review sécurité — LE PLUS GRAVE, préexistant)** : la
page **s'exécute déjà sous un périmètre réduit** sans le savoir. Voir §3.3.

---

## 2. Réconciliation avec le plan v1 (2026-07-08)

Discipline de decision-log : **une décision actée ne se re-litige pas en silence.**

### 2.1 Décisions produit du 8 juillet

| # | Décision (2026-07-08) | Sort | Justification |
|---|---|---|---|
| D1 | Bouton « Vue » → « Tous les comptes » / « Toutes les entités » | **GARDER** (clos) | Déjà livré (PR #181). Hors périmètre. |
| D2 | **Refus d'un compte = « laisser non assigné »** (aucune migration ; compromis : le compte **réapparaît** au prochain sync) | **GARDER** | Compatible avec la nouvelle IA. Le texte d'aide qui l'explique reste dû (**Q-RESYNC**). |
| D3 | Libellé de repli = `…{4 derniers de omnifiAccountId} · {devise}` | ❌ **SUPERSÉDÉ** (Etienne, 2026-07-13) | Remplacé par **`libelleCompte()`, source unique** pour les deux surfaces. Motif renforcé (§0-bis) : `omnifi_account_id` est un **UUID technique**, ses 4 derniers caractères sont **opaques et moins discriminants** que l'uuid TYGR, et **miment un masque bancaire inexistant**. |
| D4 | Vocabulaire « Party » → question **CLOSE**, retraduction EN en fin de projet | ✅ **CONFIRMÉ et ÉTENDU** (Etienne, 2026-07-13) | La destination anglaise est **actée**. La migration EN devient un **chantier nommé à part**. Cette refonte n'ajoute **aucune copie FR**. |
| D5 | Plan écrit d'abord | **GARDER** | Ce document. |

### 2.2 Lots du plan v1

| Lot v1 | Sort | Où il atterrit |
|---|---|---|
| **Lot 1** — lisibilité des comptes sans nom (libellé de repli · liste défilable · « tout cocher » tri-état · compteur) | **ÉTENDRE** | Absorbé par **L4**. Le « tout cocher » se **mutualise** avec **L3** (mêmes helpers purs, §3.2). Le libellé → **Q2, tranché**. |
| **Lot 2** — `<select>` natif → `ui/select` | **ABSORBER** (merge, §8) | Déjà écrit (`f078dee`). ⚠️ La dépendance que la v1 croyait bloquante (« `ui/select` pas encore dans main ») est **LEVÉE**. |
| **Lot 3** — feedback après Confirmer (carte « traitée », `peutConfirmer` resserré) | **GARDER / ÉTENDRE** | Intégré à **L4**. ⚠️ La cross-review montre que le mécanisme prévu **ne suffit pas** (§11-S3). |
| **Lot 4** — polish des cartes de proposition | **SUPERSÉDER (partiellement)** | Les cartes cessent d'être une section → bannière + panneau (**L4**). |

### 2.3 Les lots v1 recouvrent-ils la refonte ?

**Non.** La v1 ne traitait que le **sas** (1 des 3 sections) : rien sur le bandeau, l'ordre,
le rangement en masse, la création d'entité. Les deux plans **se complètent** ; ils ne se
doublonnent que sur le sas — et c'est là qu'on **fusionne** (L4) au lieu d'empiler.

---

## 3. Ce qui existe déjà — et ce qui est cassé

### 3.1 Correction du brief — la création d'entité est du **câblage UI**

Les trois Server Actions **existent, complètes** (zod `.strict()`, garde ADMIN, erreurs
nommées) et **ne sont branchées sur aucun bouton** (vérifié : 0 occurrence hors
`actions.ts`) :

| Action | Ligne |
|---|---|
| `creerEntiteAction` | `actions.ts:145` |
| `renommerEntiteAction` | `actions.ts:168` |
| `archiverEntiteAction` | `actions.ts:194` |

→ Le lot de création se réduit à **une surface UI + ses états** (+ `revalidatePath`).
⚠️ **Mais câbler `archiverEntiteAction` réveille un défaut dormant** — voir §3.4.

### 3.2 Briques réutilisables (à NE PAS reconstruire)

| Brique | Emplacement | Usage |
|---|---|---|
| 11 fonctions repo, **100 % sous `exigerAdmin`** | `entites.ts:211` | Intactes. |
| `EntiteLue.nbComptes` (agrégat SQL) | `entites.ts:110`, `:239` | Bandeau. ⚠️ **ment dans les mêmes cas que §3.3**. |
| `grouperParEntite` (groupement par entité) | `assignation-comptes.tsx:106` | **Existe déjà.** |
| **`etatSelectionGroupe`** / **`basculerGroupe`** | `lib/grouper-titulaire.ts:136`, `:158` | **Purs, génériques sur `{bankAccountId}`** (`holderId`/`holderName` **optionnels**) → servent L3 **et** L4. ⚠️ **Dette de nommage** : importer un module « titulaire » dans un écran d'**entités** → extraire vers `lib/selection-groupe.ts` (~15 min). |
| `Select` (`role="combobox"`) | `ui/select/select.tsx` | ⚠️ **Ne poste RIEN** dans un `<form>` → `FormData` programmatique (`assignation-comptes.tsx:369`) ou hidden **frère**. |
| `Modal` (`dismissible={false}` = destructif) | `ui/modal/modal.tsx:41` | Création (L2) + confirmation (L5). |
| `EmptyState`, `StateCard`, `SkeletonBlock`, `AppErrorState` | `ui/states/` | Tous les états. |
| **`indicateurDevise()`** | `format-montant.ts:107` | Tue `POLISH1 (a)` en une ligne. |
| `libelleCompte()` | `assignation-comptes.tsx:75` | **Source unique** (Q2). |
| `<tr sticky top-0 z-10>` | `transactions-table.tsx:40` | Tue `STICKY1`. |
| Multi-sélection + tri-état (`indeterminate` par `ref`) | `perimetre-switcher.tsx:435-509` | Gabarit de bulk. Le piège a11y est **déjà résolu**. |
| Suite d'isolation — **25 cas** entités | `tests/isolation/entites-admin-isolation.test.ts` | ⚠️ Ne couvre **pas** `renommerEntite`/`archiverEntite` sous MANAGER (§11-F1). |

**N'existe pas** (à créer, zéro dépendance externe — règle 9) : `Checkbox`, `Table`, barre
d'action groupée, `Bannière`/`Callout`, `ConfirmDialog`, `Toast`.

### 3.3 🔴 DÉFAUT PRÉEXISTANT — la surface admin s'exécute **déjà** sous un périmètre réduit

**C'est le constat le plus grave de tout le chantier, et il est antérieur à ce plan.**

Chaîne de preuve (cross-review sécurité, confiance 9/10) :

1. `exigerSessionWorkspace()` (`server/auth/session.ts:94`) remonte **toujours** le
   `viewFilter` du JWT.
2. `page.tsx:55,64` passe la session **complète** à `withWorkspace`.
3. `tenancy.ts:392-399` : si `viewFilter` est non vide et `accountScope.mode === "GLOBALE"`
   (**le cas nominal d'un ADMIN**), le GUC `app.current_view_filter` est posé **tel quel**.
4. `drizzle/migrations/0016_account-scope-l4.sql:66-94` : la policy `account_scope` sur
   `bank_accounts` est **`AS RESTRICTIVE FOR ALL`** et filtre sur ce GUC — en **USING**
   *et* en **WITH CHECK**.
5. Le **`PerimetreSwitcher` est monté dans le layout `(workspace)`** (`layout.tsx:210`) →
   **il est présent sur `/admin/entites` elle-même**, et le filtre **persiste dans le JWT**.

**Mode de défaillance (2 clics, aujourd'hui, en prod)** : l'ADMIN sélectionne
« Périmètre → Entité A » dans le header, puis ouvre `/admin/entites`. `listerComptesAvecEntite`
(`entites.ts:277`) **et** le `leftJoin` qui calcule `nbComptes` (`entites.ts:242`) sont
**amputés**. Le compteur prévu en L1 afficherait **« 0 compte non assigné »** alors que 77
le sont — le reste-à-faire, *raison d'être du bandeau*, serait **faux**.

**Corollaire ÉCRITURE — le piège de la demi-correction** : le `WITH CHECK` s'applique aussi
à l'`UPDATE`, et l'action batch rappelle `exigerSessionWorkspace()` → **récupère de nouveau
le `viewFilter`**. Corriger la lecture sans l'écriture ⇒ l'ADMIN voit 87 comptes, en
sélectionne 50, et **le lot entier échoue** (atomicité) sur « Ressource introuvable. ».
100 % reproductible.

**Le dépôt connaît déjà le remède** : `layout.tsx:148-157` et `(workspace)/actions.ts:124-131`
lisent dans une transaction **séparée**, avec une session **amputée du `viewFilter`**
(`{userId, activeWorkspaceId}`), *« sinon la clause AND view_filter de la policy
account_scope amputerait la lecture (mécanique du bug #143) »*. **Jamais appliqué à
`/admin/entites`.**

→ **Q-PERIMETRE-ADMIN** (§9). Fail-closed (aucune fuite), mais **l'ADMIN croit avoir tout
rangé**.

### 3.4 🔴 DÉFAUT DORMANT que L2 réveille — archiver une entité **ne révoque aucun accès**

1. `archiverEntite` (`entites.ts:554-566`) ne fait que `UPDATE entities SET is_active=false`.
   **Rien ne purge `member_entity_scopes`.**
2. `tenancy.ts:260-268` lit `member_entity_scopes` **sans jointure sur `is_active`** → le GUC
   `app.current_entity_scope` **contient encore l'entité archivée** → **le membre scopé
   continue de voir ses comptes**.
3. `page.tsx:96-98` ne passe que les entités **actives** → `assignation-entites.tsx:299` ne
   rend **aucune case** pour l'archivée → l'ADMIN **ne peut ni la voir ni la retirer**.
4. Pire : `assignation-entites.tsx:170` initialise `selection` depuis `scopeInitial` (qui
   **contient** l'archivée) et la **re-poste** à chaque enregistrement (`:287-289`).

**Fuite intra-groupe par persistance de droit.** Aujourd'hui **dormant** —
`archiverEntiteAction` n'est câblée nulle part. **L2 câble le bouton qui l'active.**

⚠️ **PIÈGE DANS LE REMÈDE (à écrire noir sur blanc)** : la correction naïve (« filtrer les
entités archivées dans le résolveur ») est **FAIL-OPEN**. Dans `tenancy.ts:340-346`, si
`entityIds` devient **vide** après filtrage, `entityScope` reste `GLOBALE`, le GUC n'est
**pas posé**, la policy court-circuite → **le membre voit TOUT le tenant**. `account_scope`
a, lui, sa sentinelle UUID-nul (`tenancy.ts:153`) ; `entity_scope` **n'en a pas**.

→ **Q-ARCHIVAGE** (§9).

---

## 4. Cible — la nouvelle architecture de l'information

```
┌──────────────────────────────────────────────────────────────────┐
│  BANDEAU RÉCAP           N entités · M comptes · P membres        │
│  ▸ K comptes non assignés  ← LE reste-à-faire                     │
│                                            [ + Créer une entité ] │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  ÉTAPE 1 — RANGER LES COMPTES                        (le cœur)    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 💡 X comptes peuvent être rattachés d'après vos données     │  │
│  │    (doublons SURFACÉS, jamais fusionnés)     [ Vérifier ]  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  [recherche] [filtre banque]              N sélectionné(s) →     │
│  ☐ Compte          Devise   Entité        [Select] [Assigner]    │
│  ▸ Entité A (12)                                ← en-tête collant │
│  ▸ Non assigné (77)                                               │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  ÉTAPE 2 — QUI VOIT QUOI                          (les membres)   │
└──────────────────────────────────────────────────────────────────┘
```

Trois renversements : le **rangement** passe avant l'accès des membres ; les
**propositions** deviennent une suggestion contextuelle ; le **reste-à-faire** se lit en
premier.

---

## 5. Lots

### L0 — 🔴 **Socle d'isolation de la surface admin** · **PRÉREQUIS BLOQUANT**

*Nouveau lot, imposé par §3.3. Rien d'autre ne peut être construit sur une lecture fausse.*

- **Toute** la surface `/admin/entites` — la **lecture** ET **chaque Server Action** — passe
  à `withWorkspace` une session **explicitement amputée du `viewFilter`** (gabarit
  `layout.tsx:157`).
- Répare d'un coup **tous** les compteurs (dont `nbComptes`) **et** le batch de L3.
- **Garde d'affichage fail-safe** (résidu §9) : `withWorkspace` résout `entity_scope` et
  `account_scope` **en base**, pas depuis la session — l'amputation ne les couvre donc
  **pas**. Si `ctx.entityScope` **ou** `ctx.accountScope` ≠ `GLOBALE`, l'écran affiche un
  **avertissement explicite** (« vue restreinte — les compteurs ne reflètent qu'une partie
  du groupe ») **au lieu de mentir**. **Aucune règle serveur n'est durcie** sans arbitrage.
- **Cas d'isolation (bloquant)** : *une session avec `viewFilter` non vide voit bien les
  **87** comptes et **K = 77** non assignés* ; *et l'écriture aboutit sur un compte hors
  filtre*.

### L1 — Ossature, bandeau récap · **UI pure, ZÉRO serveur** (après L0)

- Réordonner `page.tsx` : **Récap → Ranger → Qui voit quoi**.
- **Bandeau récap** : aucune requête nouvelle (les 4 lectures sont déjà dans le
  `withWorkspace`, `page.tsx:64-88`).
- 🔴 **Le compteur DOIT appliquer la même règle que `grouperParEntite`** :
  `c.entityId === null || !entitesActives.has(c.entityId)`. Sinon bandeau et tableau
  **se contredisent** sur le même écran dès qu'une entité est archivée (les **deux**
  cross-reviews l'ont trouvé indépendamment — §11-C1).
- Pleine largeur (§1.1) → **Q-PERIMETRE**.
- ❌ **`loading.tsx` déplacé en L5** : la forme de l'écran change à chaque lot ; l'écrire en
  L1 imposerait de le réécrire deux fois (le skeleton doit « épouser la FORME réelle »).
- États du bandeau à spécifier : 0 compte / 0 entité (checklist §6.5).

### L2 — Créer / renommer / archiver une entité · **câblage UI** (après **Q-ARCHIVAGE**)

- CTA « Créer une entité » → `Modal` + `creerEntiteAction`.
- **Diff serveur : 3 × `revalidatePath`** (succès uniquement) — aucune des trois actions ne
  l'a (seule `assignerCompteAction`, `actions.ts:248`).
- ✅ **Q-ENTITE-VIDE tranchée** : les entités se gèrent (renommer / archiver / compteur) via
  une **LISTE DÉDIÉE dans le bandeau récap** — **jamais** via un en-tête de groupe du tableau,
  qui **peut ne pas exister** (`grouperParEntite` filtre les groupes vides,
  `assignation-comptes.tsx:125` → une entité fraîchement créée serait **ingérable**).
- ✅ **Q-ARCHIVAGE tranchée** : **BLOQUER** l'archivage tant que des **comptes** OU des
  **scopes de membres** pointent l'entité, avec un message explicite (« porte N comptes et
  M membres »). **Pas de purge**, **pas de filtrage fail-open** dans le résolveur (§3.4).
- ❌ **« Aucun nouveau cas d'isolation requis » était FAUX** : `renommerEntite` et
  `archiverEntite` **ne sont jamais testés sous MANAGER** (§11-F1). → 2 cas à ajouter.
- `EmptyState "Aucune entité"` (`assignation-comptes.tsx:185`) n'a **pas de CTA** → point
  d'entrée naturel de la création.

### L3 — Sélection multiple + action groupée · **P1 (`ENTITY-ASSIGN-BULK1`)** — **batch acté (Q3)**

- Cases par ligne + case **tri-état** par groupe → helpers existants (extraits vers
  `lib/selection-groupe.ts`).
- **Filtre par banque** : `institutionName` est **déjà** dans `CompteAvecEntite` → aucune
  requête nouvelle.
- **Action batch** `assignerComptesEntite(tx, ctx, {bankAccountIds[], entityId|null})` :
  - ✅ Atomicité **atteignable** (`withWorkspace` = `db.transaction`, `tenancy.ts:185`).
  - ❌ **NE PAS** copier la boucle de `confirmerPropositionAction` (`actions.ts:376`) :
    `.max(500)` × 1 UPDATE = **500 aller-retours** dans une transaction WebSocket ouverte.
    → **Aller au bout du gabarit `definirScopesFinsMembre`** (`user-scopes.ts:200-224`) :
    **1 `SELECT … inArray` (pré-check) + 1 `UPDATE … WHERE id = inArray(ids)`** = 2 allers-retours.
  - ⚠️ **Piège de l'UPDATE groupé** : un compte hors périmètre RLS n'est **pas** mis à jour
    **silencieusement** (0 ligne, aucune erreur) → **comparer `returning().length` à
    `ids.length` et lever si écart**, sinon **succès partiel silencieux**.
  - ⚠️ **Valider `entityId` contre `is_active = true`** : ni la FK ni `assignerCompteEntite`
    ne le font → un batch peut assigner 500 comptes à une entité **archivée** (§11-C3).
  - ⚠️ **SQLSTATE `42501`** (violation du `WITH CHECK` d'`entity_scope` sur une
    dé-assignation sous périmètre réduit) **n'est mappé nulle part** → **500 brut**. À
    mapper vers une erreur nommée (§11-S4).

**Exit** : `withWorkspace` + `exigerAdmin` · 404 jamais 403 · zod strict borné · erreurs
nommées (**dont 42501**) · **cas d'isolation** : MANAGER refusé · compte d'un autre tenant →
`CompteIntrouvableError` · **atomicité** (un id invalide ⇒ **rien** n'est posé) ·
**`returning().length` ≠ `ids.length` ⇒ lève** · entité archivée refusée · contre-preuve ADMIN.

### L4 — Propositions → bannière + panneau · **fusionne les 4 lots v1**

- La section « Propositions (Parties Omni-FI) » **disparaît** → **bannière** dans l'étape 1 :
  « X comptes peuvent être rattachés d'après vos données — [Vérifier] ».
- Le panneau porte le sas enrichi : `ui/select` (**absorbe le Lot 2 v1**, §8) · liste
  défilable + « tout cocher » tri-état (**Lot 1 v1**, mutualisé L3) · **`libelleCompte()`**
  (**Q2**) · carte « traitée » + `peutConfirmer` resserré (**Lot 3 v1**) · texte d'aide sur
  le compromis re-sync (**D2 / Q-RESYNC**).
- **Principe Q2-bis** : la bannière **SURFACE** les doublons (entité au nom proche d'une
  party) et laisse l'admin **basculer**. **Jamais d'auto-fusion.**
- ⚠️ **L4 n'est PAS « zéro serveur »** (conséquence de Q2) : `libelleCompte()` lit
  `institutionName`, or **`CompteDeProposition` ne le porte pas** (`entites.ts:162-168`).
  → **`innerJoin(bankConnections)` + 1 colonne** dans `listerPropositionsPartyEntite`
  (`entites.ts:452-469`). Sans ça, **77 comptes sur 87** s'afficheraient `Compte 1a2b3c4d`
  au lieu de `State Bank of Mauritius · 1a2b3c4d` — l'institution disparaîtrait
  **précisément** sur les comptes qu'on veut rendre identifiables.
- 🔴 **`revalidatePath` NE réinitialise PAS la sélection du sas** (§11-S3) : l'initialiseur
  de `useState` (`propositions.tsx:101`) ne s'exécute **qu'au montage**, et `key={p.partyId}`
  est **stable** → `comptesCoches` **survit périmé**. Le commentaire d'`actions.ts:242-247`
  affirme le contraire : **il est faux**.
  **Mode de défaillance aggravé par L3** : l'ADMIN range 50 comptes en masse, ouvre le
  panneau, les 50 y sont **encore cochés**, il clique « Confirmer » → **les 50 repartent**
  vers l'entité de la party, **écrasant son rangement en silence**.
  → Exit : panneau **monté à l'ouverture** (`{ouvert && <Panneau/>}`, jamais caché en CSS) ·
  `key` dérivé d'un compteur de mutations · **`confirmerPropositionAction` pose un
  `revalidatePath`** (elle n'en a **aucun**) · `peutConfirmer` dérivé des **props**.
- 🔒 **INVARIANT INCHANGÉ** : `confirmerPropositionAction` reste le **seul** chemin posant un
  `entity_id` dérivé d'une party, sous garde ADMIN, **sur confirmation explicite**.

### L5 — Garde-fous & polish

- **Confirmation de la dé-assignation** (`CONFIRM1`) → `Modal` `dismissible={false}`
  (§2.3 « destructif : confirmation obligatoire »).
- **En-têtes collants** (`STICKY1`) · **devise en symbole** (`POLISH1 a`) · **mobile**
  (`POLISH1 b` — ⚠️ chiffré sur une table à 3 colonnes ; elle en aura **5** après L3) ·
  **`loading.tsx`** (`POLISH1 c`, déplacé ici depuis L1).
- `REVALIDATE1` : fortement atténué par le batch (1 `revalidatePath` pour N comptes).

### Hors périmètre

`SCALE1` (pagination — déclencheur non levé ; ⚠️ **mais son second volet — le `INNER JOIN
bank_connections` fail-closed — est touché par le filtre banque de L3** → à re-dater) ·
policies RLS · placement d'`entity_id` · **aucun montant** (règle 8) · **migration EN de
l'app** (chantier à part, TODOS).

---

## 6. Impacts serveur — récapitulatif ⚠️ **CORRIGÉ**

> La v2 initiale affirmait : « *toute la refonte tient sur une seule décision serveur : Q3* ».
> **Les deux cross-reviews l'ont infirmé indépendamment.** C'est faux, et c'est exactement le
> genre de ligne rassurante qu'un lecteur pressé retient. **Il y en a cinq.**

| Lot | Diff serveur | Nouveaux cas d'isolation |
|---|---|---|
| **L0** | 🔴 session amputée du `viewFilter` (lecture **+** actions) | **oui — 2** |
| L1 | aucun | non |
| L2 | 3 × `revalidatePath` · **+ remède Q-ARCHIVAGE** | **oui — 3** (MANAGER × renommer/archiver ; révocation de scope) |
| **L3** | 🔴 1 fonction repo + 1 action + barrel + mapping `42501` | **oui — 6** |
| **L4** | 🔴 `innerJoin(bankConnections)` + `institutionName` · `revalidatePath` | non |
| L5 | aucun | non |
| ~~Q-CASSE~~ | ❌ **NON RETENUE** (Etienne, 2026-07-13) — **aucune migration**. On surface le doublon, on ne le refuse pas. | non |
| **`/admin/membres`** | Q-PERIMETRE : même vocabulaire, **même langue (EN)**, **pleine largeur**. Aucun diff serveur. | non |

---

## 7. Invariants non négociables

- **Deux étages** : `tenant_isolation` (PERMISSIVE) **AND** `entity_scope` (**RESTRICTIVE
  FOR ALL**). Le filtre de périmètre vit **dans la RLS**, jamais dans le `.tsx`.
- **`entity_id` uniquement sur `bank_accounts`.**
- **Garde ADMIN applicative** (`exigerAdmin`) **en plus** de la RLS.
- **ENTITY-PARTY1** : l'ingestion ne pose **jamais** `entity_id` ; le sas est le seul chemin,
  sur **confirmation explicite**.
- **404, jamais 403.** **Aucun montant.**

---

## 8. Branches & coordination

`origin/feat/entites-select-ui` (`f078dee`, +27/−18, **non mergée**) réécrit le sélecteur de
`propositions.tsx` — le fichier que L4 transforme.

**Faits mesurés** : `propositions.tsx` **n'a pas bougé sur `main`** depuis la base de la
branche → **merge trivial, 0 conflit** (`git merge-tree`, exit 0). Branche à **18 commits de
retard**. La dépendance que la v1 croyait bloquante (`ui/select` absent de `main`) est
**LEVÉE**.

**→ Q5 tranchée : ABSORBER.** Merger la branche (PR de 27 lignes, sans conflit), puis brancher
depuis un `main` à jour. **À fermer AVANT que L4 ne démarre** — laisser une branche en vol sur
un fichier qu'on refond est un piège de coordination garanti.

**Livraison** : branche `feature/refonte-entites-ia` depuis `main` à jour. L'agent **s'arrête à
la PR poussée**.

---

## 9. Arbitrages — ✅ **DÉCIDÉS** (Etienne, 2026-07-13)

> Toutes les questions ouvertes de la v2 sont **tranchées**. Ces décisions sont **actées** :
> elles ne se re-litigent pas (discipline decision-log, §2). La colonne « Question » est
> conservée pour la traçabilité — on doit pouvoir relire *pourquoi* on a décidé.

### 🔴 Les deux décisions d'isolation (prérequis de L0 / L1 / L2)

| # | Question | ✅ DÉCISION (Etienne, 2026-07-13) |
|---|---|---|
| **Q-PERIMETRE-ADMIN** | **L'écran admin doit-il JAMAIS s'exécuter sous un périmètre réduit ?** (§3.3 — le `viewFilter` du header ampute déjà la page ; l'ADMIN scopé via `member_entity_scopes` **ou** `user_scopes` l'ampute aussi — aucune de ces fonctions ne vérifie le rôle de la cible.) | ✅ **Non, jamais.** La session est **amputée du `viewFilter`** sur **toute** la surface admin — **lecture ET chaque Server Action** (gabarit `layout.tsx:157`). → **lot L0, prérequis bloquant**.<br>⚠️ **RÉSIDU SIGNALÉ, NON TRANCHÉ** : l'amputation ne couvre que l'axe **JWT**. `entity_scope` et `account_scope` sont résolus **en base** par `withWorkspace` (`tenancy.ts:260`, `:273`), **pas** depuis la session — un ADMIN scopé via `member_entity_scopes` / `user_scopes` resterait donc amputé, et **l'écran `/admin/entites` expose lui-même l'action qui permet de scoper un ADMIN** (`definirScopesAction` liste **tous** les membres, ADMIN compris). L0 pose donc une **garde d'affichage fail-safe** (avertissement « vue restreinte » si `ctx.entityScope` ou `ctx.accountScope` ≠ `GLOBALE`) et **ne durcit AUCUNE règle serveur** sans arbitrage. → **Question rouverte à Etienne (§12).** |
| **Q-ARCHIVAGE** | **Qu'advient-il des DROITS quand une entité est archivée ?** (§3.4 — les `member_entity_scopes` orphelins survivent, sont invisibles et **re-postés** ; le membre **continue de voir** les comptes.) ⚠️ Le remède naïf est **FAIL-OPEN**. | **Bloquer l'archivage** tant que des **comptes** OU des **scopes** pointent l'entité (message explicite : « cette entité porte 12 comptes et 2 membres »). Les deux autres voies (purge des scopes / jointure `is_active` dans le résolveur) exigent une **sentinelle sur `entity_scope`**, qui n'existe pas. |

### 🟠 Les décisions de conception

| # | Question | ✅ DÉCISION (Etienne, 2026-07-13) |
|---|---|---|
| **Q-LANG** | **Aucun socle i18n n'existe** (ni `next-intl`, ni `react-i18next`, ni `messages/`). Tu as acté l'anglais + « zéro nouvelle copie FR » : **comment ?** (a) écrire `/admin/entites` **directement en anglais** (pilote) ; (b) introduire un socle i18n = **expansion de scope**, que tu as toi-même exclue. ⚠️ **Coût caché de (a)** : les primitives **partagées** portent des micro-chaînes FR en dur — `Select` « Aucune option. » (`select.tsx:313`), `Modal` `aria-label="Fermer"` (`:145`), `AppErrorState` « Réessayer » (`:62`) — et `actions.ts` porte ~8 messages FR. | **(a)**, avec **paramétrisation minimale** des 3 micro-chaînes (props optionnelles, **défaut FR** ⇒ zéro régression ailleurs). Ce n'est **pas** un socle i18n. Les messages d'`actions.ts` sont **locaux** → traduisibles sans impact. |
| **Q-PERIMETRE** | Le périmètre du **vocabulaire**, de la **langue** et de la **largeur** est-il `/admin/entites` **ou l'Admin** ? `/admin/membres` porte **les mêmes mots** (« Vision Globale », `liste-membres.tsx:42`), **la même largeur** (`max-w-3xl`, `page.tsx:68`) et **la moitié de la surface « qui voit quoi »** (on **crée** le périmètre là-bas, on l'**édite** ici). | **L'Admin.** Sinon deux écrans voisins parlent deux dialectes sur la **même notion de sécurité**, et un seul passe en anglais. Surcoût faible (`/admin/membres` est petit). |
| **Q-ENTITE-VIDE** | **Où gère-t-on une entité à 0 compte ?** (§5-L2 — `grouperParEntite` masque les groupes vides **exprès** pour la recherche ; les deux objectifs s'opposent.) | Une **liste d'entités dédiée** dans le bandeau (renommer/archiver/compteur), plutôt que de piloter l'entité depuis un en-tête de groupe qui **peut ne pas exister**. |
| **Q-CASSE** | `entities_workspace_name_unique` est **sensible à la casse**. Durcir (migration `lower()`, gabarit `0020`) ou **surfacer** ? ⚠️ **Durcir crée un cul-de-sac** : le matching de proposition (`entites.ts:436-440`) est **lui aussi** sensible à la casse → party « SUCRIÈRE » + entité « Sucrière » ⇒ pas de match ⇒ bascule sur « créer » ⇒ **`EntiteNomDupliqueError` à chaque clic**, bouton actif, action toujours en échec. | ✅ **NE PAS durcir l'unicité. Aucune migration.** On **surface** la similarité dans la bannière et on propose de **basculer** sur l'entité existante — conforme au principe **Q2-bis** (« surfacer, jamais fusionner »). Le cul-de-sac du `leftJoin` sensible à la casse est ainsi **évité par construction** (on ne crée jamais l'échec, on montre le doublon). |
| **Q-RESYNC** | Reliquat v1 : le compromis « un compte décoché **réapparaît** au prochain sync » est-il acceptable avec un simple **texte d'aide** ? | Oui — cas rare, compte inoffensif. |

---

## 10. Critères de sortie transverses

- [ ] `lint` + `typecheck` + `build` verts.
- [ ] `test:isolation` vert — **+ ~11 cas neufs** (L0 : 2 · L2 : 3 · L3 : 6).
- [ ] **La session de `/admin/entites` est amputée du `viewFilter`** — lecture **et** actions.
- [ ] Le compteur « non assignés » et `grouperParEntite` appliquent **la même règle**.
- [ ] Le batch **compare `returning().length` à `ids.length`** et **lève** si écart.
- [ ] SQLSTATE **`42501`** mappé vers une erreur **nommée** (jamais un 500).
- [ ] Le panneau L4 est **monté à l'ouverture** ; `confirmerPropositionAction` pose un
      `revalidatePath` ; `peutConfirmer` dérive des **props**.
- [ ] Tokens sémantiques uniquement · 4 états par surface · **erreur ≠ sortie** (§3.4).
- [ ] **Visual QA (Gate 4)** sur `/demo/…` — **y compris celle du redesign L7, jamais passée**
      (TODOS.md:792, dette pré-existante).
- [ ] **Cross-review (règle 6)** par un contexte frais.
- [ ] TODOS.md : dettes soldées cochées · **entrée neuve « migration EN de l'app »**.
- [ ] **STOP à la PR poussée** (Human-in-the-Loop).

---

## 11. Traçabilité des cross-reviews (règle 6)

Deux contextes **frais et indépendants**, mandatés de chercher des modes de défaillance
(lentilles distinctes : **sécurité/isolation** et **exactitude/faisabilité**). Constats
retenus, avec leur confiance :

| Réf | Constat | Confiance | Traité en |
|---|---|---|---|
| **S1** | Le `viewFilter` du header **ampute déjà** `/admin/entites` (lecture **et** écriture). | 9/10 | §3.3 · **L0** · Q-PERIMETRE-ADMIN |
| **S2** | Archiver une entité **ne révoque aucun accès** ; le remède naïf est **fail-open**. | 9/10 | §3.4 · **Q-ARCHIVAGE** |
| **S3** | `revalidatePath` **ne réinitialise pas** la sélection du sas (`useState` + `key` stable) → « Confirmer » peut **écraser un batch**. Le commentaire d'`actions.ts:242` est **faux**. | 8/10 | **L4** |
| **S4** | SQLSTATE **`42501`** non mappé → **500** sur une dé-assignation sous périmètre réduit. | 7/10 | **L3** |
| **C1** *(trouvé par les DEUX revues)* | Bandeau et tableau utiliseraient **deux définitions** de « non assigné » → se contrediraient sur le même écran. | 9/10 | **L1** |
| **C2** | Atomicité **atteignable**, mais `.max(500)` + boucle = **500 aller-retours** ; l'UPDATE groupé peut produire un **succès partiel silencieux**. | 8/10 | **L3** |
| **C3** | Une **entité archivée** reste une **cible valide** du batch (ni FK ni repo ne vérifient `is_active`). | 7/10 | **L3** |
| **E2** | La recommandation Q2 exige **`institutionName`**, pas `omnifiAccountId` → **L4 n'est pas « zéro serveur »**. | 9/10 | **L4** · §6 |
| **E3** | `omnifi_account_id` est un **UUID technique**, pas un identifiant bancaire → D3 demandait un masquage **impossible**. | 8/10 | §0-bis |
| **F1** | L2 : « aucun nouveau cas d'isolation » **faux** — `renommerEntite`/`archiverEntite` **jamais testés sous MANAGER**. | 8/10 | **L2** · §6 |
| **B2** | Une entité **à 0 compte** est **ingérable** (groupes vides filtrés). | 9/10 | **Q-ENTITE-VIDE** |
| **B3** | `/admin/membres` porte **les mêmes mots, la même largeur**, la **moitié** de la surface « qui voit quoi ». | 8/10 | **Q-PERIMETRE** |
| **B5** | Durcir la casse **crée un cul-de-sac** dans le sas (matching sensible à la casse). | 7/10 | **Q-CASSE** |
| **C1-exa** | « **Une seule décision serveur** » : **faux** — il y en a **cinq**. | 9/10 | **§6 corrigé** |
| **F2/E1** | « 22 cas d'isolation » → **25**. | 10/10 | §3.2 corrigé |
| **C2-exa** | Dette de **nommage** : importer `grouper-titulaire` dans un écran d'**entités** → extraire `lib/selection-groupe.ts`. | 8/10 | §3.2 · **L3** |
| **C4-exa** | `loading.tsx` écrit en L1 serait **réécrit deux fois** (la forme change à chaque lot). | 7/10 | **déplacé en L5** |

**Confirmé sain par les deux revues** (aucun constat) : les invariants d'isolation (§7) ·
« 404 jamais 403 » · « aucun montant » · l'isolation **tenant** (étage 1) · la généricité des
helpers de sélection · l'atomicité **atteignable** du batch · le merge **sans conflit** de la
branche en vol · l'a11y du tri-état (`indeterminate` par `ref`, **déjà résolu** au repo).

---

## 11-bis. Cross-review n° 3 — sur le CODE livré (L0→L3), 2026-07-13

Contexte frais, mandaté sur le diff `origin/main...feature/refonte-entites-ia`. Elle a
confirmé sains : la règle unique « non assigné » (aucune divergence possible), la sélection
UI (aucun chemin de fuite), l'atomicité du batch, la complétude de l'amputation L0, et
l'absence de régression. Elle a trouvé **deux bugs réels, prouvés sur Postgres** — tous deux
sur la racine que §12 avait signalée mais que le lot n'avait traitée que côté AFFICHAGE :

| Réf | Constat | Sort |
|---|---|---|
| **R1** | 🔴 La garde d'archivage **se contournait elle-même** : `archiverEntite` compte SOUS la RLS → sous périmètre réduit, il voyait 0 compte pour une entité qui en porte 12. | **Corrigé** — `PerimetreReduitError`. Principe : *une garde qui exige un dénombrement exhaustif refuse de s'exécuter sous périmètre réduit*. Cas 42. |
| **R2** | 🔴 Garde à **sens unique** : on pouvait POSER un droit sur une entité **déjà archivée** (ni la FK ni `definirScopesMembre` ne regardaient `is_active`) → le droit orphelin que Q-ARCHIVAGE interdit. | **Corrigé** — contrôle `is_active` dans `definirScopesMembre`. Cas 43. |
| **R3** | L'invariant « entité archivée ⇒ jamais une cible » n'était vrai que sur **1 des 3** chemins d'écriture. | **Corrigé** — `exigerEntiteCibleActive`, appliqué aux 3. Cas 44. |
| **R4** | Le mapping SQLSTATE **42501** était correct mais **prouvé nulle part** (exit-criterion §10 non tenu). | **Corrigé** — cas 45. |
| **R5** | L'accusé de réception du batch était du **code mort** (la barre se démonte avant que le succès soit peint) → après 50 comptes rangés, aucun retour. | **Corrigé** — le message du serveur vit au-dessus du tableau. |
| **R6** | Règle ESLint **contournable par import relatif**. | **Corrigé** — `group` au lieu de `paths`. 3 contre-preuves. |
| **R7** | TOCTOU sur `archiverEntite`. | **Corrigé** — verrou `FOR UPDATE` partagé avec `definirScopesMembre`. |
| **R8** | `/admin/membres` amputé **sans** le garde-fou d'affichage (asymétrie contraire à Q-PERIMETRE). | **Corrigé**. |
| **N1** | La cible **par défaut** de la barre d'action était la dé-assignation (geste destructif par défaut). | **Corrigé** — cible neutre, bouton inerte sans choix. |
| **N3 / N4** | Routes `/demo` publiques montant de vraies Server Actions (préexistant) ; `admin/perimetres` sans appelant. | **Consignés** — `DEMO-ACTIONS1`, `ADMIN-PERIMETRES-MORT1`. |

Les trois bloquants touchaient l'isolation → **corrigés, pas différés** (règle 9).

---

## 12. ⚠️ Question résiduelle — rouverte à Etienne (non tranchée, non devinée)

**Le principe acté est : « la surface admin ne s'exécute JAMAIS sous périmètre réduit ».**
Le moyen prescrit — amputer la session du `viewFilter` — ne couvre **qu'un des trois axes**
de réduction :

| Axe | Origine | Amputable via la session ? | Couvert par L0 ? |
|---|---|---|---|
| `view_filter` | **JWT** (posé par le `PerimetreSwitcher` du header) | ✅ oui | ✅ **oui** |
| `entity_scope` | **base** — `member_entity_scopes`, lu par `withWorkspace` (`tenancy.ts:260`) | ❌ **non** | ⚠️ garde d'affichage seulement |
| `account_scope` | **base** — `user_scopes`, lu par `withWorkspace` (`tenancy.ts:273`) | ❌ **non** | ⚠️ garde d'affichage seulement |

**Ce qui rend le résidu réel, pas théorique** : `definirScopesMembre` (`entites.ts:685`) et
`definirScopesFinsMembre` (`user-scopes.ts:181`) ne vérifient que la **membership**, jamais
le **rôle** de la cible. Et **`/admin/entites` expose elle-même l'action qui permet de scoper
un ADMIN** — `definirScopesAction` liste **tous** les membres, ADMIN compris. Un ADMIN peut
donc **se scoper lui-même** depuis l'écran, et casser sa propre vue d'administration.

**Ce que le chantier fait** (sans arbitrage) :
1. **L0** ampute le `viewFilter` (l'axe JWT) et pose une garde d'**affichage** fail-safe —
   l'écran **dit** qu'il est restreint plutôt que d'afficher des compteurs faux ;
2. **les correctifs de cross-review** (§11-bis, R1) ferment le versant **écriture** : toute
   garde dont la justesse exige un dénombrement exhaustif **refuse** de s'exécuter sous un
   périmètre réduit (`PerimetreReduitError`). C'est le complément indispensable : un
   avertissement de LECTURE ne protège pas une garde d'ÉCRITURE.

Aucune règle d'écriture serveur n'est durcie **au-delà de ça**.

**Ce que L0 ne fait PAS, et qui demande ton arbitrage** : durcir `definirScopesMembre` et
`definirScopesFinsMembre` pour **interdire de scoper un ADMIN** (fail-closed structurel, ~10
lignes + 2 cas d'isolation). C'est la seule voie qui rend le principe **vrai**, et non
seulement **visible**. Je ne l'ai pas prise seul : elle modifie une règle d'écriture serveur
que tu n'as pas explicitement ouverte.
