# TODOS — TYGR

Différés par la revue /autoplan du 2026-06-10 (plan v2.1 multi-tenant Workspace).
Décisions D2 (ré-priorisation UI, 2026-06-11) puis **D3 (annulation de D2, même
jour)** : voir le decision log du plan
(`~/.gstack/projects/tygr-app/clawdy-unknown-design-20260610-120713.md`).

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
- [ ] **5.3 (P2)** — retirer le stub `omnifi-react.d.ts` dès que le vrai package
  privé est installé (le stub fige le contrat ; un changement du tiers échappe au
  typecheck).

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
- [ ] **5.3 (P2) — Stub `@omnifi/react` fige le contrat `onSuccess(string)`** — un
  changement de contrat du widget tiers échappe au typecheck. Retirer le stub dès
  que le vrai package est installé en propre (registre privé).

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
  poser `ENABLE` + `FORCE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation`
  + `REVOKE DELETE FROM tygr_app` à sa création (PostgreSQL n'hérite pas la RLS
  de la mère — cf. constat bloquant cross-review 2026-06-15, corrigé dans 0003
  pour les partitions 2024-2027+DEFAULT). Une partition sans RLS = fuite
  cross-tenant. Ceci relève de l'isolation tenant : à traiter comme tel.

### Dette acceptée au schéma Epic 3 — cross-review (2026-06-15)

Cross-review contradictoire (rôle Sécurité, contexte frais) sur la branche
`feature/epic3-schema`. BLOQUANT corrigé dans 0003 (RLS+FORCE+policy sur les 5
partitions de `transactions_cache`, commentaire faux retiré). #3 PARTIELLEMENT
traité (voir ci-dessous). Différés :

- [ ] **#3bis — Tombstone non garanti par le seul REVOKE de 0003** — Effort S
  (P1, déclencheur : avant 1er déploiement prod). 0003 pose un `REVOKE DELETE`
  conditionnel (IF role exists) sur `transactions_cache`(+partitions) et
  `balance_history`, mais `tygr_app.sql` accorde `DELETE ON ALL TABLES` : selon
  l'ordre provision/migrate le GRANT global peut ré-écraser le REVOKE (cas des
  tests migrate→provision). Garantie définitive = retirer DELETE sur ces 2 tables
  au niveau du provisioning (GRANT ciblé au lieu de ON ALL TABLES + REVOKE).
  Touche la surface sécurité de tygr_app.sql → chantier dédié, hors PR schéma.

- [x] **#2 — Idempotence d'ingestion non garantie par la clé DB** — FAIT 2026-06-15
  (PR 2 ingestion, `feature/epic3-ingestion`). `upsertTransactions`
  (`src/server/repositories/ingestion.ts`) neutralise (is_removed=true) toute
  version antérieure de même `omnifi_txn_id` posée sur un AUTRE
  `transaction_date` AVANT l'upsert sur la clé naturelle → un re-affinement du
  BookingDateTime par l'amont ne crée plus de doublon. RLS scope la mise à jour
  au workspace courant.

### Dette résolue / intégrée à la PR 2 ingestion (2026-06-15)

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
