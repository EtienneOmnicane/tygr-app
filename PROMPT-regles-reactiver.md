# Prompt — Réactivation d'une règle en un clic (Track R, /regles, UI pure)

**Worktree** : branche `feat/regles-reactiver-liste` depuis `main` à jour.
**Domaine de fichiers (n'écris QUE là — anti-collision worktrees parallèles)** :
`src/components/regles/**` (surtout `regles-list.tsx`, `regles-feature.tsx`) et la
route de démo `src/app/demo/regles-states/**`. Touche `src/app/(workspace)/regles/**`
UNIQUEMENT si le câblage d'un handler l'exige. **INTERDIT** : `src/app/globals.css`,
tout `src/server/**`, `src/lib/**`, et les domaines transactions/perf.
**AUCUN changement serveur** : `modifierRegleAction({ ruleId, isActive })` existe déjà.

## Problème (constaté par le PO)
Une règle archivée (`is_active=false`) n'affiche dans la liste (`ReglesList`,
`regles-list.tsx`) qu'un lien « Modifier » + un badge « archivée ». Le SEUL chemin de
réactivation est une case à cocher « Règle active » enfouie dans le formulaire d'édition
(`regle-form.tsx`) — invisible : ni le PO ni les utilisateurs finaux ne la trouvent. Une
règle qu'on ne sait pas réactiver est une règle morte.

## Objectif
Rendre la réactivation évidente et directe, sans passer par le formulaire.

1. **Bouton « Réactiver » dans la liste**, sur les règles archivées UNIQUEMENT
   (`!regle.isActive`), symétrique du « Supprimer » des règles actives. Un clic →
   handler `onReactiver(ruleId)` remonté au conteneur `regles-feature.tsx`, qui appelle
   `modifierRegleAction({ ruleId, isActive: true })` puis rafraîchit la liste (même
   idiome que `onSupprimer`/`archiverRegleAction` déjà présent). État « Réactivation… »
   pendant l'appel (comme `suppressionEnCours`).
2. **Conserver « Modifier »** sur les deux états (inchangé).
3. **La case « Règle active » du formulaire d'édition** (`regle-form.tsx`) peut RESTER
   (elle sert encore à archiver/réactiver en même temps qu'on édite d'autres champs),
   mais elle n'est plus le seul chemin. Ne la supprime pas.

## Contraintes NON négociables (CLAUDE.md)
- **Phase d'abord (règle 1)** : c'est un correctif d'UI ciblé. S'il tient en ≤20 lignes
  applicatives sans changement de schéma/API/sécurité, l'exception « correctif direct »
  s'applique — mais fais quand même passer une revue à contexte frais avant push (règle 6).
  Sinon, court plan écrit d'abord.
- **Présentationnel pur** : `ReglesList` reçoit ses handlers en props, ne fetch rien.
  Ajoute `onReactiver?: (ruleId: string) => void` et `reactivationEnCours?: string | null`
  au contrat, sur le modèle EXACT de `onSupprimer`/`suppressionEnCours`. Le conteneur
  décide, le serveur reste la garde (rôle re-résolu dans la transaction).
- **Tokens uniquement** (aucune couleur en dur) : réutilise les classes du bouton
  existant. « Réactiver » = geste POSITIF/neutre → PAS de `danger` (réservé à
  « Supprimer ») ; hover `surface-inset`/`primary`, jamais de vert décoratif inventé
  (vert/rouge = donnée seulement, UI_GUIDELINES §0).
- **Rôle** : les boutons ne s'affichent que si `peutGerer` (déjà en place). La garde
  dure reste serveur (MANAGER/ADMIN).
- **Microcopy** : après réactivation, ne laisse PAS croire que le passé est reclassé —
  la ré-analyse ne touche que les transactions NON catégorisées et n'écrase jamais une
  ventilation manuelle (comportement voulu). Si tu ajoutes un message, dis « Règle
  réactivée. Lancez Ré-analyser pour l'appliquer aux transactions non catégorisées. »
- **Stop-loss (règle 5)** : `npm run lint && npm run typecheck && npm run build` verts.
- **Visual QA (Gate)** : expose l'état « règle archivée avec bouton Réactiver » dans
  `src/app/demo/regles-states/`, capture, compare à UI_GUIDELINES avant la PR.

## Hors périmètre (ne PAS faire ici)
- Suppression DÉFINITIVE (hard delete) : n'existe pas côté serveur par design
  (archive-jamais-supprimer). Si le PO la veut, c'est une feature serveur séparée —
  ouvre-la en question, ne l'improvise pas.

## Livrable
Commits sur `feat/regles-reactiver-liste`, **STOP à la PR poussée** (code applicatif →
Etienne ouvre + merge). Ne merge pas.
