# PLAN — Chantier B : hygiène des catégories (feedback 0709)

- **Branche** : `feat/categories-hygiene` (worktree `.worktrees/categories`, depuis `main`)
- **Source** : `docs/specs/FEEDBACK-retours-etienne-2026-07-09.md` (items 4, 5)
- **IDs TODOS** : FB0709-CAT-PICKER-FRAICHEUR1, FB0709-CAT-DOUBLONS1, FB0709-CAT-RENOMMER1, FB0709-REGLES-CASSE1, FB0709-REGLES-LIEN1
- **Statut grounding** : fait (2026-07-09) sur `main`.

## B1 — FB0709-CAT-PICKER-FRAICHEUR1 : catégorie créée absente du picker

**Root cause confirmée** : `category-picker.tsx` (src/components/ui/category/,
:48-212) est purement présentationnel — il filtre localement la prop
`categories` (:125-131) et ne re-fetch jamais. `creerCategorieAction`
(`src/app/(workspace)/transactions/actions.ts:231-248`) crée bien la catégorie
(d'où sa présence dans Règles), mais le CONTENEUR ne réinjecte pas la liste à
jour → picker périmé.

Modif : dans le conteneur du picker (feature /transactions), après un
`onCreate` réussi : re-lister les catégories (action existante de listing) et
re-passer la prop, OU ajouter localement la catégorie retournée par l'action
(optimiste + cohérent). Choix : **réinjection depuis le retour de l'action**
(la création retourne l'objet créé → l'append local évite un round-trip),
avec re-fetch au prochain montage. Le picker reste pur.

Test : cas conteneur (la liste passée au picker contient la catégorie créée).

## B2 — FB0709-CAT-DOUBLONS1 : unicité insensible à la casse + dédoublonnage

**Constat schéma** (`src/server/db/schema.ts:566-569`) : UNIQUE
`(workspace_id, name, parent_id)` — deux failles :
1. **Casse** : varchar sensible à la casse → « VAT » / « vat » distincts.
2. **NULL** : `parent_id` NULL ⇒ NULL ≠ NULL ⇒ deux racines « VAT » identiques
   passent la contrainte. C'est le bug observé par Etienne.

Modifs :
1. **Migration** (expand-contract, backward-compatible N-1) :
   - Index unique fonctionnel : `UNIQUE (workspace_id, LOWER(name), COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'))`
     (ou `NULLS NOT DISTINCT` si la version PG de Neon le permet — vérifier ;
     le COALESCE est le repli portable).
   - **Dédoublonnage AVANT pose de l'index** : les doublons existants
     (même workspace, LOWER(name) égal, même parent effectif) sont fusionnés —
     garder la plus ancienne (created_at min), re-pointer les références
     (ventilations de transactions, règles `categoryId`) vers la survivante par
     UPDATE (jamais de DELETE sur l'append-only ; les catégories elles-mêmes
     sont des tables normales → le doublon vidé est supprimé ou `is_active=false`
     selon la liste blanche DELETE — vérifier que `categories` y figure ; sinon
     archivage).
2. **Validation applicative** : `creerCategorieAction` + repo : vérifier
   l'existence insensible à la casse AVANT insert → erreur nommée
   `CATEGORIE_DEJA_EXISTANTE` mappée UI (« Cette catégorie existe déjà »).
   Idem au renommage (B3).

Tests : création doublon exact / doublon de casse / doublon racine (parent
NULL) → rejet nommé ; migration idempotente (si testable hors DB, sinon revue).

## B3 — FB0709-CAT-RENOMMER1 : renommer une catégorie (UI)

Le serveur EXISTE déjà : `renommerCategorie`
(`src/server/repositories/categorisation.ts:530-552`) + `renommerCategorieAction`
(`transactions/actions.ts:272-290`, garde ADMIN via `exigerAdminReferentiel`).
Manque : l'**UI**. Modif : entrée « Renommer » dans l'UI de gestion des
catégories (là où le picker/le référentiel les liste), dialog avec input
(zod : trim, min 1, max existant), erreurs mappées (dont
`CATEGORIE_DEJA_EXISTANTE` de B2). Garde ADMIN déjà en place côté serveur ;
l'UI masque l'action aux non-ADMIN (le serveur reste la vraie garde).

## B4 — FB0709-REGLES-CASSE1 : casse règles ↔ catégories

**Constat** : le matching des règles est DÉJÀ insensible à la casse — ILIKE +
escape (`src/server/repositories/regles-categorisation.ts:462-482`), et les
règles référencent les catégories par **UUID**, pas par nom. La casse perçue
par Etienne vient des DOUBLONS de catégories (B2) : « VAT » et « Vat » sont deux
catégories distinctes, donc règles et picker semblent incohérents.

Modif : B2 règle la cause. Ici : **vérification** + test explicite que
`trouverRegleQuiMatche` matche indépendamment de la casse du libellé ET du
motif ; si un chemin sensible à la casse est découvert pendant
l'implémentation (ex. recherche de catégorie par nom quelque part), le corriger
dans ce chantier. Sinon consigner « déjà conforme » dans le commit.

## B5 — FB0709-REGLES-LIEN1 : lien direct catégorisation → création de règle

**Constat** : aucun deep-link aujourd'hui (`regles/page.tsx` ne lit pas
`searchParams` ; `RegleForm` n'accepte que `valeurInitiale` en édition —
`src/components/regles/regle-form.tsx:58-84`).

Modifs :
1. `regles/page.tsx` (RSC) : lire `searchParams` `?nouvelle=1&motif=<pattern>&categorie=<uuid>`
   — validation zod stricte (motif max length aligné sur le schéma règles,
   catégorie UUID optionnelle, valeurs inconnues ignorées silencieusement).
2. `ReglesFeature` : prop initiale « formulaire de création pré-rempli ouvert ».
3. Côté catégorisation (/transactions) : bouton/lien « Créer une règle » dans
   le flux de catégorisation, construisant l'URL avec le libellé nettoyé de la
   transaction (`cleanLabel`) comme motif pré-rempli. **PII** : le motif passe
   en query param → utiliser `cleanLabel` uniquement (jamais `bank_label_raw`),
   et ne jamais logger l'URL avec son motif côté serveur (règle 8).

Exit criteria route (règle 3) : validation zod stricte des searchParams, aucun
oracle (une catégorie d'un autre tenant en query → simplement ignorée, le
formulaire s'ouvre sans pré-sélection), pas de nouveau endpoint.

## Gates & HITL

- Migration = changement de schéma → PR applicative, merge humain obligatoire.
- Gates sandbox : lint, tsc, build, vitest non-DB ; suite isolation à jour si
  un chemin de données change (B2 ne touche pas la RLS — contraintes only).
- Revue contradictoire à contexte frais ; Visual QA (picker, dialog renommage,
  formulaire règles pré-rempli) = Etienne.
- Commits locaux ; pas de push sandbox.

## Hors périmètre

Hiérarchie CATÉGORIE → SOUS-CATÉGORIE (FYGR) → `PLAN-sous-categories.md` (P2) —
mais B2 pose l'unicité par niveau (parent_id dans l'index) SANS bloquer cette
évolution.
