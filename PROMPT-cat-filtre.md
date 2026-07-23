# Prompt — Filtrage par catégorie sur /transactions (feature full-stack)

> ⚠️ **SÉQUENCEMENT — à lire avant de lancer.** Cette feature modifie
> `src/server/repositories/transactions.ts` (`listerTransactions` +
> `sommeNetteParDevise`), qui est le MÊME fichier que le chantier perf
> PERF-VENTILATION-AGG1 (agrégat de ventilation LATERAL/MATERIALIZED). **Ne lance
> PAS ce prompt en parallèle du worktree perf** : conflit garanti sur ce fichier.
> Ordre imposé : merge la PR perf d'abord, PUIS pars de `main` à jour pour ce
> travail. Si le worktree perf est encore ouvert, mets ce prompt en file.

**Worktree** : branche `feat/tx-filtre-categorie` depuis `main` à jour (après perf).

## Objectif
Ajouter un filtre « Catégorie » à la liste `/transactions` : un sélecteur dans la
toolbar restreint les opérations à une catégorie de ventilation manuelle donnée. Le
filtre doit se comporter comme les filtres existants (recherche, statut) : il part au
SERVEUR, alimente la pagination keyset ET la somme nette, jamais de filtrage client.

## Ce qu'il faut toucher (chaîne complète, dans l'ordre)
1. **Schéma** `src/lib/transactions-schema.ts` — ajoute `categoryId: z.string().uuid()
   .optional()` DANS l'objet `filtresTransactions` (source unique). Il atterrit
   mécaniquement dans `listerTransactionsSchema` ET `sommeNetteSchema` (garantie
   structurelle : le total portera exactement les mêmes prédicats que la liste).
2. **Repository** `src/server/repositories/transactions.ts` — ajoute un prédicat
   CORRÉLÉ `EXISTS (select 1 from transaction_categorizations tc where tc.transaction_id
   = ... and tc.category_id = :categoryId and tc.is_removed = false)`, sur le MÊME
   modèle que `predicatStatut` (sous-requête corrélée, PAS de jointure dérivée qui
   casserait la cardinalité de page). Applique-le dans `listerTransactions` ET
   `sommeNetteParDevise`. **N'INTRODUIS PAS de régression perf** : le prédicat doit
   rester corrélé et compatible avec l'index existant ; vérifie le plan (`EXPLAIN`)
   comme le fait le chantier perf. Respecte l'isolation : `transaction_categorizations`
   se lit via la RLS workspace + la convention de jointure `bank_accounts`
   (ENTITY-READ-JOIN1) déjà en place — ne la contourne pas.
3. **Contrat UI** `src/components/transactions/types-transactions.ts` — ajoute
   `categoryId?: string` à `FiltresTransactions` (mets à jour le commentaire qui
   énumère les filtres). `filtreActif()` le prendra automatiquement (il est dérivé de
   `Object.values`, ne pas énumérer champ par champ).
4. **Adapter** `src/app/(workspace)/transactions/adapter.ts` — propage `categoryId`
   dans `versInputBackend` (comme `recherche`/`statut`).
5. **Toolbar** `src/components/transactions/transactions-toolbar.tsx` — ajoute un
   `<Select>` « Catégorie » dans le groupe FILTRES (gauche), à côté du statut. Options
   = catégories actives (à plat, Natures + sous-natures indentées par préfixe visuel),
   fournies en prop par le conteneur depuis `categories`. Option « Toutes catégories »
   = `undefined`. **Jamais de `flex-wrap` sur le header** (CLAUDE.md « Responsive
   header ») : le groupe défile horizontalement, l'action « Gérer les catégories »
   reste `shrink-0`.
6. **Conteneur** `src/components/transactions/transactions-feature.tsx` — passe les
   catégories à la toolbar. Aucun autre changement de logique (le filtre suit le même
   chemin `appliquerFiltres` → `rechargerPremierePage` que le statut).

## Contraintes NON négociables (CLAUDE.md)
- **Phase d'abord (règle 1)** : plan écrit + relu (contexte frais) AVANT le code —
  cette feature traverse schéma, RLS-adjacent et perf.
- **Exit-criteria par surface (règle 3)** : Zod strict, filtre appliqué AVANT
  pagination (un `categoryId` ne peut tronquer une page), messages non-énumérants,
  tests (chemin heureux + catégorie inexistante + interaction avec statut+recherche).
- **Ajoute le cas au test d'isolation** : filtrer par une `categoryId` d'un autre
  workspace ne doit JAMAIS fuiter (RLS → 0 ligne).
- **Somme nette cohérente** : le total du bandeau doit refléter le filtre catégorie
  (déjà garanti par le schéma dérivé — vérifie-le par test).
- **Stop-loss (règle 5)** + **suite isolation IDOR bloquante (règle 9)** verts.
- **Empty state** : ajoute le cas « aucune transaction pour cette catégorie » (variante
  MESSAGE de l'empty existant dans `transactions-feature.tsx`).
- Relie à la dette existante **TX-FILTRES-URL1** dans `TODOS.md` (persistance des
  filtres in-page dans l'URL) : soit tu la traites ici, soit tu mets à jour l'entrée.

## Livrable
Commits sur `feat/tx-filtre-categorie`, **STOP à la PR poussée** (code applicatif →
Etienne ouvre + merge).
