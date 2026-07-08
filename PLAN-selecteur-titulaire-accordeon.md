# PLAN — Sélecteur de périmètre groupé par titulaire (accordéon + sélection de groupe)

Phase : **conception** (règle 1). Référence : `PLAN-bandeau-titulaire-accordeon.md` (D6).
Branche cible : **`feat/bandeau-titulaire-accordeon`** (même PR — même story « groupement par titulaire »).

## 1. Contexte

Le bandeau gauche « Comptes connectés » est livré en accordéon par titulaire
(`connected-accounts-card.tsx`, D4). L'onglet **« Par compte »** du sélecteur de
périmètre (`perimetre-switcher.tsx`) n'a reçu, lui, que des **sous-en-têtes plats**
(D6) : pas de repli, pas de sélection de groupe, et le placeholder générique Omni-FI
**« Account Holder »** (77 comptes sur 87 en sandbox) reste **en tête** de la liste et
noie les titulaires réellement nommés (AIRPORT HOTEL, DYOSPOWER, OMNICANE…).

Objectif : donner au sélecteur le même niveau de finition que le bandeau, sans toucher
à la sémantique serveur ni à l'isolation.

## 2. Décisions (validées avec Etienne)

- **S1 — Accordéon repliable** dans « Par compte » : chaque groupe titulaire est un
  volet **repliable, REPLIÉ par défaut**. Repli mono-groupe (< 2 groupes) → liste plate
  historique (inchangé). Pendant une **recherche active**, les groupes s'affichent
  **DÉPLIÉS** (les correspondances doivent être visibles sans clic).
- **S2 — Case « tout cocher » par groupe, TRI-ÉTAT** (aucun / partiel = `indeterminate`
  / tous). Clic : si tous cochés → décoche le groupe ; sinon → coche tout le groupe.
  N'agit QUE sur des `bankAccountId` déjà présents dans `comptes` (périmètre RLS).
- **S3 — Ordre « nommés d'abord »** : titulaires réellement nommés en tête (alpha fr),
  puis le placeholder générique **« Account Holder »** relégué APRÈS les nommés, puis le
  bucket **« Non regroupé »** (holder `null`) toujours tout dernier. Implémenté dans le
  helper **PARTAGÉ** → cohérent bandeau + sélecteur.

## 3. Invariants (non négociables)

- **DISPLAY-ONLY (règle 2)** : le groupement ET la sélection de groupe sont du CONFORT
  client. Le serveur intersecte toujours le filtre avec le droit RLS ; la case de groupe
  ne peut que cocher des comptes **déjà visibles**. **Zéro** nouvel axe, **zéro** nouveau
  champ posté (`bankAccountId` uniquement), **zéro** nouvelle Server Action. Un oubli de
  filtre ne doit jamais pouvoir créer de fuite : la RLS reste le seul périmètre.
- **Règle 8** : aucune addition cross-devise dans les en-têtes de groupe — compteur
  « N comptes » uniquement, **jamais** de solde agrégé (idem D5).
- Repli/expand et tri-état sont de la VUE : aucune donnée dérivée du titulaire ne
  descend au serveur.
- La preuve DOM de L4 doit rester vraie : cocher un groupe poste **exactement** les
  mêmes `bankAccountId` que N clics individuels.

## 4. Lots

- **LS1 — Helper partagé** (`src/lib/grouper-titulaire.ts`) : ajouter la démotion du
  placeholder générique. `NOMS_TITULAIRE_GENERIQUES` (Set, comparaison `trim` + minuscule
  fr) = `{ "account holder" }`. Ordre final :
  `[nommés réels triés alpha] → [génériques triés alpha, gardant label + count] → [Non regroupé null]`.
  Le générique reste **un groupe propre** (label + compteur + sélection de groupe), il est
  seulement **repositionné**. Conserve le contrat de **conservation totale** (chaque compte
  ressort exactement une fois).
- **LS2 — Logique pure de sélection de groupe** (dans `grouper-titulaire.ts` ou un module
  voisin) : `etatSelectionGroupe(comptesDuGroupe, coches): "aucun" | "partiel" | "tous"` et
  `basculerGroupe(coches, comptesDuGroupe): Set<string>`. **PURES**, testées en isolation
  (pas de React).
- **LS3 — `perimetre-switcher.tsx`, onglet « Par compte »** : remplacer le rendu à
  sous-en-têtes plats (lignes ~400-426) par un **accordéon CONTRÔLÉ React** (état
  d'ouverture par groupe dans un `Set<string>` de clés de groupe). ⚠️ **Ne PAS** réutiliser
  `<details>/<summary>` natif ici : une checkbox contrôlée dans un `<summary>` entre en
  conflit d'événements (le clic sur la case togglerait le `<details>`). En-tête de groupe =
  `[checkbox tri-état] [chevron + nom titulaire (tronqué)] [N comptes]`. Repliés par défaut ;
  dépliés si recherche active. `optionCompte` **inchangé** (checkbox per-compte, inputs
  `bankAccountId` postés inchangés). Repli mono-groupe conservé (liste plate). L'onglet
  « Par entité » et l'option « Groupe » épinglée : **INCHANGÉS**.
- **LS4 — Preuve DOM** (comme L4) : au Visual QA, vérifier que cocher une case de groupe
  produit le même ensemble d'`<input hidden name="bankAccountId">` que les clics individuels
  équivalents.
- **LS5 — Visual QA (Gate 4)** : capturer les états — replié multi-groupes, un groupe
  déplié, tri-état (aucun / partiel / tous), recherche active (dépliée), repli mono-groupe.
  Comparer aux tokens `UI_GUIDELINES` (§4.4 dropdown riche ; `primary` pour l'actif, jamais
  vert/rouge de donnée ; focus visibles ; `indeterminate` lisible).

## 5. Tests

- **Helper (LS1)** : « Account Holder » trié APRÈS les nommés et AVANT « Non regroupé » ;
  insensible à la casse/aux espaces ; le générique reste un groupe propre (label + count) ;
  homonymes séparés ; conservation totale (somme des groupes = entrée).
- **Sélection de groupe (LS2)** : `etatSelectionGroupe` → aucun / partiel / tous ;
  `basculerGroupe` : tous→aucun, aucun/partiel→tous ; n'ajoute JAMAIS un id absent de
  `comptes` ; immutabilité (retourne un nouveau Set).

## 6. Hors scope

- Onglet **« Par entité »** : INCHANGÉ.
- **Pas** de solde agrégé par groupe (règle 8, D5).
- Bandeau gauche : mécanisme natif `<details>` **conservé** ; SEUL l'ordre change (effet
  de bord voulu du helper partagé S3 — « Account Holder » descend en bas là aussi, par
  cohérence). Si Etienne préfère laisser le bandeau tel quel, paramétrer la démotion
  (drapeau côté appelant) — sinon appliquer partout.

## 7. Dette

- **TITULAIRE-GENERIQUE1 (P2)** : sentinelle « Account Holder » en dur (PartyName par
  défaut d'Omni-FI en sandbox). Déclencheur de résolution : Omni-FI expose un flag de
  placeholder, OU la prod fournit de vrais `PartyName` (le cas générique disparaît alors).
  À retirer à ce moment-là. Effort : ~15 min.
