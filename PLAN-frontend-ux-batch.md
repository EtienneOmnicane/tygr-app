# Plan — Maxi-Sprint UX / Nouvelles Vues (branche `feat/frontend-ux-batch`)

> Phase : **conception** (CLAUDE.md règle 1). Worktree isolé `/Users/clawdy/Desktop/wt-frontend-ux-batch`.
> Périmètre RÉDUIT après audit des branches concurrentes (décision user 2026-06-22 :
> « ne faire que le neuf »). Voir mémoire `sprint-verifier-branches-concurrentes`.

## Contexte & périmètre

Briefing initial = 4 points. Audit `git branch -r` + `git worktree list` → **2 déjà
traités ailleurs** (branches non mergées, à merger séparément par l'humain) :

| Pt | Demande | Statut réel | Action |
|----|---------|-------------|--------|
| P1 | Sélecteur comptes en `optgroup` (institution → comptes) | ❌ nulle part | **À FAIRE** |
| P2 | Picker catégories Escape/click-away + création inline | ✅ `fix/ux-categorie-flux` | **EXCLU** (doublon) |
| P3 | Page admin Moteur de règles (lister/créer/supprimer) | back livré #95, **UI nulle part** | **À FAIRE** (pas de mock) |
| P4 | Vue **mensuelle** Entrées/Sorties (dashboard) | carte mois-courant = `feat/ui-cash-in-out` ; **historique nulle part** | **À FAIRE** (historique multi-mois seulement) |

Décisions user (AskUserQuestion 2026-06-22) :
- P4 = **historique N derniers mois** (barres empilées + tableau), source **par devise mais mono affiché**.
- P3 = **page dédiée `/regles`** + lien nav.

## P1 — Sélecteur de comptes groupé par institution

**Problème** : `transactions-toolbar.tsx` rend un `<select>` plat où `c.nom =
institutionName ?? accountName` → « Bank One » répété N fois, comptes indistincts.

**Cible** : `<optgroup label="Bank One">` avec `<option>` = `accountName` à l'intérieur.

**Données** : la page `transactions/page.tsx` n'envoie aujourd'hui que `{ bankAccountId,
nom }`. Il faut enrichir `CompteFiltre` → `{ bankAccountId, accountName, institutionName }`.
`listerComptes` fournit déjà `institutionName` + `accountName` (vérifié).

**Fichiers** :
1. `src/components/transactions/types-transactions.ts` — *(non, `CompteFiltre` vit dans le toolbar)*.
   En réalité `CompteFiltre` est défini dans `transactions-toolbar.tsx` → l'étendre là.
2. `src/components/transactions/transactions-toolbar.tsx` :
   - `CompteFiltre = { bankAccountId: string; accountName: string; institutionName: string | null }`.
   - Grouper les comptes par `institutionName` (repli « Autres comptes » si null) **en
     préservant l'ordre d'arrivée** (pas de tri qui réordonnerait l'existant).
   - Rendre `<optgroup label={institution}>` → `<option>{accountName}</option>`.
   - Si une seule institution **et** un seul compte : le filtre reste masqué (`comptes.length > 1`).
   - Edge : un `accountName` vide/dupliqué → afficher l'`accountName` tel quel (pas de PII bancaire ; c'est un libellé de compte, pas un IBAN). Garder `key={bankAccountId}`.
3. `src/app/(workspace)/transactions/page.tsx` : `comptesFiltre` mappe désormais les 3
   champs (au lieu de `nom`). **La résolution `compteNom` de la table (adapter) ne change
   PAS** — elle reste `institutionName ?? accountName` via `nomParCompte`.

**Risque** : la table des transactions résout le nom de compte affiché via `nomParCompte`
(toujours `institutionName ?? accountName`). On ne touche QUE le filtre, pas la colonne.
Pas de régression sur l'affichage des lignes.

**Tests** : composant pur → couvert au Visual QA (pas de renderer React de test au projet,
choix tracé). Je vérifie en headless `/demo/transactions` si elle expose >1 institution,
sinon capture `/transactions` réelle.

## P3 — Page `/regles` (Moteur de règles)

**Back** : `src/app/(workspace)/regles/actions.ts` livré (#95). Surface utilisée :
- `listerReglesAction()` → `RegleDTO[]` (`{id, pattern, matchType, categoryId, isActive, priority}`).
- `creerRegleAction({pattern, matchType, categoryId, priority?})` → `ResultatAction<{ruleId}>`.
- `archiverRegleAction(ruleId)` → `ResultatAction` (« supprimer » = archiver, is_active=false ;
  cohérent append-only/gouvernance — JAMAIS de delete physique).
- `appliquerReglesAction()` → MANAGER/ADMIN seulement (bouton « Ré-analyser », gating `peutModifier`).
- Catégories pour le `<select>` cible : `listerCategoriesAction()`.

**Architecture** (calquée sur `/transactions` et `/admin/entites`) :
1. `src/app/(workspace)/regles/page.tsx` (RSC) :
   - `exigerSessionWorkspace` + mapping erreurs (/login, /selection) — pattern identique.
   - Charge `listerReglesAction()` + `listerCategoriesAction()` en parallèle.
   - Résout `role` via session pour gating (`peutModifier`).
   - Monte un conteneur client `<ReglesFeature>` avec data initiale + closures Server Actions.
   - `export const metadata = { title: "Règles — TYGR" }`.
2. `src/app/(workspace)/regles/loading.tsx` — skeleton natif (Suspense RSC), épouse la forme (liste).
3. `src/components/regles/` (nouveau domaine) :
   - `regles-feature.tsx` (client) : état liste + création + archivage + toasts d'erreur ;
     recharge via `listerReglesAction` après mutation. Gating : création/archivage/ré-analyse
     masqués/désactivés si `!peutModifier`.
   - `regle-form.tsx` (présentationnel) : champ motif + select matchType (Contient / Commence par)
     + select catégorie (réutilise la hiérarchie Nature/Sous-nature) + priorité (optionnel) + submit.
   - `regles-list.tsx` (présentationnel) : ligne par règle « Si libellé **contient** “X” → **Catégorie** »
     + badge actif/inactif + bouton Supprimer (archiver). État vide (EmptyState) si aucune règle.
   - `types-regles.ts` : contrat UI (`RegleUI`, `ActionsRegles`) — miroir des DTO, découple l'UI des actions.
   - `index.ts` barrel.
4. `src/components/shell/app-nav.tsx` : ajouter `{ label: "Règles", href: "/regles" }`.

**Mapping erreurs UI** (registre S2) : `INVALID_PARAMS`→« Vérifiez le motif et la catégorie » ;
`CATEGORY_NOT_FOUND`→« Catégorie introuvable » ; `RULE_NOT_FOUND`→« Règle introuvable » ;
`FORBIDDEN_ROLE`→« Réservé aux gestionnaires » ; défaut→message générique. Pas de catch-all muet.

**États (convention §6.5)** : loading (skeleton natif) / vide (EmptyState « Aucune règle, créez-en une »)
/ erreur (toast `danger` `role=alert`) / succès (liste rafraîchie). Démo states : optionnelle
(P2 backlog) — la page réelle suffit au Visual QA car pas de dépendance DB pour le rendu des états vides/erreur via props.

**Sécurité** : aucune nouvelle Server Action créée (réutilise l'existant gardé withWorkspace +
zod + RLS). La page ne touche jamais la DB en direct. `peutModifier` = défense en profondeur UI
(la vraie garde reste serveur).

## P4 — Historique mensuel Entrées/Sorties (dashboard)

**Manque** : la carte existante (`CashFlowSummary`, mois courant) ne montre QU'un mois.
Cible = **N derniers mois** (défaut 6) en tableau + barres empilées.

**Donnée — NOUVELLE requête serveur** (mon périmètre Back, gouvernance) :
- `src/server/repositories/dashboard.ts` : `historiqueMensuel(tx, { nbMois })` →
  `HistoriqueMois[]` où `HistoriqueMois = { libelleMois: "YYYY-MM"; parDevise:
  Array<{currency, entrees, sorties, variation}> }`.
- **UNE seule requête** (anti-N+1, PAS de boucle mois-par-mois) :
  `GROUP BY date_trunc('month', transaction_date), currency`, borne basse =
  1er du mois (courant − (nbMois−1)), borne haute exclusive = 1er du mois prochain.
  `transaction_date` est une colonne `date` **déjà dérivée Maurice à l'ingestion**
  (E20) → pas de re-conversion fuseau, je reste cohérent avec `syntheseMois`/`syntheseMoisParDevise`.
- Héritage scope entité par `innerJoin(bankAccounts)` (ENTITY-READ-JOIN1) — **obligatoire**,
  copié verbatim des 2 fonctions sœurs.
- Mois sans transaction → **ligne présente avec 0** (je génère la grille des N mois côté
  serveur via `generate_series` OU côté repo en complétant les trous — choix : compléter
  les trous en TS à partir d'un set de mois attendus, plus simple à tester, montants "0").
- Montants = **chaînes décimales** (règle 8), jamais de float.

**Affichage — composant présentationnel pur** :
- `src/components/dashboard/monthly-cashflow.tsx` : `MonthlyCashflow({ historique, devise })`.
  - Reçoit `HistoriqueMois[]` déjà agrégé, ne recalcule rien.
  - **Mono affiché** (décision user) : par mois, on prend la ligne de la **devise de base** ;
    s'il existe d'autres devises ce mois-là, badge discret « + autres devises » (pas d'addition
    cross-devise — règle 8). Cohérent avec la convention dashboard.
  - **Barres empilées** : par mois, barre entrée (inflow) au-dessus, sortie (outflow) en
    dessous (ou côte à côte), hauteur ∝ montant relatif au max de la fenêtre. SVG inline
    (zéro dépendance — Tremor pas confirmé installé ; je reste cohérent avec `cashflow-main-chart.tsx`
    → je vérifierai s'il utilise Tremor ou du SVG maison et m'aligne).
  - **Tableau** sous les barres : colonnes Mois / Entrées / Sorties / Variation, `tabular-nums`,
    montants via `formatMontant`, mois via `formaterMoisAnnee`. Signe explicite entrées/variation.
  - Couleurs : `inflow`/`outflow` (donnée), fonds doux, jamais de couleur en dur.
  - État vide : si tous les mois à 0 → message neutre « Pas encore de mouvement sur la période ».
- Branchement :
  - `src/app/(workspace)/(dashboard)/page.tsx` : ajouter `historiqueMensuel(tx, { nbMois: 6 })`
    DANS le `Promise.all` existant (même `withWorkspace`, pas de round-trip en plus). Passer
    `historiqueMensuel` à `DashboardContent`.
  - `src/components/dashboard/dashboard-content.tsx` : recevoir `historiqueMensuel`, monter
    `<MonthlyCashflow>` SOUS `<CashFlowSummary>` (mois courant) — les deux coexistent
    (carte = focus mois courant ; historique = tendance). ⚠️ `dashboard-content.tsx` est aussi
    touché par `feat/ui-cash-in-out` (carte mois-courant) → conflit potentiel au merge, mais
    sur des lignes différentes (j'ajoute, je ne réécris pas la carte). Documenté.

**Exit-criteria règle 3 (nouvelle lecture serveur)** :
- [ ] withWorkspace (héritée du bloc existant) + innerJoin bankAccounts (scope entité).
- [ ] Pas d'entrée client → `nbMois` est un littéral serveur (6), borné si jamais exposé plus tard.
- [ ] Montants chaînes décimales ; bornes de mois calculées en SQL (`date_trunc` + `interval`).
- [ ] Test isolation : ajouter un cas dans `tests/isolation/` (historique cross-workspace → 0 ligne
      de l'autre tenant ; scope entité respecté) **OU** test unitaire de la complétion des trous.
      → Décision : test unitaire de la **logique de complétion des mois** (déterministe, sans DB)
      + je m'appuie sur la suite isolation existante qui couvre déjà le pattern jointure des
      sœurs. Si le temps : cas isolation dédié.

## Ordre d'exécution

1. P1 (le plus contenu, 3 fichiers) → commit.
2. P4 requête serveur + composant + branchement → commit (+ test complétion mois).
3. P3 page /regles + composants + nav → commit.
4. Stop-loss global (`lint` + `typecheck` + `build`) à CHAQUE commit (hook + manuel).
5. Visual QA headless des écrans touchés.
6. Push + `gh pr create` → donner l'URL (préf user). STOP (Human-in-the-Loop : code applicatif).

## Hors périmètre (tracé)

- P2 (picker Escape/création) → `fix/ux-categorie-flux` (à merger séparément).
- Carte mois-courant cash in/out → `feat/ui-cash-in-out` (à merger séparément).
- Migration carte mois-courant vers `syntheseMoisParDevise` (dette multi-devise) → hors sprint.
- Route démo `/demo/regles-states` → backlog P2 (la page réelle suffit au QA des états).
