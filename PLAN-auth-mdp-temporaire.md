# PLAN — Flux « mot de passe temporaire » (AUTH-MDP-TEMPO1)

> **Phase : CONCEPTION** (règle 1 — plan sur disque, zéro code applicatif dans cette PR).
> Branche : `feat/auth-mdp-temporaire`. Date : 2026-07-17. Effort : M. Priorité : P1
> (déclencheur TODOS : premier onboarding de membres réels hors équipe fondatrice ;
> SLA P1 = avant le premier déploiement de production).
> Référence dette : `TODOS.md:1080-1090` + `TODOS.md:2413` (Epic 1 §10) +
> `PLAN-membres-creation-scopes.md` §6 + `PLAN-epic1-auth-consent.md:344-348`.

---

## 0. Contexte confirmé par inspection (ne PAS réimplémenter)

Tout ce qui suit a été vérifié dans le worktree (pointe de `main`, commit `2146d12`+…
= PR #216) le 2026-07-17. Le chantier se construit PAR-DESSUS, sans rien réinventer.

| Brique | État | Référence |
|---|---|---|
| Provisioning membre (admin saisit le mdp initial) | ✅ livré (squash-mergé) | `src/app/(workspace)/admin/membres/actions.ts:55-139`, `src/server/repositories/provisioning.ts:82-…` |
| Hash | argon2id, **défauts de la lib** (`m=65536,t=3,p=4`), aucun paramètre custom nulle part | `membres/actions.ts:73`, `verifier-identifiants.ts:38-39` (`HASH_FACTICE`) |
| Anti-écrasement | un user existant réutilisé ne voit JAMAIS son mdp réécrit | `provisioning.ts:104-107` |
| Login | `verifierIdentifiants` : zod → limite IP (E7, 20/15 min, `login_attempts`) → lookup → argon2 TOUJOURS exécuté (égalisation timing) → verrou → échec/inactif ; message UI unique (non-énumération E18) | `src/server/auth/verifier-identifiants.ts:83-144` |
| Lockout compte (E18) | machine pure : 5 échecs → verrou 60 s doublant jusqu'à 1 h ; succès = RAZ ; persistance `FOR UPDATE` | `src/server/auth/lockout.ts:21-77`, `src/server/repositories/identite.ts:88-107` |
| Session | JWT (`strategy:"jwt"`, maxAge défaut 30 j) ; contenu = `{ userId, activeWorkspaceId, viewFilter }` ; **PAS de rôle** (re-résolu E14), **AUCUN mécanisme d'invalidation** (pas de sessionVersion/jti) | `src/server/auth/config.ts:25-176`, `src/types/next-auth.d.ts:17-33` |
| Re-check par-requête (E6) | `exigerSessionWorkspace()` relit `users.is_active` en base à CHAQUE requête, fail-closed ; erreurs typées mappées par le layout (`NonAuthentifieError`→`/login`, `AucunWorkspaceActifError`→`/selection`) | `src/server/auth/session.ts:60-101`, `(workspace)/layout.tsx:174-178` |
| Middleware | `src/proxy.ts` (Next 16) = check **optimiste de PRÉSENCE du cookie**, ne déchiffre PAS le JWT, pas de DB → **le gate ne peut pas y vivre** | `proxy.ts:1-42` |
| `/selection` | appelle `auth()` **directement**, sans re-check E6 (constat, corrigé au passage — §5.3) | `(workspace)/selection/page.tsx:21-26` |
| Modale re-login | mergée (timer `expiresAt`, `signIn` sans redirect, garde anti-fuite d'identité) | `components/shell/garde-session.tsx`, `(workspace)/session-actions.ts:49-83` |
| Table `users` | `password_hash varchar(255) NULL` (NULL=SSO futur), `is_active`, `failed_login_count`, `locked_until` ; **hors RLS** (méta-table d'identité globale — un user peut appartenir à N workspaces) ; **PAS de `must_change_password`** | `src/server/db/schema.ts:77-94` |
| Migrations | max actuel = `0021_consent-records-audit-events.sql` → **prochaine = 0022** ; journal à trous connus (idx 9 absent) + test gardien `tests/isolation/migrations-journal-coherence.test.ts` | `drizzle/migrations/` |
| Audit | `audit.consigner(tx, ctx, …)` exige `ctx.workspaceId` (workspace-scopé) — pas de forme naturelle pour un événement user-global | `src/server/repositories/audit.ts:242-268` |
| Rotation dev | `scripts/reset-password.mjs` (dev-local, refuse `*.neon.tech`) : UPDATE `password_hash` + RAZ lockout | `reset-password.mjs:45-64` |
| Langue | **Q-LANG** : destination produit = ANGLAIS ; aucune nouvelle copie FR en dur (le « Interface en français » du CLAUDE.md est périmé sur ce point, réconciliation `DESIGN-DOCS-PERIMEES1`) | TODOS Q-LANG |

**La menace, précisément** : l'ADMIN fixe le mot de passe initial → il le connaît. Sans
forçage de changement : (a) il peut se connecter COMME le membre, indéfiniment,
indistinguablement ; (b) le secret transmis hors-bande (chat/papier) reste valide à vie.
L'objectif de sécurité du chantier n'est PAS « une case UX au premier login », c'est :
**après le changement, plus personne d'autre que le membre ne détient un secret valide,
et toute session ouverte avec l'ancien secret meurt** — y compris une session que
l'admin aurait ouverte AVANT le changement. Sans ce dernier point (invalidation),
la feature rate sa cible : le plan le traite comme non négociable (D4).

---

## 1. Décisions tranchées

### D1 — Hash du mot de passe temporaire : argon2id, colonne unique, zéro divergence

Le mot de passe temporaire **EST** un mot de passe ordinaire : haché **argon2id défauts**
(comme `membres/actions.ts:73` et tout le repo), stocké dans **`users.password_hash`**.
Pas de colonne « mdp temporaire » séparée, jamais de clair, jamais de log (règle 8).
Seul le FLAG (D2) distingue l'état « temporaire ». Écarté : un secret séparé
(2 chemins de vérification = 2 surfaces d'erreur, zéro gain).

### D2 — Modèle : 2 colonnes expand, pas de colonne d'expiration dédiée

```sql
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;  -- NULL = jamais posé depuis la migration
```

`password_changed_at` = **dernier POSAGE de mot de passe**, par qui que ce soit
(l'admin au provisioning, le membre au changement, l'opérateur au reset dev). Une seule
colonne sert TROIS usages : l'expiration du temporaire (dérivée `password_changed_at +
TTL`, lot B — pas de colonne `expires_at` à maintenir), l'invalidation de session (D4),
et un fait d'audit minimal. Écarté : `temp_password_expires_at` dédiée (2e horloge à
garder cohérente, zéro information en plus).

### D3 — Gate : re-lecture DB par-requête (modèle E6), PAS de flag dans le JWT

Le flag `must_change_password` n'entre **pas** dans le JWT : ce serait un cache
périmable, exactement le piège que le projet a déjà tranché pour le rôle (E14,
`next-auth.d.ts:3-5`). Le gate suit le modèle **E6** existant : la lecture par-requête
`identite.estActif(userId)` (`session.ts:73`) est **étendue** en `identite.etatCompte(userId)`
retournant `{ isActive, mustChangePassword, passwordChangedAt }` — **même requête
unique, zéro coût ajouté**. Le proxy (cookie non déchiffré) est inchangé.

Nouvelle erreur nommée (registre S2) : `MotDePasseAChangerError { code = "PASSWORD_CHANGE_REQUIRED" }`,
jetée par `exigerSessionWorkspace()` (donc héritée par `exigerSessionSansPerimetre` /
`exigerSessionAdministration`) quand le flag est vrai. Mappée → `redirect("/account/password")`.

**Sites de mapping à étendre (liste exhaustive au 2026-07-17, à re-vérifier par grep
`NonAuthentifieError` à l'implémentation)** : `(workspace)/layout.tsx:174` + les pages
qui re-mappent localement : `echeances/page.tsx`, `regles/page.tsx`,
`admin/entites/page.tsx`, `admin/membres/page.tsx`, `banques/page.tsx`,
`transactions/page.tsx`. Un site oublié = `MotDePasseAChangerError` tombe au
`throw erreur` final → 500 pour l'utilisateur gaté : la cross-review (règle 6)
vérifie l'exhaustivité PAR GREP. Écarté : `redirect()` directement dans la garde
(fail-closed par construction, mais déroge au pattern erreurs-typées-mappées du
projet et casse la testabilité de `session.ts` ; le grep de revue couvre le risque).

Nouvelle garde légère `exigerSessionUtilisateur(): Promise<{ userId: string }>` dans
`session.ts` : `auth()` → `userId` → `etatCompte` → checks E6 + invalidation (D4),
**SANS** exiger de workspace et **SANS** jeter `MotDePasseAChangerError`. Utilisée par :
la page/action de changement (c'est la surface autorisée), et **`/selection`** (qui
gagne au passage le re-check E6 qui lui manque — constat §0 ; le flag y redirige
aussi : un membre multi-workspace change son mdp AVANT de choisir un espace, la page
`/selection` mappe la nouvelle erreur comme le layout).

### D4 — Invalidation de session : claim `pwdAt` comparé par ÉGALITÉ STRICTE — le cœur du chantier

- **Émission** : `authorize` (via `verifierIdentifiants` étendu) retourne aussi
  `passwordChangedAt` ; le callback `jwt` pose `token.pwdAt = passwordChangedAt?.getTime() ?? null` ;
  le callback `session` le recopie (`session.pwdAt`). Types augmentés dans
  `next-auth.d.ts` (⚠️ cibler `@auth/core/jwt`, pas le ré-export — piège documenté
  `next-auth.d.ts:26-28`).
- **Vérification par-requête** (dans `exigerSessionWorkspace` ET `exigerSessionUtilisateur`,
  juste après le check `isActive`) : `normaliser(session.pwdAt) !== normaliser(etat.passwordChangedAt)`
  → **`NonAuthentifieError`** (une session périmée est INDISTINGUABLE d'un
  non-connecté — on ne confirme jamais à un porteur de session volée que « le mot de
  passe a changé »). Normalisation : `null`/`undefined`/claim absent ≡ `null` ;
  comparaison en epoch ms. Égalité stricte plutôt que `<` : insensible aux horloges,
  et un POSAGE ultérieur par l'admin (lot B) tue aussi les sessions du membre — voulu.
- **Survie de la session courante** : après un changement réussi, l'action appelle
  `unstable_update({ pwdAt: <nouveau> })` (pattern maîtrisé au projet,
  `(workspace)/actions.ts:60`) → callback `jwt` sur `trigger === "update"` re-valide
  et écrit `token.pwdAt` (même schéma de re-validation que `activeWorkspaceId`,
  `config.ts:97-109` : ne JAMAIS écrire une valeur client sans la re-lire en base —
  ici : relire `etatCompte` et poser la valeur DB, pas celle du client).
- **Effet** : toute session émise avant le changement (ancien `pwdAt`) meurt à sa
  **prochaine requête gardée** — dont une session ouverte par l'ADMIN avec le mot de
  passe temporaire. Sessions pré-migration (claim absent) vs colonne NULL → égales →
  valides : la migration n'éjecte personne ; le premier changement, si.
- Écarté : `sessionVersion` entier (équivalent, mais une 2e colonne + une 2e
  sémantique alors que `password_changed_at` existe déjà pour D2) ; liste de
  révocation serveur (stateful, sur-dimensionné pour un JWT 30 j).

### D5 — Écran de forçage : `/account/password`, hors `(workspace)`, copie EN

- **Segment** : `src/app/account/password/` — HORS du groupe `(workspace)` (aucun
  workspace requis : le forçage précède même `/selection`). Le matcher du proxy ne
  l'exclut pas → cookie exigé, comme le reste : rien à changer dans `proxy.ts`.
  Segment en ANGLAIS : Q-LANG fixe la destination EN — une route qui NAÎT aujourd'hui
  naît du bon côté de la dette (les segments FR existants seront renommés par le
  chantier EN, pas l'inverse).
- **Page** (RSC) : `exigerSessionUtilisateur()` ; si `must_change_password` est FAUX,
  la page reste accessible (self-service assumé — le TODOS demande explicitement une
  « page self-service ») avec un lien retour ; si vrai, bandeau explicatif du forçage.
  Calquée sur `login/page.tsx` (carte centrée, tokens sémantiques, pas de sidebar
  workspace — l'utilisateur gaté ne doit RIEN voir du produit).
- **Formulaire** (client, calqué `login/formulaire-connexion.tsx`) : 3 champs —
  `currentPassword` (`autoComplete="current-password"`), `newPassword` et
  `confirmPassword` (`autoComplete="new-password"`), `maxLength=200`, aide
  « At least 12 characters » ; `useActionState` ; erreur `role="alert"` ; spinner.
  ⚠️ Piège connu : l'action vit dans un `actions.ts` séparé (`"use server"` au niveau
  fichier) — jamais une closure locale capturant une fonction du module
  ([piège « use server » capture]).
- **Copie 100 % EN** (Q-LANG), registre §6. Après succès : `redirect("/")`.
- **Point UI optionnel** : entrée « Change password » dans le menu utilisateur du
  shell SI un tel menu existe déjà ; sinon NE PAS créer de menu pour ça — tracer
  une dette S (« découvrabilité self-service ») au TODOS.

### D6 — Rate-limit de l'endpoint de changement : MUTUALISER le lockout E18, décision sous FOR UPDATE

Vérifier `currentPassword`, c'est vérifier **le même secret** que le login → même
défense, mêmes colonnes, même machine pure (`lockout.ts`) :

- Un échec de `currentPassword` **compte comme un échec de connexion** :
  transition `evaluerEchec` sur `users.failed_login_count` / `locked_until`.
  Verrou actif → refus (`ACCOUNT_LOCKED`). Succès → RAZ (`evaluerSucces`).
  Conséquence assumée et VOULUE : 5 échecs cumulés (login + changement confondus)
  verrouillent le compte partout — c'est le même attaquant qui brute-force le même
  secret, le canal est indifférent.
- **Atomicité — la surface NAÎT sans la course CSO** : la décision finale
  (verrou ? → verify → écrire) est re-prise **dans UNE transaction `FOR UPDATE`**
  (séquence §5.4) : deux soumissions concurrentes ne peuvent ni bypasser le verrou
  ni perdre un incrément. On n'importe PAS le pattern read-decide-write du login ;
  on ne RÉPARE pas non plus le login ici (dette « CSO findings 1+2 »,
  `TODOS.md:2645`, lot séparé déjà tracé — périmètre inchangé).
- **Pas de plafond IP** sur cette surface : elle est authentifiée (le plafond IP E7
  protège la surface NON authentifiée `/login`, règle 3) ; le lockout par compte
  suffit et n'ouvre aucun DoS par IP partagée (NAT de bureau).
- Écarté : nouvelle table de tentatives (rien à stocker que `users` ne porte déjà) ;
  fenêtre glissante dédiée (une 2e sémantique de verrou pour le même secret).

### D7 — Pose du flag : à l'INSERT uniquement, anti-écrasement conservé

- `provisionnerMembre` / `creerUtilisateurEtRattacher` : l'INSERT `users` pose
  `must_change_password: true` + `password_changed_at: now()`. Un utilisateur
  EXISTANT réutilisé (rattachement) n'est **pas touché** (ni hash, ni flag —
  `provisioning.ts:104-107` inchangé) : on n'invalide jamais les sessions d'un user
  qu'on ne re-crédentialise pas.
- `scripts/seed-admin.mjs` : rien à changer (INSERT sans la colonne → DEFAULT false ;
  l'opérateur qui se seede choisit son propre mdp).
- `scripts/reset-password.mjs` : pose **systématiquement** `password_changed_at = now()`
  (un reset est un posage → il DOIT invalider les sessions du compte, D4) + flag selon
  env **`RESET_MUST_CHANGE=1`** (défaut `0` : l'usage dev courant — se reset soi-même —
  ne se re-gate pas ; le runbook prod, quand il existera, documentera `=1` pour
  resetter un tiers). `docs/DEMARRAGE-SANDBOX-PROD.md` § « Bootstrap du premier
  ADMIN » amendé en conséquence.

### D8 — Expiration du mot de passe temporaire : OUI, TTL 7 jours — mais en LOT B, indissociable du reset admin

**Trancher l'expiration seule serait une impasse opérationnelle** : si le temporaire
expire et qu'aucun chemin de renouvellement in-app n'existe (le provisioning est
anti-écrasement ; `reset-password.mjs` refuse la prod), le membre est bloqué
DÉFINITIVEMENT. L'expiration et le **reset admin** vivent donc ensemble :

- **Check** : au LOGIN uniquement, dans `verifierIdentifiants`, APRÈS vérification
  argon2 réussie : `mustChangePassword && passwordChangedAt + 7 j < now()` → code
  `TEMP_PASSWORD_EXPIRED`, message DÉDIÉ (« Your temporary password has expired.
  Ask your administrator to issue a new one. »). Pas d'oracle : celui qui voit ce
  message détient le bon mot de passe — il connaît déjà le compte. Un mauvais mdp
  sur un temporaire expiré → message générique habituel, compteur E18 normal.
  TTL = constante nommée (`DUREE_VIE_MDP_TEMPORAIRE_MS`, 7 jours — NIST 800-63B :
  secret d'enrôlement à durée bornée) ; pas d'expiration en cours de session (le
  gate D3 force déjà le changement).
- **Reset admin** (« Issue a new temporary password ») : action + bouton dans
  `liste-membres.tsx`, garde `exigerSessionAdministration` + rôle ADMIN côté
  repository (pattern `exigerAdmin(ctx)`), confirmation explicite. Pose : nouveau
  hash (mdp saisi par l'admin, min 12 — même schéma zod que le provisioning),
  `must_change_password = true`, `password_changed_at = now()` (→ D4 : tue TOUTES
  les sessions du membre, y compris actives — c'est le but d'un reset), RAZ lockout
  (déverrouille un membre auto-verrouillé : c'est le recours humain à E18).
  ⚠️ Le reset redonne à l'admin la connaissance du secret — intrinsèque au modèle
  sans canal email ; le flag + le TTL bornent exactement cette fenêtre. Restriction :
  un ADMIN ne peut pas resetter un autre ADMIN ? **Non retenu** au MVP (un seul
  groupe, admins de confiance) — tracé en une ligne dans la dette D10.
- **Séquencement** : le LOT A (cœur, §8) est livrable et utile SANS le lot B — le
  flag garantit déjà que toute PREMIÈRE connexion change le secret. Le lot B ferme
  la fenêtre « compte provisionné jamais activé » et donne le recours « mdp oublié /
  compte verrouillé ». Deux PR distinctes, le lot B enchaîné derrière.

### D9 — Audit : PAS d'événement `audit_events` dans ce chantier

`audit.consigner` exige `ctx.workspaceId` (`audit.ts:256-268`) : l'événement serait
dupliqué N fois pour un user multi-workspace, ou arbitrairement rattaché à un seul.
Le changement de mdp est un fait USER-global ; la table d'audit est tenant-scopée
par conception (réglementaire Omni-FI). → Hors scope, **dette P2 tracée** (§10),
raccrochée au panneau L3.4 d'Epic 1 (« événements de sécurité compte »). Les logs
structurés (§6) couvrent l'observabilité en attendant.

---

## 2. Pushback (règle 10) — l'alternative « lien d'invitation » et pourquoi pas maintenant

**Alternative examinée** : l'admin ne choisit JAMAIS de mot de passe — il génère un
**lien d'invitation** à usage unique et expirant ; le membre définit lui-même son
secret au premier accès. Posture supérieure : l'admin ne détient jamais AUCUN secret
du membre (ni fenêtre de 7 jours, ni session pré-changement à invalider).

| | Mdp temporaire + flag (CE plan) | Lien d'invitation |
|---|---|---|
| Secret connu de l'admin | Oui, borné (flag + TTL 7 j + invalidation) | **Jamais** |
| Infra requise | Rien de neuf (users + lockout existants) | Table `invitation_tokens` (hash du token, TTL, usage unique) + **surface PUBLIQUE** `/invite/[token]` (non authentifiée → rate-limit IP obligatoire, règle 3) + anti-énumération de tokens |
| Canal de remise | Hors-bande (chat/oral) — inchangé | **Email idéalement — le stack n'a AUCUN envoi d'email** (Inngest présent mais aucun provider). Sans email : l'admin copie-colle le LIEN par le même canal hors-bande |
| Coût | M (ce plan) | M-L (table + surface publique + expiration + re-génération + états UI) |
| Ce qu'il resterait à construire quand même | — | Le reset « mdp oublié » passe aussi par une invitation → même besoin de D8 |

**Verdict** : l'invitation est la CIBLE SaaS-ready, pas le premier pas. Sans canal
email, son avantage net sur ce plan se réduit à « le secret transmis est à usage
unique » — réel, mais le flag + TTL + invalidation en bornent déjà l'essentiel, pour
une infra bien moindre et sur des briques (lockout, zod, argon2) déjà éprouvées.
**Décision : flux mot de passe temporaire maintenu** (celui que la dette TODOS
esquisse), évolution « invitations » tracée §10 — déclencheur : infra email posée OU
premiers clients EXTERNAL_CLIENT (cahier §4.1). Le présent chantier n'est pas jeté
le jour des invitations : le gate, l'invalidation D4 et le reset D8 restent le socle.

---

## 3. Modèle de données & migration `0022` (expand)

- `src/server/db/schema.ts` (table `users`, après `lockedUntil` `:88`) :
  ```ts
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  ```
- Générée par **`npm run db:generate`** (jamais un `.sql` écrit à la main hors
  journal — piège connu : collision de numéro au generate suivant). Vérifier après
  génération : entrée `_journal.json` + snapshot présents, `0022` bien le numéro,
  et `tests/isolation/migrations-journal-coherence.test.ts` vert.
- **Expand pur, backward-compatible N-1** (règle 9) : DEFAULT false + NULL —
  le code N-1 ignore les colonnes ; aucun backfill (`password_changed_at` NULL =
  « jamais posé depuis la migration », sémantique assumée par D4).
- `users` est HORS RLS et dans la liste blanche DELETE : **rien à toucher** côté
  provisioning SQL / policies / triggers. Aucune table nouvelle.

---

## 4. Types & contrats étendus

- `identite.etatCompte(userId): Promise<{ isActive: boolean; mustChangePassword: boolean; passwordChangedAt: Date | null } | null>`
  — remplace `estActif` (appelant unique : `session.ts:73` ; les tests
  `repository-identite.test.ts` migrent). `null` = user inexistant → traité comme
  inactif (fail-closed).
- `UtilisateurIdentite` (`identite.ts:33-41`) : + `mustChangePassword`,
  `passwordChangedAt` ; `trouverParEmail` sélectionne les 2 colonnes en plus.
- `verifierIdentifiants` : le résultat succès porte aussi `passwordChangedAt`
  (+ lot B : nouveau code `TEMP_PASSWORD_EXPIRE` dans son union de codes).
- `next-auth.d.ts` : `Session { pwdAt?: number | null }` et
  `JWT { pwdAt?: number | null }` (module `@auth/core/jwt`, piège du ré-export).
- `session.ts` : + `MotDePasseAChangerError { code = "PASSWORD_CHANGE_REQUIRED" }`,
  + `exigerSessionUtilisateur()`, extension d'`exigerSessionWorkspace` (ordre §5.3).
- Nouveau `src/server/repositories/mot-de-passe.ts` (ou extension d'`identite.ts` —
  au choix de l'implémentation, MÊME module que le lockout de préférence) :
  `changerMotDePasse(userId, { verifierAncien, nouveauHash, maintenant })` portant
  la transaction §5.4. L'action ne touche JAMAIS la DB directement (pattern
  `membres/actions.ts:6-10`).

---

## 5. Flux détaillés

### 5.1 Provisioning (pose du flag) — D7

`creerUtilisateurEtRattacher` : l'INSERT pose `mustChangePassword: true`,
`passwordChangedAt: maintenant`. Chemins « user existant » STRICTEMENT inchangés.
Le message de succès actuel (« created and added as… ») reste — on n'y ajoute PAS le
mot de passe (règle 8 ; il est déjà à l'écran dans le champ du formulaire admin).

### 5.2 Login (émission des claims)

1. `verifierIdentifiants` inchangé dans son ordre (zod → IP → lookup → argon2
   toujours → verrou → inactif) ; il retourne en plus `passwordChangedAt`.
   *(Lot B : insérer ici, après succès argon2, le check TTL → `TEMP_PASSWORD_EXPIRE`.)*
2. `authorize` (`config.ts:34-74`) : retourne `{ id, email, name, pwdAt }`.
3. Callback `jwt` : `if (user) token.pwdAt = user.pwdAt ?? null;` — et sur
   `trigger === "update"` avec `session.pwdAt` : **re-lire `etatCompte` en base** et
   poser la valeur DB (jamais la valeur cliente — même discipline que
   `activeWorkspaceId`, `config.ts:97-109`).
4. Callback `session` : recopie `token.pwdAt`.

### 5.3 Gate par-requête — ordre STRICT des checks

Dans `exigerSessionWorkspace` (remplace le bloc `estActif`, `session.ts:71-81`) :

```
etat = identite.etatCompte(userId)        // même unique requête qu'aujourd'hui
1. etat null OU !etat.isActive        → NonAuthentifieError        (E6, inchangé)
2. pwdAt(session) ≠ pwdAt(etat)       → NonAuthentifieError        (D4 — session périmée ≡ non connecté)
3. etat.mustChangePassword            → MotDePasseAChangerError    (D3 — gate)
4. … suite inchangée (activeWorkspaceId, parse zod)
```

L'ordre 2-avant-3 garantit qu'une session pré-changement d'un compte au flag
retombé est déconnectée, jamais re-gatée. `exigerSessionUtilisateur` applique
1 et 2, **pas 3** (c'est la garde de la surface de changement et de `/selection`,
qui mappe `MotDePasseAChangerError` → `redirect("/account/password")` comme le
layout). Fail-closed conservé : échec DB → `ServiceIndisponibleError` (inchangé).

Mapping : layout + les 6 pages listées en D3 ajoutent
`if (erreur instanceof MotDePasseAChangerError) redirect("/account/password");`.

### 5.4 Action `changerMotDePasse` — séquence exacte

Fichier : `src/app/account/password/actions.ts` (`"use server"` niveau fichier).

```
1. session = exigerSessionUtilisateur()            // E6 + D4 ; PAS de gate D3
2. zod .strict() : { currentPassword: z.string().min(1).max(200),
                     newPassword: z.string().min(12).max(200),
                     confirmPassword: z.string().min(1).max(200) }
   → invalide : { erreur: "Invalid input.", code INVALID_INPUT }
   newPassword !== confirmPassword → PASSWORDS_DO_NOT_MATCH (check zod .refine)
   newPassword === currentPassword → SAME_AS_CURRENT (égalité de chaînes, avant tout hash)
3. nouveauHash = argon2.hash(newPassword)          // AVANT la transaction (~100 ms hors verrou)
4. repositories.changerMotDePasse — UNE transaction :
   a. SELECT id, password_hash, failed_login_count, locked_until, is_active
      FROM users WHERE id = $userId FOR UPDATE
   b. inexistant OU !is_active                     → NonAuthentifieError (fail-closed)
   c. estVerrouille(lockedUntil, now)              → CompteVerrouilleError (rien d'écrit)
   d. password_hash NULL                           → CompteSansMotDePasseError (SSO futur — jamais de verify sur NULL)
   e. argon2.verify(password_hash, currentPassword) // ~100 ms SOUS verrou de ligne : assumé —
      // contention bornée à CE compte (self-DoS au pire), et c'est le SEUL moyen d'exclure
      // toute course entre verify et écriture (la surface naît sans le bug CSO du login)
      échec → UPDATE failed_login_count/locked_until (transition evaluerEchec, DANS la tx)
             → CurrentPasswordIncorrectError
   f. succès → UPDATE password_hash = nouveauHash, must_change_password = false,
      password_changed_at = now, failed_login_count = 0, locked_until = NULL
5. unstable_update({ pwdAt: now.getTime() })       // la session COURANTE survit (D4)
6. log structuré { evenement: "mot_de_passe_change", userId }   // JAMAIS le mdp, JAMAIS l'email accolé
7. redirect("/")
```

Chaque erreur du repo est une classe nommée, catchée et mappée par l'action
(registre §6) ; `throw erreur` final pour le reste (pas de catch-all, règle 3).

### 5.5 Matrice sessions concurrentes (comportement attendu = tests §7)

| Session | Après le changement du membre |
|---|---|
| Session courante du membre (celle qui change) | **Survit** (`unstable_update` → pwdAt aligné) |
| Autre onglet/appareil du membre (pré-changement) | **Morte** à sa prochaine requête gardée (pwdAt ≠) → `/login` |
| Session ouverte par l'ADMIN avec le mdp temporaire | **Morte** — idem. C'est LE scénario cible du chantier |
| Session d'un AUTRE user | Intacte (comparaison par userId, rien de global) |
| Login avec l'ANCIEN mot de passe (temporaire) | Échec argon2 normal → compteur E18 |

---

## 6. Sécurité — exit criteria règle 3, point par point + registre S2

- **Authz** : `exigerSessionUtilisateur` (E6 + D4). PAS de `withWorkspace` — assumé
  et documenté : `users` est une méta-table d'identité GLOBALE hors RLS (§0) ; il
  n'existe AUCUNE ressource tenant sur cette surface. **Anti-IDOR par construction** :
  l'action ne prend AUCUN identifiant en entrée — le `userId` vient exclusivement de
  la session ; il est STRUCTURELLEMENT impossible de changer le mdp d'un tiers
  (le schéma zod `.strict()` rejette tout champ excédentaire — test dédié).
- **404 non-énumérant** : pas de ressource adressable → N/A au sens strict ;
  l'équivalent ici : session périmée/compte inexistant/inactif ≡ `NonAuthentifieError`
  (indistinguables, §5.3-5.4b) ; `CURRENT_PASSWORD_INCORRECT` explicite est
  ASSUMÉ — l'appelant est authentifié, il n'apprend rien sur autrui.
- **Validation** : zod `.strict()`, bornes 12/200 alignées provisioning (`min(12)` =
  politique existante ; pas de règles de composition — NIST 800-63B privilégie la
  longueur ; blocklist de mdp courants = dette P2 optionnelle, §10).
- **Injection** : paramètres liés Drizzle uniquement (aucun SQL brut nouveau).
- **Rate-limit** : D6 (lockout E18 mutualisé, décision sous FOR UPDATE). Surface
  authentifiée → pas de plafond IP (règle 3 le réserve aux surfaces non authentifiées).
- **CSRF/headers** : Server Action Next (POST same-origin, encrypted action ID) —
  même posture que toutes les actions du projet ; aucune route API nouvelle.
- **Erreurs nommées** — registre S2 :

| Code machine | Où | Message UI (EN — Q-LANG) |
|---|---|---|
| `INVALID_INPUT` | action | "Invalid input." |
| `PASSWORDS_DO_NOT_MATCH` | action (zod refine) | "The new passwords do not match." |
| `SAME_AS_CURRENT` | action | "Your new password must be different from the current one." |
| `CURRENT_PASSWORD_INCORRECT` | repo→action | "Your current password is incorrect." |
| `ACCOUNT_LOCKED` | repo→action | "Too many attempts. Try again later." (jamais la durée exacte) |
| `PASSWORD_CHANGE_REQUIRED` | garde (S2) | — (redirection, pas un message) |
| `NO_PASSWORD_SET` | repo→action | "This account does not use password sign-in." |
| `TEMP_PASSWORD_EXPIRED` *(lot B)* | login | "Your temporary password has expired. Ask your administrator to issue a new one." |

- **Logs structurés** (règle 8) : `{ evenement, code, userId }` uniquement — modèle
  `config.ts:50-59`. JAMAIS le mot de passe (ni ancien ni nouveau), jamais
  email+mdp dans la même ligne, jamais dans une `cause` d'erreur.

---

## 7. UI & tests

**UI** (Gate 4) : tokens sémantiques exclusifs, erreur = fond `danger-bg` + icône +
`role="alert"` (jamais rouge nu), spinner pendant `pending`, focus visibles,
`tabular-nums` sans objet ici. Route de démo `src/app/demo/account-password-states/`
(idle / erreur / verrouillé / succès-redirect) pour la capture headless. Copie EN.

**Tests** (chemin heureux + échec spécifique + limite, règle 3) :
- **Unit** : schéma zod (bornes 12/200, `.strict()` rejette un champ en trop,
  mismatch, same-as-current) ; normalisation `pwdAt` (null/undefined/ms) ;
  *(lot B)* helper d'expiration TTL aux bornes.
- **Intégration** (calqués `connexion.integration.test.ts` + `repository-identite.test.ts`) :
  1. *Heureux* : provisionner → login → claims posés → gate (une page gardée jette
     `MotDePasseAChangerError`) → changement → flag false, `password_changed_at`
     posé, lockout RAZ → la session courante passe, une session pré-changement
     (vieux pwdAt) est rejetée `NonAuthentifieError`.
  2. *Échecs* : `currentPassword` faux ×5 → `ACCOUNT_LOCKED` **et le LOGIN est
     verrouillé aussi** (mutualisation D6 prouvée) ; compte verrouillé → refus sans
     écriture ; compte inactif → `NonAuthentifieError` ; `password_hash` NULL →
     `NO_PASSWORD_SET` sans appel argon2.
  3. *Limites* : nouveau == ancien refusé AVANT tout hash ; deux changements
     CONCURRENTS (même user) → un seul gagne, l'autre sort en
     `CURRENT_PASSWORD_INCORRECT` (sérialisés par FOR UPDATE, jamais deux hashes
     écrits) ; user au flag false → l'action marche quand même (self-service) ;
     session pré-migration (claim absent) + colonne NULL → valide.
- **Isolation** : `migrations-journal-coherence` vert avec 0022 ; AUCUN cas IDOR
  ajouté — justification écrite (règle 3) : pas de ressource tenant, pas d'entrée
  identifiante (§6). La suite isolation existante reste bloquante et intacte.

---

## 8. Découpage, gates, livraison

- **LOT A (la PR d'implémentation de ce plan — cœur, M)** : migration 0022 +
  `etatCompte` + gardes/erreur/mapping (8 sites) + claims `pwdAt` + invalidation +
  écran & action `/account/password` + pose du flag au provisioning +
  `reset-password.mjs` (D7) + tests + démo states + amendements docs
  (`cahier_des_charges.md` §4.1 : 2 colonnes ; `DEMARRAGE-SANDBOX-PROD.md`).
- **LOT B (PR suivante, S-M)** : TTL 7 j au login (`TEMP_PASSWORD_EXPIRED`) +
  action admin « Issue a new temporary password » (D8) + tests dédiés.
- **Gates** : `npm run lint` + `typecheck` + suite complète (isolation incluse) +
  build — au vert AVANT tout commit (règle 5, hooks actifs). Commits conventionnels
  FR granulaires (migration / gardes / écran / tests). Cross-review contexte frais
  (règle 6) avec mandat explicite : exhaustivité du mapping par grep
  `NonAuthentifieError`, ordre des checks §5.3, matrice §5.5.
- **Human-in-the-Loop** : PR applicative → **STOP à la PR poussée**, merge humain
  uniquement. (La présente PR — ce plan — est docs-only et s'arrête aussi à la PR.)

## 9. Ce que ce plan NE fait PAS (anti-scope-creep, règle 7)

- Ne répare PAS la course CSO du login (`TODOS.md:2645`) — lot séparé déjà tracé ;
  la nouvelle surface naît atomique, c'est tout.
- Pas d'envoi d'email, pas de flux « invitation » (§2), pas de « forgot password »
  self-service NON authentifié (exigerait l'email — même dépendance, même dette).
- Pas de SSO (le `password_hash NULL` reste réservé, l'action le refuse proprement).
- Pas d'événement `audit_events` (D9) ; pas de purge `login_attempts` (dette
  existante) ; pas de politique de complexité au-delà de min 12 ; pas de re-hash
  des coûts argon2 ; pas d'écran « profil » général ; pas de renommage des
  segments FR existants (chantier EN nommé à part).

## 10. Dettes à TRACER dans TODOS.md à la livraison du lot A

- **AUTH-AUDIT-EVENT1 (P2)** — événement « password changed » quand un modèle
  d'événement user-global existera (raccroché à Epic 1 L3.4). Déclencheur : panneau `/audit`.
- **AUTH-INVITATION1 (P2)** — flux lien d'invitation (§2). Déclencheur : infra
  email posée OU premier workspace `EXTERNAL_CLIENT`.
- **AUTH-MDP-UX1 (P2, S)** — découvrabilité self-service (entrée de menu) si non
  câblée au lot A ; blocklist de mots de passe courants (NIST, optionnel).
- **(lot B livré ?)** — sinon : l'expiration D8 + reset admin restent une entrée
  P1 nommée, déclencheur inchangé (premier onboarding réel).
- Solder `TODOS.md:1080` et la ligne jumelle `:2413` (Epic 1 §10) en cochant
  AUTH-MDP-TEMPO1 avec renvoi à ce plan.
