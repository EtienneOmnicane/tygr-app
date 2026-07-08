# PLAN — Refonte de la page `/admin/entites` (sas de propositions + lisibilité)

> **Phase : conception (Règle 1).** Rien n'est codé sur la base de ce document tant
> qu'Etienne (PO) ne l'a pas validé. Il fixe le périmètre et les critères de sortie de
> l'implémentation qui suivra, dans un fil séparé.
>
> Décisions produit déjà actées (Etienne, via AskUserQuestion, 2026-07-08) intégrées
> ci-dessous. Le correctif du sélecteur « Vue » (Problème 1) est **hors de ce plan** :
> déjà livré sur la branche `fix/selecteur-vue-comptes` (petit correctif, exception
> Règle 1).

## 1. Contexte & problèmes constatés

La page ADMIN `/admin/entites` porte deux sections : le **sas de propositions**
Party → entité (`propositions.tsx`, ENTITY-PARTY1) et l'**assignation de périmètre**
par membre (`assignation-entites.tsx`). Etienne a remonté quatre gênes, toutes sur le
sas de propositions :

1. **« Account Holder » = liste interminable de devises.** Une proposition (une
   `parties.name`) regroupe beaucoup de comptes dont le `account_name` remonté par
   Omni-FI est **vide** (colonne `NOT NULL`, mais Omni-FI renvoie une chaîne vide).
   Faute de libellé, la ligne n'affiche que la pastille de devise → une colonne de
   « Rs / $ / € » sans signification, non défilable, non regroupable.
2. **Le menu déroulant « Entité cible » est un `<select>` natif** (moche, hors design
   system).
3. **« On clique Confirmer et ça ne change pas grand-chose. »** L'action pose bien les
   `entity_id`, mais la carte reste affichée à l'identique dans la session → l'ADMIN a
   l'impression de pouvoir **réassigner à l'infini** sans effet.
4. **« Et si l'admin n'est pas d'accord pour un compte ? »** Aujourd'hui : décocher le
   compte avant Confirmer suffit à le laisser non assigné — mais **aucun refus n'est
   mémorisé**.

Rappel du modèle (mesuré) : ~28 parties, ~77 liens compte↔party en prod. Le seul
identifiant de repli disponible en base est `bank_accounts.omnifi_account_id`
(varchar 64) — **il n'existe ni n° de compte ni IBAN** dans le schéma.

## 2. Décisions produit actées (Etienne, 2026-07-08)

- **Nom du bouton « Vue » :** « Groupe » → **« Tous les comptes »** (onglet Par compte)
  et **« Toutes les entités »** (onglet Par entité). ✅ **Déjà livré**
  (`fix/selecteur-vue-comptes`). Hors de ce plan.
- **Refus d'un compte par l'ADMIN : « laisser non-assigné » (option simple).**
  Décocher le compte avant Confirmer suffit ; le compte reste `entity_id = NULL`,
  donc **invisible en Vision Entité** (fail-closed) et visible seulement de l'ADMIN en
  Vision Globale.
  - **Aucune migration.** Pas de champ « refusé/ignoré » en base.
  - **Compromis assumé, à documenter dans l'UI :** un compte laissé non assigné
    **réapparaîtra** dans la proposition au prochain sync (pas de mémoire du « non »).
    C'est acceptable car le cas est rarissime (mot d'Etienne) et le compte reste
    inoffensif (invisible en Vision Entité).
  - Conséquence : **on ne réserve pas** de comportement de « refus persistant » ; si
    le besoin apparaît plus tard, ce sera une dette P2 nommée (champ + migration), pas
    ce chantier.
- **Libellé de repli (compte sans nom) — tranché :** `« Compte sans libellé · …{4
  derniers chiffres de `omnifiAccountId`} · {devise} »`. On **garde** l'identifiant
  (4 chiffres) — Etienne ne veut pas le masquer — suivi de la devise. C'est un
  libellé, jamais un montant → `truncate` autorisé (Règle 8).
