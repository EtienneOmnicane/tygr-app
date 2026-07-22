# PLAN — Réactivation d'une règle en un clic (Track R, `/regles`)

**Branche** : `feat/regles-reactiver-liste` (depuis `origin/main` @ 5d05368)
**Phase** : conception → implémentation (UI pure, aucun changement serveur)
**Date** : 2026-07-22

## Problème (constaté PO)

Une règle archivée (`is_active=false`) n'offre dans `ReglesList` qu'un lien
« Modifier » + un badge « archivée ». Le SEUL chemin de réactivation est la case
« Règle active » enfouie dans `regle-form.tsx` — invisible pour le PO comme pour les
utilisateurs finaux. Une règle qu'on ne sait pas réactiver est une règle morte.

## Objectif

Rendre la réactivation directe depuis la liste, sans ouvrir le formulaire.

## Décisions de conception

### D1 — Aucun changement serveur

`ActionsRegles.modifierRegle({ ruleId, isActive })` existe et documente DÉJÀ ce cas
(`types-regles.ts:50-53` : « Sert aussi à RÉACTIVER une règle archivée »). La garde
dure (MANAGER/ADMIN, rôle re-résolu dans la transaction) reste serveur, inchangée.
`peutGerer` côté UI n'est qu'une défense en profondeur.

### D2 — Contrat présentationnel calqué sur `onSupprimer`

`ReglesList` reste pur (zéro fetch, handlers en props). On ajoute, sur le modèle
EXACT de la paire existante :

| existant | ajouté |
| --- | --- |
| `onSupprimer: (ruleId) => void` | `onReactiver?: (ruleId) => void` |
| `suppressionEnCours?: string \| null` | `reactivationEnCours?: string \| null` |

`onReactiver` est OPTIONNEL (comme `onModifier`) : un conteneur qui ne l'injecte pas
n'affiche pas le bouton. Aucune régression pour les appelants existants.

### D3 — Le bouton n'apparaît QUE sur les règles archivées

`{!regle.isActive && onReactiver && (…)}` — strictement symétrique du
`{regle.isActive && (…)}` de « Supprimer ». Les deux boutons sont donc mutuellement
exclusifs : une ligne porte soit « Supprimer », soit « Réactiver », jamais les deux.
« Modifier » reste offert sur les deux états (inchangé).

### D4 — Tokens : « Réactiver » n'est PAS un `danger`, et pas un vert décoratif

- `danger-bg`/`danger` est réservé à « Supprimer » (geste destructif).
- Vert/rouge = DONNÉE uniquement (UI_GUIDELINES §0) → aucun vert de « succès »
  inventé sur un bouton d'action.
- Sur une ligne archivée, « Réactiver » est l'action PRINCIPALE et « Modifier » la
  tertiaire. On matérialise cette hiérarchie avec les tokens déjà employés par le
  bouton « Ré-analyser » du conteneur : `border border-line` + `text-text` +
  `hover:bg-surface-inset`. « Modifier » garde son `text-text-muted` sans bordure.

### D5 — Microcopy anti-illusion (le passé n'est PAS reclassé)

Réactiver une règle ne recatégorise rien rétroactivement : `appliquerRegles` ne
touche que les transactions SANS split et n'écrase JAMAIS une ventilation manuelle
(MANUAL prime — décision PO du moteur de règles, PR #95). Le message de confirmation
doit donc pointer vers la ré-analyse, sans la promettre :

> « Règle réactivée. Lancez « Ré-analyser les transactions » pour l'appliquer aux
> transactions non catégorisées. »

⚠️ **Cas de bord** : « Ré-analyser » n'est affiché que si `actions.appliquerRegles`
est fournie. Si elle est absente, le message ne doit PAS citer un bouton inexistant →
repli sur « Règle réactivée. » seule. Le message se calcule donc en fonction de
`typeof actions.appliquerRegles === "function"`.

### D6 — Ordre après réactivation

Aucun traitement spécifique : la règle réactivée réintègre les actives à sa
`priority` persistée, via le `recharger()` qui relit le tri serveur
(`asc(priority), asc(createdAt)`). On ne recalcule RIEN côté client (le conteneur
documente déjà pourquoi : `RegleUI` ne porte pas `createdAt`).

## Implémentation (3 fichiers, ~50 lignes)

1. **`src/components/regles/regles-list.tsx`** — 2 props au contrat + `const
   enReactivation` + bloc bouton conditionnel `!regle.isActive`. Mise à jour du
   JSDoc d'en-tête (il affirme aujourd'hui que le formulaire est le « seul chemin de
   réactivation » — devient faux).
2. **`src/components/regles/regles-feature.tsx`** — `reactivationEnCours` +
   callback `reactiver` calqué sur `supprimer` (setErreur/setInfo → appel →
   `messagePourCode` sur échec → `recharger()` → `finally` reset) + câblage des
   2 props sur `<ReglesList>`.
3. **`src/app/demo/regles-states/page.tsx`** — microcopy de la démo alignée (le
   stub `modifierRegle` gère déjà `isActive`, aucun changement de stub requis).

`regle-form.tsx` n'est PAS touché : la case « Règle active » reste (elle sert encore
à archiver/réactiver en même temps qu'on édite d'autres champs).

## Hors périmètre

- **Suppression DÉFINITIVE (hard delete)** : n'existe pas côté serveur PAR DESIGN
  (archive-jamais-supprimer, gouvernance/traçabilité). Si le PO la veut, c'est une
  feature serveur séparée — à ouvrir en question, jamais à improviser ici.
- Toute écriture hors `src/components/regles/**` et `src/app/demo/regles-states/**`
  (anti-collision worktrees parallèles).

## Critères de sortie

- [ ] Bouton « Réactiver » visible UNIQUEMENT sur `!isActive` ET `peutGerer`.
- [ ] État « Réactivation… » pendant l'appel, bouton désactivé.
- [ ] Échec serveur → bandeau `role=alert` mappé par `messagePourCode`.
- [ ] Aucune couleur en dur ; aucun `danger` sur « Réactiver ».
- [ ] `npm run lint && npm run typecheck && npm run build` verts (PWD vérifié).
- [ ] Visual QA `/demo/regles-states` : état archivé capturé et comparé aux
      UI_GUIDELINES.
- [ ] Revue à contexte frais (règle 6) avant push.

## Risque connu (recouvrement worktrees)

`origin/feature/feature-regles-form-validation-ux` (dormante depuis le 2026-06-24,
non mergée) touche `regles-feature.tsx` : elle y ajoute un `cleResetForm` (2 lignes
d'état + 1 prop). Recouvrement TEXTUEL possible sur le bloc de `useState`, mais
AUCUN recouvrement sémantique (elle vise le formulaire, nous la liste). Conflit
trivial à résoudre si les deux branches convergent un jour.
