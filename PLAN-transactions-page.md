# Plan — Page `/transactions` (liste réelle + injection SplitAllocationModal)

> **Phase** : conception (règle 1). Aucune ligne de code applicatif tant que ce
> plan + la frontière Backend ne sont pas validés. Auteur : Agent UI.
> **Branche cible** (à créer depuis `main` à jour) : `feat/transactions-list`.
> **Date** : 2026-06-17.

## 0. Intention

Remplacer la coquille Empty State de `(workspace)/transactions/page.tsx` par la
**vraie liste des opérations** : un tableau dense, scrollable, où chaque ligne
porte son badge de catégorie (ventilation) et **ouvre la SplitAllocationModal au
clic**. C'est l'écran qui met enfin la modale (mergée PR #44) en production.

C'est l'écran le plus dense de l'app après le dashboard. Objectif UX
(UI_GUIDELINES) : **clarté financière en 3 secondes** — sens (entrée/sortie) lisible
à l'œil, montants `tabular-nums` alignés à droite, état de catégorisation évident.

## 1. Frontière de données — ce que le Backend doit livrer (liste de courses)

> Gouvernance (mémoire `gouvernance-frontiere-ui`) : je suis l'Agent UI. Je ne crée
> NI repository, NI Server Action, NI schéma Zod. Je conçois l'UI contre un contrat
> de types (`types-transactions.ts`) et je liste ici, précisément, ce que Backend
> doit implémenter. Pattern éprouvé sur la modale (le contrat a tenu à la livraison).

État des lieux (audit 2026-06-17, lecture seule) :
- `transactions_cache` porte tout le nécessaire : `omnifiTxnId`, `transactionDate`
  (date Maurice, E20), `amount` (numeric 15,2), `currency`, `creditDebit`,
  `cleanLabel`, `bankLabelRaw`, `primaryCategory`/`subCategory` (catégories **OBIE
  auto**, ≠ ventilation manuelle), `bankAccountId`, `isRemoved`. Index
  `(workspace_id, transaction_date desc)` déjà en place.
- `transactionsRecentes(tx, limite=8)` lit les 8 dernières, **sans pagination, sans
  filtre, sans jointure splits**. Insuffisant pour une page liste.
- Catégorisation : `listerSplits`, `remplacerSplits`, `listerCategories` (+ Server
  Actions) déjà livrés et mergés (PR #44).

### À LIVRER côté serveur (3 manques)

**(B1) Lecture paginée `listerTransactions`** — repository `dashboard.ts` ou nouveau
`transactions.ts`. Pagination par **curseur** (pas OFFSET : la table grossit, et
l'ordre `(transaction_date desc, booking_date_time desc, id)` est stable et indexé).
Filtre `isRemoved = false` toujours. Scopé workspace par la RLS (`withWorkspace`).

Signature visée (Backend tranche l'implémentation exacte) :
```
listerTransactions(tx, {
  curseur?: { transactionDate: string; bookingDateTime: string; id: string } | null,
  limite?: number,                 // défaut 50, max 100
  filtres?: {
    sens?: "Credit" | "Debit",     // optionnel
    bankAccountId?: string,        // optionnel — filtrer un compte
    statutCategorisation?: "non_categorise" | "partiel" | "complet", // optionnel
  },
}): Promise<{
  lignes: TransactionListItem[],
  curseurSuivant: { ... } | null,  // null = dernière page
}>
```

**(B2) Résumé de ventilation par ligne** — pour afficher le bon badge SANS faire
N+1 requêtes côté UI. La lecture doit rapporter, par transaction, soit l'agrégat
des splits manuels, soit assez pour décider l'état. Deux options, **Backend
choisit** (je documente le besoin, pas la solution) :
  - *Option éco* : un champ `statutCategorisation: "non_categorise" | "partiel" |
    "complet"` + `nbSplits: number` + (si nbSplits===1) le `categoryId`/`categoryName`
    de l'unique split pour afficher 1 badge. Au-delà de 1 split → badge générique
    « N catégories ».
  - *Option riche* : la liste complète des splits par ligne (`SplitUI[]`),
    l'UI agrège. Plus de payload, mais zéro aller-retour à l'ouverture de la modale.

  → **Recommandation UI** : Option éco pour la LISTE (badge résumé), et la modale
  charge le détail des splits à l'ouverture via `listerSplits` (déjà existant). Ça
  garde la liste légère et réutilise l'existant. Décision à confirmer avec Backend.

**(B3) Server Action `listerTransactionsAction`** — pont navigateur → repository,
dans `(workspace)/transactions/actions.ts`. Retourne le DTO + curseur. Mappe les
erreurs (registre S2). Catégorisation déjà ouverte à tous les membres (décision PO,
VIEWER inclus) ; la lecture l'est a fortiori.

### Contrat de types UI (je l'écris, c'est MON fichier)

`src/components/transactions/types-transactions.ts` (présentationnel, comme
`category/types.ts`) :
```
export interface TransactionListItem {
  transactionId: string;          // = id (clé composite avec date)
  transactionDate: string;        // YYYY-MM-DD Maurice
  label: string;                  // cleanLabel ?? bankLabelRaw (jamais brut nu en prod)
  montantAbs: string;             // |amount|, chaîne décimale (règle 8)
  devise: string;                 // currency
  sens: "Credit" | "Debit";
  bankAccountId: string;
  // résumé ventilation (B2, option éco) :
  statutCategorisation: "non_categorise" | "partiel" | "complet";
  categorie?: { id: string; name: string } | null; // si exactement 1 split
  nbCategories: number;           // 0, 1, ou N
}
export interface PageTransactions {
  lignes: TransactionListItem[];
  curseurSuivant: CurseurTransactions | null;
}
export interface ActionsTransactions {
  listerTransactions(args: { curseur?: CurseurTransactions | null; filtres?: FiltresTransactions }): Promise<ResultatAction<PageTransactions>>;
}
```

> ⚠️ PII bancaire (règle 8) : `bankLabelRaw` est un libellé bancaire brut. Il peut
> s'afficher (c'est la donnée de l'utilisateur, dans SON workspace, derrière auth)
> mais ne doit JAMAIS partir en télémétrie/log/message d'erreur. Préférer
> `cleanLabel` quand présent. La démo n'utilise QUE des libellés fictifs.

## 2. Arborescence des fichiers (ce que JE crée — UI pur)

```
src/components/transactions/
├── types-transactions.ts          # contrat UI↔Backend (liste de courses B1-B3)
├── transactions-table.tsx         # tableau dense présentationnel (§2.2)
├── transaction-row.tsx            # une ligne (sens, montant, badge, clic→modale)
├── transactions-toolbar.tsx       # filtres (sens, compte, statut catégo) — pills surface-inset
├── transactions-feature.tsx       # conteneur "use client" : état, pagination, monte la modale
├── states/
│   ├── transactions-loading.tsx   # skeleton épousant la forme du tableau
│   ├── transactions-empty.tsx     # aucune transaction (≠ aucune banque)
│   └── transactions-error.tsx     # échec de lecture, onRetry
└── index.ts                       # barrel

src/app/(workspace)/transactions/
├── page.tsx        # RSC : auth + 1re page server-side, passe au feature client
├── loading.tsx     # NOUVEAU — Suspense natif pendant le fetch RSC initial
└── actions.ts      # (Backend ajoute listerTransactionsAction ici)

src/app/demo/transactions/
└── page.tsx        # Visual QA hors auth/DB — données fictives, actions stub
```

**Pourquoi conteneur client + page RSC** (convention CLAUDE.md « états d'affichage ») :
- La **1re page** se charge en RSC (server-side, rapide, `loading.tsx` natif gère
  l'attente Suspense). On passe le résultat initial au `transactions-feature` client.
- La **pagination, les filtres, le ré-essai** sont pilotés CLIENT (on charge la page
  suivante sans recharger la route, on filtre sans navigation) → composants
  `<…State/>` présentationnels + Server Action appelée depuis le client.
  C'est exactement le double mécanisme documenté (loading.tsx natif POUR le RSC ;
  composants State POUR le client).

## 3. Le tableau dense (UI_GUIDELINES §2.2 — non négociable)

Colonnes (de gauche à droite) :
| Col | Contenu | Alignement | Largeur |
|-----|---------|-----------|---------|
| Date | `transactionDate` formatée « 11 juin » | gauche | ~90px |
| Libellé | `label` (cleanLabel) + nom du compte en sous-texte `text-muted` | gauche | flex-1 |
| Catégorie | `CategoryBadge` (size="sm") OU pastille « Non catégorisé » `text-muted` OU « N catégories » | gauche | ~180px |
| Montant | `formatMontant(montantAbs, devise, {signeExplicite})` — **vert si Credit, rouge si Debit** | **droite** | ~140px |

Tokens stricts (§2.2 / §3) :
- Cellules `py-[14px] px-4` (16px), hauteur de ligne ~44px, séparateur `border-line`
  1px entre lignes. **PAS de zébrage.**
- Hover de ligne : `hover:bg-surface-inset` (cible cliquable claire), `cursor-pointer`,
  `transition-colors`. Toute la ligne est cliquable → ouvre la modale.
- Montants : Geist `tabular-nums`, alignés à droite. **Vert (`inflow`/`text-inflow`)
  pour Credit, rouge (`outflow`) pour Debit** — c'est de la donnée financière, donc
  la couleur sémantique est LÉGITIME ici (≠ le badge catégorie qui, lui, n'a jamais
  de vert/rouge — cf. CategoryBadge).
- En-tête de colonnes : `text-[13px] text-muted`, sticky en haut du conteneur
  scrollable (`sticky top-0 bg-surface-card`), séparateur `line-strong` dessous.
- Accessibilité : `<table>` sémantique (thead/tbody/th/td). Ligne cliquable =
  `<tr role="button" tabIndex={0}>` + `onKeyDown` Enter/Espace (pas qu'un onClick
  souris). `aria-label` par ligne (« Beachcomber Resorts, 10 000 MUR entrée, 11 juin,
  non catégorisé — ouvrir la ventilation »).

### Clic → SplitAllocationModal
- Le conteneur garde `transactionActive: TransactionListItem | null`. Clic sur une
  ligne → set + ouvre la modale (déjà codée, PR #44).
- À l'ouverture, la modale a besoin de `initialSplits`. **On charge le détail via
  `listerSplits(ref)`** (existant) — la liste ne portait que le résumé (B2 option
  éco). Pendant ce chargement : la modale affiche son propre état (déjà géré ? à
  vérifier — sinon petit skeleton interne). Mapping `TransactionListItem` →
  prop `transaction` de la modale : `{transactionId, transactionDate, label,
  montantAbs, devise, sens}` — alignement DIRECT, pas de transformation.
- Au `Valider` → `remplacerSplitsAction` (atomique, existant). Au succès
  (`onSaved`) : le conteneur **rafraîchit la ligne concernée** (re-fetch léger ou
  maj optimiste du résumé). Pas de full reload.

## 4. États (les 4, checklist §6.5)

1. **Loading** : `loading.tsx` natif (RSC initial) + `transactions-loading.tsx`
   (pagination/filtre client). Skeleton qui épouse la forme : mêmes colonnes, ~8
   lignes grises, montants placeholders `tabular-nums`. **Aucune couleur sémantique**
   (le chargement n'est pas de la donnée — règle états).
2. **Empty — aucune transaction** : illustration outline `table`, message `text-muted`,
   UN CTA. À distinguer de l'actuel Empty « aucune banque » (qui renvoie vers
   `/banques`). Si comptes connectés mais 0 transaction → « Première synchro en
   cours / pas encore d'opérations ». Si AUCUNE banque → garder le CTA « Connecter ».
3. **Error** : `transactions-error.tsx` — fond `danger-bg` + icône + message,
   `role="alert"`, bouton `onRetry`. **Jamais** un simple rouge (rouge = sortie).
4. **Partiel** : si une page charge mais la suivante échoue → la liste reste, un
   bandeau d'erreur discret en bas avec « Réessayer » (on ne jette pas ce qui est
   déjà affiché).

## 5. Toolbar / filtres (§2.2 toolbar + §2.3)

- Conteneur de filtres : pills `surface-inset` rounded-control, padding 8/12.
- Filtres v1 (mappés sur B1.filtres) : **Sens** (Tout / Entrées / Sorties),
  **Compte** (si >1 compte connecté), **Statut** (Tout / Non catégorisé / Partiel /
  Complet). Segmented control pour Sens (segment actif = pill `ink` blanc, §2.3).
- Pas de recherche texte en v1 (B1 ne l'expose pas ; éviter d'élargir le scope
  Backend sans décision — cf. §7).
- Changement de filtre → re-fetch page 1 client (reset curseur).

## 6. Pagination

- **« Charger plus »** (bouton secondaire `surface-inset`, bas de liste) plutôt que
  scroll infini : plus prévisible, testable, pas de piège d'accessibilité. Au clic →
  `listerTransactions({curseur: curseurSuivant})`, append. Curseur null → bouton masqué.
- (Alternative scroll-infini = différée, TODOS si demandée.)

## 7. Décisions à valider AVANT code (pushback / clarifications)

- **D-T1 — Découpage des PR.** Cette page dépend de Backend (B1-B3). Deux voies :
  (a) **Contrat-first** : je code toute l'UI contre `types-transactions.ts` + démo
  stub + tests, je pousse ; Backend livre B1-B3 en parallèle ; on câble ensuite.
  (b) **Attendre** que Backend livre B1-B3, puis je code contre le réel.
  → Recommandation : **(a)**, c'est ce qui a parfaitement marché pour la modale.
- **D-T2 — Résumé ventilation (B2).** Option éco (badge résumé + `listerSplits` à
  l'ouverture) vs option riche (splits complets dans la liste). Reco : **éco**.
- **D-T3 — Filtres v1.** La liste §5 (Sens/Compte/Statut) est-elle le bon périmètre,
  ou v1 minimale (juste la liste + pagination, filtres en V2) ? Reco : inclure les
  filtres, ils sont peu coûteux et la table sans filtre est frustrante.
- **D-T4 — Recherche texte.** Hors scope v1 (élargirait B1 + touche l'indexation /
  potentiellement PII). À acter comme V2 si voulu.
- **D-T5 — /plan-design-review ?** La modale était le « Boss Final » et a eu sa revue
  dédiée. Cette page est dense mais s'appuie sur des patterns DÉJÀ validés (table
  §2.2, CategoryBadge, modale revue). Une /plan-design-review allégée sur la
  **densité du tableau + l'état de catégorisation par ligne** serait utile mais pas
  obligatoire. Reco : revue design légère AVANT code, ou Visual QA strict APRÈS.

## 8. Quality Gates (rappel, à la livraison)

- Tests : logique pure de pagination/curseur + mapping `TransactionListItem`→modale
  (si une fonction pure émerge). Le tableau lui-même → Visual QA (pas de renderer
  React de test au projet, choix tracé).
- Visual QA Gate 4 : route `/demo/transactions`, capture des 4 états + ligne
  cliquable ouvrant la modale + densité §2.2 + couleurs sémantiques montants +
  absence de vert/rouge sur les badges catégorie.
- Lint + tsc + build verts. Commit atomique. STOP à la PR (Human-in-the-Loop).
- Anti-IDOR : la lecture passe par `withWorkspace` (B1) ; rien d'ad-hoc côté UI.
