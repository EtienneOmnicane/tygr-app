# TODOS — TYGR

Différés par la revue /autoplan du 2026-06-10 (plan v2.1 multi-tenant Workspace).
Décisions D2 (ré-priorisation UI, 2026-06-11) puis **D3 (annulation de D2, même
jour)** : voir le decision log du plan
(`~/.gstack/projects/tygr-app/clawdy-unknown-design-20260610-120713.md`).

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

Aucune de ces dettes ne touche l'isolation tenant / l'append-only / les montants.
Plan de référence : `PLAN-transactions-page.md`.

### Findings QA nav + Empty States (UI, 2026-06-17)

- [ ] **Routes `/demo/*` redirigées vers `/login` (P1, sécurité/routing)** —
  relevé par /qa 2026-06-17. Effort S (~2 lignes, gardien Backend). Le matcher
  de `src/proxy.ts:31-33` n'exclut pas `demo` de l'allowlist, donc les routes de
  démo (conçues hors auth/DB pour le Visual QA Gate 4, cf. commentaire de
  `src/app/demo/dashboard-states/page.tsx`) renvoient `307 → /login`. Casse le
  workflow Visual QA documenté en CLAUDE.md. **Déclencheur de résolution** :
  prochaine session Visual QA des états, ou au plus tard avant le premier
  déploiement (P1). À trancher : rendre `/demo` public (ajouter `demo` au
  matcher) OU corriger le commentaire « hors auth » si la protection est voulue.
  Surface auth → ne pas corriger en tant qu'Agent UI.
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

- [ ] **UI-ES1 (P2) — faire dériver `DashboardEmptyState` du `EmptyState` générique**
  — Effort S (déclencheur : merge de `feat/activate-nav-empty-states`). Le composant
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

- [ ] **W4-D1 (P1) — `OMNIFI_ENV` découplé de l'hôte de `OMNIFI_BASE_URL`** — Effort S
  (déclencheur : 1er déploiement prod). `config.ts` valide l'hôte contre l'allow-list
  mais rien ne lie `OMNIFI_ENV` (`sandbox`/`production`) à l'hôte effectif : on peut
  tourner `OMNIFI_ENV=production` pointé sur `stage`, ou l'inverse. `environment`
  devient décoratif → risque opérationnel de viser la prod en croyant être en pré-prod.
  Lier env→hôtes attendus (fail-closed) ou retirer le champ. Relevé par audit sécurité.
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

- [ ] **WIDGET-RD1 (P1) — exposer un flag `complet` sur `EtatFinalisation`** —
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
  `omnifi_connection_id` / `omnifi_account_id` sont UNIQUE globaux (non
  `(workspace_id, …)`) ; une collision d'id cross-tenant + `onConflictDoUpdate`
  fait échouer la finalisation (DoS, PAS IDOR silencieux — la RLS masque la ligne
  étrangère). Durcir en contraintes composites. Touche le schéma → migration
  dédiée + cross-review schéma. Lié à la dette #5 (FK composites).
- [ ] **3.1 — `redirectOrigin` non allowlisté** — Effort S (P1). Le schéma zod
  exige https sans path mais accepte tout host. Un MANAGER pourrait émettre un
  LinkToken pointant un domaine tiers (exfiltration du PublicToken via
  postMessage). Durcir : allowlist des origines TYGR (env `WIDGET_ALLOWED_ORIGIN`).
  Déclencheur : avant exposition du widget en prod.

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

## P3 — plus tard

- [ ] **FEAT-3.3 Console mur de la dette** — endpoints `/debt/*` disponibles côté API.
- [ ] **FEAT-1.3 Import OCR PDF/CSV** — flux Document Upload documenté côté API.
- [ ] **Epics 2, 4, 5, 6, 7** — différés intégralement ; le schéma v2.1 les anticipe
  (catégories en cache, workspaces multi-devises).
- [ ] **Onboarding self-service + billing SaaS externe** — dépend de la décision
  T-C3 (conflit de canal) ; aucune migration de schéma requise.
- [ ] **Réévaluer bases séparées par tenant (C2)** — si une exigence de conformité
  client externe l'impose (taste T1 du gate : RLS partagée retenue au MVP).
