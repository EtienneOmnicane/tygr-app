# PLAN — TX/DASH-PERIODE-PERSIST1 : la période survit à la navigation

> Phase **conception** (règle 1 CLAUDE.md). Aucune ligne de code applicatif avant ce
> fichier. Référencé pendant l'implémentation. Branche cible : `fix/periode-persist-nav`.

## 1. Problème & décision produit (déjà tranchée — NE PAS rouvrir)

La barre de vue porte deux contrôles : le **périmètre** (filtre de comptes, porté par le
**JWT** → ambiant, suit l'utilisateur) et la **période** (`?periode` preset + `?du`/`?au`
plage précise, portés par l'**URL** — lots A1 et A3/TX-TOOLBAR-DEDUP1, tous deux **mergés
dans `main`**, PR #209 et #210).

**Bug UX** : on pose une période sur le Dashboard, on clique « Transactions » dans la
sidebar → la période retombe au défaut (6 mois). Cause : les liens de
`src/components/shell/sidebar-nav.tsx` sont des `<Link href="/transactions">` **nus** →
les searchParams tombent à la navigation. Le périmètre, lui, ne reset pas (JWT). **Cette
asymétrie est ce qu'on corrige.**

**Décision produit** (tranchée, citée — pas re-litigée) : l'**URL reste la source unique**
de la période (bookmarkable, lisible serveur, propre côté RLS). **PAS** de persistance
cookie/JWT. On rend la barre cohérente en (1) **propageant** les params de période à
travers les liens de nav *qui lisent la période*, et (2) ajoutant un **reset explicite**.

## 2. Prérequis vérifiés (avant plan)

- ✅ A3 (TX-TOOLBAR-DEDUP1) **dans `main`** : `origin/main:toolbar-config.ts` a
  `transactions: barre({ periode: true, plageDates: true, … })` ; `transactions/page.tsx`
  appelle `resoudrePeriode(await searchParams)` ; `periode.ts` a `paramsPeriodeDepuisURL`,
  `lirePlage`, `PRESET_DEFAUT`, `normaliserPreset`. → `/transactions` LIT bien la période.
  `git diff origin/main HEAD` sur les fichiers clés = **vide** (la branche locale
  `fix/tx-toolbar-dedup` n'est que l'ascendance périmée d'avant-squash de la PR #210).
- ✅ Aucune branche concurrente `periode`/`persist` (`git branch -r`, `worktree list`).
- ✅ Arbre `tygr-app/` propre. → **brancher depuis `origin/main`**.

## 3. Contrainte d'architecture décisive : pas de renderer React de test

Le projet n'a **pas de renderer React de test** (choix tracé, CLAUDE.md § widget). Donc les
tests (a)/(b)/(c) exigés NE peuvent PAS porter sur le rendu des composants. **On extrait la
logique en fonctions PURES** (testables sous vitest) et les composants deviennent de fines
coquilles de câblage — exactement la philosophie du repo (toute la logique période vit déjà
dans `periode.ts` pur ; `PeriodeSwitcher`/`PlageDatesSwitcher` sont des coquilles).

## 4. Fichiers touchés

| Fichier | Nature | Rôle |
|---|---|---|
| `src/lib/periode.ts` | modif | `CLES_PERIODE` (constante exportée) ; `paramsPeriodeDepuisURL` itère CETTE liste ; `estHorsDefautPeriode(params)` (prédicat pur, réutilise `lirePlage`+`normaliserPreset`+`PRESET_DEFAUT`) |
| `src/components/shell/nav-periode.ts` | **nouveau** (pur) | `queryPeriodeDepuis`, `doitPropagerPeriode`, `hrefAvecPeriode`, `estActifNav`, `retirerPeriodeQuery` — helpers nav/URL combinant `CLES_PERIODE` + `toolbarConfig` |
| `src/components/shell/sidebar-nav.tsx` | modif | propage la période vers les liens Dashboard/Transactions, sous `<Suspense>` |
| `src/components/shell/reinitialiser-periode.tsx` | **nouveau** (client) | bouton « Réinitialiser la période », visible hors défaut |
| `src/components/shell/barre-vue.tsx` | modif | monte le bouton reset dans le groupe période (gate `config.periode`, sous `<Suspense>`) |
| `src/app/demo/shell/page.tsx` | modif | section QA : monte `<SidebarNav/>` (hrefs inspectables au DOM) |
| `tests/unit/nav-periode.test.ts` | **nouveau** | tests (a) propagation, (b) état actif |
| `tests/unit/periode.test.ts` | modif | tests (c) `estHorsDefautPeriode` + centralisation `CLES_PERIODE` |

**Aucun** changement serveur / RLS / schéma / Server Action (garde-fou : la période est un
filtre de LECTURE pur ; tâche 100 % client + URL). Si je touche une Server Action ou la
RLS → hors périmètre → STOP.

## 5. Détail — unité par unité (= commits logiques)

### Commit 1 — `periode.ts` : centraliser les clés + prédicat « hors défaut »

Aujourd'hui les 3 clés sont des littéraux dans `paramsPeriodeDepuisURL` (lignes 200-206).
On les centralise pour qu'**aucune divergence** nav↔serveur ne soit possible :

```ts
/** Les 3 clés d'URL qui portent la période. SOURCE UNIQUE : lue par le serveur
 *  (paramsPeriodeDepuisURL), propagée par la nav, purgée par le reset. Toute lecture/
 *  écriture de période itère CETTE liste — divergence impossible (garde au TYPE, cf.
 *  la boucle d'assignation ci-dessous : ajouter une clé sans l'ajouter à ParamsPeriode
 *  ne compile pas). */
export const CLES_PERIODE = ["periode", "du", "au"] as const;
export type ClePeriode = (typeof CLES_PERIODE)[number];
```

`paramsPeriodeDepuisURL` construit son objet EN ITÉRANT `CLES_PERIODE` (le `params[cle] =`
ne compile que si `ClePeriode ⊆ keyof ParamsPeriode` → tie prouvé au compilateur) ;
comportement inchangé (param dupliqué → tableau → rejeté par `valeurUnique`).

```ts
/** « Hors défaut » = une PLAGE valide filtre (?du/?au) OU un preset ≠ 6m est actif.
 *  Réutilise les MÊMES gardes que le serveur (lirePlage + normaliserPreset) — aucune
 *  détection maison. Un ?periode/?du forgé ou dupliqué retombe au défaut des deux côtés. */
export function estHorsDefautPeriode(params: ParamsPeriode): boolean {
  return lirePlage(params) !== null || normaliserPreset(params.periode) !== PRESET_DEFAUT;
}
```

### Commit 2 — `nav-periode.ts` (nouveau, pur) : helpers de navigation

```ts
// queryPeriodeDepuis(sp): extrait UNIQUEMENT CLES_PERIODE de sp (whitelist stricte),
//   en préservant fidèlement un param dupliqué (getAll/append) → le serveur cible le
//   rejette identiquement. Ne touche JAMAIS les params propres à une page (?q, ?statut).
// doitPropagerPeriode(href): toolbarConfig(href).periode || .plageDates — SEULS les
//   segments qui LISENT la période (Dashboard "", transactions). Réutilise la matrice CI.
// hrefAvecPeriode(href, sp): href + "?" + queryPeriodeDepuis(sp) SSI doitPropager & query
//   non vide, sinon href nu. → /banques /regles /echeances /graphiques restent NUS.
// estActifNav(hrefItem, pathname): hrefItem==="/" ? pathname==="/" : pathname.startsWith.
//   ⚠️ prend l'href NU + le pathname réel (jamais de query) → l'état actif est INDÉPENDANT
//   des params (c'est le piège du ticket : ne jamais calculer l'actif sur href+params).
// retirerPeriodeQuery(sp): copie de sp SANS les 3 clés → query string (pour le reset).
```

### Commit 3 — `sidebar-nav.tsx` : câbler la propagation (sous Suspense)

Structure (évite toute duplication de markup, isole `useSearchParams`) :

- `NavListe({ hrefParItem })` — **présentationnel** : `usePathname`, mappe `ITEMS`,
  calcule `actif = estActifNav(item.href, pathname)` sur l'href **NU**, et
  `href = hrefParItem(item.href)` pour le `<Link>`. Markup/classes **inchangés**.
- `NavAvecPeriode()` — lit `useSearchParams`, rend `<NavListe hrefParItem={h => hrefAvecPeriode(h, sp)} />`.
- `SidebarNav()` (export, importé par le Server Component `AppSidebar`) — 
  `<Suspense fallback={<NavListe hrefParItem={h => h} />}><NavAvecPeriode/></Suspense>`.
  Fallback = nav aux hrefs NUS : rendu serveur correct au prerender, bascule vers les
  hrefs porteurs de période à l'hydratation (aucun saut de layout — seul le query change,
  invisible). Même motif que `barre-vue.tsx` pour `PeriodeSwitcher`.

### Commit 4 — `reinitialiser-periode.tsx` (nouveau, client) + montage dans `barre-vue.tsx`

Composant `ReinitialiserPeriode` :
- `paramsPeriodeDepuisURL(useSearchParams())` → `estHorsDefautPeriode(params)`. **Si défaut →
  `return null`** (pas de bouton leurre).
- Au clic : `router.replace` sur `pathname + "?" + retirerPeriodeQuery(sp)` (ou `pathname`
  nu si vide), `{ scroll: false }` → supprime `periode`/`du`/`au`, **préserve les autres
  params**. URL propre = retour « 6 mois ».
- Style : **neutre / `text-muted`** (action neutre, PAS `inflow`/`outflow` réservés aux
  montants, PAS le rouge `danger` d'erreur — UI_GUIDELINES). Pilule `hover:bg-surface-inset
  hover:text-ink`, `focus-visible:ring-primary`. `shrink-0`, pas de `flex-wrap`.

Montage dans `barre-vue.tsx`, dans le **groupe période**, après `PlageDatesSwitcher`, gaté
`config.periode`, sous son propre `<Suspense fallback={null}>` (il lit `useSearchParams`).
Le « × » du `PlageDatesSwitcher` (efface la plage, rend la main au preset) **reste** — mon
bouton, lui, ramène le groupe ENTIER (preset + plage) au défaut. Distincts, complémentaires.

### Commit 5 — Tests

`tests/unit/nav-periode.test.ts` :
- **(a)** `hrefAvecPeriode` : source `?q=foo&periode=3m&du=2026-03-03&au=2026-04-17` →
  Dashboard `/` et `/transactions` reçoivent SEULEMENT `periode/du/au` (jamais `q`) ;
  `/echeances`/`/graphiques`/`/banques`/`/regles` restent NUS. Source vide → href nu (pas
  de `?`). Param dupliqué (`?du=X&du=Y`) propagé fidèlement (les deux valeurs).
- **(b)** `estActifNav` : `("/","/")=true`, `("/","/transactions")=false`,
  `("/transactions","/transactions")=true`, `("/transactions","/transactions/tx-1")=true`,
  `("/transactions","/")=false`. Prouve l'indépendance aux params (pathname sans query).

`tests/unit/periode.test.ts` (extension) :
- **(c)** `estHorsDefautPeriode` : `{}`→false, `{periode:"6m"}`→false,
  `{periode:"3m"}`→true, `{periode:"tout"}`→true, `{du,au}` valide→true,
  `{du}` seul→false, `{periode:"garbage"}`→false, `{du:["X","Y"]}`→false (dup rejeté).
- `retirerPeriodeQuery` : `"periode=3m&du=X&au=Y&q=foo"`→`"q=foo"` ; `"periode=3m"`→`""` ;
  dup `"du=X&du=Y&q=z"`→`"q=z"`.
- Centralisation : `CLES_PERIODE` = `["periode","du","au"]` et `paramsPeriodeDepuisURL`
  lit exactement ces 3 clés (comportement).

## 6. Garde-fous (checklist)

- [ ] Whitelist stricte `periode`/`du`/`au` — jamais `?q`/`?statut` de `/transactions`.
- [ ] Propagation SEULEMENT vers les segments qui lisent (via `toolbarConfig`).
- [ ] État actif calculé sur l'href **NU** (piège du ticket).
- [ ] Aucune couleur en dur ; reset neutre (`text-muted`), ni sortie ni erreur.
- [ ] Pas de `flex-wrap` sur le header ; condensation.
- [ ] Zéro serveur/RLS/schéma. Lecture normalisée via les helpers `periode.ts` (pas de
      `.get()` maison ; `paramsPeriodeDepuisURL` gère le param dupliqué).
- [ ] `<Suspense>` autour de tout `useSearchParams` (nav + reset).

## 7. Visual QA (Gate 4) — sur `/demo/shell`

Le demo monte déjà `AppTopbar` (donc `BarreVue` → mes contrôles période). J'ajoute une
section montant `<SidebarNav/>` (hrefs inspectables au DOM, hors auth/DB).
- Nav : sur `/demo/shell?periode=3m&du=2026-03-03&au=2026-04-17`, asserter au DOM que
  `a[href]` Dashboard/Transactions portent la query période et que echeances/graphiques/
  banques/regles sont nus. Sur `/demo/shell` nu, tous nus.
- Reset : sur `/demo/shell?periode=3m` (ou `?du=…&au=…`), le bouton « Réinitialiser la
  période » APPARAÎT dans les topbars période ; sur `/demo/shell` nu, il est ABSENT.
- Le bout-en-bout réel (clic Dashboard→Transactions, liste filtrée ; reset → 6 mois, URL
  propre) relève de la validation humaine (Gate 3 Human-in-the-Loop, stack sandbox).

## 8. Critères de sortie (même PR)

`npm run lint` + `npm run typecheck` + `npm run build` verts ; **suite complète verte**
(dont isolation + garde CI toolbar `toolbar-config.test.ts`) ; tests (a)/(b)/(c) ajoutés.
Revue par **contexte frais** (subagent indépendant / `/review`) avant de proposer.

## 9. Workflow Git (Human-in-the-Loop)

Branche `fix/periode-persist-nav` depuis `origin/main` à jour ; travail exclusif dans
`tygr-app/` ; commits par unité logique (§5). **STOP à la branche poussée** — je n'ouvre
PAS la PR, je ne merge PAS (code applicatif → validation + merge manuels d'Etienne, ticket
+ CLAUDE.md Règle 2). Je fournis le lien/commande de création de PR pour qu'Etienne l'ouvre.
