# PLAN — Feedback de synchro (Dashboard) + habillage d'erreur de connexion (WIDGET-ERR3)

> Phase : **conception**. Branche `fix/ux-synchro-et-erreur-connexion` (depuis `main` @ `8534f20`).
> Portée : **présentation uniquement**. Aucune modification de la logique de synchro,
> du contenu des messages serveur, ni des Server Actions.
> Source de vérité : `docs/UI_GUIDELINES.md` §0 / §3.4 / §3.7 / §4.4 / §6.5 + tokens `globals.css`.

---

## 0. Ce que l'audit du code a corrigé dans la prémisse du brief

Trois écarts relevés **avant** d'écrire une ligne de code (règle 10) :

1. **Le bandeau n'est pas dans `dashboard-content.tsx`.** Il est rendu par
   `src/components/dashboard/sync-button.tsx:100-172` — c'est ce `flex flex-col items-end
   gap-1.5` qui empile jusqu'à 4 `<p>` en `text-xs`, aligné à droite. C'est bien la
   surface décrite par le brief, mais le fichier annoncé est faux.

2. **Les compteurs structurés ne franchissent pas la frontière serveur → client.**
   Vérifié dans `src/app/(workspace)/banques/actions.ts:335-450` :

   | Signal | Sur `EtatFinalisation` ? |
   |---|---|
   | `incomplet: boolean` | ✅ |
   | `echecs: number` | ✅ |
   | `reparation: Array<{connectionId, jobId}>` | ✅ |
   | `aReconnecter: Array<{connectionId}>` | ✅ |
   | `rateLimited: Array<{connectionId, nextSyncAt}>` | ✅ |
   | `CompteursDesync {nonRattachees, inutilisables}` | ❌ aplatis par `supplementsDesync(r)` dans `info: string` |
   | Compteurs de succès (banques / comptes / transactions) | ❌ aplatis dans `succes: string` |

   ⇒ « non-rattachées » et « inutilisables » sont **indiscernables côté client**.
   **Arbitrage Etienne (2026-07-20) : un SEUL callout `info`, texte serveur tel quel.**
   Aucun champ ajouté à la Server Action. Les deux phrases de `messages-sync.ts`
   pointent déjà vers le même geste (« Connecter une banque ») — zéro perte utilisateur.

3. **« Reconnecter » sur la pastille du Dashboard est une décision produit livrée.**
   `ctaReconnexion={false}` est dans `main` (`dashboard-content.tsx:168`), squash-mergé
   depuis `fix/dashboard-retirer-reconnecter` — donc invisible à `git branch --merged`.
   **On ne le réintroduit pas.** Le lien « Reconnecter » du bandeau
   (`sync-button.tsx:148`) est un déclencheur DIFFÉRENT (`aReconnecter` / `reparation`,
   pas la péremption ≥24 h) : celui-là existe déjà et c'est lui qu'on sort du gris.

---

## 1. Défauts à corriger (surface 1 — bandeau de synchro)

- Aligné à **droite**, `text-xs`, `max-w-xs` : mur de prose illisible.
- Quatre canaux (`erreur` / `succes` / lien Reconnecter / `info`) empilés **sans
  hiérarchie**, tous en gris `text-text-muted` sauf l'erreur.
- Les deux **actions** (Reconnecter, Connecter une banque) sont noyées : l'une est un
  lien gris minuscule, l'autre n'existe que comme **texte** dans la phrase serveur.
- `dashboard-content.tsx:153` : `<header className="flex flex-wrap …">` — **violation
  de la règle « JAMAIS `flex-wrap` sur le header »** (CLAUDE.md § Intégration UI).
- La route de démo `demo/dashboard-states` **duplique** le markup du bouton et affiche
  encore « Comptes à jour. » — littéral **supprimé du vrai composant** (PR #202). La
  démo ment ; Gate 4 capture une fiction.

## 2. Cible

```
┌ header (pas de flex-wrap, condensation sous le breakpoint) ─────────────┐
│ Trésorerie                                          [ Synchroniser ]    │
│ 6 derniers mois · 8 comptes connectés                                   │
└─────────────────────────────────────────────────────────────────────────┘

  LIGNE D'ÉTAT PRIMAIRE  (gauche, max-w-2xl, text-sm)
  ● à jour · 15/07 14:32   Synchronisation effectuée — 3 banque(s) à jour,
                           8 compte(s) mis à jour. 142 transaction(s) importée(s).

  ⚠ Synchronisation encore en cours                          [ Relancer ]
  ⚠ Accès bancaire à rétablir                              [ Reconnecter ]
  ⚠ {texte serveur `info`}                        [ Connecter une banque ]
