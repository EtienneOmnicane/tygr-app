# PLAN — Courbe de trésorerie EOD depuis `RunningBalance` (PROD-TRESO-EOD1)

> **Phase : PLANIFICATION UNIQUEMENT** (CLAUDE.md règle 1). Aucune ligne de code
> applicatif, aucune migration, aucun schéma modifié ici. Ce document est le livrable de
> conception ; l'implémentation suivra dans un fil séparé, après feu vert humain **et
> après passage du gate §1** (vérification runtime du contrat `RunningBalance`).
> Auteur : session Backend / Architecte données. Date : 2026-07-06.
> Worktree : `treso-eod-plan` (branche `plan/treso-eod`). Chantier : **PROD-TRESO-EOD1**
> (`TODOS.md:1791`, P1, gardien Backend, effort M).
> Références lues : `CLAUDE.md`, `PLAN-cadrage-graphs-fygr.md`, `PLAN-audit-ergonomie-soldes.md`,
> `OMNIFI_API_FEEDBACK.md §10`, `docs/documentation_api.md`.

---

## 0. TL;DR (la décision d'abord)

Le « Solde Total » du dashboard est déjà juste (il vient de `current_balance` instantané,
`dashboard.ts:290` `soldesCourantsParDevise`). **Le vrai trou est la COURBE de trésorerie
historique** : `balance_history` est **vide en permanence** parce que la seule voie qui la
peuple (`synchroniserCompteComplet` → `/balances/history`) est (a) branchée sur un endpoint
Omni-FI **404 / non déployé** (`OMNIFI_API_FEEDBACK.md §10`) et (b) **jamais appelée dans le
chemin de sync réel** (elle ne vit que dans un script de seed). Le dashboard masque le trou
en traçant à la place le **flux net mensuel** (`cashflowParDevise`), pas un solde.

PROD-TRESO-EOD1 propose de **reconstruire l'EOD réel** à partir du champ `RunningBalance`
présent sur chaque transaction, sans attendre l'endpoint amont. **MAIS** ce champ est
`OmniFiAmount | null`, **non documenté** (`docs/documentation_api.md` ne le mentionne nulle
part), et le type prévient qu'il est « souvent `null` en sandbox » (`types.ts:120`).

