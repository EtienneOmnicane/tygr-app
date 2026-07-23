# Constat — qualité des libellés de transaction remontés par l'API Omni-FI

**Émetteur :** équipe TYGR (outil de trésorerie)
**Date :** 2026-07-21
**Nature :** investigation lecture seule sur la base TYGR de production locale. Aucune écriture (session `BEGIN TRANSACTION READ ONLY`).
**Objet :** caractériser factuellement la plainte métier « les libellés sont moches / cryptiques » avant de la remonter à l'équipe API.

> **Confidentialité (règle 8).** Ce document ne contient **aucune valeur brute de transaction**, aucun nom de contrepartie, aucun montant rattachable à une entité, aucun nom de client corporate. Toutes les caractérisations sont **structurelles** (longueurs, ratios, présence de motifs). Les institutions bancaires sont nommées : elles sont l'objet du signalement.

---

## 0. Résumé pour décision

Trois constats, par ordre d'importance. **Le premier retourne la plainte initiale.**

1. **Ce n'est pas d'abord un problème de libellé pauvre, c'est un problème d'extraction du marchand.** L'enrichissement amont (`CleanMerchantName`) fonctionne à **99,8 %** sur les narratifs courts et s'effondre à **2,3 %** au-delà de ~60 caractères. Or les narratifs longs sont **plus riches**, pas plus pauvres : 99,3 % d'entre eux contiennent un mot de 8 lettres ou plus. **L'information de contrepartie est présente dans le champ ; elle n'en est pas extraite.**

2. **La catégorisation amont est quasi inexistante et transversale à toutes les banques** : 93,3 % des transactions arrivent en `UNCLASSIFIED`. Les seules catégories obtenues proviennent de **9 règles à mot-clé** (identifiants `SYS_*`), pas d'un classifieur.

3. **Le narratif est tronqué à une longueur fixe qui diffère par banque** : plafond dur à **100 caractères** (MCB) et **50 caractères** (SBM). Chez SBM, 41 % des transactions frôlent le plafond — l'information est coupée en amont de nous.

**Impact utilisateur mesuré :** **3 027 transactions sur 9 056 (33,4 %)** s'affichent aujourd'hui en libellé brut italique — c'est ce que le métier perçoit comme « moche ».

---

## 1. Méthode et périmètre

**Source :** base TYGR, table `transactions_cache` jointe à `bank_accounts` → `bank_connections`, `is_removed = false`.

| Élément | Valeur |
|---|---|
| Transactions analysées | 9 056 |
| Comptes bancaires | 102 (77 MCB, 23 SBM, 2 Absa) |
| Connexions bancaires | 3 |
| Période couverte | 2026-04-12 → 2026-07-16 |
| Devises | 5 (MCB), 4 (SBM), 1 (Absa) |

**Rappel de la cascade d'affichage TYGR** (`resoudreLibelle`, `src/components/transactions/libelle-transaction.tsx`) :

1. `clean_label` (marchand enrichi) — texte plein
2. sinon catégorie bancaire traduite en FR — texte plein
3. sinon `bank_label_raw` (narratif OBIE brut) — **italique atténué**
4. sinon « Opération bancaire »

Les niveaux 3 et 4 sont ce que le métier appelle « libellé pauvre ».

> **Précision sur le niveau 2.** `UNCLASSIFIED` n'est pas cartographié dans `CORRESPONDANCE_FR` (`src/lib/categories-fr.ts`) ; `traduireCategorieBanque` le convertit donc en `null`. **Le niveau 2 est de fait inactif sur 93,3 % du volume** : la cascade réelle se réduit aujourd'hui à `clean_label → brut → repli`.

**Limite d'échantillon, à porter dans toute communication :** Absa ne compte que **9 transactions**. Ses pourcentages sont affichés pour complétude mais **ne sont pas significatifs** et ne doivent pas être cités comme un taux.

---

## 2. (a) Tableau par institution

### 2.1 Répartition de la cascade — trié par taux de libellé pauvre décroissant

| Institution | Tx | N1 marchand | N2 catégorie | N3 brut | N4 repli | **% libellé pauvre** |
|---|---:|---:|---:|---:|---:|---:|
| Absa Internet Banking ⚠️ | 9 | 1 (11,1 %) | 0 | 8 | 0 | **88,9 %** ⚠️ |
| State Bank of Mauritius | 765 | 418 (54,6 %) | 0 | 347 | 0 | **45,4 %** |
| Mauritius Commercial Bank | 8 282 | 5 607 (67,7 %) | 3 (0,0 %) | 2 672 | 0 | **32,3 %** |
| **Total** | **9 056** | **6 026 (66,5 %)** | **3** | **3 027** | **0** | **33,4 %** |

