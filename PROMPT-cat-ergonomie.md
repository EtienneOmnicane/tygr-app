# Prompt — Refonte ergonomique du gestionnaire de catégories (Track T, UI pure)

**Worktree** : branche `feat/cat-manager-ergonomie` depuis `main` à jour.
**Domaine de fichiers (n'écris QUE là — anti-collision worktrees parallèles)** :
`src/components/ui/category/category-manager-modal.tsx`, un éventuel sous-composant
frère dans `src/components/ui/category/`, et la route de démo
`src/app/demo/**` correspondante. **INTERDIT** : `src/app/globals.css`, tout fichier
`src/server/**`, `src/lib/**`, `transactions.ts`. Aucune Server Action, aucun schéma.

## Contexte
La modale `CategoryManagerModal` (accessible via le bouton « Gérer les catégories »
de la toolbar `/transactions`, ADMIN seul) est un long scroll plat : formulaire de
création (nom + `<select>` parent + Créer) empilé au-dessus de chaque Nature et de
ses sous-natures indentées, chaque ligne portant un badge + deux liens texte
minuscules « Renommer » / « Archiver ». Problèmes concrets à corriger :
1. **Archiver = 1 clic, sans confirmation** — une catégorie disparaît de tous les
   pickers sans garde-fou. Ajouter une confirmation inline (pas un `window.confirm`).
2. **Aucune recherche** dans le référentiel — illisible dès qu'il y a du volume.
3. **Groupes non repliables** — pas de vue d'ensemble ; ajouter un accordéon par
   Nature avec compteur de sous-catégories.
4. **Création décorrélée** — le `<select>` parent est peu intuitif. Préférer un
   « ＋ ajouter une sous-catégorie » CONTEXTUEL sous chaque Nature, + un bouton
   « ＋ nouvelle Nature » en tête. La création à la racine reste possible.
5. **Cibles de clic minuscules** — passer Renommer/Archiver en boutons-icônes avec
   `aria-label`, zone cliquable ≥ 32px, révélés au hover/focus mais toujours
   atteignables au clavier.

## Contraintes NON négociables (CLAUDE.md)
- **Phase d'abord (règle 1)** : commence par un COURT plan écrit (fichier
  `PLAN-cat-manager-ergonomie.md`) qui liste les états, la structure de composants et
  la conformité `docs/UI_GUIDELINES.md` (§4.4 modale, §2.3 hiérarchie boutons, §3.4
  erreur ≠ sortie). Fais-le relire (`/design-consultation` ou subagent frais) AVANT
  la moindre ligne de composant.
- **Présentationnel pur (déjà le cas)** : zéro fetch, zéro état métier. La liste
  arrive en props (`categories: CategorieUI[]`), les écritures remontent via
  `actions` (`ActionsReferentielCategories`) et `onChanged`. Ne change PAS ce contrat
  ni la signature `{ open, onClose, categories, actions, onChanged }`. Le
  conteneur `transactions-feature.tsx` doit continuer à monter la modale sans
  modification (si tu dois toucher le conteneur, STOP et signale-le — c'est hors
  domaine).
- **Tokens uniquement** (aucune couleur en dur) : `text-text`, `text-text-muted`,
  `surface-inset`, `surface-card`, `line`, `primary`, `danger`, `success`. Le
  `danger` reste réservé au geste destructif (archivage) + la confirmation, jamais
  du rouge décoratif.
- **Pré-validation locale conservée** : doublon insensible à la casse à la création
  ET au renommage (déjà présent — `doublonAuRenommage`, `messagePourCode`), le
  serveur reste juge.
- **Stop-loss (règle 5)** : `npm run lint && npm run typecheck && npm run build`
  verts avant tout commit.
- **Visual QA (règle 4/Gate)** : expose la modale hors auth via la route de démo,
  capture les états (vide, peuplé, édition, confirmation d'archivage, erreur) et
  compare par vision à UI_GUIDELINES avant de proposer la PR.

## Livrable
Commits sur `feat/cat-manager-ergonomie`, **STOP à la PR poussée** (Human-in-the-Loop :
c'est du code applicatif → Etienne ouvre la PR et merge). Ne merge pas.
