# PLAN — Audit ergonomique & refonte visuelle (totaux, soldes, en-têtes)

> **Phase : PLANIFICATION UNIQUEMENT** (CLAUDE.md règle 1). Aucun code ni token modifié
> ici. Ce document est le livrable de conception ; l'implémentation suivra dans un fil
> séparé après feu vert humain.
> Auteur : session UX/UI + Architecte Front. Date : 2026-06-22.
> Périmètre : dashboard `(workspace)/(dashboard)` — cartes SOLDE / DÉTAILS / COMPTES,
> table récente, `AppHeader`, lib de formatage `format-montant.ts` / `format-date.ts`.

---

## 0. Mise au point préalable (pushback — CLAUDE.md règle 10)

**Le « design system gstack » de l'énoncé n'existe pas comme dépendance UI.** Le stack
réel est **Tailwind CSS + tokens custom (`src/app/globals.css` + `docs/UI_GUIDELINES.md`)
+ shadcn/ui + Tremor**. « gstack » dans ce repo = l'**outillage CLI** (skills `/browse`,
`/qa`, `/design-review`, navigateur headless), pas un thème. Conséquence sur ce plan :
on ne planifie **aucune** « primitive gstack » fictive. La refonte s'exprime en :
classes Tailwind + tokens UI_GUIDELINES existants (`ink`, `primary`, `inflow/outflow`,
`surface-*`, `text-*`, `tabular-nums`), nouveaux composants présentationnels purs si
besoin, et l'outillage gstack sert au **Visual QA** (capture headless) — pas au rendu.

Tout le reste du plan respecte cette réalité : zéro dépendance nouvelle (règle 9), zéro
float (règle 8), tokens uniquement (jamais de couleur en dur).

---

## 1. Audit ergonomique & Challenge UX/UI

### 1.1 État des lieux (constats ancrés `fichier:ligne`)

| # | Constat | Preuve | Sévérité |
|---|---------|--------|----------|
| C1 | **Devise en suffixe** partout (`7 691 000,00 MUR`). À Maurice, MUR/Rs se lit usuellement en **préfixe** ; le suffixe noie l'unité loin de l'œil et allonge la ligne (cause aggravante des troncatures). | `format-montant.ts:53` (`${corps}${ESPACE}${devise}`) | Moyenne |
| C2 | **Pas de hiérarchie de devise** dans la carte SOLDE multi-devises : N lignes `text-xl` égales, aucune devise « principale » mise en avant ; en mono-devise le 28px est bon. | `side-panel-kpi.tsx:57-69` | Moyenne |
| C3 | **DR-F3 — méta « au JJ/MM » trompeuse** : la carte SOLDE affiche `au {dateSolde}` où `dateSolde` = **dernier point de courbe** (EOD), alors que le montant est le **solde COURANT** (`current_balance`). Décalage sémantique réel. | `side-panel-kpi.tsx:55` + `dashboard-content.tsx:65-67` | **Haute** (induit en erreur un FM) |
| C4 | **§3.7 « Fraîcheur » des guidelines NON implémentée** : pastille `success/warning/danger` + horodatage relatif près du solde = spécifiée mais absente. C'est la **vraie** réponse à DR-F3. | `UI_GUIDELINES.md §3.7` vs `side-panel-kpi.tsx` (rien) | **Haute** |
| C5 | **DR-F1 — catégories en anglais** : `primaryCategory` brut (« Income », « Utilities », « Rent ») dans une UI 100 % FR. Finding le plus visible. | `dashboard/transactions-table.tsx:54`, `transactions/transactions-table.tsx:54` | **Haute** (démo FR) |
| C6 | **DR-F2 — nom de compte tronqué** : banque + compte sur **une** ligne `truncate` (~300px) → « The Mauritius Commercial Bank · MCB — … » mange le compte. | `connected-accounts-card.tsx:68` | Basse (polish) |
| C7 | **`AppHeader` non responsive** : flex SANS `flex-wrap` ni hamburger → déborde < ~1100px (mesuré 925px à 375px). Desktop ≥1280px OK. | `app-header.tsx:39` | Moyenne (P2, desktop-first assumé) |
| C8 | **Dette de cohérence : 3 formateurs de date en parallèle** alors que `format-date.ts` existe. `jourMoisCourt` (dashboard-content), `jourMois` + **noms de mois redéfinis en dur** (transactions-table), `moisLisible` (side-panel). Risque de divergence FR. | `dashboard-content.tsx:121`, `transactions-table.tsx:78-86`, `side-panel-kpi.tsx:129` | Moyenne (maintenabilité) |