- **Vocabulaire « Party » → « Titulaire » : question CLOSE (sans objet).** Etienne
  retraduira toute l'UI en anglais en toute fin de projet ; le choix du terme FR
  intermédiaire n'a pas d'enjeu. On garde le libellé le plus clair sur le moment,
  sans en faire un point de blocage.
- **Ordre de travail : plan écrit d'abord** (ce document), validation, puis code.

## 3. Périmètre du chantier (lots)

### Lot 1 — Lisibilité des comptes sans nom (serveur léger + UI)

**Serveur (`repositories/entites.ts`, `listerPropositionsPartyEntite`) :**

- Ajouter `omnifiAccountId` à la projection des comptes (`CompteDeProposition`) et au
  type UI `CompteVue`. Aucune requête supplémentaire (colonne déjà sur `bank_accounts`,
  déjà jointe). Toujours sous RLS + join `bank_accounts` (ENTITY-READ-JOIN1 respecté).

**UI (`propositions.tsx`) :**

- **Libellé de repli** quand `accountName.trim() === ""` : afficher
  `« Compte sans libellé · …{4 derniers de omnifiAccountId} · {devise} »` (décision
  Etienne 2026-07-08 : on garde les 4 chiffres, on ajoute la devise). Le libellé n'est
  jamais un chiffre financier → `truncate` autorisé (Règle 8 : seuls les **montants**
  ne se tronquent pas ; ici pas de montant du tout sur cette page).
- **Liste défilable + compacte** : conteneur `max-h` + `overflow-y-auto` (calqué sur
  la listbox du `perimetre-switcher`, `max-h-64`), pour qu'une party à 40 comptes ne
  déroule pas la page.
- **« Tout cocher / tout décocher »** en tête de la liste de comptes (case tri-état,
  réutiliser le pattern `etatSelectionGroupe` / `basculerGroupe` de
  `lib/grouper-titulaire.ts` — pas de nouvelle logique). Sans ça, écarter 1 compte sur
  40 impose 39 clics.
- **Compteur** « N comptes · M cochés » (jamais de solde agrégé — Règle 8).

**Différé (P2, entrée TODOS.md, NON bloquant) :** comprendre pourquoi Omni-FI regroupe
autant de comptes sans nom sous une party générique « Account Holder » (donnée amont
fourre-tout). Déclencheur de résolution : première vraie connexion bancaire de
production avec des libellés réels. N'entre pas dans ce chantier.

### Lot 2 — Menu déroulant → composant `ui/select`

- Remplacer le `<select>` natif « Entité cible » (`propositions.tsx`, ~l.168-184) par
  le composant maison **`ui/select`** (accessible, tokens UI_GUIDELINES).
- **Contrainte d'ordre (dépendance de branche) :** `ui/select` vit sur
  `feat/select-personnalise` (pas encore dans `main`). Donc la branche de cette
  refonte doit partir de `main` **après** merge de `feat/select-personnalise`, ou être
  empilée dessus. À trancher au moment de brancher (Human-in-the-Loop : partir d'un
  `main` à jour).
- `assignation-entites.tsx` **n'a pas de `<select>` natif** (cases à cocher + radios
  stylés) → rien à faire de ce côté.

### Lot 3 — Feedback après Confirmer (fin de la « réassignation à l'infini »)

Sans migration (décision « simple ») :

- Après `etat.succes`, **basculer la carte en état « traité » côté client** (session) :
  la replier et la désactiver, avec un état succès clair
  (« ✓ Rattachée à {entité} — {N} compte(s) »). Un `useState` local « traité » suffit ;
  à la prochaine navigation, le serveur renvoie `entiteDejaRattacheeId` à jour et la
  carte reflète la réalité.
- **Resserrer `peutConfirmer`** : le bouton n'est actif que s'il y a un **vrai
  changement** à appliquer (cible différente de l'entité déjà rattachée **ou** au moins
  un compte à (dé)rattacher). Aujourd'hui il reste actif même sans changement → source
  de l'impression « à l'infini ».
