# SPEC — Reconstruction de la courbe de solde EOD depuis `RunningBalance`

> **Phase : CONCEPTION UNIQUEMENT** (CLAUDE.md règle 1). Aucune ligne de code applicatif,
> aucune migration écrite, aucun schéma modifié par ce document. Le pseudo-SQL et les
> signatures ci-dessous sont de la **spécification**, pas du code à copier.
> Date : 2026-07-23 · Branche : `plan/treso-eod` · Chantier : **PROD-TRESO-EOD1**
> (`TODOS.md:3500`, P1, gardien Backend).

## 0. Rapport au plan de cadrage — ce document COMPLÈTE, il ne remplace pas

Le cadrage existe déjà : **`PLAN-prod-treso-eod.md`** (racine, 386 l., mergé PR #248,
2026-07-06). Il porte le **gate contrat** (§1), le **pushback d'architecture** (§3), le
découpage en lots **L0→L4 / F1→F2** (§4) et le séquencement (§6). Rien de tout cela n'est
recopié ici — s'y référer.

Ce document apporte les six pièces que le cadrage ne traite pas ou traite à tort, et qui
sont exactement le périmètre demandé :

| § | Apport | Statut dans le cadrage du 2026-07-06 |
|---|---|---|
| 2 | Algorithme d'élection EOD **formel**, fuseau Maurice explicité (E20) | Esquissé en une ligne de SQL, **fuseau jamais traité** |
| 3 | Report des jours sans transaction + **piège du consolidé multi-comptes** | Principe posé (§3.3), piège du consolidé **absent** |
| 4 | Perte de pagination ~5 % → **EOD faux**, et son détecteur | **Absent** (le DIAGNOSTIC est du 2026-07-20, postérieur) |
| 5 | Persistance append-only, migration expand, **piège des 4 décimales** | Traité, mais avec une **affirmation fausse** (§5.4) |
| 6-7 | Critères de sortie règle 3 + plan de tests aux bornes de fuseau | Listés en vrac, sans les cas de bord décisifs |
| 8 | Décisions ouvertes (9, avec recommandation) | 5, dont 3 reconduites ici |

**Le gate §1 du cadrage reste BLOQUANT et n'a pas été passé** : aucun compte-rendu runtime
n'existe au dépôt (`grep RunningBalance *.md` ne remonte que le plan lui-même et TODOS).
Le brief de ce fil pose la reconstruction comme acquise ; §1.1 ci-dessous montre ce que le
source amont permet de **retirer** du gate et ce qui y **reste** — la spécification est
écrite au complet, sous cette hypothèse explicitement nommée.

---

## 1. Faits neufs depuis le cadrage (2026-07-06)

### 1.1 Le contrat `RunningBalance` est lisible dans le source amont — Q2 est répondue

Le clone local `omni-fi-core` répond par le code à deux des cinq questions que le cadrage
comptait poser à Omni-FI :

| Question du cadrage | Réponse ancrée | Source |
|---|---|---|
| **Q2 — sémantique** | « Account balance **after this transaction**. 4 decimal places for FX precision. » `DecimalField(max_digits=20, decimal_places=4, null=True)` | `apps/transactions/models.py:94-100` |
| **Q2 — devise** | `{'Amount': str(running_balance), 'Currency': obj.currency}` → la devise émise est celle **de la transaction**, pas celle du compte. `None` si le champ est nul. | `apps/transactions/serializers.py:74-80` |
| **Q1 — population** | `'balance': raw_txn.get('balance') or raw_txn.get('running_balance')` puis `if parsed.get('balance'): running_balance = Decimal(...)` → dépend **entièrement de ce que l'extracteur de la variante fournit**. | `apps/sync_engine/services/etl_pipeline.py:150`, `:198-201` |

**Ce qui reste ouvert (donc le gate reste dû, réduit)** : les extracteurs vivent sur la
branche `staging` d'`omni-fi-core` (déployée sur `api-stage`) ; le clone local est sur
`main`, où `apps/scraping/extractors/api/` est **vide**. Impossible de vérifier par lecture
si `mcb_pro` / `sbm_pro` / `absa` peuplent `balance` par transaction. **Q1 (taux de
couverture non-null sur nos 3 connexions réelles) reste la seule question bloquante** —
Q3 (ordre) est traitée en §2.3, Q4/Q5 restent des questions à l'amont.

