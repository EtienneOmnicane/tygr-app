# PLAN — Graphiques : Analyse par catégorie (camembert)

> Phase : **conception** (Règle 1). Aucune ligne de code applicatif avant ce
> fichier. Chantier lancé sous carte blanche ; l'humain fait le Visual QA + le
> merge (Human-in-the-Loop, PR `feat/` = applicative → pas d'auto-merge).
> Branche : `feat/graphiques-camembert` (depuis `main` à jour, `765eef3`).

## 1. Objectif

Remplacer la coquille EMPTY STATE de `src/app/(workspace)/graphiques/page.tsx`
par une vraie page d'**analyse par catégorie** : un **camembert (donut)** qui
répartit les mouvements par catégorie sur une période, avec le total au centre,
une légende classée (montant + part %), et des sélecteurs période / sens /
devise. Référence visuelle : les captures FYGR « Category analysis » fournies
par Etienne — MAIS adaptées aux contraintes maison (multi-devise, donut
secondaire, tokens sémantiques étanches).

## 2. Pushback (Règle 10) — la contrainte qui change le design : multi-devise

FYGR affiche **un seul** camembert avec **un total unique** au centre parce
que FYGR est mono-EUR. **TYGR ne peut pas** : `CLAUDE.md` (Localisation +
Règle 8) interdit **catégoriquement** toute addition cross-devise
(« jamais d'addition cross-devise », « aucune conversion FX d'affichage sans
taux annoté »). Un corporate mauricien tient couramment MUR + USD + EUR.

- **Risque concret** si on copie FYGR bêtement : additionner des Rs et des \$
  dans une même part de camembert → total au centre **faux et trompeur**
  (mode de défaillance : un décideur lit « 1 250 000 » sans savoir que c'est un
  mélange de devises). C'est exactement la dette que la règle interdit.
- **Alternative retenue (coût CC faible, coût humain nul)** : **un camembert
  par devise**, sélectionnable. La requête `GROUP BY currency` (comme
  `insights.ts` déjà en place) ; l'UI monte un sélecteur de devise (masqué si
  une seule devise a des données) ; le total au centre est **toujours
  mono-devise**, formaté via `format-montant.ts`. Aucune conversion FX.
- Décision : **tranchée ici**, cohérente avec `dashboard.ts` / `insights.ts`
  (mêmes invariants DASH-FX1). Pas de re-litige en implémentation.

Second point d'attention (UI_GUIDELINES §389, divergence FYGR assumée) :
« Donut disponible mais **jamais comme ancre d'écran** ; le donut est
secondaire ». On ne fait donc **pas** un cercle plein-écran héro comme FYGR.
Le donut est dimensionné modestement (~240–260 px) et **co-équen** avec la
légende classée : l'ancre de l'écran est **l'analyse** (le classement des
catégories + le total), le donut l'illustre. C'est aussi la vraie hiérarchie
FYGR (donut + liste classée côte à côte), juste sans l'emphase héro.

## 3. Source de données — décision : `primary_category` (Omni-FI natif)

Deux dimensions de catégorie existent dans la base :

| Option | Source | Pour | Contre |
|---|---|---|---|
| **A (retenue MVP)** | `transactions_cache.primary_category` (catégorie Omni-FI amont) | Auto-peuplée à l'ingestion → **données réelles fiables pour le Visual QA** ; devise + sens (`credit_debit`) sur la **même ligne** → `GROUP BY currency` propre, pas de jointure fragile ; sémantique = celle de FYGR (« category analysis ») ; `NULL` → tranche honnête « Non catégorisé » | Granularité amont non maîtrisée (libellés Omni-FI) |
| B (P2) | Ventilation manuelle `transaction_categorizations` (splits) → `categories` | Catégories métier TYGR, ventilation partielle possible | Les splits **ne portent ni devise ni sens** (ceux-ci vivent sur la transaction parente) → jointure + regroupement plus fragiles ; peu/pas de données en sandbox → donut vide au QA |

**Décision : Option A pour le MVP.** L'Option B (camembert basé sur la
ventilation manuelle) est notée **dette P2** (`ANALYSE-VENTILATION1`,
déclencheur : quand la catégorisation manuelle sera adoptée par les
utilisateurs). Ce n'est **pas** une dette d'isolation/append-only/montant →
consignation autorisée (Règle 9).

`primary_category` peut être `NULL` (ou `''`) : `nullif(primary_category,'')`
→ regroupé dans une part **« Non catégorisé »** rendue en **gris neutre**
(jamais une couleur catégorielle vive) et **toujours triée en dernier**.

## 4. Architecture (mirroir strict des patterns maison)

Le module **Insights** (`insights.ts` / `server/insights/types.ts` /
`lib/insights-schema.ts`) est le template EXACT : dérive de `transactions_cache`,
agrège en SQL, sort des chaînes décimales, `GROUP BY currency`, `innerJoin
bank_accounts` (ENTITY-READ-JOIN1). On **étend ce module** plutôt que de créer
un repository parallèle.