⚠️ Absa : 9 transactions — non significatif.

**Le repli total (niveau 4) est à zéro** : `bank_label_raw` est peuplé sur 100 % des transactions. Il n'y a donc jamais d'« Opération bancaire » affiché. Le problème n'est pas une absence de donnée, mais une **absence d'enrichissement de la donnée présente**.

### 2.2 Enrichissement amont par institution

| Institution | Tx | `CleanMerchantName` fourni | Catégorie exploitable (≠ `UNCLASSIFIED`) | `ClassificationSource = UNCLASSIFIED` |
|---|---:|---:|---:|---:|
| Absa ⚠️ | 9 | 1 (11,1 %) | 0 (0,0 %) | 9 |
| SBM | 765 | 418 (54,6 %) | 34 (4,4 %) | 731 |
| MCB | 8 282 | 5 607 (67,7 %) | 572 (6,9 %) | 7 710 |
| **Total** | **9 056** | **6 026 (66,5 %)** | **606 (6,7 %)** | **8 450 (93,3 %)** |

### 2.3 Le pire cas — ni marchand, ni catégorie exploitable

| Institution | Tx | Ni marchand ni catégorie | % |
|---|---:|---:|---:|
| Absa ⚠️ | 9 | 8 | 88,9 % |
| SBM | 765 | 347 | 45,4 % |
| MCB | 8 282 | 2 672 | 32,3 % |

**Aucune banque n'est épargnée.** MCB, la mieux servie, laisse tout de même près d'un tiers de ses transactions sans aucune information exploitable. Le classement ci-dessus mesure surtout un **degré**, pas une exception : le défaut est systémique.

---

## 3. (b) Caractérisation structurelle des patterns

### 3.1 Le fait central — une falaise d'enrichissement liée à la longueur

Taux d'obtention d'un `CleanMerchantName` selon la longueur du narratif brut :

**MCB** (8 282 tx)

| Longueur du narratif | Tx | Enrichies | **% enrichi** |
|---|---:|---:|---:|
| ≤ 40 car. | 3 313 | 3 308 | **99,8 %** |
| 41–60 car. | 3 001 | 2 268 | **75,6 %** |
| 61–80 car. | 930 | 21 | **2,3 %** |
| > 80 car. | 1 038 | 10 | **1,0 %** |

**SBM** (765 tx)

| Longueur du narratif | Tx | Enrichies | **% enrichi** |
|---|---:|---:|---:|
| ≤ 20 car. | 116 | 116 | **100,0 %** |
| 21–35 car. | 213 | 204 | **95,8 %** |
| 36–45 car. | 114 | 90 | **78,9 %** |
| > 45 car. | 322 | 8 | **2,5 %** |

Le décrochage est **brutal et net** — pas une dégradation progressive. Il ressemble à un seuil de traitement, non à une difficulté croissante de parsing.

### 3.2 Les narratifs non enrichis sont plus RICHES, pas plus pauvres

Comparaison de la forme du narratif selon que l'enrichissement a réussi ou échoué :

| Métrique structurelle | MCB — enrichi | MCB — **échec** | SBM — enrichi | SBM — **échec** |
|---|---:|---:|---:|---:|
| Longueur moyenne | 37,1 | **73,9** | 27,9 | **47,5** |
| Longueur médiane | 39 | **71** | 32 | **48** |
| Nombre de mots moyen | 3,1 | **6,1** | 3,2 | 3,1 |
| Contient un mot ≥ 8 lettres | 73,2 % | **99,3 %** | 32,5 % | **38,9 %** |
| Contient un mot ≥ 4 lettres | 100 % | **100 %** | 93,1 % | **100 %** |
| Aucun segment alphabétique lisible | 0,0 % | **0,0 %** | 6,9 % | **0,0 %** |

**Lecture :** sur les deux banques, **100 % des narratifs non enrichis contiennent au moins un mot alphabétique de 4 lettres ou plus**, et chez MCB **99,3 % en contiennent un de 8 lettres ou plus**. Ces libellés ne sont pas des codes nus : ils portent du texte lisible. L'échec d'enrichissement ne s'explique donc pas par une absence d'information exploitable dans le champ.

### 3.3 Les narratifs longs sont STRUCTURÉS — segments concaténés