> **Piège du zéro (à vérifier au gate, avec Q1)** : `if parsed.get('balance'):` est un test
> de **véracité Python**. Si l'extracteur renvoie le solde en `Decimal(0)` / `0` / `""`, un
> compte à **solde exactement nul** un jour donné produit `running_balance = None` — le jour
> perd son EOD sans erreur. Si le solde est une **chaîne** `"0.00"`, le test passe. Le
> comportement dépend du type émis par l'extracteur : à observer, pas à supposer.

### 1.2 La profondeur est bornée à 92 j en amont — la courbe 90 j est « tout juste »

`DIAGNOSTIC-profondeur-historique.md` (2026-07-20, confiance 10/10) : `mcb_pro_extractor`
impose une fenêtre de **92 jours en dur** et **ignore** `history_from_date`
(`mcb_pro_transactions.py:54-62` ; motif identique sur `absa_pro.py:694-706`). Observé en
base : MCB s'arrête net au 2026-04-13 (91 j), SBM à 37 j, Absa à 58 j.

Conséquences directes sur cette spécification :

- Une courbe **90 j** est structurellement réalisable pour MCB (92 ≥ 90), avec **2 jours de
  marge** — et elle est **impossible à remplir** pour SBM (37 j) et Absa (58 j).
- Le bord gauche d'un compte est le **premier jour à transaction connue**, pas `from`.
  **Aucune extrapolation vers l'arrière n'est légitime** (§3.1) : on ne connaît pas le solde
  antérieur à la première transaction servie.
- Donc la courbe **consolidée** additionne des comptes dont les historiques **commencent à
  des dates différentes** → marche d'escalier artificielle (§3.3). C'est un défaut de
  correctness du consolidé, pas un défaut d'affichage.

### 1.3 La pagination par offset perd ~5 % des lignes sur une passe isolée

`DIAGNOSTIC` §7-B (confiance 9/10) : 1 923 lignes servies pour **1 821 `TransactionId`
distincts** sur 20 pages (102 doublons) — tri non déterministe sur `-booking_date_time` avec
ex æquo : ce qui est dupliqué sur une page est **omis ailleurs**. L'upsert idempotent fait
converger les passes successives, mais **une synchro unique n'est pas complète**.

C'est le fait le plus lourd pour ce chantier, et il est **postérieur au cadrage** : il ne
dégrade pas la courbe en la trouant, il la rend **fausse en silence** (§4.1).

---

## 2. Algorithme de reconstruction EOD

### 2.1 Définition — le regroupement est LOCAL, l'ordre est ABSOLU

C'est la distinction qui porte toute la correction de fuseau (E20) :

- **Le jour comptable** (à quel jour appartient une transaction) est une notion **locale
  Maurice**. Il est **déjà matérialisé** : `transactions_cache.transaction_date` est dérivée
  à l'ingestion par `deriverDateComptableMaurice` (`conversion.ts:57-70`, epoch + 4 h, sans
  heure d'été), appelée en `orchestrateur.ts:123`. La colonne porte le commentaire « Date
  comptable Maurice, dérivée de booking_date_time (E20) » (`schema.ts:419-420`).
- **L'ordre entre deux transactions** est une notion **absolue**. Il se lit sur
  `booking_date_time` (`timestamptz`, UTC) — un instant est ordonnable sans fuseau.

> **Interdit structurant** : ne JAMAIS regrouper l'EOD sur `booking_date_time::date`, ni sur
> `date_trunc('day', booking_date_time)`. Ces expressions donnent le jour **UTC**, décalé de
> 4 h. Deux seules formes sont admises : la colonne `transaction_date`, ou
> `(booking_date_time AT TIME ZONE 'Indian/Mauritius')::date` — qui doivent coïncider
> (invariant testé, §7-E1). La première est préférée : elle est indexable et déjà calculée.

