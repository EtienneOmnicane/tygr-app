# PLAN — Neutralisation propre de la catégorie absente (`UNCLASSIFIED`) + cadrage de la file de revue

> **Phase : CONCEPTION** (CLAUDE.md règle 1) — plan sur disque, **aucune ligne de code**.
> **Branche :** `plan/fiabilite-unclassified` · **Livrable :** ce fichier.
> **Ouvert :** 2026-07-23 · **Gardien pressenti :** Front + Backend (contrat lecture).
> **Périmètre : la CATÉGORIE uniquement.** Le mapping / l'extraction du **marchand**
> (`clean_label`, `CleanMerchantName`, `PROD-MERCHANT1`) est traité par un **autre agent** —
> ce plan n'y touche pas (§10 Hors périmètre).

---

## 0. Résumé pour décision

**~93 % des transactions arrivent en `UNCLASSIFIED`** (8 450 / 9 056 — `CONSTAT-qualite-libelles-omnifi.md` §2.2). `UNCLASSIFIED` est la **vraie étiquette « vide »** de l'amont : la banque déclare ne pas savoir classer. Le produit doit **neutraliser** cette absence proprement — un **état neutre** (« Non catégorisé », `text-muted`), **jamais** une catégorie fausse, vide, ni un état d'erreur (rouge).