### 4.1 Repository — `repartitionParCategorie(tx, params)` (dans `insights.ts`)

```
params : { sens: "inflow" | "outflow"; from: "YYYY-MM-DD"; to: "YYYY-MM-DD" }
retour : RepartitionCategories (voir §5)
```

- Filtre de sens : littéral SQL **figé** (`credit_debit = 'Credit'` pour
  inflow, `'Debit'` pour outflow) — jamais l'entrée interpolée (garde
  anti-injection, comme `vendorsParConcentration`). Pas de `both` : un
  camembert mélangeant crédits et débits n'a pas de sens (signes opposés).
- `montant = sum(amount)::numeric(15,2)::text` (les montants sont stockés en
  **magnitude positive**, le signe est porté par `credit_debit` → pas d'`abs()`,
  cohérent avec `cashflowParDevise`).
- `part = (sum(amount) / nullif(sum(sum(amount)) over (partition by currency),0))`
  → chaîne, `coalesce(...,'0')` anti-DIV/0. **Part relative à la devise**,
  jamais cross-devise.
- Total & compteur par devise via **fenêtre** (`… over (partition by currency)`)
  → une seule requête, aucun calcul de montant en JS (Règle 8). Le JS ne fait
  que **regrouper** les lignes par devise, jamais d'arithmétique sur les
  montants.
- `WHERE is_removed = false` (tombstones exclus) + bornes `transaction_date`
  (`>= from`, `< to + 1 jour` → borne haute **inclusive**, comme insights).
- `innerJoin bank_accounts` (ENTITY-READ-JOIN1) : la RESTRICTIVE `entity_scope`
  n'est héritée par `transactions_cache` que par cette jointure. **Jamais** lire
  la table fille sans elle (sinon fuite intra-groupe, étage 2).
- Erreurs nommées : `InsightsParamsInvalidesError` (réutilisée) pour sens/dates
  hors bornes (défense en profondeur, en plus du zod amont).
- Tri SQL : `currency, sum(amount) desc, categorie`. « Non catégorisé » remis
  en dernier **en JS** (tri stable après regroupement).

### 4.2 Bornes de période Maurice — `lib/periode-analyse.ts` (nouveau, frontière)