> Note hiérarchie (checklist §6.1 « solde → tendance → détail ») : **respectée** dans
> l'ordre de pile (SOLDE → DÉTAILS → COMPTES), pas de régression à introduire.

### 1.2 Conflit de conception ASSUMÉ — disposition des totaux (Option A vs B)

Décision métier à arbitrer (le solde multi-devises est le cœur de lecture du FM).

#### Option A — « Devise de base dominante, autres en satellites »
Une seule devise (base du workspace) en **28px/700 primary**, méta fraîcheur dessous.
Les autres devises en **pile compacte secondaire** (16px, `text-muted`) sous une fine
séparation. Pas de conversion (on n'invente pas de taux), juste une hiérarchie visuelle.

```
┌──────────────────────────────────────┐
│ SOLDE TOTAL          🟢 il y a 2 h    │  ← pastille fraîcheur §3.7
│ Rs 7 691 000,00                       │  ← devise base, 28px/700 primary
│ ───────────────────────────────────  │
│ $ 12 400,00   ·   € 3 050,00          │  ← satellites 16px text-muted
└──────────────────────────────────────┘
```
**Pour** : 1 ancre nette (§6.1) ; lecture « ma trésorerie en 3 s » ; gère 1..N devises.
**Contre** : suggère une primauté de la devise base qui peut ne pas refléter le poids
réel ; si la 2ᵉ devise pèse autant, la hiérarchie ment un peu.

#### Option B — « Pile égalitaire, chaque devise sur sa ligne »
Toutes les devises au **même rang** (20px/700), empilées, méta fraîcheur globale en
tête de carte. Proche de l'existant mais avec préfixe devise + fraîcheur + alignement
strict des montants (`tabular-nums`, décimales alignées).

```
┌──────────────────────────────────────┐
│ SOLDES PAR DEVISE    🟢 il y a 2 h    │
│ Rs   7 691 000,00                     │  ← chaque devise 20px/700, alignées
│ $       12 400,00                     │
│ €        3 050,00                     │
└──────────────────────────────────────┘
```
**Pour** : honnête (aucune devise privilégiée) ; aligne les montants pour comparaison ;
zéro hypothèse métier sur « la » devise principale.
**Contre** : pas d'ancre unique forte en multi-devises (tension avec §6.1) ; en
mono-devise (cas MVP courant), redondant avec un simple gros montant.

#### Recommandation (à valider)
**Hybride piloté par le nombre de devises** : `monoDevise` → gros 28px/700 (=A
dégénérée, déjà le comportement actuel, on garde) ; `multiDevise` → **Option B**
(égalitaire, montants alignés) car les corporates mauriciens tiennent USD/EUR à des
poids **non négligeables** — privilégier une devise (A) risque de tromper. On évite la
conversion FX d'affichage tant que le taux annoté (CLAUDE.md Localisation) n'est pas
exposé par un service. **→ Question 1 de l'arbitrage.**

### 1.3 Structures proposées (cartes de score)
- Réutiliser `StateCard` (primitive existante `states/primitives.tsx`) — pas de
  nouvelle carte. Padding 24px (§1.3), ombre `card` unique.
- Aligner la **virgule décimale** des montants empilés (multi-devises) : largeur de
  colonne fixe + `text-right` sur la partie montant, label devise en colonne gauche
  étroite. Évite l'effet « escalier » des chiffres.
- Carte DÉTAILS (`KpiRow`) : conforme §1.3 (entrées `inflow-700`, sorties `outflow-700`,
  variation neutre). **Pas de refonte** ; juste vérifier l'alignement `tabular-nums`.

---

## 2. Spécification de Formatage Financier & Localisation

### 2.1 Règles devise (à figer dans `format-montant.ts` — implémentation ultérieure)

| Devise | Symbole/code affiché | Position | Décimales | Exemple |
|--------|----------------------|----------|-----------|---------|
| MUR | **`Rs`** (préfixe) — usage mauricien | préfixe | 2 | `Rs 7 691 000,00` |
| USD | `$` | préfixe | 2 | `$ 12 400,00` |
| EUR | `€` | préfixe | 2 | `€ 3 050,00` |
| Autre / inconnue | code ISO | suffixe (repli) | 2 | `1 200,00 ZAR` |

Règles transverses (conservées de l'existant, **non négociables**) :
- **Jamais de float** : tout le formatage reste sur la **chaîne** décimale (règle 8) —
  `decomposer` / `grouperMilliers` inchangés.
- **Séparateur milliers** = espace fine insécable U+202F (déjà en place).
- **Décimale** = virgule FR (déjà en place).
- **Signe négatif** = U+2212 `−` (pas le trait d'union) — déjà en place.
- **`+` explicite** optionnel pour les KPI entrées/variation (déjà en place).
- **Zéro** : `Rs 0,00` (pas de signe). Déjà géré (`estZero`).
- **Symbole/code séparé du montant par une espace insécable** (évite la coupure de ligne
  entre symbole et chiffre — contribue à corriger les troncatures).

> ⚠️ **Décision à valider** : passer MUR/USD/EUR en **préfixe symbolique** change
> l'affichage PARTOUT (5 composants consommateurs). C'est cohérent FYGR + usage local,
> mais c'est un changement visible → **Question 2 de l'arbitrage**. Repli si refusé :
> garder le code ISO suffixe actuel et ne traiter que les troncatures (largeurs).

### 2.2 Règles date (« au JJ/MM/AAAA » + fraîcheur)

- **Source unique** : router TOUT formatage de date d'affichage vers `format-date.ts`
  (supprimer les 3 implémentations parallèles — C8). Ajouter si besoin :
  - `formaterDateCourteNumerique(iso)` → `12/06/2026` (méta solde, format demandé).
  - `formaterFraicheurRelative(date)` → « il y a 2 h », « hier », « il y a 3 j »
    (Intl.RelativeTimeFormat natif, locale fr, zéro dépendance — règle 9).
- **DR-F3 / C3 / C4** : remplacer `au {dateSolde}` (faux EOD) par la **pastille fraîcheur
  §3.7** branchée sur `lastSyncedAt` du solde courant : 🟢 `success` <6 h · 🟡 `warning`
  <24 h · 🔴 `danger` ≥24 h (+ CTA « Reconnecter » en mode repair). Tooltip = horodatage
  absolu Maurice. La date du **dernier point de courbe** reste sur la COURBE, pas sur le
  solde courant — on dissocie les deux sémantiques.
- **Fuseau** : `format-date.ts` ne convertit aucun fuseau (date comptable Maurice déjà
  calculée Backend, E20). La **fraîcheur** (relative à maintenant) lit `lastSyncedAt`
  (TIMESTAMPTZ) — calcul de delta autorisé, affichage relatif.

### 2.3 Résolution définitive des troncatures (chiffres clés)
- **Montants** (soldes, KPI, table) : ne JAMAIS `truncate` un montant. Garantir la
  largeur via `tabular-nums` + colonne dimensionnée au plus grand montant plausible
  (`min-w` calibré, ou `whitespace-nowrap` + carte qui s'étend). Le symbole+espace
  insécable empêche la coupure symbole/chiffre.
- **DR-F2 / C6** : passer la carte COMPTES à **2 lignes** — banque en label `text-muted`
  11px au-dessus, nom de compte 13px dessous (chacun `truncate` indépendamment, le
  montant jamais tronqué). Supprime l'écrasement « banque · compte » sur 300px.

---

## 3. Stratégie de Visual QA & Responsiveness

### 3.1 Correctif `AppHeader` < 1100px (C7) — primitives Tailwind

Desktop-first assumé (TYGR cible des FM en desktop), donc **dégradation propre**, pas
un parcours mobile riche :
- **≥ md (768px)** : header actuel inchangé (flex, tous les items visibles).
- **< md** : nav principale repliée dans un **menu condensé** (bouton `≡` ouvrant une
  liste verticale) ; CTA « Connecter une banque » réduit à une **icône `+`** seule
  (label en `sr-only`) ; switcher workspace conserve sa largeur min mais peut tronquer
  le nom (`truncate`, `title`). `flex-wrap` interdit sur le header (cause de sauts
  disgracieux) — on **condense**, on ne **renvoie pas à la ligne**.
- **Empty-states 375px** : le chrome EN DUR de `/demo/dashboard-states` (badge « Démo ·
  Visual QA » sur 3 lignes, nav coupée) — corriger le markup de démo, pas le vrai shell.

> Hors périmètre strict des cartes/soldes : le hamburger touche la surface nav/switcher.
> À confirmer si on le **traite dans ce lot** ou si on le **scope à un lot responsive
> dédié** (TODOS P2 « Header non responsive »). **→ Question 3 de l'arbitrage.**

### 3.2 Critères de validation Visual QA (Vision + Headless)
Captures `/browse` localhost de CHAQUE état modifié, comparées PAR VISION à
`UI_GUIDELINES.md` (Quality Gate 4). États à capturer :
- Carte SOLDE : **mono-devise**, **multi-devises** (2 et 3 devises), **solde 0**, montant
  très grand (`Rs 999 999 999,00`) → **zéro troncature, zéro retour à la ligne**.
- Carte DÉTAILS : entrées/sorties/variation, valeurs négatives.
- Carte COMPTES : nom long (« The Mauritius Commercial Bank ») → 2 lignes propres.
- Table récente : catégories traduites FR, montants alignés à droite.
- Pastille fraîcheur : 3 états (<6h vert / <24h ambre / ≥24h rouge + CTA).
- `AppHeader` aux **largeurs critiques** : 1280 / 1100 / 768 / 375px → aucun
  chevauchement, aucun item coupé, hamburger fonctionnel < md.

**Critères objectifs (BLOQUANTS si écart)** :
1. Aucun chevauchement d'éléments à 1280/1100/768/375px.
2. Aucun saut de ligne sur un montant (mesure : le nœud montant tient sur 1 ligne).
3. `tabular-nums` actif sur tous les chiffres (décimales alignées en pile).
4. Couleurs sémantiques : vert/rouge **uniquement** sur la donnée ; fraîcheur via
   `success/warning/danger` (≠ outflow).
5. Focus ring visible sur header (hamburger, liens, CTA), contraste AA.
6. Pas de couleur en dur (audit classe par classe : tokens uniquement).

---

## 4. Mise à jour du Guide de Style (`CLAUDE.md`) — texte proposé

> À insérer (après validation) dans `CLAUDE.md`, section « Données financières (règle 8) »
> et une nouvelle sous-section « Intégration UI & formatage ». **Non appliqué ici.**

```
### Formatage des données financières (figé 2026-06-22)
- Source UNIQUE de formatage : `src/lib/format-montant.ts` (montants) et
  `src/lib/format-date.ts` (dates). INTERDIT de redéfinir un formateur local
  (noms de mois en dur, découpe ad-hoc) dans un composant — toute date/montant
  d'affichage passe par ces deux modules (dette C8 : 3 formateurs parallèles tués).
- Devise : symbole en PRÉFIXE pour MUR (`Rs`), USD (`$`), EUR (`€`), séparé du
  montant par une espace fine insécable ; code ISO suffixe en repli. [si Option 2 validée]
- Jamais de float (règle 8) : formatage sur la chaîne décimale, y compris à l'affichage.
- Un montant ne se `truncate` JAMAIS ; sa colonne est dimensionnée, `tabular-nums`,
  `whitespace-nowrap`. Les libellés (compte, catégorie) peuvent tronquer, pas les chiffres.
- Fraîcheur du solde : pastille §3.7 (success<6h / warning<24h / danger≥24h) sur
  `lastSyncedAt`, JAMAIS « au JJ/MM » dérivé d'un EOD de courbe pour un solde courant.

### Intégration UI (Tailwind + tokens, pas de « gstack » design)
- Le design system = `docs/UI_GUIDELINES.md` + tokens `globals.css` (Tailwind).
  Aucune couleur en dur ; toujours un token sémantique.
- Composants d'affichage purs (zéro fetch, zéro état) ; le conteneur décide l'état.
- Responsive header : condenser (< md → menu/icône), JAMAIS `flex-wrap` sur le header.
```

---

## 5. Quality Gates Front-end (checklist de non-régression QA)

**Avant toute proposition d'implémentation (rappel hooks locaux)** — CLAUDE.md règle 5 :
- `npm run lint` (eslint) — vert obligatoire.
- `npm run typecheck` (`tsc --noEmit`) — vert obligatoire.
- `npm test` (vitest, suite isolation IDOR incluse) — aucun rouge.
- Ces 3 sont exécutés par `.husky/pre-commit` ET le hook `.claude/settings.json`
  (PreToolUse sur `git commit`). Un commit échoue si l'un échoue.

**Checklist de non-régression visuelle (QA exécute avant validation)** :
- [ ] `formatMontant` : tests aux bornes — 0, négatif, grand (centimes préservés,
      zéro float), chaque devise (préfixe correct), inconnue (repli ISO).
- [ ] `format-date` : `formaterFraicheurRelative` et `formaterDateCourteNumerique`
      couverts ; fuseau Maurice non altéré (date comptable nue inchangée).
- [ ] Zéro formateur de date résiduel dans les composants (C8 résolu — grep
      « noms de mois » / `split("-")` ad-hoc = 0).
- [ ] Visual QA des 6 groupes d'états (§3.2) : captures comparées à UI_GUIDELINES,
      0 troncature montant, 0 chevauchement aux 4 largeurs.
- [ ] Pastille fraîcheur : 3 seuils rendus, CTA « Reconnecter » ≥24h.
- [ ] DR-F1 : 0 catégorie anglaise visible (table de correspondance appliquée).
- [ ] Accessibilité : focus ring header, `aria-live` inchangé sur flux, AA contrastes.
- [ ] Aucune couleur en dur introduite (revue diff).
- [ ] Cross-review contradictoire (règle 6) par contexte frais avant push.

---

## 6. Découpage d'implémentation proposé (pour le fil suivant)

Lots indépendants, livrables en PR séparées (Human-in-the-Loop, branche `feat/*`) :
- **Lot 1 — Formatage (lib)** : `format-montant` (préfixe devise) + `format-date`
  (fraîcheur relative, date numérique) + tests bornes. Cœur, débloque le reste.
- **Lot 2 — Carte SOLDE & fraîcheur** : hiérarchie multi-devises (option arbitrée) +
  pastille §3.7 (résout DR-F3/C3/C4). Dépend du Lot 1.
- **Lot 3 — DR-F1 catégories FR** : table de correspondance + application table dashboard
  & `/transactions`. Indépendant (peut nécessiter appui Backend si mapping côté data).
- **Lot 4 — DR-F2 carte COMPTES 2 lignes** : polish, indépendant.
- **Lot 5 — Responsive `AppHeader`** (si inclus, cf. Question 3) : menu condensé < md.
  Touche la surface nav/switcher → lot le plus large.
- **Lot 6 — Dette C8** : suppression des 3 formateurs parallèles (peut fusionner au Lot 1).

---

## 7. Arbitrages — TRANCHÉS (humain, 2026-06-22)

Décisions actées (decision log — ne pas re-litiger, règle 10) :

1. **Disposition multi-devises → HYBRIDE.** Mono-devise = gros 28px/700 primary
   (comportement actuel conservé) ; multi-devises = **Option B égalitaire**, chaque
   devise au même rang (20px/700), **virgules décimales alignées** (colonne montant
   `text-right` + symbole en colonne gauche étroite). Pas de conversion FX d'affichage
   (aucune devise privilégiée, pas d'hypothèse de taux).
2. **Devise → PRÉFIXE SYMBOLIQUE.** `Rs` (MUR), `$` (USD), `€` (EUR) en préfixe, séparés
   du montant par une espace fine insécable. **Repli** : devise inconnue → code ISO en
   suffixe (`1 200,00 ZAR`). Change l'affichage dans les 5 composants consommateurs —
   assumé (usage mauricien + benchmark FYGR). `format-montant.ts` à étendre (Lot 1).
3. **Responsive `AppHeader` → HORS de ce chantier.** Reste à son lot P2 dédié (TODOS
   « Header non responsive »). **Lot 5 RETIRÉ du périmètre.** Ce chantier reste centré
   soldes / totaux / formatage. La §3.1 ci-dessus documente l'approche pour le lot futur,
   mais n'est PAS implémentée ici.
4. **DR-F1 → TABLE DE CORRESPONDANCE FRONT (affichage).** Mapping FR appliqué au rendu
   (`Income`→« Revenus », `Utilities`→« Charges », `Rent`→« Loyer », `Bank Charges`→
   « Frais bancaires »…), fallback « Non catégorisé » pour une clé inconnue. La catégorie
   localisée **côté service** est reportée (dette à tracer si besoin). Débloque la démo FR.

**Périmètre final = Lots 1, 2, 3, 4, 6** (le Lot 5 header est exclu, cf. décision 3).
```
