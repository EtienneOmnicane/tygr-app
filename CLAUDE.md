@AGENTS.md

# TYGR

Plateforme de gestion de trésorerie multi-tenant (Workspaces) construite sur l'API
Open Banking Omni-FI. Trois missions : narratif réglementaire BOM Innov8 (consent
flow + audit trail), sales enablement de l'API, outil de trésorerie production pour
les Financial Managers des BU du groupe (architecture SaaS-ready).

- Spec produit : `docs/cahier_des_charges.md` (v2.1 multi-tenant)
- API amont : `docs/documentation_api.md`
- Design system : `docs/UI_GUIDELINES.md` (source de vérité UI)
- Plan approuvé + registres de revue : `~/.gstack/projects/tygr-app/clawdy-unknown-design-20260610-120713.md`
- Reports : `TODOS.md`

Stack : Next.js App Router, Tailwind CSS, shadcn/ui, Tremor, Neon PostgreSQL (RLS
forcée par workspace_id), Drizzle, Inngest, Auth.js (JWT). Interface en français.

## Localisation & temps (Île Maurice)

Règle stricte, non négociable :
- **Le système opère à l'Île Maurice (MUT, UTC+4).** Aucun changement d'heure d'été.
- **Tous les timestamps en base sont `TIMESTAMPTZ` stockés en UTC.** Jamais de
  `timestamp` sans fuseau, jamais d'heure locale persistée.
- **La conversion `Asia/Port_Louis` est EXPLICITE dans le code** pour tout calcul de
  clôture (date comptable d'une transaction, bornes de période, agrégats EOD, courbe
  90j). Une transaction à 22h UTC tombe le lendemain à Maurice : `transaction_date`
  dérive de `BookingDateTime AT TIME ZONE 'Asia/Port_Louis'` (E20). Interdit de
  comparer des dates « nues » sans avoir posé le fuseau.
- **Multi-devise first (MUR, USD, EUR).** Le modèle ne suppose jamais le mono-MUR :
  toute table portant un montant porte sa devise ; les corporates mauriciens tiennent
  couramment des comptes USD/EUR. Conversion vers la `base_currency` du workspace
  **annotée** (taux + date du taux). Combiné à la règle 8 : montants en DECIMAL/
  centimes, jamais en float, y compris après conversion FX.

## Provisioning & rôles DB (dette P0-b résolue, 2026-06-12)

L'isolation RLS ne mord QUE sous un rôle non-propriétaire des tables. Garanties :

- **Source unique du rôle** : `drizzle/provisioning/tygr_app.sql` (idempotent,
  sans mot de passe en dur). Appliqué par `npm run db:provision`
  (`DATABASE_URL_ADMIN`, rôle owner). La suite d'isolation consomme CE script
  dans son `beforeAll` — aucune définition divergente du rôle.
- **Ordre de pipeline NON négociable** : `db:provision` → `migrate` → `deploy`.
  Le `GRANT … ON ALL TABLES` explicite du script rattrape les tables déjà
  migrées (les `ALTER DEFAULT PRIVILEGES` ne couvrent que les tables futures).
