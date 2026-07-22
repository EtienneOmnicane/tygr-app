# PLAN — Lisibilité de la zone prévisionnelle du graphe « Flux de trésorerie »

> **Phase : CONCEPTION** (règle 1). Aucune ligne de code applicatif dans ce fil.
> Livrable = ce document + options chiffrées. L'implémentation référencera ce plan.
>
> Date : 2026-07-20 · Branche de rédaction : `main` (lecture seule)
> Fichiers concernés : `src/components/dashboard/flux-projection.ts`, `flux-bars.tsx`,
> `flux-tresorerie-card.tsx`, `flux-layout.ts`, `echelle-nice.ts`, `monthly-cashflow.tsx`
> Sources de vérité : `docs/UI_GUIDELINES.md` (§3.1, §3.5, §4.2, §6) · tokens
> `src/app/globals.css` · CLAUDE.md règles 8 et 10.

---

## 0. Ce que j'ai vérifié avant d'écrire (et deux constats qui changent le cadrage)

### 0.1 ⚠️ Branche concurrente NON mergée sur les mêmes fichiers

`origin/fix/flux-bars-largeur-echelle` (worktree `.worktrees/flux-fix`, commit `4d43767`)
touche **`echelle-nice.ts` + `flux-bars.tsx` + `tests/unit/echelle-nice.test.ts`)** :
« barres de flux plus larges + paliers d'échelle plus fins ». Elle n'apparaît pas dans
`git branch -r --merged origin/main`.

**Conséquence** : toute implémentation issue de ce plan **doit partir d'après le merge de
cette branche**, ou assumer un conflit sur `flux-bars.tsx`. À trancher avant le lot 1.
Ses paliers plus fins **atténuent marginalement** le défaut décrit ici (voir §1.3) mais
ne le règlent pas — deux ordres de grandeur restent deux ordres de grandeur.

### 0.2 ⚠️ La route de démo NE reproduit PAS le défaut (trou de couverture Gate 4)

`DEMO_DASHBOARD.prevision` (`src/lib/dashboard-demo-fixtures.ts:119-152`) porte des
échéances de **850 000 à 3 150 000 MUR** contre un réalisé de **5 200 000** — soit un
rapport **1:6, parfaitement visible** (barre de 17 à 72 px, cf. §1.2).

Le cas d'Etienne est un rapport **1:520** (Rs 10 000 contre 5,2 M). **Il n'existe aucune
fixture qui l'expose.** La Gate 4 du prévisionnel C1 (PR #226) est donc passée au vert sur
une donnée trop favorable : le défaut n'était pas capturable, pas seulement pas capturé.

**Conséquence** : le premier livrable de l'implémentation n'est pas un correctif visuel,
c'est **une fixture qui fait échouer la démo**. Sans elle, on corrigerait à l'aveugle et
on re-validerait à l'aveugle.

---

## 1. Diagnostic mesuré — la barre fait 0,23 px, ce n'est pas une impression

### 1.1 Chaîne causale exacte

1. `maxFenetreColonnes` (`flux-projection.ts:209`) prend le max **entrées/sorties de
   toutes les colonnes, réalisé + prévision empilés**. Sur la fixture : `5 200 000`.
2. `echelleNice(5 200 000)` (`echelle-nice.ts:38`) : mantisse `5,2` → premier palier
   ≥ dans `{1, 2, 2.5, 5, 10}` = **10** → échelle = **10 000 000**.
   Le saut 5,2 M → 10 M **divise par 1,92 la hauteur de toutes les barres**, réalisé compris.
3. `hauteurDe` (`flux-bars.tsx:234`) : `hauteur = (valeur / max) × hauteurDemi`, avec
   `hauteurDemi = (hauteurSVG − bandeLabels) / 2`.

### 1.2 Hauteurs résultantes (mesurées, `HAUTEUR_ANCRE` = `clamp(380px, 55vh, 520px)`, bande pivot 38 px)

