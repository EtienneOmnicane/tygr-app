# Plan — Activation nav + Empty States transverses

**Branche** : `feat/activate-nav-empty-states` (depuis main `b618c5b`)
**Agent** : UI (frontière : `src/components` + rendu `src/app`). Ne touche ni schéma Zod, ni Server Actions, ni agrégation.
**Objectif** : rendre cliquables les onglets Graphiques / Échéances / Transactions sans 404, en créant leurs pages en Empty State, sur des primitives d'état promues au rang transverse.

## Contexte vérifié (état réel de main, 2026-06-17)

- `components/ui/` **n'existe pas**. Primitives dans `components/dashboard/states/primitives.tsx` (`StateCard`, `SkeletonBlock`, `StateIllustration`, `cn`).
- Le barrel `dashboard/states/index.ts` **ré-exporte** ces primitives (ligne 9) → des call-sites externes peuvent en dépendre. Risque d'import cassé au déplacement.
- `app-nav.tsx` (mergé PR #18) : Dashboard actif ; les 3 autres sont `placeholder: true` (rendus inertes, pas de lien mort). Routes `/graphiques`, `/echeances`, `/transactions` **inexistantes**.
- `loading.tsx` existants (mergés, NE PAS toucher) : `(dashboard)/loading.tsx`, `selection/loading.tsx`.
- `DashboardEmptyState` est **couplé au domaine** (CTA « Connecter une banque » → `/banques`) → non réutilisable tel quel pour des sections génériques.
- Garde RSC standard (cf. `banques/page.tsx`) : `exigerSessionWorkspace()` → catch `NonAuthentifieError` ⇒ `/login`, `AucunWorkspaceActifError` ⇒ `/selection`.

## Volet 1 — Promotion des primitives (refactor)

- Créer `src/components/ui/states/primitives.tsx` ; y **déplacer** `StateCard`, `SkeletonBlock`, `StateIllustration`, `cn` (markup et tokens identiques, zéro changement visuel).
- Créer `src/components/ui/states/index.ts` (barrel des primitives + futur `EmptyState`).
- `dashboard/states/primitives.tsx` : **supprimé**, remplacé par un ré-export depuis `@/components/ui/states` pour ne casser aucun import existant (compat). Les 3 composants `Dashboard…State` importent désormais depuis `@/components/ui/states`.
- `dashboard/states/index.ts` : continue de ré-exporter les primitives (via la nouvelle source) — surface publique inchangée pour les consommateurs actuels.
- **Décision à verrouiller (design/eng)** : garder le ré-export de compat (sûr, 2 barrels) VS migrer tous les call-sites et supprimer le ré-export (plus propre, plus de surface touchée). Proposition : **compat** d'abord (risque minimal), nettoyage différé en TODOS si besoin.

## Volet 2 — EmptyState générique + 3 pages

- `src/components/ui/states/empty-state.tsx` : `EmptyState` **générique** présentationnel pur :
  - props : `title: string`, `message: string`, `cta?: { label; href }` (optionnel — une section « à venir » peut n'avoir aucun CTA), `illustration?: "empty" | "error"` (défaut `empty`).
  - construit sur `StateCard` + `StateIllustration` + le `CLASSE_CTA` (lien `primary`, §2.3). UN seul CTA max (§4.4).
- 3 pages RSC dans `(workspace)` : `graphiques/page.tsx`, `echeances/page.tsx`, `transactions/page.tsx`.
  - même bloc de garde auth/workspace que `banques/page.tsx` (redirects identiques).
  - chacune monte `<EmptyState>` contextualisé : titre = nom de section, message = « Cette section arrive bientôt / sera alimentée par vos données dès l'epic … », **pas de CTA** (ou CTA neutre vers Dashboard) — à trancher en revue.
  - `metadata.title` par page.
  - **PAS de `loading.tsx`** pour ces 3 routes (directive explicite).

## Volet 3 — Activation nav

- `app-nav.tsx` : retirer `placeholder: true` des 3 items. Les routes existent ⇒ liens réels, soulignement `accent` actif via `usePathname`, `aria-current`, focus ring conservés. Supprimer la branche `if (item.placeholder)` si plus aucun item ne l'utilise (sinon la garder inerte).

## Clôture (hors revue de plan)

- Quality Gate : `lint` + `tsc --noEmit` + `build` verts (stop-loss règle 5).
- Visual QA headless : capturer les 3 pages (cookie de présence pour le proxy) + vérifier nav active par route, comparer §4.4/§6. `/qa`.
- Human-in-the-Loop : commit sur la branche, push si demandé, **STOP à la PR** (c'est l'humain qui ouvre/merge).

## Décisions design (plan-design-review, 2026-06-17)

Classification = **APP UI** (workspace data-dense). App UI rules + universal rules appliquées.

### D1 — Empty States différenciés (passe 2, validé)
Chaque page a SON glyphe outline + SA micro-copy orientée valeur. Pas de clone (anti-slop #10).

| Page | Glyphe outline (nouveau, dans StateIllustration) | Micro-copy (valeur à venir) |
|---|---|---|
| Graphiques | courbe / ligne ascendante | « Visualisez l'évolution de votre trésorerie sur 90 jours. Les graphiques s'afficheront dès que vos comptes seront synchronisés. » |
| Échéances | calendrier / échéancier | « Suivez vos paiements clients et fournisseurs à venir. Cette section s'activera avec vos premières échéances. » |
| Transactions | lignes de tableau | « Retrouvez et catégorisez toutes vos opérations bancaires. Vos transactions apparaîtront ici après la première synchronisation. » |

→ `StateIllustration` gagne 3 nouveaux `variant` (`chart` | `calendar` | `table`), SVG outline `currentColor`, même facture que `empty`/`error`.

### D2 — CTA optionnel orienté déblocage (passe 3, validé)
Le CTA pointe vers l'action qui REND la section utile : « Connecter une banque » → `/banques`, **uniquement si aucun compte connecté**. Si des comptes existent déjà (section juste pas encore dev), pas de CTA (message seul) — le CTA serait hors-sujet. Donc `EmptyState.cta` = **prop optionnelle**, le conteneur (page RSC) décide selon l'état réel des comptes.

### D3 — Dédup : générique seul + TODO P2 (passe 5, validé)
`EmptyState` générique livré pour les 3 pages. `DashboardEmptyState` (mergé, couplé /banques) **inchangé**. TODO P2 : « faire dériver DashboardEmptyState du EmptyState générique » (évite de toucher du code dashboard mergé/QA dans cette PR).

### Tableau d'états (passe 2 — fix to 10)

| Page | LOADING | EMPTY | ERROR | SUCCESS | PARTIEL |
|---|---|---|---|---|---|
| /graphiques | — (pas de loading.tsx, RSC instantané, pas de fetch) | Empty `chart` + micro-copy + CTA conditionnel | hérite error.tsx du groupe si la garde auth throw | N/A (section pas encore dev) | N/A |
| /echeances | idem | Empty `calendar` + micro-copy + CTA conditionnel | idem | N/A | N/A |
| /transactions | idem | Empty `table` + micro-copy + CTA conditionnel | idem | N/A | N/A |

Note : ces pages ne fetchent pas de données métier (coquilles) → pas d'état loading/partiel/succès propre aujourd'hui. Seuls EMPTY (le cœur) et ERROR (via la garde auth, mutualisée) existent.

### Responsive & a11y (passe 6 — fix to 10)
- `<main>` landmark sur chaque page (déjà le pattern de banques/page.tsx). `StateCard` porte le contenu ; titre en `<h1>` (page = première hiérarchie).
- Empty State centré : fonctionne tel quel <768px (le shell mergé gère la nav mobile / bottom-nav). Aucun layout spécifique requis — l'Empty est une carte fluide.
- CTA = lien `primary` (§2.3), focus-visible ring déjà câblé dans `CLASSE_CTA`. Touch target ≥44px (h via padding py-2 + texte 14px → OK).
- Contraste : `text-muted` (#667085) sur blanc = AA pour le message (≥4.5:1).

### Information architecture (passe 1 — 8/10, pas de blocage)
Hiérarchie par page : `<h1>` section → illustration → message → CTA. Une seule ancre (la carte Empty). Nav active (soulignement accent) répond à « où suis-je ? » (wayfinding).

## NOT in scope (différé, justifié)
- Refactor `DashboardEmptyState` → dérivé du générique : **TODO P2** (ne pas toucher code dashboard mergé ici).
- Contenu réel des 3 sections (graphiques, échéances, transactions) : épics dédiées ultérieures.
- `loading.tsx` pour les 3 routes : explicitement hors scope (directive) — coquilles sans fetch.
- Migration des call-sites du barrel `dashboard/states` : ré-export de compat suffit ; nettoyage différé si besoin.

## What already exists (à réutiliser)
- `docs/UI_GUIDELINES.md` §4.4 (Empty states) + DESIGN.md — source de vérité, calibrage.
- Primitives `StateCard` / `StateIllustration` / `SkeletonBlock` / `cn` (à promouvoir).
- Pattern `DashboardEmptyState` (modèle du markup : illustration + h2 + message + CTA lien `primary`).
- `app-nav.tsx` (nav header mergée, soulignement accent, usePathname).
- Garde auth/workspace RSC (`banques/page.tsx`) : à copier verbatim.

## Implementation Tasks
Synthétisées des findings de cette revue. Chaque tâche dérive d'un finding ci-dessus.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — ui/states/primitives — ajouter variants `chart`/`calendar`/`table` à StateIllustration (SVG outline currentColor)
  - Surfacé par : Passe 2 / D1 — Empty States différenciés (anti-slop), glyphe par section
  - Files : `src/components/ui/states/primitives.tsx`
  - Verify : rendu des 3 glyphes au Visual QA
- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — ui/states/empty-state — créer EmptyState générique (title/message/cta? optionnel/illustration)
  - Surfacé par : Passe 5 / D2 / D3 — composant Empty transverse, CTA prop optionnelle
  - Files : `src/components/ui/states/empty-state.tsx`, `src/components/ui/states/index.ts`
  - Verify : tsc + import depuis les 3 pages
- [ ] **T3 (P1, human: ~1h30 / CC: ~12min)** — app/(workspace) — 3 pages RSC avec garde auth + EmptyState contextualisé
  - Surfacé par : Plan volet 2 + D1 — micro-copy par section, CTA conditionnel
  - Files : `src/app/(workspace)/{graphiques,echeances,transactions}/page.tsx`
  - Verify : routes 200 (avec session), Empty rendu, redirect /login sans session
- [ ] **T4 (P1, human: ~15min / CC: ~3min)** — shell/app-nav — retirer flag placeholder des 3 items
  - Surfacé par : Plan volet 3 — onglets cliquables sans 404
  - Files : `src/components/shell/app-nav.tsx`
  - Verify : nav active par route, pas de 404
- [ ] **T5 (P3, human: ~5min / CC: ~2min)** — TODOS.md — consigner TODO P2 dédup DashboardEmptyState
  - Surfacé par : Passe 5 / D3 — dette DRY différée
  - Files : `TODOS.md`
  - Verify : entrée datée avec déclencheur

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 6/10 → 9/10, 3 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** DESIGN CLEARED (6→9/10, 3 décisions actées, 0 non résolue). Eng review requis avant ship (gate non franchi).

NO UNRESOLVED DECISIONS
