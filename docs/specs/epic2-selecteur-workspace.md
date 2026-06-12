# SPEC — Epic 2 : Sélecteur de workspace, bascule, provisioning ADMIN, gating VIEWER

> Statut : **plan d'implémentation autonome** (autonomie complète accordée
> 2026-06-12, sous stop-loss boucle/sécurité/qualité). Surface tenant/sécurité →
> spec sur disque (règle 1). Branche : `feature/epic2-workspaces`.
> Source design : plan v2.1 D2 (matrice écrans × états, ligne « Sélecteur
> workspace » et « Transverse / VIEWER »).

## Contexte

L'auth produit aujourd'hui un `activeWorkspaceId` = **premier membership** (config.ts:85),
figé au login, jamais changeable. Pour un utilisateur multi-workspace (DAF groupe,
demain SaaS), il faut : voir ses workspaces, en choisir un, **basculer** sans se
reconnecter. Plus le provisioning (un ADMIN rattache des utilisateurs) et le gating
VIEWER (lecture seule). C'est la première feature qui rend le multi-tenant *visible*.

## État vérifié (2026-06-12, main @ 4dd1186)

- `config.ts:82-85` : `jwt` callback fige `activeWorkspaceId` au login, pas de
  mise à jour ultérieure. Pas de `trigger === "update"` géré.
- `session.ts` : `exigerSessionWorkspace` re-valide `is_active` + exige un
  `activeWorkspaceId`. `withWorkspace` re-valide la membership à CHAQUE requête
  (E14) → un workspace non-membre donne 404.
- `identite.membershipsDe(userId)` : lit les memberships sous RLS
  (`own_memberships_select`), triés. Déjà testé (suite isolation cas 9).
- Rôles : ADMIN / MANAGER / VIEWER (schema, check contrainte).
- Aucun écran post-login autre que l'accueil ; pas de page de provisioning.

## Périmètre (4 lots) & ce qui est explicitement HORS scope

| Lot | Inclus | Hors scope |
|---|---|---|
| L1 Sélecteur | Page/écran de choix de workspace (états D2 : skeleton, vide, erreur, **skip auto si 1 seul**), switcher header permanent | Le badge workspace existe déjà (page.tsx) — on le fait évoluer en switcher |
| L2 Bascule | Server Action `basculerWorkspace(workspaceId)` → met à jour `activeWorkspaceId` dans le JWT via `unstable_update`/session update, **re-validation membership obligatoire** | — |
| L3 Provisioning ADMIN | Server Action ADMIN « créer un utilisateur + rattacher à un workspace avec rôle » ; écran minimal | Invitations email, self-service (P3) |
| L4 Gating VIEWER | Helper `peutModifier(role)` + désactivation des actions + tooltip « réservé aux managers » ; surfaces ADMIN cachées si non-ADMIN | — |

## ARBITRAGES SÉCURITÉ (le cœur de l'Epic — anti-IDOR)

**S1 — La bascule re-valide la membership À L'ÉCRITURE du token (défense en
profondeur).** Le risque IDOR n°1 : `basculerWorkspace(wsId)` écrit `wsId` dans le
JWT sans vérifier que l'utilisateur est membre → il force un tenant étranger. Même
si `withWorkspace` rattrape ensuite (404), on NE DOIT PAS écrire un
`activeWorkspaceId` non autorisé dans le token. Donc : `basculerWorkspace` appelle
`membershipsDe(userId)` et **rejette** (erreur nommée `WorkspaceSwitchDeniedError`)
si `wsId` n'y est pas — AVANT toute mise à jour de session. Double barrière :
écriture validée + lecture re-validée.

**S2 — `membershipsDe` reste la seule source des workspaces affichés.** Le
sélecteur n'affiche QUE `membershipsDe(userId)` (lu sous RLS). Jamais une liste
construite côté client ou depuis un paramètre. Pas d'énumération de workspaces
d'autrui.

**S3 — Le provisioning ADMIN est gardé par le rôle du CONTEXTE, pas du client.**
`creerEtRattacher` ne s'exécute que si `ctx.role === "ADMIN"` (résolu par
`withWorkspace` à chaque requête, jamais depuis le JWT/client). Un MANAGER/VIEWER
qui forge la requête → rejet (erreur nommée, pas 403 énumérant). L'ADMIN ne peut
rattacher qu'à un workspace dont IL est membre ADMIN (pas de création cross-tenant).

**S4 — Cas ajoutés à la suite IDOR (BLOQUANT) :** (a) bascule vers un workspace
non-membre → rejet, JWT inchangé ; (b) provisioning par un non-ADMIN → rejet ;
(c) provisioning ciblant un workspace où l'acteur n'est pas ADMIN → rejet.