- **Secret (C4)** : le script crée `tygr_app` NOLOGIN sans mot de passe ; le
  LOGIN + mot de passe est posé hors script (`ALTER ROLE … PASSWORD` depuis un
  secret d'env, jamais commité) — rotation en runbook au déploiement.
- **Garde-fou runtime (C6, fail-closed)** : `withWorkspace` refuse de servir
  (`UnsafeDatabaseRoleError`, mappé 500) si la connexion tourne sous le
  propriétaire des tables — la RLS serait contournée. Couvert par la contre-
  preuve R1 (test C5) : sous l'owner, la RLS ne filtre pas ET le garde-fou
  bloque ; un déprovisionnement ou un `DATABASE_URL` pointant l'owner fait
  échouer la CI.

## Tribal Knowledge & Quality Gates

Règles non négociables pour tout agent (humain ou IA). Une règle violée = la tâche
n'est PAS terminée, quel que soit l'état du code. En cas de conflit entre vitesse et
ces règles, les règles gagnent ; en cas de doute sur une exception, demander.

### 1. Séparation stricte des phases
- Une requête = une phase : **conception** (plan/spec écrit sur disque), **implémentation**
  (référence un plan existant), ou **revue** (contexte frais). Jamais deux dans le même fil.
- Aucune ligne de code applicatif tant que le plan de la fonctionnalité n'existe pas
  en fichier. L'auteur ne s'auto-déclare jamais "revu" : la revue passe par /review,
  /code-review ou un subagent indépendant.
- Exception (liste fermée) : correctif ≤20 lignes, sans changement de schéma, d'API
  ou de surface de sécurité → implémentation directe autorisée, revue requise avant push.

### 2. Architecture de données — tenancy (anti-IDOR)
- TOUT accès aux données passe par `withWorkspace(session, fn)` (`src/lib/tenancy.ts`) :
  BEGIN → `SET LOCAL app.current_workspace_id` → re-validation de la membership à
  CHAQUE requête → repositories scopés. Pas d'accès au client DB hors `src/lib/` et
  `src/repositories/` (règle lint à installer au scaffold).
- Interdits absolus : requête ad-hoc dans une route/composant, `BYPASSRLS`,
  désactivation de RLS, usage de `tygr_service` hors résolution webhook documentée.
- Exceptions (liste fermée) : migrations (`DATABASE_URL_ADMIN`), résolution
  `connection → workspace_id` dans `/api/webhooks/omnifi` (rôle `tygr_service`,
  SELECT 3 colonnes uniquement).
- Preuve : la suite d'isolation IDOR (accès cross-workspace → 404 ; requête sans
  WHERE → 0 ligne) est BLOQUANTE en CI. Tout nouvel endpoint y ajoute ses cas.

### 3. Exit criteria par nouvelle route / Server Action
Livrés dans le MÊME PR, sinon le PR est incomplet :
- [ ] Authz via `withWorkspace` ; ressource d'un autre tenant → **404, jamais 403**
      (pas d'oracle d'existence).
- [ ] Validation d'entrée : schéma zod strict (types, bornes, longueurs max) ;
      rejet bruyant avec code d'erreur nommé.
- [ ] Audit sécurité ciblé (OWASP ASVS) : injection (paramètres liés uniquement),
      IDOR (cas ajouté à la suite isolation), messages non-énumérants,
      rate-limit si surface non authentifiée, CSRF/headers selon le type de route.
- [ ] Chaque erreur a un nom : code machine → message UI mappé (registre S2 du
      plan). Catch-all silencieux interdit.
- [ ] Tests : chemin heureux + chemin d'échec spécifique + cas limite
      (nil/vide/concurrence).
- [ ] Logs structurés corrélés (`workspace_id`, `connection_id` si pertinent).

### 4. Visual QA (vision contre la source de vérité)
- Tout PR touchant l'UI : captures localhost (navigateur headless gstack) de chaque
  état modifié — loading/vide/erreur/succès/partiel — comparées PAR VISION à
  `docs/UI_GUIDELINES.md` (checklist §6) avant la revue.
- Écart sur les tokens objectifs (couleurs sémantiques entrées/sorties, fond
  prévisionnel, `tabular-nums`, densités, focus visibles) = BLOQUANT.
  Écart subjectif (goût) = noté et renvoyé à /design-review, pas bloquant.

### 5. Stop-loss au commit
- Aucun commit si `lint`, `tsc --noEmit` ou le build échouent. Aucun test rouge
  commité : on corrige, ou on isole avec entrée TODOS.md datée — jamais de
  `.skip` silencieux.
- Enforcement : hooks `.claude/settings.json` (PreToolUse sur `git commit`, exécuté
  par le harness) + `.husky/pre-commit` (couvre les commits hors agent). Les deux
  exécutent `npm run lint && npm run typecheck`.

### 6. Revue contradictoire (cross-review)
- Toute revue de fond est faite par un contexte FRAIS (subagent ou Codex) qui n'a
  pas vu le raisonnement de l'auteur — l'indépendance est le mécanisme du challenge.
- Le réviseur a mandat de chercher des modes de défaillance (IDOR, concurrence,
  curseurs, hypothèses API non vérifiées) ; tout constat cite `fichier:ligne` + un
  mode de défaillance concret + une confiance /10. **Fabriquer un désaccord est
  interdit** : un faux constat pollue l'audit trail et apprend à ignorer les revues.
  "Aucun constat" exige la liste explicite de ce qui a été examiné.
- Désaccord auteur/réviseur non résolu → remonté à l'humain avec les deux positions.
  Jamais tranché silencieusement, jamais lissé.

