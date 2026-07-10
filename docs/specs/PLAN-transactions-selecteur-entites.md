# PLAN — Chantier C : sélecteur de comptes /transactions (feedback 0709)

- **Branche** : `fix/transactions-selecteur-entites` (worktree `.worktrees/selecteur`, depuis `main`)
- **Source** : `docs/specs/FEEDBACK-retours-etienne-2026-07-09.md` (item 3)
- **ID TODOS** : FB0709-TX-SELECTEUR1
- **Statut grounding** : fait (2026-07-09) sur `main`.

## C1 — Bug « banque invisible » dans le menu déroulant

**Suspect n°1 confirmé au grounding** : `listerComptes`
(`src/server/repositories/dashboard.ts:156-204`) filtre
`.where(eq(bankAccounts.isSelected, true))` (:202) — tout compte
`isSelected=false` disparaît SILENCIEUSEMENT du menu. Second filtre :
`parties.isActive=true` (:174) pour le groupement titulaire. Aucun contrôle sur
`bankConnections.status`.

Étapes :
1. **Diagnostic d'abord** (stop condition règle 7 : si la cause réelle diffère,
   STOP + consigner) : reproduire la disparition — vérifier quand/où
   `isSelected` passe à false (re-sync ? sélection au widget ?) et si les
   comptes d'Etienne touchés sont bien `isSelected=false` ou victimes d'un
   autre filtre (partie inactive, entity scope).
2. **Correctif** selon le diagnostic, à trancher pendant l'implémentation :
   - si `isSelected=false` est un état légitime (compte non retenu au widget) :
     le menu doit l'exposer quand même sous un groupe « Comptes non suivis »
     OU l'upsert de re-sync ne doit pas dégrader `isSelected` (même invariant
     que `entity_id` : la re-sync ne réécrase pas un choix utilisateur) ;
   - si c'est un bug d'ingestion : corriger l'upsert.
   Le correctif ne contourne JAMAIS la RLS entity_scope : un compte hors
   périmètre reste invisible (fail-closed voulu, ne pas « réparer » ça).

Test : cas repo `listerComptes` avec compte `isSelected=false` (comportement
attendu post-décision), compte de partie inactive, et contre-preuve scope.

## C2 — Porter le sélecteur accordéon entités/titulaire du dashboard

**Constat** : /transactions groupe par `institutionName` via
`grouperParInstitution` (`src/components/transactions/transactions-toolbar.tsx:47-63`)
rendu en `<Select>` natif à `<optgroup>` (:110-120). Le dashboard a
`ConnectedAccountsCard` (accordéon `<details>/<summary>`, display-only) groupé
par titulaire via `grouperParTitulaire` (`src/lib/grouper-titulaire.ts:71-104`,
pure, testée), data shape `CompteConnecte[]` avec `holderId`/`holderName`.

Modifs :
1. RSC `transactions/page.tsx:70` : enrichir le mapping `CompteFiltre[]`
   (:92-96) avec `holderId`/`holderName` (déjà retournés par `listerComptes`).
2. Nouveau composant présentationnel `transactions/comptes-selecteur.tsx` :
   accordéon par titulaire (réutiliser `grouperParTitulaire` + le markup
   `<details>/<summary>` de `ConnectedAccountsCard` comme modèle), mais
   SÉLECTIONNABLE (le dashboard est display-only) : chaque compte est un item
   cliquable qui pousse `bankAccountId` dans `FiltresTransactions` ; entrée
   « Tous les comptes » ; état sélectionné visible (token `primary`).
   Composant pur : options en props, `onChange` en prop.
3. `TransactionsFeature` (:87-91) : câblage inchangé — le sélecteur remplace le
   `<Select>` dans la toolbar, `onChange` → `appliquerFiltres` → reset curseur
   page 1 (mécanique existante).
4. Moins de 2 groupes → liste plate (même repli que le dashboard :116-123).

## Exit criteria / gates

- Pas de nouvelle route ; `listerComptes` reste sous `withWorkspace`.
- Si C1 touche l'upsert d'ingestion : test du non-écrasement (miroir de
  l'invariant entity_id) obligatoire dans le même PR.
- Gates sandbox : lint, tsc, build, vitest non-DB (dont `grouperParTitulaire`
  et le nouveau composant si testable purement).
- Revue contradictoire à contexte frais ; Visual QA (menu, états vide/erreur,
  responsive) = Etienne. Commits locaux, pas de push sandbox.

## Hors périmètre

Recherche par mots-clés (chantier D) ; affichage catégorie/description
(chantier A) ; ré-assignation d'entités (chantier E).
