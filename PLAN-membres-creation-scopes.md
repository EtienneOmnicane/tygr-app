# Plan — Création d'un membre + assignation d'entités à la création

> **Phase : IMPLÉMENTATION** (CLAUDE.md règle 1). Réfère le socle validé
> `PLAN-entites-multi-tenant.md` (§1.4 member_entity_scopes, §3.3 gardes ADMIN) et
> `PLAN-entity-write-scope1.md` (policy `entity_scope` FOR ALL). Branche
> `feat/membres-creation-scopes` depuis `origin/main` (post #168).
>
> **Principe directeur** : on ne réécrit AUCUNE brique existante. Le provisioning
> (`creerUtilisateurEtRattacher`) et l'assignation d'entités (`definirScopesMembre`)
> sont déjà livrés, testés et gardés ADMIN. Ce chantier les **compose** et rend
> l'existant visible (liste des membres). Trois morceaux, tous effort **S**.

## 0. Contexte confirmé par inspection (ne PAS réimplémenter)

- `provisionnerMembre` (`admin/membres/actions.ts`) : zod strict + `argon2.hash` **dans
  l'action** → `withWorkspace` → `creerUtilisateurEtRattacher`. Garde ADMIN portée par
  le repo (`ctx.role`), jamais côté client.
- `creerUtilisateurEtRattacher` (`repositories/provisioning.ts`) : réutilise l'user par
  email (users hors RLS), INSERT membership `onConflictDoNothing` sous WITH CHECK RLS,
  retourne `{ userId }`.
- `definirScopesMembre` (`repositories/entites.ts`) : garde ADMIN, vérifie la membership
  dans le workspace courant (sinon `MembreNonScopableError`), **remplace atomiquement**
  (DELETE+INSERT) le jeu de scopes, `[]` = Vision Globale ; FK composite `(entity_id,
  workspace_id) → entities` rejette toute entité d'un autre tenant (`EntiteIntrouvableError`).
- `listerMembresWorkspace` / `listerEntites` (`repositories/entites.ts`) : ADMIN-only,
  tenant-scopés, déjà consommés par `/admin/entites`.

## 1. Morceau 1 — Assignation à la création (chaînage atomique)

**But** : l'ADMIN crée un membre ET fixe son périmètre entité en un seul geste, une
seule transaction.

### 1.1 Repo `provisioning.ts` (modif ciblée, retour enrichi — non cassant)
`creerUtilisateurEtRattacher` retourne désormais :
```ts
{ userId: string; utilisateurCree: boolean; membershipCreee: boolean }
```
- `utilisateurCree` : `false` si l'user existait déjà (branche de réutilisation),
  `true` s'il a été inséré.
- `membershipCreee` : dérivé de `.returning()` sur l'INSERT `onConflictDoNothing` du
  membership (longueur > 0 ⇔ nouvelle ligne ⇔ n'était pas déjà membre du workspace).

Ajout de champs uniquement → le destructuring `{ userId }` existant (integration test
`epic2-workspaces`) reste valide. **Aucun** changement de comportement (anti-écrasement
du mot de passe conservé : la branche user-existant n'écrit jamais `passwordHash`).

### 1.2 Action `provisionnerMembre` (chaînage dans UNE tx)
- Schéma zod : ajouter `entityIds: z.array(z.string().uuid()).max(200)` (miroir exact de
  `definirScopesSchema`), lu via `formData.getAll("entityIds")`.
- Corps `withWorkspace(session, async (tx, ctx) => { … })` :
  1. `const { userId, utilisateurCree, membershipCreee } = await creerUtilisateurEtRattacher(tx, ctx, {…})`
  2. **N'applique le périmètre QUE sur une création de membership** :
     ```ts
     if (membershipCreee && entityIds.length > 0) {
       await definirScopesMembre(tx, ctx, { userId, entityIds });
     }
     ```
     Justification (cohérente avec le morceau 3, anti-écrasement) : re-« créer » un
     email déjà membre ne doit PAS silencieusement écraser son périmètre déjà réglé
     dans `/admin/entites`. Un membre existant → aucune mutation (mot de passe ET
     périmètre inchangés). Un membre neuf sans case cochée → Vision Globale (défaut
     naturel, aucune ligne). **La gestion fine du périmètre d'un membre existant reste
     `/admin/entites`.**
- **Atomicité prouvée** : les deux appels partagent la MÊME transaction. Si
  `definirScopesMembre` lève (entité d'un autre tenant → FK → `EntiteIntrouvableError`),
  TOUT est rollback — y compris l'utilisateur et la membership : un membre du workspace A
  ne peut jamais naître avec un scope de B, et rien ne persiste sur échec (fail-closed).
- Les deux gardes ADMIN sont déjà dans les repos → **pas de garde dupliquée côté action**.
- Mapping d'erreurs : ajouter `EntiteIntrouvableError` / `MembreNonScopableError` →
  message générique « Champs invalides. » (une entité inconnue = saisie invalide, pas
  d'oracle) ; `ProvisioningNonAutoriseError` / `RoleInvalideError` → `MESSAGE_REFUS`
  (inchangé). Toute autre exception remonte (500).
- `revalidatePath("/admin/membres")` après succès → la liste (RSC) intègre le nouveau
  membre sans navigation (le formulaire est piloté par `useActionState`, pas un submit
  navigant).

### 1.3 UI `formulaire-provisioning.tsx` (cases entités + bascule)
Reprend le pattern de `admin/entites/assignation-entites.tsx` (bascule Vision Globale /
Vision Entité + cases), intégré au `<form>` existant :
- Props : `entites: EntiteVue[]` (actives, `{id, nom, code}`) passées par la page.
- `useState<"GLOBALE"|"ENTITE">` + `useState<string[]>` (sélection). Défaut GLOBALE.
- Mode ENTITE : cases par entité ; garde-fou produit (mirror assignation-entites) —
  submit désactivé si ENTITE + 0 case (envoyer `[]` = Globale, contre l'intention).
- `entityIds` envoyés = `mode==="GLOBALE" ? [] : selection` → un `<input type="hidden"
  name="entityIds">` par id.
- Dégradé sans entité : si `entites.length===0`, la bascule est neutralisée, note
  « Aucune entité — le membre aura une Vision Globale » (Globale reste un défaut valide,
  pas un cul-de-sac contrairement à `/admin/entites` QA-ENTITES-CREATION-UI1).
- Reste `useActionState` inchangé ; tokens UI_GUIDELINES §2.3 conservés.

## 2. Morceau 2 — Liste des membres sous le formulaire

**But** : rendre l'état à côté de l'action (solde QA-LISTES-MANQUANTES1(b)).

### 2.1 Page `admin/membres/page.tsx` (une seule tx, garde ADMIN dedans)
Refactor calqué EXACTEMENT sur `admin/entites/page.tsx` :
- `withWorkspace(session, async (tx, ctx) => { if (!peutAdministrer(ctx.role)) return null;
  const entites = await listerEntites(tx, ctx); const membres = await
  listerMembresWorkspace(tx, ctx); return { role: ctx.role, entites, membres }; })`
- `donnees === null → notFound()` (surface admin CACHÉE, 404 non-énumérant — inchangé).
- Entités actives projetées en `EntiteVue[]` pour le formulaire ; `membres` +
  map `id→nom` d'entité passés à la liste.

### 2.2 Composant `liste-membres.tsx` (NOUVEAU, présentationnel pur)
- Zéro fetch, zéro état (règle composant d'affichage) ; props `membres`, `entitesParId`.
- Table dense UI_GUIDELINES §2.2/§2.1 : en-têtes 12px/600 uppercase text-muted (NOM,
  EMAIL, RÔLE, PÉRIMÈTRE) ; cellules 13px ; séparateurs `line`, pas de zébrage.
- Colonne Rôle : badge (réutilise la sémantique `ROLE_BADGE`/`ROLE_LABEL` déjà définie
  dans assignation-entites — mais **présentationnel local** pour ne pas coupler ; tokens
  identiques, aucune couleur en dur).
- Colonne Périmètre : `scopeInitial.length===0` → « Vision Globale » (text-muted) ;
  sinon les noms d'entités (via `entitesParId`, repli « N entité(s) » si un id est absent
  de la map, ex. entité archivée).
- Empty state (§4.4) : « Aucun membre pour l'instant » si la liste est vide (ne devrait
  pas arriver — l'ADMIN courant y figure — mais fail-safe).

## 3. Morceau 3 — Message email-existant véridique (comportement inchangé)

Le message de succès ne doit plus laisser croire à une création quand l'user est réutilisé.
Construit depuis `utilisateurCree` / `membershipCreee` / `entityIds.length` :
- création réelle : `« <email> créé et rattaché comme <rôle>. »` (+ « Périmètre : N
  entité(s). » / « Vision Globale. »).
- user existant, nouvelle membership : `« Utilisateur existant rattaché comme <rôle> —
  mot de passe inchangé. »`.
- déjà membre : `« <email> est déjà membre — aucune modification (mot de passe et
  périmètre inchangés). »`.

Comportement **strictement inchangé** (anti-écrasement voulu) : seul le libellé change.
⚠️ Le mot de passe n'apparaît JAMAIS dans un message ni un log (règle 8).

## 4. Sécurité & garde-fous (exit-criteria règle 3) — reconduits, non réinventés

- Authz : `withWorkspace` re-valide la membership ; garde ADMIN dans les repos
  (`creerUtilisateurEtRattacher`, `definirScopesMembre`) — **jamais** côté client.
- IDOR / cross-tenant : `workspace_id = ctx.workspaceId` (jamais paramètre) ; FK composite
  `(entity_id, workspace_id)` interdit toute entité d'un autre tenant en base ; WITH CHECK
  RLS sur l'INSERT membership.
- Validation : zod `.strict()`, bornes (email 254, nom 120, mdp 12–200, role enum,
  entityIds uuid×≤200).
- Messages non-énumérants : entité/membre introuvable → « Champs invalides. » générique ;
  refus rôle → « Action non autorisée. ». (Nuance email-existant : cf. dette
  PROV-EMAIL-EXISTANT1 §6.)
- Argon2 **dans l'action**, jamais dans le repo ; aucun mot de passe en clair loggé.

## 5. Tests

### 5.1 `tests/isolation/provisioning-scopes-isolation.test.ts` (NOUVEAU, bloquant CI)
Sous `tygr_app` (RLS active), DDL = migrations réelles + provisioning (source unique) —
gabarit `entites-admin-isolation.test.ts`. Cas :
1. **Heureux** : ADMIN_A crée un MANAGER neuf avec `[ENT_SUCRE]` → user + membership +
   1 ligne `member_entity_scopes` (Sucrière). Contre-preuve owner.
2. **Atomicité cross-tenant (le cœur, règle 3)** : ADMIN_A crée un user neuf avec
   `[ENT_B]` (entité de WS_B) → rejet ; **aucun** user/membership/scope ne persiste
   (vérifié sous owner : rollback total). Un membre de A ne reçoit JAMAIS un scope de B.
3. **Vision Globale** : ADMIN_A crée un membre avec `[]` → user + membership, **0** ligne
   de scope.
4. **Non-ADMIN** : MANAGER_A tente la chaîne → `ProvisioningNonAutoriseError`, rien créé.
5. **Email existant** : ré-provisionner un email déjà membre → mot de passe INCHANGÉ
   (hash owner constant) ET scopes existants NON touchés (`membershipCreee===false` ⇒
   pas d'appel `definirScopesMembre`).
6. **User existant d'un autre workspace** : rattachement à A sans réécrire son hash.

Le test appelle la logique de chaînage réutilisable (extraite en fonction pure
`provisionnerAvecScopes(tx, ctx, {…})` dans le repo, ou reproduite fidèlement) plutôt que
la Server Action (dépendante d'Auth.js) — même approche que les suites existantes qui
testent les repos, pas les actions.

### 5.2 Non-régression
- `epic2-workspaces.integration.test.ts` (retour enrichi compatible) : inchangé, doit rester vert.
- `entites-admin-isolation.test.ts` : inchangé.

## 6. Dette à TRACER dans TODOS.md (ne PAS coder ici)

- **AUTH-MDP-TEMPO1 (P1)** — flux « mot de passe temporaire » : colonne
  `must_change_password` (migration expand), gate au premier login, page self-service de
  changement de mot de passe (aucune n'existe aujourd'hui — seul `scripts/reset-password.mjs`
  dev). Sans lui, l'ADMIN connaît indéfiniment le mot de passe du membre. Effort M.
  Déclencheur : premier onboarding de membres réels hors équipe fondatrice.
- **PROV-EMAIL-EXISTANT1 (P2)** — durcissement de la réutilisation par email : le message
  véridique révèle qu'un email existe déjà comme user TYGR, y compris dans un AUTRE
  workspace (`users` hors RLS, réutilisation globale par email) → léger oracle
  d'énumération cross-tenant sur surface ADMIN. Options : refuser la réutilisation d'un
  user non déjà membre, ou message uniforme. Effort S. Déclencheur : multi-tenant clients
  réels (aujourd'hui un seul groupe).
- Amender **QA-LISTES-MANQUANTES1(b)** : la liste des membres `/admin/membres` est livrée
  par ce chantier → cocher le sous-point (b), garder (a) `/banques`.

## 7. Ce que ce plan NE fait PAS (anti-scope-creep, règle 7)

- Ne crée PAS le flux mot de passe temporaire (dette AUTH-MDP-TEMPO1).
- Ne change PAS le comportement anti-écrasement (morceau 3 = message seulement).
- Ne touche PAS `/admin/entites`, l'ingestion, `categorisation.ts`, ni la RLS/migrations.
- Ne gère PAS l'édition/retrait d'un membre depuis la liste (lecture seule au MVP).
- N'ajoute AUCUNE dépendance (règle 9).

## 8. Gates de sortie

`npm.cmd run lint` + `typecheck` + `test` (suite isolation incluse) au vert ; commits
conventionnels FR granulaires ; cross-review contexte frais (règle 6) ; **STOP à la PR**
(feat/ applicatif → Human-in-the-Loop, pas d'auto-merge).
