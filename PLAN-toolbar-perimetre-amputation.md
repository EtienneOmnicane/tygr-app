# PLAN — TOOLBAR-PERIMETRE-AMPUTATION1 (P1)

> Amputer le `viewFilter` des surfaces de GESTION `/banques` et `/regles`, **puis**
> retirer leur sélecteur de périmètre (2 cellules restantes de la matrice A2).
> Réf. brief : entrée `TOOLBAR-PERIMETRE-AMPUTATION1` de `TODOS.md` (fait foi).
> Branche cible : `fix/toolbar-perimetre-amputation` (coupée de `main` à jour).

## 0. Le fond du problème (rappel, vérifié au code)

Le `viewFilter` **n'est pas** un filtre d'affichage local : c'est l'INTENTION du
sélecteur « Périmètre » (L8b-1), portée par le **JWT**, transformée par
`withWorkspace` en GUC `app.current_view_filter`, consommé par la **2ᵉ clause AND**
des policies `account_scope` (migrations `0016_account-scope-l4.sql` +
`0017_account-scope-filles-l5.sql`, RESTRICTIVE FOR ALL, USING **et** WITH CHECK) sur
`bank_accounts` et ses tables filles. Il **suit l'utilisateur de page en page** et mord
sur toute page dont la session n'est **pas** amputée.

Preuve du mécanisme (`src/server/db/tenancy.ts:368-419`) :

- `viewFilter` absent/vide ⇒ le GUC `app.current_view_filter` **n'est PAS posé** ⇒ la
  clause `view_filter` court-circuite (`nullif(...) IS NULL = TRUE`) ⇒ on voit/écrit
  **tout le DROIT** dur.
