# Conception — Page Transactions (`/transactions`)

> Phase 1 (conception). Epic 3, chantier post-dashboard. Auteur : Agent UI, 2026-06-16.
> À implémenter APRÈS livraison du service `listerTransactions` par le Backend.
> Aucune ligne de code applicatif tant que ce plan n'est pas validé (CLAUDE.md règle 1).

## Contexte & frontière de gouvernance

- **Donnée = Backend.** La page consomme `listerTransactions(tx, { limite, ... })`
  (signature exacte à fournir par le Backend) → `TransactionRecente[]`. Listing
  complet, trié, limite généreuse côté SQL. **Aucune agrégation/tri/troncature côté UI.**
  Raison : `transactionsRecentes` (dashboard) est tronquée à 8 → inutilisable ici.
- **Rendu = UI (moi).** `page.tsx`, `loading.tsx`, `error.tsx`, le composant badge,
  la réactivation de l'onglet navbar. Rien d'autre.

## Contrat de données consommé (déjà en place)

`TransactionRecente` (`src/server/repositories/dashboard.ts`) :
`omnifiTxnId`, `transactionDate` (YYYY-MM-DD), `amount` (chaîne décimale),
`currency`, `creditDebit` ("Credit" | "Debit"), `cleanLabel` (string | null),
`primaryCategory` (string | null), `subCategory` (string | null), `bankAccountId`.
→ **Pas de `merchant`** dans ce contrat (ne pas le supposer).

## 1. Routing & shell

- Page : `src/app/(workspace)/transactions/page.tsx` (RSC, groupe `(workspace)` →
  header/nav + garde RLS hérités).
- RSC appelle `listerTransactions` via **un seul `withWorkspace`** + ré-export
  `@/server/db` (même frontière lint anti-IDOR que le dashboard).
- Devise : `base_currency` du workspace (MVP mono-devise MUR), passée à la table.

## 2. Réactivation navbar

- `app-nav.tsx` : les onglets sont DÉJÀ neutralisés (`placeholder: true`, PR #35).
  → retirer `placeholder: true` du SEUL item `Transactions` (1 ligne), **dans la
  même PR** que la page (jamais réactiver un lien avant que sa cible existe).
- Graphiques reste `placeholder` (page à venir) ; Échéances reste `placeholder`
  durablement (pas de donnée backend — arbitrage PO acté).

## 3. Structure visuelle

```
H1  Transactions
    Toutes les opérations synchronisées de vos comptes.   ← sous-titre text-muted

┌─ StateCard ─────────────────────────────────────────────┐
│ DATE · LIBELLÉ · CATÉGORIE(badge) · MONTANT              │  ← TransactionsTable
│ lignes : divide-y, tabular-nums, Credit=inflow/Debit=out │     (réutilisé)
└─────────────────────────────────────────────────────────┘
```

- **Réutilise `TransactionsTable`** (décision validée) monté nu : le H1 de page
  remplace son titre interne « Transactions récentes ». → petite évolution du
  composant : rendre le titre **optionnel** (prop `titre?: string`, masqué si absent)
  pour ne pas afficher deux titres. Changement rétro-compatible (dashboard continue
  de passer son titre).

## 4. Badges catégorie (décision validée : pastille colorée)

- **Nouveau composant** `src/components/dashboard/category-badge.tsx` :
  `<CategoryBadge category={primaryCategory} />` → pastille arrondie, fond ténu.
- **⚠️ Tokens NEUTRES uniquement** (UI_GUIDELINES §3.1) : JAMAIS inflow/outflow
  (vert/rouge réservés aux MONTANTS). Palette de fonds neutres/désaturés
  (ex. surface-inset + nuances de gris/ardoise), différenciées par catégorie via
  un **mapping déterministe** `primaryCategory → token`.
- **Mapping** : table fermée pour les catégories connues (Income, Utilities, Rent,
  Banking & Finance, Payroll, …) + **fallback** « Non catégorisé » (null) en gris
  neutre. Le mapping est purement présentationnel (côté UI), pas de la logique métier.
- **Intégration** : `TransactionsTable` remplace le `<span>` texte de catégorie par
  `<CategoryBadge>`. Comme la table est partagée, le badge apparaît AUSSI sur le
  dashboard — cohérent et souhaitable (à confirmer au Visual QA).

## 5. Les 4 états (checklist UI_GUIDELINES §6.5 — obligatoire)

| État | Mécanisme |
|---|---|
| **Loading** | `loading.tsx` natif : skeleton épousant la table (réutilise `SkeletonBlock`/`StateCard`). Montants placeholders `tabular-nums`, aucune couleur sémantique. |
| **Vide** | 0 transaction → `StateCard` : message « Aucune transaction synchronisée pour l'instant ». PAS de CTA « connecter une banque » ici (la page suppose un workspace avec comptes ; l'empty global vit sur le dashboard). |
| **Erreur** | `error.tsx` du segment → `DashboardErrorState` (existant, digest sans PII, `role="alert"`). |
| **Succès** | `TransactionsTable` peuplée. |

## 6. Périmètre & exclusions

- **Je touche** : `transactions/page.tsx`, `transactions/loading.tsx`,
  `transactions/error.tsx`, `category-badge.tsx` (nouveau), `transactions-table.tsx`
  (titre optionnel + badge), `app-nav.tsx` (1 ligne).
- **Je ne touche PAS** : `listerTransactions` & tout `src/server/`, schémas Zod,
  Server Actions, contrat. Frontière de gouvernance (cf. [[gouvernance-frontiere-ui]]).

## 7. Quality Gates avant livraison

- `tsc --noEmit`, `eslint` vierge, `vitest` au vert.
- Visual QA humain (états vide/loading/succès + badges contre §3.1 : vérifier
  qu'aucun badge n'emploie de couleur sémantique inflow/outflow).
- Route de démo (`/demo/...`) pour capture headless si besoin.

## Dépendance bloquante

⛔ **Attendre la signature de `listerTransactions`** avant d'écrire le câblage data
de `page.tsx`. Le reste (badge, titre optionnel, états, navbar) est implémentable
sans la signature — mais je groupe tout dans une PR cohérente une fois la signature
connue, pour ne pas livrer une page sans données.
