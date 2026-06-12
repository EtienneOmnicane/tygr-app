# SPEC — Refactorisation de l'arborescence vers le modèle cible

> Statut : **EN ATTENTE D'APPROBATION HUMAINE** — aucun déplacement avant
> (CLAUDE.md règle 1). Branche d'exécution : `refactor/arborescence`.
> Référence : rapport EM du 2026-06-12 (arborescence cible + plan en 5 étapes
> déjà présentés et validés sur le principe).

## Contexte

L'auth est sécurisée et auditée (CSO + revue Eng). Avant d'ajouter de la
complexité (PR 2 sélecteur de workspace, Epic 3.1 matrice), on veut une
arborescence compartimentée : présentation / back-end / data / utilitaires purs,
avec des frontières **vérifiables par le linter** plutôt que par discipline.

## État actuel vérifié (2026-06-12, main @ 7eb05d0)

```
src/
├── app/                         # routes (login, api/auth, accueil)
├── auth.ts                      # config Auth.js (racine — flotte)
├── db/{index,schema}.ts         # connexion + schéma Drizzle
├── lib/
│   ├── tenancy.ts               # withWorkspace (I/O)
│   └── auth/{lockout,rate-limit-ip,session,verifier-identifiants}.ts
├── proxy.ts                     # convention Next 16 (reste à la racine de src/)
├── repositories/identite.ts
└── types/next-auth.d.ts
```

**Alias :** `tsconfig.json` → `@/* : ./src/*` ; `vitest.config.ts` →
`@ : src`. **Conséquence dure : déplacer un fichier change son chemin d'import**
(`@/db` → `@/server/db`). Un `git mv` seul casse la compilation ; chaque étape
réécrit les imports `@/…` correspondants.

**Graphe d'imports actuel (occurrences à réécrire) :**

| Import | Occurrences | Devient |
|---|---|---|
| `@/db/schema` | 7 | `@/server/db/schema` |
| `@/repositories/identite` | 6 | `@/server/repositories/identite` |
| `@/lib/auth/lockout` | 5 | `@/server/auth/lockout` |
| `@/auth` | 5 | `@/server/auth/config` |
| `@/lib/tenancy` | 4 | `@/server/db/tenancy` |
| `@/lib/auth/rate-limit-ip` | 4 | `@/server/auth/rate-limit-ip` |
| `@/lib/auth/verifier-identifiants` | 3 | `@/server/auth/verifier-identifiants` |
| `@/db` | 3 | `@/server/db` |
| `@/lib/auth/session` | 1 | `@/server/auth/session` |

## Arborescence cible

```
src/
├── app/                         # PRÉSENTATION — routes/layouts/pages uniquement
│   ├── login/                   #   (groupes de routes (public)/(workspace) = hors
│   ├── api/auth/[...nextauth]/  #    périmètre, traités au build UI — voir Hors scope)
│   ├── layout.tsx · page.tsx · globals.css
├── components/                  # UI partagée (vide au départ — créée avec PR 2/UI)
├── server/                      # BACK-END — jamais importé par du code "use client"
│   ├── auth/
│   │   ├── config.ts            #   ex-src/auth.ts (renommé : "config" > "auth/auth")
│   │   ├── lockout.ts
│   │   ├── rate-limit-ip.ts
│   │   ├── session.ts
│   │   └── verifier-identifiants.ts
│   ├── db/
│   │   ├── index.ts · schema.ts
│   │   └── tenancy.ts           #   ex-src/lib/tenancy.ts (I/O = back-end)
│   └── repositories/identite.ts
├── lib/                         # utilitaires PURS isomorphes (zéro I/O)
│   └── (vide au départ — accueillera format-montant, dates Maurice au build UI)
├── proxy.ts                     # RESTE à la racine de src/ (convention Next 16)
└── types/next-auth.d.ts         # RESTE (augmentation de types globale)
```