- `viewFilter` présent ⇒ intersecté avec le DROIT (`account_scope`), posé ⇒ la vue
  **rétrécit** (jamais n'élargit).

Conséquences terrain sur les pages qui tournent en session COMPLÈTE
(`exigerSessionWorkspace`) :

- **`/banques`** — un filtre actif fait que le sync **attache 0 compte SANS erreur**
  (le `WITH CHECK` de `account_scope` refuse l'INSERT des comptes hors filtre) → bug
  « spinner puis rien » (déjà documenté `banques/actions.ts:281-286`). Et les compteurs
  de `listerConnexionsBancaires` (leftJoin `bank_accounts`) **sous-comptent** (« 1 compte »
  pour une connexion qui en a 5).
- **`/regles`** — un filtre actif fait que « Ré-analyser » (`appliquerReglesAction`)
  **ne recatégorise que le périmètre filtré** : le FM croit avoir ré-analysé tout le
  groupe.

## 1. Invariant de discipline (l'ordre est NON négociable)

`perimetre: false` dans `toolbar-config.ts` n'est **légitime QUE** si la page **ET**
ses Server Actions tournent sur une session **amputée** du `viewFilter`. La garde CI
`tests/unit/toolbar-config.test.ts` (l.218) **refuse** `perimetre: false` tant que le
segment n'est pas dans la liste blanche `SEGMENTS_SANS_PERIMETRE_AUTORISES` — et cette
liste ne doit être étendue **qu'après** l'amputation serveur (commentaire du test, l.61).

> ⚠️ La garde CI est une **liste blanche**, pas un scanner du source serveur : elle ne
> *prouve* pas mécaniquement l'amputation. C'est pourquoi l'amputation réelle est une
> exigence de **correction** (et de revue règle 6), pas une astuce pour passer la CI.

**Donc : amputer le serveur D'ABORD, retirer le sélecteur ENSUITE.**

## 2. Principe de découpage (organise tout le plan)

> **Amputer exactement les chemins de code où un `view_filter` actif DISTORD le
> résultat** (rétrécit silencieusement une écriture, ou mal-compte / mal-scope une
> lecture qui doit être tenant-wide sur une surface de gestion). Ne PAS amputer un
> chemin que le filtre ne touche pas — surtout une lecture qui doit honorer le
> périmètre d'affichage.

C'est ce principe qui tranche le write/read de `/regles` ci-dessous.

## 3. Sécurité — ce que l'amputation retire (et ne retire PAS)

`withWorkspace` pose **trois GUC distincts** (`tenancy.ts`) :

| GUC | Source | Nature | Amputation ? |
|---|---|---|---|
| `app.current_workspace_id` | session (workspace actif) | TENANT (dur, anti-IDOR) | **conservé** |
| `app.current_entity_scope` | **base** (`member_entity_scopes`) | ENTITÉ (dur) | **conservé** |
| `app.current_account_scope` | **base** (`user_scopes`) | COMPTE (dur, DROIT) | **conservé** |
| `app.current_view_filter` | **JWT** (`session.viewFilter`) | AFFICHAGE (sélecteur) | **RETIRÉ** |

Amputer = reconstruire la session avec `{ userId, activeWorkspaceId }` seulement ⇒
`viewFilter` absent ⇒ `withWorkspace` ne pose jamais `app.current_view_filter` ⇒ clause
`view_filter` neutre. Les **DROITS DURS restent posés depuis la base** : un membre
réellement scopé (via `user_scopes`/`member_entity_scopes`) **reste borné**. L'amputation
ne confère **aucun** accès supplémentaire ; elle ne retire qu'une **intention
d'affichage transitoire**. C'est exactement la doctrine de `exigerSessionAdministration`
(`session.ts:103-135`) et la leçon anti-auto-amputation #143 (test #10bis de
`account-scope-isolation.test.ts`).

## 4. DÉCISION À REMONTER (règle 10) — nom du helper d'amputation

Le seul helper qui ampute le `viewFilter` est `exigerSessionAdministration()`
(`session.ts:136`). Il reconstruit `{ userId, activeWorkspaceId }`, ne vérifie **pas**
le rôle, et sa doc établit « la sécurité est INCHANGÉE, on ne retire qu'une intention
d'affichage ». Le réutiliser tel quel sur `/banques` et `/regles` **fonctionne**, mais
son **NOM ment** : ce ne sont pas des surfaces d'`/admin`.

Deux options (à trancher par Etienne — **je ne tranche pas seul**) :

- **(a) — RECOMMANDÉE. Renommer** en un helper neutre `exigerSessionSansPerimetre()`
  (session amputée du filtre d'affichage), avec `exigerSessionAdministration` conservé
  comme **alias mince** (`export const exigerSessionAdministration = exigerSessionSansPerimetre`)
  → zéro churn sur les appelants `/admin` existants.
  - **Pour** : le nom dit la vérité ; futur lecteur d'un helper *quasi-sécurité* ne se
    demande plus « pourquoi la page Banques exige une session d'admin ? » (risque qu'un
    « fix » casse l'amputation) ; l'invariant devient auto-documenté.
  - **Coût** : ~1 renommage + 1 alias + doc dans `session.ts` (fichier sensible, mais
    changement purement lexical, couvert par tsc + suites d'isolation admin existantes).
  - **Nuance de nommage** : « sans périmètre » désigne le **filtre d'affichage** (le
    sélecteur), PAS les scopes durs (qui restent). La doc le précisera.
- **(b) — Utiliser `exigerSessionAdministration()` tel quel** sur les 2 pages + un
  commentaire expliquant pourquoi.
  - **Pour** : diff minimal, zéro touche à `session.ts`.
  - **Contre** : le nom ment durablement (le brief le pointe) — dette de lisibilité sur
    une surface de sécurité, exactement le genre de piège que règle 6 doit attraper.

**→ ATTENDRE l'arbitrage avant d'écrire le code serveur.** Le reste du plan est écrit en
supposant (a) ; sous (b) on remplace `exigerSessionSansPerimetre` par
`exigerSessionAdministration` partout et on saute le §5.1.

## 5. Fichiers touchés

### 5.1 `src/server/auth/session.ts` — le helper (si option (a))

- Renommer `exigerSessionAdministration` → `exigerSessionSansPerimetre` ; garder
  `exigerSessionAdministration` en **alias** exporté.
- Réécrire la doc pour dire « surface tenant-wide (admin OU gestion) », pas « admin ».
- ⚠️ Ne change **rien** au comportement : mêmes 2 champs reconstruits, même sécurité.

### 5.2 `src/app/(workspace)/banques/page.tsx` — la lecture (compteurs)

- Ligne 31 : `exigerSessionWorkspace()` → `exigerSessionSansPerimetre()`.
- **Pourquoi** : `listerConnexionsBancaires` (l.44-47, leftJoin `bank_accounts`)
  sous-compte sous un filtre actif. C'est une lecture **distordue** par le filtre → on
  ampute (principe §2). Adapter le `try/catch` (mêmes erreurs mappées).

### 5.3 `src/app/(workspace)/banques/actions.ts` — les 6 actions

Toutes relèvent du **cycle de vie d'une connexion** (surface tenant-wide : une
connexion remonte les comptes de N entités). Aucune n'est une « lecture d'affichage qui
doit honorer le périmètre ». → **amputer les 6** :

| Ligne | Action | Effet du filtre aujourd'hui |
|---|---|---|
| 152 | `demarrerConnexionAction` | flux LinkToken (connexion) — tenant-wide |
| 212 | `finaliserConnexionDropinAction` | **INSERT `bank_accounts`** → 0 compte (WITH CHECK) |
| 272 | `synchroniserConnexionsAction` | **UPSERT `bank_accounts`** → « spinner puis rien » |
| 444 | `creerLinkTokenRepairAction` | LinkToken REPAIR (connexion) — tenant-wide |
| 491 | `resynchroniserConnexionApresReparationAction` | **UPSERT `bank_accounts`** |
| 590 | `selectionnerComptesAction` | **UPDATE `bank_accounts.is_selected`** — blocable hors filtre |

Remplacer `const session = await exigerSessionWorkspace();` par
`exigerSessionSansPerimetre()` à ces 6 lignes.

### 5.4 `src/app/(workspace)/regles/actions.ts` — DÉCOUPAGE lecture / écriture

Preuve par le **repository** `src/server/repositories/regles-categorisation.ts` de ce
que chaque fonction touche :

| Ligne action | Fonction repo | Tables touchées | Filtre distord ? | Amputer ? |
|---|---|---|---|---|
| 115 `listerReglesAction` | `listerRegles` | `categorization_rules` seul | **NON** | **NON** (lecture, sans effet) |
| 129 `creerRegleAction` | `creerRegle` | `categorization_rules` seul | non | **OUI** (uniformité) |
| 155 `modifierRegleAction` | `modifierRegle` | `categorization_rules` seul | non | **OUI** (uniformité) |
| 175 `archiverRegleAction` | `archiverRegle` | `categorization_rules` seul | non | **OUI** (uniformité) |
| 200 `appliquerReglesAction` | `appliquerRegles` | **INNER JOIN `bank_accounts`** (repo l.426-429) + `transactions_cache` + `transaction_categorizations` | **OUI** | **OUI** (LE bug) |
| 226 `reordonnerReglesAction` | `reordonnerRegles` | `categorization_rules` seul | non | **OUI** (uniformité) |

**Justification honnête du découpage (règle 6 — ne pas prétendre que les 5 sont
« distordues ») :**

- **`appliquerReglesAction` est la SEULE réellement distordue aujourd'hui** :
  `appliquerRegles` fait un `INNER JOIN bank_accounts` (repo l.426) → sous un filtre
  actif, la sélection des candidats est rétrécie aux comptes filtrés → ré-analyse
  partielle. C'est le bug ciblé. **Amputation REQUISE.**
- **`listerReglesAction` (lecture) n'est PAS amputée** : `listerRegles` ne lit que
  `categorization_rules` (workspace-global, `tenant_isolation`). Le `view_filter` n'a
  **aucun** effet → l'amputer serait un no-op sans valeur, et le principe §2 dit « ne
  pas amputer une lecture non distordue ». On la laisse.
- **`creer` / `modifier` / `archiver` / `reordonner` sont amputées par UNIFORMITÉ**,
  pas par nécessité de correction : elles ne touchent que `categorization_rules` →
  amputation = **no-op prouvé**. On les ampute quand même pour :
  1. **Invariant uniforme** : « toutes les *écritures* d'une surface de gestion
     `perimetre: false` tournent tenant-wide » (les règles SONT tenant-wide : il
     n'existe pas de règle « par périmètre »).
  2. **Robustesse** : si une écriture de règle touchait un jour `bank_accounts` (ex.
     règle scopée par compte), l'amputation est **déjà en place** — la garde CI étant
     une simple liste blanche, elle ne rattraperait pas cette régression.
  - Aucun risque : l'amputation ne retire que le filtre d'affichage, jamais les DROITS
    durs (§3) → un membre scopé reste borné.

### 5.5 `src/components/shell/toolbar-config.ts` — la matrice

- `banques` : `perimetre: true` → `perimetre: false` (garder `cta: true`).
- `regles` : `perimetre: true` → `perimetre: false`.
- Mettre à jour les commentaires (l.179-191) : passer de « PÉRIMÈTRE CONSERVÉ … À
  retirer SEULEMENT avec l'amputation P1 » à « amputé (TOOLBAR-PERIMETRE-AMPUTATION1) →
  périmètre retiré, session amputée via `exigerSessionSansPerimetre` ».

### 5.6 `tests/unit/toolbar-config.test.ts` — la garde CI

- Ajouter `"banques"` et `"regles"` à `SEGMENTS_SANS_PERIMETRE_AUTORISES` (l.63) — avec
  commentaire pointant l'amputation serveur.
- Mettre à jour les deux `it` :
  - l.139 `/banques` : `perimetre: true` → `false`, libellé « périmètre RETIRÉ (session
    amputée : le sync attache tous les comptes) ».
  - l.149 `/regles` : `perimetre: true` → `false`, libellé « périmètre RETIRÉ (session
    amputée : Ré-analyser porte sur tout le tenant) ».
- Vérifier que l'invariant l.218 passe (les 2 segments sont maintenant whitelistés) et
  que la garde anti-mensonge (l.241) reste verte (aucune des 2 pages ne monte de
  période).

## 6. Critère de sortie — cas d'isolation (règle 3, MÊME PR)

Nouveau fichier `tests/isolation/perimetre-amputation-gestion-isolation.test.ts`,
calqué sur `account-scope-isolation.test.ts` (migrations réelles + provisioning +
exécution sous `tygr_app`, garde structurelle de la policy `account_scope`).

> Contrainte du harnais (déjà assumée par le test #ent existant) : la suite **ne peut
> pas** appeler les Server Actions (runtime Next). On teste la **composition
> équivalente** : la seule différence entre les deux mondes est la session passée à
> `withWorkspace` (filtrée vs amputée) — exactement ce que change le remplacement de
> `exigerSessionWorkspace` par `exigerSessionSansPerimetre`.

Seed : `WS_A`, un membre ADMIN, deux comptes `ACC_1`/`ACC_2` (**même** workspace, même
connexion), une catégorie, une règle active dont le motif matche, et des transactions
NON catégorisées sur **les deux** comptes.

Cas prouvés :

1. **/regles — reproduction du bug** : session `viewFilter=[ACC_1]` →
   `appliquerRegles` ne catégorise **que** les transactions de `ACC_1` (celles de
   `ACC_2` restent sans split).
2. **/regles — la correction** : session **sans** `viewFilter` (amputée) →
   `appliquerRegles` catégorise les transactions des **deux** comptes (tout le tenant).
3. **/banques — reproduction du bug** : session `viewFilter=[ACC_1]` tentant d'INSÉRER
   un **nouveau** compte `ACC_3` (hors filtre) → **refus `WITH CHECK`** (le pendant
   « 0 compte attaché sans erreur »).
4. **/banques — la correction** : session **sans** `viewFilter` (amputée) → l'INSERT de
   `ACC_3` **réussit** (tous les comptes d'une connexion s'attachent).
5. **Non-régression sécurité** : sous la session amputée, un `WHERE workspace_id = WS_B`
   forgé renvoie **0 ligne** (l'amputation ne touche PAS `tenant_isolation`). Et un
   membre réellement scopé (`user_scopes`) reste borné même amputé (le filtre
   d'affichage était en plus de son droit, pas à la place).

> La RLS reste la garde : c'est un test de correction d'**affichage/écriture**, pas une
> preuve de fuite cross-tenant (le filtre ne fait que RÉTRÉCIR).

## 7. Effet de bord ASSUMÉ (à confirmer dans le corps de la PR)

Une fois amputé, **« Ré-analyser » sur `/regles` porte sur tout le tenant quel que soit
le filtre d'affichage courant** — c'est l'**intention** (le FM veut ré-analyser le
groupe entier ; un filtre d'affichage résiduel ne doit plus le trahir). De même, le
sync `/banques` attache tous les comptes de la connexion indépendamment du filtre. Ces
deux comportements sont le **but**, pas une régression.

## 8. Gates & livraison

- `npm run lint`, `npx tsc --noEmit`, `npm run build` **verts** (stop-loss règle 5).
- Suite d'isolation **verte**, dont le nouveau fichier + `toolbar-config.test.ts`
  (2 `it` mis à jour + invariant l.218) + les suites `admin` existantes (l'alias ne doit
  rien casser).
- Docs : cocher `TOOLBAR-PERIMETRE-AMPUTATION1` dans `TODOS.md` (livré) et refléter les
  2 cellules dans le commentaire de `TOOLBAR-GLOBALE-CADRAGE1`.
- **Revue en contexte FRAIS** (subagent indépendant, règle 6) AVANT push : mandat de
  chercher (a) un chemin `/banques`/`/regles` resté en session complète, (b) une
  amputation qui élargirait par erreur un droit dur, (c) un trou du cas d'isolation.
- **Git (Human-in-the-Loop)** : branche `fix/toolbar-perimetre-amputation` depuis `main`
  à jour ; commits WIP par unité logique ; **push** ; **STOP à la branche poussée** — je
  n'ouvre PAS la PR, je ne merge PAS. Etienne fait le Visual QA + merge. C'est du code
  applicatif + surface serveur → aucune auto-fusion.

## 8bis. DÉCOUVERTES en implémentation (au-delà de la liste du brief — assumées, non silencieuses)

Le brief listait les call-sites d'`actions.ts`. Deux fichiers supplémentaires de ces
mêmes surfaces portaient `exigerSessionWorkspace()` et RELÈVENT de l'invariant « la page
ET **toutes** ses Server Actions tournent amputées ». Vérifiés au code, amputés :

- **`banques/widget-runtime.ts`** (3 actions MFA : `pollJobAction` / `submitMfaAction` /
  `resendMfaAction`). Elles relaient vers l'API Omni-FI (Bearer) et n'écrivent JAMAIS
  `bank_accounts` ; leur seul contact DB est `exigerDroitWidget()` qui pose les GUC puis
  vérifie UNIQUEMENT `peutModifier(ctx.role)` (rôle issu de `workspace_members`, hors
  `bank_accounts`). → le viewFilter n'a **aucun effet** ⇒ amputation **NO-OP**, adoptée
  pour l'uniformité de l'invariant (et le futur-proofing : la garde CI n'est qu'une liste
  blanche). Les écritures de comptes vivent toutes dans `actions.ts`, déjà amputé.

- **`regles/page.tsx`** (RSC). Ne lit que règles / catégories / rôle (workspace-global) —
  aucune table account-scoped → viewFilter sans effet. Amputée quand même : l'invariant
  nomme explicitement « la page », et `/banques/page.tsx` crée le précédent. NO-OP sûr
  (seul le read de `ctx.role` change de session ; le rôle vient de la membership).

- **CONSÉQUENCE `/regles` → bande MINIMALE.** Avec `perimetre: false` et déjà sans période
  ni CTA, `/regles` n'a **plus aucun contrôle**. Une `barre({…tout à false})` non-minimale
  ne rend RIEN (réservé à `/selection`) — et la garde CI `toolbar-config.test.ts` (l.299)
  l'interdit pour tout autre segment. `/regles` rejoint donc `/admin/*` en **`MINIMALE`**
  (fine bande portant le repère de tenant). `/banques` garde son CTA → reste une `barre`.
  ⚠️ **Effet visuel à valider au Visual QA** (Etienne) : la barre de `/regles` passe du
  sélecteur de périmètre à une bande de tenant nue ; celle de `/banques` au CTA seul.

## 9. Ordre d'exécution

1. Arbitrage helper (§4) — **bloquant**.
2. `session.ts` (si (a)) → `banques/page.tsx` → `banques/actions.ts` (×6) →
   `regles/actions.ts` (×5 écritures).
3. `toolbar-config.ts` (matrice + commentaires).
4. `toolbar-config.test.ts` (liste blanche + 2 `it`).
5. Nouveau test d'isolation.
6. Gates verts.
7. Docs (`TODOS.md`).
8. Revue fraîche → commits → push → STOP.