Sur les narratifs longs non enrichis (> 45 caractères) :

| Séparateur présent | MCB (2 564 tx) | SBM (314 tx) |
|---|---:|---:|
| Barre verticale `\|` | **100,0 %** | 0,0 % |
| Barre oblique `/` | 67,5 % | **82,8 %** |
| Deux-points `:` | 0,7 % | **85,7 %** |
| Tiret `-` | 14,4 % | 78,0 % |
| Nb moyen de `/` par libellé | 2,9 | 3,0 |

**Chez MCB, 100 % des narratifs longs non enrichis contiennent une barre verticale.** C'est la signature d'un enregistrement **multi-champs aplati en une seule chaîne** : la structure existe côté source, elle est détruite à la sérialisation. SBM présente le même phénomène avec un jeu de séparateurs différent (`:` et `/`).

C'est le point le plus actionnable du constat : **l'amont dispose de champs séparés qu'il concatène**, plutôt que de les exposer.

### 3.4 Troncature — plafonds durs, différents par banque

| Institution | Longueur max observée | Exactement au plafond | À moins de 5 car. du plafond | % du volume banque |
|---|---:|---:|---:|---:|
| MCB | **100** | 360 | 546 | 6,6 % |
| SBM | **50** | 29 | 317 | **41,4 %** |
| Absa ⚠️ | 89 | — | — | — |

Deux plafonds ronds et distincts (100 et 50) sur deux connecteurs différents : signature d'une **limite de champ côté extraction amont**, pas d'une limite bancaire. **Chez SBM, 41 % des transactions frôlent ou atteignent le plafond de 50 caractères** — l'information est vraisemblablement coupée avant de nous parvenir.

À noter : la troncature (100 / 50) et la falaise d'enrichissement (~60 / ~45) sont **deux phénomènes distincts**, à des seuils différents.

### 3.5 Densité technique — le cas SBM est spécifique

| Métrique | MCB — échec | SBM — échec |
|---|---:|---:|
| Entièrement en capitales | 0,4 % | **94,5 %** |
| Contient au moins un chiffre | 83,2 % | **97,1 %** |
| Contient une référence ≥ 6 chiffres | 25,9 % | **81,6 %** |
| Contient une date intégrée | 11,5 % | **51,9 %** |
| **Part de caractères numériques** | 16,1 % | **44,9 %** |
| Commence par un code court en capitales | 25,3 % | **56,5 %** |
| Commence par un chiffre | 0,0 % | 34,3 % |

**Deux profils de défaut nettement différents :**

- **MCB** — narratif long, en casse mixte, faiblement numérique (16 %), riche en texte. *Le libellé est bon ; l'extraction échoue.*
- **SBM** — narratif tout en capitales (94,5 %), **quasi la moitié des caractères sont des chiffres**, 81,6 % portent une référence longue, 51,9 % une date. *Le libellé est réellement pauvre en plus de l'extraction défaillante.*

Forme anonymisée du profil SBM dégradé (**structure reconstituée, aucune valeur réelle**) :
`XX/000000000/JJ-MM-AA:REF000000`

Forme anonymisée du profil MCB dégradé :
`CODE 00000000 | LIBELLE TEXTUEL LONG | 00/00 | REF-000000`

### 3.6 Cardinalité — pas de codes génériques répétés

| Institution | Groupe | Tx | Libellés distincts | % unicité |
|---|---|---:|---:|---:|
| MCB | avec marchand | 5 607 | 2 374 | 42,3 % |
| MCB | **sans marchand** | 2 675 | 2 376 | **88,8 %** |
| SBM | avec marchand | 418 | 294 | 70,3 % |
| SBM | **sans marchand** | 347 | 345 | **99,4 %** |

Les libellés non enrichis sont **quasi tous uniques** (88,8 % et 99,4 %). Ce ne sont donc pas des codes techniques génériques répétés : chacun décrit une opération singulière. **Écarter l'hypothèse « l'amont renvoie un code passe-partout ».**

### 3.7 Nature du `CleanMerchantName` fourni

| Institution | Tx enrichies | Marchand contenu dans le brut | Marchand ≡ brut entier | Marchands distincts |
|---|---:|---:|---:|---:|
| MCB | 5 607 | 71,3 % | 716 (12,8 %) | 784 |
| SBM | 418 | 84,2 % | 279 (66,7 %) | 244 |

Le `CleanMerchantName` est majoritairement un **extrait littéral du narratif**, pas un libellé issu d'un référentiel marchand. Chez SBM, **deux tiers des « marchands » sont le narratif brut recopié intégralement** — la normalisation y est largement nominale.

