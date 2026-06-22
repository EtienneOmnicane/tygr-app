# PLAN — Workspace actif par défaut (DASH-WSACTIF1)

> Phase : **conception** (règle 1). Implémentation séparée référencera ce fichier.
> Décision PO (2026-06-22, AskUserQuestion) : **défaut = workspace avec le plus de
> comptes bancaires**, repli déterministe par nom. Pas de surface UI nouvelle.

## 1. Problème (prouvé)

Le dashboard affiche « 0,00 Rs » alors que des comptes/transactions existent.
**Ce n'est NI la synchro, NI le SQL d'agrégation** (cf. mémoire
`diagnostic-solde-zero-mauvais-workspace.md`, PR #93). Cause racine unique :

`src/server/auth/config.ts:84` (callback `jwt`, à la connexion) :
```ts
const memberships = await identite.membershipsDe(user.id);
token.activeWorkspaceId = memberships[0]?.workspaceId ?? null;
```
`membershipsDe` trie par `workspace_id` (un UUID **aléatoire**) → le « premier »
est arbitraire. `enardou@omni-fi.co` est ADMIN de « Omni-FI HQ » (0 compte) et
MANAGER de « Omnicane Trading BU » (12 comptes) → atterrit sur HQ = vide.

## 2. Correctif — choisir le workspace le plus « peuplé »

### 2.1. Nouvelle requête repo (identite.ts)

Ajouter à `creerRepositoryIdentite` une fonction qui renvoie, pour un user,
ses memberships **enrichis du nombre de comptes** de chaque workspace, afin de
choisir le défaut. Contraintes de sécurité (règle 2) :

- Lire `workspace_members` **SOUS RLS** via `own_memberships_select`
  (`app.current_user_id` posé en transaction) — comme `membershipsDe`.
- ⚠️ `bank_accounts` est sous RLS `tenant_isolation` keyée sur
  `app.current_workspace_id` — **PAS** `current_user_id`. On ne peut donc PAS
  compter `bank_accounts` dans la même transaction que `membershipsDe` (le GUC
  workspace n'est pas posé → 0 ligne, fail-closed). **Deux options** :

  **Option A (retenue) — agrégat via une jointure depuis workspace_members.**
  `bank_accounts.workspace_id` est filtré par la policy `tenant_isolation` qui
  exige `app.current_workspace_id`. Sans contexte workspace, la lecture directe
  de `bank_accounts` renvoie 0. **Donc on ne lit pas `bank_accounts` ici.**

  À la place : on garde la liste des memberships (lecture sûre, RLS user), et le
  **comptage des comptes par workspace** se fait par une requête `count` groupée
  que l'on autorise par une policy de lecture analogue à `own_memberships_select`
  — MAIS cela ajoute une policy sur `bank_accounts` (surface de sécurité). **Trop
  lourd pour un défaut de confort.**

  **Option B (RETENUE, plus simple et sûre) — résoudre le défaut DANS un
  contexte workspace, membership par membership.** Au login on connaît la liste
  des workspaces de l'utilisateur (`membershipsDe`, sûr). Pour chaque, on peut
  poser `app.current_workspace_id` (le user EST membre, re-validé) et compter ses
  `bank_accounts` sous la RLS normale. On choisit le workspace au plus grand
  compte. **Aucune policy nouvelle, fail-closed conservé, chaque comptage est
  scopé au workspace dont l'utilisateur est prouvé membre.**

  Pour éviter N transactions, on fait **une seule** transaction qui, pour chaque
  workspace de l'utilisateur, pose le GUC et compte — ou plus simple : une requête
  `count(*) ... group by workspace_id` exécutée **sous `current_user_id`** via une
  jointure `workspace_members ⋈ bank_accounts` où la visibilité de
  `bank_accounts` reste gouvernée par sa policy.

> **TRANCHÉ après vérification du modèle RLS** : `bank_accounts.tenant_isolation`
> exige `app.current_workspace_id`. Une jointure `workspace_members ⋈
> bank_accounts` sous `own_memberships_select` (user-scopé) verrait
> `workspace_members` mais **0 ligne** de `bank_accounts` (GUC workspace absent).
> → On adopte l'**Option B itérative bornée** : `membershipsDe` (sûr) PUIS, dans
> une transaction unique, pour chaque workspace membre, `set_config(
> app.current_workspace_id)` + `count(bank_accounts)`. Le nombre de workspaces
> par user est petit (≤ quelques dizaines) ; coût négligeable au login.

### 2.2. Fonction `membershipParDefaut(userId): Promise<string | null>`

Signature : renvoie l'id du workspace à activer (ou `null` si aucun membership).
Logique :
1. `membershipsDe(userId)` → liste des `{ workspaceId, role }` (sûr, RLS user).
   Si vide → `null` (inchangé : `AucunWorkspaceActifError` plus tard).
2. Transaction unique : pour chaque membership, `set_config(
   'app.current_workspace_id', wsId, true)` puis `count(*)` sur `bank_accounts`.
   (Le user est prouvé membre → poser ce GUC est légitime, c'est ce que fait
   `withWorkspace` ensuite de toute façon.)
3. Trier : **compte de comptes DESC**, puis **nom ASC** (déterministe en cas
   d'égalité, ex. deux workspaces à 0 compte → ordre stable). Retourner le 1er.

> Le tri secondaire par **nom** (pas par UUID) rend le défaut reproductible et
> lisible : à égalité de comptes, c'est le 1er par ordre alphabétique.

### 2.3. Branchement (config.ts)

```ts
if (user?.id) {
  token.userId = user.id;
  token.activeWorkspaceId = await identite.membershipParDefaut(user.id);
}
```
La bascule manuelle (`basculerWorkspace`, `unstable_update`) et la barrière
anti-IDOR du `trigger === "update"` restent **inchangées**.

## 3. Exit criteria (règle 3)

- [ ] Authz : la nouvelle requête lit `workspace_members` sous
      `own_memberships_select` ; les comptages `bank_accounts` sont scopés par
      `tenant_isolation` à un workspace dont l'utilisateur est membre prouvé.
      Aucun bypass RLS, aucun nouveau GRANT, aucune nouvelle policy.
- [ ] `workspace_id` jamais un paramètre client (dérivé des memberships du user).
- [ ] Erreur nommée : `null` propre si aucun membership (chemin existant
      `AucunWorkspaceActifError`). Pas de catch silencieux.
- [ ] Tests (isolation, PGlite) :
  - user membre de 2 ws (0 compte / N comptes) → défaut = celui à N comptes.
  - égalité (2 ws même nombre de comptes) → défaut = nom ASC (déterministe).
  - user sans membership → `null`.
  - **contre-preuve d'isolation** : le comptage d'un workspace ne fuit jamais
    les comptes d'un autre tenant (un 3e workspace, non membre, n'est jamais
    compté ni visible).
- [ ] Logs : aucun (chemin login déjà journalisé) ; pas de PII.

## 4. Hors périmètre (anti-scope-creep, règle 7)

- Pas de mémorisation du « dernier workspace utilisé » (option écartée par le PO).
- Pas de redirection vers `/selection` (option écartée).
- Pas de changement du sélecteur de workspace existant ni de la bascule.

## 5. Découpage

PR #1 isolée (petite, déblocage immédiat du dashboard). Branche
`fix/workspace-defaut-comptes` depuis `main` à jour.