**Décisions tranchées (zéro choix laissé à l'exécution) :**

| # | Sujet | Décision |
|---|---|---|
| B1 | `src/auth.ts` | → `src/server/auth/config.ts`. Renommé `config` pour éviter `server/auth/auth.ts` ; la route `[...nextauth]` importe `@/server/auth/config`. |
| B2 | `lib/tenancy.ts` | → `server/db/tenancy.ts`. C'est de l'I/O (transactions, `set_config`), sa place est en `server/`, pas en `lib/` (réservé au pur). |
| B3 | `lib/auth/*` | → `server/auth/*` (aplati : plus de sous-dossier `auth/auth`). |
| B4 | `lib/` | **vidé** au terme du refacto. Réservé aux purs isomorphes à venir (format-montant). Pas supprimé : le dossier reste, vide, avec un `.gitkeep` ou prêt à recevoir. |
| B5 | `proxy.ts`, `types/` | **ne bougent pas** (contraintes Next / résolution de types globale). |
| B6 | Alias tsconfig/vitest | **inchangés** (`@/* : src/*`). On ne touche NI tsconfig NI vitest.config : seuls les chemins après `@/` changent. Réduit la surface de risque. |
| B7 | Tests | `tests/` ne bouge pas d'emplacement ; seuls ses imports `@/…` sont réécrits, en même temps que le code qu'ils visent. |

## Plan de migration — 5 étapes, 5 commits atomiques

**Invariant absolu (règle d'exécution imposée) : après CHAQUE étape, lancer
`npm run lint && npm run typecheck`. Échec compilation ou import cassé →
stop-loss immédiat : `git reset --hard HEAD~1` (rollback du dernier commit),
arrêt de la boucle, rapport.** Chaque étape est purement mécanique (déplacement
+ réécriture d'imports), zéro changement de logique. `git mv` pour préserver
l'historique. Rollback d'une étape = revert d'un commit.

### Étape 1 — Garde-fous de frontière AVANT tout déplacement
- Aucune réécriture de chemin. On installe les barrières sur l'arbre **actuel** :
  règle ESLint `no-restricted-imports` interdisant l'import du client DB
  (`@/db`, futur `@/server/db`) hors `server/`+`repositories/`, et l'import de
  tout module `server/` depuis un fichier `"use client"`.
- **But :** figer le comportement et **solder la dette P0 « règle lint anti
  accès DB ad-hoc »** ; si une frontière est déjà violée, on le découvre AVANT
  de déménager (et non au milieu).
- Gate : lint + tsc. Commit : `chore(lint): frontières d'import (anti accès DB ad-hoc, server/client)`.

### Étape 2 — Déplacer les modules PURS (risque nul, étalonnage)
- `git mv src/lib/auth/lockout.ts src/server/auth/lockout.ts` ;
  idem `rate-limit-ip.ts`. Zéro dépendance interne → réécriture d'imports
  minimale (les fichiers qui les importent : `verifier-identifiants.ts`,
  `identite.ts`, et leurs tests).
- Gate : lint + tsc. Commit : `refactor: déplace lockout + rate-limit-ip vers server/auth`.

### Étape 3 — Déplacer la couche DATA
- `git mv` : `src/db/* → src/server/db/*`, `src/lib/tenancy.ts →
  src/server/db/tenancy.ts`, `src/repositories/ → src/server/repositories/`.
- Réécrire tous les `@/db`, `@/db/schema`, `@/lib/tenancy`,
  `@/repositories/identite` (cf. tableau) dans le code ET les tests d'isolation.
- Gate : lint + tsc. Commit : `refactor: regroupe db + tenancy + repositories sous server/`.

### Étape 4 — Déplacer la couche AUTH applicative
- `git mv` : `src/auth.ts → src/server/auth/config.ts`,
  `src/lib/auth/{session,verifier-identifiants}.ts → src/server/auth/`.
- Réécrire `@/auth`, `@/lib/auth/session`, `@/lib/auth/verifier-identifiants`
  (code + tests). Mettre à jour la règle ESLint de l'étape 1 vers les chemins
  définitifs `server/`.
- Gate : lint + tsc. Commit : `refactor: regroupe la config Auth.js + session sous server/auth`.

### Étape 5 — Nettoyage structurel
- Supprimer les dossiers désormais vides (`src/lib/auth/`, `src/db/`,
  `src/repositories/`). Créer `src/components/` et garder `src/lib/` (vide,
  `.gitkeep`) pour le pur isomorphe à venir. Aucun déplacement de code.
- Gate : lint + tsc. Commit : `chore: nettoie l'arbo (dossiers vides, prépare components/ et lib/)`.

## Critères d'acceptation

1. `npm run lint`, `npm run typecheck`, `npm run build` ET `npm test` (52 tests)
   verts au terme de l'étape 5.
2. La suite anti-IDOR (8 + cas 9) passe inchangée dans sa logique — seuls ses
   imports ont bougé.
3. Zéro changement de comportement : `git diff main --stat` ne montre que des
   renommages + réécritures d'imports (aucune ligne de logique modifiée).
4. La règle ESLint de frontière est active et **échoue** si on tente d'importer
   `@/server/db` depuis un composant client (test manuel de la barrière).
5. `proxy.ts` et `next.config.ts` inchangés ; l'app démarre (`/login` 200).

## Hors scope (différé, entrées TODOS si nouveau)

- Groupes de routes `app/(public)`/`(workspace)` : au build UI / PR 2 (touche
  les URLs et la structure des layouts — mérite son propre lot).
- Peuplement de `lib/` (format-montant, dates Maurice) et `components/` :
  arrive avec le build UI (spec matrice VALIDATED_SHELVED).
- Refacto vers packages/monorepo hexagonal : écarté (surdimensionné).

## Rollback

Par étape : `git reset --hard HEAD~1` (le stop-loss imposé) ou revert du commit.
Global : revert des 5 commits, ou abandon de la branche `refactor/arborescence`.
Zéro migration DB, zéro dépendance ajoutée → rollback sans risque de données.

## Estimation

5 étapes × (git mv + réécriture imports + 2 gates) ≈ **1 h-1 h 30 CC**.

## Fichiers touchés (vue d'ensemble)

Déplacés : `auth.ts`, `db/index.ts`, `db/schema.ts`, `lib/tenancy.ts`,
`lib/auth/{lockout,rate-limit-ip,session,verifier-identifiants}.ts`,
`repositories/identite.ts` (9 fichiers). Imports réécrits : ~10 fichiers source
+ 6 fichiers de tests. Config créée : règle ESLint (étape 1). Inchangés :
`tsconfig.json`, `vitest.config.ts`, `next.config.ts`, `proxy.ts`, `types/`.