**Frontière exacte** : minuit à Maurice = **20:00:00 UTC** la veille. `…T19:59:59Z` → jour J ;
`…T20:00:00Z` → jour J+1. Le cas « 22 h UTC » du brief est donc **deux heures après** la
bascule ; les tests doivent viser la bascule elle-même, pas seulement 22 h (§7).

### 2.2 Élection du représentant du jour

Pour un compte `c` (devise `D_c`) et une fenêtre `[from, to]` exprimée en **jours comptables
Maurice** :

```
Sélection    : transactions de c
               WHERE is_removed = false                    -- tombstone exclu
                 AND running_balance IS NOT NULL            -- pas de point fabriqué
                 AND currency = D_c                         -- garde de devise (§2.4)
                 AND transaction_date BETWEEN from AND to    -- bornes LOCALES Maurice

Élection     : DISTINCT ON (transaction_date)
               ORDER BY transaction_date,
                        booking_date_time DESC,             -- instant absolu, le plus tardif
                        omnifi_txn_id      DESC             -- départage stable des ex æquo

Projection   : (bank_account_id, balance_date = transaction_date,
                balance = running_balance, currency = D_c)
```

Propriétés attendues :

- **Déterministe** : deux exécutions sur la même donnée élisent la même transaction, y
  compris sur ex æquo de `booking_date_time` (le tri final sur `omnifi_txn_id` est arbitraire
  mais **stable** — imprécision connue et tracée, décision D8).
- **Indépendante de l'ordre d'arrivée des pages** : elle lit la base, pas le flux. C'est
  l'argument décisif pour l'option (A) du cadrage §3.6 (colonne persistée) contre
  l'accumulation en mémoire, que la perte de pagination (§4) rend intenable.
- **Ne fabrique rien** : un jour sans transaction porteuse de `running_balance` n'a **pas**
  de ligne. Le comblement est un problème de lecture (§3), pas d'écriture.

### 2.3 Ordre intra-jour — ce que l'élection suppose (Q3)

L'élection suppose que `running_balance` **suit** l'ordre de booking : que la transaction la
plus tardive du jour porte bien le solde de clôture. Deux cas dégradent silencieusement :

1. **Ex æquo de `booking_date_time`** (date sans heure, ou horodatages identiques) : l'ordre
   réel est perdu ; le départage par `omnifi_txn_id` peut élire une transaction intermédiaire
   → EOD faux d'un cran. **Détectable** par le contrôle §4.2.
2. **`running_balance` nul sur la dernière transaction du jour, non nul sur les
   précédentes** : l'élection retient l'avant-dernière → EOD faux d'un mouvement.
   **Détectable** par le même contrôle.

Aucun des deux ne justifie de bloquer le chantier : tous deux sont **observables** par le
contrôle de complétude. C'est ce qui rend §4 non optionnel.

### 2.4 Devise — la garde qui n'est pas cosmétique

Le serializer amont émet `RunningBalance.Currency = obj.currency`, **la devise de la
transaction** (`serializers.py:74-80`). Si un compte MUR porte une transaction libellée en
USD (opération FX), son `running_balance` est un solde **en USD**. L'écrire comme EOD du
compte MUR injecte une valeur d'une autre devise dans la série MUR — une addition
cross-devise déguisée, interdite (règle 8).

D'où `AND currency = D_c` dans la sélection, et la validation symétrique à l'ingestion :
`RunningBalance.Currency` doit égaler `Amount.Currency`, sinon le solde est mis à `null`
avec un log codé sans PII (lot L1 du cadrage — déjà prévu, ici justifié par le source).

`balance_history` porte une PK `(bank_account_id, balance_date)` (`schema.ts:529`) : une
seule ligne par compte et par jour, donc **une seule devise possible** — la devise vit en
colonne. Le « une courbe par devise » se joue donc **à la lecture** (§3.3, et fix du bug
cross-devise de `courbeTresorerie`, cadrage §3.2, toujours présent au 2026-07-23 :
`dashboard.ts:466-490` fait `sum(balance)` avec `groupBy(balanceDate)` **seul**).

### 2.5 Bord droit — ancrer sans écrire

