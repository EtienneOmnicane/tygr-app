# Vendoring de `@omni-fi/react-link` — note de sécurité

**TL;DR : `vendor/omni-fi-react-link/` contient du code tiers BUILDÉ, NON AUDITÉ et
NON REPRODUCTIBLE, intégré pour DÉBLOQUER LA DÉMO. À remplacer par le package publié
dès qu'il existe (dette P1, cf. `TODOS.md`).**

## Pourquoi ce dossier existe

Le widget natif Omni-FI (`@omni-fi/react-link`) est requis pour la connexion bancaire
(hook `useOmniFILink`). Au 2026-06-16 :

- il **n'est publié sur aucun registre npm** (public ou privé) — `npm install
  @omni-fi/react-link` → 404 ;
- son dépôt GitHub (`omni-fi-app/omni-fi-react-link`) **ne committe pas le `dist/`**
  (généré par `tsup` ; `package.json` → `"files": ["dist", …]` mais le build n'est pas
  versionné), donc une install `github:` récupère une coquille non importable.

Faute de source d'installation officielle, le package a été **buildé localement puis
copié** dans ce dossier, et installé via `"@omni-fi/react-link": "file:vendor/omni-fi-react-link"`.

## Comment il a été produit (NON reproductible en l'état)

1. `git clone omni-fi-app/omni-fi-react-link`
2. `bun install && bun run build` (génère `dist/` via tsup)
3. copie de `dist/` + métadonnées dans `vendor/omni-fi-react-link/`
4. `npm install ./vendor/omni-fi-react-link`

⚠️ Le `dist/` ici présent a été généré sur une machine de dev à un instant T. Il n'y a
**aucune garantie de reproductibilité** (pas de lockfile du build amont, pas de hash de
provenance). Un reviewer ne peut pas re-générer ce bundle à l'identique pour le vérifier.

## Risques acceptés (pour la démo uniquement)

- **Supply chain / code opaque** : on intègre un bundle JS tiers non audité ligne à
  ligne dans un repo qui manipule des **secrets bancaires** (flux Link / PublicToken).
- **Confiance runtime partielle** : même vendoré, le widget **charge un script depuis
  le CDN Omni-FI** (`getScriptUrl` → `*-cdn.omni-fi.co/v1/omni-fi-connect.js`). Le code
  réellement exécuté côté navigateur vient en partie du CDN, pas de ce dossier. Le
  vendoring ne résout que la **résolution de build**, pas la confiance du code distant.
- **Dérive** : fork figé ; ne reçoit pas les correctifs amont.

## Mitigations en place

- Aucun secret n'est lu/exposé par le package côté serveur ; le hook tourne en
  `ssr:false` (client uniquement).
- Le `publicToken` n'est jamais loggé ; la finalisation se fait côté serveur (règle 8).
- L'origine de redirection (cible postMessage du PublicToken) est validée par allowlist
  serveur fail-closed (`src/server/widget/redirect-origin.ts`).

## Sortie de dette (OBLIGATOIRE)

Dès qu'Omni-FI **publie** le package (npm public ou registre privé d'entreprise) :

1. `npm install @omni-fi/react-link@<version-publiée>` (remplace la dépendance `file:`).
2. Supprimer `vendor/omni-fi-react-link/` et ce fichier.
3. Re-valider le parcours critique (build + flux de connexion) — cf. dette P1 `TODOS.md`.

Idéalement, demander au repo amont d'ajouter un script `prepare` (build à l'install) ou
de publier le `dist/`, ce qui rendrait tout ce vendoring inutile.
