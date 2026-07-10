# PLAN — Chantier A : batch UI dashboard/transactions/règles (feedback 0709)

- **Branche** : `fix/feedback-0709-ui-batch` (worktree `.worktrees/ui-batch`, depuis `main`)
- **Source** : `docs/specs/FEEDBACK-retours-etienne-2026-07-09.md` (items 1, 2, 6, 10, 12 + catégorie visible + vérif manager)
- **IDs TODOS** : FB0709-DASHBOARD-DEVISES1, FB0709-TOPVENDORS5, FB0709-TX-CATEGORIE-VISIBLE1, FB0709-TX-DESCRIPTION1, FB0709-REGLES-PRIORITE-AIDE1, FB0709-SYNC-HEURE-MU1, FB0709-SYNC-MANAGER1
- **Statut grounding** : fait (2026-07-09) sur le code de `main`, refs ci-dessous.

## A1 — FB0709-TOPVENDORS5 : Top contreparties = top 5 + câbler la période

**Bug confirmé** : `vendorsParConcentration(tx, { direction, topN })`
(`src/server/repositories/insights.ts:180-183`) n'accepte **pas** de bornes de
période — il agrège TOUTES les transactions. La page
(`src/app/(workspace)/(dashboard)/page.tsx:103-106`) résout pourtant
`resoudrePeriode(periode)` → `{from, to}` et les passe à `cashflowParDevise`
mais PAS aux vendors. D'où « le sélecteur 1/3/6 mois ne change jamais la carte ».

Modifs :
1. `insights.ts` : ajouter `from?/to?` (dates comptables, mêmes types que
   `cashflowParDevise`) à `vendorsParConcentration` ; filtre SQL sur
   `transaction_date` (paramètres liés, borne posée en date comptable Maurice —
   les bornes viennent de `resoudrePeriode` déjà calées `Indian/Mauritius`).
2. `page.tsx` : passer `{ from: fromFlux, to }` à l'appel vendors.
3. Top 5 : `VENDORS_TOP_N_DEFAUT` (`src/lib/insights-schema.ts:21-22`, valeur
   actuelle 10) → **5**. Vérifier qu'aucun autre appelant ne dépend du 10.
4. Titre/sous-titre de `top-vendors-card.tsx` : refléter la période affichée
   (le libellé de période existe déjà côté page).

Tests : cas repo avec transactions dans/hors période (fixtures non-DB si la
suite existante le permet, sinon test du composeur de conditions) ; cas topN=5.

## A2 — FB0709-DASHBOARD-DEVISES1 : harmoniser devises/montants/dates

**Constat grounding** : les composants dashboard inspectés passent déjà par
`formatMontant`/`formaterDateComptable` (`connected-accounts-card.tsx:91`,
`transactions-table.tsx:15,73`, `top-vendors-card.tsx:26,126`). Le « mélange de
formes » vu par Etienne vient donc probablement : (a) des composants NON
inspectés (`soldes-devises-row.tsx`, `cash-flow-summary.tsx`, `flux-*.tsx`,
KPI), (b) du repli code ISO suffixe pour devise inconnue vs préfixe symbole,
(c) d'écrans voisins (/banques, /transactions) visuellement contigus.

Modifs :
1. **Audit exhaustif** (grep `Intl.NumberFormat|toLocaleString|toFixed|"MUR"|"USD"|"EUR"`
   sur `src/components/**` et `src/app/(workspace)/**`) ; lister chaque
   rendu de montant/date hors `format-montant.ts`/`format-date.ts`.
2. Basculer chaque divergence sur la source unique (règle 8 : formatage sur
   chaîne décimale, préfixe symbolique + espace fine insécable, virgule
   décimale, U+2212).
3. Si le « mélange » vient du repli ISO : uniformiser le repli (décision :
   garder le repli documenté, mais vérifier que MUR/USD/EUR passent tous par
   le symbole).

Pas de changement de `format-montant.ts` lui-même sauf bug avéré.

## A3 — FB0709-TX-CATEGORIE-VISIBLE1 : afficher le NOM de la catégorie

La table dashboard affiche déjà `categorieFr(t.primaryCategory)`
(`transactions-table.tsx:64-65`). Le libellé « 1 catégorie » est sur la page
**/transactions** (ligne de transaction ventilée, composants
`src/components/transactions/`). Modif : remplacer le compteur par le nom de la
catégorie (mono-catégorie → nom ; multi-ventilation → « Nom + n autres » ou
liste tronquée — libellés tronquables, jamais les montants). Localiser par grep
`catégorie` dans `src/components/transactions/`.

## A4 — FB0709-TX-DESCRIPTION1 : description plus grosse (bold) dans le détail

Vue détail transaction sur /transactions (dialog/sheet au clic). Modif CSS
uniquement : description en taille supérieure + `font-semibold`/`font-bold`,
tokens sémantiques (`text-*`), pas de couleur en dur.

## A5 — FB0709-REGLES-PRIORITE-AIDE1 : expliquer l'ordre de priorité

Page `src/app/(workspace)/regles/page.tsx` ; `priority = index` posé par
`reordonnerReglesAction` (`actions.ts:109-111`), matching serveur en priorité
croissante (première règle qui matche gagne). Modif : texte explicatif dans
`ReglesFeature` au-dessus de la liste (ex. « Les règles s'appliquent de haut en
bas : la première qui correspond catégorise la transaction. Réordonnez par
glisser/boutons. ») + hint visuel sur le numéro d'ordre. `text-muted`, pas de
nouveau composant.

## A6 — FB0709-SYNC-HEURE-MU1 : heure précise du dernier sync (Maurice)

`formaterFraicheurRelative` (`src/lib/format-date.ts:203-228`) retourne DÉJÀ
`horodatageAbsolu` en `Indian/Mauritius` (« 12/06/2026 12:00 ») — mais il n'est
visible qu'en tooltip (`balance-freshness-pill.tsx:52-58`). Modif : afficher
l'horodatage absolu en clair à côté de la fraîcheur relative (pill ou légende
sous le solde), format `format-date.ts` uniquement. La pastille
success/warning/danger existante ne change pas.

## A7 — FB0709-SYNC-MANAGER1 : vérification MANAGER (test seulement)

`tests/isolation/widget-orchestration-isolation.test.ts` couvre VIEWER (rejet,
:528-534) et ADMIN (succès, :449-467) mais PAS MANAGER. La garde
`peutModifier` (`widget-runtime.ts:73`) autorise MANAGER. Modif : ajouter le
cas « MANAGER peut synchroniser » au test (miroir du cas ADMIN). Aucun code
applicatif. NB : ce test est DB-dépendant → non exécutable en sandbox ; il sera
vérifié par lecture en revue + CI d'Etienne.

## Exit criteria (règle 3 / gates)

- Aucune nouvelle route/Server Action → pas de nouvelle surface authz ; les
  modifs repo (A1) restent sous `withWorkspace`, paramètres liés.
- Gates sandbox : `lint`, `tsc --noEmit`, `next build`, `vitest` (suites non-DB).
- Revue contradictoire par subagent à contexte frais (règle 6).
- Visual QA Gate 4 (états dashboard, /transactions, /regles) = **Etienne** avant merge.
- Commit(s) locaux sur la branche ; **pas de push depuis la sandbox** (proxy).

## Hors périmètre

Sous-catégories (FYGR) → `PLAN-sous-categories.md` (P2). Recherche → chantier D.
Sélecteur comptes /transactions → chantier C.
