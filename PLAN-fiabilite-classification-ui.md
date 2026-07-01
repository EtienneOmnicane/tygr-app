# PLAN — Affichage des indices de fiabilité de classification (`/transactions`)

> **Phase : CONCEPTION (Planning).** Aucun code applicatif n'est écrit ici (CLAUDE.md règle 1).
> Ce document décrit les composants impactés, la logique d'affichage, la donnée requise,
> et l'étape de QA visuelle headless. Il attend **validation humaine** avant implémentation.
>
> Auteur : Agent Frontend · Date : 2026-06-24 · Cible : page `/transactions`
> Dépend de : `feat/tech-api-trace-classification` (persistance amont, **NON mergée** — cf. §2).

---

## 0. TL;DR (pour relecture rapide)

- On ajoute **deux indices** sur chaque ligne de `/transactions`, distincts l'un de l'autre et
  **distincts du badge de ventilation manuelle existant** (`CategorisationStatusBadge`) :
  1. un badge **« À vérifier »** (ambre) quand la classification amont est peu fiable ;
  2. une **icône de source** discrète (⚙ règle / 🤖 modèle) avec infobulle, quand la source amont est connue.
- **Décision produit n°1 (validée)** : « À vérifier » s'affiche **seulement si `confidence == Low` ET une catégorie est posée**.
  Raison : le serializer Omni-FI met `ConfidenceLevel` à `"Low"` **par défaut** sur les lignes non enrichies — un « Low strict » badgerait la majorité des lignes (bruit).
- **Décision produit n°2 (validée)** : la source amont (`USER_RULE`/`SYSTEM_RULE`/`ML_FALLBACK`) est une **icône + tooltip**, jamais du texte en sous-texte (risque de chevauchement), et **jamais libellée « utilisateur »** — c'est la règle Omni-FI, pas la saisie TYGR.
- **🚧 BLOQUANT data (§2)** : la donnée est **persistée en base mais ne remonte PAS jusqu'au Front**. La branche `feat/tech-api-trace-classification` n'est ni mergée, ni branchée sur la chaîne de lecture (`repositories/transactions.ts` → `adapter.ts` → `TransactionListItem`). **Ce travail Backend est un pré-requis dur** ; sans lui, la couche UI n'a rien à afficher.

---

## 1. Contexte & cadrage sémantique (anti-confusion — à lire avant tout)

Trois concepts cohabitent sur une ligne de transaction. Les confondre serait un bug de sens.
Le briefing parle de « source banque ou utilisateur » : **cette formulation mélange deux d'entre eux** et le plan la corrige explicitement.

| Concept | Champ source | Sens réel | Déjà affiché ? |
|---|---|---|---|
| **A. Ventilation manuelle TYGR** | `transaction_categorizations` (splits) → `statutCategorisation`, `nbCategories` | L'**utilisateur TYGR** a réparti le montant sur des catégories (manuel). « Non catégorisé / N catégories / partiel ». | ✅ Oui — `CategorisationStatusBadge` (colonne dédiée). **NE PAS TOUCHER.** |
| **B. Fiabilité de la classification amont** | `transactions_cache.confidence_level` (`High`/`Medium`/`Low`, **défaut `"Low"`**) | À quel point **Omni-FI** est sûr de la catégorie qu'**il** a posée automatiquement. | ❌ Non — **objet de ce plan** (badge « À vérifier »). |
| **C. Source de la classification amont** | `transactions_cache.classification_source` (`USER_RULE`/`SYSTEM_RULE`/`ML_FALLBACK`) | Quelle **sous-source Omni-FI** a classé : une règle (utilisateur côté Omni-FI ou système) ou un modèle ML. **PAS la saisie TYGR.** | ❌ Non — **objet de ce plan** (icône + tooltip). |

