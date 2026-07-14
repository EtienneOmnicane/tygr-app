# PLAN — TX-STATUT-SELECT-LAYOUT1 : le popover du `Select` passe en portal `fixed`

> Chantier B1 (P2, backlog du 2026-07-13). Branche `fix/select-layout-shift`, partie de `main`.
> Règle 1 : plan AVANT code (composant PARTAGÉ, >20 lignes). Revue contradictoire en contexte
> FRAIS après implémentation (registre en §5). Livraison : STOP à la PR (Human-in-the-Loop).

## 1. Diagnostic — la cause n'était pas celle supposée au ticket

Le ticket supposait « une mesure de largeur qui réserve puis retire l'espace de la scrollbar ».
La mesure au navigateur dit autre chose :

- `select.tsx` rendait son menu en `position: absolute`, donc **enfant du conteneur du trigger** ;
- le groupe de filtres de `/transactions` est `overflow-x-auto` (`transactions-toolbar.tsx:156`) ;
- **en CSS, dès que `overflow-x` ne vaut plus `visible`, `overflow-y` est forcé de `visible` à
  `auto`** (CSS Overflow 3 §3.5). La toolbar est donc scrollable VERTICALEMENT ;
- à l'ouverture, le menu (288px) déborde de la rangée (40px) → **la toolbar devient scrollable de
  142px** (mesuré) → scrollbar parasite. Le `scrollIntoView({block:"nearest"})` de l'option active
  fait ensuite défiler CE conteneur → la recherche et les deux champs de date sortent du champ de
  vision : le « saut de layout » signalé.

Le bug n'était donc PAS propre à `/transactions` : il était latent partout où un ancêtre clippe.
Deux autres cas, confirmés à la mesure (cf. §4) : le tableau d'assignation
(`assignation-comptes.tsx:339`) et la liste des suggestions en modale (`propositions.tsx:233`).

## 2. Fix — contenu au composant, sans changement d'API ni de token

Le menu est **portalé dans `document.body`** (`createPortal`, `react-dom` déjà au projet — zéro
dépendance ajoutée, règle 9) et positionné en **`position: fixed`** sur le rect du trigger. Un
`fixed` (a) échappe à TOUT ancêtre clippant ou scrollable, (b) est hors flux → il ne peut pas
créer de scrollbar de document. **La cause disparaît au lieu d'être contournée écran par écran.**

- **`src/components/ui/select/position-menu.ts` (nouveau, PUR)** — toute la géométrie, hors React
  et hors DOM, donc TESTABLE sans navigateur (convention maison : `allocation.ts`, `machine-mfa.ts` ;
  il n'y a pas de renderer React de test au projet). `calculerPositionMenu(rect, viewport)` :
  FLIP au-dessus si l'espace du bas est court ET que celui du haut est meilleur ; ancre et hauteur
  BORNÉES au viewport ; largeur ≥ trigger, plafonnée au bord droit ; `left` borné aux marges.
  Constantes miroir des anciennes classes (`MENU_MAX_PX=288` = `max-h-72`, etc.).
- **`select.tsx`** — mesure (`getBoundingClientRect`) et applique. Points durs :
  - **`ouvrir()` est la PORTE UNIQUE** : le menu ne se rend que si sa position est connue, donc
    un `setOuvert(true)` isolé ne l'afficherait pas (piège tombé une fois, sur le typeahead).
  - **Le clic-extérieur et l'Échap testent le conteneur OU le menu portalé** : ces écouteurs sont
    NATIFS, ils voient le DOM réel, où les deux sous-arbres sont désormais DISJOINTS. Sans ça,
    le `mousedown` sur une option passe pour un clic extérieur → démontage avant le `click` →
    **sélection impossible** ; et l'Échap fermerait la MODALE parente.
  - **Reposition au `scroll` en CAPTURE** (un `scroll` ne bulle pas) + `resize`, coalescés par rAF.
  - **Fermeture dès que le trigger n'est plus visible** (`IntersectionObserver`, racine = viewport :
    son rectangle d'intersection tient compte des clips d'ancêtres). Contrepartie nécessaire du
    `fixed` : sans elle, un trigger clippé laisse le menu ORPHELIN, flottant dans le vide.
  - **`z-[60]`** : le menu et l'overlay de la Modal sont maintenant deux portals FRÈRES sous `body`
    — à z-index égal, seul l'ordre du DOM les départagerait. (Avant le portal, le menu était
    DESCENDANT du contexte d'empilement de l'overlay : il passait toujours devant. Il n'y avait
    là aucun défaut de z-index — seulement le clipping.)

Non-régressions Modal vérifiées : l'overlay ne ferme que si `e.target === e.currentTarget` → un
clic sur une option portalée (qui reste descendante REACT de l'overlay) ne ferme pas la modale ;
le focus-trap interroge le panneau, or le focus ne quitte jamais le trigger (`aria-activedescendant`).

## 3. Effet de bord assumé

Le typeahead lit désormais l'horodatage de l'ÉVÉNEMENT (`e.timeStamp`) au lieu de `Date.now()` :
une fois le composant restructuré, le React Compiler l'analyse et refuse l'appel impur
(`react-hooks/purity`). C'est de toute façon la bonne source (l'instant de la SAISIE).