- Le message de succès rappelle le compromis Lot-4 : « Les comptes décochés restent non
  assignés (visibles de l'admin, invisibles en Vision Entité). »

### Lot 4 — Polish visuel (« pas jolie »)

- Aligner les cartes de proposition sur le style des cartes d'`assignation-entites`
  (`rounded-card`, `shadow-card`, densités, en-tête clair), tokens sémantiques
  uniquement (aucune couleur en dur ; vert/rouge réservés à la donnée).
- Clarifier le vocabulaire pour un ADMIN non technique : remplacer « Party » (jargon
  Omni-FI) par un terme métier dans l'UI (**« Titulaire »** proposé). **À confirmer**
  par Etienne — c'est un choix de libellé, pas d'archi.
- Soigner l'**état vide** (déjà présent) et ajouter un **état succès** distinct.

## 4. Invariants non négociables (rappels — à ne pas casser)

- **ENTITY-PARTY1 :** le sas reste le **seul** chemin qui pose un `entity_id` dérivé
  d'une party ; l'ingestion n'en pose jamais ; un re-sync ne réécrase pas un
  `entity_id` déjà posé. Aucune écriture automatique.
- **Gates d'écriture inchangées :** tout passe par `confirmerPropositionAction` →
  `withWorkspace` → garde ADMIN du repo + RLS tenant + `entity_scope` RESTRICTIVE + FK
  composites. **Aucun nouveau chemin d'assignation** n'est ouvert par ce chantier.
- **Aucune migration**, aucun nouveau champ, aucune table touchée (décision « simple »).
- **Aucun montant** affiché sur cette page → pas de surface Règle 8, mais la règle
  « on ne tronque pas un chiffre » reste (ici on ne tronque que des libellés).
- Le **filtre de périmètre vit dans la RLS**, jamais dans le `.tsx`.

## 5. Critères de sortie (Règles 3/4/5/6)

- [ ] `npm run lint` + `npm run typecheck` verts (stop-loss Règle 5).
- [ ] Serveur : projection `omnifiAccountId` ajoutée sans requête N+1 ; type UI mis à
      jour ; aucun accès DB hors `withWorkspace`.
- [ ] `propositions.tsx` : `ui/select`, libellé de repli, liste défilable + tout
      cocher/décocher, feedback « traité », `peutConfirmer` resserré.
- [ ] **Visual QA (Gate 4)** : captures des états (vide / liste longue / après
      Confirmer / erreur) comparées à `docs/UI_GUIDELINES.md`. Route de démo si
      possible (hors auth/DB).
- [ ] **Revue fraîche (Règle 6)** : subagent/contexte indépendant, mandat IDOR /
      chemin d'écriture / respect ENTITY-PARTY1.
- [ ] Aucune régression du chemin `confirmerPropositionAction` (tests existants verts).
- [ ] Entrée TODOS.md pour le différé P2 (comptes sans nom « Account Holder »).

## 6. Livraison & branches (Human-in-the-Loop)

- Branche `feat/refonte-entites` depuis `main` à jour **après** merge de
  `feat/select-personnalise` (dépendance `ui/select`), ou empilée dessus.
- L'agent s'arrête à la **PR poussée** (PR applicative → merge humain). Validations
  humaines : Visual QA des écrans + cohérence du vocabulaire (« Titulaire »).

## 7. Questions ouvertes pour Etienne (avant implémentation)

1. ~~**Vocabulaire :** « Party » → « Titulaire » ?~~ **CLOSE (2026-07-08).** Sans objet :
   retraduction complète en anglais en fin de projet.
2. ~~**Libellé de repli :** garder l'identifiant ou le masquer ?~~ **TRANCHÉ
   (2026-07-08).** `« Compte sans libellé · …{4 derniers chiffres de l'id} · {devise} »` —
   on garde les 4 chiffres, on ajoute la devise.
3. **(SEULE QUESTION OUVERTE)** Le compromis « re-proposé au prochain sync » est-il
   acceptable tel quel, avec un simple texte d'aide qui l'explique dans le sas, ou
   veux-tu autre chose ? (Rappel : décocher = `entity_id NULL`, réapparaît au sync
   suivant, pas de mémoire du « non ».)