```

### 2.1 Décision — la pastille de fraîcheur **descend** dans la ligne d'état

Elle quitte le cluster droit du header pour rejoindre la ligne d'état primaire. Motifs :

- le brief exige « résultat de synchro **+** pastille de fraîcheur » sur la même ligne ;
- la garder AUSSI dans le header la **dupliquerait** ;
- le bandeau ne se rend qu'après une synchro (`retour !== null`) : sans ce déplacement,
  la pastille disparaîtrait au repos → **régression**. Donc la ligne d'état se rend
  **toujours**, portant la pastille au repos et le résultat après synchro ;
- effet de bord bénéfique : le cluster droit du header retombe à un seul élément, ce
  qui **supprime la cause** du `flex-wrap`.

`BalanceFreshnessPill` est **réutilisée telle quelle** (`ctaReconnexion={false}`
conservé — cf. §0.3). Aucune pastille réinventée.

### 2.2 Décision — d'où vient le TEXTE de chaque bloc

Contrainte dure : le serveur concatène **tout** dans une seule phrase `succes`
(base + partiel + reconnexion + cooldown + réparation). La découper côté client serait
du **re-parsing de prose**, interdit (`registre-synchro.ts` en fait la dette fondatrice).

Règle retenue, sans seconde source de vérité sur les nombres :

| Bloc | Texte | Ton / sévérité |
|---|---|---|
| Ligne d'état | `erreur` **ou** `succes`, **verbatim serveur** | `registreSynchro()` → danger / success / neutre |
| Callout « en cours » | libellé d'action court (UI), **sans compteur** | `warning` |
| Callout « à rétablir » | libellé d'action court (UI), **sans compteur** | `warning` |
| Callout `info` | `info`, **verbatim serveur** | `warning` |

**Les compteurs restent dans la phrase serveur** (ligne d'état) ; les callouts ne
portent que l'**action**. On n'invente aucun chiffre et on ne peut pas diverger du
serveur — c'est exactement le mode de défaillance corrigé par la PR #202.

### 2.3 Déclencheurs (signaux STRUCTURÉS uniquement, jamais la phrase)

| Callout | Condition | Action |
|---|---|---|
| Synchronisation encore en cours | `incomplet === true` | `Relancer` → rappelle l'action (idempotente) |
| Accès bancaire à rétablir | `reparation.length > 0 \|\| aReconnecter.length > 0` | `Reconnecter` → `/banques` |
| Information | `info` non vide | `Connecter une banque` → `/banques` |

Réserve assumée : quand le relais durable W1 est parti, le serveur écrit « la
récupération se poursuit automatiquement » — `incomplet` reste `true` sans qu'on puisse
le distinguer. « Relancer » y reste un geste **valide et idempotent** (rate-limit amont),
pas une contradiction. Non résoluble sans toucher l'action → hors périmètre.

### 2.4 Architecture (arbitrage Etienne : contexte client)

| Fichier | Nature | Rôle |
|---|---|---|
| `src/components/sync/sync-contexte.tsx` | **client** | Provider : porte `EtatFinalisation \| null`, `enCours`, `synchroniser()`. Seul point qui appelle la Server Action. |
| `src/components/sync/sync-summary.tsx` | **pur** | Ligne d'état + callouts. Zéro fetch, zéro état, handlers en props. |
| `src/components/ui/states/callout.tsx` | **pur** | Primitive `Callout` partagée (`danger` / `warning`). |
| `sync-button.tsx` | client | Réduit au **déclencheur** ; consomme le contexte. Garde VIEWER inchangée. |
| `dashboard-content.tsx` | pur | Monte le provider, retire `flex-wrap`, place `SyncSummary` sous le header. |

`SyncSummary` étant **pur et piloté par props**, la démo peut enfin monter le **vrai**
composant avec des états figés au lieu d'en dupliquer le markup (cf. §1).

---

## 3. Surface 2 — WIDGET-ERR3 (`widget-feedback.tsx`)

**Défaut** : les trois canaux d'erreur (`erreurDemarrage`, `erreurWidget`,
`erreurFinalisation`) sont rendus en `<p className="text-sm text-danger">` — **rouge nu**,
sans fond ni icône. Viole §3.4 : « une erreur a TOUJOURS un fond teinté, une icône et un
texte ; une sortie n'est qu'un montant ». Le rouge nu appartient aux montants `outflow`.

**Correctif** : les trois `<p>` passent par la primitive `Callout severite="danger"`
(fond `danger-bg` + icône + message, `role="alert"`). **Le registre de messages et sa
logique non-énumérante (#229, règle 3) ne sont pas touchés** — uniquement le contenant.

Le docstring en tête de fichier (« le fond `danger-bg` est porté au niveau des états de
page ; ici on reste sur le feedback inline court ») devient **faux** : il est réécrit.

### 3.1 Primitive `Callout` — pourquoi elle est créée ici

Le markup « fond teinté + icône + message » est aujourd'hui **dupliqué à l'identique**
dans au moins 4 fichiers :

- `components/echeances/echeances-feature.tsx:246`
- `components/regles/regles-feature.tsx:260`
- `components/transactions/transactions-feature.tsx:459`
- `components/admin/avertissement-vue-restreinte.tsx:38` (variante `warning`)

Aucune primitive partagée n'existe (`ui/states/primitives.tsx` s'arrête à `SkeletonBlock`
/ `StateCard` / `StateIllustration`). La créer respecte « pas de markup de carte
dupliqué ». **Migrer les 4 sites existants est hors périmètre** (scope creep à 2 jours
d'une démo) → entrée TODOS `UI-CALLOUT-MIGRATION1` (P2, déclencheur : prochain chantier
UI transverse).

---

## 3bis. Passe design (2026-07-20)

Passe **compressée et assumée** : les 7 passes interactives de `/plan-design-review`
(maquettes IA + comparateur + Codex + 7 STOP bloquants) sont disproportionnées pour deux
surfaces de polish, et la génération de maquettes IA contredit frontalement CLAUDE.md
(« gstack sert au Visual QA, **jamais au rendu** »). Substance conservée, machinerie écartée.
Classifier : **APP UI** (dense, orienté tâche) → règles App UI, pas Landing.

### F1 — Contraste AA : `text-danger` sur `danger-bg` ÉCHOUE (bloquant)

**Mesuré**, pas jugé à l'œil (`scratchpad/contrast.mjs`, formule WCAG 2.1) :

| Couple | Ratio | AA normal (4,5) |
|---|---|---|
| `danger #bf3b2f` sur `danger-bg #f6e4df` | **4,40:1** | ❌ **ÉCHEC** |
| `warning #8a6108` sur `warning-bg #f7e8c3` | 4,56:1 | ✅ (de justesse) |
| `text #0c1633` sur `danger-bg` | 11,46:1 | ✅ |
| `text #0c1633` sur `warning-bg` | 11,59:1 | ✅ |