## 4. Preuves

- **Unitaire** — `tests/unit/select-position-menu.test.ts` (14 tests) : sens d'ouverture, FLIP,
  non-FLIP quand le haut est pire, bornage hauteur/largeur/`left`, trigger hors-vue (horizontal ET
  vertical), balayage d'invariant « le menu tient dans le viewport » pour toute position du trigger.
- **Visual QA (Gate 4)** — Edge headless (`playwright-core`, installé HORS du dépôt) sur le build de
  PRODUCTION, 7 fichiers appelants via les routes `/demo` (aucune route de démo à créer) :
  `/demo/transactions` (le bug), `/demo/assignation-comptes`, `/demo/admin-suggestions` (Select en
  MODALE), `/demo/echeances-states`, `/demo/regles-states`. États : fermé / ouvert / FLIP / modale.
  Le harnais ne fait pas que capturer, il MESURE l'invariant — et il a été rejoué sur le code
  d'ORIGINE pour prouver qu'il sait échouer :

  | Invariant mesuré à l'ouverture | Code d'origine | Après fix |
  |---|---|---|
  | L'ancêtre clippant devient scrollable | **5 instances** (toolbar : **0 → 142px**) | 0 |
  | Menu hors du viewport (options inatteignables) | **6 instances** (jusqu'à `bas=1033` pour 900) | 0 |
  | FLIP quand l'espace manque en bas | absent | OK |
  | Clic sur une option → sélectionne | OK | OK (non-régression du portal) |

  Restent 11 « clic → sélectionne » en échec, **identiques avant/après** : artefacts des pages de
  démo (`/demo/assignation-comptes` câble la VRAIE Server Action, qui échoue sans session ; et
  `echeances-list.tsx:98` ne commit PAS le statut « partiel », il révèle d'abord un champ).
- **Gates** — `lint`, `typecheck`, `npm test` (525+), `npm run build`.

## 5. Registre de revue contradictoire (2 réviseurs, contexte frais, règle 6)

| # | Constat | Confiance | Suite donnée |
|---|---|---|---|
| F1 | `top`/`bottom` jamais bornés au viewport : le menu SUIT le trigger au scroll → ancre négative → menu à cheval hors de l'écran, options inatteignables. **Le test affirmait l'invariant sans jamais l'exercer verticalement.** | 9/10 (×2, trouvé indépendamment) | **CORRIGÉ** : ancre bornée aux marges, hauteur déduite de l'ancre bornée. 3 tests ajoutés — ils échouaient sur le code d'avant. |
| F2 | Le `fixed` échappe au clip : quand le TRIGGER est clippé, le menu reste ORPHELIN sur une ancre invisible. | 8/10 | **CORRIGÉ** : `IntersectionObserver` → fermeture. |
| F3 | Le listbox portalé sort du sous-arbre `aria-modal` → options peut-être muettes au lecteur d'écran (1 instance : sas ADMIN). | 7/10 | **CONSIGNÉ P1** (`SELECT-MODALE-A11Y1`) : incertitude sur le comportement réel des AT, et les 2 correctifs candidats sortent du périmètre (API ou durcissement de la Modal). **Arbitrage humain demandé.** |
| F4 | `getBoundingClientRect` à chaque `scroll` (reflow forcé). | 6/10 | **CORRIGÉ** : coalescence rAF. |
| F5 | TODOS : « 12 tests » (il y en avait 11), « 7 instances » (7 FICHIERS / 14 occurrences). | 10/10 | **CORRIGÉ**. |
| R2 | TODOS : la rétro-analyse z-index (« menu à égalité avec l'overlay ») est FAUSSE — le menu était descendant du contexte d'empilement de l'overlay. | 10/10 | **CORRIGÉ** (un audit trail faux est pire que pas d'audit trail). |
| R2 | `workspace-switcher.tsx:60` : même famille de bug, hors `Select` (popover vers le bas depuis le bas d'une sidebar `overflow-y-auto`). | 9/10 | **CONSIGNÉ P2** (`SIDEBAR-SWITCHER-CLIP1`) — hors périmètre (règle 7), vérifié en lecture. |
| R2 | Aucune échelle de z-index documentée ; ce lot introduit le premier cran > 50. | 5/10 | **CONSIGNÉ P2** (`UI-ZINDEX-ECHELLE1`). |
| R2 | Docstring périmée (`max-h-72` n'existe plus). | 3/10 | **CORRIGÉ**. |

Vérifiés SANS constat par les réviseurs : pièges du portal (mousedown / Échap+capture /
`stopImmediatePropagation` / overlay synthétique / focus-trap), cycle de vie des écouteurs
(retrait avec le même flag `capture`), SSR & hydratation (rien de portalé au premier rendu),
pureté React Compiler, tokens (aucune couleur en dur, `shadow-popover` & co conservés verbatim),
API publique intacte (aucun des 7 appelants ne peut casser), zéro dépendance ajoutée,
`perimetre-switcher` et `category-picker` sains (aucun ancêtre clippant).
