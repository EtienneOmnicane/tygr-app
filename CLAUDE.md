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
