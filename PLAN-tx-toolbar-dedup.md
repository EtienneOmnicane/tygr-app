# PLAN — TX-TOOLBAR-DEDUP1 (A3) : dédoublonner les filtres de dates de `/transactions`

> Phase **conception** (règle 1 CLAUDE.md). Aucune ligne de code applicatif avant ce fichier ;
> l'implémentation le référence. Ticket : `TODOS.md` → `TX-TOOLBAR-DEDUP1`. Effort : ~0,25 j.
> Branche : `fix/tx-toolbar-dedup` depuis `main` à jour. Travail exclusif dans `tygr-app/`.

## 1. Objectif

Depuis le lot A1 (`TOOLBAR-DATE-PRECISE1`, PR #209, **mergé dans main**), la barre de vue globale
porte une plage de dates précise (`?du`/`?au`) + presets (`?periode`). Résultat : `/transactions`
a **deux** sources de filtre de dates concurrentes sur le même écran :

1. la **barre globale** (`PeriodeSwitcher` + `PlageDatesSwitcher`) — aujourd'hui un **NO-OP** sur
   `/transactions` (la page ne lit pas `searchParams`) ;
2. les **bornes de date IN-PAGE** de `transactions-toolbar.tsx` (`?` deux `<input type="date">`).

But : **retirer les bornes in-page** et faire de la **barre globale la source unique**, en copiant
le pattern déjà en place sur le Dashboard (`resoudrePeriode(searchParams)`). Précédent exact déjà
appliqué sur cet écran : le sélecteur de compte a été retiré au profit du `PerimetreSwitcher` global
(PR #190, commentaire « retrait feedback 0709 » — `transactions-toolbar.tsx:13-16`).

## 2. Vérif préalable — branches concurrentes (mémoire `sprint-verifier-branches-concurrentes`)

`git branch -r` + `git worktree list` + diffs faits **avant** ce plan. Conclusion : **AUCUN
recouvrement vivant**.

- Précédents cités par le ticket → **tous mergés dans main** : #209 (A1 plage), #208 (A2 matrice
  toolbar-config), #207 (somme nette), #206 (recherche layout-shift), #190 (retrait sélecteur compte).
- `origin/fix/transactions-runtime-usserver-capture` (touche `page.tsx`) → **déjà dans main**
  (l'inline `versUI` + son commentaire sont présents `page.tsx:187-200`). Branche périmée.
- `origin/feat/transactions-recherche` (touche `transactions-toolbar.tsx`) → **superseded** (la
  recherche est dans main, commit `243cdfc`). Branche périmée.
- Worktrees `.worktrees/retrait-selecteur` et `.worktrees/runtime-usserver` → **orphelins**
  (non-ancêtres de main). On n'y touche pas ; branche fraîche depuis `main`.

## 3. Ce que le repo fournit DÉJÀ (rien à créer côté serveur)

- **`resoudrePeriode(params)`** (`src/lib/periode.ts`) : source **unique** de validation. Rend
  `{ preset, from, to, nbMois, moisAncrage }`. `from`/`to` = dates comptables **Maurice**
  `YYYY-MM-DD` **inclusives**. Plage `?du`/`?au` **prime** sur preset. Défaut = **`6m`**
  (`PRESET_DEFAUT`). Presets : `ce-mois / 3m / 6m / 12m / tout` (`tout` → `from = 2024-01-01`).
  Fuseau géré à l'intérieur ; **on ne réimplémente aucune borne** (règle CLAUDE.md « Localisation »).
- **Backend prêt, contrat INCHANGÉ** : `listerTransactionsAction` / `sommeNetteTransactionsAction`
  (`transactions/actions.ts`) valident déjà `dateDebut`/`dateFin` (`transactions-schema.ts:89-128`,
  garde Zod `dateDebut ≤ dateFin`). Le repo filtre sur `transaction_date` via `gte/lte`
  (`repositories/transactions.ts:516-520`) — or `transaction_date` **EST** déjà la date Maurice
  (E20). Injecter `from`/`to` (déjà Maurice) comme `dateDebut`/`dateFin` est donc **cohérent, sans
  conversion**, et **n'ouvre aucune nouvelle surface serveur** → pas de nouveau cas d'isolation
  (le ticket l'anticipait). Les tests d'isolation existants prouvent déjà le filtrage de date
  scopé tenant (`transactions-isolation.test.ts:326-345`, `transactions-somme-nette-isolation.test.ts`).
- **Navigation** : `PeriodeSwitcher`/`PlageDatesSwitcher` font `router.replace(pathname?query,
  {scroll:false})` sur la **page courante** → re-rendent le RSC `page.tsx` avec la nouvelle borne
  (`periode-switcher.tsx:10-11,94`). Sur `/transactions`, changer période/plage **re-exécutera**
  bien `PageTransactions`. Le `PerimetreSwitcher` (JWT + Server Action + redirect) est un mécanisme
  **séparé et orthogonal** — non touché par ce lot.

## 4. Piège CRITIQUE identifié (invisible aux gates) et sa solution

`TransactionsFeature` est **client-driven** : il seed `lignes`/`curseur`/`filtres` depuis la prop
`initial` **une seule fois** au montage (`transactions-feature.tsx:121-125`, `useState(initial…)`),
**jamais re-synchronisé**. Donc câbler naïvement le RSC (lui passer un nou`initial` calculé pour la
nouvelle période) **n'actualiserait PAS la liste affichée** : l'URL changerait, le RSC recalculerait
`initial`, mais la liste client resterait **périmée** jusqu'à ce qu'on touche un filtre in-page.
C'est le classique « état dérivé des props » — lint/tsc/build **verts**, bug au runtime.

**Solution (deux mécanismes complémentaires, les deux nécessaires) :**

1. **Injection SERVEUR de la période** dans les 3 chemins d'appel (voir §5.C). La période vit dans
   l'URL (lue par le RSC), **jamais** dans `filtres` client — exactement comme `nomParCompte` est
   déjà injecté côté serveur. Ainsi la pagination « Charger plus » et le refetch de la somme
   restent bornés à la période **sans** que le client ait à la connaître.
2. **`key={`${from}|${to}`}` sur `<TransactionsFeature>`** dans `page.tsx`. Au changement de
   période, `from`/`to` changent → `key` change → React **remonte** le composant → re-seed depuis
   le `initial` frais (page 1 de la nouvelle période). Idiome Next standard pour « réinitialiser
   l'état client quand une identité dérivée du serveur change ». Miroir du comportement Dashboard
   (qui, étant RSC pur, se re-rend entièrement à chaque changement de période).

> Pourquoi les DEUX : l'injection seule laisse la liste visible périmée (piège ci-dessus) ; le
> `key` seul ne suffit pas car « Charger plus »/refetch de somme passent par les closures — qui
> **doivent** porter la période, sinon la page 2 ramènerait tout l'historique.

## 5. Changements, fichier par fichier (tout dans `tygr-app/`)

### A. `src/components/transactions/transactions-toolbar.tsx` — retirer les bornes in-page
- Supprimer les **deux** blocs `<label>…<input type="date">` (`~233-265` : « Date de début » /
  « Date de fin ») et leur commentaire de bloc.
- Docstring l.17 : retirer « bornes de date » de l'énumération des contrôles.
- **CONSERVER** : la recherche (débounce ~300 ms, refs `filtresRef`/`onChangeRef`), le filtre
  **STATUT**, l'action « Gérer les catégories ». Le `justify-between`/`overflow-x-auto`/pas de
  `flex-wrap` reste (toolbar h-10 rangée unique).

### B. `src/components/transactions/types-transactions.ts` — nettoyer le contrat de filtres
- Retirer `dateDebut?` et `dateFin?` de `FiltresTransactions` (l.157-160).
- Mettre à jour la docstring (l.135-145) : les dates ne sont **plus** un filtre in-page — la fenêtre
  de dates est portée par la **barre globale** (URL `?periode`/`?du`/`?au`), injectée côté serveur.
  Le SCHÉMA backend garde `dateDebut`/`dateFin` (c'est ce que la période alimente).

### C. `src/app/(workspace)/transactions/adapter.ts` — injecter la période (source unique préservée)
- `versInputBackend(filtres, curseur, periode?: { from: string; to: string })` : après `statut`,
  avant `curseur`, poser `input.dateDebut = periode.from ; input.dateFin = periode.to` si `periode`.
  **Retirer** les lignes `if (filtres?.dateDebut)…` / `if (filtres?.dateFin)…` (82-83).
- `versFiltresSommeNette(filtres, periode?: {…})` : `const input = versInputBackend(filtres, null,
  periode)` puis `delete input.curseur/limite`. → la somme **hérite mécaniquement** de la période
  (invariant « source unique de projection de filtres », adapter.ts:88-101, **préservé** : un futur
  filtre atterrit dans les deux). Param **optionnel** ⇒ appels/tests existants compilent toujours.

### D. `src/app/(workspace)/transactions/page.tsx` — câbler la page sur la période globale
- Signature : `PageTransactions({ searchParams }: { searchParams: Promise<{ [cle: string]: string |
  string[] | undefined }> })` — **strict copie** du Dashboard (`(dashboard)/page.tsx:56-60`).
- Après la garde de session : `const { from, to } = resoudrePeriode(await searchParams); const
  periode = { from, to };` (on n'a besoin QUE des bornes au jour — ni `nbMois` ni `moisAncrage`,
  propres à la tendance du Dashboard).
- Injecter `periode` dans les **3** chemins :
  - `premiere = await listerTransactionsAction(versInputBackend(undefined, null, periode))` (l.145) ;
  - closure `listerTransactions` : `versInputBackend(filtres, curseur, periode)` (l.117) ;
  - closure `sommeNette` : `versFiltresSommeNette(filtres, periode)` (l.136).
  Les closures capturent `periode` (objet **sérialisable** de deux chaînes — sans rapport avec le
  piège « capture de fonction locale » ; sûr, comme la `Map nomParCompte` déjà capturée).
- `<TransactionsFeature key={`${from}|${to}`} … />` (remount au changement de période, §4).
- Le commentaire de tête de fichier gagne une note « période = barre globale via resoudrePeriode ».
- `import { resoudrePeriode } from "@/lib/periode";`.

### E. `src/components/shell/toolbar-config.ts` — /transactions devient une page à plage câblée
- `transactions: barre({ periode: true, plageDates: true, perimetre: true, cta: true })` (ajouter
  `plageDates: true` — l.165). Mettre à jour le commentaire (l.159-164) : A3 livré, la page LIT
  `resoudrePeriode(searchParams)`, la plage est désormais montée (fin du NO-OP).
- Invariants CI satisfaits : `plageDates ⇒ periode` (periode reste `true`) ✓ ; anti-mensonge (la
  page appelle `resoudrePeriode(await searchParams)`, pas un objet littéral) ✓.

### F. `tests/unit/toolbar-config.test.ts` — supprimer l'exemption, unifier les attendus
- `SEGMENTS_PERIODE_NON_CABLEE = []` (retirer `"transactions"`, l.79) + réécrire son commentaire :
  A3 a fermé l'unique exemption ; **ne jamais rallonger** (toute entrée = aveu d'un contrôle qui ne
  filtre rien, la revue doit la refuser).
- `COMPLETE` devient la barre **complète AVEC plage** (`plageDates: true`) : `/transactions` partage
  désormais la config du Dashboard. Remplacer les usages de `COMPLETE_AVEC_PLAGE` par `COMPLETE` et
  supprimer la constante devenue redondante ; ajuster les libellés/commentaires des `it(...)`
  (`/transactions` : période **+ plage** + périmètre + CTA).
- La garde « une page qui MONTE la période DOIT la LIRE » relira `transactions/page.tsx` (sans
  exemption) et le trouvera appelant `resoudrePeriode(await searchParams)` → **vert**.

### G. `tests/unit/transactions-adapter-filtres.test.ts` — tester l'injection période
- Le test « cumule recherche + statut + dates » (l.45-61) passait `dateDebut`/`dateFin` **dans les
  filtres UI** → ne compilera plus. Le réécrire : `versInputBackend({recherche, statutCategorisation},
  null, { from, to })` ⇒ `{ recherche, statut, dateDebut: from, dateFin: to }`.
- Ajouter : période seule (sans filtre in-page) ⇒ `{ dateDebut, dateFin }` ; et
  `versFiltresSommeNette(filtres, periode)` porte la **même** injection (sans curseur/limite).

### H. (optionnel, polish) `transactions-feature.tsx`
- **Aucun changement fonctionnel requis** (le `key` vit dans `page.tsx` ; `filtreActif` itère
  `Object.values(filtres)` → fonctionne avec moins de clés ; la période est ambiante, pas dans
  `filtres`). Éventuel toilettage : le commentaire l.347 « (statut/dates) » → « (statut) » et le
  message d'état vide reste valide pour « aucune opération sur cette période ». À faire seulement
  si ça n'élargit pas le diff inutilement.

## 6. Décisions de conception à acter (règle 10 — énoncées, pas fabriquées)

1. **Défaut = 6 mois** (au lieu de « tout » historiquement). Conséquence **directe et assumée** du
   « copier le Dashboard » : `resoudrePeriode({})` → `PRESET_DEFAUT = 6m`. **Pas un mensonge** : la
   barre affiche « 6 mois » actif et la liste montre 6 mois ; « Tout » est à **un clic**. C'est
   l'intention explicite du ticket (barre = source unique), pas une extension de périmètre.
2. **Les filtres in-page (recherche/statut) se réinitialisent** quand la période globale change
   (conséquence du remount `key`). Cohérent avec la sémantique « refresh complet » du Dashboard, et
   raisonnable pour une action volontaire et proéminente. Alternative (préserver via refetch piloté
   par effet) : plus de code, double-fetch/flash — écartée pour un lot ~0,25 j. **À signaler dans la
   PR** ; si Etienne préfère la préservation, c'est un suivi propre.
3. **La somme nette reste déclenchée par un filtre in-page** (`filtreActif` inchangé), la période
   étant un **scope ambiant** (comme le périmètre RLS) : la somme la **respecte** (injection serveur)
   sans être déclenchée par elle. « Un changement de plage filtre la somme » se vérifie ainsi :
   sous un filtre statut, la somme est bornée à la plage active (ses `dateDebut/dateFin` = plage).

## 7. Plan de test / critères de sortie (même PR)

- `npm run lint` · `npm run typecheck` · `npm run build` **verts**.
- `npx vitest run` : garde CI toolbar **verte SANS** exemption `SEGMENTS_PERIODE_NON_CABLEE` ;
  `transactions-adapter-filtres` mis à jour vert ; suite d'isolation (inchangée) verte.
- **Visual QA (Gate 4)** contre `docs/UI_GUIDELINES.md`, navigateur headless (`next start` HTTP —
  cf. mémoire, éviter le proxy HTTPS qui casse l'hydratation) : états **loading / vide / erreur /
  succès** de `/transactions` ; **prouver au DOM** que la toolbar n'a plus qu'une rangée (recherche
  + statut + action), pas de champ date ; **vérifier qu'un changement de plage dans la barre globale
  filtre la liste ET (sous filtre) sa somme nette**, et que « Tout » réélargit.
- Cohérence fuseau : une transaction proche minuit tombe le bon jour Maurice (déjà garanti par
  `transaction_date` + `resoudrePeriode`, aucune date « nue » comparée).

## 8. Hors périmètre (ne PAS faire ici)

- `GRAPHIQUES-PERIODE-DEDUP1` (jumelle sur `/graphiques`) — nécessite un arbitrage produit
  (vocabulaire des presets), ticket séparé.
- `TOOLBAR-PERIMETRE-AMPUTATION1`, horizon futur d'Échéances — non liés.
- Aucune modif de schéma/RLS/migration/Server Action (contrat backend inchangé).

## 9. Workflow Git (Human-in-the-Loop)

Branche `fix/tx-toolbar-dedup` depuis `main` à jour. Commits **par unité logique** (jamais
`git add -A`) : (1) retrait bornes in-page + type + toolbar ; (2) injection période adapter+page+key ;
(3) matrice `plageDates` + retrait exemption CI + tests. **Cross-review par contexte frais**
(subagent indépendant / `/review`) avant de proposer. **Push la branche, STOP à la PR poussée** —
c'est du code **applicatif** : Etienne valide (Visual QA + devise/fuseau) et merge. Ne pas ouvrir la
PR, ne pas merger.
