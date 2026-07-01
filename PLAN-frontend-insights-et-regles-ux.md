# PLAN — Front : câblage Insights (Voie A) au dashboard + refonte UX du formulaire de règles

> Phase : **conception** (règle 1). Aucune ligne de code applicatif avant validation humaine.
> Date : 2026-06-24 · Branche cible : nouvelle `feature/*` depuis `main` à jour.
> Référence backend : `PLAN-tech-api-insights.md` (Voie A livrée, PR #114). Ce plan couvre
> la **surface front non encore livrée** (§2.5 du plan insights) + 2 correctifs dashboard.

## 0. État réel constaté (corrige la formulation initiale)

- **Le dashboard n'est PAS cassé.** `(workspace)/(dashboard)/page.tsx` consomme déjà
  `dashboard.ts` et affiche courbe + synthèse + tendance + table.
- **La Voie A (`src/server/repositories/insights.ts`) est livrée et mergée mais branchée
  à RIEN** : `cashflowParDevise` et `vendorsParConcentration` n'ont aucun consommateur.
- Décisions produit validées par l'utilisateur (2026-06-24) : faire les **3** sous-chantiers
  dashboard + refonte **ergonomique** (pas visuelle complète) du formulaire de règles.

---

## Chantier 1 — Dashboard : consommer la Voie A

### 1A. Corriger la synthèse du mois (mono-devise cassé → multi-devise)

**Problème** : `syntheseMois` est `@deprecated` — elle somme `amount` SANS `GROUP BY currency`,
donc additionne MUR + USD et l'UI affiche le total dans `base_currency` (faux). Le remplaçant
`syntheseMoisParDevise` (une ligne par devise) existe déjà dans `dashboard.ts`.

**Fichiers touchés**
- `(workspace)/(dashboard)/page.tsx` : remplacer l'appel `syntheseMois(tx, mois)` par
  `syntheseMoisParDevise(tx, mois)` dans le `Promise.all` (même `withWorkspace`).
- `components/dashboard/dashboard-content.tsx` : type de prop `syntheseMois: SyntheseMois`
  → `synthesesMois: SyntheseMoisDevise[]`. Propager aux deux consommateurs.
- `components/dashboard/cash-flow-summary.tsx` : accepter `SyntheseMoisDevise[]` ;
  rendre **un bloc Entrées/Sorties/Variation par devise** (pile égalitaire, virgules
  décimales alignées — convention multi-devise CLAUDE.md §formatage). Mois sans transaction
  → repli `[{currency: base, 0, 0, 0}]` pour garder l'affichage `Rs 0,00`.
- `components/dashboard/side-panel-kpi.tsx` : consomme aussi `syntheseMois` (carte
  « Détails ») → même bascule vers la liste par devise.

**Garde-fous** : zéro recalcul JS (montants = chaînes), `formatMontant` only, aucune
addition cross-devise. Tokens `inflow`/`outflow` inchangés.

### 1B. Migrer la courbe vers un flux de trésorerie (cashflowParDevise)

**Problème** : `CashflowMainChart` consomme `courbeTresorerie`, basée sur `balance_history`
qui est **VIDE en Staging** (Omni-FI n'expose pas l'historique des soldes — DASH-SOLDE2) →
courbe perpétuellement « en cours de synchronisation ». On a en revanche les **flux**
(transactions). On bascule donc la courbe sur `cashflowParDevise` (entrées/sorties/net
dérivés de `transactions_cache`).

> ⚠️ **Changement de sémantique assumé** : on passe d'un **solde EOD consolidé** (niveau)
> à un **flux net par période** (variation). Ce n'est PAS la même grandeur. Conséquences :
> - Le titre/sous-titre de la carte changent (« Position de trésorerie / Solde consolidé »
>   → p.ex. « Flux de trésorerie / Entrées − sorties par mois »).
> - On affiche le **net** par bucket (et idéalement entrées/sorties en appoint).
> - **Multi-devise** : `cashflowParDevise` renvoie une ligne **par (bucket, devise)**, alors
>   que la courbe actuelle est mono-série. Au MVP mono-devise on filtre/affiche la
>   `base_currency` (1 série) ; le multi-série est une dette explicite (voir §Dettes).

**Décision de granularité** : `granularite: "mois"` sur la fenêtre des N derniers mois
(cohérent avec la tendance existante) — une courbe journalière de flux serait bruitée et
redondante avec la table. (À confirmer ; défaut retenu = mois.)

**Fichiers touchés**
- `(workspace)/(dashboard)/page.tsx` : ajouter `cashflowParDevise(tx, {granularite:"mois",
  from, to})` au `Promise.all` ; retirer (ou conserver en filet, voir §Dettes) `courbeTresorerie`.
- `components/dashboard/cashflow-main-chart.tsx` : nouvelle forme de points
  (`PointCashflow` : `{bucket, currency, entrees, sorties, net, …}`). Adapter :
  - axe X = `bucket` (formaté via `format-date`, jamais de parsing maison),
  - série = `net` (chaîne → géométrie via le `valeurGeo` existant, cul-de-sac float),
  - tooltip = entrées / sorties / net formatés `formatMontant`,
  - **ligne de zéro** visible (le net peut être négatif — la courbe de solde ne l'était
    jamais), aire `inflow`/`outflow` selon le signe (ou neutre `primary` si on garde sobre).
  - État vide : message adapté (« aucun flux sur la période » au lieu de « historique en
    cours de synchronisation »).
- Filtrer sur `base_currency` côté page (ou composant) pour rester mono-série au MVP.

### 1C. Nouveau panneau « Top contreparties » (vendorsParConcentration)

**Donnée réellement neuve.** Concentration des plus gros postes (par défaut **dépenses**,
`direction:"outflow"`), top N borné, `part` = fraction du total de la devise.

**Fichiers touchés / créés**
- `(workspace)/(dashboard)/page.tsx` : ajouter `vendorsParConcentration(tx,
  {direction:"outflow", topN: VENDORS_TOP_N_DEFAUT})` au `Promise.all`.
- **Créer** `components/dashboard/top-vendors-card.tsx` (présentationnel PUR) :
  - liste des contreparties : libellé + montant (`formatMontant`) + barre de `part`
    (largeur = `part`, couleur `outflow`/`inflow` selon direction),
  - groupé/étiqueté par devise si plusieurs devises présentes (jamais d'addition cross-devise),
  - réutilise `StateCard` + primitives existantes (zéro carte ad-hoc),
  - état vide (« pas encore de contreparties ») via les primitives `states/`.
- `components/dashboard/dashboard-content.tsx` : nouvelle prop `topVendors:
  ConcentrationVendors`, monter `<TopVendorsCard>` dans la colonne principale
  (sous `CashFlowSummary`, au-dessus de la table — emplacement à confirmer).
- `lib/etat-dashboard.ts` : vérifier que l'ajout de vendors n'altère pas la logique
  `vide/partiel/complet` (les vendors suivent le sort des transactions ; pas de nouvel état).

### Architecture commune au chantier 1 (non négociable)

- **UN SEUL `withWorkspace`** : tous les nouveaux services entrent dans le `Promise.all`
  existant (perf + une seule revalidation de membership + RLS appliquée une fois). Ne PAS
  ouvrir une 2e transaction.
- **Devise de base** déjà résolue dans la page → réutilisée pour filtrer cashflow/synthèse.
- Aucune Server Action nouvelle nécessaire (la page est un RSC qui appelle les repositories
  directement, comme l'existant). Pas de nouvelle surface HTTP → pas de nouveau cas isolation
  IDOR (lectures déjà scopées RLS + jointure `bank_accounts` ENTITY-READ-JOIN1 dans `insights.ts`).

### Visual QA chantier 1 (Gate 4)
- Route démo `src/app/demo/dashboard-states/` : ajouter des fixtures pour la courbe de flux
  (avec net négatif), la synthèse multi-devise (MUR+USD) et le panneau vendors.
- Captures headless (gstack `/browse`) des états : complet, partiel (vendors/courbe vides),
  multi-devise. Comparaison vision ↔ `docs/UI_GUIDELINES.md` (couleurs sémantiques,
  `tabular-nums`, alignement virgules, focus).

---

## Chantier 2 — Refonte UX du formulaire de règles (`regle-form.tsx`)

**Périmètre validé** : *messages d'erreur + feedback*. **Le câblage serveur est déjà bon** —
`ReglesFeature` affiche déjà un bandeau `role=alert` (codes S2 mappés). Le défaut est
**localisé à `regle-form.tsx`** : `peutSoumettre` grise le bouton et `soumettre()` fait un
`return` muet → l'utilisateur ne sait pas pourquoi.

**Comportement cible** (demande explicite utilisateur) :
- Le bouton « Créer la règle » **reste cliquable** (plus de désactivation pour cause de
  champ manquant ; on garde seulement `disabled` pendant `enCours` = appel serveur).
- Au clic avec champ(s) invalide(s) : **ne pas soumettre**, marquer les champs en faute et
  afficher un **message rouge sous le champ concerné** :
  - catégorie vide → « Veuillez choisir une catégorie » (sous le `<select>` catégorie),
  - motif vide → « Saisissez un motif de libellé » (sous l'`<input>` motif).
- Effacer l'erreur d'un champ dès qu'il devient valide (onChange) — pas d'erreur fantôme.
- Soumission valide → `onCreer(...)` inchangé ; le conteneur gère succès/erreur serveur.

**Fichiers touchés**
- `components/regles/regle-form.tsx` (cœur du chantier) :
  - état d'erreurs locales `{ pattern?: string; categoryId?: string }` + `aTente` (submit attempted).
  - retirer `categoryId !== "" && motifValide` du `disabled` du bouton (garder `enCours`).
  - `soumettre()` : calcule les erreurs ; si présentes → `setErreurs`, focus le 1er champ
    fautif, `return` (mais **plus muet** : les messages s'affichent).
  - messages : `<p class="text-sm text-danger" role="alert">` sous chaque champ + bordure
    `border-danger` + `aria-invalid` + `aria-describedby` sur l'input/select (a11y).
  - aucune couleur en dur (token `danger`), `cn` local conservé, zéro dépendance externe.
- (Optionnel, si l'utilisateur le souhaite) micro-ajustement de la disposition pour aérer —
  **mais** rester dans le périmètre « ergonomie », pas de refonte visuelle. Le `flex-wrap`
  actuel est sur un **form** (pas un header) → autorisé par UI_GUIDELINES ; on le garde,
  on s'assure juste que les messages d'erreur ne cassent pas l'alignement `items-end`
  (passer le wrapper de champ en `flex-col` avec slot d'erreur réservé).

**Garde-fous** : la validation UI reste un **garde-fou ergonomique** ; la vérité reste zod
strict + FK côté serveur (inchangé). Pas de modif des Server Actions ni du contrat.

### Visual QA chantier 2 (Gate 4)
- Route démo `src/app/demo/category-states/` (ou la page `/regles` en local) : capturer
  le formulaire **vierge**, **après clic à vide** (2 messages rouges), **un champ corrigé**
  (1 message restant), **état `enCours`**. Vérifier focus visible + contraste `danger`.

---

## État de livraison

- **PR A — Dashboard insights : ✅ LIVRÉE** → https://github.com/EtienneOmnicane/tygr-app/pull/115
  (branche `feature/dashboard-insights-voie-a`, commits `c3d412a` + `1d26d6f`). 533/533 tests,
  lint/typecheck verts, Visual QA 3 états OK, cross-review contexte frais propre. En attente
  de merge humain.
- **PR B — UX formulaire règles : ✅ LIVRÉE** → https://github.com/EtienneOmnicane/tygr-app/pull/116
  (branche `feature/regles-form-validation-ux`, commit `d9612bd`). Validation cliquable +
  messages d'erreur inline + reset au succès (dette préexistante corrigée). 539/539, Visual
  QA 4 états OK (route démo `/demo/regle-form`), cross-review propre. En attente de merge humain.

## Séquencement proposé (PR séparées — revues indépendantes)

1. **PR A — Dashboard insights** (chantier 1, 1A+1B+1C ensemble car ils partagent
   `page.tsx` + `dashboard-content.tsx` ; les séparer multiplierait les conflits sur ces
   2 fichiers). Tests : adaptation `etat-dashboard` + fixtures démo.
2. **PR B — UX formulaire règles** (chantier 2, isolé, petit diff, faible risque).

> Indépendance : aucun fichier partagé entre A et B → parallélisables. Si l'utilisateur
> préfère une seule PR, faisable mais revue plus lourde.

## Quality Gates (rappel, bloquants)
- Règle 5 : `npm run lint && npm run typecheck` verts avant tout commit.
- Règle 4 : Visual QA des états modifiés vs UI_GUIDELINES.
- Règle 6 : cross-review par contexte frais (subagent/Codex) avant push.
- Règle 8 : montants = chaînes, `formatMontant` only, zéro float, zéro addition cross-devise.
- Règle 2/3 : pas de nouvelle surface non scopée ; lectures via `withWorkspace`.
- Human-in-the-Loop : STOP à la PR poussée (code applicatif → merge humain).

## Dettes à inscrire dans TODOS.md (règle 9) si différées
- **DASH-CASHFLOW-MULTISERIE** (P2) : la courbe de flux n'affiche qu'**une devise**
  (base_currency) ; `cashflowParDevise` renvoie multi-devise. Déclencheur : 1er workspace
  multi-devise actif en démo. Effort : ~moyen (courbe multi-série ou sélecteur de devise).
- **DASH-COURBE-SOLDE-EOD** (P2) : `courbeTresorerie`/`balance_history` redeviennent
  pertinents quand Omni-FI livrera `/balances/history` → réintroduire une vue « solde » à
  côté de la vue « flux ». Lien : DASH-SOLDE2, INSIGHTS-AMONT1. Décider si on garde
  `courbeTresorerie` en filet ou on la retire.
- **DASH-VENDORS-DIRECTION** (P2) : le panneau vendors est figé `outflow` ; un toggle
  inflow/outflow/both serait utile. Déclencheur : retour utilisateur. Effort : faible.

## Décisions verrouillées (utilisateur, 2026-06-24)
1. **Courbe** : RENOMMER → titre « Flux de trésorerie », sous-titre « Entrées − sorties
   par mois ». Ligne de zéro visible (net négatif possible).
2. **Granularité** : MENSUELLE (`granularite: "mois"`).
3. **PR** : DEUX PR séparées — PR A (chantier 1, dashboard insights), PR B (chantier 2,
   formulaire règles).