| Valeur projetée | H=380 px | H=495 px | H=520 px | Lisible ? |
|---|---|---|---|---|
| **Rs 10 000** (cas Etienne) | **0,17 px** | **0,23 px** | **0,24 px** | ❌ sous-pixel |
| Rs 50 000 | 0,85 px | 1,14 px | 1,21 px | ❌ trait fantôme |
| Rs 110 000 | 1,88 px | 2,51 px | 2,65 px | ⚠️ limite |
| Rs 850 000 *(fixture démo)* | 14,5 px | 19,4 px | 20,5 px | ✅ |
| Rs 3 150 000 *(fixture démo)* | 53,9 px | 72,0 px | 75,9 px | ✅ |

**Seuil de disparition** : à l'échelle courante, **toute valeur < ~44 000 MUR rend moins
d'1 px** ; il faut **~131 000 MUR pour atteindre 3 px** (le minimum pour qu'une barre se
lise comme une barre). Formulé indépendamment de l'échelle :
**au-delà d'un rapport de 1:229 entre la valeur et le plafond d'axe, la barre n'existe plus.**

Le constat d'Etienne est arithmétiquement exact, et son diagnostic (`maxFenetreColonnes`,
échelle unique) est le bon. Rien à requalifier.

### 1.3 Ce que la branche `fix/flux-bars-largeur-echelle` change (et ne change pas)

Des paliers de mantisse plus fins éviteraient le saut 5,2 M → 10 M (échelle ≈ 5,5 M au lieu
de 10 M) : gain **×1,8** sur toutes les hauteurs. La barre de Rs 10 000 passerait de
**0,23 px à 0,42 px**. Toujours invisible. **Ce n'est pas une piste de résolution**, juste
une amélioration indépendante qu'il ne faut pas confondre avec un correctif.

---

## 2. CHALLENGE (règle 10) — le problème n'est pas visuel, il est sémantique

Etienne demande de traiter deux problèmes distincts : **(1) signaler la prévision**,
**(2) rendre lisible une petite prévision**. Je prends position sur les deux, et je conteste
le découpage.

### 2.1 Le problème (1) est DÉJÀ résolu, et conforme

L'encodage « prévision » en place est complet et respecte §3.5 / §6.4 — je l'ai lu ligne à ligne :

