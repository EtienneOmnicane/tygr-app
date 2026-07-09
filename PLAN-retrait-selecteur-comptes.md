# PLAN — Retrait du sélecteur de comptes de la toolbar /transactions

- **Branche** : `fix/transactions-retrait-selecteur-doublon` (worktree
  `.worktrees/retrait-selecteur`), depuis `origin/main` (`f8dcf12`).
- **Phase** : implémentation. Grounding fait. Motif : le filtre par compte dans la
  toolbar fait DOUBLON avec le `PerimetreSwitcher` (topbar) qui scope déjà les comptes
  côté serveur via `viewFilter` intersecté par la RLS (`withWorkspace`/tenancy.ts).

## GROUNDING SÉCURITÉ (obligatoire — confirmé)

`listerTransactions` (`server/repositories/transactions.ts:190-194`) : le
`if (bankAccountId)` est un prédicat **MÉTIER / d'affinage**, PAS une garde de
sécurité — commentaire du repo explicite : « La RLS scope déjà au workspace ; ces
conditions sont métier ». La frontière de sécurité = `withWorkspace` (RLS
`workspace_id` étage 1 + `entity_scope`/`account_scope` via GUC, étage 2, pilotés par
le `viewFilter` du PerimetreSwitcher). **Retirer le filtre client `bankAccountId` ne
touche AUCUNE frontière de sécurité** : le périmètre reste borné serveur.

## DÉCISION (tranchée & consignée)

**Retrait UI-ONLY.** On retire `bankAccountId` du CONTRAT UI (`FiltresTransactions`)
et le sélecteur ; on **LAISSE le paramètre `bankAccountId` INERTE** côté schéma zod /
action / repository. Raisons :
- La sécurité n'en dépend pas (cf. grounding) — aucun risque à le laisser.
- Le repo/schéma sont partagés et couverts par des tests d'isolation (« filtre par
  compte ») ; les retirer casserait des tests verts et réduirait une capacité backend
  légitime sans bénéfice (règle 9 : pas de churn gratuit).
- Un futur besoin (lien profond « voir ce compte ») pourrait le réutiliser.
Conséquence : l'UI ne PRODUIT plus jamais `bankAccountId` ; le backend garde la
capacité, non sollicitée. Aucune migration, aucune Server Action modifiée.

## Modifs (UI seule)

1. `types-transactions.ts` : retirer `bankAccountId?` de `FiltresTransactions`.
2. `transactions-toolbar.tsx` : retirer le bloc `<CompteSelecteur>`, son import, la
   prop `comptes`, et l'interface `CompteFiltre` (exportée — vérifier ré-exports).
   Garder statut + bornes de dates. La toolbar est une TOOLBAR DE CONTENU (pas le
   header) : le `flex-wrap` y est acceptable, mais on peut resserrer.
3. `transactions-feature.tsx` : retirer la prop `comptes` + le type `CompteFiltre`.
   `appliquerFiltres` inchangé ; `rechargerPremierePage` envoie déjà `curseur: null`
   (reset page 1) — cohérent, ne bouge pas.
4. `page.tsx` : supprimer le mapping `comptesFiltre` (ne servait qu'au sélecteur) et
   la prop `comptes={comptesFiltre}`. **GARDER `nomParCompte`** (libellé compte dans
   la table). Ne PAS toucher au scope serveur / listerComptes.
5. `comptes-selecteur.tsx` : supprimer (plus référencé) + son test
   `comptes-selecteur-groupement.test.ts`.
6. `demo/transactions/page.tsx` : retirer `COMPTES` + la prop `comptes`.

Vérifier l'`adapter.versInputBackend` : il lit `filtres.bankAccountId` — après retrait
du champ, l'accès devient impossible côté type ; retirer la ligne (l'input backend ne
portera simplement plus ce filtre). Vérifier aussi tout ré-export de `CompteFiltre`.

## Gates & sortie

- Gates : lint, tsc, build, vitest non-DB. Le test d'isolation « filtre par compte »
  (backend) reste VERT (on ne touche pas le repo). Le test de groupement du sélecteur
  est SUPPRIMÉ avec le composant.
- Revue contradictoire à contexte frais (mandat : le retrait laisse-t-il une référence
  pendante ? le scope serveur est-il intact ? nomParCompte préservé ? pas de perte du
  reset curseur ?).
- Commits locaux (plomberie). STOP à la PR. Visual QA (toolbar sans sélecteur,
  filtrage via « Vue » topbar, responsive) = Etienne.

## Note branches concurrentes (à signaler à Etienne)

Ce retrait rend OBSOLÈTES : `fix/transactions-ux-toolbar` (78b0eb6, améliorait le
sélecteur) et le sélecteur de `fix/feedback-0709-ui-batch`. Si ce retrait est retenu,
ces deux-là ne doivent PAS être mergés sur la partie sélecteur (conflit / travail
annulé). À arbitrer au merge.