### 7. Autonomie longue durée
- Tâche estimée >1h : plan écrit + critères de sortie mesurables AVANT de commencer.
  Checkpoints : WIP commit par unité logique (jamais `git add -A`), résumé
  [PROGRESS] périodique, /context-save avant tout changement de focus.
- Stop conditions (obligatoires) : 3 tentatives échouées sur le même problème →
  STOP + synthèse tenté/écarté/recommandation. Découverte qui change le périmètre
  (schéma, sécurité, comportement API amont) → STOP + question. Expansion de scope
  silencieuse interdite : tout différé devient une entrée TODOS.md.

### 8. Données financières (spécifique TYGR)
- Montants : **jamais de float**. DECIMAL en base ; côté TS, chaînes décimales ou
  centimes entiers ; règles d'arrondi documentées ; tests aux bornes. Affichage :
  Geist `tabular-nums` (UI_GUIDELINES §0).
- `audit_events` et `consent_records` sont **append-only** : aucun UPDATE/DELETE,
  même en migration de réparation — on écrit un événement correctif.
- Aucune donnée bancaire réelle hors production : fixtures = sandbox Omni-FI
  uniquement ; pas de dump de prod en local ; logs sans PII (jamais de libellés
  bancaires bruts dans les messages d'erreur ou la télémétrie).
- Secrets : env vars uniquement, jamais en fixture ni en commit ; secrets webhook
  distincts sandbox/production ; rotation documentée en runbook.
- Driver DB : connexion via Pool/WebSocket ou TCP en mode transaction UNIQUEMENT
  (`SET LOCAL` exige des transactions multi-statements) — le mode HTTP de
  `@neondatabase/serverless` est interdit pour les requêtes applicatives (E16).

### 9. CI/CD & dette technique
- Pipeline canonique (à créer, ordre non négociable) : lint → typecheck
  → tests unitaires → **suite isolation IDOR (bloquante)** → build → migrations
  expand-contract → deploy preview. En production : **migrate PUIS deploy**, jamais
  l'inverse ; toute migration est backward-compatible avec le code N-1.
- Toute dette acceptée = entrée TODOS.md (quoi/pourquoi/priorité/contexte). Un
  `// TODO` en commentaire sans entrée TODOS.md correspondante est un défaut de
  revue (règle 6 doit l'attraper).
- Nouvelle dépendance : justification une ligne (Layer 1 éprouvé / Layer 2 à
  scruter / Layer 3 premiers principes), lockfile committé, audit de vulnérabilités
  au moment de l'ajout.
- **Gestion de la dette (audit EM 2026-06-12)** — règles de classement et de vie :
  - Classification **P0/P1/P2 avec SLA** : P0 = réglé avant la prochaine feature ;
    P1 = avant le premier déploiement de production ; P2 = raccroché obligatoirement
    à un chantier nommé (jamais « un jour »).
  - Toute entrée TODOS.md porte **date, effort estimé et déclencheur de résolution**
    (l'événement qui la rend due), pas seulement une priorité.
  - Dette touchant **l'isolation tenant, les tables append-only ou les montants :
    INTERDITE** — ça se corrige immédiatement, ça ne se consigne pas.
  - **Revue de dette à chaque fin d'epic** ; un P2 vieux de 2 epics est re-priorisé
    ou tué explicitement (décision tracée), jamais laissé pourrir.
  - Dépendance beta/RC : **pin exact dans package.json** (pas de caret) +
    re-validation du parcours critique concerné à chaque bump.

### 10. Pushback systématique (Devil's Advocate)
- L'agent n'est pas un exécutant : c'est un Staff Engineer. Avant d'exécuter toute
  instruction complexe (architecture, modèle de données, logique métier, surface de
  sécurité), il DOIT analyser la demande. S'il identifie un angle mort de sécurité,
  une dette technique future, ou une approche plus simple/scalable : **STOP avant la
  première ligne de code** — exposer le risque, chiffrer le coût des deux options,
  proposer l'alternative. L'humain tranche.
- Forme exigée : risque concret (mode de défaillance, pas une opinion) + alternative
  + coût comparé (humain / CC). Un pushback sans alternative est une plainte ; un
  pushback fabriqué viole la règle 6. Si la demande est saine, le dire en une ligne
  et exécuter — pas de théâtre d'objections.
- Ne s'applique pas : aux tâches triviales (exception règle 1), ni aux décisions déjà
  tranchées et consignées (decision log / plan approuvé) — celles-là se rouvrent en
  citant la décision et le fait nouveau qui la remet en cause, pas en la re-litigant.
- Une fois l'arbitrage rendu, exécution totale : le pushback vit AVANT la décision,
  jamais pendant l'implémentation (pas de scope creep déguisé en prudence).

## Omni-FI — authentification multi-schéma & flux Link Widget (2026-06-15)

Source de vérité : `docs/documentation_api.md` (sections Authentification, Link
Widget, Sync Engine), aligné sur la doc Fern en ligne. Tribal knowledge pour tout
agent touchant le client Omni-FI :

- **Quatre schémas d'auth, choisis PAR endpoint** (le client ne peut pas se figer
  sur un seul — l'`ApiKey` codé en dur de la PR 1 est à généraliser) :
  - `ApiKey <client_id>:<secret>` — appels SERVEUR : `link-token`, `link-exchange`,
    et les endpoints B2B de lecture/sync (avec `clientUserId` en query).
  - `LinkToken` (identité dérivée du token) — `widget/session/exchange` uniquement.
  - `Bearer <SessionToken>` — tous les appels WIDGET après l'échange : `link-connect`,
    `sync/job/{id}` (polling), `sync/{id}/input`, `sync/{id}/resend`,
    `sync/job/{id}/accounts`, `link-token/context`, `widget/session/revoke`.
- **`ClientUserId` = `workspaces.omnifi_client_user_id`** : c'est NOTRE id interne
  d'EndUser, fourni à `link-token` et re-transmis à `link-exchange` — c'est la
  frontière tenant (le mismatch lève `403 PUBLIC_TOKEN_CLIENT_MISMATCH`). Jamais
  inventé par Omni-FI.
- **Secrets en transit** : `SECRET` (ApiKey) et `SessionToken` (Bearer) ne sont
  JAMAIS loggés ni mis dans un message d'erreur / une `cause` brute (règle 8 ;
  réutiliser le `resumeCauseSure` de la PR 1). Les identifiants bancaires de l'EndUser
  (email/password de la banque) transitent par `link-connect` et ne sont JAMAIS
  stockés ni journalisés côté TYGR (PII bancaire).
- **Machine à états MFA** (polling de `sync/job/{id}`) : `OTP_REQUESTED`↔`OTP_WAITING` ;
  mauvais code → `UserInput` repasse `null`, `Status` reste `OTP_REQUESTED` (détecter
  la transition non-null→null) ; **3 échecs → `FAILED`/`LOGIN_FAILED`**. Watermark
  `MfaResendRequestedAt` ré-émis VERBATIM à chaque submit après un resend, sinon
  `409 STALE_INPUT`. Resend : cooldown `MfaResendCooldownSeconds`, max 3.
- **Rate-limits** : `widget/session/exchange` 10/IP/60s ; `sync` 1/15min/connexion.
- **Découverte de comptes** : `GET /sync/job/{id}/accounts` (Bearer) — résout
  l'ancienne dette « connexion → bank_accounts ».

## Convention des états d'affichage (Loading / Empty / Error / Partiel)

Deux mécanismes coexistent, à choisir selon l'origine de l'attente (checklist
UI_GUIDELINES §6.5 — tout écran de données spécifie ses 4 états) :

- **`loading.tsx` natif (App Router)** — quand l'attente est le RSC lui-même
  (Suspense automatique de Next pendant qu'un Server Component résout ses
  données). Skeleton inline, monté par le routeur. Ex. `(workspace)/selection/
  loading.tsx`. C'est le défaut pour un segment de route qui fetch côté serveur.

- **Composants `<…State/>` présentationnels** (`src/components/<domaine>/states/`)
  — quand l'état est piloté par le CLIENT (données déjà chargées mais vides,
  échec de synchro à re-tenter, polling). Composants « stupides » : aucun fetch,
  aucun état interne, handlers (`onRetry`/`onConnect`) en props optionnelles et
  inertes par défaut. Le conteneur (page/feature) décide quel état monter. Ex.
  `components/dashboard/states/` : `DashboardLoadingState`, `DashboardEmptyState`,
  `DashboardErrorState`, exportés par un `index.ts` barrel.

Règles communes (non négociables) :
- **Tokens UI_GUIDELINES uniquement**, jamais de couleur en dur. Briques
  partagées dans `states/primitives.tsx` (`SkeletonBlock`, `StateCard`,
  `StateIllustration`) — pas de duplication du markup de carte.
- **Erreur ≠ sortie (§3.4)** : un état d'erreur porte TOUJOURS fond `danger-bg`
  + icône + message, jamais un simple rouge (qui est réservé aux montants
  `outflow`). `role="alert"`.
- **Loading neutre** : le skeleton n'emploie aucune couleur sémantique
  (`inflow`/`outflow`) — le chargement n'est pas de la donnée. Il épouse la
  FORME réelle de l'écran (mêmes cartes, mêmes colonnes) pour éviter le saut de
  layout ; montants placeholders en `tabular-nums`.
- **Empty (§4.4)** : illustration outline légère + message `text-muted` + UN seul
  CTA. Jamais un « No data » sec.
- **Zéro dépendance externe** (règle 9) : `cn` local + SVG inline tant que
  clsx/cva/lucide ne sont pas au projet.
- **Visual QA (Gate 4)** : une route de démo `src/app/demo/<domaine>-states/`
  expose les états hors auth/DB pour capture headless. Hors production.

## Human-in-the-Loop (workflow Git & déploiement)

Discipline de livraison — l'agent ne franchit jamais ces frontières seul :

- **Règle 1 — Pas de commit direct sur `main`.** Toute modification vit sur une
  branche `feature/*` (ou `fix/*`, `chore/*`). `main` est protégée ; on y arrive
  uniquement par merge de PR validée.
- **Règle 2 — L'agent s'arrête à la PR.** L'agent committe sur la branche `feature/*`,
  pousse si demandé, puis **STOP** : c'est l'humain qui ouvre la Pull Request, ce qui
  déclenche la CI (`.github/workflows/ci.yml`). L'agent n'ouvre pas la PR à la place
  de l'humain.
- **Règle 3 — Validation humaine obligatoire avant merge.** Deux contrôles que la CI
  ne couvre pas et que l'humain DOIT faire : (a) **Visual QA** des écrans modifiés
  contre `docs/UI_GUIDELINES.md` (Quality Gate 4), (b) **vérification devises &
  fuseaux** — un montant converti affiche le bon taux/date, une clôture tombe le bon
  jour à Maurice (section Localisation). La CI valide le code ; l'humain valide le sens.
- **Règle 4 — L'humain merge.** Le merge de la PR est l'acte humain qui déclenche le
  déploiement. L'agent ne merge jamais, ne force jamais le push sur `main`.

Ces quatre règles complètent le stop-loss (Quality Gate 5) : le stop-loss garde le
commit, le Human-in-the-Loop garde la PR et le déploiement.

## Dev local — stack de validation (2026-06-12)

Le driver applicatif est Neon Serverless (WebSocket, E16) : un Postgres local nu ne
suffit pas. Stack de validation reproductible (conteneurs dédiés, réseau isolé
`tygr_validation`, AUCUN lien avec d'autres stacks Docker de la machine) :

```bash
docker network create tygr_validation
docker run -d --name tygr_postgres --network tygr_validation \
  -e POSTGRES_USER=tygr_owner -e POSTGRES_PASSWORD=… -e POSTGRES_DB=tygr postgres:16-alpine
docker run -d --name tygr_wsproxy --network tygr_validation -p 127.0.0.1:5433:80 \
  -e ALLOW_ADDR_REGEX='^tygr_postgres:5432$' ghcr.io/neondatabase/wsproxy:latest
# migrations : psql dans le conteneur (sed 's/--> statement-breakpoint//g' …)
# rôle applicatif : CREATE ROLE tygr_app LOGIN + GRANT (hors migrations à ce jour — voir TODOS)
```

`.env` local : `NEON_WSPROXY_LOCAL="localhost:5433"` (active le câblage wsproxy
dev-only de `src/db/index.ts` et `scripts/seed-admin.mjs` — variable INTERDITE en
production), `DATABASE_URL` avec l'hôte `tygr_postgres` (vu par le wsproxy).
Le wsproxy reste restreint (`ALLOW_ADDR_REGEX` exact, bind 127.0.0.1) — jamais de
proxy ouvert. Démontage : `docker rm -f tygr_postgres tygr_wsproxy && docker
network rm tygr_validation`.

Toute dette relevée en validation est consignée dans `TODOS.md` (règle 9 — le
registre canonique de la dette est TODOS.md, ce fichier n'en garde que le renvoi).

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