> ⚠️ **Piège sémantique `USER_RULE`** (doc API §1355, `USER_RULE > SYSTEM_RULE > ML_FALLBACK`) :
> `USER_RULE` = une règle définie **dans Omni-FI**, pas une catégorisation saisie par le Financial
> Manager dans TYGR. Le libellé d'infobulle ne dira **jamais** « par l'utilisateur » tout court
> (qui se confondrait avec le concept A), mais **« par règle Omni-FI »**. La surcharge **manuelle**
> côté Omni-FI passe par un endpoint `override` distinct (§1361) que **nous n'ingérons pas** au MVP.

> ⚠️ **Piège `ConfidenceLevel` numérique vs ordinal** : la doc montre aussi `"Confidence": 0.97`
> (ligne 1029) — mais c'est le **score d'analyse de documents uploadés** (statement parsing),
> **pas** l'enrichissement de transaction. `Enrichment.ConfidenceLevel` est un **libellé ordinal**
> (`High`/`Medium`/`Low`), confirmé par le serializer (`types.ts:89`). On raisonne en libellés, **jamais en float** (règle 8).

### 1.1 Données déjà disponibles côté ligne (ne rien réinventer)

`TransactionListItem` (`types-transactions.ts`) porte déjà : `cleanLabel`, `bankLabelRaw`,
`categorieBanque` (catégorie OBIE traduite FR, `null` si absente/non cartographiée), `compteNom`,
`statutCategorisation`, `categorie`, `nbCategories`. La ligne (`transaction-row.tsx`) a déjà un
sous-texte « compte · catégorie » et un `title` = libellé brut.

Le repository `TransactionLigne` expose déjà `isAutoCategorized` et `categorySource`
(`'OMNIFI'`) — utile pour la **condition « catégorie posée »** de la décision n°1 (voir §4.1).

---

## 2. 🚧 PRÉ-REQUIS DATA — la donnée ne remonte PAS encore au Front (BLOQUANT)

**Constat vérifié dans le code (pas une supposition) :**

- ✅ **Persistance OK mais isolée** : `feat/tech-api-trace-classification` ajoute `confidence_level`,
  `classification_source`, `rule_id_match` à `transactions_cache` (migration `0012`, `schema.ts:402-404`,
  ingestion `orchestrateur.ts:128-129` + `ingestion.ts:194-214`). L'**écriture** est faite.
- ❌ **Branche NON mergée** dans `main` (`git branch -r --no-merged origin/main` la liste).
- ❌ **Aucune voie de lecture** : le `select` de `repositories/transactions.ts` (lignes 250-271)
  **ne projette pas** ces colonnes ; `TransactionLigne` (interface) ne les porte pas ; `adapter.ts`
  → `TransactionListItem` ne les connaît pas. **Donc, même la branche mergée, la donnée s'arrête à l'ingestion.**

**Conséquence :** la couche UI (mon périmètre) ne peut afficher ces indices que si la chaîne de
lecture les transporte. C'est du **code serveur (frontière Backend** — cf. mémoire `gouvernance-frontiere-ui`).
Le présent plan **liste précisément ce qui manque** (§2.1), mais **ne l'implémente pas** : c'est une
**dépendance Backend à ordonnancer avant** la livraison UI.

### 2.1 Liste de courses Backend (pré-requis, hors de mon périmètre d'implémentation)

