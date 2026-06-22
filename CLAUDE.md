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
- **La conversion `Indian/Mauritius` est EXPLICITE dans le code** pour tout calcul de
  clôture (date comptable d'une transaction, bornes de période, agrégats EOD, courbe
  90j). Une transaction à 22h UTC tombe le lendemain à Maurice : `transaction_date`
  dérive de `BookingDateTime AT TIME ZONE 'Indian/Mauritius'` (E20). Interdit de
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
  Le `GRANT … ON ALL TABLES` (SELECT/INSERT/UPDATE — **PAS DELETE**, cf. section
  suivante) rattrape les tables déjà migrées (les `ALTER DEFAULT PRIVILEGES` ne
  couvrent que les tables futures). Sur base **neuve**, les GRANT DELETE sélectifs
  (liste blanche, conditionnels à l'existence des tables) ne mordent qu'au
  **re-provision post-migrate** : le runbook rejoue `db:provision` après `migrate`.
- **Secret (C4)** : le script crée `tygr_app` NOLOGIN sans mot de passe ; le
  LOGIN + mot de passe est posé hors script (`ALTER ROLE … PASSWORD` depuis un
  secret d'env, jamais commité) — rotation en runbook au déploiement.
- **Garde-fou runtime (C6, fail-closed)** : `withWorkspace` refuse de servir
  (`UnsafeDatabaseRoleError`, mappé 500) si la connexion tourne sous le
  propriétaire des tables — la RLS serait contournée. Couvert par la contre-
  preuve R1 (test C5) : sous l'owner, la RLS ne filtre pas ET le garde-fou
  bloque ; un déprovisionnement ou un `DATABASE_URL` pointant l'owner fait
  échouer la CI.

## Intégrité append-only des tables financières (#3bis, 2026-06-17)

`transactions_cache` (+ partitions) et `balance_history` sont **append-only** :
l'effacement est **logique** (`is_removed=true` via UPDATE) ou l'historique EOD
est immuable. JAMAIS de DELETE physique. Deux gardes **complémentaires**, parce
qu'aucune ne suffit seule (leçon de cross-review — la 1re a été contournée par
la 2nde voie) :

- **(1) Privilège : liste blanche DELETE « deny-by-default »** (`tygr_app.sql`).
  Le GRANT global ne donne que SELECT/INSERT/UPDATE (idem `ALTER DEFAULT
  PRIVILEGES`, donc toute table FUTURE — partition de roulement comprise — naît
  sans DELETE). DELETE est ensuite octroyé **table par table** (bloc
  `DO`/`to_regclass` conditionnel) aux SEULES tables normales (`workspaces`,
  `users`, `login_attempts`, `workspace_members`, `bank_connections`,
  `bank_accounts`). **Ne JAMAIS** ajouter une table append-only à cette liste, ni
  un `GRANT … DELETE ON ALL TABLES` (il engloberait l'append-only + ses
  partitions ; un REVOKE de rattrapage ne se propage PAS aux partitions).

- **(2) Intégrité : trigger `BEFORE DELETE`** (migration `0004`, fonction
  `tygr_refuser_delete_append_only`, lève `append_only_no_delete` / ERRCODE
  `check_violation`, message sans PII). Indispensable EN PLUS du privilège : une
  **cascade FK `ON DELETE cascade`** (depuis `bank_accounts`/`bank_connections`,
  qui ONT légitimement DELETE) supprime les lignes enfant **sans re-vérifier
  leur privilège** → sans ce trigger, déconnecter une banque effacerait
  physiquement l'historique. Le trigger est la seule défense **indépendante du
  privilège ET du chemin** (DELETE direct, partition en direct, cascade, code
  futur, même sous l'owner).

- **Partitions — héritage (à ne PAS confondre avec la RLS)** : un trigger
  row-level posé sur la table MÈRE partitionnée est **hérité** par toutes les
  partitions, présentes ET futures (PostgreSQL ≥ 11). La **RLS, elle, n'est PAS
  héritée** (`ENABLE`/`FORCE`/`CREATE POLICY` posés par partition dans `0003`).
  Donc au **roulement annuel** des partitions : RÉPÉTER la RLS (sinon fuite
  cross-tenant), mais PAS le trigger (déjà hérité). Inverser cette règle = bug.

- **Preuve (bloquante en CI)** : `tests/isolation/tombstone-delete-isolation.test.ts`
  — DELETE direct/partition/cascade refusé sous `tygr_app` ET sous l'owner,
  partition future héritant le trigger, UPDATE `is_removed` toujours autorisé,
  contre-preuve DELETE autorisé sur une table normale, idempotence du script.

Corollaire de gouvernance : ces deux invariants relèvent de l'isolation tenant /
append-only → **dette INTERDITE** (règle 9). Toute nouvelle table financière
append-only DOIT poser son trigger `BEFORE DELETE` et rester hors liste blanche.

## Entités multi-tenant (Option B — entités sous le Workspace, 2026-06-22)

> Plan de référence validé : `PLAN-entites-multi-tenant.md` (§5). Cette section
> décrit l'invariant cible ; l'implémentation suit (lots L1→L5 du plan).

Le Workspace = un GROUPE (« Omnicane »), pas une entité. Les ENTITÉS (BU) sont un
niveau SOUS le workspace (`entities` + `bank_accounts.entity_id`), JAMAIS une frontière
de tenant. Raison métier non négociable : **1 credential bancaire = comptes de N
entités** (une connexion remonte d'un coup les comptes de plusieurs BU). L'Option A
(entité = workspace isolé) polluerait un workspace avec les comptes d'autres entités à
l'ingestion.

DEUX étages d'isolation, à ne JAMAIS confondre ni inverser :
- **Étage 1 — TENANT (dur)** : RLS `workspace_id` (POLITIQUE_TENANT). Anti-IDOR
  cross-client. INCHANGÉ par le multi-entités. Fuite ici = cross-client (critique).
- **Étage 2 — ENTITÉ (scopé)** : policy RLS `entity_scope` **AS RESTRICTIVE FOR ALL**
  (USING + WITH CHECK, migration 0009 ; était FOR SELECT en 0008) sur `bank_accounts` via
  le GUC `app.current_entity_scope` (posé par `withWorkspace` depuis `member_entity_scopes`,
  JAMAIS un paramètre client). RESTRICTIVE ⇒ se combine en **AND** avec `tenant_isolation`
  (PERMISSIVE) — une PERMISSIVE s'OR'erait et ne filtrerait rien. « Vision Entité » = GUC =
  CSV d'entités ; « Vision Globale » = GUC vide = tout le tenant. La policy borne lecture
  ET écriture : USING (SELECT/UPDATE/DELETE) interdit de cibler un compte hors scope ;
  WITH CHECK (INSERT/UPDATE) interdit d'INSÉRER ou de DÉPLACER un compte hors scope.
  Transactions/soldes héritent du scope par JOINTURE sur bank_accounts (pas de duplication
  d'entity_id sur l'append-only) — d'où la règle « jamais de lecture des tables filles sans
  joindre bank_accounts » (ENTITY-READ-JOIN1). Fuite ici = intra-groupe (grave, pas
  cross-client) — mais traitée comme un gate bloquant.

Invariants :
- `entity_id` vit UNIQUEMENT sur `bank_accounts` (NULLABLE = « non assigné »). Ne JAMAIS
  dénormaliser entity_id dans transactions_cache/balance_history (append-only/partitionné
  + réassignation ne doit pas réécrire l'historique).
- FK composites scopées workspace OBLIGATOIRES (pattern `categories`) :
  `bank_accounts(entity_id, workspace_id) → entities(id, workspace_id)` et
  `member_entity_scopes(entity_id, workspace_id) → entities`. Cible : `entities
  UNIQUE(id, workspace_id)`. ON DELETE RESTRICT vers les entités (jamais cascade) ;
  l'app archive (is_active=false). Cascade légitime uniquement
  `member_entity_scopes(user_id, ws) → workspace_members` (purge des droits).
- Un compte `entity_id IS NULL` est INVISIBLE en Vision Entité (fail-closed) ; seul
  l'ADMIN (Vision Globale) le voit, dans le sas. L'ingestion ne pose jamais entity_id
  automatiquement ; l'upsert de re-sync ne réécrase JAMAIS un entity_id déjà assigné.
- Vision Entité / Globale : `member_entity_scopes` (N:N user↔entity). AUCUNE ligne =
  Vision Globale. Le scope se résout depuis le CONTEXTE, jamais d'un paramètre client.
- Pas de nouveau rôle au MVP : Vision Entité = membre scopé (pas un rôle). Gestion
  entités/scopes/assignation = ADMIN-only. ⚠️ Deux gardes COMPLÉMENTAIRES, à ne pas
  confondre : (1) la policy `entity_scope` FOR ALL borne l'écriture au **périmètre entité**
  (structurel, fail-closed, ignore le rôle) ; (2) la garde **applicative** `ctx.role ===
  "ADMIN"` réserve l'assignation `compte → entité` à l'ADMIN. La RLS ne connaît pas le rôle :
  un membre MANAGER non scopé (Vision Globale) passe la policy mais doit être bloqué côté
  Server Action par la garde de rôle. Ne JAMAIS exposer un chemin d'assignation sans CETTE
  garde applicative en plus de la RLS.
- Écriture bornée (ENTITY-WRITE-SCOPE1) : en Vision Globale (GUC vide) tout passe — l'ingestion
  (`upsertCompte`, INSERT `entity_id` NULL) tourne en Vision Globale (gardée `peutModifier`).
  Un membre SCOPÉ ne peut créer/déplacer un compte que DANS son périmètre ; un INSERT
  `entity_id=NULL` sous Vision Entité est refusé (fail-closed voulu — un membre borné ne
  crée pas de comptes non-assignés).
- Omni-FI « Parties » volontairement IGNORÉES au MVP : assignation MANUELLE côté TYGR
  (sas). Pré-remplissage via PartyId = dette P2 (ENTITY-PARTY1), PAS une dette d'isolation.
- Provisioning : `entities` et `member_entity_scopes` dans la liste blanche DELETE de
  `tygr_app.sql` (éditables, NON append-only). Ne JAMAIS y ajouter une table append-only.
- Le filtre de périmètre vit dans la RLS (fail-closed), JAMAIS dans le .tsx : un oubli de
  WHERE entity_id ne doit pas pouvoir créer une fuite intra-groupe.

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
- `audit_events` et `consent_records` sont **append-only stricts** : aucun
  UPDATE/DELETE, même en migration de réparation — on écrit un événement
  correctif. `transactions_cache` (+ partitions) et `balance_history` sont
  **append-only au DELETE** : pas de suppression physique (garde-fou trigger +
  liste blanche, cf. « Intégrité append-only des tables financières »), mais
  l'UPDATE est permis (tombstone `is_removed`, affinage de catégorie).
- Aucune donnée bancaire réelle hors production : fixtures = sandbox Omni-FI
  uniquement ; pas de dump de prod en local ; logs sans PII (jamais de libellés
  bancaires bruts dans les messages d'erreur ou la télémétrie).
- Secrets : env vars uniquement, jamais en fixture ni en commit ; secrets webhook
  distincts sandbox/production ; rotation documentée en runbook.
- Driver DB : connexion via Pool/WebSocket ou TCP en mode transaction UNIQUEMENT
  (`SET LOCAL` exige des transactions multi-statements) — le mode HTTP de
  `@neondatabase/serverless` est interdit pour les requêtes applicatives (E16).

#### Formatage des données financières (figé 2026-06-22, audit ergonomie soldes)
- **Source UNIQUE de formatage** : `src/lib/format-montant.ts` (montants) et
  `src/lib/format-date.ts` (dates). **INTERDIT** de redéfinir un formateur local
  (noms de mois en dur, découpe ad-hoc de `YYYY-MM-DD`, groupement de milliers maison)
  dans un composant — toute date/montant d'affichage passe par ces deux modules. Dette
  C8 (3 formateurs de date parallèles) tuée par cette règle ; toute réintroduction est
  un défaut de revue (règle 6).
- **Devise = PRÉFIXE symbolique** : `Rs` (MUR), `$` (USD), `€` (EUR), séparé du montant
  par une **espace fine insécable** (U+202F). Devise inconnue → **repli** code ISO en
  suffixe. Le symbole/code ne se coupe JAMAIS du chiffre (insécable).
- **Jamais de float** (rappel règle 8) : formatage sur la **chaîne** décimale, y compris
  à l'affichage (`decomposer`/`grouperMilliers`) — `parseFloat` perd des centimes.
- **Séparateurs FR** : milliers = espace fine insécable ; décimale = virgule ; signe
  négatif = U+2212 `−` (pas le trait d'union) ; `+` explicite optionnel pour les KPI
  entrées/variation ; zéro = `Rs 0,00` (sans signe).
- **Un montant ne se `truncate` JAMAIS** : sa colonne est dimensionnée (`tabular-nums`,
  `whitespace-nowrap`, largeur calibrée au plus grand montant plausible). Seuls les
  **libellés** (nom de compte, catégorie) peuvent tronquer — jamais les chiffres clés.
- **Multi-devises** : une ligne par devise, **jamais d'addition cross-devise** ; mono →
  gros montant 28px/700 ; multi → pile égalitaire, **virgules décimales alignées**. Pas
  de conversion FX d'affichage sans taux annoté (cf. Localisation).
- **Fraîcheur du solde courant** : pastille `success` <6h / `warning` <24h / `danger`
  ≥24h (UI_GUIDELINES §3.7) sur `lastSyncedAt`. **JAMAIS** « au JJ/MM » dérivé d'un EOD
  de courbe pour un solde COURANT (anti-pattern DR-F3 : confond solde instantané et
  clôture journalière). La date du dernier point de courbe reste sur la courbe.

#### Intégration UI (Tailwind + tokens — « gstack » n'est PAS un design system)
- **Le design system = `docs/UI_GUIDELINES.md` + tokens `src/app/globals.css`** (Tailwind
  custom). **`gstack` est l'outillage CLI** (skills `/browse`, `/qa`, `/design-review`,
  navigateur headless) — il sert au **Visual QA (Gate 4)**, à la capture d'états et au
  dogfooding, **jamais au rendu**. Ne pas planifier ni coder contre des « primitives
  gstack » : elles n'existent pas. Le rendu = classes Tailwind + tokens sémantiques.
- **Aucune couleur en dur** : toujours un token sémantique (`ink`, `primary`, `accent`,
  `inflow`/`outflow`, `surface-*`, `text-*`, `danger`/`success`/`warning`). Vert/rouge
  réservés à la **donnée** ; les erreurs système portent fond + icône + message (≠ sortie).
- **Composants d'affichage purs** : zéro fetch, zéro état interne, handlers en props
  optionnelles inertes ; le conteneur (RSC/feature) décide quel état monter. Réutiliser
  les primitives existantes (`StateCard`, `states/primitives.tsx`) — pas de carte ad-hoc.
- **Responsive header** : **condenser** sous le breakpoint (menu/icône), **JAMAIS
  `flex-wrap`** sur le header (cause des sauts de ligne disgracieux).

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

### Logique widget MFA côté client (PR-W3) — consommation par l'UI

La logique métier MFA est séparée du visuel (pour l'agent UI) :
- **Machine PURE** `src/components/widget/machine-mfa.ts` : réducteur
  `transition(etat, evenement)` + sélecteurs (`peutSoumettre`, `peutResend`,
  `cooldownRestantSecondes`, `pollingActif`). Zéro React, zéro réseau — toute la
  décision MFA est ici (détection de rejet, watermark, cooldown, plafonds).
- **Hook** `useOmniFiWidget(sessionToken, jobId, deps)` : pilote la machine
  (polling périodique, submit, resend) via des Server Actions **injectables**
  (`DepsWidget`) ; expose `{ etat, erreur, enCours, soumettreOtp, demanderResend }`.
- **Server Actions runtime** `src/app/(workspace)/banques/widget-runtime.ts` :
  `pollJobAction` / `submitMfaAction` / `resendMfaAction` — pont navigateur →
  client Omni-FI serveur (le client serveur n'est jamais expédié au navigateur).

Contrat pour les composants UI (purs) :
- Brancher sur `etat.phase` (`initialisation|mfa_requis|mfa_validation|
  synchronisation|termine|echec`) pour choisir l'écran ; ne JAMAIS recoder la
  logique de rejet/cooldown — utiliser les sélecteurs.
- Désactiver le bouton submit si `!peutSoumettre(etat)`, le bouton resend si
  `!peutResend(etat, Date.now())` ; afficher `cooldownRestantSecondes`.
- `etat.mfa` porte canal/longueur/destinations masquées pour le libellé OTP.
- Ne jamais logger l'OTP saisi ni le SessionToken (règle 8). Le hook ne les
  expose pas dans `etat`.
- Tests : la machine pure est couverte (rejet/watermark/cooldown/échecs) ; le
  hook (coquille timers/refs) est validé au Visual QA (pas de renderer React de
  test au projet — choix tracé TODOS, règle 9).

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

## Politique de branches (actée 2026-06-18)

- **`main`** = Production stable (protégée, source de vérité).
- **`staging`** = Pré-production / recette : environnement d'intégration continue où l'on fusionne et teste les grosses fonctionnalités (ex. intégration Omni-FI) **avant** de promouvoir vers `main`.
- **Les nouvelles fonctionnalités partent de `main`** : on crée chaque branche de feature/fix depuis `main` à jour (`git pull origin main`), puis on la propose en PR (vers `staging` pour recette, ou directement vers `main` selon le flux).
- **Dossier de travail exclusif** : toutes les commandes (Git, Node, etc.) s'exécutent dans `tygr-app/`, jamais à la racine `Desktop/TYGR`.
- Hygiène : ne supprimer une branche distante que si `git branch -r --merged origin/main` la confirme fusionnée. Créer les branches d'infra (ex. `staging`) depuis un **clone propre** du remote.

### Autorisation de merge (Human-in-the-Loop nuancé, actée 2026-06-18)

- **Auto-merge autorisé** (l'agent peut merger lui-même via `gh`, en son nom, après Quality Gate vert) **UNIQUEMENT** pour les PR **non applicatives** : documentation, `chore/`, notes, configuration éditoriale — rien qui change le comportement du produit.
- **Human-in-the-Loop reste ABSOLU** pour tout le reste : code métier, infrastructure, sécurité, base de données (typiquement `feat/`, `fix/`, `refactor/`, migrations, RLS, Server Actions). Pour ces PR, l'agent **s'arrête à la PR poussée** et attend la validation + le merge **manuel** de l'humain.
- En cas de doute sur la catégorie d'une PR (mixte docs + code, ou portée ambiguë) : traiter comme **applicative** → ne pas auto-merger.
