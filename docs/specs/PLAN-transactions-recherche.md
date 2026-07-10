# PLAN — Chantier D : recherche par mots-clés /transactions (feedback 0709)

- **Branche** : `feat/transactions-recherche` (worktree `.worktrees/recherche`, depuis `main`)
- **Source** : `docs/specs/FEEDBACK-retours-etienne-2026-07-09.md` (item 11)
- **ID TODOS** : FB0709-RECHERCHE-TX1
- **Statut grounding** : fait (2026-07-09) sur `main` — **découverte majeure : le
  backend existe déjà intégralement.** L'effort réel est ~0,5 j (UI seule),
  pas 1 j.

## Existant (ne PAS réécrire)

- `listerTransactions` (`src/server/repositories/transactions.ts:182-336`)
  accepte déjà `recherche` : ILIKE sur `cleanLabel` UNIQUEMENT, métacaractères
  LIKE échappés, paramètre lié (:199-200). Jamais `bank_label_raw` (PII, règle
  8 — commentaire :197 explicite).
- Zod : `listerTransactionsSchema.recherche` = trim, min 1, max 120
  (`src/lib/transactions-schema.ts:73-94`), `.strict()`.
- Server Action `listerTransactionsAction`
  (`transactions/actions.ts:180-196`), erreurs nommées sans exception client.
- Curseur keyset opaque base64url (`transactions.ts:136-166`), reset page 1 au
  changement de filtre géré par le parent (`adapter.ts:64-79`,
  contrat commenté `transactions-toolbar.tsx:14`).

## D1 — UI : champ de recherche dans la toolbar

Modifs :
1. `TransactionsToolbar` (`src/components/transactions/transactions-toolbar.tsx`) :
   input de recherche (icône loupe SVG inline, placeholder « Rechercher un
   libellé… »), contrôlé, **debounce ~300 ms** avant `onChange({ ...filtres,
   recherche })` (pas de requête par frappe) ; croix d'effacement ; valeur vide
   → `recherche: undefined` (pas de chaîne vide, le zod min(1) la rejetterait).
2. `TransactionsFeature` : rien à changer sur le fond — `appliquerFiltres`
   reset déjà le curseur page 1. Vérifier que l'état « recherche active, 0
   résultat » monte l'EmptyState avec un message adapté (« Aucune transaction
   ne correspond à “…” ») plutôt que l'empty générique — composant états
   existant, variante message seulement.
3. Bornes : maxLength 120 sur l'input (aligné zod) ; l'UI tronque, le serveur
   reste la vraie garde.

## D2 — Garanties transverses (à vérifier, pas à construire)

- **PII (règle 8)** : le terme de recherche ne doit jamais être loggé — grep
  des logs autour de `listerTransactionsAction` pour vérifier qu'aucun
  `console/log structuré` ne sérialise `filtres` brut ; si oui, rédiger le
  champ (`recherche: "[redigé]"`).
- **Pas d'URL** : les filtres sont en état mémoire (pas de searchParams) → le
  terme ne fuit pas dans l'historique navigateur. Conserver ce choix.
- Test : composeur de filtres (recherche + compte + période cumulés), reset
  curseur au changement de terme, échappement `%`/`_` (test repo existant à
  étendre si non couvert).

## Exit criteria / gates

- Aucune nouvelle route/action — la surface authz existante ne bouge pas.
- Gates sandbox : lint, tsc, build, vitest non-DB.
- Revue contradictoire à contexte frais ; Visual QA (recherche active, vide,
  effacement, debounce perceptible) = Etienne. Commits locaux, pas de push.

## Hors périmètre

Recherche plein-texte (tsvector), recherche sur montants/catégories,
persistance du terme en URL. Si Etienne veut chercher aussi les contreparties
→ entrée TODOS dédiée.
