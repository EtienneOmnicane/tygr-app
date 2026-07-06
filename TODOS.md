# TODOS — TYGR

Différés par la revue /autoplan du 2026-06-10 (plan v2.1 multi-tenant Workspace).
Décisions D2 (ré-priorisation UI, 2026-06-11) puis **D3 (annulation de D2, même
jour)** : voir le decision log du plan
(`~/.gstack/projects/tygr-app/clawdy-unknown-design-20260610-120713.md`).

### Polish dashboard v2 — dettes ouvertes après UI-FLUX-CHART-POLISH (#147 mergée, 2026-06-30)

Chantier graphe de flux livré et mergé (#147 : courbe corrigée — déformation +
hauteur §4.2 ; barres — hauteur, responsive, labels, plafond largeur). Dettes
visuelles restantes ci-dessous. **NOTE DE REGROUPEMENT** : `UI-FLUX-CHART-GABARIT1`
+ `UI-FLUX-CHART-NICE-SCALE1` + `UI-FLUX-BARRE-LARGEUR-PROD1` + `UI-SOLDE-CARD-POLISH1`
sont **tous du polish visuel dashboard** (même validation = l'œil) → à traiter
idéalement en **UN chantier « polish dashboard v2 »** (évite 4 micro-PR et 4 cycles
recon/plan).

- [ ] **UI-FLUX-CHART-GABARIT1 (P2, effort ~0,25 j hors arbitrage) — la DIV conteneur
  du graphe est trop HAUTE → aspect surdimensionné/« enfantin » (le tracé lui-même est
  ok).** Cause = `HAUTEUR_ANCRE = clamp(380px, 55vh, 520px)` introduit en #147
  (`src/components/dashboard/flux-layout.ts`, constante UNIQUE → fix s'applique à la
  courbe ET aux barres d'un coup, trivial une fois la valeur décidée). ⚠️ **ARBITRAGE
  REQUIS** : le `55vh` vient de `UI_GUIDELINES.md` §4.2 — le baisser (ex. ~40-45vh, ou
  plafond plus bas) **s'écarte de la charte**. À trancher : ajuster la valeur **vs**
  respecter le design system (valider avec le mainteneur de la charte si besoin). Repère :
  on était à `300px` fixe le matin du 2026-06-30 (jugé « écrasé ») → viser **entre les
  deux**. **Déclencheur** : décision sur la valeur cible (chiffre + accord charte).

- [ ] **UI-FLUX-CHART-NICE-SCALE1 (P2, effort ~0,5 j) — échelle « nice » non implémentée :
  un mois à fort montant écrase les petits (courbe ET barres).** Reporté VOLONTAIREMENT du
  polish #147 (juger le visuel d'abord). Fix : arrondi du `max` (puissance de 10 / pas
  régulier) dans `flux-bars.tsx` (barres) + domaine Y de la courbe dans `flux-chart-trace.tsx`.
  ⚠️ Isolation : le `max` des barres vient de `maxFenetre` (`flux-projection.ts`) qui n'est
  importé QUE par `flux-bars.tsx` → post-traiter localement ou modifier `maxFenetre` est
  sans effet de bord ; NE PAS toucher `projeterSurGrille`/`MoisAffiche` (partagés avec le
  tableau « Évolution mensuelle »). **Déclencheur** : ce chantier polish dashboard v2.

- [ ] **UI-FLUX-BARRE-LARGEUR-PROD1 (P2, effort ~0,1 j) — `LARGEUR_BARRE_MAX=40px` jugé
  sur données CREUSES.** Le plafond de largeur de barre (`flux-bars.tsx`) a été réglé alors
  que les fenêtres courtes étaient vides (faute de seed 2026 dense au moment du QA).
  Revérifier le rendu des barres sur fenêtre courte avec de **vraies données 2026 denses**
  (seed réparé en #146) et ajuster la constante si besoin. **Déclencheur** : QA visuel sur
  données denses (ce chantier polish dashboard v2).

- [x] **UI-SOLDE-CARD-POLISH1 (P2, effort ~0,25 j) — carte SOLDE mal espacée.** ✅ LIVRÉ (PR #160). « Rs » collé
  au montant (manque de respiration devise↔chiffre — vérifier que l'espace fine insécable
  U+202F de `format-montant.ts` est bien rendue, sinon ajuster l'espacement de la carte) ;
  bloc « il y a Xh » / « Synchroniser » mal aligné/rangé à droite. Composant carte solde du
  side-panel (distinct du graphe). Niveau classes Tailwind a priori. **Déclencheur** : ce
  chantier polish dashboard v2.

- [ ] **UI-SOLDE-MULTIDEVISE-POLISH1 (P2, effort S-M — Front) — la pile « SOLDES PAR
  DEVISE » mélange deux formats et casse l'alignement des décimales.** Constaté sur prod
  réelle (2026-07-02, 5 devises : EUR/GBP/MUR/USD/ZAR). Composant `SoldesMultiDevises`
  (`src/components/dashboard/side-panel-kpi.tsx`). Défauts OBJECTIVÉS : (1) deux formats
  coexistent — les devises à symbole connu (EUR €, MUR Rs, USD $) rendent le symbole en
  COLONNE GAUCHE + montant nu à droite, tandis que les devises SANS symbole (GBP, ZAR)
  n'ont AUCUN symbole gauche et collent le code ISO en SUFFIXE (« 349,20 GBP », « 583,52
  ZAR ») → colonne gauche en dents de scie (2 lignes vides), deux layouts entrelacés ;
  (2) l'alignement des décimales §7-1 est CASSÉ pour les lignes à suffixe : le code ISO
  inline pousse le nombre à gauche, donc « 349,20 » / « 583,52 » ne s'alignent pas sur
  « 774 022,60 » / « 221 862 968,24 » / « 177 427,99 » — l'invariant même pour lequel la
  grille `[auto_1fr]` existe ; (3) devise de base (MUR/Rs) pas en tête (ordre arbitraire) ;
  (4) pas de rythme/séparation entre lignes. CAUSE : `symbolePrefixe` renvoie un symbole
  pour certaines devises et rien pour d'autres → repli `formatMontant(total, currency)`
  (suffixe ISO) pour les inconnues, d'où le mélange. PISTE FIX : UN seul format —
  indicateur de devise TOUJOURS en colonne gauche (symbole si connu, SINON le code ISO),
  montant TOUJOURS « nombre nu » aligné à droite, décimales alignées, jamais de suffixe
  inline → €/GBP/Rs/$/ZAR tous à gauche, tous les nombres alignés. ⚠️ Unifier DU MÊME
  COUP mono (`SoldeMonoDevise`) et multi sur le MÊME helper « nombre nu » ET la MÊME
  logique d'indicateur gauche (absorbe la micro-dette P3 déjà notée : rendu identique
  garanti du même montant ; aujourd'hui le mono d'une devise sans symbole afficherait le
  suffixe ISO, incohérent avec le € mono). ⚠️ NE PAS casser le groupement U+202F ni
  `tabular-nums` ; le « nombre nu » = `formatMontant(total, "")` aujourd'hui (hack chaîne
  vide) → préférer un vrai helper partagé ; ne pas changer le comportement global de
  `format-montant.ts` sans vérifier les autres appelants. Isolation : aucune (rendu).
  **Déclencheur** : cette passe QA sur données réelles multi-devises.

- [ ] **UI-FLUX-HOOK-MIGRATION1 (P3, effort ~0,2 j, NON bloquant) — une seule implémentation
  du ResizeObserver.** La courbe (`flux-chart-trace.tsx`) garde son `ResizeObserver` INLINE ;
  les barres utilisent le hook extrait `use-dimensions-svg.ts` (#147). Migrer la courbe vers
  le hook partagé pour n'avoir qu'une implémentation (anti-duplication). **Déclencheur** :
  prochaine retouche de la courbe OU passage anti-dette. Raccroché au plus tard à un chantier
  nommé (règle 9, P3 ne pourrit pas).

- [ ] **DASH-ETAT-DISCRIMINANT1 (P3, effort ~0,3 j — décision comportementale AVANT code) —
  `page.tsx` appelle encore `cashflowParDevise` dont le SEUL rôle résiduel est d'alimenter le
  champ `flux`, lui-même consommé UNIQUEMENT par `choisirEtatDashboard` (discriminant
  partiel/complet).** Contexte : depuis la PR #150 (fix « courbe effondrée »), la courbe ne
  lit plus `flux` (elle dérive de `serieMensuelle` projetée) → `flux` n'est plus qu'un
  discriminant d'état d'onboarding. Candidat : basculer le discriminant sur `serieMensuelle`
  (ex. `serieMensuelle.length === 0`, ou une variante scopée à la devise de base) puis retirer
  du dashboard le champ `flux` + l'appel `cashflowParDevise` (l.98) + `fromFlux`/`to` (l.76)
  → **une requête SQL en moins par chargement du dashboard**. ⚠️ NE PAS toucher la DÉFINITION
  de `cashflowParDevise` (`insights.ts`, testée en isolation directe) ni son export barrel —
  on retire un APPELANT, pas la capacité. ⚠️ **Touche la logique d'onboarding** (partiel =
  « synchro en cours ») ET un **cas de bord** : un workspace n'ayant QUE des transactions hors
  devise de base (base MUR, tx uniquement USD) passerait de « partiel » à « complet » avec la
  variante simple `serieMensuelle.length` — la variante scopée devise l'évite mais élargit la
  signature de `choisirEtatDashboard`. **Chantier DÉDIÉ logique d'état, JAMAIS un rider d'un
  autre PR** (risque de régression d'onboarding silencieuse). **Déclencheur** : décision
  comportementale sur le cas USD-only (accepter l'écart simple vs préserver la sémantique
  mono-devise), puis chantier nommé. Origine : rebond de la PR #150 (revue Tech Lead 2026-07-01).

### Infra — découverte à clarifier (2026-06-30)

- [ ] **REPO-PARENT-IMBRIQUE1 (P2, effort ~0,25 j, NE PAS toucher à l'aveugle) — un dépôt git
  PARENT existe dans `Desktop/TYGR/`** (branche `feature/epic3-dashboard-ui-states` + dossier
  `worktrees/`), DISTINCT de `Desktop/TYGR/tygr-app/` (le vrai dépôt applicatif). Sans impact
  tant qu'on travaille DEPUIS `tygr-app/`, mais **piège latent** : une commande git lancée du
  mauvais dossier opère sur le parent. À clarifier : que contient-il, encore utile, archiver ?
  **Réflexe immédiat** : `git rev-parse --show-toplevel` AVANT toute commande git sensible
  (doit afficher `…/tygr-app`). **Déclencheur** : avant toute opération git destructive à la
  racine OU revue d'hygiène du poste. (Cohérent avec la directive mémoire « racine git ».)

### Chantiers PRODUIT à cadrer (pas encore lancés, 2026-06-30)

- [~] **REGLES-OPERATIONNEL1 (P2, effort à chiffrer après recon) — onglet Règles jugé « pas
  opérationnel ».** Amélioration d'EXISTANT (`src/app/(workspace)/regles/`, moteur
  `categorization_rules`) → **recon de l'existant nécessaire** pour comprendre ce qui manque
  AVANT de planifier (point de départ plus clair que les pages neuves). **Déclencheur** : début
  de chantier Règles (recon d'abord). **EN COURS** : chantier « Règles v1 — Édition + Priorité »
  (branche `feature/regles-edition-priorite`, 2026-07-01) livre l'édition, la réactivation via
  édition, le réordonnancement par priorité (drag + flèches) et la garde de rôle serveur.

- [ ] **REGLE-REORDER-CONCUR1 (P2, effort ~0,25 j, 2026-07-01) — réordonnancement des règles en
  last-write-wins.** `reordonnerRegles` (repo) réécrit l'ensemble des priorités des règles
  actives en une transaction, SANS verrou optimiste. Deux gestionnaires qui réordonnent (ou
  créent, cf. défaut `max+1`) en parallèle → le dernier COMMIT gagne. **Pas d'incohérence de
  données** (les priorités restent une permutation valide, l'ordre total `asc(priority),
  asc(createdAt)` reste déterministe) → risque purement cosmétique (un réordre peut être écrasé
  silencieusement). Parade possible : version optimiste (colonne `updated_at`/compteur) ou
  `SELECT … FOR UPDATE` sur l'ensemble actif. **Déclencheur** : premier workspace réel avec
  plusieurs gestionnaires qui éditent les règles simultanément, OU signalement « mon
  réordonnancement a sauté ».

- [ ] **NAV-GRAPHIQUES1 (P2, CADRAGE PRODUIT requis) — activer l'onglet Graphiques** (page à
  créer / aujourd'hui vide ou inactive). **Cadrage produit d'abord** : quel contenu ? quels
  graphes ? réutilise-t-il le moteur flux (`flux-*`, insights) ou autre ? Benchmark/challenger
  à faire. **Déclencheur** : décision produit sur le contenu de la page.

- [ ] **NAV-ECHEANCES1 (P2, CADRAGE PRODUIT requis — décision métier clawdy/Omnicane) — activer
  l'onglet Échéances** (page neuve). Sujet MÉTIER, pas technique : prévisionnel ? factures à
  venir ? rappels ? **Déclencheur** : décision produit/métier sur la nature de l'écran.

### Sélecteur de périmètre (L8b-1) — bug d'auto-amputation corrigé (2026-06-30)

Le `PerimetreSwitcher` ne s'auto-ampute plus : la liste qui le peuple reflète
désormais le DROIT COMPLET du membre (lecture en session sans `viewFilter` dans le
layout), pas le filtre actif. Affordance de reset ajoutée (« Tout effacer » +
option « Groupe » mise en évidence). Dette UI ouverte par ce chantier :

- [ ] **UI-PERIMETRE-ACCORDEON1 (P2, effort ~0,5 j) — sélecteur de périmètre en
  accordéon banque→comptes (tri-state sur la banque : tout / partiel / rien) pour
  gérer les gros volumes de comptes.** Aujourd'hui le sélecteur est une **liste
  PLATE** de comptes (`src/components/shell/perimetre-switcher.tsx`) : parfait à
  faible volume, mais illisible quand un manager a des dizaines de comptes répartis
  sur plusieurs banques. Cible : grouper les comptes par `institutionName`, avec une
  case par banque à **trois états** (tous cochés / partiellement cochés / aucun) qui
  coche/décoche tous ses comptes d'un coup, et une section repliable par banque.
  Pas de changement serveur (la sélection postée reste une liste de `bankAccountId`,
  la RLS intersecte). **Déclencheur** : volumes réels — premier manager avec des
  dizaines de comptes / plusieurs banques (retour terrain « la liste est trop
  longue »). Tant que les workspaces restent à faible volume, la liste plate suffit.

> **RÉVISION UI-PERIMETRE-ACCORDEON1 (clawdy 2026-07-02, données prod réelles)** : l'axe
> de groupement passe de banque→comptes à **Groupe→Entité→comptes** (accordéon, tri-state
> par entité ET par Groupe : tout / partiel / rien). Même mécanique tri-state que la
> version banque, axe différent — cohérent avec UI-ACCOUNTS-ACCORDEON-ENTITE1
> (organisation entity-first). Le sélecteur (`src/components/shell/perimetre-switcher.tsx`)
> est aujourd'hui une liste PLATE ; cible = accordéon par entité, l'option « Groupe »
> restant le niveau haut (tout le périmètre). MÊME DÉPENDANCE : entités peuplées
> (ENTITY-PARTY1) + ENTITY-UI1. Cette entrée ABSORBE la remarque « sélection des entités
> par groupe » — pas de ticket séparé. Cross-ref PERIMETRE-ENTITE-DERIVE1.

- [ ] **PERIMETRE-ENTITE-DERIVE1 (P2, effort ~1 j) — le filtre « par entité » dérive
  si l'ADMIN réassigne un compte.** L'axe Entité du sélecteur (L8b-2, stratégie a) pose
  dans le token la **liste des `bankAccountId` de l'entité à l'instant T** (le token ne
  stocke pas d'`entity_id`). Si l'ADMIN réassigne ensuite un compte à/hors de l'entité,
  la liste figée ne suit pas → le libellé re-dérivé (`entiteDuFiltre`,
  `src/components/shell/perimetre-switcher.tsx`) cesse de correspondre exactement et
  retombe sur « N comptes » (pas de mensonge, mais on perd le nom). **Pas une dette
  d'isolation** (la RLS reste la sécurité ; le filtre ne peut que rétrécir). **Déclencheur** :
  réassignation de compte fréquente OU besoin produit d'un libellé entité stable.
  **Résolution** : stratégie (b) (GUC `view_filter_entity` dédié, axe RLS complet) ou
  recalcul du filtre au login / au changement d'assignation. Tant que les assignations
  sont rares, la dérive est acceptable (péremption assumée par le plan L8b-2).

### Verrou production sur hôte partagé — livré (2026-06-26)

`config.ts` autorise désormais `OMNIFI_ENV="production"` sur l'hôte PARTAGÉ
`api-stage.omni-fi.co` via l'opt-in `OMNIFI_AUTORISER_PRODUCTION="1"` (l'env vient des
clés, pas de l'hôte — confirmé tuteur). Branche `feat/verrou-prod-hote-partage`. Plan :
`PLAN-verrou-prod-hote-partage.md`. Dettes/étapes ouvertes par ce chantier :

- [ ] **PROD-DATA-LOCAL1 (P1, déclencheur : tout usage DURABLE de vraie donnée) —
  vraie donnée bancaire stockée sur base Docker LOCALE.** Constat 2026-06-26 : les clés
  prod pointent vers la stack Postgres conteneurisée du poste de dev → de la PII bancaire
  réelle (soldes, libellés, relevés) vit en local, en clair via `.env`, sans chiffrement
  au repos garanti ni backup ni contrôle d'accès. Viole CLAUDE.md règle 8 (« pas de dump
  de prod en local »). TOLÉRABLE pour une démo/un test ponctuel ; INTERDIT comme usage
  durable. Résolution : base Neon dédiée + pipeline `provision → migrate → deploy`, et ne
  jamais conserver de vraie donnée sur un poste. Effort : ~0,5j (infra base) hors code app.

- [x] **PROD-ENDUSER1 (P1, déclencheur : avant le 1er parcours « connecter une banque »
  en prod) — créer + inscrire l'EndUser de production. 🚧 BLOQUÉ côté Omni-FI (2026-06-26).**
  ✅ **RÉSOLU 2026-07-02** : connexions bancaires RÉELLES établies en environnement prod
  (77 comptes découverts, soldes multi-devises remontés) → le `401 Invalid client
  credentials` est LEVÉ, les clés prod sont désormais reconnues. La bascule vraie-donnée
  est opérationnelle. (Reste historique du blocage ci-dessous pour trace.)
  L'annuaire des EndUsers Omni-FI est rattaché aux CLÉS : l'EndUser sandbox actuel est
  inconnu des clés prod (`link-token` échouerait). Étapes : `POST /clients/end-users` avec
  les clés prod → écrire la valeur reçue dans `workspaces.omnifi_client_user_id` (UPDATE ;
  le code lit la colonne, pas `.env` — `orchestration.ts:109`). Réversible (remettre
  l'EndUser sandbox). Hors code, opérationnel. Cf. `docs/BASCULE-PRODUCTION-OMNIFI.md` § piège n°3.
  **BLOCAGE** : `POST /clients/end-users` avec les clés PROD renvoie `401 Invalid client
  credentials` sur `api-stage.omni-fi.co`. Diagnostiqué : ce n'est PAS notre commande (test
  de contrôle avec les clés SANDBOX du `.env` → `201 Created`), ni une faute de copie (clés
  prod aux bonnes longueurs : client_id 39 car., secret 72 car.). ⇒ Les clés prod ne sont
  pas reconnues par ce serveur (jamais générées / secret périmé — affiché 1 seule fois /
  autre environnement). **Action requise (user + tuteur)** : (re)générer le secret via
  `POST /clients/{ApiClientId}/keys/generate` OU faire confirmer par le tuteur qu'un
  ApiClient de prod ACTIF existe bien sur `api-stage`. Tant que ce 401 n'est pas levé, la
  bascule vraie donnée est impossible (le verrou code, lui, est PRÊT — PR #124 mergée).

- [ ] **PROD-ENDUSER-DIAG-CLEANUP (P2, déclencheur : prochain ménage sandbox) — EndUser de
  contrôle résiduel.** Le diagnostic du 401 (2026-06-26) a créé `tygr-diag-controle-sandbox`
  dans l'annuaire SANDBOX (test prouvant la commande). Omni-FI n'expose pas de `DELETE
  /clients/end-users/{id}` (→ 404 HTML). Résidu inerte (identifiant sans donnée bancaire,
  bac à sable). Le purger si Omni-FI ajoute une route de suppression, sinon l'ignorer.

### Sync réel Omni-FI — déclenchement de scraping (POST /sync) livré (2026-06-25)

Le bouton « Synchroniser mes comptes » DÉCLENCHE désormais un sync réel
(`POST /sync/{ConnectionId}` ApiKey → job → attente) AVANT la boucle de lecture
existante, au lieu de relire seulement le cache amont (branche
`feat/omnifi-sync-trigger`). Contrat confirmé empiriquement en sandbox
(`scripts/diag-sync.ts` : 201 `{JobId,PENDING}`, COMPLETED parfois à t+0s).
Dettes ouvertes par la revue contradictoire de ce chantier :

- [x] **SYNC-REPAIR-UI1 (P1, point de DÉPLOIEMENT du widget en prod) — LIVRÉ
  (branche `feature/sync-repair-ui`, 2026-06-25) : réouverture du widget natif en mode
  REPAIR quand une banque retombe en MFA.** Le composant
  `src/components/widget/bank-connect-widget.tsx` consomme désormais `r.reparation` (de
  `synchroniserConnexionsAction` / `finaliserConnexionDropinAction`) et affiche un bouton
  « Reconnecter » par connexion (dans `WidgetFeedback`). Au clic :
  `creerLinkTokenRepairAction(connectionId, jobId, redirectOrigin)` → LinkToken `Mode:
  REPAIR` (champs `ConnectionId`/`JobId` ajoutés à `CreerLinkTokenParams`) → remontage du
  MÊME `OmniFiLinkLauncher` (le widget gère l'OTP en interne, cf. vendor README §MFA
  handling) → `onSuccess` relance `resynchroniserConnexionApresReparationAction`
  (re-découverte + `synchroniserCompte`, ingestion INCHANGÉE) et retire la connexion de
  l'état réparation. Sécurité : gating MANAGER/ADMIN + ClientUserId scopé + garde anti-IDOR
  `ReparationContexteInvalideError` (la connexion doit appartenir au tenant) prouvée par
  la suite isolation (`tests/isolation/widget-orchestration-isolation.test.ts`, +7 cas).
  Cas couverts : widget fermé sans finir (état réparation conservé, bouton recliquable) ;
  échec de re-lecture fail-soft ; re-sync re-OTP (re-signalé avec le NOUVEAU jobId).
  **Reste (Human-in-the-Loop, NON une dette de code)** : valider le PARCOURS INTERACTIF
  réel (clic → écran code du widget → re-lecture) sur le serveur HTTPS avec des clés
  sandbox — le widget natif n'est pas capturable en headless (Visual QA des états statiques
  fait via route démo `/demo/banque-connexion` blocs 5–6, cert HTTPS local rejeté par
  Chromium → rendu CSS inliné, cf. [[visual-qa-serveur-https-voisin]]).

- [ ] **SYNC-RATELIMIT-UI1 (P2) — exploiter `EtatFinalisation.rateLimited` côté UI.** Le
  serveur remonte `rateLimited = [{connectionId, nextSyncAt}]` (connexions en cooldown
  « 1 sync / 15 min », non re-déclenchées) et un message texte avec délai relatif. Le
  champ structuré est pour l'instant inerte côté client (seul le texte de `succes` est
  affiché). **À faire** : afficher un compte à rebours / désactiver le bouton jusqu'à
  `nextSyncAt`. **Déclencheur** : retour utilisateur « je clique et il ne se passe
  rien » sur des clics rapprochés. **Effort** : S.

- [ ] **SYNC-LONGRUN1 (P1, point de DÉPLOIEMENT — workspace multi-connexions Omnicane) —
  déporter l'attente du job hors de la Server Action interactive.**
  `synchroniserConnexionsDepuisOmnifi` poll chaque job jusqu'à `POLL_SYNC_PLAFOND_MS`
  (120 s) **séquentiellement** par connexion : sur N connexions lentes, l'action peut
  approcher `N × 120 s` et dépasser le plafond d'exécution de la plateforme (Next/Vercel),
  l'utilisateur reçoit alors le message générique ET perd les imports des connexions
  déjà traitées (le `return` final n'est pas atteint). Le cas métier explicite est
  « 1 connexion = N entités » (CLAUDE.md Entités) → plusieurs connexions par workspace.
  **À faire** : déporter le déclenchement+attente vers un job d'arrière-plan (Inngest est
  au stack) et notifier l'UI à la complétion, ou borner agressivement le plafond +
  paralléliser. **Déclencheur** : premier workspace réel à ≥3 connexions actives, OU
  premier timeout plateforme observé sur ce bouton. **Effort** : M/L (intro d'un job
  Inngest). Lien : la même infra servira un futur trigger automatique / webhooks.

### Parcours utilisateur complet — bilan QA runtime (2026-06-24)

Parcours connecté de bout en bout (navigateur headless, compte `enardou@omni-fi.co`,
base locale 12 comptes / 260+ tx sandbox), branche `feature/regles-form-validation-ux`.
Le cœur métier (consulter la trésorerie, ventiler, automatiser par règles, déconnexion)
est **réel, persistant et correct sur desktop ≥1024px** ; les constats ci-dessous sont
des **trous de complétude / onboarding / responsive**, pas des bugs de logique. **Aucun**
ne touche l'isolation tenant, l'append-only ni les montants (sinon il serait corrigé
immédiatement, pas consigné). Preuves runtime : POST de ventilation `200` → statut
« Complet » ; règle créée `200` + « Ré-analyser » a recatégorisé 7 transactions ;
logout → `/login` et accès direct post-logout re-redirigé.

- [x] **QA-ONBOARD-CATEG1 (P1, point d'ONBOARDING — premier utilisateur) — seeder les
  catégories par défaut à la création d'un workspace.** ✅ RÉSOLU 2026-07-06 (branche
  `feat/onboard-seed-categories`, en attente de revue/merge). Constaté : le picker de
  ventilation affichait « Aucune catégorie ne correspond » sur un champ **vide** — un
  workspace neuf n'avait **aucune** catégorie et rien ne déclenchait le seed à sa création.
  **Livré, deux volets** : (A) `scripts/seed-admin.mjs` et `scripts/seed-omnifi-demo.ts`
  sèment le référentiel à la création du workspace, via une lib partagée
  `scripts/seed-categories-lib.mjs` (idempotente, verrou consultatif) ; le référentiel a
  été déplacé `scripts/categories-referentiel.mjs` → `src/lib/categories-referentiel.mjs`
  (importable côté app). (B) CTA « Importer les catégories standard » dans le picker vide
  → Server Action `importerCategoriesStandardAction` → repository
  `importerReferentielCategories` (sous `withWorkspace`, garde ADMIN, RLS). Preuves :
  `tests/isolation/seed-categories-isolation.test.ts` (9 cas : seed CLI, tout-ou-rien,
  CTA admin/idempotence/refus non-admin/intra-tenant/tout-archivé). Cf. mémoire
  `seed-categories-commande-locale`.

- [ ] **QA-RESPONSIVE-SHELL1 (P1, point de DÉPLOIEMENT si usage tablette/mobile attendu) —
  condenser le header sous le breakpoint (débordement horizontal global).** Mesuré au
  DOM : `scrollWidth` ≈ **950px** quelle que soit la page → débordement de **+575px en
  mobile (375px)** et **+182px en tablette portrait (768px)** ; OK seulement à partir de
  **1024px**. Identique sur toutes les routes (transactions, regles, graphiques,
  admin/entites) → c'est **structurel**, pas une page. Cause exacte :
  `src/components/shell/app-header.tsx:39` est un `flex h-16 items-center gap-6` avec 8+
  items horizontaux (logo + `AppNav` + `WorkspaceSwitcher` + CTA banque + Membres +
  Entités + déconnexion) **sans aucune classe responsive** (`md:`/`hidden`/menu mobile) ;
  `AppNav` (`app-nav.tsx:36`) est lui aussi un `flex` non condensé. Viole la règle UI
  CLAUDE.md « Responsive header : condenser sous le breakpoint (menu/icône), **JAMAIS
  flex-wrap** ». **À faire** : passer le bloc de droite + la nav en menu/burger sous
  `lg` (ou masquer/regrouper). **Déclencheur** : décision produit « l'app doit être
  utilisable < 1024px » (un Financial Manager sur tablette/téléphone). Si desktop-only
  assumé → tracer la décision et **fermer ce ticket explicitement** (ne pas laisser
  pourrir). **Effort** : M. (NB : la mémoire `dashboard-insights-voie-a-livre` notait
  déjà un « overflow mobile préexistant » — c'est lui, généralisé à tout le shell.)

- [ ] **QA-UX-CATEG-COHERENCE1 (P2) — lever l'ambiguïté entre catégorie *prédite Omni-FI*
  et statut de ventilation TYGR.** Sur `/transactions`, une même cellule juxtapose la
  catégorie **prédite** par Omni-FI en sous-texte (« Charges d'exploitation »,
  « Honoraires », « Logement ») ET le statut de ventilation TYGR « Non catégorisé » → une
  ligne intitulée « Charges d'exploitation » est affichée « Non catégorisé », ce qui se
  contredit à l'œil. Après ventilation, la colonne montre « 1 catégorie**s** » (pas
  d'accord singulier/pluriel) **mais pas le nom** de la catégorie posée (il faut rouvrir
  la modale pour la connaître). Cellule par ailleurs **dupliquée** dans le DOM (variantes
  mobile+desktop superposées : « Non catégorisé Non catégorisé »). **À faire** : clarifier
  le vocabulaire (prédiction ≠ ventilation validée), afficher la/les catégorie(s)
  utilisateur dans la colonne, corriger l'accord pluriel, et masquer la variante non
  pertinente au lieu de la dupliquer. **Déclencheur** : prochaine itération UX
  `/transactions`. **Effort** : S–M. Cf. mémoires `cascade-libelle-transaction` +
  `ui-fiabilite-classification-transactions`.

- [ ] **QA-UX-VENTIL-RESTE1 (P2) — « Catégoriser le reste » ne doit pas créer une ligne
  orpheline quand une catégorie est déjà sélectionnée.** Reproduction : ouvrir la modale,
  choisir une catégorie (montant laissé vide), cliquer « + Catégoriser le reste » → au
  lieu de remplir la **ligne courante**, l'action **ajoute une 2ᵉ ligne** pré-remplie au
  montant restant mais **sans catégorie**. Résultat : « Reste Rs 0,00 » (barre pleine)
  mais Valider reste désactivé car une ligne a une catégorie sans montant et l'autre un
  montant sans catégorie — état confus pour l'utilisateur. Le garde-fou (Valider
  désactivé sur état incohérent) est correct ; c'est l'ergonomie du raccourci qui piège.
  **À faire** : « Catégoriser le reste » remplit la dernière ligne **catégorisée mais non
  chiffrée** s'il y en a une, sinon crée la ligne. **Déclencheur** : prochaine itération
  de la modale de ventilation. **Effort** : S. Cf. mémoire `split-allocation-modal-plan`.

- [ ] **QA-ENTITES-CREATION-UI1 (P1, raccroché au chantier Entités multi-tenant) — exposer
  la création d'entité dans l'UI `/admin/entites`.** La page n'offre que l'**assignation**
  (Vision Globale / Vision Entité par membre) et affiche « Aucune entité n'a encore été
  créée pour ce groupe » ; passer un membre en « Vision Entité » mène à un **cul-de-sac**
  (« Sélectionnez au moins une entité » alors qu'aucune n'existe et qu'on ne peut pas en
  créer). **Le backend est pourtant prêt** : `creerEntiteAction` +
  `creerEntiteSchema` existent dans
  `src/app/(workspace)/admin/entites/actions.ts:113`, mais **ne sont câblés nulle part
  dans l'UI** (vérifié : ni `page.tsx` ni `assignation-entites.tsx` ne les importent).
  C'est donc un **trou d'UI**, pas un trou complet. **À faire** : ajouter un formulaire
  « Nouvelle entité » qui appelle `creerEntiteAction` (garde ADMIN déjà côté action).
  **Déclencheur** : le multi-entités est la priorité démo n°1 (roadmap Omnicane) → dû
  avant toute démo « Vision Entité ». **Effort** : S–M. Cf. mémoires
  `ui-admin-entites-maquette`, `roadmap-omnicane-entites`.

- [ ] **QA-LISTES-MANQUANTES1 (P2) — les pages « liste » n'affichent pas l'existant.**
  Trois écrans nommés comme des listes ne montrent que des actions, jamais l'état :
  (a) **`/banques`** (« Banques connectées ») n'affiche **aucune** des 12 banques
  connectées (seulement « + Connecter une banque » / « Synchroniser ») → impossible de
  voir ni déconnecter une connexion ; (b) **`/admin/membres`** (« Membres du workspace »)
  n'affiche que le **formulaire de création**, pas la liste des membres (or
  `listerMembresWorkspace` existe déjà, cf. mémoire `ui-admin-entites-maquette`) ;
  (c) **`/admin/entites`** liste bien les membres mais pas les entités (cf.
  QA-ENTITES-CREATION-UI1). **À faire** : rendre l'état à côté de l'action (liste des
  connexions bancaires avec déconnexion ; liste des membres avec rôle). **Déclencheur** :
  prochaine itération admin / gestion des connexions. **Effort** : M.

- [ ] **QA-NAV-PLACEHOLDERS1 (P2) — Graphiques & Échéances : sections vides au message
  trompeur + incohérence placeholder.** `/graphiques` et `/echeances` sont des
  placeholders « Bientôt… **cette section s'activera dès que vos comptes seront
  synchronisés** » — or les comptes **sont** synchronisés (12 comptes, 260+ tx) : le
  message est **factuellement faux** dans ce contexte et promet une activation qui ne
  viendra pas d'une synchro. De plus, `app-nav.tsx:42` prévoit un mode `placeholder`
  (libellé inerte, non cliquable) **non utilisé** : ces deux items naviguent vers une
  vraie page placeholder (200) au lieu d'être rendus inertes → deux conventions
  « pas encore livré » coexistent. **À faire** : soit livrer ces écrans, soit aligner sur
  UNE convention (item de nav inerte OU page « en construction » au message honnête, sans
  référence à une synchro déjà faite). **Déclencheur** : développement de la section
  Graphiques (90j) / Échéances. **Effort** : S (alignement) à L (livraison réelle).

- Note QA (non bloquante, **données de démo**, pas l'app) : soldes strictement
  identiques sur les 4 banques (fixture sandbox clonée → ressemble à des doublons) ;
  transactions datées dans le futur relatif (22 août / 14 juil. au 24 juin) ; libellés
  « Opération bancaire » résiduels (fallback enrichment, cf. mémoire
  `contrat-enrichment-imbrique`). Limite de la **sandbox**, à garder en tête pour les
  démos. **Parcours bancaire non testable en local HTTP** : le widget Omni-FI refuse
  l'origine `http://localhost` (« Origine sécurisée non autorisée », garde-fou
  `RedirectOrigin` attendu, erreur correctement affichée) — testable seulement en https.

### Insights financiers — module amont non livré, dérivation interne (2026-06-24)

- [ ] **INSIGHTS-AMONT1 (P2) — basculer les Insights sur l'API Omni-FI quand le module
  sera livré.** Audit de faisabilité Staging du 2026-06-24 (cf.
  `PLAN-tech-api-insights.md`) : `/insights/cashflow`, `/insights/vendors`,
  `/insights/alerts` et `/dashboard/insights` renvoient tous **`501 NOT_IMPLEMENTED`**
  (« Insights module is not yet implemented »), 501 même **sans auth** → module non
  branché côté serveur (la route existe : `OPTIONS → 200`, `POST → 405`). On a donc livré
  la **Voie A** : cashflow & vendors **DÉRIVÉS** de `transactions_cache`
  (`src/server/repositories/insights.ts` + DTO internes `src/server/insights/types.ts`),
  zéro dépendance au 501. **Déclencheur de résolution** : passage **501 → 200** de
  `GET /insights/cashflow` en Staging (re-jouer l'audit §1 du plan à chaque sprint tant
  que ce ticket est ouvert). **Effort estimé** : ~1 j (client amont + mapper
  `mapDepuisOmniFi` → MÊME DTO interne + flag `INSIGHTS_SOURCE` + réconciliation
  dérivé↔amont). **Ne PAS coder le client amont avant** : un 501 ne révèle aucun payload
  de succès → on figerait un parseur contre un contrat fantôme (piège `/v1` /
  `Enrichment` déjà payé ×2). NON une dette d'isolation/append-only/montant (la Voie A
  respecte déjà tous ces invariants : RLS tenant + JOIN scope entité + agrégat SQL en
  chaînes décimales). Rappels de contrat amont gravés dans `docs/agent-capabilities.md`
  (§5) : routes à la RACINE (pas `/v1`), param `client_user_id` snake_case (camelCase →
  403), enveloppe d'erreur `{Error:{}}` ≠ OBIE.

- [ ] **INSIGHTS-MATVIEW1 (P2, conditionnelle) — matérialiser le cashflow si la perf
  l'exige.** Les insights sont aujourd'hui calculés À LA LECTURE (agrégat SQL sur
  `transactions_cache`), choix KISS validé (pas de table spéculative, règle 9). Si un
  cap de perf est **démontré** (pas supposé), introduire une vue matérialisée
  `insights_cashflow_*` rafraîchie post-sync, **append-only au DELETE** (trigger +
  liste blanche, comme toute table financière — cf. CLAUDE.md). **Déclencheur** : p95 de
  l'agrégat cashflow > seuil sur jeu de données réel. **Effort** : ~0,5–1 j. **Pas
  avant** une mesure réelle.

### Localisation — identifiant de fuseau Maurice erroné (2026-06-22, Lot 2)

- [x] **TZ-DOC1 (P1, point de DÉPLOIEMENT/fuseau) — corriger « Asia/Port_Louis » →
  « Indian/Mauritius »** — Effort S. **RÉSOLU 2026-06-22** (`hotfix/tz-mauritius-correction`).
  Découvert au Lot 2 (pastille de fraîcheur §3.7) : `Asia/Port_Louis` **n'existe pas**
  comme identifiant IANA et fait planter `Intl` (`RangeError: Invalid time zone
  specified`), y compris sous full-ICU (Node 25, ICU 78). Le bon nom canonique de
  Maurice (UTC+4) est **`Indian/Mauritius`**. Le seul code passant une chaîne de fuseau
  à `Intl` (`src/lib/format-date.ts`, `FUSEAU_MAURICE`) utilisait DÉJÀ le bon
  identifiant — aucune ligne exécutée n'était en cause ; le risque était purement
  documentaire (un futur agent se fiant au commentaire). Correctif : remplacement des
  mentions **affirmatives** trompeuses dans `CLAUDE.md` (« Localisation & temps » +
  « Formatage »), `docs/cahier_des_charges.md` §3.bis, les en-têtes de
  `src/server/ingestion/conversion.ts`, `src/server/db/schema.ts`, `src/lib/format-date.ts`,
  et les libellés de test (`ingestion-conversion.test.ts`, `format-date.test.ts`).
  CONSERVÉES volontairement (citent `Asia/Port_Louis` comme l'erreur À ÉVITER, les
  remplacer les viderait de sens) : les garde-fous `format-date.ts:54,145` et le constat
  historique archivé sur `balanceDate` (cross-review 2026-06-15, plus bas). **Vérifié**
  côté Backend : aucune clause SQL `AT TIME ZONE` n'est exécutée dans `drizzle/` à ce
  jour (la dérivation `transaction_date` se fait en TS par offset fixe UTC+4 dans
  `deriverDateComptableMaurice`) — donc PAS de dette Backend bloquante ; le jour où une
  telle clause SQL sera posée, elle devra employer `Indian/Mauritius`.

### Entités multi-tenant (Option B) — dettes ouvertes par le plan (2026-06-22)

Plan de référence validé : `PLAN-entites-multi-tenant.md` (§5). Le socle Entités L1→L2
(`entities`, `bank_accounts.entity_id`, `member_entity_scopes`, policy RLS `entity_scope`
+ 3ᵉ GUC) couvre l'**étage 1 (tenant, dur — inattaquable, prouvé en cross-review)** et
pose la garde **étage 2 (entité)** sur `bank_accounts`. Les dettes ci-dessous sont hors
périmètre du socle (anti-scope-creep, règle 7). Aucune ne touche l'isolation **tenant**
(sinon INTERDITE, règle 9) — toutes sont **intra-groupe (étage 2)**.

> 🔓 **GATE D'ACTIVATION — LES DEUX P1 SONT LEVÉES (2026-06-22)**. Historique : la
> cross-review sécu (contexte vierge) avait identifié deux trous **latents** prouvés
> runtime — lecture sans jointure (`ENTITY-READ-JOIN1`) et écriture non scopée
> (`ENTITY-WRITE-SCOPE1`) — et posé une **interdiction formelle** de livrer un chemin
> créant une ligne `member_entity_scopes` tant qu'ils n'étaient pas TOUS DEUX clos.
> ✅ `ENTITY-READ-JOIN1` levée (PR #83, jointure repos) ; ✅ `ENTITY-WRITE-SCOPE1` levée
> (PR `fix/entity-write-scope`, policy `entity_scope` FOR ALL USING+WITH CHECK, migration
> 0009). L'étage 2 borne désormais lecture ET écriture, prouvé par
> `tests/isolation/entites-isolation.test.ts` (blocs « étage 2 hérité par jointure » +
> « écriture bornée par scope »). **Le verrou sécurité est donc OUVERT** ; ce qui reste
> avant une Vision Entité réelle en prod n'est plus de l'isolation mais du **produit** :
> livrer L3/L4 (repo `entites.ts` + Server Actions `definirScopesMembre`/sas, garde
> **ADMIN applicative**) puis L5 (preuve runtime bout-en-bout du parcours VIEWER scopé).

- [x] **ENTITY-READ-JOIN1 (P1) — brancher les repos de LECTURE sur la jointure `bank_accounts` pour hériter du scope entité** —
  ✅ **RÉSOLU 2026-06-22 (PR #83, `fix/entity-read-join1`)**. `innerJoin(bankAccounts)` ajouté aux
  4 fonctions de lecture de `dashboard.ts` (`transactionsRecentes`, `syntheseMois`,
  `courbeTresorerie` + `soldeConsolideCourant` — même fuite latente sur `balance_history`,
  bouchée par cohérence). Jointures sûres (`bank_account_id` NOT NULL) et neutres en Vision
  Globale (policy RESTRICTIVE laisse tout passer GUC vide → agrégats inchangés, zéro régression).
  Tests « fuites latentes 13/13b » INVERSÉS en preuve de levée sur les vraies fonctions repo
  (Vision Entité Sucrière ne voit que Sucrière ; contre-preuve Vision Globale voit tout).
  Reste HISTORIQUE ci-dessous :
  Effort S, gardien Backend. Ouvert 2026-06-22 (découvert pendant l'implémentation L1→L2,
  branche `feat/entities-data-model`). La policy `entity_scope` (étage 2) vit sur
  `bank_accounts` ; transactions/soldes n'en héritent **que via une JOINTURE** sur
  `bank_accounts`. Or des repos de lecture lisent les tables filles SANS cette jointure —
  vérifié : `transactionsRecentes` (`dashboard.ts:238`, `from(transactionsCache)` nu).
  Conséquence : en Vision Entité, ces lectures verraient les transactions d'une autre
  entité du **même** workspace. ⚠️ **Pas une fuite cross-tenant** : `transactions_cache`
  porte sa propre policy `tenant_isolation` (étage 1 intact) — l'écart est **intra-groupe**
  (étage 2). À faire : ajouter `innerJoin(bankAccounts, …)` (ou un `WHERE bank_account_id
  IN (select id from bank_accounts)` qui passe la RLS) à `transactionsRecentes`,
  `courbeTresorerie`, `syntheseMois` et tout repo lisant `transactions_cache`/
  `balance_history` directement, pour que la policy `entity_scope` morde par héritage.
  **Déclencheur** : socle Entités mergé — **BLOQUANT avant le premier déploiement où une
  Vision Entité est activée** (P1, SLA « avant prod »). Tant que personne n'a de ligne
  `member_entity_scopes` (tout le monde en Vision Globale), l'écart est inerte. Corrige
  aussi l'affirmation « masque déjà en lecture par jointure » d'ENTITY-WRITE-SCOPE1 :
  vraie pour les repos QUI joignent, à généraliser par cette dette.

- [ ] **ENTITY-PARTY1 (P2) — pré-remplir la CRÉATION d'entités + l'assignation via les
  « Parties » Omni-FI, dès la phase 1 du widget** — Effort M, gardien Backend. Ouvert
  2026-06-22, **précisé 2026-07-02 (retour terrain prod réelle)**. La doc API expose `GET
  /parties/{PartyId}/accounts` + `OBReadAccount6.PartyId/PartyName/OwnershipType`
  (entités légales API). `party_id`/`party_name` sont **DÉJÀ persistés** à l'ingestion
  (`ingererPartiesDesComptes`, tables `parties` + `account_party_role`) — le socle existe.
  Ce qui manque = le **pont `Party` → `entities` + `bank_accounts.entity_id`** :
    1. À la **phase 1 du widget** (récupération entités/comptes à l'ouverture, événements
       `sync.retrieving_parties`/`sync.parties_retrieved`), DÉRIVER une entité candidate
       par `PartyName` distinct et PRÉ-COCHER le rattachement des comptes de cette party.
    2. Décision PO (2026-07-02, question tranchée) : **PRÉ-REMPLIR + VALIDATION ADMIN**,
       PAS de création/assignation automatique. Le widget PROPOSE ; l'ADMIN confirme dans
       le sas (`/admin/entites`) avant que `entity_id` soit posé.
  ⚠️ **FRONTIÈRE D'ISOLATION — NON NÉGOCIABLE** : l'ingestion NE crée JAMAIS d'entité ni
  ne pose `entity_id` sans le pas de validation ADMIN (invariant CLAUDE.md « l'ingestion ne
  pose jamais entity_id automatiquement » + « l'upsert de re-sync ne réécrase JAMAIS un
  entity_id assigné »). Raison : 1 credential = comptes de N entités → faire autorité du
  découpage amont = **fuite intra-groupe** (compte visible par le mauvais Financial
  Manager). La party Omni-FI est un INDICE de pré-remplissage, jamais l'autorité.
  **Déclencheur** : retour terrain « trop de saisie manuelle » (✅ CONSTATÉ 2026-07-02 :
  77 comptes prod à assigner à la main après reset) **ET** preuve que les Parties sont
  fiablement peuplées en prod → **✅ PROUVÉ 2026-07-02 sur la donnée prod RÉELLE** :
  `28 parties`, **100 % nommées** (ex. `OMNICANE THERMAL ENERGY`, `OMNICANE LIMITED`,
  `AIRPORT HOTEL LTD`, `MERIDIS LIMITED`, `TROPICAL CUBES`…), **77 liens** `account_party_role`
  (chaque compte rattaché à sa party), `entity_id` encore à 0 (pont non câblé). Recon :
  `SELECT p.name, count(apr.bank_account_id) FROM parties p LEFT JOIN account_party_role
  apr ON apr.party_id=p.id GROUP BY p.name`. NB : `parties.entity_id` existe DÉJÀ dans le
  schéma (colonne présente) → le pont est structurellement prêt, il reste à l'alimenter via
  le sas validé. Les deux déclencheurs sont donc levés — dette **mûre pour planification**.
  **NON une dette d'isolation** (le
  pré-remplissage ne relâche aucune garantie ; c'est la création AUTO qui en serait une,
  et elle est écartée). Voir aussi [[PERIMETRE-ENTITE-DERIVE1]] (péremption du libellé si
  réassignation ultérieure).

- [x] **ENTITY-WRITE-SCOPE1 (P1, BLOQUANTE avant prod Vision Entité) — l'étage 2 ne borne PAS l'ÉCRITURE** —
  ✅ **RÉSOLU 2026-06-22 (PR `fix/entity-write-scope`)**. Migration `0009_entity-write-scope.sql` :
  la policy `entity_scope` passe de `FOR SELECT` à **`AS RESTRICTIVE FOR ALL`** (USING + WITH
  CHECK, même expression GUC). USING borne le ciblage (SELECT/UPDATE/DELETE), WITH CHECK borne
  l'état résultant (INSERT/UPDATE) → un membre scopé ne peut ni muter/supprimer un compte hors
  scope, ni l'INSÉRER/déplacer hors scope. **PAS d'« exception ADMIN » dans la RLS** (la dette
  l'évoquait) : inutile et plus sûr ainsi — la RLS ignore le rôle, et l'ADMIN opère en Vision
  Globale (GUC vide → branche TRUE → tout passe). La garde « assignation ADMIN-only » reste
  **applicative** (futur `entites.ts`, L4). Backward-compat N-1 prouvée : ingestion (INSERT
  `entity_id=NULL`) et re-sync tournent en Vision Globale → neutres ; aucune régression sur 397
  tests. Tests d'écriture 14/14b/14c INVERSÉS (preuve : UPDATE sans WHERE ne mute que Sucrière ;
  déplacement hors scope lève 42501 ; INSERT NULL OK en Globale, refusé en Vision Entité).
  **Durcissement `categorisation.ts` NON inclus** (hors périmètre : la catégorisation masque
  déjà en lecture par la jointure #83 ; à rouvrir SI elle devient scopée en écriture). Reste
  HISTORIQUE ci-dessous :
  Effort S-M, gardien Backend. Ouvert 2026-06-22, **sévérité relevée par la cross-review
  sécu (contexte vierge)** : la formulation initiale « durcissement de la catégorisation »
  **sous-évaluait** le fait. La policy `entity_scope` est `FOR SELECT` uniquement → en
  Vision Entité, **l'ÉCRITURE sur `bank_accounts` n'est pas scopée du tout** (seul
  `tenant_isolation`/workspace gouverne). **Prouvé runtime** : un VIEWER scopé Sucrière
  exécutant `UPDATE bank_accounts SET … ` (sans WHERE) mute AUSSI les comptes Énergie +
  le compte non assigné ; un `INSERT` d'un compte assigné à Énergie (hors scope) réussit.
  ⚠️ **NUANCE (ce qui borne le risque)** : ce n'est PAS une fuite de **confidentialité** —
  `UPDATE/DELETE … RETURNING` ne renvoie que les lignes **visibles au SELECT** (donc
  in-scope) ; un `DELETE`/`UPDATE` ciblant une valeur d'Énergie renvoie `[]` et ne
  détruit/altère PAS la ligne hors scope. C'est un trou d'**intégrité/autorisation** (un
  membre borné peut altérer en masse des comptes qu'il ne devrait pas toucher), pas un
  oracle. **Non exploitable dans le socle L1→L2** : aucun chemin ne crée de Vision Entité
  (pas de repo `entites.ts`/`definirScopesMembre`), et l'assignation compte→entité est
  ADMIN-only (Vision Globale). À faire : policy `entity_scope` RESTRICTIVE FOR
  UPDATE/DELETE (USING+WITH CHECK honorant le scope, avec exception ADMIN explicite) sur
  `bank_accounts` ; ET borner l'écriture catégorisation (`categorisation.ts`) si elle
  devient scopée. **Déclencheur** : AVANT tout déploiement livrant un chemin d'écriture
  vers `member_entity_scopes` (cf. GATE d'activation ci-dessus). Couvert par le test
  « écriture VIEWER scopé hors périmètre » (assertion du comportement ACTUEL, à inverser
  quand la dette est levée). Raccroché au chantier « rôles Vision Entité » (ROADMAP §3).

- [ ] **ENTITY×ACCOUNT-DOUBLE-AXIS (P2 fonctionnel, PAS isolation) — l'AND des deux policies
  RESTRICTIVE masque un octroi party hors scope BU** — Effort S, gardien Backend. Ouvert
  2026-06-26, **repéré au cross-review L4** (PR #132, `feat/account-scope-l4`). Un membre cumulant
  `member_entity_scopes` (axe BU) ET `user_scopes` (party/compte) subit l'**AND** des policies
  `entity_scope` et `account_scope` (toutes deux RESTRICTIVE), **pas l'union** : un compte
  légitimement octroyé par party mais dont l'entité est HORS du scope BU du membre devient
  **invisible** pour lui. **Prouvé runtime** (cross-review) : `account_scope` résout bien l'union
  `{S1,H}` mais `entity_scope={ENT_S}` masque `H` (entity NULL) → visible = `{S1}`. **FAIL-CLOSED**
  (sous-ensemble du droit) → **AUCUNE fuite, aucun IDOR** ; c'est une dette FONCTIONNELLE (un
  octroi légitime est silencieusement nié), pas d'isolation. Le commentaire « account_scope
  subsume entity_scope » était trompeur (corrigé docs-only, même PR). **Résolution** : retrait
  d'`entity_scope` en L9 (une fois `account_scope` prouvé en prod) → dissout l'intersection ; OU
  interdire le double octroi côté UI (`entites.ts` : un membre est scopé BU **ou** party/compte,
  pas les deux). **Déclencheur** : activation d'un chemin d'écriture qui permet le double octroi,
  OU lot L9 (retrait `entity_scope`). Non bloquant pour le merge L4 (sûr).
  **Manifestation L5 — incohérence de maille FICHE ≠ FLUX** (repérée au cross-review L5, PR #133) :
  depuis 0017 les tables filles (transactions_cache/balance_history/transaction_categorizations) ne
  portent QUE `account_scope`, alors que la FICHE `bank_accounts` porte AUSSI `entity_scope`. Pour le
  membre double-axe, un compte octroyé par party mais à entité hors scope BU (ex. ACC_S2) est donc
  **masqué sur sa fiche** (intersection `account_scope ∩ entity_scope`) tout en laissant voir ses
  **flux** (les filles, `account_scope` seul) → oracle d'inférence UX BÉNIN (« des flux sans fiche »),
  toujours fail-closed, jamais d'IDOR (un compte hors des DEUX axes reste invisible partout). Couverte
  par le test de non-régression `tests/isolation/account-scope-double-axe-maille.test.ts` (qui ACTE le
  comportement actuel — fiche `{ACC_S1}`, flux `{ACC_S1,ACC_S2}`, ACC_H nulle part). **Résolution : L9**
  (le retrait d'`entity_scope` réaligne la maille fiche↔flux ; le test devra alors être inversé pour
  exiger ACC_S2 sur la fiche).

- [ ] **ENTITY-INGEST1 (P2) — pré-assignation automatique `compte → entité` à l'ingestion** —
  Effort S, gardien Backend. Ouvert 2026-06-22. Au MVP, un compte neuf naît `entity_id =
  NULL` (« non assigné », à trier dans le sas) — comportement voulu (l'humain tranche
  l'affectation). Cette dette = appliquer une règle de pré-assignation à la découverte
  (dépend des Parties, ENTITY-PARTY1, pour la source du mapping). L'upsert d'ingestion
  ne réécrase JAMAIS un `entity_id` déjà posé (invariant du socle, à préserver).
  **Déclencheur** : ENTITY-PARTY1 livrée. **NON une dette d'isolation.**

- [ ] **ENTITY-UI1 (P2, FRONTIÈRE FRONT) — pages admin Entités : référentiel, sas d'assignation, sélecteur de scope** —
  Effort M, **gardien Front**. Ouvert 2026-06-22. Le **Backend L3/L4 est livré** (repo
  `src/server/repositories/entites.ts` + Server Actions `src/app/(workspace)/admin/entites/actions.ts` :
  `creerEntiteAction`, `renommerEntiteAction`, `archiverEntiteAction`, `assignerCompteAction`,
  `definirScopesAction` ; tous ADMIN-only, contrats `EntiteLue`/`EtatAction`). Reste l'UI (calque
  `admin/membres/page.tsx` + `formulaire-provisioning.tsx`) : (1) liste des entités (`listerEntites`)
  + formulaires créer/renommer/archiver ; (2) **sas** « Comptes à assigner » listant `entity_id IS
  NULL` + picker d'entité par compte → `assignerCompteAction` ; (3) sélecteur multi-entités du
  périmètre d'un membre → `definirScopesAction` (cases à cocher `name="entityIds"`, vide = Vision
  Globale). Gating d'affichage : réservé ADMIN (la garde dure est déjà serveur). **Déclencheur** :
  ce chantier L3 mergé → l'UI devient le maillon manquant pour activer une Vision Entité en
  pratique. Ne touche ni l'isolation ni les montants (surface de rendu).

### Outillage migrations DB — db:migrate câblé + drift résolu (2026-06-19)

`/investigate` : `/transactions` plantait au runtime sur « relation "categories"
does not exist » (RSC `page.tsx:62` → `listerCategories` → `categorisation.ts:414`).
ROOT CAUSE = **drift de migration** : la base locale était restée à 0003/0004 ;
les migrations **0005 (Pilier 1 : categories, transaction_categorizations,
categorization_audit)** et 0006 n'avaient jamais été appliquées. Cause STRUCTURELLE :
**aucun script `db:migrate` n'existait** (db:generate générait les .sql, rien ne les
APPLIQUAIT) + la table de suivi `drizzle.__drizzle_migrations` n'existait pas (les
0000→0006 avaient été posées à la main). PGlite reconstruit tout le schéma → tests
verts, drift invisible en CI unitaire.

Corrigé (LOCAL prouvé) : 0005 appliquée (owner) + `db:provision` rejoué (GRANT/RLS
sur les 3 tables ; `categorization_audit` reste INSERT/SELECT seul, trigger
append-only 0005 OK). Requête exacte rejouée sous `tygr_app` + RLS → passe (0 row).
Outillage AJOUTÉ (`scripts/migrate.mjs` + `scripts/baseline-migrations.mjs`,
`db:migrate`/`db:baseline` dans package.json) : migrator Drizzle officiel + baseline
idempotent reproduisant à l'identique le format du suivi (sha256 du .sql brut,
schéma `drizzle`, created_at = `when` du journal). Pipeline `db:provision → db:migrate
→ deploy` enfin RÉELLE (avant : étape migrate fantôme, cf. commentaire provision.mjs:6).

- [ ] **DB-MIGRATE1 (P2, point de DÉPLOIEMENT) — baseline+migrate sur la base cloud** —
  Effort S, gardien Backend. ⚠️ **CORRIGÉ 2026-06-19** : il n'existe AUCUNE base Neon cloud
  aujourd'hui. `DATABASE_URL` ET `DATABASE_URL_ADMIN` pointent sur le Docker LOCAL
  (`tygr_postgres:5432` via `NEON_WSPROXY_LOCAL`) ; aucune URL `neon.tech`, aucun
  `.env.production`. « Neon » = juste le driver WebSocket. **La seule base réelle (Docker local)
  est DÉJÀ à jour** (fix appliqué). Donc rien à migrer maintenant. **Dépend du déploiement**
  (point 7 ROADMAP) : le jour où une instance cloud est créée, lancer `db:baseline` UNE FOIS
  (si base pré-existante) puis `db:migrate` — OU sur base NEUVE `db:migrate` direct (PAS de
  baseline) puis re-`db:provision` (GRANT DELETE liste-blanche, cf. #3bis). **Déclencheur** :
  création de l'instance cloud / 1er déploiement réel.
- [ ] **DB-MIGRATE2 (P2) — intégrer `db:migrate` à la CI bloquante** — Effort S. La
  pipeline canonique (CLAUDE.md règle 9 : lint→typecheck→tests→isolation→build→migrations)
  n'a pas d'étape migrate exécutée. Ajouter `db:provision && db:migrate` contre une base
  éphémère au CI pour ATTRAPER ce drift (un .sql généré mais jamais appliqué casserait
  alors le CI, pas le runtime). **Déclencheur** : mise en place du workflow CI/CD.
- [ ] **DB-MIGRATE3 (P2) — `0009_entity-write-scope` absente du journal Drizzle** —
  Effort S, gardien Backend. Découvert 2026-06-22 en générant la migration du moteur de
  règles (`db:generate` a numéroté `0009`, collision). Le fichier
  `drizzle/migrations/0009_entity-write-scope.sql` existe sur `main` (PR #85) mais n'a NI
  entrée dans `meta/_journal.json` NI `meta/0009_snapshot.json` — il a été posé « à la main »
  (comme les 0000→0006 historiques, cf. DB-MIGRATE1). Conséquence : l'état Drizzle est
  désynchronisé du disque ; un futur `db:generate` peut re-collisionner ou diffuser un
  snapshot incohérent. La suite d'isolation applique les `.sql` PAR NOM (pas via le journal)
  → l'exécution réelle est correcte (0009 puis 0010 s'appliquent), seul l'outillage Drizzle
  est en dette. **Contournement appliqué** (PR moteur de règles) : ma migration renommée
  `0010_categorization-rules` + journal à `idx:10` (le trou idx:9 reflète honnêtement le
  0009 hors-journal). **À faire** : régénérer un `meta/0009_snapshot.json` cohérent + entrée
  journal pour `0009_entity-write-scope` (ou rebaseliner proprement). **Déclencheur** :
  prochain `db:generate` qui touche le schéma, ou mise en place de DB-MIGRATE2.
  **NON une dette d'isolation** (n'affecte ni la RLS ni l'append-only — purement outillage).

### Page /transactions — câblée et opérationnelle (UI, 2026-06-17)

L'UI complète de `/transactions` (table dense, pagination, injection
SplitAllocationModal) est livrée ET câblée sur les vraies Server Actions Backend.
La réconciliation des contrats Backend↔UI vit dans
`src/app/(workspace)/transactions/adapter.ts` (statut MAJ→min, compteNom via map
comptes, curseur opaque string + hasMore, libellé non-PII).

- [x] **TX-B1 — `listerTransactionsAction` (lecture paginée + filtres)** — LIVRÉ
      (Backend, PR #45) + CÂBLÉ (PR à suivre). Pagination keyset, filtres
      `bankAccountId` + `statut`.
- [x] **TX-B2 — résumé de ventilation par ligne** — LIVRÉ + CÂBLÉ. Backend renvoie
      `statut` + `nbSplits` (PAS la catégorie unique nommée → l'UI affiche un badge
      de comptage générique « 1 catégorie » / « N catégories »).
- [x] **TX-B3bis — `listerSplitsAction`** — LIVRÉ (Backend) + CÂBLÉ. LÈVE une
      exception en cas d'échec (≠ `[]` faussement vide) ; le conteneur try/catch et
      BLOQUE l'ouverture de la modale (alerte « Erreur de chargement ») —
      anti-écrasement des splits. Vérifié au Visual QA (ligne t5 de la démo).

Dettes ouvertes héritées du câblage :

- [ ] **TX-FILTRE1 (P2) — filtre Sens (Entrées/Sorties) absent** — Effort S
      (gardien Backend). Le schéma de lecture (`listerTransactionsSchema`, `.strict`)
      n'a pas de champ `sens`/`creditDebit` ; le segmented control Sens a donc été
      RETIRÉ de la toolbar v1 (le filtrer côté client casserait la pagination —
      pages tronquées). **Déclencheur** : première demande utilisateur de filtrer
      entrées/sorties. Backend ajoute `sens` au schéma + au WHERE (colonne
      `credit_debit` indexable) ; l'UI ré-active le segmented (commenté dans
      `transactions-toolbar.tsx`) + le champ `FiltresTransactions.sens` + le mapping
      dans `adapter.ts:versInputBackend`.
- [ ] **TX-BADGE1 (P2) — nom de la catégorie unique sur la ligne** — Effort S
      (gardien Backend). Quand `nbSplits===1`, la liste affiche « 1 catégorie »
      générique faute du nom (B2 ne renvoie pas `categorie {id,name}`). **Déclencheur** :
      retour UX « je veux voir la catégorie sans cliquer ». Backend enrichit la ligne
      du `categoryId`/`categoryName` quand il n'y a qu'un split ; l'UI peuple alors
      `TransactionListItem.categorie` (déjà prévu au type) → `CategoryBadge` nommé.
      **Re-confirmé par clawdy (2026-07-01)** : souhait explicite d'afficher le **nom +
      un badge** de la catégorie au lieu du **compteur** « 1 catégorie ». C'est
      exactement ce ticket ; le bug QA remonté sous l'étiquette « TX-QA-CAT-BADGE1 » y
      est **absorbé** (pas de doublon, règle 9). Recoupe aussi la partie « afficher le
      nom + corriger l'accord pluriel » de **QA-UX-CATEG-COHERENCE1**.
- [ ] **TECH-DASHBOARD-CASCADE (P2) — aligner la table du DASHBOARD sur la cascade de
      libellé de `/transactions`** — Effort M (gardien Backend + Front). Date 2026-06-23.
      La cascade intelligente (marchand → catégorie FR → brut bancaire → repli) +
      l'anti-doublon + l'infobulle `title` (libellé bancaire d'origine au survol) ont
      été livrés UNIQUEMENT sur `/transactions` (`feat/prod-merchant-cascade`). Le
      dashboard (`components/dashboard/transactions-table.tsx`) reste volontairement en
      mode HISTORIQUE `cascade={false}` (marchand → repli) parce que (1) son DTO
      `TransactionRecente` (`server/repositories/dashboard.ts`) ne porte PAS encore
      `bankLabelRaw` — l'ajouter touche le repository dashboard (gardien Backend, à
      re-scoper côté sécu/perf de la requête) ; (2) sa colonne **Catégorie est fixe**
      (grille `grid-cols`), donc l'anti-doublon de `/transactions` (sous-texte
      optionnel masquable) n'y est pas transposable tel quel — il faut repenser la
      colonne. **Déclencheur** : prochaine itération UX du dashboard, ou retour « le
      dashboard et la page transactions n'affichent pas le même libellé pour la même
      opération ». Travail : étendre `TransactionRecente` (+ SELECT) avec `bankLabelRaw`,
      passer `cascade` (défaut) + `categorieFr` + `bankLabelRaw` au `LibelleTransaction`
      du dashboard, et arbitrer le sort de la colonne Catégorie (la masquer par ligne
      quand elle devient le libellé, ou la conserver et accepter le rappel).

Aucune de ces dettes ne touche l'isolation tenant / l'append-only / les montants.
Plan de référence : `PLAN-transactions-page.md`.

### Bugs QA /transactions relevés par clawdy (2026-07-01)

Passe QA visuelle de la page `/transactions` et de la modale de ventilation par clawdy.
Constats d'**ergonomie / affordance / layout** — aucun ne touche l'isolation tenant,
l'append-only ni les montants (sinon corrigé immédiatement, pas consigné). Bugs de fond
sur la catégorie (compteur au lieu du nom, filtre Sens) déjà tracés ailleurs :
**TX-QA-CAT-BADGE1** est absorbé par **TX-BADGE1** (ci-dessus, re-confirmé le 2026-07-01)
et n'est donc PAS ré-ouvert ici (règle 9). Fichiers cités vérifiés en lecture seule.

- [ ] **TX-QA-CURSOR1 (P2) — `cursor: pointer` absent au survol des boutons cliquables**
      — Effort S (gardien Front). Date 2026-07-01. Les éléments cliquables du picker de
      catégorie et de la modale de ventilation n'exposent **aucun** `cursor-pointer` : au
      survol, le curseur reste une flèche → l'utilisateur ne perçoit pas qu'ils sont
      cliquables. Vérifié : les seuls `cursor-*` présents sont des `disabled:cursor-not-allowed`
      (état désactivé). Éléments concernés (tous SANS `cursor-pointer`) : options de
      catégorie et « + Ajouter une catégorie » (`src/components/ui/category/category-picker.tsx:203`,
      `:282`), boutons Créer / Annuler (`category-picker.tsx:324`, `:335`), boutons de la
      modale de ventilation ouvrir/valider/ajouter/retirer/« catégoriser le reste »
      (`src/components/ui/category/split-allocation-modal.tsx:199`, `:207`, `:378`, `:394`,
      `:407`), « Charger plus » et fermeture d'erreur (`src/components/transactions/transactions-feature.tsx:209`,
      `:260`), archiver une catégorie (`src/components/ui/category/category-manager-modal.tsx:234`),
      croix de fermeture de modale (`src/components/ui/modal/modal.tsx:140`). **Exception** :
      la LIGNE du tableau (`<tr>`) porte déjà `cursor-pointer` (`transaction-row.tsx:90`) —
      elle n'est pas concernée. **Déclencheur** : cette passe QA (affordance des contrôles).

- [ ] **TX-QA-CREER-CAT-OVERFLOW1 (P2) — le bloc « créer une catégorie » déborde de son
      conteneur (bouton « Annuler » qui dépasse)** — Effort S (gardien Front). Date
      2026-07-01. Dans le picker de catégorie, le mode déplié de création aligne sur UNE
      seule rangée un `<input>` + les boutons « Créer » et « Annuler » via un
      `flex items-center gap-2`, sans `flex-wrap` ni contrainte de rétrécissement sur le
      champ ; dans la largeur étroite du popover, l'ensemble déborde et « Annuler » sort du
      cadre. Fichier probable : `src/components/ui/category/category-picker.tsx:296-346`
      (conteneur `flex` ligne 298, `input flex-1` ligne 320, boutons lignes 324 et 335).
      **Déclencheur** : cette passe QA (layout du bloc de création inline).

- [ ] **TX-QA-FILTRE-CAT1 (P2) — filtre par catégorie absent sur `/transactions`** —
      Effort S (gardien Front). Date 2026-07-01. La toolbar propose Compte, Statut de
      ventilation et bornes de date, mais **aucun filtre par catégorie** ; l'utilisateur
      demande de pouvoir restreindre la liste à une catégorie donnée. Fichier :
      `src/components/transactions/transactions-toolbar.tsx` (aucun select catégorie). À
      distinguer de **TX-FILTRE1** (filtre *Sens* Entrées/Sorties), qui est un besoin
      différent : ici il s'agit bien de la CATÉGORIE. NB (lecture seule, non tranché) : le
      schéma de lecture Backend (`listerTransactionsSchema`, `.strict`) ne porte pas non
      plus de champ catégorie aujourd'hui — un filtrage purement client casserait la
      pagination keyset (même piège que TX-FILTRE1), à arbitrer au moment de l'implémentation.
      **Déclencheur** : cette demande utilisateur de filtrer par catégorie.

- [x] **TX-QA-SPLIT-DOUBLON1 (P1) — deux splits sur la MÊME catégorie autorisés sur une
      transaction ventilée** — ✅ LIVRÉ (branche `feat/tx-split-doublon`, 2026-07-01). Garde
      SERVEUR canonique `CategorieDupliqueeError` (code `CATEGORY_DUPLICATE_IN_SPLIT`) dans
      `remplacerSplits`, insérée AVANT le bloc somme (ordre « doublon d'abord » verrouillé par
      un test dédié : payload 900+200 sur la même catégorie → CategorieDupliquee, PAS
      VentilationDepasse). Défense en profondeur : `.superRefine` d'unicité sur
      `remplacerSplitsSchema` + gating UI (`lignesEnDoublon` pur, marquage `danger` +
      `role="alert"` + « Valider » désactivé). Invariant de somme INCHANGÉ (ajout only).
      Tests : +4 isolation (rejet, contrôle distinct, ordre, non-régression atomicité) avec
      fixture `CAT_A2`, migration chirurgicale des cas de somme (categoryId seul modifié,
      montants/seuils intacts) ; +5 unitaires `lignesEnDoublon`/`peutValider`. Suite complète
      785/785 verte, typecheck+lint+build OK, Visual QA du gating concluant. Effort S/M
      (gardien Backend + Front). Date 2026-07-01.
      Reproduit par clawdy : on peut affecter DEUX parts de ventilation à la même catégorie
      sur une même transaction. Aucun sens métier (fausse tout regroupement par catégorie).
      **Décision clawdy 2026-07-01 : INTERDIRE** (erreur à la validation), **pas** de fusion
      automatique des montants. Garde **REQUISE côté SERVEUR** — la ventilation est écrite par
      `remplacerSplits` (état cible complet, tout-ou-rien), qui est la vérité : une garde UI
      seule est contournable par appel direct de la Server Action. Poser le rejet des
      catégories en double dans le repository, à côté de l'invariant de somme existant
      (`src/server/repositories/categorisation.ts:298` `remplacerSplits`, étape 2 validation
      de l'état cible ; lève actuellement `VentilationDepasseError` — prévoir une erreur
      nommée dédiée, ex. `CategorieDupliqueeError`), et/ou dans le schéma
      (`src/lib/categorisation-schema.ts:66` `remplacerSplitsSchema`, `.array().max(50)`
      sans contrainte d'unicité aujourd'hui). Idéalement AUSSI une erreur inline UI en amont
      (« catégorie déjà utilisée ») dans `src/components/ui/category/split-allocation-modal.tsx`
      pour ne pas amener l'utilisateur jusqu'au rejet serveur. Touche la ventilation → **test
      d'isolation du cas attendu** (2 splits même catégorie → rejet). NB : ce n'est **pas** une
      dette d'isolation tenant / append-only / montants (qui se corrigeraient immédiatement) —
      c'est une **règle d'intégrité de ventilation**. Marqué **P1** car bug de **données**, pas
      du polish. **Déclencheur** : cette passe QA (intégrité de la ventilation).

- [x] **TX-QA-SPLIT-MAX1 (P2) — bouton « Tout le reste » / « Max » pour remplir le montant
      restant d'un split** — ✅ LIVRÉ (branche `feat/tx-split-max`, 2026-07-01). Chaque ligne
      de la modale de ventilation porte un lien « Tout le reste » qui met SON montant = montant
      restant à ventiler, en un clic (fini la saisie manuelle du chiffre exact). Helper PUR
      `montantPourLeReste(montantTotal, lignes, cleLigne)` dans `allocation.ts` : calcul 100 %
      centimes (BigInt, règle 8, aucun float), il EXCLUT la contribution actuelle de la ligne
      (`total − sommeDesAUTRESlignes`) sinon on sous-compterait ; renvoie `null` si ≤ 0 (ligne
      déjà couverte par les autres OU dépassement) → bouton MASQUÉ, jamais de négatif injecté.
      Distinct de `categoriserLeReste` (qui, lui, crée une NOUVELLE ligne). Décision produit :
      autorisé même SANS catégorie choisie (remplit juste le montant ; `peutValider` garde le
      blocage à l'envoi). Gardes #157 (doublon) et invariant de somme intacts — c'est de l'aide
      à la saisie, la validation serveur reste la vérité. Tests : 8 cas ajoutés dans
      `tests/unit/allocation.test.ts` (reste positif, exclusion de la contribution courante,
      décimales exactes, reste 0 → null, dépassement des autres → null, sans catégorie).
      Visual QA `/demo/transactions` : clic remplit au centime près, reste tombe à 0 ; ligne
      couverte / dépassement → bouton off. **Déclencheur** : cette passe QA.

### Findings QA nav + Empty States (UI, 2026-06-17)

- [x] **Routes `/demo/*` redirigées vers `/login` (P1, sécurité/routing)** —
  ✅ RÉSOLU (PR #43, vérifié 2026-06-26). Le matcher `src/proxy.ts:41` exclut
  désormais `demo` de l'allowlist (`(?!login|api/auth|demo|_next/...)`) → `/demo/*`
  est PUBLIC (décision PO + QA B-1 : bac à sable sans DB/auth, n'expose rien). Le
  Visual QA Gate 4 fonctionne. [Audit backlog 2026-06-26 : entrée jamais cochée.]
- [ ] **Empty State de section : débordement header mobile 375px (P2, UI démo)** —
  relevé par /qa 2026-06-17. Effort S. Le chrome reconstitué EN DUR de
  `/demo/dashboard-states` (pas le vrai shell) casse à 375px : badge « Démo · Visual
  QA » sur 3 lignes, nav qui déborde (« Transactions » coupé). **Déclencheur** :
  chantier responsive / TODO P2 UI-ES1. Hors production, n'affecte que la capture.
- [ ] **Header applicatif (`AppHeader`) non responsive — déborde < ~1100px (P2, UI)** —
  relevé au Visual QA du CTA banque, 2026-06-19. Effort M. Le VRAI header
  (`src/components/shell/app-header.tsx`) aligne logo + nav + switcher + CTA + Membres
  + déconnexion en flex SANS `flex-wrap` ni menu hamburger : il débordait DÉJÀ avant ce
  travail (mesuré 471px > 375px viewport mobile, header seul). Le nouveau CTA permanent
  « Connecter une banque » (label long) AGGRAVE la magnitude (→ 925px à 375px) sans
  créer le problème. **Desktop ≥1280px : aucun débordement (parcours FM réel OK).**
  Contexte produit : TYGR cible des Financial Managers en usage desktop ; le mobile
  n'est pas un parcours prioritaire et n'a aucune stratégie responsive à ce jour.
  **Déclencheur de résolution** : premier chantier responsive du shell (menu condensé /
  hamburger < md, ou CTA réduit à une icône `+` seule sur petit écran). Hors périmètre
  de la tâche CTA (refonte responsive = surface nav/switcher large). Signalé à l'humain
  dans la note de PR.
- [ ] **Tableaux dashboard (`MonthlyCashflow` + `TransactionsTable`) débordent < ~430px (P2, UI)** —
  relevé au Visual QA de la PR « dashboard insights » (2026-06-24). Effort S. Mesuré au
  DOM à 390px : `table.w-full` (Évolution mensuelle, en-têtes Mois/Entrées/Sorties/Variation,
  right=475) et l'en-tête « Montant » de `TransactionsTable` (right=508) dépassent le
  viewport → scroll horizontal de page. **PRÉEXISTANT** : ces deux composants ne sont PAS
  modifiés par la PR insights (diff DOM le confirme — mes composants `CashflowMainChart`,
  `CashFlowSummary`, `TopVendorsCard` ne débordent pas, leurs grilles passent en 1 colonne
  sous `sm:`). Même famille et même déclencheur que la dette `AppHeader` ci-dessus : desktop
  ≥1280px sain (parcours FM réel), mobile non prioritaire. **Déclencheur** : premier chantier
  responsive du shell (les tableaux denses passeront en scroll-x encapsulé `overflow-x-auto`
  ou en cartes empilées sous `md`). Signalé à l'humain dans la note de PR.
- [ ] **DASH-CASHFLOW-MULTISERIE — la courbe de flux n'affiche qu'UNE devise (P2, UI/data)** —
  ouvert 2026-06-24 (PR « dashboard insights »). Effort M. `cashflowParDevise` renvoie le
  flux net par (mois, devise) ; la page (`(dashboard)/page.tsx`) filtre sur `base_currency`
  pour rester mono-série (`flux.points.filter(p => p.currency === deviseBase)`). Conséquence :
  un workspace dont les flux sont MAJORITAIREMENT dans une devise ≠ base_currency verra une
  courbe vide (état « partiel ») alors que des transactions existent — les SOLDES et la
  SYNTHÈSE (ventilée, non filtrée) restent affichés, donc pas de perte de donnée, juste la
  courbe muette. **Déclencheur** : premier workspace réellement multi-devise actif en démo.
  Résolution : courbe multi-série (une ligne/devise) ou sélecteur de devise au-dessus de la
  carte. Aucune addition cross-devise (DASH-FX1 reste interdit).
- [ ] **DASH-COURBE-SOLDE-EOD — réintroduire la vue « solde » quand l'API livrera l'historique (P2, data)** —
  ouvert 2026-06-24. Effort M. La courbe consommait `courbeTresorerie` (`balance_history`),
  remplacée par le flux net (`cashflowParDevise`) car `balance_history` est VIDE en Staging
  (Omni-FI n'expose pas `/balances/history`, cf. DASH-SOLDE2 / INSIGHTS-AMONT1). `courbeTresorerie`
  + `PointCourbe` sont CONSERVÉS dans `dashboard.ts` (non supprimés) mais ne sont plus appelés.
  **Déclencheur** : passage 501→200 de `/balances/history` côté Omni-FI. Résolution : décider
  d'une vue « solde EOD » à côté de la vue « flux » (onglet/toggle), ou retirer définitivement
  `courbeTresorerie` si le solde reste hors périmètre.
- [ ] **DASH-VENDORS-DIRECTION — figer/déverrouiller le sens du panneau Top contreparties (P2, UI)** —
  ouvert 2026-06-24. Effort S. `TopVendorsCard` est câblé en dur sur `direction: "outflow"`
  (dépenses) ; `vendorsParConcentration` supporte aussi `inflow` et `both` (le composant gère
  déjà les 3 libellés). **Déclencheur** : retour utilisateur demandant à voir les recettes.
  Résolution : toggle inflow/outflow/both au-dessus du panneau (state client + re-fetch via
  Server Action dédiée, ou pré-charger les 3 sens côté RSC).

### Refonte lisibilité Dashboard (UI, 2026-06-19)

Travail UI livré (branche `feat/ui-dashboard-refactor`) : bouton de re-synchro
renommé « Synchroniser mes comptes » (+ icône ↻) dans `bank-connect-widget.tsx` ;
carte « Comptes connectés » préparée à afficher la PROVENANCE bancaire (contract-first).
Reste deux dettes à la frontière Backend :

- [x] **DASH-INST1 (P1) — persister le nom d'institution (`institution_name`)** —
  ✅ **LIVRÉ 2026-06-19 (Backend, branche `feat/ingestion-institution-name`)**. Les 3
  étapes faites : (1) migration `0006_add-institution-name.sql` (`institution_name`
  varchar(140) nullable, expand-safe) ; (2) ingestion persiste
  `normaliserNomInstitution(conn.InstitutionName)` via `upsertConnexion` (+ rafraîchi
  au `onConflictDoUpdate`) ; (3) `listerComptes` joint `bank_connections` (innerJoin,
  `connection_id` NOT NULL) → `CompteConnecte.institutionName`. Nuance : à la
  finalisation widget (`link-exchange` ne renvoie pas `InstitutionName`) on insère
  `null` ; le nom est renseigné au prochain `ingererConnexions` (GET /connections).
  Fonction pure `normaliserNomInstitution` (trim/null/troncature) + 5 tests. Reste
  HISTORIQUE ci-dessous :
  relevé 2026-06-19, effort M, **gardien Backend**. L'API Omni-FI FOURNIT
  `OmniFiConnection.InstitutionName` (`server/omnifi/types.ts:56`) mais l'ingestion
  (`server/ingestion/index.ts:55` → `upsertConnexion`) ne le persiste PAS : la table
  `bank_connections` n'a que `institution_id` (ID opaque), aucune colonne nom. La carte
  comptes affiche donc « Compte courant » sans la banque. **Côté UI c'est PRÊT**
  (`connected-accounts-card.tsx` : type `CompteAffiche` + `libelleCompte`, dégradation
  propre si absent — affiche « Absa · Compte courant » dès que la donnée arrive, zéro
  retouche UI). **À faire (Backend)** : (1) migration expand `bank_connections.institution_name`
  (varchar, nullable) ; (2) ingestion persiste `conn.InstitutionName` ; (3) `listerComptes`
  (`repositories/dashboard.ts`) jointure `bank_connections` → expose `institutionName`
  dans `CompteConnecte`. **Déclencheur** : cette demande produit (lisibilité provenance,
  2026-06-19) → DÛ. Ne touche PAS l'append-only/montants ; touche le contrat de lecture.
- [x] **DASH-DEDUP1 (P2, investigation) — doublons de comptes signalés en UI** —
  ✅ **AUDITÉ + PROUVÉ 2026-06-19 (Backend, même branche)**. Verdict : l'upsert compte
  est correct — `onConflictDoUpdate({ target: omnifi_account_id })` met à JOUR au lieu
  d'insérer. Plus qu'une présomption : un **test d'isolation dédié** prouve sur PGlite
  qu'un même `omnifi_account_id` re-découvert via une connexion DIFFÉRENTE ne crée
  qu'UNE ligne `bank_accounts` (le 2e upsert rafraîchit libellé/solde). Aucun doublon
  possible au niveau données. SI un doublon réapparaît en UI : ce serait un compte avec
  un `omnifi_account_id` réellement distinct côté Omni-FI (à investiguer alors avec
  capture). Reste HISTORIQUE ci-dessous :
  relevé 2026-06-19, effort S (investigation), gardien Backend. Une demande produit
  évoquait des comptes dupliqués à l'écran. **Analyse UI** : impossible par construction
  côté données — `bank_accounts.omnifi_account_id` est `UNIQUE` (`schema.ts:228`) et
  `upsertCompte` fait `onConflictDoUpdate` sur cette colonne (`repositories/ingestion.ts:112`) ;
  la carte utilise la PK UUID `bankAccountId` comme `key` React. **Décision (PO, 2026-06-19)** :
  NE PAS ajouter de dedupe côté React — il masquerait un éventuel bug d'ingestion au lieu
  de le corriger (anti-pattern). **À faire SI le symptôme se reproduit** : capture + contexte,
  puis investiguer l'ingestion (deux `bank_accounts` distincts pour le même compte réel ?
  `isSelected` mal posé ?). Pas d'action UI. **Déclencheur** : nouvelle observation de doublon
  avec preuve.
- Note : afficher la banque PAR LIGNE de transaction (table dashboard 4 colonnes serrées)
  a été ÉCARTÉ — la provenance vit dans la carte comptes (plus lisible), et `TransactionRecente`
  ne porte pas le nom (que `bankAccountId`). À rouvrir avec DASH-INST1 si besoin produit.
- [ ] **UI-ACCOUNTS-ACCORDEON-ENTITE1 (P2, effort M — Front, DÉPEND d'ENTITY-PARTY1) —
  la carte « Comptes connectés » est trop longue (77 comptes réels → scroll massif) ;
  la grouper en ACCORDÉON PAR ENTITÉ (repliable) et afficher le nom d'ENTITÉ.** Composant
  `src/components/dashboard/connected-accounts-card.tsx`. ⚠️ **DÉPENDANCE DURE** :
  grouper/nommer par entité EXIGE `bank_accounts.entity_id` peuplé → c'est exactement
  **ENTITY-PARTY1** (pont Party→entities→entity_id). Tant que les comptes sont
  `entity_id=NULL`, rien à grouper. DOWNSTREAM d'ENTITY-PARTY1 (+ ENTITY-UI1 pour
  créer/assigner, + QA-ENTITES-CREATION-UI1). ⚠️ **DÉCISION PRODUIT** (ne pas trancher en
  silence) : DASH-INST1 / DR-F2 / TX-PROVENANCE2 exposaient le nom de la BANQUE
  (`institutionName`) ; ici clawdy veut le nom d'ENTITÉ. Reco archi (clawdy 2026-07-02) :
  entête d'accordéon = ENTITÉ, mais garder la BANQUE en secondaire par ligne (sinon on
  perd « ce compte est chez MCB vs Absa »). Recoupe UI-PERIMETRE-ACCORDEON1 (même
  mécanique accordéon) mais AXE et composant différents. Isolation : rendu seulement, mais
  le groupement doit rester borné au scope entité du membre (RLS + jointure #83 /
  ENTITY-READ-JOIN1) — jamais d'entête d'entité hors scope. **Déclencheur** : ENTITY-PARTY1
  livrée ; le scroll est déjà là (77 comptes réels en prod).

### Solde Total dérivé des soldes courants, par devise (2026-06-19)

Le « Solde Total » du dashboard était à 0 et la courbe bloquée sur « en cours de
synchronisation » parce que TOUT dépendait de `balance_history`, VIDE (sa seule source
`/balances/history` est 404 chez Omni-FI, cf. §10). Décision PO (2026-06-19) : dériver le
Solde Total des **soldes courants** (`bank_accounts.current_balance`, bien remplis), **par
devise** (multi-devises, jamais d'addition cross-devise).

- [x] **DASH-SOLDE1 (Backend) — `soldesCourantsParDevise`** — ✅ LIVRÉ
  (branche `feat/dashboard-solde-multidevise`). `repositories/dashboard.ts` : nouvelle
  fonction (somme `current_balance` GROUP BY devise, SQL/numeric, comptes sélectionnés) +
  type `SoldeParDevise { currency, total }`. Indépendant de `balance_history`. 2 tests
  d'isolation (multi-devises MUR+USD, source = current_balance).
- [x] **DASH-SOLDE2 (P1, FRONTIÈRE FRONT) — câbler le Solde Total par devise dans l'UI** —
  ✅ **LIVRÉ + MERGÉ** (Front). Câblage initial **PR #69** (`feat(dashboard): câble le Solde
  Total par devise dans l'UI (DASH-SOLDE2)`, commit `5cb6115`) puis raffiné au **Lot 2 — PR #79**
  (`feat(dashboard): carte SOLDE hybride + pastille de fraîcheur`, commit `4e9e8b0`).
  `(dashboard)/page.tsx:80` appelle `soldesCourantsParDevise(tx)` et passe `SoldeParDevise[]`
  à `SidePanelKpi` ; `side-panel-kpi.tsx` rend une **ligne par devise** (mono → gros montant
  28px/700 `primary` ; multi → `SoldesMultiDevises`, pile égalitaire à virgules décimales
  alignées, grille `[auto_1fr]`), tout en `tabular-nums`, via `formatMontant` (chaînes, zéro
  float). Jamais d'addition cross-devise. Bonus inclus : la méta trompeuse « au JJ/MM »
  (anti-pattern DR-F3) est remplacée par la pastille de fraîcheur sur `lastSyncedAt`.
  L'ancien `soldeConsolide: string` ne sert plus qu'à la COURBE (EOD historique,
  `cashflow-main-chart.tsx`). **Case cochée 2026-06-22** (le code était en `main`, seule la
  case du registre restait ouverte). Reste HISTORIQUE ci-dessous :
  Effort S, **gardien Front**. La carte « SOLDE » (`dashboard-content.tsx` / le KPI haut)
  consomme aujourd'hui `soldeConsolide: string` (un montant unique = 0). À remplacer par la
  consommation de `soldesCourantsParDevise(tx)` → afficher une ligne par devise (« 8 074 400
  MUR » + « 179 200 USD »), `tabular-nums`. La page (`(dashboard)/page.tsx`) doit appeler la
  nouvelle fonction et passer `SoldeParDevise[]` au composant. **Déclencheur** : merge de
  DASH-SOLDE1. Backend prêt (contract-first) ; Front câble le rendu.
- [ ] **DASH-FX1 (P2) — conversion FX vers `base_currency` (un seul « Solde Total »)** —
  Effort M, gardien Backend. Pour afficher UN chiffre consolidé (pas une ligne par devise),
  il faut convertir USD/EUR → MUR (`base_currency` du workspace) avec un **taux + date
  annotés** (CLAUDE.md : conversion FX annotée, jamais de float). EXIGE une source de taux
  (table de taux, API FX). **Déclencheur** : besoin produit d'un total unique cross-devise.
  Tant qu'absent, l'affichage par devise (DASH-SOLDE2) est la voie correcte — aucun taux
  inventé.

### Challenge intégrité/mapping des données (2026-06-22, investigation)

Trois constats remontés (« 0,00 Rs », « tout en Rs », « Main Operating Account » au lieu
de la banque). Diagnostic ci-dessous ; deux corrections Backend livrées
(`syntheseMoisParDevise`, provenance dans `listerTransactions`), le reste tracé.

- [x] **DASH-WSACTIF1 (P1, FRONTIÈRE FRONT/SESSION) — le dashboard lit le MAUVAIS workspace → « 0,00 Rs »** —
  ✅ RÉSOLU (PR #94, vérifié 2026-06-26). Les DEUX correctifs demandés sont en place :
  (1) **workspace par défaut = le plus peuplé en comptes** — `membershipParDefaut`
  (`identite.ts:228-247`) compte les `bank_accounts` par workspace et retourne le gagnant
  (repli déterministe par nom à égalité), au lieu du 1er par UUID ; câblé au login
  (`auth/config.ts:87`). (2) **sélecteur de workspace visible** —
  `components/shell/workspace-switcher.tsx` (100 l.) monté dans `app-header.tsx:51`, câblé
  sur l'action `basculerWorkspace`. L'utilisateur n'atterrit plus sur « Omni-FI HQ » vide.
  [Audit backlog 2026-06-26 : entrée jamais cochée.]
- [x] **DASH-CASHFLOW-DEVISE1 (Backend) — `syntheseMois` sommait cross-devise (« tout en Rs »)** —
  ✅ LIVRÉ. `syntheseMois` additionnait `amount` MUR+USD sans GROUP BY → la carte Cash In/Out
  affichait un total mélangé dans la base_currency (faux dès qu'un workspace a plusieurs devises).
  Ajout de **`syntheseMoisParDevise`** (GROUP BY currency, renvoie `currency`), `syntheseMois`
  conservé @deprecated le temps de la migration Front. Prouvé en isolation (MUR/USD séparés).
- [x] **DASH-CASHFLOW-DEVISE2 (P1, FRONTIÈRE FRONT) — câbler `syntheseMoisParDevise` dans l'UI** —
  ✅ RÉSOLU (PR #115, vérifié 2026-06-26). `cash-flow-summary.tsx:34` reçoit
  `SyntheseMoisDevise[]` (une entrée par devise) et itère `BlocDevise key={s.currency}`
  (`:53`) ; alimenté par `page.tsx:105` (`syntheseMoisParDevise`). `syntheseMois` (déprécié)
  n'est plus consommé par l'UI. Convention multidevise respectée (un bloc par devise, pas
  d'addition cross-devise). [Audit backlog 2026-06-26 : entrée jamais cochée.]
- [x] **TX-PROVENANCE1 (Backend) — exposer le nom d'institution par transaction** —
  ✅ LIVRÉ. `listerTransactions` joint désormais `bank_accounts` + `bank_connections` et expose
  `accountName` + `institutionName` sur `TransactionLigne` (la colonne vit sur
  `bank_connections.institution_name`, PAS `bank_accounts` comme supposé). Bonus : la jointure
  `bank_accounts` fait hériter le scope entité (ENTITY-READ-JOIN1).
- [ ] **TX-PROVENANCE2 (P2, FRONTIÈRE FRONT) — afficher la banque dans la table /transactions** —
  Effort S, gardien Front. La table montre `account_name` (« Main Operating Account ») ; l'adapter
  (`transactions/adapter.ts`) peut maintenant remplir `compteNom` avec `institutionName`
  (« Bank One ») ou l'afficher en sous-texte, la donnée étant exposée par ligne. **Déclencheur** : ce ticket.

### Synchronisation automatique des soldes/transactions (2026-06-19)

À la connexion (Finish → `finaliserConnexionDropinAction`), les COMPTES sont déjà rattachés
auto (découverte `/accounts`). Le bouton « Synchroniser mes comptes »
(`synchroniserConnexionsDepuisOmnifi`) ingère désormais AUSSI les **transactions** de chaque
compte (pagination par page → `upsertTransactions`), ce qui remplit Détails + Transactions
récentes (livré 2026-06-19, branche `feat/dashboard-solde-ui`). Restent automatisation +
soldes EOD :

- [ ] **DASH-AUTOSYNC2 (P2) — ré-ingestion globale à chaque clic** — Effort S, gardien
  Backend. `synchroniserConnexionsDepuisOmnifi` ré-ingère les transactions de TOUS les
  comptes `is_selected` du workspace à chaque appel (pas seulement les connexions
  nouvellement ajoutées) → coût API qui croît avec le nombre de comptes. Acceptable au MVP
  (idempotent, volumes faibles). **Déclencheur** : nombreux comptes en prod / plainte de
  lenteur. Piste : ne synchroniser que les comptes des connexions touchées, ou borner par
  `lastSyncedAt` (skip si récent).
- [ ] **DASH-AUTOSYNC1 (P1) — synchro auto en arrière-plan** — Effort M-L, gardien Backend.
  Éviter que l'utilisateur doive cliquer « Synchroniser » après chaque ajout de banque.
  Pistes : (a) **cron Inngest** périodique (déjà au stack) qui rejoue
  `synchroniserConnexionsDepuisOmnifi` + `synchroniserCompteComplet` par workspace ; (b)
  **webhook Omni-FI** (si disponible) déclenchant la synchro sur événement amont ; (c)
  déclenchement **post-Finish** (enchaîner une synchro légère après finalisation). Contraintes
  NON négociables : rate-limit amont (`sync` 1/15min/connexion, CLAUDE.md), idempotence
  (upserts déjà idempotents), isolation tenant (`withWorkspace`), pas de PII en log. **À
  concevoir dans un chantier dédié** (scheduling + observabilité), PAS dans une PR de feature.
  **Déclencheur** : DÛ pour un MVP production (sinon données « figées » entre deux clics
  manuels). Lié à OMNIFI_API_FEEDBACK.md (la voie curseur `/sync` aiderait pour les deltas).

### Purge locale des données de démo (runbook dev, 2026-06-19)

Question récurrente : « comment repartir d'une base ne contenant QUE mes connexions
manuelles ? ». Réponse : les 4 banques (Absa/Bank One/MCB/SBM) viennent de l'**EndUser
sandbox côté Omni-FI** (provisionné), pas de notre seed. Purger la base LOCALE est
possible, mais la prochaine synchro re-rapatrie tout ce que l'EndUser a côté Omni-FI (le
vrai « reset » serait un EndUser neuf côté Omni-FI, hors de notre portée).

Procédure de purge LOCALE (dev uniquement, JAMAIS en prod — `transactions_cache` est
append-only avec trigger ; on passe par l'owner pour contourner) :
```bash
# Dans le conteneur de validation, rôle owner (le trigger BEFORE DELETE bloque tygr_app) :
docker exec -i tygr_postgres psql -U tygr_owner -d tygr <<'SQL'
  -- ordre = enfants avant parents (FK) ; truncate cascade contourne l'append-only.
  TRUNCATE transactions_cache, balance_history, bank_accounts, bank_connections RESTART IDENTITY CASCADE;
SQL
# Puis re-synchroniser UNIQUEMENT les banques voulues via le widget / bouton.
```
NB : `TRUNCATE … CASCADE` par l'owner outrepasse le trigger `BEFORE DELETE` (qui ne se
déclenche pas sur TRUNCATE) — acceptable EN DEV seulement. En prod, l'effacement reste
logique (`is_removed`), jamais physique.

### Findings /design-review du Dashboard (UI, 2026-06-19)

Audit `--quick` du Dashboard contre `UI_GUIDELINES`/`DESIGN.md` (Visual QA headless
`/demo/dashboard`). **Verdict : Design A− / AI-Slop A** — dashboard propre, layout
asymétrique conforme, typo réelle (Instrument Sans/Geist), ZÉRO pattern slop. 3 findings
mineurs, AUCUN bloquant, NON corrigés (décision PO 2026-06-19 : tracer, le dashboard est
suffisant) :

> **PROGRAMMÉS (2026-06-22)** : DR-F1/F2/F3 sont raccrochés au chantier
> **`PLAN-audit-ergonomie-soldes.md`** (audit ergonomique soldes/totaux, plan validé
> humain le 2026-06-22, arbitrages §7 tranchés). Ils ne sont plus « un jour » mais
> assignés à un lot d'implémentation nommé (règle 9). **Avancement : DR-F3 livré au Lot 2
> (PR #79, mergée), DR-F1 + DR-F2 livrés au Lot 3+4 (branche `feat/lot3-4-polish-ui`).**
> Reste C8 (Lot 6, dette de formateurs de date) ci-dessous.

- [x] **DR-F1 (P2, medium) — catégories de transactions en ANGLAIS dans l'UI française** —
  ✅ **LIVRÉ 2026-06-22** (branche `feat/lot3-4-polish-ui`, Lot 3). Table de correspondance FR
  **côté affichage** : `src/lib/categories-fr.ts` (`categorieFr`, fonction pure) mappe la
  `primaryCategory` OBIE (`Income`→« Revenus », `Utilities`→« Charges », `Rent`→« Loyer »,
  `Insurance`→« Assurances », `Taxes`→« Taxes », `Payroll`→« Salaires », `Banking & Finance`/
  `Bank Charges`→« Frais bancaires »), fallback « Non catégorisé » pour toute clé inconnue/nulle
  (filet anti-anglais). Appliquée dans `components/dashboard/transactions-table.tsx`. Couverture :
  `tests/unit/categories-fr.test.ts` (6 cas, bornes incluses). Visual QA `/demo/dashboard` :
  colonne CATÉGORIE = Revenus/Charges/Loyer, 0 anglais. Catégorie localisée côté service
  REPORTÉE (dette tracée, langue pivot anglaise conservée en base pour export/réconciliation).
  **ÉCART de périmètre vs le finding initial** : le finding citait aussi `/transactions`, MAIS
  cette page n'affiche PAS `primaryCategory` — elle affiche la catégorie de VENTILATION MANUELLE
  (`categorie.name` via `CategorisationStatusBadge`), saisie par l'utilisateur et DÉJÀ en français
  (cf. `types-transactions.ts` : « indépendant de primaryCategory »). La traduire eût été incorrect.
  DR-F1 ne concernait donc que la catégorie OBIE auto, affichée uniquement sur le dashboard.
- [ ] **OBIE-CATALOG1 (P2, medium, robustesse données) — catalogue OBIE→FR FIGÉ, désynchronisé
  de l'amont réel** — Effort S, ouvert 2026-06-23 (sonde runtime, branche `fix/categories-fr-catalogue-obie`).
  DR-F1 avait peuplé `CORRESPONDANCE_FR` (`src/lib/categories-fr.ts`) depuis le **seed de démo**
  (8 clés : income/rent/utilities/…). Or la sonde du compte RÉEL montre que l'API émet **11
  catégories distinctes**, dont **10 absentes du mapping** (`Business Expenses` 96 tx,
  `Professional Fees`, `Revenue`, `Administrative Costs`, `Personnel`, `Food & Drink`, `Travel &
  Transport`, `Housing`, `Healthcare`, `Other`) → **96 % des transactions** retombaient sur « Non
  catégorisé » à l'affichage alors que `primary_category` est correctement peuplée en base
  (l'ingestion fait son travail — bug d'AFFICHAGE pur, pas d'ingestion). **Correctif immédiat
  (cette branche)** : les 11 clés observées ajoutées au mapping (`revenue`+`income`→« Revenus »).
  **Fragilité RÉSIDUELLE** : le mapping reste une liste FERMÉE maintenue à la main, alors que
  l'amont émet librement — toute NOUVELLE catégorie OBIE s'affichera silencieusement « Non
  catégorisé » sans alerte. **Déclencheur de résolution** : (a) une localisation côté SERVICE
  (table de mapping en base, langue pivot anglaise conservée) si le volume de catégories grandit ;
  OU (b) ajout d'une catégorie OBIE non cartographiée détecté en prod. Piste low-cost intermédiaire :
  log structuré (sans PII) quand `categorieFr` retombe sur le défaut, pour détecter les trous.
  **MAJ 2026-06-23 (feat auto-categorized)** : l'ingestion NULLifie désormais `primary_category`
  quand la catégorie OBIE est vide ou `Uncategorized` (decision PO ; `versLignePersistee` +
  `scripts/backfill-auto-categorized.mjs`). Conséquence pour CE point : le défaut de `categorieFr`
  ne signale PLUS que de VRAIES catégories inconnues (le bruit `Uncategorized` ne remonte plus) →
  la piste (b)/log devient un signal fiable de trou de catalogue. `primary_category` reste l'OBIE
  brut (anglais) pour les catégories exploitables ; le marqueur de provenance vit dans la nouvelle
  colonne `is_auto_categorized`/`category_source` (cf. migration 0011), distinct de ce mapping FR.
- [x] **DR-F2 (P3, polish) — carte « Comptes connectés » : nom de compte tronqué** —
  ✅ **LIVRÉ 2026-06-22** (branche `feat/lot3-4-polish-ui`, Lot 4). `connected-accounts-card.tsx`
  refondue sur 2 lignes : banque en LABEL (`text-[11px] text-text-muted uppercase`, `truncate`
  indépendant, omise si `institutionName` null), nom de compte dessous (`text-[13px]`, `truncate`
  indépendant), montant à droite JAMAIS tronqué (`shrink-0 whitespace-nowrap tabular-nums`). Le
  flex parent porte `min-w-0` pour autoriser le `truncate` des enfants. Nettoyage : type
  `CompteAffiche` supprimé (le composant prend `CompteConnecte` directement — `institutionName`
  est dans le contrat depuis DASH-INST1) ; commentaire d'en-tête « contract-first » périmé corrigé.
  Visual QA `/demo/comptes-provenance` (4ᵉ cas « noms TRÈS longs » ajouté à la démo, contrainte
  300px) : « The Mauritius Commercial Bank… » + « Compte courant… » tronquent SÉPARÉMENT, le
  montant `Rs 999 999 999,00` reste intégralement visible. Zéro troncature de chiffre clé.
- [ ] **DR-F3 (P3 → réévalué medium, polish/correction) — méta « au JJ/MM » TROMPEUSE sous un
  solde COURANT** — Effort S, gardien Front. `side-panel-kpi.tsx:55` affiche « au 12/06 »
  (`dateSolde` = **dernier point de courbe**, EOD) alors que le montant est le solde COURANT
  (`current_balance`) → décalage sémantique qui peut induire un FM en erreur. **DÉCISION ACTÉE
  (2026-06-22)** : remplacer la méta par la **pastille fraîcheur §3.7** (success<6h /
  warning<24h / danger≥24h + CTA « Reconnecter ») branchée sur `lastSyncedAt` — pattern DÉJÀ
  spécifié dans `UI_GUIDELINES.md §3.7` mais jamais implémenté. La date du dernier point de
  courbe reste sur la COURBE. **Déclencheur** : chantier `PLAN-audit-ergonomie-soldes.md`
  **Lot 2**.
- [ ] **C8 (P2, medium, maintenabilité) — 3 formateurs de DATE en parallèle alors que
  `format-date.ts` existe** — Effort S, gardien Front. Relevé à l'audit ergonomie 2026-06-22.
  `dashboard-content.tsx:121` (`jourMoisCourt`), `transactions-table.tsx:78-86` (`jourMois`
  AVEC ses propres noms de mois redéfinis EN DUR), `side-panel-kpi.tsx:129` (`moisLisible`) —
  trois découpes ad-hoc de `YYYY-MM-DD` au lieu d'une source unique. Risque de divergence FR
  (abréviations de mois incohérentes entre composants). **DÉCISION ACTÉE (2026-06-22)** :
  router TOUT formatage de date d'affichage vers `src/lib/format-date.ts` (source unique),
  supprimer les 3 implémentations locales. **Déclencheur** : chantier
  `PLAN-audit-ergonomie-soldes.md` **Lot 6** (fusionnable au Lot 1). Critère de clôture :
  `grep` de noms de mois / `split("-")` ad-hoc dans `src/components` = 0.

### Robustesse UX panne DB + savoir tribal Next 16 (2026-06-17)

Symptôme : base injoignable (Neon/wsproxy down) → 500 brut + crash de
sérialisation Next (« Only plain objects can be passed to Client Components »),
car l'erreur du driver Neon porte une `cause: ErrorEvent` (classe DOM non
sérialisable). Corrigé (branche `fix/workspace-db-error-ux`) :
- `ServiceIndisponibleError` (`session.ts`) : `exigerSessionWorkspace` convertit
  l'erreur d'infra du chemin E6 (`estActif`) en une Error PROPRE sérialisable —
  **FAIL-CLOSED conservé** (DB injoignable ⇒ accès refusé, jamais « supposé
  actif »). Vérifié : compte désactivé → /login (métier), DB down → écran infra.
- `(workspace)/layout.tsx` : helper `gererErreurInfra` qui **rend `AppErrorState`
  directement** (« Service momentanément indisponible », `role=alert`, sans fuite
  technique) pour TOUTE erreur d'infra — `ServiceIndisponibleError` du chemin E6
  ET une panne brute survenant pendant `withWorkspace`/`membershipsAvecNom`
  (axe 5 de la cross-review). Garde-fous dans l'ordre : `unstable_rethrow`
  (re-lance redirect/notFound — jamais avalés), `UnsafeDatabaseRoleError`
  re-`throw` (refus de sécurité C6, pas un « réessayez »), reste → écran. Prouvé
  en prod (standalone) : panne (début ET pendant) → HTTP 200 + écran propre ;
  nominal, redirect sans cookie, et fail-closed (compte désactivé → /login)
  intacts.
- `components/ui/states/app-error-state.tsx` : état d'erreur transverse (§3.4).
- `app/global-error.tsx` : filet ultime pour une panne du ROOT layout.

Cross-review Sécurité (contexte frais) : **feu vert**, fail-closed solide sur les
3 axes critiques (estActif lève ⇒ jamais de session retournée ; layout court-
circuite le shell ; désactivé ≠ panne). 1 constat MINEUR non-sécurité (axe 5)
**corrigé** ci-dessus par `gererErreurInfra`.

⚠️ **SAVOIR TRIBAL Next 16.2 (vérifié empiriquement, contre-intuitif)** : un
`error.tsx` / `global-error.tsx` NE capture PAS une exception levée par le
**data-fetching d'un layout pendant le SSR initial**. Testé : `(workspace)/
error.tsx`, `app/error.tsx` (absent du build), `global-error.tsx` — AUCUN ne
monte (leurs `console.error` ne s'exécutent jamais), Next sert sa 500 par
défaut. La seule voie fiable = **le layout gère l'erreur lui-même** (try/catch +
rendu direct), PAS un boundary. Conséquence : ne pas « ajouter un error.tsx »
pour fiabiliser un layout qui fetch — gérer dans le layout, ou sortir le fetch
(approche Next recommandée). `app/error.tsx`/`(workspace)/error.tsx` ont été
RETIRÉS (redondants : le layout court-circuite avant les pages).

- [ ] **UX-ERR1 (P2) — bouton « Réessayer » fonctionnel sur l'écran d'erreur du
  layout** — Effort S (déclencheur : si l'incident DB devient visible en démo).
  L'`AppErrorState` rendu par le layout RSC n'a PAS de `onRetry` (un handler
  client est impossible dans un Server Component). L'utilisateur doit recharger
  la page à la main. Option : un petit Client Component « bouton recharger »
  (`location.reload()`) ou un `<a href>` vers la même URL. Cosmétique ; le
  rechargement manuel marche déjà.

### Empty States transverses (UI, 2026-06-17)

- [x] **UI-ES1 (P2) — faire dériver `DashboardEmptyState` du `EmptyState` générique**
  — ✅ **LIVRÉ 2026-06-22** (Front, branche `feat/empty-state-derive`). `DashboardEmptyState`
  ne reclone plus StateCard + StateIllustration + la classe CTA : il choisit copy/illustration/
  CTA selon son domaine (/banques) puis DÉLÈGUE le rendu à `<EmptyState>` (−62 lignes dupliquées).
  Le générique a été étendu pour l'accueillir, sans casser ses 4 usages réels (layout, échéances,
  graphiques, global-error) : `message` passe à `ReactNode` (nom de compte en gras inline) et `cta`
  devient l'union `EmptyStateCta` (`{label,href}` → `<Link>` | `{label,onClick}` → `<button>`,
  rétrocompat du handler `onConnect`). Contrat public de `DashboardEmptyState` inchangé
  (`accountLabel?`, `onConnect?`). Stop-loss : lint + typecheck + 395 tests verts. Visual QA
  (`/demo/dashboard-states` cas « compte connecté » + `/demo/dashboard` onglet Vide « aucune
  banque ») : rendu visuellement IDENTIQUE à avant le refactor, 0 erreur console. Reste HISTORIQUE
  ci-dessous :
  Effort S (déclencheur : merge de `feat/activate-nav-empty-states`). Le composant
  générique `src/components/ui/states/empty-state.tsx` (livré avec les pages
  graphiques/échéances/transactions) recouvre le markup de `DashboardEmptyState`
  (illustration + titre + message + CTA lien `primary`). `DashboardEmptyState` reste
  couplé au domaine (CTA « Connecter une banque » → /banques) — le réécrire comme une
  fine spécialisation du générique supprime la duplication. Différé pour ne pas toucher
  du code dashboard mergé/QA dans la PR d'activation nav (décision design D3,
  plan-design-review 2026-06-17).

### Vendoring de @omni-fi/react-link (2026-06-16)

- [ ] **VENDOR-1 (P1) — remplacer le vendoring `file:` par le package publié** —
  Effort S (déclencheur : Omni-FI publie `@omni-fi/react-link` sur npm public OU un
  registre privé d'entreprise). `vendor/omni-fi-react-link/` contient un `dist/` tiers
  BUILDÉ localement, NON audité et NON reproductible (cf. `SECURITY_VENDORING.md`),
  intégré pour débloquer la démo (le package n'est sur aucun registre et son dépôt ne
  committe pas le `dist/`). Risque supply-chain assumé pour la démo uniquement, sur app
  qui manipule des secrets bancaires. Sortie : `npm install @omni-fi/react-link@<ver>`,
  supprimer `vendor/` + `SECURITY_VENDORING.md`, re-valider build + flux de connexion.
  Idéal : demander au repo amont un script `prepare` (build à l'install) ou la
  publication du `dist/`. Décision PO 2026-06-16 (« OK démo, dette tracée »).

### Ré-alignement contrat widget sur le code source + cross-review (2026-06-16)

⚠️ La doc Fern « `onSuccess = publicToken seul` » (tranchée 2026-06-15) était FAUSSE.
Code source réel (github.com/omni-fi-app/omni-fi-react-link) : hook `useOmniFILink`,
`onSuccess({ connections: [...] })` (multi-connexions), entrée `token`, script CDN
(`isReady`). URL API : `sandbox.omni-fi.co` = coquille NXDOMAIN → vrai hôte
`stage.omni-fi.co` (vérifié HTTP 200). Câblage ré-aligné + boucle fail-soft multi.

Cross-review Sécurité + QA passée (aucun BLOQUANT/MAJEUR). 3 constats corrigés au
diff (dédoublonnage publicTokens + test, test IDOR dans la boucle, casse stub).
Durcissements différés (déclencheur commun : intégration du VRAI package / mise en prod) :

- [x] **W4-D1 (P1) — `OMNIFI_ENV` découplé de l'hôte de `OMNIFI_BASE_URL`** —
  ✅ RÉSOLU (PR #122 verrou env-piloté + PR #124 hôte partagé, vérifié 2026-06-26).
  `config.ts` LIE désormais env↔hôte (fail-closed) : garde de cohérence
  (`:154-165` — un `production` sur hôte sandbox-only, ou l'inverse, fait échouer le
  démarrage) + verrou production (`:147-168`) + notion d'`HOTES_PARTAGES` (`:74`) pour
  l'hôte api-stage qui sert sand ET prod (l'env y vient des clés + du drapeau
  `OMNIFI_AUTORISER_PRODUCTION`, plus décoratif). `environment` n'est plus décoratif :
  il borne le démarrage. [Audit backlog 2026-06-26 : entrée jamais cochée.]
- [ ] **W4-D2 (P2) — pas de rate-limit applicatif sur `finaliserConnexionsDropin`** —
  Effort S (déclencheur : si la sélection multi-banques devient courante). Boucle
  séquentielle ≤20 connexions × (exchange + pagination /accounts) ; surface
  authentifiée + gating MANAGER/ADMIN + array borné, donc pas un vecteur anonyme,
  mais un re-jeu peut dépasser le 10/IP/60s amont (throttle). Borner totalPages ou
  la durée totale. Relevé par audit sécurité (5/10).
- [ ] **W4-D3 (P2) — `open()` du widget sans garde anti-double-ouverture** — Effort S
  (déclencheur : test du flux réel avec `@omni-fi/react-link` désormais installé).
  `omnifi-link-launcher.tsx` : `useEffect([isReady, open])` peut ré-appeler `open()`
  si l'identité de `open` n'est pas stable dans le package. Le flux normal le masque
  (onSuccess→setFerme→launcher démonté). Ajouter un `useRef` « déjà ouvert » si le
  test révèle une double-ouverture. Relevé par audit QA (5/10).

### Redirection Dashboard post-succès widget (UI, 2026-06-18)

Branche `feat/omnifi-native-success` : au succès COMPLET de la finalisation native
(`onSuccess` → `finaliserConnexionDropinAction`), l'utilisateur est redirigé vers le
Dashboard (`router.push('/')`) ; en succès PARTIEL on reste sur `/banques` pour ne
pas masquer l'échec (bandeau + lien d'action). Le repli manuel « Une banque
n'apparaît pas ? » est conservé (retrait progressif). Liste de courses Backend :

- [x] **WIDGET-RD1 (P1) — exposer un flag `complet` sur `EtatFinalisation`** —
  ✅ RÉSOLU (vérifié 2026-06-26). `EtatFinalisation` porte désormais `complet?: boolean`
  (`banques/actions.ts:52`) et `finaliserConnexionDropinAction` le calcule
  (`:199`, `complet: r.echecs === 0`) → le Front peut déclencher la redirection au succès
  total et rester sur place en partiel. [Audit backlog 2026-06-26 : entrée jamais cochée.]
  CONTEXTE HISTORIQUE conservé ci-dessous :
  Effort S (déclencheur : ce câblage de redirection, dû MAINTENANT). Le contrat
  `EtatFinalisation` (`src/app/(workspace)/banques/actions.ts`) ne renvoie que
  `{ erreur, succes }` (strings) ; le serveur CONNAÎT `echecs`/`reussies`
  (`finaliserConnexionsDropin`, `orchestration.ts`) mais les fond dans le LIBELLÉ.
  Côté client je distingue donc « succès total » de « partiel » uniquement via un
  champ booléen — que je consomme déjà en contract-first (`EtatFinalisationUI =
  EtatFinalisation & { complet?: boolean }`, `bank-connect-widget.tsx`). **Tant que
  Backend ne pose pas le flag, `complet` vaut `undefined` → fallback SÛR : aucune
  redirection automatique**, on reste sur la page avec le lien explicite (jamais de
  navigation qui masquerait un échec). Demande Backend : ajouter `complet: boolean`
  (= `echecs === 0 && reussies.length > 0`) au retour de `finaliserConnexionDropinAction`.
  Frontière respectée (gardien Backend du contrat) — je ne modifie pas la Server Action.
  Anti-pattern à NE PAS faire côté UI : parser le texte de `succes` pour deviner le
  partiel (couplé au libellé, casse au moindre changement de message).

### Conflit d'agents — câblage widget unifié (2026-06-15, RÉSOLU)

Le merge de main dans PR-W4 avait révélé DEUX câblages divergents du widget.
**Tranché (doc Fern) : `onSuccess = publicToken SEUL`.** Unification appliquée :
- `bank-connect-widget.tsx` (agent UI, monté par `banques/page.tsx`) réécrit sur
  le contrat dropin → `onSuccess(publicToken)` + `finaliserConnexionDropinAction`.
- Doublon `connecter-banque.tsx` (backend, non monté) SUPPRIMÉ.
- `finaliserConnexionAction` + son schéma zod (sessionToken/jobId) SUPPRIMÉS de
  `actions.ts`. Stub `omnifi-react.d.ts` nettoyé (plus de sessionToken/jobId).
- `finaliserConnexion` (orchestration, chemin « widget custom » via
  getSyncJobAccounts) CONSERVÉE + testée (réutilisable hors dropin), mais plus
  appelée par aucune action. Un seul chemin runtime : le dropin.
- [x] **5.3 (P2) — RÉSOLU 2026-06-16** — stub `omnifi-react.d.ts` + stub JS + alias
  de build SUPPRIMÉS : le vrai package `@omni-fi/react-link` est vendoré et fournit
  ses propres types (branche `fix/omni-fi-integration`). Voir dette VENDOR-1.

### Cross-review sécurité PR-W4 — intégration widget drop-in (2026-06-15)

Audit OWASP contexte frais. **Aucun bloquant.** Corrigés dans PR-W4 : 3.1
(allowlist serveur du redirectOrigin via `APP_ALLOWED_ORIGINS`, fail-closed) et
5.2 (open() du widget déclenché dans un effect après pose du token, plus de token
vide). Différés / décisions :

- [ ] **1.1 (P1) — Contraintes UNIQUE globales `omnifi_connection_id` /
  `omnifi_account_id` (non scopées workspace)** — Hypothèse : Omni-FI garantit
  l'unicité par ClientUserId (workspace). Si cette hypothèse est fausse, une
  migration composite UNIQUE(workspace_id, id) sera nécessaire. Documenté dans
  `schema.ts` au-dessus des contraintes. Décision (2026-06-15) : PAS de migration
  avant la démo (pas de risque opérationnel à la veille) ; à confirmer auprès
  d'Omni-FI puis durcir si besoin. La RLS empêche toute fuite de lecture ; le
  risque résiduel est un oracle/déni de rattachement en cas de collision.
- [ ] **3.1 résolu / suivi** — `APP_ALLOWED_ORIGINS` doit être renseigné en env
  (sinon fail-closed : aucune connexion widget possible). À documenter au déploiement.
- [x] **5.3 (P2) — RÉSOLU 2026-06-16** — stub supprimé, vrai package `@omni-fi/react-link`
  vendoré (ses types réels font foi : `onSuccess(payload)`, pas `onSuccess(string)` —
  l'ancienne hypothèse Fern était fausse). Suivi : dette VENDOR-1 (package publié).

### Cross-review croisée Agent UI — précision financière ingestion (2026-06-15)

Alerte « bloquante » de l'Agent UI sur `ingestion/index.ts` + `dashboard.ts`.
**Les DEUX constats rejetés sur preuve — code maintenu, aucun correctif.**
Désaccord tranché par l'humain en faveur de l'analyse documentaire (règle 6).

- **P1 (prétendu bloquant) — fuseau de `balanceDate` : FAUX POSITIF.** L'Agent UI
  réclamait `AT TIME ZONE 'Asia/Port_Louis'` sur `b.Date` par symétrie avec
  `transaction_date`. PREUVE (doc Fern `get-historical-balances`) : le champ `Date`
  est `format: date` (YYYY-MM-DD **nu**, sans heure ni fuseau) et l'endpoint renvoie
  des « end-of-day balances » = DÉJÀ la date comptable du compte. `AT TIME ZONE` ne
  s'applique qu'à un INSTANT (cas de `transaction_date`, dérivée d'un
  `BookingDateTime` horodaté) ; l'appliquer à une date nue serait un no-op ou un
  DÉCALAGE d'un jour. `balanceDate: b.Date` est correct — le « corriger » créerait
  le bug.
- **P2 — source du KPI solde : DÉJÀ CONFORME.** `soldeConsolideCourant`
  (`dashboard.ts`) somme déjà le dernier EOD de `balance_history`
  (`max(balance_date)` par compte) et NE lit PAS `bank_accounts.current_balance` →
  KPI et courbe partagent la même source. Rien à changer.
- Leçon (méthode) : un constat de cross-review se VÉRIFIE contre la source de vérité
  avant correctif ; une fausse symétrie (date nue vs instant) ne suffit pas. 2e
  faux positif d'affilée tranché par preuve (cf. C1 PR-W1).

> ⚠️ État réel à corriger : `feature/epic3-dashboard-integration` (qui porte
> `dashboard.ts` / `soldeConsolideCourant`) **n'est PAS encore mergée dans `main`**
> au 2026-06-15 (dernier merge = PR-W3 #15). Le socle de lecture du dashboard
> n'est donc pas en prod ; PR-W4 + Visual QA en dépendent. À merger.

### PR-W3 — logique widget MFA côté client (2026-06-15)

- A1 (PR-W1) **respecté** : `widget-runtime.ts` ne logge jamais l'OTP/token ;
  erreurs réduites à un code machine (`OMNIFI_<status>` / `RUNTIME_ERROR`).
- A2 (PR-W1) **respecté** : le watermark est `undefined` tant qu'aucun resend,
  jamais `null` (machine + submitMfaAction omettent le champ).
Cross-review OWASP (contexte frais) — aucun bloquant. #6 (polling infini sur job
bloqué non terminal) **CORRIGÉ** : `clearInterval` dès état terminal + plafond
`MAX_POLLS` (~10 min). Sain confirmé : OTP/token/watermark jamais exposés, gating
avant effet, A2 respecté, codes non-énumérants. Différés :
- [ ] **#3 — détection de rejet OTP best-effort** — Effort S (P2). La transition
  `UserInput présent→absent` peut manquer un snapshot de polling (echecsOtp client
  non incrémenté). Impact sécurité NUL (le serveur tranche au 3e échec → FAILED) ;
  c'est une divergence de COMPTEUR UI. Documenté « vérité = serveur » dans
  machine-mfa.ts. À couvrir par un test du cas snapshot-manqué si testing-library
  est ajouté.
- [ ] **Test du hook React `useOmniFiWidget` non couvert** — Effort S (P2). La
  logique métier MFA est dans la machine PURE (couverte : 11 tests rejet/
  watermark/cooldown/échecs). Le hook reste une coquille (timers/refs polling) —
  non testé car pas de renderer React au projet (testing-library/jsdom = nouvelle
  dépendance, règle 9). Couvert au Visual QA avec l'agent UI. Déclencheur : si on
  ajoute testing-library pour d'autres hooks, brancher un test polling/submit/resend.

### Cross-review sécurité PR-W2 — orchestration serveur widget (2026-06-15)

Audit OWASP/IDOR contexte frais sur les Server Actions démarrer/finaliser.
**1 bloquant corrigé, 1 non-bloquant corrigé, 2 différés.**
- **1.1 (BLOQUANT) CORRIGÉ** : `finaliserConnexion` recoupe désormais
  l'`InstitutionId` des comptes du job avec celui de la connexion échangée →
  `ConnexionDesalignmentError` fail-closed si désalignement (sessionToken/jobId
  d'un autre flux). Test d'isolation du cas ajouté.
- **5.1 CORRIGÉ** : log structuré corrélé (`workspace_id` + code machine, sans
  PII/token) dans les Server Actions (exit-criteria règle 3) ; `instanceof
  OmniFiApiError` mort retiré.
- [ ] **1.2 — Contraintes UNIQUE globales non composites** — Effort M (P1).
  ⚠️ **DOUBLON de `1.1`** (même sujet — audit 2026-06-26). RÉELLEMENT OUVERT :
  `omnifi_connection_id` / `omnifi_account_id` sont UNIQUE globaux (`0003`, vérifié)
  et NON `(workspace_id, …)` ; une collision d'id cross-tenant + `onConflictDoUpdate`
  fait échouer la finalisation (DoS, PAS IDOR silencieux — la RLS masque la ligne
  étrangère). Durcir en contraintes composites. Touche le schéma → migration
  dédiée + cross-review schéma. Lié à la dette #5 (FK composites). À FUSIONNER avec 1.1.
- [x] **3.1 — `redirectOrigin` non allowlisté** —
  ✅ RÉSOLU (vérifié 2026-06-26 ; doublon de l'entrée « 3.1 résolu / suivi » plus haut).
  L'allowlist serveur existe : `src/server/widget/redirect-origin.ts`
  (`autoriserRedirectOrigin`, motif `non_allowliste`, **fail-closed si `APP_ALLOWED_ORIGINS`
  vide**) — une origine hors liste est refusée avant tout appel Omni-FI. Branché dans
  `orchestration.ts`. [Audit backlog 2026-06-26 : entrée jamais cochée.]

### Cross-review sécurité PR-W1 — client widget multi-auth (2026-06-15)

Audit OWASP contexte frais sur la gestion LinkToken/SessionToken/identifiants
bancaires. **Aucun constat bloquant ni non-bloquant valide.**
- Constat « C1 » du réviseur (`historiqueSoldes` sans `clientUserId`) **INFIRMÉ** :
  citation doc erronée (ligne de `latest-job`, pas `balances/history`). La doc
  réelle (`balances/history` : query = from/to/page/pageSize, SANS clientUserId)
  confirme que le client PR 1 est correct. Désaccord tranché par le fait, pas lissé.
- Observations propagées aux PR appelantes (non corrigeables dans le client) :
  - [ ] **A1 — log autour de `connecter()`** : l'appelant (PR-W2/W3) ne doit JAMAIS
    logger l'objet d'erreur + ses arguments ensemble (le body porte le mot de passe
    bancaire). Le client lui-même ne fuite rien. Effort S (P1, déclencheur PR-W2).
  - [ ] **A2 — watermark MFA `undefined` vs `null`** : l'appelant passe `undefined`
    (champ omis) tant qu'aucun resend n'a eu lieu ; ré-émet la valeur lue verbatim
    ensuite. Passer `null` explicite → 409 STALE_INPUT. À documenter côté UI widget.

## P0 — en cours (Semaines 2-3, séquencement C1 restauré par D3)

- [ ] **Epic 1 — Auth.js + consent flow + audit + révocation** — priorité absolue.
  Référence d'implémentation : plan v2.1 (Epic 1, E14, registre S2). Démontrable
  en interne fin S2 sur le workspace démo sandbox.
  - [x] PR 1 `feature/auth-foundation` — FAIT 2026-06-12 (en attente PR humaine).
  - [ ] PR 2 — sélecteur de workspace (états D2) + bascule activeWorkspaceId via
    session update + parcours provisioning ADMIN + gating VIEWER.
  - [ ] PR 3 — consent flow Omni-FI + audit trail append-only + révocation
    (re-découpage au démarrage). Inclut la modal re-login sans perte de
    contexte (D2 transverse).

### Dette relevée au contrat widget natif (UI, 2026-06-15)

- [ ] **🔴 `finaliserConnexionAction` désalignée du contrat Fern `publicToken` seul**
  — Effort S (P0, déclencheur : avant la démo du widget natif). Décision 2026-06-15 :
  le widget natif Omni-FI (`@omnifi/react`, `onSuccess`) renvoie le **publicToken
  SEUL** (doc Fern `link-connect → PublicToken`). L'UID UI
  (`bank-connect-widget.tsx`) a été aligné : `onSuccess(publicToken: string)`
  n'envoie plus que `publicToken`. MAIS `finaliserConnexionAction`
  (`banques/actions.ts`) garde un `finalisationSchema` zod **`.strict()`** exigeant
  `publicToken + sessionToken + jobId` → avec publicToken seul, la validation
  REJETTE l'appel et la connexion bancaire n'est jamais rattachée. **Action backend** :
  réduire `finalisationSchema` à `{ publicToken }` (le `link-exchange` n'a besoin que
  de `PublicToken` + `ClientUserId`, ce dernier résolu côté serveur depuis le
  workspace). Tant que ce n'est pas fait, le flux de connexion casse à la
  finalisation, même si le widget aboutit.

### Dette acceptée à la PR auth-foundation (2026-06-12)

- [ ] **Purge périodique de `login_attempts`** — Effort S. Les lignes hors
  fenêtre (15 min) s'accumulent ; cron de purge à brancher avec les crons de
  la pipeline (semaines 3-5). Sans purge : croissance lente de la table, aucun
  impact de sécurité (le COUNT est borné par l'index).
- [ ] **Runbook rotation AUTH_SECRET** — Effort S. La rotation invalide toutes
  les sessions actives (stratégie JWT) ; procédure + fenêtre de maintenance à
  documenter au setup du déploiement (avec le choix d'hébergeur, règle 9).
- [ ] **Typographies UI complètes (Instrument Sans + Geist tabular partout)** —
  Effort S. Le login utilise les tokens couleurs §0 mais la famille Geist
  existante ; bascule complète avec le build UI (spec VALIDATED_SHELVED).

### Dette relevée pendant le refacto d'arborescence (2026-06-12)

- [ ] **`@/db` ré-exporte `schema` → porte dérobée à la frontière P0-a** —
  Effort S (P1). La règle lint confine `@/db/schema`, mais `src/db/index.ts`
  ré-exporte `schema`, donc `app/page.tsx:14` importe `{ schema, withWorkspace }`
  et tisse du Drizzle brut (`schema.workspaces`) dans un Server Component. À
  corriger en 2 temps : (a) retirer le ré-export `schema` de l'index DB pour
  fermer la porte ; (b) déplacer la requête de page.tsx dans un repository scopé.
  Code applicatif → hors du refacto mécanique, lot dédié.

### Dette acceptée au schéma financier Epic 3 (2026-06-12)

- [ ] **Roulement automatique des partitions `transactions_cache`** — Effort S
  (P1, déclencheur : premier déploiement de production). La migration 0003 crée
  les partitions annuelles 2024-2027 + DEFAULT ; le plan exige une alerte si la
  partition à J-30 manque + création automatique du roulement. À brancher avec
  les crons de la pipeline de sync (Étape 2). Sans elle : à partir de 2028 les
  lignes tombent dans la partition DEFAULT (fonctionnel mais non perforant) —
  jamais de perte de données.
  **⚠️ SÉCURITÉ NON NÉGOCIABLE** : toute partition créée par ce roulement DOIT
  poser, à sa création, `ENABLE` + `FORCE ROW LEVEL SECURITY` + `CREATE POLICY
  tenant_isolation`. La RLS N'est PAS héritée de la mère (cf. constat bloquant
  cross-review 2026-06-15, corrigé dans 0003 pour 2024-2027+DEFAULT) → c'est
  l'invariant que le roulement doit RÉPÉTER. Une partition sans RLS = fuite
  cross-tenant. À traiter comme de l'isolation tenant (non différable).
  NB : le **trigger `BEFORE DELETE` append-only** (migration 0004), lui, EST
  hérité automatiquement par toute partition (présente/future, PostgreSQL ≥ 11,
  vérifié empiriquement) — le roulement n'a PAS à le répéter. Ne pas confondre
  les deux invariants : RLS = à répéter ; trigger = hérité.

### Dette acceptée au schéma Epic 3 — cross-review (2026-06-15)

Cross-review contradictoire (rôle Sécurité, contexte frais) sur la branche
`feature/epic3-schema`. BLOQUANT corrigé dans 0003 (RLS+FORCE+policy sur les 5
partitions de `transactions_cache`, commentaire faux retiré). #3 PARTIELLEMENT
traité (voir ci-dessous). Différés :

- [x] **#3bis — Tombstone non garanti par le seul REVOKE de 0003 — FAIT
  2026-06-17** (branche `fix/tombstone-delete-provisioning`). `tygr_app.sql`
  passe en **liste blanche DELETE (deny-by-default)** : plus aucun `GRANT DELETE
  ON ALL TABLES` ; le GRANT global se limite à `SELECT, INSERT, UPDATE` (idem
  `ALTER DEFAULT PRIVILEGES`), et DELETE est octroyé table par table (bloc
  `DO`/`to_regclass` conditionnel) UNIQUEMENT aux 6 tables normales
  (`workspaces`, `users`, `login_attempts`, `workspace_members`,
  `bank_connections`, `bank_accounts`). `transactions_cache` (+ partitions, y
  compris FUTURES via roulement) et `balance_history` ne reçoivent JAMAIS DELETE
  — garantie indépendante de l'ordre provision/migrate et du nombre de
  re-provisions (prouvé PGlite : invariant `DELETE=false` dans les deux ordres).
  Le `REVOKE` de 0003 demeure (ceinture + intention documentée). Preuve verrouillée :
  `tests/isolation/tombstone-delete-isolation.test.ts` (DELETE refusé sur les 2
  tables + partition directe + DEFAULT ; UPDATE `is_removed` toujours autorisé ;
  contre-preuve DELETE autorisé sur `workspace_members`). Le piège « REVOKE non
  propagé aux partitions » est ainsi clos par construction.
  **2e volet — faille CASCADE colmatée (cross-review Sécurité, 2026-06-17).** La
  liste blanche seule NE suffisait PAS : le grant DELETE légitime sur
  `bank_accounts`/`bank_connections` (déconnexion d'une banque) laissait la
  cascade FK `ON DELETE cascade` effacer PHYSIQUEMENT l'append-only SANS
  re-vérifier son privilège (reproduit : 1 ligne → 0). Migration **0004**
  (`0004_append-only-no-delete.sql`) ajoute une fonction + un **trigger
  BEFORE DELETE** sur la mère `transactions_cache` (HÉRITÉ par ses 5 partitions,
  présentes et futures — PostgreSQL ≥ 11) et sur `balance_history`, qui lève
  `append_only_no_delete` (ERRCODE check_violation) : défense réelle indépendante
  du privilège ET du chemin (direct / partition directe / cascade / code futur).
  L'invariant append-only est désormais vrai par construction (vérifié même SOUS
  l'owner, et sur une partition 2028 créée après la migration). Cas cascade
  verrouillés (tests 8-10 : DELETE `bank_accounts`/`bank_connections` rejeté,
  lignes append-only intactes). Le roulement de partitions n'a PAS à répéter le
  trigger (hérité) — seule la RLS est à répéter (cf. dette roulement ci-dessus).
  - [ ] **Suivi opérationnel (P2, déclencheur : 1er déploiement prod sur base
    NEUVE)** — Effort S. En ordre `provision → migrate` sur base vierge, les
    GRANT DELETE des tables normales sont sautés au 1er provision (tables encore
    absentes) ; ils ne mordent qu'au **re-provision post-migrate**. L'append-only
    reste protégé à tout instant (jamais d'octroi) ; le seul effet est que
    l'offboarding RGPD (DELETE sur tables normales) exige ce re-provision. À
    intégrer dans le runbook de déploiement (étape « db:provision » à rejouer
    après migrate). Aucun impact sur base déjà migrée (cas Neon/local actuel).

- [x] **#2 — Idempotence d'ingestion non garantie par la clé DB** — FAIT 2026-06-15
  (PR 2 ingestion, `feature/epic3-ingestion`). `upsertTransactions`
  (`src/server/repositories/ingestion.ts`) neutralise (is_removed=true) toute
  version antérieure de même `omnifi_txn_id` posée sur un AUTRE
  `transaction_date` AVANT l'upsert sur la clé naturelle → un re-affinement du
  BookingDateTime par l'amont ne crée plus de doublon. RLS scope la mise à jour
  au workspace courant.

### Migration ingestion curseur → PAGE (2026-06-19)

L'orchestrateur d'ingestion est passé du modèle par curseur (`/transactions/sync`,
delta Added/Modified/Removed/NextCursor) au modèle par PAGE (`/transactions`,
`Links.Next`/`Meta.TotalPages`), Omni-FI ayant confirmé que `/sync` est une
extension future NON déployée (cf. OMNIFI_API_FEEDBACK.md §10). Branche
`feat/ingestion-pagination-page`. Conséquences tracées :

> ✅ **RECONFIRMÉ (Slack Omni-FI, 2026-06-26)** : `/transactions/sync` et
> `/balances/history` NE sont PAS déployés ; l'API est page-based
> (`GET /accounts/{id}/transactions`). Audit code 2026-06-26 : l'orchestrateur vise
> bien le page-based (`orchestrateur.ts:167`, boucle `TotalPages`/`Links.Next` avec
> plafond anti-boucle) — AUCUN appel curseur résiduel. Pas de bug, rien à corriger.

- [ ] **INGEST-CURSOR1 (P2) — retirer la colonne orpheline `sync_cursor`** —
  Effort S (déclencheur : prochaine migration touchant `bank_accounts`, ou revue
  de fin d'epic). Depuis la migration page, `bank_accounts.sync_cursor`
  (`schema.ts`) n'est plus écrite ni lue (seul `last_synced_at` est maintenu via
  `marquerSynchronise`). Colonne laissée en place EXPRÈS pour ne pas coupler ce
  changement de code à une migration DB (risque séparé). À dropper proprement
  (migration `ALTER TABLE … DROP COLUMN`, backward-compatible avec le code N-1).
- [ ] **INGEST-DELTA1 (P2) — surcoût du re-téléchargement complet** — Effort M
  (déclencheur : volumes prod réels OU Omni-FI déploie `/transactions/sync`).
  Le modèle par page relit TOUTE la liste des transactions à chaque sync (pas de
  delta) ; l'`upsert` idempotent absorbe les doublons mais le coût réseau/CPU croît
  avec l'historique. Acceptable au MVP (volumes sandbox faibles, arbitrage PO
  2026-06-19). Atténuations possibles : borne `fromBookingDateTime` si l'API la
  supporte, ou repasser au curseur le jour où `/sync` existe (le code était déjà
  écrit pour, cf. historique git).

### Dette résolue / intégrée à la PR 2 ingestion (2026-06-15) — ⚠️ SUPERSEDED par la migration page (2026-06-19)

> Q3 (`bornerCount`/`COUNT_MAX`) et Q4 (`HasMore`/`NextCursor`) ci-dessous étaient
> SPÉCIFIQUES au modèle curseur, désormais abandonné. Q3 devient `bornerPageSize`
> (pageSize borné [1, 100]) ; Q4 devient la garde `MAX_PAGES` sur la boucle par page
> (l'amont peut mentir sur `Links.Next`). Conservé pour historique.

Q3 et Q4 (différées depuis la cross-review PR 1) intégrées dans l'orchestrateur
`src/server/ingestion/orchestrateur.ts` :
- **Q3 (count borné)** : `bornerCount` clampe le `count` du sync dans [1, 500]
  (COUNT_MAX, doc Omni-FI) avant tout appel réseau.
- **Q4 (garde anti-boucle)** : la boucle lève `IngestionBoucleError` si l'amont
  renvoie `HasMore=true` avec un `NextCursor` vide ou identique au précédent
  (sinon re-ingestion infinie de la 1re page) ; plafond `MAX_PAGES` en filet.

- [ ] **Découverte de comptes (connexion → bank_accounts) hors surface PR 1** —
  Effort M (P1, déclencheur : flux widget / consent). L'ingestion PR 2 synchronise
  des comptes DÉJÀ rattachés (`synchroniserCompteComplet`) mais ne crée pas les
  `bank_accounts` à partir d'une connexion : la liste des comptes d'une connexion
  passe par `GET /sync/job/{JobId}/accounts` (SessionTokenAuth) ou `GET
  /parties/{PartyId}/accounts` (ApiKey + PartyId), hors de la surface lecture
  livrée en PR 1. Pour la démo sandbox : rattacher les comptes pré-connectés en
  amont (script/seed). À industrialiser avec le flux widget. `upsertCompte` est
  déjà prêt dans le repository d'ingestion.
- [ ] **#5 — FK non composites → rattachement cross-workspace possible** — Effort
  M (P1). `bank_accounts.connection_id → bank_connections.id` (et FK analogues)
  ne vérifient pas l'égalité de `workspace_id` : une ligne du workspace courant
  peut référencer un parent d'un autre workspace. Atténué par le `WITH CHECK`
  (on n'écrit pas DANS un autre tenant) + `workspace_id` dénormalisé et indexé
  (la lecture reste filtrée). Durcissement : PK/UNIQUE composites `(workspace_id,
  id)` sur les parents + FK composites. À trancher (coût vs bénéfice).
- [ ] **#6 — `ON DELETE no action` sur `created_by`/`workspace_id`** — Effort S
  (P1). Supprimer un user qui a créé une `bank_connection` est bloqué par la FK
  (alors que `workspace_members.user_id` est en cascade) → offboarding RGPD
  heurte une erreur FK. Choix à acter : `SET NULL` sur `created_by` (traçabilité
  via audit_events) vs statu quo (protection de l'historique). Idem suppression
  de workspace, bloquée tant qu'il reste des données financières.

### Dette acceptée à la PR 1 client Omni-FI — cross-review (2026-06-15)

PR 1 `feature/epic3-omnifi-live`. La cross-review contradictoire (rôles Sécurité
+ QA, contexte frais) a produit 7 constats. Corrigés DANS la PR 1 : S1 (SSRF/
fuite de clé — `startsWith` https contournable → `new URL` + rejet userinfo +
allow-list des 3 hôtes doc), Q1 (`{Data:null}` rejeté), S2 (cause réseau réduite
à `{name,code}`), Q5 (`Retry-After` format date HTTP), Q2 (Links/Meta exposés sur
les endpoints page-based). Différés ci-dessous (mordent en PR 2, pas en PR 1) :

- [ ] **Q3 — `count` du sync non borné vs max 500 (doc § Transactions)** — Effort S
  (P1, déclencheur : PR 2 ingestion). `OmniFiClient.syncTransactions` passe `count`
  tel quel ; un `count>500` → soit 400 dur (ingestion bloquée), soit clamp
  silencieux (dérive de pagination). À borner [1,500] côté client ou appelant au
  moment où la boucle d'ingestion est écrite. Sans : risque uniquement si un
  appelant fournit un count hors borne — aucun appelant n'existe avant la PR 2.
- [ ] **Q4 — invariant curseur `NextCursor` vide + `HasMore:true` non défendu** —
  Effort S (P1, déclencheur : PR 2 ingestion). `NextCursor` est typé `string` non
  optionnel ; une boucle naïve sur un `NextCursor:""` renvoyé avec `HasMore:true`
  re-demanderait la 1re page (curseur vide = historique complet) → boucle infinie
  ré-ingérant les mêmes lignes. La garde (refuser `HasMore` sans curseur non vide)
  vit naturellement dans la boucle d'ingestion PR 2. Sans : aucun effet en PR 1
  (le client expose une page, n'itère pas).

### Dette relevée pendant Epic 2 + audit EM (2026-06-12)

- [x] **next-auth épinglé en CARET, viole notre propre règle 9** — FAIT
  2026-06-15 (PR 0 `feature/epic3-omnifi-live`). Pin exact posé dans
  `package.json` ET `package-lock.json` (`"5.0.0-beta.31"`, sans `^`) ; version
  résolue inchangée (`5.0.0-beta.31` déjà installée), `npm ci --dry-run` OK.
  Rappel : re-valider le parcours login à chaque bump manuel futur.
- [ ] **QA visuelle des états Suspense non capturable in situ** — Effort S (P2).
  Le skeleton `loading.tsx` n'a pas pu être capturé via navigation réelle
  (browse attend `load` ; le Suspense streamé échappe au timing ; CDP network
  throttling hors allowlist). Contourné par un **rendu HTML offline** (CSS
  compilé extrait du dev server) — le markup est validé, mais PAS dans le vrai
  flux Suspense. Déclencheur : pour une QA fiable des états de chargement,
  ajouter un harness Playwright qui intercepte le streaming, OU une route de
  test dédiée derrière un flag dev. Le code `loading.tsx` est correct.
  **MAJ 2026-06-15** : la route de démo `/demo/dashboard-states`
  (feature/epic3-dashboard-ui-states-v2) matérialise l'option « route de test
  dédiée » — les 3 états du dashboard y sont capturables in situ (Visual QA
  réussie via segmented control, sans flux Suspense). Reste ouvert pour
  `loading.tsx` du sélecteur (Suspense réel). Reclasser en « partiellement
  adressé » au merge.
- [ ] **CSO findings 1+2 — courses lockout & rate-limit (TOUJOURS OUVERTS)** —
  Effort S-M (P1). Re-validation read-decide-write non atomique : N requêtes
  concurrentes lisent l'état « non verrouillé » avant qu'aucune n'écrive →
  bypass du lockout E18 et du plafond IP E7 sous concurrence. Plus grave que le
  delta de timing ci-dessous. Correction structurelle commune : UPDATE
  conditionnel atomique (lockout) + compteur atomique (IP, Redis en phase 2).
  À traiter en un lot AVANT le premier déploiement production. Rapport CSO du
  2026-06-12 (script d'attaque de preuve disponible).

### Dette relevée en validation locale (2026-06-12, EM run)

- [x] **Provisioning du rôle `tygr_app` non migré (P0-b)** — FAIT 2026-06-12 :
  `drizzle/provisioning/tygr_app.sql` (idempotent, sans mdp) + `npm run
  db:provision` + garde-fou runtime C6 (`UnsafeDatabaseRoleError`) + contre-
  preuve R1 (test C5) + suite isolation consomme le script (source unique).
  Spec : `docs/specs/provisioning-tygr-app.md`. Reste à brancher dans la CI
  (étape provision avant migrate) au setup déploiement — dépend de l'hébergeur.
- [ ] **Delta de timing résiduel ~10-15 ms sur le login** — Effort S. La
  vérification argon2 est égalisée (hash factice) mais l'écriture d'échec
  (transaction FOR UPDATE) n'existe que sur le chemin « compte connu » —
  oracle statistique théorique. Exploitation bornée par la limite 20/IP/15 min.
  Option : écriture factice symétrique côté email inconnu.
- [ ] **`/login` vide les champs après un échec** — Effort S (UX). L'email doit
  survivre au re-rendu de useActionState. À reprendre avec le build UI.
- [ ] **`turbopack.root` à épingler dans next.config.ts** — Effort S. Un
  package-lock.json parasite dans le HOME fait inférer une mauvaise racine
  workspace (warning au boot dev).

## P1 — au scaffold du repo (bloquant pour le premier commit de code)

- [x] **Installer les hooks stop-loss** — FAIT 2026-06-11 : `.husky/pre-commit`
  (prouvé bloquant sur erreur de type) + `.claude/settings.json` PreToolUse
  (`.claude/hooks/stop-loss-commit.sh`). Ajouter `npm test` au pre-commit dès que
  la suite de tests existera.
- [ ] **npm audit : 2 vulnérabilités modérées transitives** (postcss via next,
  toutes versions stables affectées au 2026-06-11) — Effort S. Surveiller le patch
  next et re-auditer à chaque bump (CLAUDE.md règle 9).
- [x] **Règle lint anti accès DB ad-hoc (P0-a)** — FAIT 2026-06-12 (refacto
  d'arborescence, étape 1) : `no-restricted-imports` confine schéma/repositories
  hors `src/server/**`, `allowTypeImports` pour les types partagés ; barrière
  prouvée chirurgicale (import de valeur du schéma depuis `app/` rejeté).
- [x] **Pipeline CI canonique** — FAIT 2026-06-11 : `.github/workflows/ci.yml`
  (lint → typecheck → tests/IDOR bloquant, sur PR vers main). Restent à brancher au
  setup du déploiement : étape build, migrations expand-contract, deploy preview
  (règle 9) — dépend du choix d'hébergeur (Vercel + Neon).

### Chantiers produit prioritaires (revue PM/Architecture, 2026-06-23)

- [ ] **PROD-MERCHANT1 (P1) — afficher le marchand réel + la catégorie amont (tuer « Opération bancaire »)** —
  Effort M, gardien Front + Backend (contrat). Ouvert 2026-06-23. Le fallback
  `"Opération bancaire"` (`transactions/adapter.ts:83`, `transactions-table.tsx:54`)
  s'affiche quand `clean_label` est null. L'enrichissement amont est DÉJÀ ingéré et
  stocké (`orchestrateur.ts:70-72` mappe `CleanMerchantName`/`PrimaryCategory`/
  `SubCategory` ; colonnes `schema.ts:372-373`) — donc le travail est d'EXPOSER en
  lecture, pas de brancher une intégration absente. **PRÉ-REQUIS BLOQUANT (règle 6) :
  vérifier en runtime le niveau du contrat** — le serializer Django réel niche sous
  `Enrichment{}` (`omni-fi-core/.../serializers.py:92-101`) alors que `types.ts:97-99`
  lit les champs À PLAT. Si le sandbox respecte le serializer, `t.CleanMerchantName`
  est toujours `undefined` → 100% des lignes tombent sur le fallback (cause racine
  probable). Logger 1 payload sans PII avant tout code. **Recoupe `GAP-CATEG-NATIVE1`
  (exploitation `primary_category`/`sub_category`)** — PROD-MERCHANT1 en est la tranche
  AFFICHAGE due immédiatement ; GAP-CATEG-NATIVE1 garde le volet score de confiance/
  file de revue (Epic 8.1). **Déclencheur** : ce ticket (irritant visible en démo).

- [ ] **PROD-TRESO-EOD1 (P1) — courbe de trésorerie journalière depuis `RunningBalance`** —
  Effort M, gardien Backend. Ouvert 2026-06-23. PRÉMISSE CORRIGÉE : le « Solde Total »
  n'est PAS déduit des historiques — il vient déjà du `current_balance` instantané ITAV
  (`orchestration.ts:151-153`, `dashboard.ts:179-193`). Le vrai trou = la COURBE 90j
  (`balance_history`) est vide tant qu'Omni-FI ne sert pas `/balances/history` (404
  sandbox). Le serializer transaction expose `RunningBalance` par ligne
  (`omni-fi-core/.../models.py:94-100`) : reconstruire l'EOD réel par compte/devise à
  partir du dernier `RunningBalance` de chaque jour comptable (AT TIME ZONE
  'Indian/Mauritius', E20), sans attendre l'endpoint amont. APPEND-ONLY : `balance_history`
  reste immuable (pas de DELETE). **Lève la décision DR-F3** (solde courant vs EOD) et
  alimente la courbe prévisionnelle. **NON une dette de montants** (lecture/reconstruction,
  pas de FX). **Déclencheur** : ce ticket OU recette « la courbe est vide ».

- [ ] **PROD-UX-REVIEW1 (P1) — review UX/UI profonde via /design-review** —
  Effort L (CC: ~½j par passe), gardien Front + Design. Ouvert 2026-06-23. Passe
  /design-review sur les écrans clés (dashboard, /transactions, /regles, sas entités)
  contre `docs/UI_GUIDELINES.md` : hiérarchie, densités, `tabular-nums`, états
  loading/vide/erreur/partiel, focus visibles, alignement des virgules décimales
  multi-devises. Sortie = findings priorisés, écarts OBJECTIFS (tokens) traités comme
  bloquants (Gate 4), écarts de goût renvoyés en backlog. PAS une refonte from scratch :
  itération sur l'existant. **Déclencheur** : avant le premier déploiement production
  (P1). Raccrocher les findings tokens/sémantique à des sous-tickets datés.

## P2 — après le MVP

### Epic 8 — Intelligence Métier (interview Accountant Omnicane/OL, 2026-06-11)
- [ ] **FEAT-8.1 Moteur de catégorisation auto (Nature/Sous-nature + score de
  confiance)** — Effort M. Priorité `USER_RULE > SYSTEM_RULE > ML_FALLBACK` ; le
  score pilote l'application silencieuse vs la file de revue manuelle ; surcharge
  manuelle = audit immuable + nouvelle USER_RULE. Dépend de : transactions_cache
  alimenté (semaines 3-5).
- [ ] **FEAT-8.2 Dettes & Échéanciers (saisie manuelle)** — Effort M. Emprunts +
  conditions (montant/taux/durée/échéancier), projections de décaissement dans la
  courbe prévisionnelle. Source manuelle au MVP ; `/debt/*` API en automatisation
  ultérieure.
- [ ] **FEAT-8.3 Alertes proactives** — Effort M. (a) liquidités dormantes (solde
  excédentaire stagnant, seuil/durée configurables) ; (b) frais bancaires anormaux
  (écart vs moyenne historique de catégorie, cf. `CategoryAnomalies`). Dashboard +
  email, jamais d'action automatique.


- [ ] **FEAT-3.2 Matrice de flux pivot (Accordion Pivot Table)** — Effort M (CC: ~2j).
  Différé au gate CEO, confirmé par D3 (2026-06-11). Dépend de : Epic 3.1 livré,
  catégories exploitables (Epic 2). Contexte : analyse croisée mensuelle pour DAF.
  Acquis réutilisable : spec UI validé (arbitrages A1-A8, top-nav, tokens @theme,
  centimes entiers) — `~/.gstack/projects/tygr-app/specs/20260611-155303-91653-prototype-ui-s2-app-shell-matrice-flux-mockee.md`.
- [ ] **SSO groupe (Entra ID / Google)** — Effort S (CC: ~2h). Provider Auth.js
  additionnel, zéro refonte (architecture JWT prête). Dépend de : réponse Open
  Question 2 (IdP du groupe). Pré-requis pour l'onboarding à grande échelle.
- [ ] **SSE pour le panneau audit** — Effort S (CC: ~3h). Remplace le polling E17.
  Améliore la scène signature (latence perçue). Dépend de : MVP shippé.
- [ ] **Workspace de consolidation (vue holding cross-workspace)** — Effort M-L.
  Statut selon décision T-C2 du gate final. Le besoin n°1 probable du DAF groupe ;
  modèle de permission read-only cross-tenant à concevoir AVANT tout build.
  Ne contredit pas l'isolation : la démontre (membership explicite).

### Gap Analysis — capacités Omni-FI inexploitées (état des lieux 2026-06-23)

> Issue de l'audit « état des lieux » (Staff Engineer, 2026-06-23) — voir
> `docs/CARTOGRAPHIE-EXISTANT.md` §6. **Trous dans la raquette** pour le persona
> Financial Manager multi-BU : des capacités que l'API Omni-FI FOURNIT
> (`docs/documentation_api.md`) mais que TYGR ne consomme pas encore. Les écarts déjà
> tracés ailleurs ne sont PAS re-dupliqués ici — ils sont **raccrochés** en fin de
> section. Aucune de ces dettes ne touche l'isolation tenant / l'append-only / les
> montants (sinon INTERDITE, règle 9) : ce sont des fonctionnalités absentes.

- [ ] **GAP-WEBHOOK1 (P1, FRONTIÈRE BACKEND) — ingestion pilotée par webhook Omni-FI absente** —
  Effort L, gardien Backend. Ouvert 2026-06-23. Le cahier des charges v2.1 (§1, §2.4,
  FEAT-1.2) fait du **webhook HMAC SHA-256** le cœur de l'architecture d'ingestion
  (résolution `connection → workspace_id` via `tygr_service`, dédup `omnifi_event_id`,
  quarantaine `webhook_events_pending`, enqueue Inngest). Or **aucune route
  `/api/webhooks/omnifi` n'existe** (`src/app/api/` ne contient que `auth/`), et l'API
  expose pourtant toute la surface nécessaire (`PUT /dev/webhooks/config` →
  `WebhookSecret`, `POST /dev/webhooks/rotate-secret`, `POST /dev/webhooks/test`, 13+
  `EventType` dont `sync.completed`/`sync.failed`/`sync.mfa_required`). Conséquence
  métier : la synchro ne se déclenche JAMAIS d'elle-même (cf. `DASH-AUTOSYNC1`). **À
  concevoir dans un chantier dédié** (réception HMAC constant-time + dédup +
  quarantaine + worker) — PAS dans une PR de feature ; surface sécurité (HMAC,
  `tygr_service`) → cross-review obligatoire. **Déclencheur** : DÛ pour un MVP
  production avec fraîcheur de données (sinon données figées entre clics manuels) ;
  pré-requis du runbook de déploiement (config webhook = secret distinct sandbox/prod).
  Complète `DASH-AUTOSYNC1` (piste b) côté push ; le cron (piste a) reste l'alternative
  pull si le push amont n'est pas fiable en sandbox.

- [ ] **[P2] - [TECH-API-INSIGHTS] - Intégration `/insights/cashflow` et `/insights/vendors`** —
  Effort M, gardien Backend. Ouvert 2026-06-23 (ex-`GAP-INSIGHTS1`, renommé 2026-06-23). L'API livre clé en main
  `CashflowRibbon`, `TopVendors`, `CategorySummary`, **`CategoryAnomalies`**,
  `RecurringPayments`, `IncomeInsights`, `Alerts` — qui couvrent **directement
  FEAT-8.3** (alertes : liquidités dormantes, frais bancaires anormaux) et enrichissent
  FEAT-3.1, **sans moteur d'analyse interne à écrire**. TYGR ne consomme aujourd'hui
  aucun endpoint `insights`. Décision d'architecture à poser (le pushback de la règle
  10) : **consommer l'amont** (rapide, mais couple TYGR à la qualité analytique
  Omni-FI et au `clientUserId`) **vs. recalculer en interne** (maîtrise, mais réécrit ce
  qui existe). **Déclencheur** : ouverture du chantier Epic 8.3 (alertes) OU demande
  produit « anomalies de frais ». **Raccroché à FEAT-8.3** (ne pas livrer 8.3 sans
  trancher cette option d'abord).

- [ ] **[P3] - [TECH-API-DEBT] - Module Debt Profiling (`/dashboard/debt`, `/debt/exposure/*`, `/debt/.../repayment`)** —
  Effort M-L, gardien Backend. Ouvert 2026-06-23 (ex-`GAP-DEBT1`, renommé + redescendu P2→P3
  le 2026-06-23 pour s'aligner sur `FEAT-3.3` déjà en P3 ; aucun écran dette n'existe, c'est un
  chantier neuf à cadrer en spec dédiée, pas une dette d'un existant). **FEAT-3.3 (mur de la dette)** et une
  partie de **FEAT-8.2 (échéanciers)** sont disponibles amont sans saisie manuelle :
  `TotalDebt`/`UtilizationRate`, instruments (taux, `NextPaymentDate`/`NextPaymentAmount`,
  `IsOverdue`, `MinimumPaymentAmount`), exposition par institution/devise, et
  **prédiction de remboursement** (`/debt/accounts/{id}/repayment`) qui alimenterait la
  courbe prévisionnelle. Le cahier des charges prévoyait la dette en **saisie manuelle**
  au MVP (FEAT-8.2) — cette dette ouvre l'**alternative API** (moins de saisie, dépend de
  `PartyId` et de la fiabilité sandbox des endpoints debt). **Déclencheur** : ouverture du
  chantier FEAT-3.3/8.2 OU preuve sandbox que `/debt/*` est peuplé. **Raccroché à
  FEAT-3.3 (P3) et FEAT-8.2 (P2)** — re-prioriser ces deux entrées si l'API debt est
  retenue comme source.

- [x] **[P1] - [TECH-API-TRACE] - Capture des métadonnées de classification (`ConfidenceLevel`, `ClassificationSource`, `RuleIdMatch`)** —
  ✅ **LIVRÉ & MERGÉ 2026-06-24 (PR #110)** : migration `0012_classification-metadata` (3 colonnes
  varchar(120) nullable, expand-only, SANS CHECK — résilience aux nouveautés API ; écrite à la main +
  journal idx 12 car DB-MIGRATE3 ; héritage partitions vérifié) + `TransactionAUpserter`/`upsertTransactions`
  (INSERT + onConflict) + `versLignePersistee` (mapping via `chaineOuNull`, indépendant de `categorieValide`,
  `"Low"` conservé). Pas de backfill (acté). Pré-requis de `GAP-CATEG-NATIVE1` désormais satisfait.
  Effort S, **gardien Backend** (tâche ATOMIQUE assignable sans collision — touche uniquement la
  couche ingestion + le schéma, zéro surface Front). Ouvert 2026-06-23 (scindé de
  `GAP-CATEG-NATIVE1` le 2026-06-23 : c'en est la première brique, isolée pour être livrable seule).
  **Le fait, prouvé** : le bloc `Enrichment{}` (`server/omnifi/types.ts:94`) porte 6 champs ; on en
  mappe 3 (`CleanMerchantName`/`PrimaryCategory`/`SubCategory` via `versLignePersistee`,
  `orchestrateur.ts:76-94`) et on **JETTE** `ConfidenceLevel`, `ClassificationSource`, `RuleIdMatch` —
  reçus du payload mais aucune colonne en base (`transactions_cache` n'a que `clean_label`/
  `primary_category`/`sub_category`, `schema.ts:372-374`). Même pathologie que le bug `Enrichment`
  imbriqué (PR #101) : la donnée arrive et est perdue. **Valeur** : distinguer une auto-catégo
  fiable d'une douteuse + tracer la source (`USER_RULE>SYSTEM_RULE>ML`), exigée par la roadmap
  (traçabilité MANUAL/RULE) — prolongement direct du fix PR #101, ratio valeur/effort imbattable.
  **À faire (Back uniquement)** : (1) migration expand `transactions_cache` (+ `confidence_level`,
  `classification_source`, `rule_id_match`, varchar nullable, expand-safe — table partitionnée
  append-only, donc colonnes ADD only, jamais de DROP) ; (2) étendre `TransactionAUpserter`
  (`repositories/ingestion.ts:42`) + le SET du `onConflictDoUpdate` (`upsertTransactions`) ;
  (3) mapper les 3 champs dans `versLignePersistee` via `chaineOuNull` (le serializer pose ""
  par défaut — réutiliser la normalisation existante, ne JAMAIS persister "" brut). **NE PAS** y
  inclure l'exposition en lecture/UI ni la file de revue : ça relève de `GAP-CATEG-NATIVE1` (P2,
  ci-dessous). **Déclencheur** : DÛ — première brique de l'exploitation de l'enrichissement amont
  (priorisé P1 le 2026-06-23, gain immédiat, donnée déjà dans le payload). **NON une dette
  d'isolation** ; touche l'append-only en mode expand-only (colonnes additives, aucune suppression).

- [ ] **GAP-CATEG-NATIVE1 (P2) — chaîne de priorité de classification + file de revue (socle FEAT-8.1)** —
  Effort M, gardien Backend. Ouvert 2026-06-23 (**périmètre réduit le 2026-06-23** : la capture des
  champs enrichis amont en est SORTIE → `TECH-API-TRACE` P1, ci-dessus, pré-requis de ce ticket).
  Le moteur de **règles déterministe** (motif→catégorie) est livré (PR #95, `regles-categorisation.ts`)
  — utile, mais ce n'est PAS FEAT-8.1. Une fois `TECH-API-TRACE` livré (les colonnes de confiance/source
  peuplées), restent : (1) la chaîne de priorité `USER_RULE > SYSTEM_RULE > ML_FALLBACK` (doc API
  §Priorité de classification) qui ARBITRE entre la catégo amont, les règles locales et la ventilation
  manuelle ; (2) le **score de confiance** pilotant l'application silencieuse vs une **file de revue
  manuelle** (exposer `confidence_level` en lecture catégorisée, seuil de bascule en file). **Dépend de
  `TECH-API-TRACE`** (sans les colonnes peuplées, pas de score à exploiter). **Déclencheur** : ouverture
  du chantier FEAT-8.1 (Epic 8). **Raccroché à FEAT-8.1** — précise le périmètre « consommer
  l'enrichissement amont avant tout ML interne ».

- [ ] **[P2] - [DECISION-PRODUIT-OVERRIDE] - Arbitrage : moteur de règles LOCAL vs propagation amont (`/transactions/override`)** —
  Effort S (le dev) mais **bloqué sur une DÉCISION produit AVANT tout code** (règle 10),
  gardien Backend (exécution) + PO (arbitrage). Ouvert 2026-06-23 (ex-`GAP-OVERRIDE1`,
  requalifié de dette technique en décision produit le 2026-06-23 : ce n'est pas un correctif
  à planifier mais un choix d'architecture à trancher). **Le fait** : FEAT-2.2 prévoit que la
  correction manuelle « transmette la directive via `POST /accounts/{AccountId}/transactions/override` »,
  or aujourd'hui la ventilation manuelle (`remplacerSplits`, audit append-only) est **purement
  locale** — l'amont Omni-FI ne ré-apprend jamais des corrections, et une re-synchro peut
  ré-imposer une catégorisation auto divergente. **Les deux options à arbitrer** : (A) **garder
  le moteur local comme seule vérité** (maîtrise totale, zéro couplage, mais divergence assumée
  avec la classification Omni-FI sur le même compte) ; (B) **propager** via un appel best-effort
  à l'override amont après chaque split validé (idempotent, sans PII en log, fail-soft — l'échec
  amont ne casse pas la vérité locale) → aligne les deux classifications, au prix d'un couplage
  sortant. **À trancher par le PO** ; l'exécution (option B) est triviale une fois la décision
  prise. **Déclencheur** : retour utilisateur « mes corrections ne tiennent pas après synchro »
  OU industrialisation de la catégorisation (`TECH-API-TRACE` / chaîne de priorité). **NON une
  dette d'isolation** (la vérité locale reste la ventilation manuelle ; l'override est un signal
  sortant).

**Écarts déjà tracés ailleurs (rappel, NON re-dupliqués)** : synchro auto →
`DASH-AUTOSYNC1` (P1) ; UI multi-entités → `ENTITY-UI1` (P2) ; pré-remplissage sas via
Parties → `ENTITY-PARTY1` (P2) ; courbe/soldes EOD sans source amont → constat « Solde
Total dérivé des soldes courants » + dépendance `/balances/history` (404 sandbox) ;
matrice pivot → `FEAT-3.2` (P2) ; import OCR → `FEAT-1.3` (P3). Voir
`docs/CARTOGRAPHIE-EXISTANT.md` §5 pour la correspondance Épiques → état réel complète.

### Chantiers produit P2 (revue PM/Architecture, 2026-06-23)

- [ ] **PROD-I18N-EN1 (P2) — internationalisation anglaise de l'application** —
  Effort L (transverse), gardien Front. Ouvert 2026-06-23. Vital pour la phase finale
  (démo/sales hors francophones). Aujourd'hui 100% des chaînes UI sont en FR en dur
  (interface FR actée, CLAUDE.md). Périmètre : extraction des chaînes, lib i18n (next-intl
  pressenti, Layer 1 — à valider), bascule FR↔EN, et surtout NE PAS internationaliser le
  FORMATAGE financier qui reste piloté par `format-montant.ts`/`format-date.ts` (devise =
  préfixe symbolique, séparateurs ; un changement de locale ne doit pas casser l'espace
  fine insécable ni la virgule décimale). FYGR a un switch de langue (drapeau, captures) —
  parité attendue. **Déclencheur** : préparation de la démo finale / premier prospect
  anglophone. **Raccroché à la phase de polissage pré-démo** (jamais « un jour »).

- [ ] **PROD-GRAPHS-FYGR1 (P2) — aligner/challenger les graphiques sur FYGR (donut + barres + analyse catégorie)** —
  Effort M, gardien Front + Backend. Ouvert 2026-06-23. FYGR expose un donut « analyse
  par catégorie » + des barres mensuelles par catégorie + un moteur de formules cash-flow
  (captures `docs/benchmarks/FYGR/2_graphics/`). L'API Omni-FI fournit CLÉ EN MAIN
  `CategorySummary`, `TopVendors`, `CashflowRibbon`, `CategoryAnomalies` (endpoint
  `/insights`) — qu'on ne consomme pas. **Décision d'architecture à poser AVANT build
  (règle 10) : consommer l'amont (rapide, couple TYGR à la qualité analytique Omni-FI +
  `clientUserId`) vs recalculer en interne (maîtrise, réécrit l'existant).** Le moteur de
  formules custom FYGR est hors MVP (raccrocher à FEAT-3.2 pivot). **Recoupe directement
  `TECH-API-INSIGHTS`** — PROD-GRAPHS-FYGR1 en est le volet VISUALISATION ; ne pas livrer sans
  trancher l'option insights d'abord. **Déclencheur** : ouverture Epic 8.3 OU demande
  produit « graphiques comme FYGR ». **Raccroché à TECH-API-INSIGHTS + FEAT-3.2.**

### Dette UI + tests relevée en cross-review PROD-MERCHANT1 (2026-06-23)

> Issue de la revue QA/cross-review indépendante du commit `4da3411` (branche
> `feat/prod-merchant-1`, ticket PROD-MERCHANT1). Constats C1 et C2 NON bloquants ;
> divergence et absence de test ASSUMÉES temporairement par le PO pour ne pas retarder
> une release à forte valeur métier (affichage marchand + repli élégant). Aucune de ces
> dettes ne touche l'isolation tenant / l'append-only / les montants (sinon INTERDITE,
> règle 9) : ce sont du polissage d'affichage et de la couverture de test.

- [ ] **TECH-MERCHANT-POLISH1 (P2) — unifier l'affichage de la catégorie OBIE par défaut + tester `traduireCategorieBanque`** —
  Effort S, gardien Front. Ouvert 2026-06-23. Regroupe deux constats de cross-review :
  **(C1)** le Dashboard (`transactions-table.tsx:60`) affiche `categorieFr(t.primaryCategory)`
  qui retombe TOUJOURS sur « Non catégorisé » par défaut, alors que la table /transactions
  (`adapter.ts:93` → `traduireCategorieBanque`) renvoie `null` (sous-texte masqué) quand la
  catégorie est absente/non cartographiée — même donnée OBIE, deux rendus. **(C2)** la
  fonction `traduireCategorieBanque` (`adapter.ts:130`) porte une logique conditionnelle
  non triviale (rejet du défaut vers `null`) sans aucun test unitaire (exit-criteria règle 3 :
  chemin heureux + cartographié + absent/non-cartographié). **Déclencheur** : lors du chantier
  de refonte globale UX/UI ou lors du prochain grand refactor des tableaux de données.

### Dettes ouvertes par L8b-1 (sélecteur de périmètre, 2026-06-30)

Relevées en cross-review de `feat/l8b1-perimetre-switcher` (constats #2/#3/#5,
confiance ≤5/10 — nettoyages, non bloquants). Le câblage sécurité (intersection
serveur RLS, fail-closed) est sain ; ces entrées sont de la réutilisation/efficacité.

- [ ] **UI-CN-DEDUP1 (P2) — extraire le helper `cn` local dans `src/lib/cn.ts`.**
  `cn(...)` est redéfini à l'identique dans `components/shell/perimetre-switcher.tsx`
  et `components/ui/category/category-picker.tsx` (2 copies verbatim ; `workspace-switcher.tsx`
  n'en utilise pas, incohérence préexistante). Toujours zéro dépendance externe (règle 9
  respectée — ce n'est PAS clsx). **Déclencheur** : 3e réutilisation du pattern, OU adoption
  future de `clsx`/`cva`. **Effort** : S.

- [ ] **UI-POPOVER-HOOK1 (P2) — factoriser la mécanique popover (clic-extérieur mousedown
  + Échap capture + focus auto rAF) dans un hook partagé `usePopoverDismiss`.** Réimplémentée
  mot pour mot dans `perimetre-switcher.tsx` et `category-picker.tsx:81-114`. Divergence déjà
  constatée : le `stopImmediatePropagation` du CategoryPicker (Échap qui ne ferme pas une
  modale parente) n'est PAS reporté dans le switcher (simple `stopPropagation`) — bénin tant
  que le switcher reste hors modale (header). **Déclencheur** : 3e popover, OU besoin de monter
  le switcher dans une modale. **Effort** : M.

- [ ] **PERF-LISTERCOMPTES-CACHE1 (P2) — mémoïser `listerComptes` par requête via `React.cache`.**
  Sur le dashboard, `listerComptes` tourne 2× par rendu : `(workspace)/layout.tsx` (pour le
  sélecteur de périmètre) ET `(dashboard)/page.tsx` (pour les cartes), dans deux `withWorkspace`
  distincts (RSC ne partagent pas de transaction). Lecture indexée légère, mais redondante.
  `React.cache(listerComptes)` dédoublonnerait sur un même rendu. **Déclencheur** : profilage
  du TTFB dashboard, OU passage de `listerComptes` à une lecture coûteuse. **Effort** : S.

## P3 — plus tard

- [ ] **FEAT-3.3 Console mur de la dette** — endpoints `/debt/*` disponibles côté API.
- [ ] **FEAT-1.3 Import OCR PDF/CSV** — flux Document Upload documenté côté API.
- [ ] **Epics 2, 4, 5, 6, 7** — différés intégralement ; le schéma v2.1 les anticipe
  (catégories en cache, workspaces multi-devises).
- [ ] **Onboarding self-service + billing SaaS externe** — dépend de la décision
  T-C3 (conflit de canal) ; aucune migration de schéma requise.
- [ ] **Réévaluer bases séparées par tenant (C2)** — si une exigence de conformité
  client externe l'impose (taste T1 du gate : RLS partagée retenue au MVP).