C'est exactement le motif des 4 callouts ad-hoc existants — un **défaut d'accessibilité
préexistant** que la primitive allait généraliser aux deux surfaces.

**Décision** : dans `Callout`, le **message** porte `text-text` (11,46:1) et l'**icône**
porte la couleur de sévérité. §3.4 exige « fond teinté + icône + message » — il n'exige
**pas** que le message soit coloré. Conforme §3.4 **et** AA. Effet de bord assumé : la
nouvelle primitive sera plus lisible que les 4 sites ad-hoc jusqu'à leur migration
(→ `UI-CALLOUT-MIGRATION1`).

### F2 — Saut de layout (bloquant)

`setRetour(null)` au clic vide le bandeau ; comme il est monté au-dessus de la rangée KPI,
tout le dashboard **remonte puis redescend** à chaque synchro. Deux corrections :

- la **ligne d'état est montée en permanence** (elle porte la pastille au repos) — elle ne
  disparaît jamais, donc sa hauteur ne s'effondre pas ;
- pendant `enCours`, elle affiche « Synchronisation en cours… » au lieu de se vider.

Seuls les **callouts** apparaissent/disparaissent, et ils sont sous la ligne d'état.

### F3 — Rôle VIEWER non spécifié

Un VIEWER ne peut pas synchroniser (`peutModifier` faux). La ligne d'état lui reste
**visible** (la fraîcheur est une information de lecture) ; le callout « en cours » ne lui
propose **pas** « Relancer ». Les liens vers `/banques` restent (navigation, pas écriture).