> **Gate bloquant (§1) : on ne code RIEN tant qu'on n'a pas prouvé, en runtime, que
> `RunningBalance` est (Q1) présent et non-null sur données réelles, (Q2) le solde
> POST-transaction dans la devise du compte, (Q3) ordonnable intra-jour de façon stable.
> Réponse NON à Q1/Q2/Q3 ⇒ le chantier ne part pas (ou pivote vers `/balances/history`
> si Q4 montre qu'il est repassé 200).** La suite (§4) est conditionnée à ce GO.

Deux découvertes de revue à traiter dans le chantier, indépendamment de la source :
- **Bug latent (correctness, règle 8)** : `courbeTresorerie` (`dashboard.ts:307`) somme
  `balance` **sans `GROUP BY currency`** → dès que `balance_history` contient 2 devises, la
  courbe additionne des roupies et des dollars. **À corriger AVANT de la peupler.**
- **Sémantique stock vs flux** : la courbe EOD (un **stock**) n'a pas de point les jours
  sans transaction → gaps. Un solde se **reporte** (carry-forward), il ne « tombe pas à 0 ».
  Décision de comblement à poser (§3.3), distincte du flux net actuel.

---

## 1. ÉTAPE 1 — Vérification du contrat `RunningBalance` (BLOQUANTE, aucun code)

### 1.1 Pourquoi c'est bloquant (l'incertitude, ancrée)

| Fait | Preuve | Conséquence |
|---|---|---|
| `RunningBalance` est typé nullable | `types.ts:120` `RunningBalance?: OmniFiAmount \| null` | Une courbe ne peut pas s'appuyer sur un champ null. |
| Le type prévient : « souvent `null` en sandbox → l'historique de soldes reste vide » | `types.ts:118-119` | La sandbox ne prouve PAS la faisabilité ; il faut des **données réelles**. |
| Le champ n'est **jamais lu** aujourd'hui | `orchestrateur.ts:92-137` (`versLignePersistee` ne le mappe pas) ; absent de `TransactionAUpserter` (`ingestion.ts:46-67`) et de `transactions_cache` (`schema.ts:364-...`, pas de colonne) | Rien ne le persiste : zéro donnée d'observation en base. |
| **La doc ne le documente pas** | `docs/documentation_api.md:889-917` (objet Transaction) **ne liste pas** `RunningBalance` ; `grep RunningBalance docs/` = 0 | On dépend d'un champ **hors contrat écrit**, connu seulement du serializer (`models.py`, cité `TODOS.md:1796-1797`). Un champ non contractuel peut disparaître ou rester vide sans préavis. |
| L'endpoint EOD « propre » est 404 | `OMNIFI_API_FEEDBACK.md §10` (`:202-225`), confirmé « extensions futures » par Omni-FI 2026-06-19 | La dérivation `RunningBalance` est un **contournement**, pas la voie nominale (cf. pushback §3.1). |

Coder l'ingestion/dérivation avant de lever ces points = écrire un pipeline contre un
**contrat fantôme** (le projet a déjà payé ce piège 2× côté Insights : `/v1`, `Enrichment`
imbriqué — cf. `PLAN-cadrage-graphs-fygr.md §6`). On refuse de recommencer.

### 1.2 Questions à poser à Omni-FI (prêtes à transmettre)

> À envoyer tel quel à l'équipe API. Chaque question a une **preuve runtime** associée
> (§1.3) — on n'attend pas seulement une réponse écrite (la doc s'est déjà trompée : `/v1`,
> `client_user_id` snake, `/balances/history` 404), on **observe**.

- **Q1 — Présence & population sur données réelles.** Sur l'endpoint **déployé**
  `GET /accounts/{AccountId}/transactions` (paginé par page), le serializer émet-il
  `RunningBalance` par transaction ? Est-il **peuplé (non-null) pour des connexions
  bancaires RÉELLES** (production), ou seulement structurellement présent / null hors
  sandbox ? *(La doc §Transactions ne le liste pas ; le type dit « souvent null en
  sandbox ».)*
- **Q2 — Sémantique.** `RunningBalance` est-il le **solde du compte APRÈS** l'application de
  la transaction (running balance post-opération), exprimé dans la **devise du compte** ? À
  quel **type de solde OBIE** correspond-il (`ITAV` / `CLBD` / `CLAV` …) ? *(Détermine que
  « dernier `RunningBalance` du jour » = solde de clôture EOD.)*
- **Q3 — Ordre intra-jour.** Quand plusieurs transactions partagent un même **jour
  comptable** (voire un `BookingDateTime` identique), existe-t-il un **ordre stable et
  monotone** pour désigner la DERNIÈRE opération du jour : un numéro de séquence, un
  `BookingDateTime` à la sous-seconde, ou une garantie que `RunningBalance` suit l'ordre de
  booking ? *(Sans ça, « dernier solde du jour » est ambigu sur les ex æquo de timestamp.)*
- **Q4 — État de `/balances/history`.** L'endpoint dédié
  `GET /accounts/{AccountId}/balances/history` (série EOD, `docs:836`) est-il **toujours
  404 / non déployé**, ou a-t-il été livré depuis le 2026-06-19 ? *(S'il est repassé 200,
  c'est la source correcte — déjà câblée via `historiqueSoldes`/`synchroniserCompteComplet`
  — et la dérivation `RunningBalance` devient un simple repli.)*
- **Q5 — Profondeur & stabilité.** L'endpoint transactions paginé remonte-t-il **assez
  d'historique** pour bâtir une courbe 90 j, et un **re-sync renvoie-t-il les mêmes
  `RunningBalance`** (idempotence) pour que la re-dérivation soit déterministe ?