Le dernier point réel de la courbe est le dernier jour à transaction, qui peut être ancien.
`current_balance` (instantané, ITAV) sert de **contrôle de vraisemblance** en recette
(cadrage §3.5) et de prolongement **au rendu**, jamais de ligne écrite : injecter un solde
instantané dans une table de clôtures est l'anti-pattern DR-F3 (CLAUDE.md « Fraîcheur du
solde »). Un écart légitime existe dès que la dernière transaction est ancienne (intérêts,
frais) — c'est un signal de diagnostic, **jamais** une condition de rejet d'ingestion.

---

## 3. Jours sans transaction — le report

### 3.1 Règle : report AVANT uniquement

Un solde est un **stock** : il persiste jusqu'au mouvement suivant. Pour un jour `J` sans
EOD réel, la valeur affichée est l'EOD du **dernier jour connu antérieur**.

**Le report est unidirectionnel.** Avant le premier EOD connu d'un compte, il n'y a **rien à
reporter** : le solde antérieur est inconnu (et, vu §1.2, il ne sera jamais servi). Un
report arrière fabriquerait un solde plat parfaitement crédible et parfaitement faux. Le
bord gauche de la série d'un compte est donc son premier EOD réel, point.

### 3.2 Où il vit : au rendu, jamais en base

Décision reconduite du cadrage (§3.3, option A) et **inchangée** : `balance_history` ne
contient que des EOD **observés**. Le report est un **helper pur** (entrée : EOD réels +
bornes ; sortie : axe continu), testable hors DB et hors `Date`, sur le modèle de
`grilleMois` (`dashboard.ts:636-650`) et de `flux-projection.ts`.

Trois raisons, la troisième étant décisive : (a) la table reste factuelle ; (b) matérialiser
des jours reportés multiplierait les lignes par ~30 sans information ; (c) **une ligne
reportée est indiscernable d'une ligne observée** — or §4 impose justement de distinguer ce
qui est prouvé de ce qui est supposé.

### 3.3 Le piège du consolidé multi-comptes (non traité au cadrage)

La courbe consolidée somme les EOD de tous les comptes d'une devise. Si le compte A a de
l'historique depuis J-90 et le compte B seulement depuis J-37 (cas réel : MCB 91 j vs SBM
37 j, §1.2), alors :

> à J-38 la courbe vaut `solde(A)`, à J-37 elle vaut `solde(A) + solde(B)`.
> **Une marche verticale apparaît, qui ne correspond à aucun mouvement.** Un FM la lira comme
> une entrée massive.

Le report (§3.1) **n'y change rien** : il n'y a rien à reporter avant le premier EOD de B.
C'est un défaut de **sens**, pas de rendu. Options, à trancher (D6) :

- **(a) recommandée** — la série consolidée d'une devise ne démarre qu'à la date où **tous**
  les comptes sélectionnés de cette devise ont un EOD connu. Honnête, coût nul, mais raccourcit
  la courbe au plus court historique (37 j si SBM est dans le périmètre).
- (b) démarrer au plus tôt et marquer visuellement la zone où le périmètre est **incomplet**
  (n comptes sur m). Plus riche, exige une surface UI et un compte de couverture par jour.
- (c) ignorer : **rejeté** — c'est livrer une fausse variation de trésorerie.

Note : le choix (a) rend le bord gauche **dépendant du périmètre sélectionné** (sélecteur de
comptes / Vision Entité) — la courbe se raccourcit quand on ajoute un compte récent. Contre-
intuitif mais correct ; à expliciter en UI le jour du lot F1.

---

## 4. Complétude — la perte de pagination rend l'EOD FAUX, pas absent

### 4.1 Le mode de défaillance, précisément

Soit un jour `J` à 12 transactions. La passe perd la 12ᵉ (≈5 %, §1.3). L'élection (§2.2)
retient alors la **11ᵉ** : elle a un `running_balance` parfaitement valide — celui d'avant le
dernier mouvement. La ligne écrite est **plausible, unique, non nulle et fausse**.

Aucune garde existante ne l'attrape : `upsertSoldes` est idempotent, `normaliserMontant`
valide la forme, la RLS valide le périmètre. Et comme l'écart porte sur **un seul
mouvement**, il ne saute pas aux yeux sur une courbe. Une valeur fausse qui se fige dans un
historique de trésorerie est plus grave qu'un trou : un trou se voit.