### F4 — Risque « mosaïque de cartes » (App UI)

Trois callouts empilés en fond teinté peuvent virer au « stacked cards instead of layout ».
Garde-fous : `rounded-control` (pas `rounded-card`), **pas d'ombre**, pas de bordure
gauche colorée (motif « AI slop » n° 8), hauteur compacte, une seule icône par ligne.

### F5 — Ordre d'affichage quand plusieurs callouts se déclenchent

Du plus grave au plus informatif : **erreur → accès à rétablir → synchro en cours → info**.
Sans ordre fixe, l'ordre dépendrait de l'ordre des champs — instable d'une synchro à l'autre.

### Notations

| Passe | Avant | Après |
|---|---|---|
| 1. Architecture de l'information | 7/10 | 9/10 (ordre F5 + ligne d'état permanente) |
| 2. Couverture des états | 6/10 | 9/10 (loading F2 + VIEWER F3 ajoutés) |
| 3. Parcours / arc émotionnel | 7/10 | 8/10 (plus de saut de layout au clic) |
| 4. Risque « AI slop » | 6/10 | 9/10 (garde-fous F4) |
| 5. Alignement design system | 8/10 | 10/10 (F1 corrige un écart AA réel) |
| 6. Responsive & accessibilité | 5/10 | 9/10 (F1 + F3 + header sans `flex-wrap`) |

**Hors périmètre de la passe** : maquettes IA (interdites par CLAUDE.md), migration des 4
callouts ad-hoc, refonte de la hiérarchie du dashboard.

## 4. Critères de sortie

- [ ] Aucune couleur en dur ; tokens sémantiques uniquement. `inflow`/`outflow` absents
      des deux surfaces (état **système**, pas donnée financière).
- [ ] `tabular-nums` sur tout montant/date affiché ; formatage via `format-montant.ts` /
      `format-date.ts` — aucun formateur local.
- [ ] Header **sans `flex-wrap`**, condensation sous le breakpoint.
- [ ] `SyncSummary` et `Callout` **purs** : zéro fetch, zéro état, handlers en props.
- [ ] Démo `demo/dashboard-states` monte le **vrai** `SyncSummary` (fin de la duplication
      + du littéral mort « Comptes à jour. ») ; `demo/banque-connexion` couvre l'erreur habillée.
- [ ] **Gate 4** : captures headless des états succès / partiel / à reconnecter /
      non-rattachées / erreur de connexion, comparées PAR VISION à §3.4 / §3.7 / §6.5.
- [ ] `npm run lint` + `npm run typecheck` **verts** (règle 5).
- [ ] `WIDGET-ERR3` fermé dans `TODOS.md` ; `UI-CALLOUT-MIGRATION1` ouvert.
- [ ] **Deux commits logiques** (bandeau / erreur widget). **STOP à la PR poussée** —
      code applicatif, pas d'auto-merge (Human-in-the-Loop).

## 5. Hors périmètre (explicite)

- Ajouter des champs à `EtatFinalisation` (arbitrage §0.2).
- Réintroduire le CTA « Reconnecter » sur la pastille (décision produit §0.3).
- Migrer les 4 callouts ad-hoc existants (→ TODOS `UI-CALLOUT-MIGRATION1`).
- Toute modification de `messages-sync.ts`, `registre-synchro.ts`, `actions.ts`.
