# PLAN — Plage de dates précise dans la barre de vue (TOOLBAR-DATE-PRECISE1, lot A1)

Date : 2026-07-14 · Branche : `feat/toolbar-date-precise` · Effort : ~0,5 j
Références : `PLAN-toolbar-config.md` (lot A2, prérequis mergé #208), TODOS.md
§ **TOOLBAR-DATE-PRECISE1**. Ce plan implémente le cadrage A1 ; il ne re-litige pas
la matrice A2 (règle 10).

## 1. Problème

Les presets de période (`Ce mois / 3m / 6m / 12m / Tout`) ne couvrent pas la demande
« du 3 mars au 17 avril » (rapprochement, clôture, contrôle d'un relevé). Il manque un
sélecteur de **plage explicite** (`?du` / `?au`) dans la barre de vue.

**Contrainte dirigeante, héritée d'A2 : un contrôle affiché DOIT filtrer réellement.**
Un sélecteur de dates monté sur une page qui ne lit pas `?du`/`?au` serait le
« mensonge de la période » que le lot combat. Donc : **on ne monte le contrôle que là
où le serveur est câblé**, et la CI le vérifie mécaniquement.

## 2. Fait nouveau découvert au cadrage (et son arbitrage)

En vérifiant le câblage serveur, constat : **le Dashboard est la SEULE page du groupe
`(workspace)` qui lit `?periode`.** Les deux autres pages où A2 a monté le
PeriodeSwitcher l'IGNORENT complètement :

| Page            | `periode: true` (A2) | lit `?periode` ? | filtre de période réel                                  |
| --------------- | -------------------- | ---------------- | ------------------------------------------------------- |
| `/` (dashboard) | ✅                   | ✅ `resoudrePeriode` | la barre                                            |
| `/graphiques`   | ✅                   | ❌ (pas de `searchParams`) | **segmenté IN-PAGE** (`graphiques-feature.tsx`) |
| `/transactions` | ✅                   | ❌ (pas de `searchParams`) | **dates IN-PAGE** (`transactions-toolbar.tsx`)  |

A2 a donc livré son propre défaut sur ces deux pages : sa garde CI vérifiait
l'invariant *périmètre*, jamais « la page lit-elle vraiment `?periode` ». Câbler
`?du`/`?au` sur `/graphiques` y créerait **deux filtres de période concurrents** — le
défaut exact que TODOS.md ligne 74 avait anticipé (« trancher d'abord qui possède les
bornes de date, sinon deux canaux concurrents »), tranché pour Transactions (A3) mais
jamais pour Graphiques.

**Arbitrage Etienne (2026-07-14, après pushback règle 10)** — option « Dashboard seul
+ tuer le no-op » :

- A1 câble `?du`/`?au` sur le **Dashboard UNIQUEMENT**.
- `/graphiques` repasse à **`periode: false`, `plageDates: false`** : on RETIRE de la
  barre un PeriodeSwitcher qui ne filtre rien aujourd'hui. **Zéro régression** (c'est un
  no-op ; le segmenté in-page reste maître et continue de filtrer) — c'est une
  correction du défaut A2.
- `/transactions` : **INTACT** (hors périmètre, arbitrage explicite). Son PeriodeSwitcher
  reste un no-op jusqu'à A3 — mais il devient une **exemption NOMMÉE et DATÉE dans la
  garde CI** (§6) au lieu d'un mensonge silencieux. A3 supprimera l'exemption.
- Unification de `/graphiques` sur la barre → dette **GRAPHIQUES-PERIODE-DEDUP1** (P2,
  jumelle de TX-TOOLBAR-DEDUP1), qui devra trancher le conflit de vocabulaire des presets
  (la barre n'a pas de fenêtre glissante 30j/90j ; Graphiques n'a pas de « Tout »).

## 3. Périmètre

Dashboard + matrice. **Aucun changement** de schéma, d'API, de RLS, de Server Action ni
de repository → **zéro surface de sécurité nouvelle** (pas de nouveau cas d'isolation).
`?du`/`?au` sont des paramètres de LECTURE, normalisés en dates typées avant de toucher
le SQL (même défense que `?periode` : la valeur brute d'URL n'atteint jamais une requête).

## 4. Décisions d'implémentation

### 4.1 `src/lib/periode.ts` — la plage PRIME sur le preset

`resoudrePeriode` prend désormais **l'objet `searchParams` entier** (au lieu du seul
`?periode`) : c'est la seule façon de faire vivre la règle de priorité dans UNE fonction
pure qui possède tout le contrat d'URL. Un seul appelant (le Dashboard) → migration triviale.

- `lirePlage(params)` — helper PUR partagé **serveur ET client** (source unique de la
  validation, pas de re-implémentation dans le .tsx). Retourne `{du, au}` ou `null` :
  - `du`/`au` absents ou incomplets (un seul des deux) → `null` ;
  - non `YYYY-MM-DD` calendaire réel (2026-02-30 → rejet) : réutilise **`estDateISO`**
    de `format-date.ts` (source unique — pas une 3ᵉ implémentation de validité de date) ;
  - `du > au` → `null` (comparaison lexicographique : licite sur du `YYYY-MM-DD` de
    largeur fixe, aucun `new Date` donc aucun fuseau parasite) ;
  - amplitude > `MAX_MOIS_PLAGE` (120 mois) → `null`. **Anti-abus** (règle 3, bornes) :
    sans plafond, un `?du=1900-01-01` forgé à la main ferait générer 1 200+ mois de
    grille de tendance et un `GROUP BY` d'autant. Le plancher réel des données est
    `PLANCHER_HISTORIQUE` (2024-01-01), donc 10 ans ne bride aucun usage légitime.
  - Toute invalidité → `null` → **repli silencieux sur le preset**, conformément à la
    convention EXISTANTE du module (`normaliserPreset` : hors liste blanche → défaut).
    Cohérence > rejet bruyant ici : l'URL est forgée par notre UI, et une page de
    lecture ne doit pas rendre un 400 sur un param cosmétique.
- `resoudrePeriode(params)` : si `lirePlage` rend une plage → `from/to = du/au`,
  `moisAncrage` = mois de `au` (la tendance se termine à la FIN de la plage, pas
  aujourd'hui), `nbMois = nbMoisEntre(du, moisAncrage)` ; sinon → chemin preset inchangé.
- `BornesPeriode.preset` devient **`PresetPeriode | null`** : `null` quand une plage
  prime. C'est la garde ANTI-MENSONGE au niveau du type — un appelant ne peut plus lire
  `.preset` et croire que « 6m » s'applique alors qu'une plage filtre.

**Fuseau (règle CLAUDE.md, à ne PAS mal lire).** Le chemin PRESET continue de dériver
« aujourd'hui » par conversion EXPLICITE `Indian/Mauritius` (`aujourdhuiMaurice`). Le
chemin PLAGE, lui, ne convertit **rien** — et c'est correct : `du`/`au` sont des **dates
comptables Maurice saisies telles quelles** (un `<input type="date">` n'a pas de fuseau),
comparées à `transaction_date` qui EST déjà la date Maurice (E20). La règle « jamais de
date nue » interdit de dériver un JOUR depuis un INSTANT sans poser le fuseau : le chemin
plage ne touche aucun instant. Là où un instant intervient — le `max` du champ `au` (« pas
de date future ») — on passe par `dateCouranteMaurice()`, PAS par le `new Date()` du
navigateur (à 21 h à Paris, Maurice est déjà le lendemain).

### 4.2 `toolbar-config.ts` — flag `plageDates`

`ConfigBarreVue` gagne `plageDates: boolean`. Dashboard `true` ; **tout le reste `false`**
(dont `/transactions` — arbitrage §2 — et `/graphiques`, qui perd aussi `periode`).
Invariant : **`plageDates: true` ⇒ `periode: true`** (la plage prime SUR un preset ; sans
groupe de presets affiché, « primer » n'a pas de sens et il n'y a plus de retour arrière
en un clic).

### 4.3 UI — `plage-dates-switcher.tsx` (client, nouveau)

Calque de `PeriodeSwitcher` : lit l'URL (`useSearchParams`), écrit par `router.replace`
(`scroll: false`, autres params PRÉSERVÉS). Deux `<input type="date">` (même primitive
que `transactions-toolbar.tsx` — cohérence, et le navigateur borne nativement
`du.max = au` / `au.min = du`, donc une plage inversée n'est même pas saisissable).

- **État local** pour les deux champs, **commit à l'URL seulement quand la paire est
  complète** : une plage à moitié saisie ne doit pas écrire `?du=` seul (le serveur
  replierait sur le preset → l'écran mentirait sur ce qu'il filtre).
- **Priorité VISIBLE** (exigence du lot) : plage active ⇒ (a) le `PeriodeSwitcher`
  n'affiche **AUCUN segment actif** (`actif = null`, `aria-checked=false` partout) — sinon
  « 6 mois » resterait allumé pendant qu'une plage filtre, soit le mensonge à l'échelle du
  contrôle ; (b) le contrôle de plage porte l'état actif (bordure `primary`) + un bouton
  **×** qui efface `?du`/`?au` et rend la main au preset.
- Cliquer un preset **efface la plage** (2ᵉ porte de sortie, comportement attendu).
- Tokens sémantiques uniquement, **pas de `flex-wrap`** sur le header (règle UI).
- `<Suspense>` autour du contrôle (comme `PeriodeSwitcher`) : `useSearchParams` force le
  bail-out CSR au prerender (Next 16) ; fallback inerte aux mêmes dimensions.

**Piège vérifié (nit TODOS ligne 76)** : le champ caché `origine` du `PerimetreSwitcher`
lit la query via `useSyncExternalStore` abonné au seul `popstate` — or `router.replace`
n'émet pas `popstate`. Non aggravé ici : son `getSnapshot` relit
`window.location.search` à CHAQUE rendu, et le `<form>` n'existe que popover ouvert.
Mon contrôle écrit l'URL exactement comme `PeriodeSwitcher` (au `change` d'un input
visible, **sans debounce ni raccourci clavier**) — c'est précisément le cas que le nit
déclare sûr. La dette reste ouverte, inchangée.

#### 4.4 Câblage serveur

Dashboard : `resoudrePeriode(await searchParams)` (l'objet entier). Graphiques : rien à
câbler (sorti du périmètre, cf. §2).

⚠️ **Ce paragraphe affirmait initialement que ça suffisait. C'ÉTAIT FAUX** — cf. §4.5.

### 4.5 Le vrai piège : les agrégats MENSUELS ignoraient `from`/`to` (BLOQUANT de revue)

Constat de la cross-review, **vérifié dans le SQL puis arbitré par Etienne (2026-07-14)** :
deux des quatre cartes du Dashboard n'étaient PAS bornées au jour.

| Lecture | Avant | Sous plage « 3 mars → 17 avril » |
| --- | --- | --- |
| `vendorsParConcentration` / `cashflowParDevise` | `{from, to}` | ✅ correct |
| `syntheseMoisParDevise(mois)` | bords de MOIS | ❌ **avril ENTIER** (18→30 avril inclus) |
| `syntheseParMois({moisFin, nbMois})` | bords de MOIS | ❌ **mars + avril ENTIERS** |

Ça ne se voyait pas avec les presets : leur `from` tombe TOUJOURS un 1er du mois et leur
`to` vaut aujourd'hui → l'agrégat mensuel coïncidait avec le filtre. **Une plage au jour
casse cet alignement aux deux extrémités.** Livrer en l'état aurait déplacé le mensonge de
la barre vers la DONNÉE FINANCIÈRE — le défaut que ce lot existe pour tuer.

Correctif (option retenue par Etienne : « câbler les agrégats sur from/to ») :
- `syntheseMoisParDevise(mois)` → **`synthesePeriodeParDevise({from, to})`** (renommée : elle
  n'agrège plus « un mois »). Le type `SyntheseMoisDevise` → `SynthesePeriodeDevise`.
- `syntheseParMois({moisFin, nbMois})` → **`syntheseParMois({from, to})`** : la fenêtre est au
  JOUR, le GROUP BY reste MENSUEL → sous plage, les mois d'extrémité sont **PARTIELS**
  (mars = 3→31). Assumé et **annoncé par le libellé de période**.
- **Zéro régression sous preset** : la page passe alors le mois d'ancrage ENTIER
  (`${mois}-01` → `dernierJourMois(mois)`) = exactement les anciennes bornes. La Server
  Action `syntheseParMoisAction` reconstitue de même sa fenêtre historique.
- **Libellés** (ils mentaient aussi) : « N derniers mois » est FAUX sous une plage passée
  (janvier→mars consultée en juin). Un `libellePeriode` est calculé **une fois par la page**
  (source unique) et descend dans l'en-tête, le Top contreparties, la tendance et
  l'`aria-label` du graphe. La carte « Synthèse du mois » devient « Synthèse de la période »
  sous plage, avec l'intervalle réel — un titre ne doit jamais annoncer autre chose que ce
  qu'il agrège.
- **Preuve (suite d'isolation, bloquante en CI)** : plages coupant À L'INTÉRIEUR des mois
  d'extrémité, des deux côtés (un débit hors plage doit disparaître des totaux), plage d'un
  seul jour, bornes inclusives, multi-devise préservé.

## 5. Tests

`tests/unit/periode.test.ts` : plage explicite prime sur le preset ; `du > au` → repli ;
`?du`/`?au` invalides (format, 2026-02-30, tableau, plage incomplète) → repli ;
amplitude > 120 mois → repli ; `preset === null` quand la plage prime ; `nbMois`/
`moisAncrage` dérivés de la FIN de plage ; non-régression de tous les cas preset existants.

`tests/unit/toolbar-config.test.ts` : matrice mise à jour (dashboard `plageDates`,
graphiques sans période) + invariant `plageDates ⇒ periode`.

## 6. Garde CI ANTI-MENSONGE (le cœur du lot)

Nouveau test : **toute page dont la matrice monte `periode` ou `plageDates` DOIT lire
`resoudrePeriode`** — vérifié en lisant le source de sa `page.tsx` (`src/app/(workspace)/
<segment>/page.tsx`, le route group `(dashboard)` résolvant le segment `""`).

C'est la garde qui aurait attrapé le défaut d'A2, et elle est mécanique (pas de vigilance
de relecteur). Elle porte **une seule exemption, nommée et datée** : `transactions`
(dette A3 / TX-TOOLBAR-DEDUP1). Le mensonge devient ainsi *tracké et bloquant par défaut*
au lieu d'être silencieux ; A3 supprimera la ligne d'exemption.

## 7. Exit criteria

- [x] `lint`, `typecheck`, build, tests verts (règle 5) — 1209 tests / 78 fichiers.
- [x] Aucune migration, aucune RLS, aucune nouvelle route/Server Action → **pas de nouvelle
      surface d'authz**. Deux repositories voient leurs BORNES resserrées (jointures, scope
      entité et policies INCHANGÉS) ; leurs cas d'isolation sont mis à jour ET complétés.
- [x] Revue contradictoire (contexte frais, règle 6) : **1 BLOQUANT** (§4.5, agrégats
      mensuels — arbitrage humain rendu, corrigé), **3 IMPORTANTS** corrigés :
      - param DUPLIQUÉ (`?du=X&du=Y`) : `URLSearchParams.get()` rendait « le premier » côté
        UI là où Next livre un tableau au serveur → le contrôle s'allumait sur une plage que
        la page ignorait. Lecture d'URL unifiée (`paramsPeriodeDepuisURL`).
      - brouillon désynchronisé : vider une borne laissait la plage FILTRER en silence
        (champ vide, bordure active, serveur toujours borné) → une paire inexploitable LÈVE
        désormais la plage ; saisie invalide signalée (`aria-invalid` + fond `danger-bg`).
      - garde CI trop faible : un simple COMMENTAIRE contenant « resoudrePeriode » la
        satisfaisait, et elle n'empêchait pas de passer `{ periode }` seul (qui typecheck et
        ignore `?du`/`?au`) → elle dépouille les commentaires et refuse l'objet littéral.
      - NITs traités : plancher historique appliqué à `?du` ; contrôle de plage condensé
        sous `lg` (pas de `flex-wrap` sur le header). NIT laissé : `max` du champ figé à
        l'hydratation (périmé d'un jour si l'onglet reste ouvert au-delà de minuit Maurice —
        le natif ne fait que guider, la garde est serveur).
- [ ] TODOS.md : TOOLBAR-DATE-PRECISE1 → A1 livré (Dashboard) ; nouvelle entrée
      GRAPHIQUES-PERIODE-DEDUP1 (P2) ; TX-TOOLBAR-DEDUP1 pointe l'exemption CI.
- [ ] **Visual QA humain (Gate 4)** : `/demo/shell` (section dashboard = période + plage)
      et le Dashboard réel — dont la **vérification fuseau (règle HITL 3b)** : une plage
      « du 1er au 1er » tombe bien sur la journée comptable Maurice attendue.
- [ ] STOP à la PR poussée (PR applicative → Human-in-the-Loop).
