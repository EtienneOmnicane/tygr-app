# PLAN — Refonte ergonomique du gestionnaire de catégories (Track T, UI pure)

**Branche** : `feat/cat-manager-ergonomie` (worktree `.worktrees/cat-ergonomie`, base `origin/main` @ 5d05368).
**Phase** : conception (règle 1). Aucune ligne de composant avant relecture indépendante.
**Domaine d'écriture** : `src/components/ui/category/category-manager-modal.tsx`,
`src/components/ui/category/category-manager-ligne.tsx` (nouveau), `src/app/demo/category-states/page.tsx`.
**Hors domaine (interdit)** : `globals.css`, `src/server/**`, `src/lib/**`, `transactions.ts`,
`transactions-feature.tsx`.

---

## 1. Contrat — INCHANGÉ

Signature préservée à l'identique : `{ open, onClose, categories, actions, onChanged }`.
Vérifié : `transactions-feature.tsx:528-534` monte la modale avec exactement ces 5 props →
**le conteneur n'est pas touché**. Aucune Server Action, aucun schéma, aucun fetch, aucun
état métier. La pré-validation locale (`doublonAuRenommage`, `messagePourCode`) est conservée
telle quelle — le serveur reste juge.

## 2. Structure de composants

| Fichier | Responsabilité |
|---|---|
| `category-manager-modal.tsx` | Orchestrateur : recherche, ouverture des groupes, création (racine + contextuelle), appels `actions`, erreur globale. Rend l'accordéon par Nature. |
| `category-manager-ligne.tsx` (nouveau) | `LigneCategorie` : 3 modes exclusifs — **lecture** / **édition** / **confirmation d'archivage**. Porte les boutons-icônes et l'erreur contextuelle. |

Découpage motivé par la taille : la ligne passe de 1 à 3 modes ; la laisser dans le fichier
modal produirait un fichier > 600 lignes. `index.ts` n'exporte pas la ligne (détail interne).

## 3. États à couvrir (checklist §6.5 — chacun capturé au Visual QA)

1. **Vide** — aucune catégorie : empty state §4.4 (illustration outline légère + message
   `text-muted` + **UN** CTA « ＋ Nouvelle Nature »). Jamais un « Aucune catégorie » sec.
2. **Peuplé** — accordéons par Nature, compteur « N sous-catégories » (singulier/pluriel géré).
3. **Recherche active** — champ en tête (loupe + bouton effacer) ; les groupes qui matchent
   se déplient automatiquement ; une sous-catégorie qui matche affiche sa Nature parente pour
   le contexte, même si la Nature ne matche pas.
4. **Recherche sans résultat** — message + lien « Effacer la recherche » (pas de cul-de-sac).
5. **Création racine** — formulaire révélé par « ＋ Nouvelle Nature » (en tête).
6. **Création contextuelle** — « ＋ ajouter une sous-catégorie » sous chaque Nature ouverte ;
   `parentId` déduit du point d'entrée. **Le `<select>` parent disparaît** (source de la
   confusion) ; la création à la racine reste possible via le CTA de tête.
7. **Édition** — renommage inline (existant conservé : select du texte, Enter/Escape).
8. **Confirmation d'archivage** — la ligne bascule : « Archiver « X » ? » + bouton `danger`
   « Archiver » + lien « Annuler ». Un clic ne détruit plus rien (§2.3 destructif =
   confirmation obligatoire). Pas de `window.confirm`.
9. **Erreur serveur** — bloc `danger-bg` + icône + message + `role="alert"` (§3.4), **placé
   au contact du geste** (dans la ligne pour renommer/archiver, sous le formulaire pour
   créer). Corrige un défaut actuel : l'erreur d'archivage s'affiche aujourd'hui en haut de
   la modale, à distance de la ligne concernée.
10. **Doublon (pré-validation locale)** — traitement §2.3 (bordure `danger` + message 12px
    sous le champ), **distinct** du bloc d'erreur système §3.4. Les deux ne se confondent pas.
11. **En cours** — `disabled` + opacité 48 %.

## 4. Conformité `docs/UI_GUIDELINES.md`