### 4.2 Détecteur — la différence de `RunningBalance` (contrôle gratuit)

`RunningBalance` porte sa propre preuve : si l'on détient **toutes** les transactions entre
deux clôtures, la variation du solde doit égaler la somme des mouvements.

Soit `K` le dernier jour **antérieur à J** portant un EOD, et `M(K, J]` les transactions du
compte dont `transaction_date ∈ ]K, J]`, `is_removed = false`, `currency = D_c` :

```
Δ_observé  = EOD(J) − EOD(K)
Δ_attendu  = Σ ( + amount  si credit_debit = 'Credit'
                 − amount  si credit_debit = 'Debit'   )  sur M(K, J]
Écart(J)   = Δ_observé − Δ_attendu           ⇒  jour COMPLET ⟺ Écart = 0
```

Arithmétique **`numeric` de bout en bout**, jamais de float, jamais de tolérance
d'arrondi (règle 8) : les deux membres sont des décimaux exacts à 2 décimales ; toute
tolérance masquerait précisément le défaut recherché.

Le signe vient de `credit_debit`, **jamais** du signe de `amount` : côté OBIE tous les
montants sont positifs (`conversion.ts:6-8`, et `normaliserMontant` n'accepte que du
positif `:33`). Sommer `amount` nu donnerait « sorties = 0 » en silence.

**Ce que le contrôle attrape** : transaction manquante (perte de pagination), ex æquo mal
départagé, `running_balance` nul sur la vraie dernière transaction du jour, tombstone
apparu entre deux passes.

### 4.3 Ce que le contrôle ne prouve PAS — à ne pas surinterpréter

- **Il ne discrimine pas la cause.** Un écart peut être un mouvement réel jamais servi par
  le scraping (intérêts, frais bancaires). C'est un **drapeau**, pas un verdict — et surtout
  **jamais une condition de rejet d'ingestion** (même discipline que §2.5).
- **Il ne couvre pas le premier EOD** de la fenêtre : aucun `K` antérieur connu.
- **Écart = 0 n'est pas une preuve de complétude** : deux erreurs de sens opposé se
  compensent. Cas non couvert le plus net : la perte d'un **jour entier** en bord de fenêtre —
  il ne crée aucun écart, il déplace simplement `K`.
- Il suppose `EOD(K)` lui-même juste : un écart peut se **propager** d'un jour au suivant.
  Un jour marqué douteux devrait rendre douteux le suivant (règle de propagation à décider
  avec D2).

### 4.4 Dépendance — la vraie parade est en amont de ce chantier

Le détecteur signale ; il ne répare pas. La réparation structurelle est la **dette B du
DIAGNOSTIC** (§8-3) : itérer l'ingestion par **fenêtres de dates bornées**
(`fromBookingDateTime` / `toBookingDateTime`, dont le DIAGNOSTIC §5 prouve qu'ils
fonctionnent) et **asserter `count == Meta.TotalRecords` par fenêtre** — contre-preuve à
l'appui : requête bornée sur `2026-04-27` → `TotalRecords: 54`, 54 ids distincts, 54 en base.

Ce chantier-ci **n'en dépend pas pour démarrer** (les passes successives convergent, et le
drapeau rend l'incertitude visible), mais **le drapeau reste obligatoire tant que la dette B
n'est pas refermée** (décision D9). Sans lui, on publie une courbe dont on sait qu'elle est
fausse à ~5 % des jours, sans pouvoir dire lesquels.

---

## 5. Persistance append-only

### 5.1 Ce qui est permis, ce qui est interdit

`balance_history` est **append-only au DELETE** (CLAUDE.md « Intégrité append-only ») :

- **DELETE physique : interdit**, sur tous les chemins. Deux gardes indépendantes déjà en
  place — hors liste blanche de `drizzle/provisioning/tygr_app.sql` (le rôle applicatif n'a
  pas le privilège) **et** trigger `BEFORE DELETE` `tygr_refuser_delete_append_only`
  (migration `0004`), qui couvre aussi la **cascade FK** depuis `bank_accounts`
  (`schema.ts:521-523`, `onDelete: "cascade"`) et l'owner. **Rien dans cette spec ne
  supprime.** Aucune table de ce chantier n'entre en liste blanche.