### 1.3 Preuve runtime (read-only, ZÉRO PII — même discipline que l'audit cadrage §7)

Un script Node jetable (`node --env-file=.env <script>`), qui **n'imprime QUE** : méthode,
chemin, code HTTP, **présence/forme des clés** et des **compteurs** — **jamais une valeur**
(aucun montant, aucun libellé, aucun secret, aucune donnée bancaire ; règle 8) :

1. **Q4 d'abord** : `GET /accounts/{id}/balances/history` → imprimer le **code HTTP** seul.
   Si `200` : re-jouer l'audit §10 (schéma de succès réel) et **basculer la recommandation**
   vers cette source (§3.1). Si `404` : continuer.
2. **Q1/Q2/Q3** : `GET /accounts/{id}/transactions` sur **une connexion réelle** (ou la
   meilleure fixture sandbox disponible), et pour chaque compte imprimer uniquement :
   - `nbTransactions`, `nbAvecRunningBalanceNonNull` (⇒ **taux de couverture**) ;
   - la **présence** des clés `RunningBalance.Amount` / `RunningBalance.Currency` et si
     `Currency` == devise du compte (booléen agrégé, jamais la valeur) ;
   - pour un **jour à ≥2 transactions** : la **précision de `BookingDateTime`** (date seule
     vs horodatage sous-seconde) et le **nombre de timestamps distincts** dans le jour
     (⇒ ambiguïté d'ordre Q3), sans imprimer les timestamps.

### 1.4 Critère GO / NO-GO (le gate)

| Observation | Verdict |
|---|---|
| Q4 = `/balances/history` repassé **200** | **PIVOT** : source = endpoint dédié (§3.1). Lots §4 adaptés (pas de colonne `running_balance`, on branche `synchroniserCompteComplet` dans le chemin réel). |
| Q1 couverture non-null **≈ 100 %** sur réel **ET** Q2 = solde post-tx devise compte **ET** Q3 = ordre stable | **GO** dérivation `RunningBalance` — lots §4 tels quels. |
| Q1 couverture partielle/nulle sur réel, **ou** Q2 ambigu, **ou** Q3 sans ordre stable | **NO-GO / STOP** : on ne fabrique pas une courbe sur une donnée trouée. Synthèse à l'humain (règle 7) : rester sur le flux net actuel + tracer la dette « courbe EOD en attente d'Omni-FI ». |

> Sortie de §1 = un **compte-rendu daté** (couverture non-null, sémantique, ordre) + le
> verdict. C'est LUI qui débloque §4. Aucune écriture en base, aucune donnée réelle
> manipulée hors lecture.

---

## 2. État des lieux (ancré `fichier:ligne`)

### 2.1 Le pipeline de solde EOD existe déjà… mais mort-né

| Brique | Fichier | État |
|---|---|---|
| `upsertSoldes` (INSERT `balance_history` ON CONFLICT DO UPDATE) | `ingestion.ts:234-255` | ✅ Écrit. UPDATE permis (append-only **au DELETE** seulement, règle 8) → re-dérivation OK. |
| `historiqueSoldes` (`GET /balances/history`) | `client.ts:307-320` | ✅ Écrit, mais cible un endpoint **404** (`OMNIFI_API_FEEDBACK.md §10`). |
| `synchroniserCompteComplet` (transactions **+** soldes via `historiqueSoldes`) | `index.ts:72-112` | ⚠️ **Seul appelant = `scripts/seed-omnifi-demo.ts:167`** (seed). Jamais dans le chemin réel. |
| `courbeTresorerie` (lecture EOD → `PointCourbe[]`) | `dashboard.ts:307-332` | ⚠️ Prête mais lit une table **vide** ; **non importée** par le dashboard ; **bug cross-devise** (§3.2). |
| `soldeConsolideCourant` (dernier EOD par compte) | `dashboard.ts:246-277` | ⚠️ Dépend de `balance_history` (vide) ; pas d'appelant vivant. |
| Table `balance_history` (`PK (bank_account_id, balance_date)`, `balance numeric(15,2)`, `currency char(3)`, RLS tenant) | `schema.ts:458-480` | ✅ Structurellement OK. Pas d'`entity_id` (hérite du scope par jointure `bank_accounts`, ENTITY-READ-JOIN1). |

### 2.2 Le chemin de sync RÉEL n'écrit aucun solde

- Le chemin vivant est **`synchroniserCompte`** (`orchestrateur.ts:150-224`) : transactions
  par page → `upsertTransactions` → `marquerSynchronise` → `appliquerRegles`. **Aucun appel
  à `historiqueSoldes` / `upsertSoldes`.** Appelé par le flux widget
  (`widget/orchestration.ts:978, :1278`) et la re-synchro (`banques/actions.ts:370`).
- Donc **en production `balance_history` reste vide** — et le resterait même si
  `/balances/history` repassait 200, tant que c'est `synchroniserCompteComplet` (seed-only)
  qui le peuple. **C'est le point d'insertion de PROD-TRESO-EOD1.**

### 2.3 Ce que le dashboard trace aujourd'hui à la place

- `page.tsx:96-98` : « Courbe = **FLUX net mensuel** dérivé des transactions
  (`cashflowParDevise`) ; balance_history vide → la courbe de solde restait muette. »
- `page.tsx:128` : filtre **mono-série** sur `base_currency` (dette DASH-CASHFLOW-MULTISERIE).
- `courbeTresorerie` **n'est pas** importée dans `page.tsx`. La carte flux
  (`flux-tresorerie-card.tsx`, cf. `PLAN-cadrage-graphs-fygr.md §3.3`) toggle **Barres/Courbe**
  mais les deux représentent le **flux net**, pas un solde.

---

## 3. Pushback / risques d'architecture (CLAUDE.md règle 10)

### 3.1 La source « propre » reste `/balances/history` — la dérivation est un contournement

`RunningBalance`-dérivé **reconstruit** ce qu'Omni-FI expose nativement via l'endpoint EOD
dédié (aujourd'hui 404). Risque : on bâtit une mécanique de dérivation que l'amont peut
**rendre caduque** au prochain déploiement. **Décision assumée** : on la construit quand
même car (a) la courbe est vide **aujourd'hui** et le déclencheur (« recette : la courbe est
vide », `TODOS.md:1802`) est dû ; (b) le coût est borné et **réversible** — le jour où Q4
passe 200, on rebranche `synchroniserCompteComplet` (déjà écrit) et la dérivation devient un
repli derrière un flag. **Garde-fou** : Q4 (§1.3) est vérifié EN PREMIER à chaque itération ;
si 200, on pivote au lieu de dériver.

### 3.2 Bug latent (correctness) : `courbeTresorerie` additionne les devises

`dashboard.ts:307-332` fait `sum(${balanceHistory.balance})` avec `groupBy(balanceDate)`
**seul** — pas de `currency`. Un workspace MUR+USD verrait la courbe **additionner roupies +
dollars** (viole règle 8 « jamais d'addition cross-devise », comme l'ex-`syntheseMois`
`@deprecated` `dashboard.ts:334`). Tant que la table est vide c'est dormant ; **peupler la
table ARME le bug**. → **À corriger dans le même chantier, AVANT tout `upsertSoldes` réel** :
`GROUP BY (balance_date, currency)` → `PointCourbe` par devise (calqué sur
`soldesCourantsParDevise` `:290` et `cashflowParDevise`). C'est un **gate de correctness**,
pas une option.

### 3.3 Sémantique stock vs flux : comblement des jours sans transaction

Un `RunningBalance` n'existe **que les jours à transaction**. Un solde est un **stock** : il
persiste jusqu'à la prochaine opération (il ne « retombe pas à 0 »). Si `courbeTresorerie` ne
renvoie que les jours à mouvement, la courbe est **trouée / en dents de scie**. Options :
- **(A) recommandée** — Backend **honnête** : `balance_history` ne contient QUE des EOD
  réels (jours à transaction) ; le **report** (carry-forward jusqu'à aujourd'hui) est un
  **helper de rendu pur** côté Front (comme `grilleMois`/`flux-projection.ts`). Pas de ligne
  fabriquée en base (append-only reste factuel).
- (B) Matérialiser des lignes EOD reportées en base : rejeté — pollue une table append-only
  avec des points non observés, coûteux, et re-dérivation fragile.

Corollaire **anti-DR-F3** : on **n'injecte JAMAIS** `current_balance` (instantané, ITAV) comme
un point EOD de `balance_history` — mélanger solde instantané et clôture est exactement
l'anti-pattern DR-F3 (`PLAN-audit-ergonomie-soldes.md` C3, CLAUDE.md « Fraîcheur du solde »).
Le bord droit de la courbe est prolongé au rendu et **ancré/validé** par `current_balance`,
sans l'écrire.

### 3.4 Ordre intra-jour & ex æquo (dépend de Q3)

« Dernier `RunningBalance` du jour » suppose un ordre. Si `BookingDateTime` est à la
sous-seconde et distinct → `ORDER BY booking_date_time DESC` suffit. Si des ex æquo existent
et qu'aucune séquence OBIE n'est fournie (Q3 = non), on **départage sur une clé stable mais
arbitraire** (`omnifi_txn_id`) et on **documente** l'ambiguïté résiduelle (EOD potentiellement
faux d'un cran sur un jour à opérations de timestamp identique). À défaut de Q3, c'est une
**imprécision connue et tracée**, pas un bug silencieux.

### 3.5 Réconciliation (garde-fou de validation, pas un gate dur)

Le dernier EOD dérivé doit ≈ `current_balance` **quand la dernière transaction est récente**,
et **diverger légitimement** quand elle est ancienne (le solde a pu bouger hors scraping :
intérêts, frais). → Utiliser l'écart comme **sanity-check** de recette (log/diag), **jamais**
comme condition de rejet d'ingestion.

### 3.6 Décision de persistance : colonne `running_balance` vs accumulation mémoire

- **(A) recommandée** — Persister `running_balance` (numeric(15,2) **nullable**) sur
  `transactions_cache`, puis **dériver l'EOD en SQL** (`DISTINCT ON (transaction_date)
  … ORDER BY transaction_date, booking_date_time DESC, omnifi_txn_id`). **Pour** :
  dérivation **reproductible & testable** depuis la donnée stockée, re-jouable à volonté,
  indépendante de l'ordre d'arrivée des pages ; réutilise `normaliserMontant`. **Contre** :
  une migration **expand** (ajout colonne nullable) sur `transactions_cache` (partitionnée) —
  backward-compatible, se propage aux partitions, mais c'est un changement de schéma.
- (B) Accumuler le dernier `RunningBalance`/jour **en mémoire** dans la boucle de pages de
  `synchroniserCompte`, upsert en fin. **Pour** : zéro migration. **Contre** : exige toutes
  les pages dans un même run, gère l'ordre inter-pages à la main, **non re-dérivable** hors
  ingestion, plus dur à tester. → Rejeté sauf si la migration est jugée trop coûteuse.

> **Note règle 1/9** : la migration (A) touche le schéma → **hors périmètre du correctif
> ≤20 lignes** ; elle suit le pipeline `provision → migrate → deploy` et le principe
> expand-contract (backward-compat avec le code N-1). L'ajout d'une colonne nullable ne
> requiert aucun GRANT nouveau (SELECT/INSERT/UPDATE déjà couverts ; **pas** de DELETE —
> `transactions_cache` reste hors liste blanche, append-only).

---

## 4. Lots d'implémentation (numérotés, avec risques)

> **Séparation nette exigée par le chantier** : les lots **L1→L4 sont BACKEND-TESTABLES**
> (ingestion, dérivation, agrégat, multidevise — prouvables par tests unit/isolation sans
> UI) ; les lots **F1→F2 sont FRONT** (branchement visuel au dashboard) et **différés** (pas
> d'accès front aujourd'hui). Tout L* est conditionné au **GO du §1**.

### 🔒 L0 — Gate contrat `RunningBalance` (BLOQUANT, §1) — *aucun code*
Livrable : compte-rendu runtime (Q1–Q5) + verdict GO/NO-GO/PIVOT. **Rien ne démarre sans.**

### — BACKEND-TESTABLES —

### L1 — Contrat & persistance de `RunningBalance` (schéma + mapping)
- **Migration expand** : `transactions_cache.running_balance numeric(15,2) NULL` (se propage
  aux partitions ; aucun GRANT/DELETE nouveau ; append-only intact).
- Étendre `TransactionAUpserter` (`ingestion.ts:46`) + le `set` de `upsertTransactions`
  (`:204-227`) avec `runningBalance: string | null` (idempotent, reflète l'état amont courant
  comme les autres champs).
- Mapper dans `versLignePersistee` (`orchestrateur.ts:92`) : `runningBalance = t.RunningBalance
  ? normaliserMontant(t.RunningBalance.Amount) : null` + **valider** `t.RunningBalance.Currency
  === t.Amount.Currency` (sinon `null` + log code sans PII : incohérence devise).
- **Tests (unit)** `ingestion-conversion` / `ingestion-orchestrateur` : null→null ;
  présent→normalisé ; `>2` décimales significatives → rejet (réutilise la garde
  `normaliserMontant` `conversion.ts:41`) ; devise incohérente → null.
- **Risques** : migration sur table partitionnée (valider la propagation aux partitions de
  roulement) ; un `RunningBalance` à 4 décimales OBIE (`« 750.0000 »`) — déjà géré par
  `normaliserMontant`.

### L2 — Dérivation EOD + persistance dans le CHEMIN RÉEL
- **Repository** `deriverSoldesEodDepuisTransactions(tx, bankAccountId)` (nouveau, dans
  `ingestion.ts` ou `dashboard.ts` selon lecture/écriture) : `SELECT DISTINCT ON
  (transaction_date) transaction_date, running_balance, currency FROM transactions_cache
  WHERE bank_account_id = $1 AND is_removed = false AND running_balance IS NOT NULL ORDER BY
  transaction_date, booking_date_time DESC, omnifi_txn_id` → liste `SoldeAUpserter`.
- **Brancher dans `synchroniserCompte`** (`orchestrateur.ts`, APRÈS la boucle de pages,
  autour de `marquerSynchronise`) : dériver puis `upsertSoldes`. **Isolé en best-effort**
  (try/catch + log code sans PII), **exactement comme `appliquerRegles` `:209-221`** — une
  dérivation de solde bancale ne doit jamais faire perdre des transactions déjà persistées.
- **Repurposer** `synchroniserCompteComplet` (`index.ts:72`) : la branche `/balances/history`
  devient le **repli conditionné à Q4=200** (gardée), sinon la dérivation L2 est la source.
- **Tests (unit + isolation)** :
  - unit dérivation : jour à N transactions → **dernier** `RunningBalance` retenu ; jour sans
    `running_balance` non-null → **absent** ; tombstone (`is_removed`) **exclu** ; ex æquo de
    timestamp → départage déterministe (`omnifi_txn_id`).
  - **idempotence** : re-sync ⇒ même EOD (UPDATE via ON CONFLICT, pas de doublon).
  - **isolation** (`ingestion-isolation` / `dashboard-isolation`) : l'EOD écrit/lu respecte
    tenant (`workspace_id` de `ctx`) ET scope entité (héritage par jointure `bank_accounts`).
- **Risques** : ordre intra-jour (§3.4, dépend de Q3) ; pages ré-affinant `transaction_date`
  d'une transaction (la neutralisation `is_removed` de `upsertTransactions:172-180` doit être
  respectée par le filtre `is_removed = false` — c'est le cas).

### L3 — Durcissement `courbeTresorerie` (correctness, cross-devise)
- **`GROUP BY (balance_date, currency)`** → `PointCourbe` **par devise** (nouveau champ
  `currency`), calqué sur `soldesCourantsParDevise:290`. Supprime le bug §3.2. Conserver la
  jointure `bank_accounts` (ENTITY-READ-JOIN1) et les bornes `[from, to]`.
- **Tests (isolation)** `dashboard-cas-limites` / `dashboard-isolation` : workspace 2 devises
  → **aucune addition cross-devise** (une série par devise) ; bornes de fenêtre inclusives ;
  scope entité (Vision Entité masque les comptes hors périmètre ; Vision Globale inchangée).
- **Risque** : changement de **signature de retour** (`PointCourbe` gagne `currency`) → les
  appelants doivent suivre. Aujourd'hui **aucun appelant applicatif vivant** (`page.tsx` ne
  l'importe pas) → changement sûr, mais à faire AVANT L(F1).

### L4 — Agrégat multidevise & report (couche lecture, sans UI)
- Exposer la courbe **multi-série par devise** (déjà rendu possible par L3) prête pour le
  Front, alignée sur la logique DASH-CASHFLOW-MULTISERIE (une série/devise, jamais de FX).
- **Helper de report PUR** (carry-forward, §3.3) testable hors DB/`Date` (comme `grilleMois`
  `dashboard.ts:497` et `flux-projection.ts`) : à partir des EOD réels + bornes, produire un
  axe continu (dernier solde connu reporté). **Aucune écriture** — pur.
- **Tests (unit)** `flux-projection-courbe`-like : trous comblés par report ; bord droit
  prolongé jusqu'à `to` ; multi-devise (séries indépendantes) ; workspace vide → série vide.
- **Risque** : le report est de la **présentation** — ne jamais le confondre avec une donnée
  observée (garder la frontière donnée/rendu nette).

### — FRONT (DIFFÉRÉS — pas d'accès front aujourd'hui) —

### F1 — Branchement visuel au dashboard (courbe SOLDE) + cohabitation flux
- Importer `courbeTresorerie` dans `page.tsx` (aujourd'hui absent) sous le **même
  `withWorkspace`/`Promise.all`** que les autres services, piloté par le preset de période
  (`resoudrePeriode`).
- **Décision de cohabitation (à trancher §5, portée Front)** : la courbe EOD (**stock** =
  vraie trésorerie) et le flux net mensuel (`cashflowParDevise`, **flux**) sont deux
  sémantiques distinctes. Options : (a) **carte trésorerie = solde EOD** distincte de la
  carte flux (recommandé : ce que le FM appelle « ma courbe de tréso ») ; (b) 3e mode dans le
  toggle de `flux-tresorerie-card` (Barres/Courbe-flux/**Solde**) ; (c) remplacer le flux par
  le solde. Recommandation : **(a)** — ne pas écraser le flux, ajouter le solde.
- Multi-série par devise (aligne DASH-CASHFLOW-MULTISERIE) + report au rendu (helper L4).
- **Visual QA (Gate 4)** obligatoire : états loading/vide/erreur/partiel de la courbe,
  `tabular-nums`, tokens sémantiques, 0 addition cross-devise visible.

### F2 — Résolution DR-F3 (solde courant vs EOD) — cross-link audit soldes
- La courbe EOD fournit enfin des **dates de points réelles** → la date du dernier point
  **reste sur la courbe** ; le solde COURANT porte la **pastille de fraîcheur** (`lastSyncedAt`,
  `PLAN-audit-ergonomie-soldes.md §2.2`, CLAUDE.md « Fraîcheur du solde »), **jamais** « au
  JJ/MM » dérivé d'un EOD. Ce lot **consomme** L1–L4 ; il est le complément d'affichage de
  DR-F3 (déjà spécifié côté carte solde par le chantier ergonomie).

---

## 5. Décisions à trancher (humain — NON tranchées ici)

1. **Source EOD** : dérivation `RunningBalance` (défaut, si GO §1) **vs** attente/repli
   `/balances/history` (si Q4=200). *Tranché par le runtime du §1, pas par préférence.*
2. **Persistance** (§3.6) : **colonne `running_balance` + dérivation SQL** (recommandé,
   reproductible) **vs** accumulation mémoire (zéro migration). → impacte L1/L2.
3. **Comblement des trous** (§3.3) : **report au rendu, base factuelle** (recommandé) vs
   matérialisation en base (rejeté). → impacte L4/F1.
4. **Cohabitation courbe** (F1) : **carte solde distincte du flux** (recommandé) vs toggle
   3-états vs remplacement. → décision **Front**, à confirmer au lot F1.
5. **Ambiguïté d'ordre intra-jour** (§3.4) : accepter le départage arbitraire tracé si Q3=non
   (recommandé) vs bloquer jusqu'à séquence OBIE. → impacte L2.

---

## 6. Séquencement & dépendances

```
L0 (gate §1) ──GO──▶ L1 (colonne + mapping) ──▶ L2 (dérivation EOD, chemin réel)
                                   │
                                   └──▶ L3 (fix cross-devise courbeTresorerie) ──▶ L4 (multidevise + report)
                                                                                        │
                                        [plus tard, accès front] ────────────────────▶ F1 (branchement) ──▶ F2 (DR-F3)
```

- **L3 est un pré-requis de correctness** avant tout affichage (peupler sans L3 = armer le
  bug cross-devise) — le faire tôt, indépendamment de F1.
- Chaque lot = **PR séparée** (Human-in-the-Loop, branche `feat/*` depuis `main` à jour) ;
  L1 (migration) suit `provision → migrate → deploy` et expand-contract (règle 9).
- **Exit criteria par lot backend** (règle 3, rappel) : authz via `withWorkspace` (jamais de
  `workspace_id` paramètre) ; erreurs nommées (pas de catch-all silencieux — sauf le
  best-effort **tracé** de L2, calqué `appliquerRegles`) ; tests chemin heureux + échec + cas
  limite (jour vide, null, ex æquo, tombstone, concurrence de re-sync) ; logs structurés sans
  PII ; **suite isolation IDOR verte** (bloquante CI).
- **Dette INTERDITE** (règle 9) : le correctif cross-devise L3 touche un **montant** → se
  corrige, ne se consigne pas. L'isolation tenant/entité (héritage par jointure) est
  non-négociable sur toute lecture/écriture EOD.

---

## 7. Ce que ce plan n'inclut PAS (anti-scope-creep)

- **Pas de FX / conversion de devise** : PROD-TRESO-EOD1 est de la reconstruction de solde,
  **pas** de montants convertis (règle 8 ; DASH-FX1 reste séparé). Multi-devise = séries
  côte à côte, jamais additionnées.
- **Pas de refonte du flux net** (`cashflowParDevise`) ni de la carte flux — on **ajoute** le
  solde, on ne réécrit pas l'existant.
- **Pas de branchement front** livré maintenant (L(F1/F2) explicitement différés, faute
  d'accès front) — mais spécifiés pour que le fil suivant les prenne sans re-cadrage.
- **Pas de client `/balances/history` neuf** : il existe (`historiqueSoldes`) ; on le
  rebranche seulement si Q4 passe 200.