- **§4.4 modale** : titre uppercase centré, Escape + clic-overlay ferment, croix en haut à
  droite — fournis par la primitive `Modal` (`size="lg"` = 720px, conservé : le contenu est
  une liste à colonnes d'actions, pas un formulaire simple).
- **§4.4 dropdown riche** : la recherche en tête et l'indentation hiérarchique reprennent ce
  pattern, déjà appliqué au `CategoryPicker` → cohérence interne.
- **§2.3 hiérarchie** : « Créer » = `success` (validation dans une surface de confirmation) ;
  « ＋ Nouvelle Nature » / « ＋ ajouter une sous-catégorie » = **lien d'action** `primary` 600
  avec « + » ; « Archiver » (confirmation) = **destructif** `danger` ; « Annuler » = lien.
  **Un seul** bouton de rang primaire visible par surface.
- **§2.3 focus** : ring 2px `primary` offset 2px sur **tous** les contrôles, y compris les
  boutons-icônes révélés au hover.
- **§3.4 erreur ≠ sortie** : cf. état 9. Le `danger` reste réservé au geste destructif et aux
  erreurs — aucun rouge décoratif.
- **§2.2 densité** : lignes ~40px, contrôles h-40 pour la saisie, gap 12px.
- **Tokens uniquement** : `text-text`, `text-text-muted`, `text-text-faint`, `surface-inset`,
  `surface-card`, `line`, `primary`, `danger`, `danger-bg`, `success`. Zéro couleur en dur.
- **Zéro dépendance** (règle 9) : `cn` local + SVG inline (pas de lucide au projet).

## 5. Cibles de clic (point 5 du brief)

« Renommer » / « Archiver » passent de liens texte 12px à des **boutons-icônes 32×32**
(`h-8 w-8`, crayon / carton d'archive en SVG inline) avec `aria-label` explicite
(« Renommer la catégorie Électricité »), donc lisible au lecteur d'écran hors contexte.

Révélation : `opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100`.
Deux raisons de ne PAS se contenter de `group-hover` : (a) sans `focus-within`, la navigation
clavier ciblerait un bouton invisible ; (b) sans le `opacity-100` de base, les écrans tactiles
(aucun hover) n'auraient **jamais** accès aux actions. `opacity-0` conserve la focusabilité —
on ne rend jamais l'élément `hidden`.

## 6. Points durs identifiés (à prouver, pas à supposer)

- **Escape en mode édition / confirmation** : `Modal` écoute `keydown` sur `document`
  (`modal.tsx:109`). Aujourd'hui l'`onKeyDown` de la ligne ne stoppe pas la propagation →
  presser Escape pendant un renommage **ferme toute la modale** (défaut existant). Cible :
  Escape annule d'abord le mode local, et ne ferme la modale que si aucun mode local n'est
  actif. Le portail est monté sur `document.body`, donc un `stopPropagation` React devrait
  suffire (les deux listeners ne sont pas sur le même nœud) — **à vérifier au clavier réel
  en Visual QA**, pas à déduire ; repli `stopImmediatePropagation` sur l'événement natif.
- **Recherche et accents** : `toLocaleLowerCase("fr")` seul ne fait pas matcher « electricite »
  avec « Électricité ». Normalisation NFD + retrait des diacritiques, locale au composant
  (aucun rapport avec `format-montant`/`format-date`, dont la règle de source unique ne
  concerne que montants et dates).
- **`enCours` global** : un archivage désactive actuellement TOUTES les lignes. Conservé en
  l'état (le contrat `actions` est séquentiel et une modale de référentiel n'a pas de
  concurrence réelle) — signalé ici pour que la revue le confirme plutôt que de le découvrir.

## 7. Décision tranchée en revue : accordéons **REPLIÉS** par défaut

Ma recommandation initiale (« dépliés + Tout replier ») est **écartée** par la revue design,
sur des appuis plus forts que ma préférence :

- **Précédent interne documenté** : `UI_GUIDELINES.md:329` — la liste hiérarchique canonique
  du design system (matrice de flux §4.1) livre ses lignes repliées. Même structure ici.
- **Le brief lui-même** demande « une vue d'ensemble » (point 3) : c'est le repli qui la donne.
- **La découvrabilité est portée par le compteur** « N sous-catégories », pas par l'ouverture.
- **Le bruit du canal `primary`** : dépliés, 8 Natures produisent 8 liens « ＋ » + le CTA de
  tête + « Fermer » = 10 liens bleus dans 720px ; le rang « lien d'action » cesse d'attirer l'œil.

Conséquences : **pas** de contrôle « Tout replier » ni « Tout déplier » (la recherche est
l'instrument global) ; repli **sans exception conditionnelle** à la taille du référentiel ;
état d'ouverture éphémère (non persisté) ; chevron ▶/▼ + `aria-expanded` + `aria-controls`.

## 8. Arbitrages issus des deux revues indépendantes (2026-07-22)

Revue A (design system) et revue B (ergonomie / a11y), contextes frais, sans vue de mon
raisonnement. Ce qui est retenu et pourquoi :

**Corrections structurelles (le plan v1 était fautif) :**

- **A1/B3 — hauteur non bornée = contenu INATTEIGNABLE.** `Modal` verrouille le scroll du
  body (`modal.tsx:117`) et centre le panneau (`items-center`) sans `max-h` ni `overflow-y`.
  Un panneau plus haut que le viewport déborde **des deux côtés** : titre et recherche
  passent au-dessus du bord haut, hors de tout conteneur scrollable. Correctif : la liste
  d'accordéons est le SEUL conteneur scrollable (`max-h-[min(60vh,480px)] overflow-y-auto`),
  recherche et CTA de création restent en dehors. Pattern déjà au projet
  (`category-picker.tsx:164`).
- **A2 — le bloc d'erreur que je spécifiais échoue l'AA.** `text-danger` sur `danger-bg` =
  **4,40:1** (seuil 4,5). La primitive `Callout` encode déjà l'arbitrage (message en
  `text-text` = 11,46:1, sévérité portée par fond + icône). Correctif : réutiliser `Callout`
  au lieu de re-rouler un bloc — ce que la règle « pas de carte ad-hoc » demandait déjà.
- **B5 — l'Escape était accroché au mauvais nœud.** Le handler vit aujourd'hui sur l'`<input>`
  (`category-manager-modal.tsx:342`) : au Tab vers « Enregistrer », Escape ferme toute la
  modale ; et le mode confirmation n'a **aucun champ** sur quoi l'accrocher. Correctif :
  `onKeyDown` sur le conteneur de ligne (les événements React remontent l'arbre React).
- **B2/B6 — le focus tombe sur `<body>` à chaque sortie de mode**, et le trap de `Modal`
  (`modal.tsx:100-106`) ne teste que « premier » / « dernier » : depuis `body`, aucune branche
  ne matche et Tab part **derrière l'overlay**. Correctifs : destination de focus explicite
  après chaque transition (annulation → bouton « Renommer » ; archivage réussi → « ＋ ajouter »
  du groupe, sinon champ de recherche) ; `aria-disabled` au lieu de `disabled` sur les boutons
  de ligne, pour que l'élément focusé ne sorte pas de l'arbre d'accessibilité sous le doigt.
- **B4 — `md:` est une largeur, pas une capacité de survol.** iPad paysage / laptop tactile
  matchent `md:` sans hover : les actions resteraient à `opacity: 0` **définitivement**.
  Correctif : variant `pointer-fine` (vérifié présent, Tailwind 4.3.0), pas `md:`.

**Précisions retenues :** A3 « Archiver » confirmé = **texte** `danger` + `hover:bg-danger-bg`
(§2.3 rang destructif ; précédent `gestion-entites.tsx:134`), jamais un bouton plein — deux
boutons saturés vert + rouge dans la même surface effacent la hiérarchie, et l'archivage est
**réversible**. · A4 `text-primary font-semibold` (le « 600 » de §2.3 est une graisse, pas la
teinte `primary-600`). · A7 la révélation au survol s'applique **au seul mode lecture**. ·
B1 réinitialisation de l'état à **l'ouverture** (aujourd'hui l'erreur d'un geste abandonné
survit à la fermeture ; la recherche aggraverait le défaut). · B7 région live `role="status"`
**montée en permanence et vide**, remplie après chaque succès (sans elle, un archivage au
clavier = ligne disparue, focus perdu, silence total). · B8 le message de doublon perd son
`role="alert"` (il se ré-annonçait à **chaque frappe**) au profit de `aria-invalid` +
`aria-describedby` : la distinction §3.4 / §2.3 devient sémantique et non plus seulement
visuelle. · B11 `Set` local des ids mutés en attente du rafraîchissement parent — sinon un
second clic sur une ligne déjà archivée affiche « Catégorie introuvable » après un succès. ·
B13/B14 `aria-expanded`/`aria-controls` sur les en-têtes, `aria-label` sur la recherche.

**Décisions que je tranche (les revues divergeaient ou laissaient ouvert) :**

- **B9/B10 — mutation sous recherche active, et repli pendant une saisie.** Un **seul mode
  local actif à la fois**, porté par l'orchestrateur (`{ type: "edition" | "confirmation",
  categoryId } | null`). Replier un groupe qui le contient l'annule — exactement comme
  Escape ou « Annuler » : un renommage non validé n'est pas une donnée précieuse, et le
  comportement reste prévisible. La recherche n'est **jamais** effacée automatiquement (on
  enchaîne souvent plusieurs renommages sous le même filtre) ; c'est la région live qui lève
  l'ambiguïté, en signalant le cas où l'élément muté ne matche plus le filtre courant.
- **A5 — largeur.** Le désaccord (`sm` 480px vs `lg` 720px) se tranche par la **mesure**, pas
  par l'argument : je pars sur `sm` (§2.2 « formulaire simple », et toutes les autres modales
  du projet sont en `sm` ; à 720px, ~600px de vide séparent un libellé court de ses icônes,
  ce qui fait dériver d'une ligne entre « Renommer » et « Archiver »). Si le mode édition est
  à l'étroit à la capture, retour en `lg` — arbitré sur la capture, pas sur l'opinion.
- **B12 — clic-overlay.** Il détruit une saisie comme le faisait Escape, mais le corriger
  proprement (`dismissible` masque aussi la croix) exige de toucher `modal.tsx`, **hors
  domaine**. Traité : Escape dans ce lot, overlay consigné en TODOS.
- **A6 — « Créer » `success` ici vs `primary` dans le picker.** Les deux sont conformes
  séparément (surface de confirmation vs popover). Aucun changement de code ; c'est ma
  **rédaction** qui était trompeuse : la cohérence reprise du picker porte sur la recherche
  en tête et l'indentation, pas sur la hiérarchie des boutons.
- **B2 (volet hors domaine)** — le trap de `Modal` reste percé quand le focus est sur `body`,
  pour **toutes** les modales du projet. Hors domaine ici → TODOS, pas de correctif sauvage.

**Réfuté par la preuve, pas par l'autorité :** ma prudence sur Escape (§6) et sur la
fraîcheur du focus trap était infondée. Revue B l'a vérifié **en source** :
`next/dist/client/app-index.js:32` monte React sur `document` ; `react-dom` appelle
`listenToAllSupportedEvents` sur le conteneur du portail (`document.body`) ; `keydown` est
délégué. Le handler React s'exécute donc sur `body`, descendant strict de `document` → un
`stopPropagation` coupe bien la remontée vers le listener de `Modal`. `stopImmediatePropagation`
est **inutile**. Et `modal.tsx:94` fait son `querySelectorAll` **dans** le handler `keydown` :
les focusables sont recalculés à chaque Tab, aucune péremption possible. Deux conditions
invisibles à commenter dans le code : le portail doit rester descendant de `document`, et
`modal.tsx:109` doit rester en phase **bubble**.

## 9. Critères de sortie

- [ ] Contrat `{ open, onClose, categories, actions, onChanged }` intact ; `transactions-feature.tsx` non modifié (`git diff --name-only` le prouve).
- [ ] Les 11 états rendus sur `/demo/category-states` (dont un stub d'échec pour l'erreur serveur, un référentiel vide, et un référentiel volumineux pour la recherche).
- [ ] Captures headless comparées par vision à UI_GUIDELINES §6 (Gate 4).
- [ ] Escape en édition et en confirmation vérifié **au clavier**, pas au code.
- [ ] `npm run lint && npm run typecheck && npm run build` verts **avec `PWD` du worktree affiché** dans la même sortie (Gate 5).
- [ ] Aucune couleur en dur (`grep -nE '#[0-9a-fA-F]{3,6}|rgb\('` sur les fichiers touchés = vide).
- [ ] STOP à la PR poussée (Human-in-the-Loop : code applicatif → Etienne ouvre et merge).