Concentration : chez SBM, **une seule valeur de marchand couvre 78,5 %** des transactions enrichies (les 328 occurrences de la règle `SYS_EMTEL`). Autrement dit, hors une poignée de mots-clés, l'enrichissement SBM ne produit presque rien.

---

## 4. (c) Champ OBIE incriminé, par banque

### 4.1 Chaîne de mapping vérifiée côté TYGR

| Champ TYGR | Champ API Omni-FI | Emplacement | Code |
|---|---|---|---|
| `bank_label_raw` | `TransactionInformation` | racine de la transaction | `orchestrateur.ts:114` |
| `clean_label` | `CleanMerchantName` | **imbriqué sous `Enrichment{}`** | `orchestrateur.ts:115` |
| `primary_category` | `PrimaryCategory` | imbriqué sous `Enrichment{}` | `orchestrateur.ts:121` |
| `classification_source` | `ClassificationSource` | imbriqué sous `Enrichment{}` | `orchestrateur.ts:129` |

Le mapping TYGR est conforme au contrat réellement servi. **La pauvreté n'est pas un défaut d'ingestion de notre côté.**

### 4.2 Diagnostic par banque

| Institution | Problème de **libellé** | Problème de **catégorie** | Champ OBIE en cause | Diagnostic |
|---|---|---|---|---|
| **MCB** | Non — narratif riche (99,3 % de mots longs), mais **tronqué à 100 car.** et **aplati avec `\|`** | Oui — 93,1 % `UNCLASSIFIED` | `Enrichment.CleanMerchantName` vide au-delà de ~60 car. ; `Enrichment.PrimaryCategory` | **Extraction + catégorie.** Le `TransactionInformation` est exploitable. |
| **SBM** | **Oui** — 94,5 % capitales, 44,9 % de chiffres, **tronqué à 50 car.** (41 % au plafond) | Oui — 95,6 % `UNCLASSIFIED` | `TransactionInformation` pauvre à la source **+** `Enrichment.*` vide | **Les deux.** Seule banque où le narratif lui-même est en cause. |
| **Absa** ⚠️ | Indéterminé — 9 tx | Indéterminé — 9 tx | — | **Échantillon insuffisant.** Ne pas conclure. |

### 4.3 Champs OBIE de contrepartie — absents du contrat

Vérification menée sur le backend Omni-FI (code source consulté en local) : `MerchantDetails`, `CreditorName`, `DebtorName`, `RemittanceInformation` **ne sont ni modélisés ni exposés**. Il n'existe donc **aucune source structurée de nom de contrepartie** dans l'API — tout doit être deviné par analyse textuelle du narratif. Ce n'est pas un bug mais une **limite de modélisation**, et c'est la demande d'évolution la plus structurante à porter.

En revanche `BankTransactionCode` et `ProprietaryBankTransactionCode` **existent** côté amont mais ne sont **pas ingérés par TYGR** — piste d'amélioration de notre côté (§6).

### 4.4 Corroboration côté amont — et sa limite

Les 606 transactions catégorisées le sont via **9 identifiants de règle**, tous préfixés `SYS_` :

| `rule_id_match` | Catégorie | Sous-catégorie | Tx | Banques |
|---|---|---|---:|---:|
| `SYS_EMTEL` | UTILITIES | Telecommunications | 328 | 2 |
| `SYS_SERVICE FEE` | BANKING_AND_FINANCE | Bank Fees | 149 | 1 |
| `SYS_MAURITIUS TELECOM` | UTILITIES | Telecommunications | 80 | 1 |
| `SYS_BANK CHARGE` | BANKING_AND_FINANCE | Bank Fees | 29 | 1 |
| `SYS_CWA` | UTILITIES | Water | 14 | 2 |
| `SYS_OWN ACCOUNT` | INTER_ACCOUNT_TRANSFER | Own Account Transfer | 3 | 2 |
| `SYS_LOAN INTEREST` | BANKING_AND_FINANCE | Interest | 1 | 1 |
| `SYS_CEB` | UTILITIES | Electricity | 1 | 1 |
| `SYS_ATM` | BANKING_AND_FINANCE | ATM Withdrawal | 1 | 1 |

Ces identifiants correspondent exactement au format `f'SYS_{keyword}'` d'une **liste de mots-clés codée en dur** trouvée dans le pipeline d'enrichissement amont, associée à `confidence_level='MEDIUM'` et `classification_source='SYSTEM_RULE'` — les deux valeurs **effectivement observées en base**. La catégorisation repose donc sur une table de mots-clés, sans classifieur.