| Signal | Où | Conforme |
|---|---|---|
| Fond `surface-forecast` sur les colonnes futures | `flux-bars.tsx:259-267` | ✅ §3.5 |
| Opacité 45 % sur les barres projetées | `flux-bars.tsx:52, 350, 359` | ✅ §3.5 (45 % exact) |
| Séparateur « aujourd'hui » pointillé 1 px `line-strong` | `flux-bars.tsx:301-311` | ✅ §3.5 |
| Sous-label « Réalisé à date » 11 px italique `primary` | `flux-bars.tsx:384-394` | ✅ §3.5 |
| Pastille de légende neutre `surface-forecast` + bordure | `flux-tresorerie-card.tsx:89-97` | ✅ §3.5 (n'emprunte pas inflow/outflow) |
| Tooltip à blocs étiquetés « Réalisé à date » / « Prévision » | `flux-bars.tsx:425-439` | ✅ |
| `aria-label` annonçant explicitement la projection | `flux-bars.tsx:249-253` | ✅ §3.5 (accessibilité) |
| Sous-titre de carte « prévision issue des échéances » | `flux-tresorerie-card.tsx:50-53` | ✅ |

**Sept signaux redondants, dont deux non visuels.** Ajouter une huitième couche
(hachures, contour pointillé, nouveau token de surface) n'apporte **aucune information
nouvelle** — et surtout : **aucun de ces encodages n'est perceptible sur une barre de
0,23 px.** Une hachure a besoin d'environ 8 px pour montrer une seule diagonale ; un
contour pointillé de 1 px sur une forme de 0,23 px de haut est un artefact.

> **Donc : oui, « zone claire + code couleur » est un pansement.** Pas parce que
> l'habillage serait mal fait — il est déjà là et il est bon — mais parce qu'il traite un
> problème qui n'existe pas, avec un moyen qui ne peut physiquement pas atteindre le
> problème qui existe. Les options d'encodage du §3 sont chiffrées parce qu'elles ont été
> demandées ; je n'en recommande aucune comme réponse au défaut observé.

**La zone paraît vide parce qu'elle EST vide au rendu** : le seul pixel allumé y est le
fond beige. Le signal « prévision » ne se dégrade pas en « erreur » — il se dégrade en
« rien ». C'est un symptôme du problème (2), pas un problème de signalétique.

### 2.2 Le vrai problème : les deux séries ne sont pas commensurables

Elles ne mesurent pas la même chose :

| | Réalisé | Prévision |
|---|---|---|
| Source | `transactions_cache` | `echeances` (saisie manuelle) |
| Nature | **Mesure exhaustive** — tout ce qui a transité | **Sous-ensemble déclaré** — ce qui a été saisi |
| Couverture | 100 % du flux bancaire | inconnue, dépend de la discipline de saisie |
| Ordre de grandeur | ~5 000 000 MUR/mois | ~10 000 MUR/mois |

« Août 2026 : sorties Rs 10 000 » **ne veut pas dire** « on prévoit Rs 10 000 de sorties en
août ». Ça veut dire « **on a saisi** Rs 10 000 d'échéances pour août ». Le flux réel d'août
sera de l'ordre de 5 M, comme tous les mois.

C'est là que le même axe devient **activement trompeur**, indépendamment de tout habillage :

- **Rendu actuel** (barre invisible) → lecture : *« la trésorerie tombe à zéro en août »*. Faux.
- **Avec un plancher de hauteur ou une échelle secondaire** → lecture : *« août est
  comparable aux mois passés »*. Faux aussi, dans l'autre sens.

**Un graphe ne peut pas être honnête en superposant une mesure exhaustive et un
sous-ensemble déclaré sur un axe partagé.** Aucune option d'encodage ne répare ça : le
défaut est dans la donnée, pas dans le rendu.

### 2.3 Position

1. **Court terme** — remplacer la comparaison de hauteurs par un **canal textuel**
   (option C, §3.3) + une **mention de couverture** (§4.4). On arrête de mentir sans
   prétendre comparer. Ce n'est pas un correctif définitif, et il ne doit pas être présenté
   comme tel.
2. **Structurel** — soit **sortir la prévision de l'axe** (option E, §4.1), soit
   **homogénéiser la série** (option F, §4.2). F est le vrai fix produit ; il exige une
   décision sur la méthode de projection, restée ouverte depuis
   `PLAN-cadrage-scenario-previsionnel-fygr.md` §5.
3. **Ce que je ne recommande pas** : plancher de hauteur (option D) et échelle secondaire
   (option G). Chiffrés quand même, avec leur mode de défaillance.

**Etienne tranche.** Les trois voies sont chiffrées ci-dessous.

---

## 3. Options d'ENCODAGE (problème 1 — signaler la prévision)

> Rappel : demandées explicitement, chiffrées honnêtement. **Aucune ne rend visible une
> barre sous-pixel** — colonne « effet sur le défaut observé » systématiquement renseignée.

### 3.1 Option A — Hachures diagonales (`<pattern>` SVG)

**Maquette**
```
   ▲ entrées
   █████        ▨▨▨▨▨        █ = réalisé, aplat inflow/outflow 100 %
   █████        ▨▨▨▨▨        ▨ = prévision, hachures 45° même teinte
───█████────┊───▨▨▨▨▨────    ┊ = séparateur « aujourd'hui »
   █████    ┊   ▨▨▨▨▨
   ▼ sorties     [ fond surface-forecast ]
```
Deux `<pattern id="hachure-inflow|outflow">` définis une fois dans `<defs>`, remplis en
`var(--color-inflow)` / `var(--color-outflow)` sur fond transparent. La teinte sémantique
est **conservée** (une sortie reste rouge) ; la **texture** porte le statut « projeté ».

**Coût** — agent : ~1,5 h (defs + bascule du `fill` + tests visuels). Humain : ~20 min QA.

**Compromis honnête**
- ✅ Canal **non chromatique** : lisible en niveaux de gris et pour un daltonien — meilleur
  que l'opacité seule sur ce point précis.
- ❌ **Sans effet sur le défaut** : illisible sous ~8 px de hauteur.
- ❌ Sur des barres fines (« Tout » = colonnes étroites), la hachure produit du **moiré**.
- ⚠️ **Écart §3.5** : la table normative dit « opacité 45 % » pour les barres. Une hachure
  *remplaçante* est un écart à faire acter ; *cumulée* à l'opacité 45 %, elle devient
  quasi invisible (45 % d'une hachure ≈ un gris). Il faut choisir, et le tracer.

### 3.2 Option B — Contour pointillé + remplissage atténué

**Maquette**
```
   ┌╌╌╌┐        contour 1px dash 2-2 en var(--color-outflow)
   ╎░░░╎        remplissage même teinte à 20 %
───┴╌╌╌┴───     lecture : « forme prévue, pas encore constatée »
```

**Coût** — agent : ~1 h. Humain : ~15 min QA.

**Compromis honnête**
- ✅ Cohérent avec le séparateur « aujourd'hui » déjà pointillé — un même vocabulaire
  graphique pour « projeté ».
- ❌ **Sans effet sur le défaut** : un contour de 1 px sur une forme de 0,23 px est un
  artefact ; le `rx={2}` actuel écrase déjà les petites formes.
- ❌ Un contour dash sur fond beige `surface-forecast` (#efebdd) tombe à **contraste
  insuffisant** pour `inflow` (#157a4a) en petite taille — à mesurer avant de retenir.

### 3.3 Option C — Étiquette de valeur sur les colonnes prévisionnelles ★

**Maquette**
```
   ▲
   █████    ┊                       la valeur est ÉCRITE, pas dessinée :
   █████    ┊   ·Rs 10 000·         on ne demande plus à l'œil de comparer
───█████────┊───────▁──────         des hauteurs incomparables
   █████    ┊   (barre ~0 px + tick 2 px `line-strong`)
   ▼             [ surface-forecast ]
```
Sur chaque colonne **purement projetée** dont la barre rend moins de `SEUIL_PX` (≈ 3 px),
on écrit le montant en `text-[11px] tabular-nums text-text-faint`, ancré au-dessus (entrée)
ou au-dessous (sortie) de l'axe, **dans le SVG en unités de viewBox**.

**Coût** — agent : ~2,5–3 h (placement, anti-collision, format compact, tests). Humain :
~30 min QA. **+1 h agent** si `formatMontantCompact` est nécessaire (§4.3).

**Compromis honnête**
- ✅ **Seule option de ce §3 qui adresse réellement le problème (2)** : elle change le canal
  d'information (texte au lieu de longueur), donc elle échappe à la contrainte d'échelle.
- ✅ **Ne distord aucune proportion** : la barre reste géométriquement exacte (quasi nulle).
  On n'affirme rien de faux ; on rend lisible ce qui est illisible.
- ❌ **Encombrement** : sur 3 colonnes projetées ça passe ; au-delà de ~5 il faut décider
  d'un pas d'affichage (même logique que `MAX_LABELS`) — sinon les étiquettes se chevauchent.
- ❌ `Rs 10 000,00` fait ~11 caractères : sur colonne étroite (fenêtre « Tout »),
  débordement garanti → format compact requis, donc extension de `format-montant.ts` (§4.3).
- ⚠️ **Ne rend pas la comparaison honnête** — elle la *contourne*. Le lecteur voit un
  chiffre juste à côté d'une barre absente. Sans la mention de couverture (§4.4), il peut
  toujours conclure « août s'effondre ». **Cette option n'est pas suffisante seule.**

---

## 4. Options STRUCTURELLES (problème 2 — la comparaison elle-même)

### 4.1 Option E — Sortir la prévision de l'axe (encart dédié) ★★

Le graphe « Flux de trésorerie » redevient **100 % réalisé** (axe, échelle, frontière :
tout disparaît). Les échéances vivent dans un **encart propre** sous la carte — ou dans la
page Échéances existante — avec **sa propre échelle**, où Rs 10 000 est pleine hauteur et
parfaitement lisible.

**Maquette**
```
┌─ Flux de trésorerie ───────────────────────────────┐
│  █  █  █  █  █  █      (réalisé seul, échelle 5 M) │
│ ───────────────────                                │
└────────────────────────────────────────────────────┘
┌─ Échéances à venir ─── 3 prochains mois ───────────┐
│  Juil.  Rs 0            ▏                          │
│  Août   Rs 10 000  ▐████████████  (échelle 10 000) │
│  Sept.  Rs 3 150 000    …                          │
│  ⓘ Échéances saisies uniquement — ne couvre pas    │
│    l'ensemble des flux attendus.                   │
└────────────────────────────────────────────────────┘
```

**Coût** — agent : ~5–8 h (nouveau composant présentationnel + états loading/vide/erreur +
fixtures + retrait du prévisionnel de `flux-bars.tsx` + tests). Humain : ~1 h (décision
produit + QA). **Réversible** : le code prévisionnel de `flux-bars.tsx` n'est pas jeté,
il est débranché.

**Compromis honnête**
- ✅ **Supprime le mensonge à la racine** : plus d'axe partagé, donc plus de comparaison
  implicite entre une mesure et une déclaration.
- ✅ **Deux échelles légitimes** parce que **deux graphes** — c'est la différence de fond
  avec l'option G (§4.5), qui met deux échelles dans un seul graphe.
- ✅ Lisibilité maximale de la prévision, quel que soit son ordre de grandeur.
- ❌ **Perte de la continuité temporelle** — l'argument fort du design d'origine, et le
  pattern FYGR (`PLAN-cadrage-scenario-previsionnel-fygr.md` §1.2). Deux endroits à
  regarder au lieu d'un.
- ❌ **Défait une partie de la PR #226** (prévisionnel C1) livrée il y a 3 jours. À assumer
  explicitement — c'est une décision produit, pas une correction de bug.
- ⚠️ Impact sur §6.1 de UI_GUIDELINES (« une seule ancre visuelle ») : l'encart doit rester
  **secondaire**, jamais une seconde ancre.

### 4.2 Option F — Homogénéiser la série (baseline + échéances) ★★★ *(le vrai fix)*

La prévision cesse d'être « les échéances saisies » et devient **une projection du flux
attendu** : baseline dérivée des mois réalisés (moyenne, ou récurrents détectés par le
moteur de règles), **plus** les échéances saisies en supplément identifié.

La série redevient commensurable : les barres futures retrouvent l'ordre de grandeur des
barres passées, **l'axe partagé redevient honnête**, et tout le §3 devient sans objet — la
prévision est visible parce qu'elle est de la bonne taille.

**Coût** — agent : **2–3 jours** (méthode de projection, dérivation serveur, tests aux
bornes, annotation de la part baseline vs part saisie, QA). Humain : **décision produit
majeure** — quelle méthode ? moyenne glissante ? récurrents détectés ? sur quelle
profondeur ? Question explicitement **laissée ouverte** dans
`PLAN-cadrage-scenario-previsionnel-fygr.md` §5, et signalée §3 du même document : *« sans
décision explicite, on livre une prévision fausse »*.

**Compromis honnête**
- ✅ Seule option qui rend le design d'origine (axe partagé, continuité temporelle)
  **légitime** au lieu de le rafistoler.
- ❌ Coût sans commune mesure avec les autres ; c'est un chantier, pas un correctif.
- ❌ **Introduit un risque nouveau** : une baseline est une *hypothèse*. Elle doit être
  annotée comme telle, sinon on remplace un faux constat visuel par un faux constat
  chiffré — plus crédible, donc plus dangereux.
- ⚠️ Bloqué sur décision produit. **Ne peut pas être le correctif de cette semaine.**

### 4.3 Option D — Plancher de hauteur de barre ❌ *non recommandée*

Forcer `hauteur = max(hauteurCalculée, 3px)` dès que la valeur est non nulle.

**Coût** — agent : ~45 min. Humain : ~10 min.

**Pourquoi je la déconseille**
- ❌ **Distorsion directe** : Rs 10 000 et Rs 130 000 rendent la même hauteur. Deux valeurs
  d'un facteur 13 deviennent visuellement égales — le graphe **affirme** quelque chose de faux.
- ❌ Le plancher se lit comme une **hauteur proportionnelle** (c'est une barre, dans un
  graphe à barres) : rien ne signale au lecteur qu'il regarde un minimum technique.
- ⚠️ **Variante acceptable** : un **tick** de 2 px `line-strong` — forme *différente* d'une
  barre, qui dit « présence, valeur non représentable » sans prétendre à une hauteur. C'est
  le marqueur de l'option C (§3.3), et il n'a de sens **qu'accompagné de l'étiquette**.
  Seul, il est aussi muet que le fond beige.

### 4.4 Mention de couverture *(à retenir avec toute option court terme)*

Sous le graphe, au même emplacement et dans le même style que la note multi-devises
existante (`text-[11px] text-text-faint`, `flux-bars.tsx:134-139`) :

> « Prévision = échéances saisies uniquement. Elle ne couvre pas l'ensemble des flux
> attendus et n'est pas comparable aux mois réalisés. »

**Coût** — agent : ~20 min. Humain : ~10 min (validation du libellé).
**C'est la ligne la plus rentable du plan** : elle désamorce le faux constat
« la trésorerie s'effondre » pour 20 minutes de travail, quelle que soit l'option retenue.

### 4.5 Option G — Échelle secondaire / double axe ❌ *fortement déconseillée*

Un second axe Y (droite) pour la zone prévisionnelle.

**Coût** — agent : ~4–6 h. Humain : ~45 min.

**Pourquoi je la déconseille**
- ❌ **Fausse comparaison structurelle** : deux barres de même hauteur y valent des montants
  différents d'un facteur 500. C'est l'anti-pattern classique du double axe, et il est ici
  **maximal** (le rapport d'échelles est énorme et **variable** d'une fenêtre à l'autre).
- ❌ Le rapport change avec la fenêtre → **la même donnée ne rend pas pareil** d'une période
  à l'autre. Illisible dans le temps, impossible à mémoriser.
- ❌ Coûte plus cher que l'option E (§4.1) **pour un résultat moins honnête** : si on accepte
  deux échelles, autant assumer deux graphes.

---

## 5. Contraintes non négociables (toutes options)

### 5.1 Design system

- **Tokens sémantiques uniquement** (`globals.css`), **zéro couleur en dur** — y compris
  dans un `<pattern>` SVG : `fill="var(--color-outflow)"`, jamais `#bf3b2f`.
- **Vert/rouge restent la donnée** (§3.1). La prévision **conserve** la teinte sémantique du
  sens (une sortie projetée reste `outflow`) et se distingue par **statut** (opacité /
  texture / atténuation), jamais par une couleur inventée.
- **Ne pas emprunter** : `accent` ambre = marque/nav active (§5 du guide) ; `danger`/
  `danger-bg` = erreur système (§3.4) — une prévision n'est pas une alerte.
- **Piège vérifié (mémoire projet)** : `surface-forecast` (#efebdd) et `surface-inset`
  (#f0ecdf) sont à **2 unités RGB** — indistinguables à l'œil. Tout nouveau token de surface
  doit être **comparé en HEX**, pas jugé sur capture (`flux-bars.tsx:270-275` documente déjà
  un faux signal causé par cette confusion).
- **Tokens disponibles pour un encodage « prévision »** : `surface-forecast`, `line`,
  `line-strong`, `text-faint`, `primary` (déjà porteur de « Réalisé à date »).
  **Aucun nouveau token n'est nécessaire** — si l'implémentation en réclame un, c'est le
  signe qu'elle sur-encode.

### 5.2 Règle 8 — montants

- Tout montant affiché (**étiquette de valeur comprise**) passe par
  `src/lib/format-montant.ts`. **Interdit** de dériver une chaîne d'affichage d'un
  `parseFloat` — même « juste pour l'étiquette ».
- `parseFloat` reste **cantonné à la géométrie** : `maxFenetre*`, `hauteurDe`, `echelleNice`.
  Frontière déjà documentée (`flux-projection.ts:14-15, 61-63, 208`) — la maintenir.
- **Si un format compact est retenu** (option C) : il s'écrit **dans `format-montant.ts`**
  (source unique, règle « INTERDIT de redéfinir un formateur local »), et il opère **sur la
  chaîne décimale** — découpe de la partie entière par longueur, **jamais** une division
  flottante. `Rs 10 000` / `Rs 3,15 M`. Prévoir ses tests aux bornes (999 999 → 1 M,
  zéro, négatif, devise inconnue en suffixe ISO).
- `tabular-nums` sur toute étiquette chiffrée (§0 du guide).

### 5.3 Multi-devises (DASH-FX1)

- **Aucune addition cross-devise, aucun FX inventé.** Acquis et à préserver.
- **Piège à traiter explicitement** : la fixture `DEMO_DASHBOARD_PREVISION_AUTRE_DEVISE`
  produit des colonnes **à 0 en devise de base** alors que **des échéances existent** en
  USD. Avec une étiquette de valeur naïve, la zone afficherait **« Rs 0 »** — un faux
  constat (« rien de prévu ») pire que la barre invisible actuelle.
  → L'étiquette doit distinguer **« aucune échéance »** de **« échéances dans une autre
  devise, non converties »**. Le drapeau `autresDevises` existe déjà sur `MoisAffiche`
  (`flux-projection.ts:28`) : la donnée est là, il faut la lire.

### 5.4 Prévision = 0

Trois cas distincts, aujourd'hui **rendus à l'identique** (un aplat beige muet) :

| Cas | État actuel | Attendu |
|---|---|---|
| `prevision === null` (fenêtre passée, D4) | pas de zone — correct | inchangé ✅ |
| Zone présente, **toutes colonnes à 0** (aucune échéance saisie) | aplat beige muet | message dans la zone : « Aucune échéance saisie sur ces mois » |
| Zone présente, colonnes à 0 **en devise de base** mais échéances en USD | aplat beige muet | mention explicite d'autre devise (§5.3) |

Cohérent avec le principe déjà acté : *« une prévision vide n'est pas une prévision nulle »*
(`flux-projection.ts:146-149`). Le principe est posé côté données ; **il n'est pas rendu
côté UI** — c'est un manque, pas une divergence.

### 5.5 À ne pas rouvrir (décisions actées)

- **D2** — la colonne pivot porte réalisé + échéances restantes empilés.
- **D3** — 3 mois de projection.
- **D4** — pas de prévision si la fenêtre n'atteint pas le mois courant.
- Séparation `flux-projection.ts` (module neutre) / `flux-bars.tsx` (client) — contrainte
  RSC (fix C2), **pas un choix de style** : `monthly-cashflow.tsx` est un Server Component
  qui importe la projection. Toute nouvelle fonction de dérivation partagée va dans le
  module neutre.

---

## 6. Visual QA — Gate 4

**Outillage** : navigateur headless `gstack` (skill `/browse`). *Rappel CLAUDE.md : gstack
est de l'**outillage de QA**, jamais du rendu. Le rendu reste Tailwind + tokens.*

### 6.1 Préalable bloquant

**Ajouter la fixture manquante** (§0.2) : `DEMO_DASHBOARD_PREVISION_FAIBLE` — réalisé
~5,2 M, prévision Rs 10 000, soit le cas réel d'Etienne. **Sans elle, la QA ne peut pas
voir le défaut**, donc ne peut pas valider le correctif. C'est le premier commit du lot.

### 6.2 États à capturer — route `/demo/dashboard`

| # | Onglet | Ce qu'on vérifie |
|---|---|---|
| 1 | `sans-prevision` | Réalisé seul — **non-régression** : aucun changement visuel |
| 2 | `succes` | Réalisé + prévision **du même ordre** (1:6) — le cas sain ne se dégrade pas |
| 3 | **`prevision-faible` (à créer)** | **Le défaut** : 1:520 → la prévision est-elle lisible ? |
| 4 | `prevision-sans-realise` | Prévision seule : l'échelle est dominée par elle → lisible |
| 5 | `prevision-autre-devise` | Piège §5.3 : ne dit **jamais** « Rs 0 » quand des USD existent |
| 6 | **`prevision-zero` (à créer)** | Zone présente, tout à 0 → message, pas d'aplat muet |
| 7 | `vide` | « Aucun mouvement » — non-régression |
| 8 | `un-mois` | Colonnes larges : plafond `LARGEUR_BARRE_MAX`, étiquettes non tronquées |

Chaque état en **desktop ≥1024px** (cœur métier) **et** à `HAUTEUR_ANCRE` minimale
(380 px) — c'est la hauteur où les barres sont les plus petites, donc le pire cas.

### 6.3 Méthode de mesure — pièges vérifiés à ne pas répéter

Trois pièges déjà payés sur ce projet, tous applicables ici :

1. **Le SVG est étiré** (`className="w-full"`, viewBox = px mesurés) : **ne jamais dériver
   un px CSS d'une unité de viewBox**. Toute annotation de contrôle se pose **dans le SVG**
   (le sous-label « Réalisé à date » l'a appris, `flux-bars.tsx:379-383`).
2. **Le screenshot ment** : trancher par `getBoundingClientRect()` sur les `<rect>` et par
   `screenshot --selector`, **jamais à l'œil**. Assertion concrète : *« la hauteur rendue de
   la barre prévisionnelle, ou de son substitut, est ≥ 3 px »* — mesurée, pas estimée.
3. **Comparer les HEX**, pas les aplats (§5.1) : deux tokens à 2 unités RGB sont
   indistinguables sur capture.

**Environnement** : QA sur **`next start` en HTTP**, jamais `next dev` — hydratation morte
sous proxy HTTPS, et l'îlot client (`useState` du survol, `ResizeObserver`) ne réagit pas :
les mesures **mentent**. Ne pas lancer `npm run build` pendant qu'un `next dev` voisin
tourne (`.next/` partagé). Redémarrage du serveur ⇒ session `browse` morte ⇒ re-mesurer.

### 6.4 Grille de conformité (UI_GUIDELINES §6)

- §6.3 — vert/rouge sur la donnée seule ; erreurs avec fond + icône + message ?
- §6.4 — prévisionnel marqué par `surface-forecast` **ou** opacité 45 % **et** label ?
  *(si l'option A remplace l'opacité par une hachure, l'écart est **acté ici**, pas subi)*
- §6.1 — une seule ancre visuelle *(critique pour l'option E : l'encart reste secondaire)*
- §6.2 — `tabular-nums` sur toute étiquette chiffrée
- §6.5 — les 4 états spécifiés (loading / vide / erreur / partiel)
- §6.6 — contrastes AA : **à mesurer** pour tout texte 11 px posé sur `surface-forecast`
  (`text-faint` #8a8f9f sur #efebdd est **le point de contrôle le plus à risque** du plan)

Écart sur token objectif = **BLOQUANT**. Écart de goût = noté, renvoyé à `/design-review`.

---

## 7. Recommandation et découpage

| Lot | Contenu | Coût agent | Coût humain | Dépendance |
|---|---|---|---|---|
| **0** | Fixtures `prevision-faible` + `prevision-zero` (§6.1) | 1 h | 15 min | — |
| **1** | Mention de couverture (§4.4) + traitement prévision = 0 (§5.4) | 1,5 h | 20 min | Lot 0 |
| **2** | Étiquette de valeur, option C (§3.3) + format compact (§5.2) | 3–4 h | 30 min | Lot 0 |
| **3a** | *ou* Sortir la prévision, option E (§4.1) | 5–8 h | 1 h | **décision** |
| **3b** | *ou* Homogénéiser la série, option F (§4.2) | 2–3 j | décision produit | **décision** |

**Ce que je recommande** : **lots 0 + 1 + 2 tout de suite** (~6 h agent, ~1 h humain). Ça
tue le faux constat « la trésorerie s'effondre en août » et rend la valeur lisible, **sans
rien affirmer de faux**. Puis **trancher entre 3a et 3b** — c'est une décision produit, pas
technique, et je ne la prends pas à ta place.

**Mon avis si tu veux un pari** : **3b (option F)** est la seule qui rende le design
d'origine honnête, et c'est de toute façon la question que le cadrage prévisionnel a laissée
ouverte — elle reviendra. **3a (option E)** est le repli propre si tu ne veux pas ouvrir ce
chantier maintenant : moins ambitieux, honnête, réversible.

**Ce que je ne ferai pas sans arbitrage explicite** : le plancher de hauteur (§4.3) et
l'échelle secondaire (§4.5). Les deux rendent le graphe *plus joli* et *moins vrai* — sur
un outil de trésorerie, c'est le mauvais côté de l'arbitrage.

---

## 8. Questions ouvertes — à trancher par Etienne

1. **Structurel** : 3a (sortir la prévision) ou 3b (homogénéiser la série) ? Ou statu quo
   axe partagé + lots 0-2 seulement, en assumant que la comparaison reste bancale ?
2. **Branche concurrente** (§0.1) : merger `fix/flux-bars-largeur-echelle` d'abord, ou
   assumer le conflit sur `flux-bars.tsx` ?
3. **Format compact** (§5.2) : on étend `format-montant.ts`, ou on garde le format long en
   acceptant la contrainte de largeur (donc pas d'étiquette sous fenêtre « Tout ») ?
4. **Libellé de la mention de couverture** (§4.4) — le mien est un premier jet ; c'est du
   texte produit, il est à toi.