| # | Fichier | Changement | Note |
|---|---|---|---|
| BK-1 | — | **Merger** `feat/tech-api-trace-classification` dans `main` (Human-in-the-Loop). | Persistance + migration 0012. Sans elle, les colonnes n'existent pas. |
| BK-2 | `server/repositories/transactions.ts` | Projeter `confidenceLevel`, `classificationSource` dans le `select` (lignes 250-271) + les ajouter à l'interface `TransactionLigne`. | `rule_id_match` **non requis** par l'UI (identifiant opaque, aucun usage d'affichage) — ne pas l'exposer. |
| BK-3 | `(workspace)/transactions/adapter.ts` | Mapper ces 2 champs vers le DTO UI dans `versLigneUI`. | Conversion pure, déjà le rôle de l'adaptateur. |
| BK-4 | `components/transactions/types-transactions.ts` | Étendre `TransactionListItem` (voir §3 le contrat exact souhaité). | C'est le **contrat** que l'UI consommera. |

> **Pushback (règle 10).** Avant d'écrire la moindre ligne d'UI, ces 4 points doivent être
> tranchés. **Deux ordres possibles**, je recommande le premier :
>
> - **Option A (recommandée) — Backend d'abord, UI ensuite, 2 PR séquentielles.**
>   Coût : 1 aller-retour de plus. Bénéfice : l'UI se branche sur une donnée **réelle** et la
>   QA visuelle (§6) teste du vrai, pas du mock. Pas de DTO « fantôme » mergé sans producteur.
> - **Option B — UI en parallèle contre un contrat figé (deps injectables + stub démo).**
>   Coût : risque de divergence contrat/réalité (déjà vécu, d'où l'`adapter.ts`). Bénéfice :
>   parallélisme. Acceptable **uniquement** si BK-4 (le contrat) est gelé **en premier** et que
>   la démo `demo/transactions` fournit le stub.
>
> Tant que l'humain n'a pas tranché A/B, la partie UI ci-dessous est **conçue mais pas codée**.

---

## 3. Contrat de données souhaité (extension `TransactionListItem`)

Ajouts proposés au DTO (BK-4). Les noms restent **alignés sur le vocabulaire amont** mais
**typés en union** côté UI pour rendre l'affichage déterministe et tester les cas.

```ts
// AJOUTS à TransactionListItem (types-transactions.ts) — proposition de contrat
//
// Fiabilité amont (B). Libellé ordinal Omni-FI, normalisé en union par l'adaptateur.
// `null` = la fiabilité n'a pas été remontée (ligne ancienne pré-0012, ou API muette).
// ATTENTION : "Low" est le DÉFAUT serializer — il NE signifie PAS "douteux" en soi
// (cf. règle d'affichage §4.1 qui croise avec la présence d'une catégorie).
niveauFiabilite: "High" | "Medium" | "Low" | null;

// Source amont (C). Normalisée en union ; `null` si inconnue/non remontée.
// "USER_RULE" = règle définie DANS Omni-FI, JAMAIS la saisie manuelle TYGR (concept A).
sourceClassification: "USER_RULE" | "SYSTEM_RULE" | "ML_FALLBACK" | null;
```

> **Normalisation côté adaptateur (BK-3), pas côté composant** : l'adaptateur reçoit une chaîne
> amont libre (les colonnes sont `varchar(120)` **sans CHECK** — choix de résilience Backend
> assumé, cf. migration 0012). Il **mappe vers l'union** et retombe sur `null` pour toute valeur
> inattendue (`High`→`High`, valeur inconnue→`null`). Le composant ne voit **jamais** de chaîne libre.
> Cela isole l'UI des nouveautés d'API (même esprit que `traduireCategorieBanque`).

---

## 4. Logique d'affichage (le cœur)

### 4.1 Badge « À vérifier » (fiabilité — concept B)

**Règle de décision (validée) — fonction PURE, isolée et testée :**

```
afficherAVerifier(item) =
     item.niveauFiabilite === "Low"
  ET uneCategorieEstPosee(item)
```

où `uneCategorieEstPosee(item)` = **`item.categorieBanque !== null`** (la catégorie OBIE traduite
est présente). Justification : si Omni-FI n'a **pas** posé de catégorie, la ligne relève du repli
« Non catégorisé » **déjà géré** ; la badger « À vérifier » serait redondant et bruyant. On ne
veut le badge que sur une catégorie **présente mais peu sûre**.

| `niveauFiabilite` | catégorie posée | Rendu |
|---|---|---|
| `Low` | oui | **⚠ À vérifier** (ambre) |
| `Low` | non | rien (la ligne est déjà « Non catégorisé ») |
| `Medium` / `High` | — | rien (classification sûre) |
| `null` | — | rien (donnée absente — **jamais** d'alarme sur une absence) |

- **Isolation du seuil (anti-dette)** : la règle vit dans **un seul module pur**
  (`regle-fiabilite.ts`, proposé §5), avec une constante `NIVEAUX_A_VERIFIER = ["Low"]` et le
  flag `EXIGE_CATEGORIE = true`. Si l'observation réelle (sandbox/prod) montre qu'il faut élargir
  à `Medium` ou retirer la condition catégorie, **on change une constante**, pas la logique de rendu.
  → tracé comme dette P2 « affiner le seuil après mesure des volumes » (voir §8).

- **Token couleur** : **ambre `warning` / `warning-bg`** (UI_GUIDELINES §3.6 « badges de statut » +
  §3.7 fraîcheur). Cohérent avec l'`IndicePartiel` existant (déjà ambre). **JAMAIS de rouge** :
  le rouge `outflow` est réservé aux **montants** (§3.1) ; « à vérifier » est un état, pas une erreur
  ni une perte. **JAMAIS de vert/rouge sur un badge de catégorie** (règle déjà inscrite dans
  `categorisation-status-badge.tsx`).

- **Forme** : pastille pill 11px, `warning-bg` + texte `warning`, icône triangle outline inline
  (SVG, pas de lucide — règle 9). Libellé court **« À vérifier »**. `title`/`aria-label` explicite :
  « Classification automatique peu fiable — à vérifier ».

### 4.2 Icône de source (concept C)

**Règle :** afficher une icône **seulement si `sourceClassification !== null`**.

| `sourceClassification` | Icône | Infobulle (`title`) |
|---|---|---|
| `USER_RULE` | ⚙ (engrenage/règle, outline) | « Classé par règle Omni-FI » |
| `SYSTEM_RULE` | ⚙ (même glyphe règle) | « Classé par règle système Omni-FI » |
| `ML_FALLBACK` | 🤖 (modèle/puce, outline) | « Classé par modèle (ML) Omni-FI » |
| `null` | (rien) | — |

- **Discrétion** : l'icône est petite (`size-3.5`), `text-text-muted`, posée **en fin du sous-texte
  existant** « compte · catégorie » de la ligne — **pas** une nouvelle colonne, **pas** du texte
  (décision n°2 : éviter le chevauchement avec le sous-texte). Elle ne porte **aucune couleur
  sémantique** (ni inflow/outflow ni warning) : c'est un repère neutre, pas un statut.
- **Accessibilité** : `aria-hidden` sur le glyphe + `title` sur le wrapper + un `<span class="sr-only">`
  portant le libellé complet (l'icône seule n'est pas lisible au lecteur d'écran). Le `title` global
  de la ligne (`bankLabelRaw`) reste prioritaire au survol de la **zone large** ; l'icône a son propre
  `title` sur sa **zone propre** (survol ciblé), sans masquer celui de la ligne.
- **Regroupement `USER_RULE`/`SYSTEM_RULE`** sur le même glyphe ⚙ : ce sont deux variantes de
  « règle » ; seul le ML mérite un glyphe distinct (origine probabiliste). Évite un zoo d'icônes.

### 4.3 Placement & cohabitation (anti-chevauchement — préoccupation centrale de la QA)

Rappel de la structure actuelle de la ligne (`transaction-row.tsx`) :

```
┌──────────┬─────────────────────────────────────┬──────────────┬───────────────┐
│  Date    │ Libellé (marchand)                  │ Statut       │      Montant   │
│          │ compte · catégorie banque    [⚙/🤖] │ ventilation  │   (signé, €)   │
│          │ [badge ventilation en mobile]       │ (desktop)    │  [Entrée/Sortie]│
└──────────┴─────────────────────────────────────┴──────────────┴───────────────┘
```

Décisions de placement, pensées pour **ne pas casser la densité §2.2 (~44px/ligne)** :

1. **Icône source (⚙/🤖)** → **fin du sous-texte** « compte · catégorie » (colonne Libellé).
   Le sous-texte est déjà `truncate` ; l'icône est **hors flux de troncature** (posée après, en
   `inline-flex`, `shrink-0`) pour ne jamais être coupée ni pousser le texte hors cellule.
2. **Badge « À vérifier »** → **sous le badge de ventilation**, dans la **colonne Statut** (desktop).
   Cohabite avec `CategorisationStatusBadge` en pile verticale `gap-1`. En **mobile**, il se replie
   sous le libellé, **à côté** du badge de ventilation déjà replié (ligne 110-116) — en `flex-wrap`
   **local à ce conteneur** (autorisé ici, ce n'est pas le header — la règle anti-`flex-wrap` vise le header).
3. **Aucun ajout de colonne** : on réutilise les deux colonnes existantes. Pas d'élargissement du
   tableau (qui rognerait la colonne Montant, intouchable — règle « un montant ne se truncate jamais »).

**Risques de chevauchement identifiés → ce que la QA (§6) doit prouver :**

- (R1) Sur une ligne **à long marchand + long nom de compte + icône source + badge « À vérifier » + badge ventilation** :
  le sous-texte ne doit pas chevaucher l'icône ; les deux badges de la colonne Statut ne doivent pas
  déborder sur la colonne Montant.
- (R2) En **mobile** (colonne Statut masquée) : la pile repliée (libellé + 2 badges) ne doit pas
  faire exploser la hauteur de ligne ni rogner le montant.
- (R3) Un nom de compte **très long** (ex. « Compte Courant Principal Multi-Devises EUR ») + icône :
  vérifier que le `truncate` agit sur le **texte** et laisse l'icône intacte (shrink-0).
- (R4) Ligne **sans aucun des deux indices** (`null`/`Medium`) : rendu **identique à aujourd'hui**
  (non-régression visuelle — la ligne ne doit pas « bouger »).

---

## 5. Composants UI impactés / créés (périmètre Front)

> Tous **présentationnels purs** : zéro fetch, zéro état interne, props inertes (CLAUDE.md
> « Composants d'affichage purs »). Réutilisent tokens + `cn` local (pas de clsx/cva/lucide — règle 9).

| Élément | Type | Rôle |
|---|---|---|
| `regle-fiabilite.ts` | **module pur (NOUVEAU)** | `afficherAVerifier(item)`, `libelleSource(source)`, constantes de seuil. **Aucun React.** Entièrement testable unitairement (la décision vit ici, jamais dans le `.tsx`). |
| `FiabiliteBadge.tsx` | **composant pur (NOUVEAU)** | Rend « ⚠ À vérifier » (ambre) ou `null`. Props : `niveauFiabilite`, `categoriePresente`, `size?`. N'embarque pas la donnée brute — reçoit le verdict. |
| `SourceClassificationIcon.tsx` | **composant pur (NOUVEAU)** | Rend ⚙/🤖 + `title` + `sr-only`, ou `null`. Props : `source`. |
| `transaction-row.tsx` | **modifié** | Insère l'icône en fin de sous-texte + le badge dans la colonne Statut (et le repli mobile). **Pas** d'autre changement de structure. |
| `types-transactions.ts` | **modifié (contrat)** | Les 2 champs du §3. *(Édité côté Backend si Option A ; côté Front si on gèle le contrat d'abord — à trancher §2.1.)* |
| `categorisation-status-badge.tsx` | **INCHANGÉ** | Concept A (ventilation manuelle). On **n'y touche pas** — séparation des concepts. |
| `demo/transactions/page.tsx` | **modifié** | Ajoute des lignes de démo couvrant **tous** les cas (R1-R4 + chaque source + chaque niveau) pour la QA headless hors auth/DB. |

**Pourquoi un module `regle-fiabilite.ts` séparé** : la règle (Low + catégorie) est de la **logique
métier d'affichage** susceptible d'évoluer après mesure. La sortir du composant la rend testable
sans renderer React (le projet n'a pas de renderer de test — choix tracé) et empêche qu'un futur
ajustement de seuil se disperse dans le JSX.

---

## 6. 🔎 Étape de QA Visuelle (Headless Browser) — Quality Gate 4

> **Obligatoire** (CLAUDE.md règle 4 + Human-in-the-Loop règle 3a). Tout PR UI : captures localhost
> de **chaque état modifié**, comparées **par vision** à `docs/UI_GUIDELINES.md`. Objectif spécifique
> ici : **prouver l'absence de chevauchement** introduit par les deux nouveaux indices.

### 6.1 Surface de test : route démo (hors auth/DB)

On capture via `src/app/demo/transactions/` (existe déjà), enrichie de **lignes-cas** déterministes :

| Cas démo | `niveauFiabilite` | catégorie | `sourceClassification` | Attendu |
|---|---|---|---|---|
| C1 | `Low` | présente | `ML_FALLBACK` | ⚠ À vérifier **+** 🤖 |
| C2 | `Low` | **absente** | `null` | **Aucun** badge fiabilité (→ « Non catégorisé »), aucune icône |
| C3 | `High` | présente | `USER_RULE` | Pas de badge, **⚙** seul |
| C4 | `Medium` | présente | `SYSTEM_RULE` | Pas de badge, **⚙** seul |
| C5 | `null` | présente | `null` | **Identique à aujourd'hui** (non-régression) |
| C6 | `Low` | présente, **marchand + compte très longs** | `ML_FALLBACK` | Tous indices visibles **sans chevauchement** (R1/R3) |

### 6.2 Procédure (skill `/browse` ou `/qa`, navigateur headless gstack)

1. Lancer le dev server local (⚠ **leçon mémoire `visual-qa-serveur-https-voisin`** : un lockfile
   Next global peut empêcher un 2ᵉ `next dev` ; **ne pas tuer** un serveur voisin — réutiliser le port
   déjà servi). Cibler **`http://localhost:<port>/demo/transactions`** en **HTTP** (un `https://`
   self-signed renvoie `chrome-error`, qui **n'est pas** un bug de la page).
2. **Captures** : pleine page + **zoom sur 3-4 lignes** (desktop **et** viewport mobile ~375px) pour
   inspecter la densité et les replis.
3. **Comparaison par vision** à UI_GUIDELINES : token ambre `warning` (pas rouge), `tabular-nums`
   intact sur les montants, focus visibles, densité ~44px préservée, **aucun débordement** badge→Montant.
4. **Filet anti-`chrome-error` (mémoire)** : si le navigateur headless refuse la page, **replier sur
   `curl -sk http://localhost:<port>/demo/transactions`** et **asserter sur le DOM** —
   présence/absence des classes (`text-warning`, `bg-warning-bg`), des `title` (« règle Omni-FI »,
   « à vérifier »), du `sr-only`, et **du nombre attendu de badges par cas** (C2 = 0 badge fiabilité,
   C5 = 0 indice). Le DOM prouve la logique même quand le rendu pixel est inaccessible.
5. **Assertion de non-chevauchement automatisable** (en complément de la vision) : sur C6, mesurer via
   le DOM/headless que le `right` du conteneur de badges Statut **≤** le `left` de la cellule Montant,
   et que le sous-texte tronqué n'a pas de `scrollWidth > clientWidth` qui empièterait sur l'icône.

### 6.3 Critère de sortie QA (bloquant)

- ✅ C1-C6 rendent **exactement** l'attendu (table 6.1).
- ✅ Token ambre (jamais rouge) ; aucune couleur en dur ; densité préservée ; montants jamais rognés.
- ✅ **Zéro chevauchement** prouvé sur C6 (desktop + mobile), par vision **et** par mesure DOM.
- ✅ C5 pixel-identique à `main` (diff visuel de non-régression).
- Écart sur token objectif = **BLOQUANT** ; écart de goût = noté, renvoyé à `/design-review`, non bloquant.

> **Piège de QA à éviter (mémoire `qa-uppercase-css-et-echap-portail`)** : ne **jamais** asserter sur
> le **texte visible** d'un libellé qui peut être transformé en CSS (`uppercase`, etc.) — asserter sur
> les **classes**, les `title`, ou des sélecteurs stables, pas sur la casse rendue.

---

## 7. Découpage en lots & ordre de livraison

> Séquence **après** arbitrage §2.1 (Option A recommandée). Chaque lot = un WIP commit par unité
> logique (règle 7), jamais `git add -A` (mémoire `protocole-collaboration-deux-agents`).

| Lot | Contenu | Périmètre | PR |
|---|---|---|---|
| **L0 (pré-requis)** | Merger `feat/tech-api-trace-classification` (BK-1). | Backend / humain | PR existante |
| **L1 (Backend)** | BK-2/BK-3/BK-4 : remonter `confidence_level` + `classification_source` du repository jusqu'au DTO. Test : la lecture projette bien les 2 champs ; l'adaptateur normalise une valeur inconnue → `null`. | Backend | PR #A |
| **L2 (Front)** | `regle-fiabilite.ts` + `FiabiliteBadge` + `SourceClassificationIcon` + insertion dans `transaction-row` + lignes démo. Tests purs du module règle (Low+cat, Low sans cat, Medium, null). | Front | PR #B |
| **L3 (QA)** | Captures headless C1-C6 (desktop+mobile) + assertions DOM + diff non-régression C5. Joint au PR #B. | Front | (dans #B) |

L'agent **s'arrête à la PR poussée** (Human-in-the-Loop règle 2) ; l'humain ouvre/merge.

---

## 8. Dettes & différés (TODOS.md — règle 9)

À inscrire **si** ces points sont actés au moment de l'implémentation (date, effort, déclencheur) :

- **P2 — Affiner le seuil « À vérifier »** : règle figée à `Low` + catégorie présente. Déclencheur :
  après mesure réelle de la distribution `confidence_level` en sandbox/prod (combien de lignes badgées ?).
  Si trop/trop peu, ajuster `NIVEAUX_A_VERIFIER`/`EXIGE_CATEGORIE` (constantes isolées, §4.1). Effort : S.
- **P2 — `rule_id_match` non exposé** : volontairement non remonté à l'UI (identifiant opaque, aucun
  usage d'affichage). Déclencheur : si un écran « pourquoi cette catégorie ? » voit le jour (lien vers la
  règle Omni-FI). Aujourd'hui : YAGNI. Effort : néant tant que non demandé.
- **P2 — Action « marquer comme vérifié »** : le badge « À vérifier » est **lecture seule** au MVP
  (aucun moyen de l'acquitter). Déclencheur : si les FM demandent une file de revue (rejoint
  `GAP-CATEG-NATIVE1`, déjà au backlog). Effort : M (nécessite une colonne d'état côté Backend). **Hors scope.**
- **Rappel dette existante** : `DB-MIGRATE3` (migration 0009 hors `_journal.json`) — non créée par ce
  plan, mais L0 réapplique 0012 ; vérifier que le journal est cohérent avant migrate (mémoire `migration-hors-journal-drizzle`).

---

## 9. Conformité aux règles (auto-checklist AVANT validation)

- [x] **Règle 1** — phase unique = conception, fichier sur disque, **zéro code applicatif**.
- [x] **Règle 8 / formatage** — aucun float (libellés ordinaux) ; aucune couleur en dur (tokens `warning`) ;
  montants intouchés (jamais rognés) ; vert/rouge réservés aux montants, ambre pour le statut.
- [x] **Composants purs** — nouveaux composants sans fetch/état ; réutilisation des colonnes existantes,
  pas de carte ad-hoc ; séparation stricte des 3 concepts (A intouché).
- [x] **Règle 4** — étape QA visuelle headless détaillée, critère de sortie bloquant, filet DOM.
- [x] **Règle 10** — pushback data (§2) exposé **avant** toute ligne d'UI, avec coût A/B chiffré.
- [x] **Règle 9 / dette** — différés tracés P2 avec déclencheur ; pas de `// TODO` orphelin ; pas de dep nouvelle.
- [x] **Frontière de gouvernance** — la partie lecture/contrat (§2.1) est identifiée comme **Backend** ;
  l'UI (§5) reste mon périmètre.

---

**→ J'attends ta validation de ce plan (et l'arbitrage Option A vs B au §2.1) avant de passer à l'implémentation.**