## Implémentation (lots = commits)

### L1 — Sélecteur + states D2
- `src/app/(workspace)/selection/page.tsx` (Server Component) : liste
  `membershipsDe`. **Skip auto** : si 1 seul membership ET déjà actif → redirect
  accueil. États : skeleton (chargement RSC), vide (« Aucun workspace — contactez
  votre administrateur » + mail ADMIN), erreur (retry). Tokens UI_GUIDELINES.
- Switcher header : `src/components/shell/WorkspaceSwitcher.tsx` (client, dropdown
  riche §4.4) — liste des memberships, actif coché, action = bascule L2.

### L2 — Bascule
- `src/app/(workspace)/actions.ts` : `"use server"` `basculerWorkspace(wsId: string)`
  — zod (uuid strict), `exigerSessionWorkspace`, `membershipsDe`, **rejet S1** si
  non-membre, sinon session update de `activeWorkspaceId` + redirect accueil.
- `config.ts` : gérer `trigger === "update"` dans le `jwt` callback pour propager
  le nouveau `activeWorkspaceId` au token (re-vérifié S1 en amont).

### L3 — Provisioning ADMIN
- Repository : `creerUtilisateurEtRattacher` (dans un repository scopé server/) —
  crée l'user (email normalisé, hash argon2 d'un mot de passe initial) + insère le
  membership DANS `withWorkspace` (RLS WITH CHECK garantit le bon tenant). Garde S3.
- `src/app/(workspace)/admin/membres/` : écran minimal (formulaire), visible ADMIN
  uniquement (S3 + L4).

### L4 — Gating VIEWER
- `src/lib/permissions.ts` (pur, isomorphe) : `peutModifier(role)` →
  `role !== "VIEWER"`. Testable unitairement.
- UI : actions désactivées (opacité 48% §2.3) + tooltip « réservé aux managers » ;
  surfaces ADMIN cachées (pas désactivées) si `role !== "ADMIN"` (D2 ligne 37).

## Critères d'acceptation

1. lint + tsc + build + tests verts. Suite IDOR étendue (S4 a/b/c) BLOQUANTE.
2. Multi-workspace : un user membre de 2 WS voit le sélecteur, bascule, et
   l'accueil reflète le nouveau workspace (badge + données scopées).
3. Mono-workspace : skip auto, aucun écran de choix (D2).
4. **IDOR (S1) :** bascule forgée vers un WS non-membre → rejet, `activeWorkspaceId`
   du JWT INCHANGÉ (test : le token ne contient jamais le WS étranger).
5. **Provisioning (S3) :** non-ADMIN → rejet ; ADMIN ne rattache qu'à ses WS ADMIN.
6. **VIEWER :** actions de modification désactivées + tooltip ; surfaces ADMIN
   absentes du DOM (pas juste cachées en CSS) pour un non-ADMIN.
7. États D2 du sélecteur : skeleton / vide / erreur — **QA visuelle headless
   obligatoire, zéro chevauchement CSS** (stop-loss qualité).
8. Tests : unités (permissions, validation), intégration (bascule + provisioning
   sur PGlite/rôle non-owner), IDOR (S4).

## Plan de test

| Couche | Quoi | Nb (cible) |
|---|---|---|
| Unit | `peutModifier` (3 rôles), zod uuid bascule | +4 |
| Intégration | bascule membre OK / non-membre rejet ; provisioning ADMIN OK / non-ADMIN rejet | +4 |
| IDOR (S4) | bascule non-membre, provisioning non-ADMIN, provisioning hors-ADMIN-tenant | +3 |
| Visual QA | sélecteur états repos/loading/erreur — vision, anti-chevauchement | manuel |

## Hors scope (TODOS si nouveau)

- Consolidation cross-workspace (vue holding) — exclue (modèle de permission à
  concevoir, plan).
- Invitations email / self-service onboarding (P3).
- SSO provider (P2).

## Rollback

Branche `feature/epic2-workspaces`. Une migration possible si un mot de passe
initial / champ de provisioning l'exige (à confirmer en L3 — sinon zéro migration).
Revert du PR = retour à l'`activeWorkspaceId` figé au login. Aucun risque données.

## Stop-loss actifs (rappel, instructions 2026-06-12)

- **Boucle** : >3 modifs du même fichier pour un test → arrêt + rapport.
- **Sécurité** : tout risque d'exposition cross-tenant (IDOR) → arrêt immédiat.
- **Qualité** : QA visuelle headless systématique sur les 3 états du sélecteur,
  zéro chevauchement CSS.