- **UPDATE : permis** — c'est le mécanisme d'affinage. `upsertSoldes`
  (`ingestion.ts:243-264`) fait déjà `ON CONFLICT (bank_account_id, balance_date) DO UPDATE`.

### 5.2 Immuabilité vs convergence — la tension à trancher (D4)

Le brief pose « l'historique EOD est immuable ». La perte de pagination (§4) impose l'inverse :
un EOD faux à la passe 1 doit pouvoir être **corrigé** à la passe 2, sinon la première synchro
fige une valeur fausse pour toujours.

**Recommandation** : l'immuabilité de `balance_history` porte sur le **DELETE** (invariant
CLAUDE.md), pas sur la valeur. La re-dérivation **écrase** l'EOD d'un jour donné dès qu'elle
dispose d'une donnée plus complète — comportement déjà implémenté par `upsertSoldes`, et
seule façon de converger. Un EOD n'est pas un événement d'audit : `audit_events` et
`consent_records` sont, eux, append-only **stricts** (aucun UPDATE) et ne sont pas concernés.

Corollaire d'idempotence : re-dériver sur une donnée **inchangée** doit produire une valeur
**identique** (garanti par le déterminisme §2.2) — sinon la courbe bougerait à chaque synchro.

### 5.3 Migration expand `0025` (la prochaine libre — `0024_account-party-role-scope.sql`)

`ALTER TABLE transactions_cache ADD COLUMN running_balance numeric NULL` :

- **Backward-compatible** (règle 9, expand-contract) : colonne nullable, le code N-1 l'ignore.
- **Se propage aux partitions** (ajout de colonne sur la table mère partitionnée), y compris
  la partition `DEFAULT` et les partitions de roulement à venir.
- **Aucun GRANT nouveau** : SELECT/INSERT/UPDATE sont déjà couverts ; **pas de DELETE** —
  `transactions_cache` reste hors liste blanche.
- **Rappel roulement annuel** : à la création d'une partition, RÉPÉTER la RLS (non héritée),
  **PAS** le trigger (hérité). Ne pas inverser.
- Ordre de pipeline inchangé et non négociable : `db:provision` → `migrate` → `deploy`.

### 5.4 Le piège des 4 décimales — le cadrage se trompe

Le cadrage §4-L1 affirme : « un `RunningBalance` à 4 décimales OBIE (« 750.0000 ») — **déjà
géré** par `normaliserMontant` ». **C'est vrai pour les décimales nulles et faux dès qu'elles
sont significatives**, et la conséquence n'est pas locale :

`normaliserMontant` **lève** `OmniFiInvalidResponseError` sur >2 décimales significatives
(`conversion.ts:41-45` — refus délibéré d'un arrondi caché, décision PO 2026-06-19). Or le
champ amont est `decimal_places=4` **explicitement « for FX precision »**
(`models.py:94-100`). Et `versLignePersistee` est appelée dans un `.map()` sur la page
entière (`orchestrateur.ts:189`) : un throw n'invalide pas le solde, **il fait perdre la page
de transactions complète**, donc jusqu'à 100 transactions — pour un champ accessoire.

**Exigence** : la normalisation du solde est une fonction **dédiée et non-levante**
(`normaliserSoldeCourant`, nom indicatif) : forme inattendue ou décimales significatives
au-delà de la 2ᵉ ⇒ **`null` + log codé sans PII**, jamais d'exception, jamais d'arrondi
silencieux. Un solde absent dégrade la courbe ; une exception fait perdre des transactions.
Ne **pas** réutiliser `normaliserMontant` telle quelle sur ce champ.

Échelle de stockage : `numeric(15,2)`, aligné sur `balance_history.balance`
(`schema.ts:525`) — recommandé (D5) ; l'alternative `numeric(20,4)` conserverait la fidélité
amont mais déplacerait l'arrondi au moment de l'écriture EOD, où il serait invisible.

---

## 6. Critères de sortie (règle 3), adaptés au périmètre

Ce chantier n'ajoute **pas** de route ni de Server Action publique : il s'insère dans le
chemin de sync (`synchroniserCompte`, `orchestrateur.ts:167`) et modifie une lecture
(`courbeTresorerie`). La checklist règle 3 s'applique ainsi, **dans le même PR** :

- [ ] **Authz** : tout accès via `withWorkspace` ; aucun `workspace_id` en paramètre. La
      dérivation lit et écrit **sous le contexte**, jamais en service.
- [ ] **Isolation entité** : toute lecture d'une table fille **joint `bank_accounts`**
      (ENTITY-READ-JOIN1) — ceinture, la policy `account_scope` (0017) étant la bretelle.
      Cas ajoutés à la suite isolation (bloquante CI).
- [ ] **Validation d'entrée** : bornes de fenêtre normalisées (`resoudrePeriode`,
      `src/lib/periode.ts`) ; `running_balance` validé par la normalisation non-levante
      (§5.4) ; devise contrôlée (§2.4).
