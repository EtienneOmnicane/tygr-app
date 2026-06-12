# SPEC — Provisioning du rôle `tygr_app` (résolution dette P0-b)

> Statut : **EN ATTENTE D'APPROBATION HUMAINE** — aucune ligne de SQL/code avant
> (CLAUDE.md règle 1 ; surface = rôles DB + RLS, donc spec obligatoire).
> Branche d'exécution : `fix/provisioning-tygr-app`.
> Origine : revue Eng du 2026-06-12 (risque **R1 HIGH** : l'étanchéité RLS dépend
> entièrement d'un rôle non-propriétaire qui vit hors du code versionné).

## Contexte & risque

Tout le modèle d'isolation multi-tenant ne mord QUE pour un rôle **non-propriétaire**
des tables (la RLS est ignorée pour l'owner, même avec `FORCE` — non, `FORCE`
l'applique à l'owner aussi, MAIS `BYPASSRLS` ou un rôle superuser la contourne ;
et surtout l'app doit se connecter SOUS `tygr_app`, pas sous l'owner Neon).

**Le trou (vérifié 2026-06-12) :** aucune migration ne crée `tygr_app` ni ses
GRANT. Le rôle est provisionné **à la main en trois endroits désynchronisés** :
- **Local** : `CREATE ROLE` + `GRANT` tapés au shell pendant la validation.
- **Neon (prod/preview)** : idem, manuel, non tracé.
- **Tests** : la suite IDOR (`workspace-isolation.test.ts`) et les tests repository
  recréent `tygr_app` dans leur `beforeAll` PGlite — une 4e définition, divergente.

**Scénario de défaillance (R1) :** un jour `DATABASE_URL` pointe vers le rôle owner
Neon (erreur de config, commodité). La RLS tombe silencieusement, l'isolation
inter-tenant disparaît, **et aucun test ne le détecte** — les tests tournent sous
`tygr_app` par construction, jamais sous l'owner. Faille invisible, sévérité HIGH.

## État actuel vérifié (2026-06-12, refacto mergé attendu)

- Migrations : `0000_workspace-foundation`, `0001_rls-force`, `0002_login-attempts`.
  Aucune ne touche aux rôles. `drizzle.config.ts` applique avec `DATABASE_URL_ADMIN`
  (owner) — c'est le bon rôle pour gérer les privilèges.
- `0001_rls-force.sql` : `ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY`.
- CI : la suite IDOR tourne sur PGlite (`npm test`), sans base externe. Le
  provisioning Neon n'est jamais exercé en CI.
- `withWorkspace` (`server/db/tenancy.ts`) ne vérifie PAS `current_user` au runtime
  — il SUPPOSE que la connexion est déjà sous `tygr_app`.

## Décisions à arbitrer dans ce spec (proposées, à valider)

| # | Sujet | Proposition |
|---|---|---|
| C1 | Où vit le provisioning | **Script SQL idempotent versionné** `drizzle/provisioning/tygr_app.sql`, appliqué avec `DATABASE_URL_ADMIN` AVANT `migrate`, via une commande `npm run db:provision`. PAS une migration Drizzle numérotée (les rôles sont des objets cluster/instance, pas du schéma applicatif — les mélanger casse le rejeu expand-contract). |
| C2 | Idempotence | `DO $$ … IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='tygr_app') …` pour le rôle ; `GRANT` ré-émis (idempotent par nature) ; `ALTER DEFAULT PRIVILEGES` posé AVANT toute table (cf. R2 ci-dessous). |
| C3 | Le piège `ALTER DEFAULT PRIVILEGES` (R2 de la revue) | Le script DOIT (a) poser les default privileges ET (b) ré-émettre un `GRANT … ON ALL TABLES IN SCHEMA public` explicite — sinon les 3 tables déjà créées par les migrations 0000/0002 n'héritent pas du GRANT et `tygr_app` perd l'accès en lecture. Les deux, ceinture-bretelles. |
| C4 | Secret du mot de passe `tygr_app` | Le script ne fixe PAS de mot de passe en dur. Il fait `CREATE ROLE tygr_app LOGIN` ; le mot de passe est posé hors script (Neon UI / `ALTER ROLE … PASSWORD` depuis un secret d'env `TYGR_APP_PASSWORD`), jamais commité. Local : mot de passe trivial documenté dans CLAUDE.md (déjà le cas). |
| C5 | Le test négatif inversé (le cœur de la preuve) | Nouveau test : prouver qu'**en se connectant SOUS l'owner**, la RLS ne protège PAS (lignes cross-tenant visibles). Rend explicite POURQUOI le rôle est vital et fait **échouer la CI** si quelqu'un déprovisionne ou pointe sur l'owner. C'est la conversion de R1 d'angle mort invisible en invariant testé. |
| C6 | Garde-fou runtime (défense en profondeur, R3) | Optionnel, à trancher : une assertion au premier appel de `withWorkspace` refusant de servir si `current_user` = owner (fail-closed). Coût : 1 requête au démarrage. Recommandé mais séparable en lot ultérieur si on veut garder ce PR minimal. |

## Plan de migration (séquencement expand-contract, règle 9)

Ordre NON négociable (le provisioning est un **prérequis de pipeline**) :

```
db:provision (DATABASE_URL_ADMIN, idempotent)  →  migrate  →  deploy
```

Jamais `migrate` avant `provision` sur une base neuve, sinon les tables existent
avant le GRANT (R2). Sur une base déjà migrée (cas actuel Neon/local), `provision`
rattrape via le `GRANT … ON ALL TABLES` explicite (C3).

## Critères d'acceptation

1. `drizzle/provisioning/tygr_app.sql` idempotent : 2 exécutions consécutives sans
   erreur, état identique (rôle présent, GRANTs posés, default privileges actifs).
2. `npm run db:provision` documenté et exécutable contre une base locale ET Neon.
3. **Test négatif inversé (C5)** dans la suite isolation : connexion owner → la RLS
   ne filtre PAS (assertion que des lignes cross-tenant SONT visibles), connexion
   `tygr_app` → filtre (déjà couvert). Le test échoue si le rôle de test n'est pas
   correctement dégradé — preuve que la CI attrape le scénario R1.
4. La suite IDOR existante (8 + cas 9) reste verte ; son `beforeAll` est refactoré
   pour **consommer le script de provisioning** au lieu de redéfinir le rôle à la
   main (source unique de vérité — supprime la 4e définition divergente).
5. CLAUDE.md : section « Provisioning & rôles DB » documentant l'ordre
   provision→migrate→deploy et la rotation du mot de passe `tygr_app`.
6. `db:provision` branché dans le pipeline CI canonique (avant migrate) — coordonné
   avec l'étape build/deploy encore à brancher (dépend du choix d'hébergeur).

## Plan de test

| Couche | Quoi | Nb |
|---|---|---|
| Provisioning | Script appliqué 2× = idempotent (rôle, grants, default priv) | +1 |
| Isolation (C5) | Owner → RLS ne mord pas (lignes cross-tenant visibles) ; tygr_app → mord | +2 |
| Isolation (refactor) | Les 8 cas + cas 9 existants, beforeAll consommant le script | inchangé |
| Garde-fou runtime (si C6 retenu) | withWorkspace sous owner → refus fail-closed | +1 |

## Hors scope

- Le choix d'hébergeur et l'étape deploy/preview de la CI (dépendance ouverte,
  TODOS) — ce spec prépare le terrain (`db:provision` prêt à brancher) sans le
  trancher.
- Rotation automatisée du secret `tygr_app` (runbook manuel au MVP).
- C6 (garde-fou runtime) séparable si on veut un PR minimal — à décider à l'approbation.

## Rollback

Le script de provisioning est idempotent et additif (CREATE IF NOT EXISTS, GRANT) —
pas de DROP. Rollback = ne pas l'appliquer ; aucune donnée touchée. Le test négatif
et le refactor du beforeAll sont du code testé, revert standard.

## Estimation

Script + idempotence : ~30 min · test négatif inversé + refactor beforeAll : ~45 min
· doc CLAUDE.md + câblage npm script : ~15 min · (C6 si retenu : +30 min).
**Total ~1 h 30 CC** (+30 min avec garde-fou runtime).

## Fichiers touchés (prévision)

Créés : `drizzle/provisioning/tygr_app.sql`, test négatif (dans la suite isolation
ou un fichier dédié). Modifiés : `package.json` (script `db:provision`),
`tests/isolation/workspace-isolation.test.ts` (beforeAll → consomme le script),
`CLAUDE.md` (section rôles/provisioning), `.github/workflows/ci.yml` (étape
provision, coordonnée au déploiement). Éventuel : `server/db/tenancy.ts` (garde-fou
C6, si retenu).
