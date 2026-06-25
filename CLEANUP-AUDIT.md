# Rapport d'audit — Nettoyage du dépôt (PHASE 1, lecture seule)

> Branche dédiée : `chore/cleanup-repo` (créée depuis `origin/main`, **pas encore checkoutée**, working tree intact).
> **Aucune modification effectuée.** En attente de validation avant PHASE 2.
> Périmètre : dépôt applicatif `tygr-app/` (le vrai dépôt git de l'app, cf. directive racine).

---

## TL;DR — Le dépôt `tygr-app/` est déjà en très bon état

- ✅ **Aucun secret versionné** (ni suivi, ni dans les 218 commits d'historique).
- ✅ `.gitignore` complet et correct (env, build, logs, .DS_Store, .pem).
- ✅ Aucun fichier indésirable suivi par erreur.
- ⚠️ **1 risque latent au niveau du dépôt RACINE** `Desktop/TYGR` (pas l'app) : `.env.prod` non ignoré.
- 🧹 Ménage léger possible : **1 branche locale mergée** à supprimer + décision sur 3 fichiers non suivis.

---

## 1. `.gitignore` — ✅ CONFORME, rien ne manque

Le `.gitignore` de `tygr-app/` couvre déjà tout ce qui est demandé :

| Demandé            | Présent ? | Règle                                            |
|--------------------|-----------|--------------------------------------------------|
| `node_modules/`    | ✅        | `/node_modules`                                  |
| `.next/`           | ✅        | `/.next/`                                         |
| `dist/` `build/`   | ✅        | `/build`, `/out/` (cf. note vendor ci-dessous)   |
| `coverage/`        | ✅        | `/coverage`                                       |
| `*.log`            | ✅        | `npm-debug.log*`, `yarn-debug.log*`, etc.        |
| `.DS_Store`        | ✅        | `.DS_Store`                                       |
| **env (tous)**     | ✅        | `.env*` + opt-in `!.env.example`, `!.env.prod.example` |

**Confirmé par `git check-ignore` :** `.env` → IGNORÉ ✅, `.env.prod` → IGNORÉ ✅.

➡️ **Aucune action requise sur le `.gitignore` de `tygr-app/`.**

---

## 2. 🔴 SÉCURITÉ — fichiers sensibles versionnés

### Dans `tygr-app/` : ✅ RAS (rien à signaler)
- `git ls-files | grep env` → **uniquement** `.env.example` et `.env.prod.example` (modèles sains, valeurs vides).
- Recherche `secret|credential|*.pem|*.key` dans les fichiers suivis → **0 résultat**.
- Historique des **218 commits** (`git log --all --diff-filter=A`) → **aucune** trace d'un `.env` réel ou d'un fichier secret ajouté puis retiré. **Pas de fuite historique.**

### 🟠 PRIORITÉ MOYENNE — au niveau du dépôt RACINE `Desktop/TYGR` (conteneur, pas l'app)
- `Desktop/TYGR/.env.prod` **existe sur disque** et **n'est PAS ignoré** : il n'y a **pas de `.gitignore` à la racine**.
- Il n'est **pas encore suivi** (absent de `git ls-files`), donc **pas de fuite actuelle**, mais un `git add -A` distrait à la racine pourrait le committer → **risque latent**.
- **Recommandation (PHASE 2)** : créer un `.gitignore` minimal à la racine `Desktop/TYGR` ignorant `.env`, `.env.*` (sauf `*.example`), `node_modules/`. Décision t'appartient.

> ℹ️ Conformément à ta consigne : **je ne touche pas à l'historique git**. S'il y avait eu un secret historisé, je te l'aurais signalé pour rotation — ce **n'est pas le cas**.

---

## 3. Fichiers indésirables SUIVIS par git — ✅ RAS

- Recherche `node_modules/`, `.next/`, `dist/`, `build/`, `coverage/`, `*.log`, `.DS_Store`, `.cache/` dans les fichiers suivis → **aucun**.
- `.DS_Store` suivis : **0**.

### ⚠️ Faux positif à NE PAS nettoyer : `vendor/omni-fi-react-link/dist/*`
4 fichiers (`index.cjs`, `index.js`, `index.d.ts`, `index.d.cts`) sont suivis dans un `dist/`. **C'est VOLONTAIRE et CRITIQUE** :
- `SECURITY_VENDORING.md` documente que ce SDK Omni-FI est installé via `file:vendor/omni-fi-react-link` ;
- le `dist/` amont **n'est publié nulle part** (npm 404, GitHub ne committe pas son build) ;
- **le dé-suivre casserait l'install et la démo bancaire.**

➡️ **À CONSERVER. Ne pas `git rm --cached`.**

---

## 4. Branches locales mergées dans `main` — candidates à suppression

Croisement strict (`git merge-base --is-ancestor <branche> origin/main`) sur les 13 branches locales :

| Branche locale                                  | Statut vs `origin/main`        |
|-------------------------------------------------|--------------------------------|
| **`fix/libelle-transaction-information`**       | ✅ **MERGÉE → supprimable**     |
| `chore/todos-chantiers-produit`                 | ⏳ non-mergée (1 commit hors)   |
| `docs/omnifi-bascule-prod-debloquee`            | ⏳ non-mergée (1 commit hors)   |
| `docs/qa-bilan-parcours-todos`                  | ⏳ non-mergée (1 commit hors)   |
| `feat/autosync-transactions-post-connexion`     | ⏳ non-mergée (1 commit hors)   |
| `feat/omnifi-sync-trigger` *(branche courante)* | ⏳ non-mergée¹                  |
| `feat/prod-merchant-cascade`                    | ⏳ non-mergée (1 commit hors)   |
| `feature/dashboard-insights-voie-a`             | ⏳ non-mergée (2 commits hors)  |
| `feature/epic-insights-derives-internes`        | ⏳ non-mergée (1 commit hors)   |
| `feature/regles-form-validation-ux`             | ⏳ non-mergée (1 commit hors)   |
| `feature/transactions-fiabilite-classification` | ⏳ non-mergée (1 commit hors)   |
| `fix/categories-fr-catalogue-obie`              | ⏳ non-mergée (1 commit hors)   |
| `fix/seed-omnifi-cuid`                          | ⏳ non-mergée (1 commit hors)   |

¹ `feat/omnifi-sync-trigger` correspond à la PR #119 mais a été **squash-mergée** : son tip (`e194afa`) n'est pas un ancêtre direct du merge commit (`82978c8`). Par prudence **je ne la propose pas** (et `git branch -d` la refuserait). À supprimer manuellement seulement si tu confirmes que #119 est bien mergée.

➡️ **PHASE 2 : `git branch -d fix/libelle-transaction-information`** (suppression sûre, `-d` refuse si non mergée).

---

## 5. Fichiers temporaires / orphelins NON suivis — pour revue (rien supprimé)

| Fichier non suivi                          | Taille | Nature                                                            | Recommandation                          |
|--------------------------------------------|--------|-------------------------------------------------------------------|-----------------------------------------|
| `scripts/diag-sync.ts`                     | 19K    | Script de diagnostic sync                                         | 🔒 **CONSERVER** — tu veux le rejouer en prod. **Je ne le touche pas.** Le committer ou l'ignorer ? → **ta décision**. |
| `scripts/reset-password.mjs`               | 3.1K   | Réinit. mot de passe local (mdp via ENV, jamais loggé, dev-only)  | Sain. À committer (utile) ou ignorer ? → **ta décision** |
| `PLAN-frontend-insights-et-regles-ux.md`   | 13K    | Doc de plan. **PAS** un doublon de `PLAN-frontend-ux-batch.md`    | À committer ou laisser hors suivi ? → **ta décision** |

- Aucun `.tmp` / `.bak` / `.orig` / `*~` trouvé.
- Aucune modification non committée en attente.
- `git remote prune origin --dry-run` → **aucune référence distante obsolète**.

---

## Contraintes respectées (rappel)
- ❌ Aucune réécriture d'historique (pas de rebase/reset --hard/filter-branch/force-push).
- ❌ Aucun code applicatif ni test supprimé. **Code MFA « mort » NON touché** (`machine-mfa.ts`, `soumettreMfa`/`resendMfa`, `use-omnifi-widget.ts`).
- ❌ `scripts/diag-sync.ts` **NON supprimé** — décision t'appartient.
- ✅ Branche `chore/cleanup-repo` créée, **rien modifié**, PR à la fin (tu merges).

---

## Plan PHASE 2 proposé (à valider point par point)

1. **(Optionnel, sécu)** Créer `Desktop/TYGR/.gitignore` ignorant `.env*` (sauf `*.example`) + `node_modules/`. → couvre le `.env.prod` racine.
2. **(Optionnel)** Décider du sort des 3 fichiers non suivis (commit / ignore / laisser).
3. **Supprimer la branche mergée** : `git branch -d fix/libelle-transaction-information`.
4. **`git fetch --prune`** (cosmétique — rien à pruner actuellement, mais sans risque).
5. Quality gates (`lint` + `typecheck` + `tests`) restent verts (aucun changement de code prévu).

> **Le `.gitignore` de `tygr-app/` ne nécessite AUCUNE modification** — contrairement à ce que le briefing anticipait, il est déjà complet.

**👉 Dis-moi quels points tu valides et je passe à la PHASE 2.**