- [ ] **Erreurs nommées** : chaque échec porte un code machine. **Exception tracée** : la
      dérivation est **best-effort** dans le chemin de sync (try/catch + log codé), calquée
      sur `appliquerRegles` — une dérivation bancale ne doit jamais faire perdre des
      transactions déjà persistées. C'est le seul catch large admis, et il journalise.
- [ ] **Tests** : chemin heureux + échec + cas limite (jour vide, `null`, ex æquo, tombstone,
      re-sync concurrent) — détail §7.
- [ ] **Logs structurés sans PII** (`workspace_id`, `bank_account_id`, compteurs) : jamais de
      montant, jamais de libellé bancaire, jamais de solde dans un message.
- [ ] **Suite isolation IDOR verte** (bloquante CI).
- [ ] **Dette INTERDITE** : le fix cross-devise de `courbeTresorerie` touche un **montant** —
      il se corrige dans ce chantier, il ne se consigne pas.

---

## 7. Plan de tests

### A. Bornes de fuseau — unitaire (`tests/unit/ingestion-conversion.test.ts`)

Déjà couvert : 22 h UTC → lendemain, matin UTC → même jour, offset explicite, rejet d'un
horodatage illisible (`ingestion-conversion.test.ts:45-65`). **Manquants**, à ajouter :

| Cas | Entrée | Attendu |
|---|---|---|
| Bascule −1 s | `2026-07-22T19:59:59Z` | `2026-07-22` |
| **Bascule exacte** | `2026-07-22T20:00:00Z` | `2026-07-23` |
| Franchissement d'année | `2026-12-31T20:00:00Z` | `2027-01-01` |
| Offset non-UTC équivalent | `2026-07-22T23:00:00+02:00` | `2026-07-23` |

La bascule exacte (20:00:00Z) est le cas décisif : 22 h la franchit déjà largement et
passerait même avec un décalage mal implémenté.

### B. Élection EOD — isolation (nouveau, `tests/isolation/`)

| # | Cas | Attendu |
|---|---|---|
| E1 | Jour UTC contenant `T19:59:59Z` **et** `T20:00:00Z` | **Deux jours comptables distincts** ; l'EOD de J = solde de 19:59:59Z. *Échoue si l'agrégation groupe en UTC — c'est le test qui garde §2.1.* |
| E2 | Dernière transaction du jour sans `running_balance` | Avant-dernière élue **et** contrôle §4.2 en écart ≠ 0 |
| E3 | Transaction `is_removed = true` la plus tardive | Exclue de l'élection |
| E4 | Ex æquo parfait de `booking_date_time` | Départage stable ; 2 exécutions ⇒ même résultat |
| E5 | Re-dérivation sur donnée inchangée | Valeur identique, **aucune ligne dupliquée** (PK) |
| E6 | Transaction USD sur compte MUR | **Non élue** ; l'EOD MUR reste celui de la dernière transaction MUR |
| E7 | Workspace MUR + USD | **Deux séries**, aucune addition cross-devise (fix `courbeTresorerie`) |
| E8 | Périmètre : autre workspace / Vision Entité | Invisible ; agrégat borné (jointure `bank_accounts`) |
| E9 | Transaction d'aujourd'hui à 21 h UTC | Jour comptable **demain** ⇒ **hors** fenêtre `[from, aujourd'hui Maurice]` |