Les presets (`mois-courant`, `30-jours`, `90-jours`, `12-mois`) → `{from,to}`
**calculés à Maurice** (E20). Helper pur `bornesPeriodeMaurice(preset,
maintenant?)` : part de `dateCouranteMaurice()` (déjà la date comptable
Maurice), puis **arithmétique calendaire en UTC** sur cette date « nue » (pas de
re-conversion de fuseau — la date est déjà à Maurice). `maintenant` injectable
(tests déterministes). Module `lib/` (importable client pour les libellés de
preset ; le serveur réutilise pour les bornes — dépendance lib→server jamais
l'inverse). Enum + libellés FR = **source unique**.

### 4.3 Server Action — `graphiques/actions.ts`

`analyserCategoriesAction(input:{ sens; periode })` :
`exigerSessionWorkspace()` → zod `safeParse` (INVALID_PARAMS sinon) → bornes via
`bornesPeriodeMaurice` (serveur, E20-correct) → `withWorkspace` →
`repartitionParCategorie`. Lecture → renvoie le DTO directement (pas
d'enveloppe `ResultatAction` pour la lecture, comme `listerEcheancesAction`) ;
erreurs de session remontées à l'error boundary RSC. Logs corrélés
(`workspace_id`, `code`) **sans PII** (jamais de libellé de catégorie brut si
c'était PII — ici primary_category n'est pas PII, mais on reste sobre).

### 4.4 UI — `components/graphiques/`

- `types-graphiques.ts` — contrat UI (`RepartitionCategoriesUI`, `…DeviseUI`,
  `PartCategorieUI`, `SensFluxUI`, `PeriodePreset`, `ActionsGraphiques`).
- `palette.ts` — tokens catégoriels + affectation **déterministe** (couleur
  stable par index de tranche ; « Non catégorisé » toujours neutre).
- `donut-categories.tsx` — **SVG pur** (aucune lib de graphe, Règle 9),
  arcs calculés à la main (géométrie via `Number()` = cul-de-sac float, jamais
  réinjecté dans un montant affiché — pattern `flux-chart-trace`). Total au
  centre via `formatMontant` + libellé sens. `role="img" aria-label`. Hover →
  surbrillance + montant/part de la tranche.
- `legende-categories.tsx` — table classée : pastille couleur + nom + montant
  (`tabular-nums`, aligné à droite, **jamais tronqué**) + part % + nb. Seuls les
  **noms** peuvent tronquer.
- `graphiques-feature.tsx` — conteneur CLIENT : sélecteurs période/sens/devise
  (segmented `role=tablist`), recharge via actions injectées, gère les 4 états.
- `index.ts` — barrel.

### 4.5 Page RSC — `graphiques/page.tsx` (remplace le placeholder)

Auth (redirects login/selection) → `listerComptes` (pour l'empty-state
« aucune banque ») → fetch initial (`sens=outflow`, `periode=mois-courant`) →
map DTO→UI → monte `GraphiquesFeature` avec closures `"use server"`. Lecture
ouverte à tous les membres (VIEWER inclus) : l'analyse est en lecture seule, pas
de gating d'écriture.

### 4.6 Demo route — `src/app/demo/graphiques-states/`

États hors auth/DB pour capture headless (Gate 4), comme
`demo/echeances-states`. Hors production.

## 5. Contrat de données

```ts
type SensFlux = "inflow" | "outflow";
type PeriodePreset = "mois-courant" | "30-jours" | "90-jours" | "12-mois";

interface PartCategorie {
  categorie: string;          // primary_category ; "Non catégorisé" si NULL/''
  estNonCategorise: boolean;  // → rendu gris neutre, trié en dernier
  montant: string;            // sum(amount) — chaîne décimale
  part: string;               // fraction 0..1 du total de la devise — chaîne
  nbTransactions: number;
}
interface RepartitionDevise {
  currency: string;
  total: string;              // total mono-devise (centre du donut) — chaîne
  nbTransactions: number;
  parts: PartCategorie[];     // triées montant desc ; Non catégorisé en fin
}
interface RepartitionCategories {
  sens: SensFlux; from: string; to: string;
  devises: RepartitionDevise[]; // 1 entrée / devise — JAMAIS d'addition cross-devise
}
```

## 6. Palette catégorielle (extension design system)

UI_GUIDELINES ne définit qu'**un** token donut (`#5BA8D9`, « séries neutres
d'analyse »). Un camembert multi-catégories a besoin d'un **jeu catégoriel**.
On ajoute une palette `chart-cat-*` (analytique, **non-sémantique** : évite
`inflow` vert et `outflow` rouge réservés à la donnée signée) + un neutre pour
« Non catégorisé ». Ajout **dans les deux** sources (`globals.css` +
UI_GUIDELINES.md « toute divergence se corrige là-bas d'abord »). Palette
harmonisée Dodo (lagoon / indigo / accent ambre / teal / orchidée / ardoise),
contrastes AA, distinguable ; « Non catégorisé » = gris chaud neutre.

## 7. États (convention §6.5)

- **loading** : `loading.tsx` natif (Suspense RSC pendant le fetch initial),
  skeleton neutre épousant la forme (cercle + lignes de légende), aucune
  couleur sémantique.
- **empty (aucune banque)** : `EmptyState illustration="chart"` + CTA
  « Connecter une banque » (D2, seulement si aucun compte).
- **empty (aucune donnée sur la période/sens/devise)** : message sobre
  `text-muted` (« Aucun mouvement sur cette période »), pas de donut vide.
- **error** : bandeau `role=alert` `bg-danger-bg` + icône (jamais un rouge sec).

## 8. Exit-criteria (Règle 3) — livrés dans ce PR

- [ ] Authz via `withWorkspace` ; jamais `workspace_id` en paramètre client ;
      ressource hors tenant → invisible (RLS), pas d'oracle.
- [ ] Zod strict (enum sens/preset fermées, dates calendaires) ; rejet nommé
      INVALID_PARAMS.
- [ ] Injection : sens/preset mappés vers des littéraux SQL figés ; dates en
      paramètres liés ; aucune valeur d'entrée interpolée.
- [ ] IDOR : cas ajouté à la suite isolation
      (`repartition-categorie-isolation.test.ts`) — un WS ne voit jamais les
      catégories d'un autre ; agrégat par devise ; tombstone exclu ; Non
      catégorisé ; part relative à la devise.
- [ ] Erreurs nommées → codes machine → messages UI mappés.
- [ ] Montants : agrégés en SQL, chaînes décimales, `format-montant.ts` à
      l'affichage ; **jamais de float** ; **jamais d'addition cross-devise**.
- [ ] Fuseau : bornes de période via `dateCouranteMaurice` (E20).
- [ ] 4 états + demo route pour Visual QA.
- [ ] `tsc --noEmit` + `eslint` verts (les tests vitest/PGlite tournent sur le
      Mac via husky — non exécutables en sandbox).

## 9. Ce qui n'est PAS fait (scope tenu, dette notée)

- Bar chart FYGR (comparaison période/période) : **hors scope** ce PR (le
  dashboard couvre déjà entrées/sorties par période). Notable P2 si demandé.
- Rapports custom à formule FYGR : hors scope (chantier distinct).
- Camembert sur ventilation manuelle : dette **P2 `ANALYSE-VENTILATION1`**.
- Export/drill-down par catégorie vers `/transactions` filtré : P2 (amélioration
  ergonomique, pas bloquant).
