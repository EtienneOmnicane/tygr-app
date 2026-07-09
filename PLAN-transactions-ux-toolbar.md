# PLAN — Chantier UX transactions : toolbar + sélecteur comptes + gestion catégories

## DÉCISIONS actées (Etienne, 2026-07-09)
- Popover comptes : **en-têtes titulaire NON repliables** (pas d'accordéon dans le
  popover) → préserve l'a11y clavier séquentielle du `Select`. Répond à « banque
  noyée » par les en-têtes titulaire + scroll borné.
- Libellé du trigger : **« Tous les comptes »** (sans préfixe « Vue : »).

- **Branche** : `fix/transactions-ux-toolbar` (worktree `.worktrees/ux-toolbar`),
  basée sur `fix/feedback-0709-ui-batch` (`6a31d00`) — PAS sur main, pour éviter la
  collision avec ce chantier batch concurrent non mergé (arbitrage Etienne 2026-07-09).
- **Phase** : implémentation. Grounding fait (voir §0). Estimé > 1h → ce plan.
- **Périmètre** : UI seule. AUCUNE modif backend/repository/schéma/Server Action.

## §0 — Grounding (état réel de la base `6a31d00`, ≠ brief)

Le brief décrit le sélecteur comme « une grosse boîte inline avec radios (accordéon
`<details>`) ». **FAUX sur cette branche** : `comptes-selecteur.tsx` a été SUPPRIMÉ par
le batch, et la toolbar utilise déjà le primitive `Select` (`ui/select/select.tsx`) —
un vrai dropdown popover : trigger `role=combobox` fermé par défaut, listbox overlay
`z-50 shadow-popover`, scroll borné `max-h-72 overflow-y-auto`, sélection visible
(`bg-primary-50` + `✓`), a11y clavier complète (typeahead, Échap sans fermer la modale).

Donc le popover EXISTE. Ce qui manque réellement :
1. Il groupe par **institution** (`grouperParInstitution`, toolbar:47) ; le brief veut
   par **TITULAIRE**. Le helper pur `src/lib/grouper-titulaire.ts` existe (testé, trie +
   relègue les noms génériques « account holder »).
2. `comptesFiltre` (page.tsx:92) ne passe QUE `{bankAccountId, accountName,
   institutionName}` — il a DROPPÉ `holderId/holderName`. Or `listerComptes`
   (dashboard.ts:59,167) les fournit toujours → simple RÉINJECTION dans le map (câblage
   page, PAS backend).
3. Libellé du trigger générique. Cible : « Tous les comptes » quand aucun filtre.

Modale catégories (`category-manager-modal.tsx`) : porte un **`<select>` natif** (l.141,
« Nature parente ») → problème #3. Les erreurs sont DÉJÀ mappées (`erreur` state +
`doublon` → « existe déjà »). États vide gérés (l.186). Pas de refonte lourde.

## §1 — Sélecteur de comptes par titulaire (problème #1)

- **Toolbar** : remplacer `grouperParInstitution` par un groupement par titulaire.
  Réutiliser le CONTRAT du helper : `CompteFiltre` regagne `holderId?/holderName?`.
  Grouper : en-tête = `holderName` (repli « Non regroupé » si null), option = compte
  (`accountName` — repli `institutionName` si accountName générique/vide). Item « Tous
  les comptes » en tête (groupe sans en-tête, valeur "").
- **Décision (pushback règle 10)** : PAS d'accordéon repliable DANS le popover. Le
  `Select` rend des groupes plats à en-têtes non-repliables ; un accordéon casserait le
  `role=option` séquentiel + le typeahead + la navigation ↑↓. Les en-têtes titulaire +
  scroll borné répondent au besoin (« banque noyée ») sans ce coût. À valider au QA.
- **Libellé trigger** : `placeholder="Tous les comptes"` (le Select affiche le
  placeholder quand `value` ne matche aucune option = filtre vide). Préfixe « Vue : »
  optionnel — décision : garder simple « Tous les comptes » (le libellé du compte
  sélectionné parle de lui-même). À confirmer au QA.
- **page.tsx** : `comptesFiltre` réinjecte `holderId/holderName` depuis `comptes`.
- **Tri** : réutiliser l'ordre du helper `grouper-titulaire` (nommés → génériques →
  non regroupé). Adapter le helper au type `CompteFiltre` OU mapper CompteFiltre →
  forme attendue. Éviter de DUPLIQUER la logique de tri (DRY).

## §2 — Layout toolbar (problème #2)

- La rangée est `flex flex-wrap items-center gap-3`. `flex-wrap` est interdit sur le
  HEADER (CLAUDE.md) mais ceci est une TOOLBAR de contenu — le wrap y est acceptable.
  Néanmoins réaligner pour cohérence : items de même hauteur (`h-10`), regroupement
  logique (compte | statut | dates), `gap` homogène. Responsive : sur petit écran,
  empiler proprement (le wrap actuel produit des lignes bancales).
- « Gérer les catégories » (bouton ADMIN, vit dans `transactions-feature.tsx`, hors
  toolbar) : vérifier son placement — actuellement `justify-end` au-dessus de la
  toolbar. Le laisser cohérent (aligné à droite, même hauteur).
- Pas de nouvelle couleur en dur ; tokens only.

## §3 — Gestion catégories (problème #3)

- Remplacer le `<select>` natif « Nature parente » (l.141-154) par le primitive
  `Select` (groupes/options plats, `ariaLabel`, `size="md"`). Cohérence visuelle avec
  la toolbar. Le `Modal` parent capture déjà Échap ; le Select `stopImmediatePropagation`
  sur Échap → ne ferme PAS la modale (pattern documenté dans select.tsx). Vérifier.
- Erreurs : déjà mappées (`erreur` + `doublon`). Confirmer que CATEGORIE_DEJA_EXISTANTE
  (retour serveur) est bien affiché (le state `erreur` reçoit le message d'action).
- États vide/erreur : déjà présents (l.186). Ne pas sur-ingénier.

## §4 — Gates & sortie

- Gates : `lint` + `tsc`. Build recommandé (piège `"use client"` déjà vu). Tests :
  étendre `comptes-selecteur-groupement` SI je réintroduis une logique de groupement
  titulaire testable (sinon le helper `grouper-titulaire` a déjà ses tests).
- Composants d'affichage PURS (tokens only, handlers en props). Zéro fetch UI.
- Revue contradictoire à contexte frais (mandat : régression a11y du Select, perte de
  compte dans le groupement — chaque compte ressort 1× —, PII holderName non loggé,
  câblage holderId page).
- Commits locaux (plomberie, hook > timeout). STOP à la PR. Visual QA (popover
  fermé/ouvert, sélection, responsive, dialog catégories) = Etienne.
- Hors périmètre : backend, recherche mots-clés (chantier D, autre branche).

## §5 — Risque de dépendance de branche (à signaler à Etienne)

Cette branche est fille de `fix/feedback-0709-ui-batch` (NON mergée, pas de PR). Elle
ne pourra être mergée qu'APRÈS son parent, ou en rebasant sur main une fois le parent
mergé. Si le parent change, rebaser. Tracé ici pour ne pas surprendre au merge.