> **Limite méthodologique à respecter.** La copie locale du backend Omni-FI date du **18 juin 2026** et diverge de ce qui tourne réellement : la production émet des catégories en `SCREAMING_SNAKE_CASE` (`BANKING_AND_FINANCE`) et des règles absentes de la copie locale (`SYS_SERVICE FEE`, `SYS_LOAN INTEREST`, `SYS_OWN ACCOUNT`). **Ne rien affirmer publiquement sur l'état actuel du code amont.** Le message Slack (§7) s'en tient donc strictement aux mesures faites sur les données reçues, et pose des questions plutôt que des diagnostics.

---

## 5. Distinction demandée — libellé, catégorie, ou les deux

| Dimension | Verdict | Preuve |
|---|---|---|
| **Problème de libellé (source)** | **SBM oui, MCB non** | MCB : 99,3 % des narratifs non enrichis ont un mot ≥ 8 lettres. SBM : 44,9 % de caractères numériques, 94,5 % capitales |
| **Problème d'extraction du marchand** | **Oui, les deux — dominant** | Falaise 99,8 % → 2,3 % (MCB) et 100 % → 2,5 % (SBM) selon la seule longueur |
| **Problème de catégorie** | **Oui, transversal et massif** | 93,3 % `UNCLASSIFIED` ; 9 règles à mot-clé pour tout le volume |
| **Problème de troncature** | **Oui, différencié** | Plafonds durs 100 (MCB) / 50 (SBM) ; 41 % du volume SBM au plafond |

**Ordre de traitement recommandé pour l'amont :** extraction du marchand sur narratifs longs (débloque ~30 % du volume) → exposition des segments structurés → catégorisation → révision des plafonds de troncature.

---

## 6. À corriger côté TYGR — ne pas envoyer à Omni-FI

L'investigation a révélé **deux défauts qui nous appartiennent**. Ils sont listés ici pour honnêteté du constat et doivent être traités séparément.

**6.1 — `UNCLASSIFIED` n'est pas neutralisé à l'ingestion (défaut réel, à corriger).**

`CATEGORIES_OBIE_VIDES` (`src/server/ingestion/orchestrateur.ts:77`) ne contient que `"uncategorized"`. L'amont émet aujourd'hui **`UNCLASSIFIED`**, qui ne correspond pas. Conséquence mesurée en base :

- `is_auto_categorized = true` sur **9 056 / 9 056** transactions (100 %)
- alors que seules **606** portent une catégorie réellement exploitable (6,7 %)

**93,3 % des transactions sont donc marquées « catégorisées automatiquement par Omni-FI » alors qu'elles ne le sont pas**, et `category_source = 'OMNIFI'` est posé à tort sur l'ensemble. Tout indicateur interne de fiabilité de classification bâti sur ces colonnes est aujourd'hui faux. L'affichage n'est pas affecté (la traduction FR rattrape le cas en aval), ce qui a masqué le défaut.

> Le garde-fou existant était correct au moment de son écriture : l'amont a changé sa valeur par défaut sans que la liste fermée suive. La correction doit traiter `UNCLASSIFIED` **et** `UNCATEGORIZED`, et le test doit porter sur la valeur réellement observée en base, pas sur la fixture.

**6.2 — `BankTransactionCode` / `ProprietaryBankTransactionCode` non ingérés.**

Ces deux champs existent dans le contrat amont et ne sont pas récupérés. Ils pourraient alimenter un libellé de repli typé (« Frais bancaires », « Retrait DAB ») nettement plus lisible que le narratif brut, sans dépendre d'Omni-FI. **Piste à évaluer indépendamment du signalement.**

---

## 7. (d) Brouillon de message Slack — à relire et envoyer par Etienne

> Non envoyé. À relire avant transmission. Volontairement court, chiffré, sans diagnostic sur le code amont.

---

Salut 👋

On a mesuré la qualité des libellés de transaction côté TYGR sur **9 056 transactions réelles** (MCB, SBM, Absa — avril→juillet). On voulait vous remonter ça avec des chiffres plutôt qu'une impression, parce qu'il y a un point qui nous a surpris.

**Le constat principal : ce n'est pas que les libellés soient pauvres, c'est qu'on n'en extrait pas le marchand quand ils sont longs.**

Taux de `Enrichment.CleanMerchantName` renseigné, selon la longueur de `TransactionInformation` :