La neutralisation est **déjà en place à trois couches** (ingestion #243, affichage `/transactions`, affichage SQL du donut/dashboard). **Ce plan cadre le RESTE** — quatre lots, du plus dû au plus lourd :

| Lot | Objet | Dette | Priorité proposée |
|---|---|---|---|
| **A** | Backfill des lignes déjà ingérées avec `is_auto_categorized=true` à tort | (nouveau, issu de #243) | **P1** |
| **B** | Unifier l'affichage catégorie Dashboard vs `/transactions` + tester `traduireCategorieBanque` | `TECH-MERCHANT-POLISH1` | **P2** |
| **C** | Observabilité des trous de catalogue (log de la clé BRUTE) | `OBIE-CATALOG1` piste (b) | **P2** |
| **D** | File de revue de catégorisation + score de confiance | `GAP-CATEG-NATIVE1` (socle FEAT-8.1) | **P2** |

**Décision structurante à trancher AVANT le Lot D (§6.1) :** la file de revue mélange-t-elle les **~93 % « Non catégorisé »** (aucune classification amont → *backlog de saisie*) et le petit lot **« À vérifier »** (classification amont douteuse → *vérification*) ? Ce sont deux gestes métier différents.

---

## 1. Contexte & ancrages vérifiés

### 1.1 Le fait

`UNCLASSIFIED` (SCREAMING_SNAKE) est la valeur **réellement émise** par l'amont, constatée par inventaire base le 2026-07-21. Elle **n'est pas** la graphie documentée (`Uncategorized`). Inventaire exhaustif du même jour : **4 valeurs seulement** en base — `UNCLASSIFIED`, `UTILITIES`, `BANKING_AND_FINANCE`, `INTER_ACCOUNT_TRANSFER` — dont **3 vraies catégories** à préserver.

Deux concepts **distincts**, à ne jamais confondre (déjà nommés dans le code, `regle-fiabilite.ts:8-12`) :
- **A. Ventilation manuelle TYGR** (`statutCategorisation` : `non_categorise|partiel|complet`) — les *splits* saisis par l'utilisateur.
- **B. Fiabilité amont** (`niveauFiabilite` : `Low|Medium|High`) → badge « À vérifier ».
- **C. Source amont** (`sourceClassification` : `USER_RULE|SYSTEM_RULE|ML_FALLBACK`) → icône + infobulle.
- **(catégorie OBIE)** `primaryCategory` — traduite FR à l'affichage, absente ⟺ « Non catégorisé ».

`UNCLASSIFIED` touche **la catégorie OBIE** (elle devient `null`), **pas** la ventilation manuelle.

### 1.2 Ce que #243 a livré (à NE PAS re-livrer)

Commit `456157f` — `fix(ingestion): neutralise "UNCLASSIFIED"` (#243, mergé) :

- `CATEGORIES_OBIE_VIDES = new Set(["uncategorized", "unclassified"])` (`orchestrateur.ts:95`) — la liste fermée connaît désormais les **deux graphies**.
- Conséquence à l'ingestion (`versLignePersistee`, `orchestrateur.ts:139-152`) : pour une ligne `UNCLASSIFIED` →
  - `primary_category = null`
  - `is_auto_categorized = false`
  - `category_source = null` (cohérence garantie par le CHECK `transactions_cache_auto_source_coherence`).
- Les métadonnées de trace (`confidence_level`, `classification_source`, `rule_id_match`) restent **fidèlement persistées** même pour une ligne `UNCLASSIFIED` (`orchestrateur.ts:141-148`) — utile pour la future file de revue. Un `Low` par défaut est **conservé** (neutraliser un score bas est une décision de couche UI, pas de la trace).
- Tests ajoutés (`tests/unit/ingestion-orchestrateur.test.ts`) : `UNCLASSIFIED` toutes casses → `false` ; **contre-preuve** verrouillant les 3 vraies catégories.
- **NON fait, explicitement différé par #243 :** *« Les lignes DÉJÀ ingérées gardent leur mauvaise valeur : aucun backfill ici (tables append-only, arbitrage séparé). »* → **c'est le Lot A de ce plan.**

### 1.3 Ce que l'affichage neutralise DÉJÀ

| Couche | Fichier | Comportement `UNCLASSIFIED` / absence | Verdict |
|---|---|---|---|
| Traduction (source unique) | `src/lib/categories-fr.ts` | `categorieFr(null/UNCLASSIFIED)` → `« Non catégorisé »` (`CATEGORIE_FR_PAR_DEFAUT`). `normaliserCleObie` gère le SCREAMING_SNAKE. | ✅ |
| `/transactions` sous-texte | `adapter.ts:240` `traduireCategorieBanque` | rejette le défaut vers `null` → **pas de sous-texte trompeur**. | ✅ (mais **non testé** — C2) |
| `/transactions` statut | `categorisation-status-badge.tsx:57-67` | 0 catégorie → « Non catégorisé » en `text-muted`, **jamais d'alerte**. | ✅ |
| Cascade libellé | `libelle-transaction.tsx` | niveau 2 (catégorie) **sauté** quand `categorieFr=null` → cascade `marchand → brut → repli`. | ✅ |
| Donut / dashboard (SQL) | `categorie-fr-sql.ts` `caseCategorieFr` / `estLibelleNonCategorise` | sentinelles + vide → branche `else` → « Non catégorisé », marqué `estNonCategorise=true` / `origine="AUCUNE"`, **trié en dernier, rendu neutre** (`insights/types.ts:92-140`). | ✅ |
| Dashboard colonne Catégorie | `transactions-table.tsx:73` | `categorieFr(t.primaryCategory)` → affiche le **texte** « Non catégorisé ». | ⚠️ **divergence** (C1) |
| Top contreparties | `top-vendors-card.tsx:124` | `UNCLASSIFIED` → « Sans contrepartie identifiée ». | ⚠️ **relève du MARCHAND** → hors périmètre (§10) |

**Conclusion état des lieux :** la neutralisation *fonctionnelle* est faite ; restent (1) la **cohérence de la donnée déjà ingérée** (Lot A), (2) deux **incohérences/dettes d'affichage** de la CATÉGORIE (Lots B/C), (3) l'**absence totale de file de revue** (Lot D).

---

## 2. Lot A — Backfill des lignes déjà ingérées (P1)

### 2.1 Le défaut mesuré (CONSTAT §6.1)

Avant #243, `UNCLASSIFIED` passait `categorieAutoValide()` comme une vraie catégorie. Conséquence **en base sur les lignes déjà ingérées** :
- `is_auto_categorized = true` sur **9 056 / 9 056** (100 %),
- alors que **606** seulement (6,7 %) portent une classification réelle,
- `category_source = 'OMNIFI'` posé à tort sur ~93 % du volume.

**#243 corrige les ingestions FUTURES, pas le passé.** Tant que le backfill n'est pas fait : *tout indicateur interne de fiabilité bâti sur ces colonnes est faux* (le score du Lot D lirait des colonnes menteuses). C'est le **pré-requis data du Lot D**.

### 2.2 Pourquoi la re-sync ne suffit pas

`upsertTransactions` (onConflict) réécrirait `is_auto_categorized`/`category_source` à la valeur correcte **au prochain sync** — MAIS :
1. l'historique amont est **borné à ~92 j** (`profondeur-historique-92j-mcb-pro`) : les lignes plus anciennes ne reviennent jamais dans un payload → jamais corrigées ;
2. les connexions sont **actuellement désynchronisées** (`SYNC-DESYNC1`, P1) — aucune re-sync ne tourne.

→ **Un backfill explicite one-shot est nécessaire.**

### 2.3 Légalité append-only (à vérifier, pas à supposer)

`transactions_cache` est append-only **au DELETE**, mais **l'UPDATE est permis** (tombstone `is_removed`, *affinage de catégorie* — CLAUDE.md §8). Un backfill par **UPDATE** est donc légal. **Ce n'est PAS une dette d'isolation ni de montants** (on corrige des colonnes de métadonnées de classification) → il se corrige, ne se consigne pas comme dette interdite.

### 2.4 Forme du correctif (à trancher, §6.3)

Option retenue par défaut (à valider) : **script de migration de données** (`scripts/backfill-*.mjs`) sous `DATABASE_URL_ADMIN`, idempotent, du même genre que `scripts/backfill-auto-categorized.mjs` déjà cité dans `OBIE-CATALOG1`.

Cible de l'UPDATE (parité EXACTE avec `versLignePersistee`) — pour toute ligne où la catégorie OBIE brute n'est PAS exploitable :
```
is_auto_categorized = false, category_source = NULL, primary_category = NULL
```
- **Prédicat = même liste fermée que le code** (`categorieAutoValide` : `lower(btrim(primary_category)) IN ('uncategorized','unclassified')` OU vide/NULL). Ne PAS ré-inventer le prédicat en SQL : le dériver de la constante (risque de divergence, cf. leçon `caseCategorieFr`).
- **Ne JAMAIS toucher** `confidence_level`/`classification_source`/`rule_id_match` (trace fidèle, conservée volontairement).
- Respecter le CHECK `transactions_cache_auto_source_coherence` (l'UPDATE le satisfait par construction).
- **Partitions** : l'UPDATE doit couvrir toutes les partitions (table mère → propagé).
- **Isolation** : le script tourne en admin (hors RLS) — donc **borné par un `WHERE` explicite**, pas par le tenant. Documenter que c'est une **correction de données globale**, pas une opération applicative (analogue migration).

**Preuve exigée (règle 3/5) :** COUNT avant/après par `(is_auto_categorized, category_source)` ; idempotence (2ᵉ passage = 0 ligne modifiée) ; **contre-preuve** : les 606 lignes réellement classées (`UTILITIES`/`BANKING_AND_FINANCE`/`INTER_ACCOUNT_TRANSFER`) **restent** `is_auto_categorized=true` (un prédicat trop large les casserait — même piège que la contre-preuve de #243).

---

## 3. Lot B — Unifier l'affichage catégorie + tester `traduireCategorieBanque` (P2, `TECH-MERCHANT-POLISH1`)

### 3.1 C1 — deux rendus pour la même donnée

- **Dashboard** (`transactions-table.tsx:73`) : `categorieFr(t.primaryCategory)` → retombe **toujours** sur le **texte** « Non catégorisé » (une colonne pleine de « Non catégorisé » sur 93 % des lignes).
- **`/transactions`** (`adapter.ts:240` → `traduireCategorieBanque`) : renvoie **`null`** → sous-texte **masqué**.

Même donnée OBIE, deux comportements. **Décision d'affichage à poser (§6.2)** : sur le Dashboard, « Non catégorisé » en colonne dédiée est-il le bon état neutre, ou faut-il un placeholder atténué (`—` / vide `text-faint`) comme sur `/transactions` ? Cohérence attendue : **une seule convention** de rendu de l'absence de catégorie, quelle que soit la surface.

### 3.2 C2 — `traduireCategorieBanque` non testée

`adapter.ts:240` porte une logique conditionnelle non triviale (rejet du défaut → `null`) **sans test unitaire dédié** — viole l'exit-criteria règle 3. Tests requis (§7).

### 3.3 Portée

Lot **d'affichage pur** (aucune donnée touchée, aucun schéma). Aligne les deux surfaces sur la **source unique** `categories-fr.ts` + une convention de rendu de l'absence unique.

---

## 4. Lot C — Observabilité des trous de catalogue (P2, `OBIE-CATALOG1` piste (b))

### 4.1 Le risque résiduel

`CORRESPONDANCE_FR` est une **liste fermée** maintenue à la main ; l'amont émet **librement**. Toute **nouvelle** catégorie OBIE hors catalogue s'affiche « Non catégorisé » **silencieusement** — sans alerte. On l'a déjà payé deux fois (les 96 % de la sonde de juin ; le SCREAMING_SNAKE de juillet).

### 4.2 Le signal, maintenant fiable (effet de bord positif de #243)

Depuis #243, `UNCLASSIFIED` est **nullifié à l'ingestion**. Donc, à l'affichage, un `primary_category` **non-NULL** qui retombe sur le défaut de `categorieFr` **est** un vrai trou de catalogue (le bruit `Uncategorized`/`UNCLASSIFIED` ne remonte plus). Le signal est devenu **qualifiable**.

### 4.3 Le correctif

Log **structuré, sans PII** (règle 8 — `primary_category` est une étiquette OBIE générique, pas un libellé bancaire, donc loggable), qui émet **la clé BRUTE** (`OBIE-CATALOG1` insiste : *« logger la clé BRUTE, pas seulement le fait qu'on est retombé sur le défaut »*) **uniquement** quand :
```
primary_category IS NOT NULL  ET  normaliserCleObie(primary_category) ∉ CORRESPONDANCE_FR
```
- **Où** : au point de traduction. Attention — la traduction existe en **deux endroits** (TS `categorieFr` + SQL `caseCategorieFr`). Un log à l'ingestion (`versLignePersistee`, une fois par transaction) est préférable à un log au rendu (répété à chaque vue). **À trancher (§6.4)** : logger à l'**ingestion** (une émission par tx, volume maîtrisé, mais rate potentiellement les catégories déjà en base) vs au **rendu** (couvre l'existant mais bavard → dédup nécessaire).
- **Anti-bruit** : dédup par clé (Set en mémoire process, ou throttle), sinon une nouvelle catégorie fréquente noie les logs.

---

## 5. Lot D — File de revue de catégorisation + score (P2, `GAP-CATEG-NATIVE1`, socle FEAT-8.1)

### 5.1 Ce qui existe déjà (briques)

- **Trace amont peuplée** (`TECH-API-TRACE`, #110 livré) : `confidence_level`, `classification_source`, `rule_id_match` en base + normalisées à l'affichage (`niveauFiabilite`, `sourceClassification`).
- **Badge « À vérifier »** (`regle-fiabilite.ts` `afficherAVerifier`) : `Low` + **catégorie posée** → badge. `EXIGE_CATEGORIE=true` empêche le badge de crier sur les 93 % non classés (le `Low` par défaut du serializer). Seuil `NIVEAUX_A_VERIFIER = {Low}` **isolé et élargissable**.
- **Filtre `non_categorise`** dans la toolbar (`transactions-toolbar.tsx:62`) — MAIS il filtre la **VENTILATION manuelle** (concept A), **pas** l'absence de catégorie OBIE. **Piège de nommage à ne pas répercuter.**
- **Moteur de règles déterministe** (PR #95) — utile, **mais ce n'est PAS FEAT-8.1**.

### 5.2 Ce qui manque (le cœur du Lot D)

`GAP-CATEG-NATIVE1` restant :
1. **Chaîne de priorité** `USER_RULE > SYSTEM_RULE > ML_FALLBACK` (doc API §Priorité de classification) — arbitre entre catégo amont, règles locales et ventilation manuelle.
2. **Score de confiance** pilotant l'**application silencieuse** vs le versement en **file de revue manuelle** (seuil de bascule ; exposer `confidence_level` en lecture catégorisée).
3. **La file elle-même** : aucune surface agrégée aujourd'hui (ni compteur, ni vue dédiée, ni nudge). Seulement des badges par ligne + un filtre de ventilation.

### 5.3 Cadrage produit de la file (décisions §6.1)

**Composition — deux populations, un geste différent :**

| Population | Prédicat | Volume | Geste métier | État visuel |
|---|---|---|---|---|
| **« Non catégorisé »** | `primary_category IS NULL` **et** aucun split | ~93 % | *Assigner* une catégorie (saisie) | neutre `text-muted` |
| **« À vérifier »** | catégorie amont posée **et** `Low` (`afficherAVerifier`) | faible | *Confirmer / corriger* | badge ambre `warning` (jamais rouge) |

→ **Décision D-1 (§6.1) : la file est-elle UNE liste (les deux mélangées) ou DEUX entrées distinctes ?** Recommandation : **deux entrées** — mélanger un backlog de 93 % avec un lot de vérification noierait le signal « À vérifier » et rendrait la file décourageante. La « file de revue » au sens de `GAP-CATEG-NATIVE1` = surtout **« À vérifier »** ; le « Non catégorisé » est un **backlog de saisie**, adressé par le **filtre existant** + un éventuel compteur (nudge).

**Priorisation de la file** (si liste unique retenue) : `Low`+catégorie d'abord (une décision est en jeu), puis montants décroissants (impact trésorerie), « Non catégorisé » en fin.

**Surface** : réutiliser `/transactions` + un filtre (pas un nouvel écran au MVP — éviter l'expansion de scope). Un **compteur/nudge** agrégé (« N transactions à vérifier ») est l'incrément minimal ; une vue dédiée est un incrément ultérieur.

### 5.4 Dépendance

Le score n'a de sens **qu'après le Lot A** (sinon `is_auto_categorized`/`category_source` mentent sur 93 % des lignes). **Ordonnancement : A → D.**

---

## 6. Décisions ouvertes (à trancher par le PO / humain — règle 10)

- **D-1 (Lot D, structurant).** File de revue = **une** liste mêlant « Non catégorisé » (93 %) et « À vérifier », **ou deux** entrées distinctes ? *Reco : deux.*
- **D-2 (Lot D).** Seuil de bascule en file : garde-t-on `NIVEAUX_A_VERIFIER = {Low}` seul, ou ajoute-t-on `Medium` après mesure des volumes réels (sandbox/prod) ? *Reco : {Low} au MVP, flag déjà isolé (`regle-fiabilite.ts:28`).*
- **D-3 (Lot A).** Backfill : **script one-shot** (reco) vs attendre la re-sync (rejeté §2.2) ? Et : **borne-t-on** le backfill aux workspaces actifs ou à toute la base ?
- **D-4 (Lot C).** Log de trou de catalogue à l'**ingestion** (reco, volume maîtrisé) vs au **rendu** (couvre l'existant, plus bavard) ?
- **D-5 (Lot B).** Rendu de l'absence de catégorie **sur le Dashboard** : garder le texte « Non catégorisé » en colonne, ou aligner sur `/transactions` (`—`/vide atténué) ? *Reco : une seule convention, à choisir ; ne pas laisser diverger.*
- **D-6 (transverse).** `Low` par défaut du serializer est conservé en base (trace). La **neutralisation UI** du score bas est-elle : masquer le badge quand `categorieBanque=null` (déjà fait, `EXIGE_CATEGORIE`) — suffit-il, ou faut-il distinguer un `Low` *par défaut* d'un `Low` *décidé* par l'amont (impossible sans info supplémentaire — probablement à laisser tel quel) ?

---

## 7. Tests (par lot)

**Lot A (backfill)**
- COUNT par `(is_auto_categorized, category_source)` avant/après ; après : 0 ligne `is_auto_categorized=true` avec `primary_category` sentinelle/NULL.
- **Idempotence** : 2ᵉ passage → 0 ligne modifiée.
- **Contre-preuve** : les 3 vraies catégories restent `is_auto_categorized=true` (prédicat pas trop large).
- Partitions couvertes (au moins une ligne par partition présente).

**Lot B**
- `traduireCategorieBanque` : chemin heureux (catégorie cartographiée → FR) ; catégorie absente/NULL → `null` ; catégorie **non** cartographiée → `null` ; `UNCLASSIFIED`/`UNCATEGORIZED` → `null`. (règle 3 : heureux + cartographié + absent/non-cartographié.)
- Non-régression : Dashboard et `/transactions` rendent l'absence **de la même façon** (selon D-5).

**Lot C**
- Le log fire **uniquement** sur `primary_category` non-NULL non cartographiée ; **ne fire pas** sur NULL ni sur les sentinelles (post-#243) ni sur les catégories cartographiées.
- Dédup : deux occurrences de la même clé → un seul log (fenêtre).
- **Sans PII** : le message ne contient que la clé OBIE, jamais `bank_label_raw`.

**Lot D**
- `afficherAVerifier` : déjà couvert — étendre si le seuil bouge (D-2).
- Prédicat de la file (les deux populations) : cardinalités distinctes prouvées par mutation (ne pas corréler « pas de catégorie OBIE » et « pas de split » avec la même fixture — piège `piege-fixture-correle-deux-clauses`).
- Le compteur/nudge agrégé lit **sous la RLS** (scopé workspace + périmètre entité) — cas isolation ajouté.

**Parité (transverse, déjà existant à ne pas casser)** : `normaliserCleObie` (TS) ≡ normalisation SQL de `caseCategorieFr`, verrouillée clé-par-clé dans `tests/isolation/graphiques-repartition-isolation.test.ts`. Tout ajout au dictionnaire doit garder ce test vert.

---

## 8. Impacts i18n & états d'affichage

### 8.1 i18n

- **Source unique** du libellé : `CATEGORIE_FR_PAR_DEFAUT = "Non catégorisé"` (`categories-fr.ts:32`). Tout nouvel état neutre (« À vérifier », « Sans contrepartie »…) doit passer par un point unique, pas de littéral dispersé.
- **Langue pivot = anglais en base** : `primary_category` reste la valeur OBIE brute (export/réconciliation). La traduction est **au rendu** — invariant à préserver (le backfill NULLifie, il ne traduit pas).
- **Tension Q-LANG** (`decision-q-lang-produit-anglais`) : la destination produit est l'**anglais** (`/admin/*` pilote). Ces libellés (« Non catégorisé », « À vérifier ») sont **français** aujourd'hui. Ce plan **n'ouvre pas** la migration EN (hors périmètre) mais toute chaîne ajoutée doit rester **centralisée** pour être traduisible d'un geste le jour venu. À signaler, pas à traiter ici.

### 8.2 États d'affichage (convention CLAUDE.md « Loading / Empty / Error / Partiel »)

- **`UNCLASSIFIED` = état NEUTRE, jamais Error.** « Erreur ≠ sortie » (§3.4) : un état d'erreur porte fond `danger-bg` + icône + message + `role="alert"`. « Non catégorisé » n'est **rien de tout ça** — c'est `text-muted`, une incitation discrète (`categorisation-status-badge.tsx:12` : *« l'absence de ventilation n'est pas une erreur »*). **Non négociable.**
- **Vert/rouge réservés à la donnée** (`inflow`/`outflow`). La file de revue et le badge « À vérifier » emploient l'**ambre** (`warning`), jamais le rouge (cohérent avec `IndicePartiel`).
- **Empty** (une file de revue vide, un donut 100 % non catégorisé) : illustration outline + `text-muted` + un seul CTA — jamais un « No data » sec.
- **Nouveaux états à spécifier** (checklist UI_GUIDELINES §6.5) si le Lot D crée une surface : Loading / Empty (file vide = bon signe) / Error / le compteur à zéro.
- **Visual QA (Gate 4)** : les états CATÉGORIE se capturent déjà via `src/app/demo/graphiques-states/` (poste « Non catégorisé », `estNonCategorise:true`) et `src/app/demo/transactions/`. Tout nouvel état (compteur/nudge, file) **ajoute son cas de démo** hors auth/DB.

---

## 9. Critères de sortie (règle 3) — par surface créée

- **Lot A (script)** : tourne sous `DATABASE_URL_ADMIN` (comme une migration de données) ; `WHERE` explicite ; idempotent ; **ne touche ni l'isolation ni les montants** ; preuve COUNT + contre-preuve ; append-only respecté (UPDATE only, jamais DELETE).
- **Lot D (lecture/compteur/file)** : `withWorkspace` (lecture scopée) ; ressource d'un autre tenant → 404 ; lit **sous la RLS + périmètre entité** (jointure `bank_accounts`, `ENTITY-READ-JOIN1`) ; zod strict sur tout filtre d'URL ; erreurs nommées ; logs corrélés `workspace_id` ; cas isolation IDOR ajouté à la suite bloquante.
- **Lots B/C (affichage + log)** : purs / sans schéma ; pas de couleur en dur ; log sans PII.

---

## 10. HORS périmètre (à ne pas empiéter)

- **Mapping / extraction du MARCHAND** (`clean_label`, `CleanMerchantName`, la falaise d'enrichissement, `PROD-MERCHANT1`, la neutralisation `top-vendors-card.tsx` « Sans contrepartie identifiée ») → **autre agent**. Ce plan reste sur la **catégorie**.
- **Signalement à l'amont** (message Slack `CONSTAT` §7, plafonds de troncature, exposition des segments) → non-code, hors plan.
- **Override amont** (`POST /transactions/override`, `DECISION-PRODUIT-OVERRIDE`) → décision produit distincte.
- **Ingestion de `BankTransactionCode`/`ProprietaryBankTransactionCode`** (CONSTAT §6.2) → piste séparée (repli typé de libellé), n'est pas de la catégorie OBIE.
- **Migration produit vers l'anglais** (Q-LANG) → chantier distinct.

---

## 11. Ordonnancement proposé

```
A (backfill, P1)  ─┬─►  D (file + score, P2)   [D dépend de A : sinon score sur données menteuses]
                   │
B (affichage, P2) ─┘    (indépendant, livrable seul)
C (observabilité, P2)   (indépendant, livrable seul)
```

**Prochaine phase = IMPLÉMENTATION**, un lot par PR (règle 1 : ce plan doit exister avant toute ligne de code — c'est fait). Chaque PR référence ce fichier et coche §9. Revue contradictoire à contexte frais (règle 6). **STOP à la PR** (Human-in-the-Loop).