### C. Complétude — unitaire (fonction pure, §4.2)

Jour complet ⇒ écart nul · une transaction retirée ⇒ écart = son montant signé · jour dont
`K` est antérieur de plusieurs jours ⇒ somme sur l'intervalle `]K, J]` · premier EOD de la
fenêtre ⇒ **non évaluable** (et non « complet ») · débits et crédits mêlés ⇒ signe pris sur
`credit_debit`, **jamais** sur `amount`.

### D. Report — unitaire (helper pur, §3)

Trous comblés par la valeur antérieure · **aucun report avant le premier EOD connu** · bord
droit prolongé jusqu'à `to` · séries multi-devises indépendantes · périmètre vide ⇒ série
vide · consolidé à historiques inégaux ⇒ comportement conforme à D6 (pas de marche muette).

> **Fixtures** : écrire d'abord celle qui **fait échouer** — un jeu de démo trop régulier
> (une transaction par jour, tous les `running_balance` peuplés, une seule devise) rend E1,
> E2, E6 et C structurellement non capturables.

---

## 8. Décisions ouvertes

Les cinq du cadrage §5 restent valides ; D1/D6/D8 en sont la reprise. Recommandation en gras,
**aucune n'est tranchée ici**.

| # | Décision | Options | Impact |
|---|---|---|---|
| D1 | Source EOD | **dérivation `RunningBalance`** / `/balances/history` si Q4 = 200 | Tranchée par le runtime du gate, pas par préférence |
| D2 | Jour dont le contrôle §4.2 est en écart | **persister + drapeau** / ne pas persister (⇒ trou, puis report) / persister sans marque | Migration (D3), sens de la courbe |
| D3 | Où vit le drapeau | colonne sur `balance_history` (migration ; UPDATE légal) / **recalcul à la lecture** (zéro migration, coût requête) | L2/L3 |
| D4 | Immuabilité de l'EOD | **UPDATE autorisé (convergence)** / figé au premier calcul | §5.2 — contredit la lecture stricte du brief, arbitrage requis |
| D5 | Échelle `running_balance` | **`numeric(15,2)`** / `numeric(20,4)` | Migration 0025, §5.4 |
| D6 | Bord gauche du consolidé | **démarrer quand tous les comptes ont un EOD** / marquer la zone partielle / ignorer (rejeté) | §3.3, lot F1 |
| D7 | Fenêtre « 90 jours » | **réutiliser les presets existants (`3m`)** / introduire une fenêtre 90 j parallèle | `PRESETS_PERIODE = ce-mois, 3m, 6m, 12m, tout` (`periode.ts:58`) — aucun preset « 90 j » n'existe |
| D8 | Ex æquo intra-jour | **accepter le départage stable et le tracer** / bloquer jusqu'à séquence OBIE | §2.3 |
| D9 | Dépendance à la dette B (ingestion par fenêtres) | **parallèle, drapeau obligatoire entre-temps** / bloquante | §4.4 |

---

## 9. Hors périmètre (anti-scope-creep)

- **Aucun FX, aucune conversion** : multi-devise = séries côte à côte, jamais additionnées.
- **Pas de refonte du flux net** (`cashflowParDevise`) : on **ajoute** le solde (stock), on ne
  remplace pas le flux.
- **Pas de branchement front** : lots F1/F2 du cadrage, différés, spécifiés là-bas.
- **Pas de client `/balances/history` neuf** : `historiqueSoldes` existe (`client.ts:307-320`) ;
  on le rebranche si et seulement si Q4 repasse 200.
- **Pas de correctif de la dette B** (pagination par fenêtres) : chantier distinct dont ce
  plan ne fait que **dépendre et signaler** (§4.4).
- **Pas d'élargissement de la profondeur amont** : la fenêtre 92 j de `mcb_pro` est une
  question à Omni-FI (DIAGNOSTIC §8-1), pas un correctif TYGR.