| Longueur | MCB | SBM |
|---|---|---|
| court (≤ 40 / ≤ 20 car.) | **99,8 %** | **100 %** |
| moyen (41–60 / 21–35) | 75,6 % | 95,8 % |
| long (61–80 / 36–45) | **2,3 %** | 78,9 % |
| très long (> 80 / > 45) | **1,0 %** | **2,5 %** |

Le décrochage est net, et il suit **uniquement la longueur**. Or les libellés longs sont les plus riches : **99,3 %** des narratifs MCB non enrichis contiennent un mot de 8 lettres ou plus. L'info de contrepartie est bien dans le champ — elle n'en ressort pas.

**Trois autres points chiffrés :**

1. **Catégorisation** — 93,3 % des transactions arrivent en `PrimaryCategory: UNCLASSIFIED`, toutes banques confondues. Les 6,7 % restants viennent de **9 `rule_id_match` distincts**, tous en `SYS_*` (Emtel, CWA, CEB, bank charge…). Concrètement la catégorie n'est pas exploitable pour de la trésorerie.

2. **Troncature** — `TransactionInformation` plafonne à **100 caractères sur MCB** et **50 sur SBM**. Côté SBM, **41 % des transactions sont à moins de 2 caractères du plafond** : on pense que l'info est coupée avant de nous arriver. Est-ce une limite voulue ?

3. **Structure aplatie** — **100 %** des libellés MCB longs non enrichis contiennent un `|`, et 85 % des SBM un `:`. On dirait des champs séparés concaténés en une chaîne. Si c'est le cas, les exposer séparément nous éviterait de les re-parser (et à vous d'en extraire le marchand).

**Profils par banque** (formes anonymisées, aucune donnée client) :
- **MCB** — libellé riche mais long, casse mixte, ~16 % de chiffres. `CODE 00000000 | LIBELLE TEXTUEL | 00/00 | REF-000000`
- **SBM** — nettement plus pauvre : **94,5 % tout en majuscules, 45 % des caractères sont des chiffres**, 82 % portent une référence longue. `XX/000000000/JJ-MM-AA:REF000000`
- **Absa** — seulement 9 transactions chez nous, on ne conclut rien.

**Ce qui nous aiderait, par ordre d'impact pour nous :**

1. Extraire le marchand aussi sur les narratifs longs — ça débloquerait à soi seul **~30 % de notre volume** (3 027 transactions aujourd'hui affichées en libellé brut).
2. Exposer les segments du narratif séparément plutôt que concaténés, quand la structure existe à la source.
3. Un champ de contrepartie structuré (type `CreditorName` / `DebtorName` / `MerchantDetails` OBIE) — aujourd'hui il n'y a aucune source de nom de contrepartie autre que le texte libre.
4. Confirmer si les plafonds 100 / 50 caractères sont intentionnels.

Dites-nous ce qui est réaliste et sur quel horizon — on adaptera notre affichage en attendant. Et si vous voulez qu'on vous transmette des `TransactionId` précis pour reproduire, on peut le faire par un canal adapté (on évite de coller des libellés bancaires ici).

Merci 🙏

---

## 8. Annexes — reproductibilité

Scripts de diagnostic (lecture seule, `BEGIN TRANSACTION READ ONLY`, hors dépôt) :

```
<scratchpad>/diag-libelles-1-recon.mjs       volumétrie, colonnes peuplées
<scratchpad>/diag-libelles-2-categories.mjs  valeurs de catégorie et métadonnées amont
<scratchpad>/diag-libelles-3-cascade.mjs     cascade par institution  → §2
<scratchpad>/diag-libelles-4-forme.mjs       métriques de forme       → §3.2, §3.5, §3.6
<scratchpad>/diag-libelles-5-preuve.mjs      falaise de longueur      → §3.1, §3.7, §4.4
<scratchpad>/diag-libelles-6-troncature.mjs  troncature et structure  → §3.3, §3.4
```

Lancement : `node --env-file=.env <script>` depuis `tygr-app/`. Aucun n'écrit en base — la transaction en lecture seule est un verrou PostgreSQL, pas une convention.

**Ce qui n'a pas été fait** (à assumer si on nous le demande) :
- aucune vérification live contre l'API amont — l'analyse porte sur les données déjà ingérées ;
- aucune inspection du code Omni-FI déployé — seulement une copie locale datée du 18/06, qui diverge de la production ;
- Absa écarté de toute conclusion (9 transactions).
