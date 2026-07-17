import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Frontière d'accès aux données (règle 2, dette P0-a) — EXTRAITE en constante parce
 * qu'elle doit être RÉPÉTÉE dans l'override `admin/` ci-dessous.
 *
 * ⚠️ En flat config, un bloc qui redéclare `no-restricted-imports` REMPLACE la règle,
 * il ne la fusionne pas. Sans cette constante, l'override admin désactiverait
 * SILENCIEUSEMENT la frontière d'accès aux données sur toute la surface d'administration
 * — exactement la régression qu'on veut éviter.
 */
const FRONTIERE_DONNEES = {
  // Schéma brut + client DB + tenancy/repositories : confinés.
  // `@/db` (l'index, qui exporte withWorkspace ET le pool) n'est PAS listé :
  // importer withWorkspace depuis une page serveur est légitime. Ce qui fuit
  // (le pool `db`) est couvert par la cloison server/ ; le schéma, lui, est
  // bloqué partout hors serveur dès maintenant.
  group: [
    "@/db/schema",
    "@/server/db/schema",
    "@/repositories/*",
    "@/server/repositories/*",
  ],
  // allowTypeImports : un `import type` est effacé à la compilation (zéro accès DB
  // au runtime) — autorisé. Les imports de VALEUR restent bloqués. La frontière vise
  // l'accès runtime à la donnée, pas la connaissance des types partagés.
  allowTypeImports: true,
  message:
    "Accès runtime au schéma/repositories interdit hors src/server/** (CLAUDE.md règle 2). Lis les données via withWorkspace(session, fn). (Les `import type` sont autorisés.)",
};

/**
 * Frontière de la PRIMITIVE SYSTÈME (lot W1, PLAN-ingestion-webhook-omnifi.md
 * §6.1) — même mécanique de constante RÉPÉTÉE que FRONTIERE_DONNEES.
 *
 * `executerPourWorkspaceSysteme` CONTOURNE la re-validation de membership (il
 * n'y a pas d'utilisateur) : elle n'est légitime que pour les chemins sans
 * session — les fonctions Inngest (W1) et, plus tard, la route webhook (W4).
 * Importée d'une Server Action ou d'un composant, elle deviendrait un bypass
 * de membership : la règle rend l'oubli IMPOSSIBLE. `group` avec préfixe glob
 * double-étoile : attrape aussi les imports relatifs (leçon R6). Pas
 * d'allowTypeImports : aucun type de ce module n'a vocation à circuler (les
 * types partagés vivent dans tenancy).
 */
const FRONTIERE_SYSTEME = {
  // Trois globs, du plus précis au plus large — chaque élargissement ferme une
  // voie de contournement PROUVÉE au lint : `../db/systeme` (relatif depuis
  // src/server/*) ne contient pas « server/ » ; `./systeme` (voisin direct
  // dans src/server/db/) ne contient pas « db/ ». Le dernier motif interdit du
  // même coup le ré-export par db/index.ts (la primitive ne doit JAMAIS
  // rejoindre le point d'entrée commun). Seul module homonyme du repo ; un
  // futur faux positif porterait ce message et se résoudrait en renommant.
  group: ["**/server/db/systeme", "**/db/systeme", "**/systeme"],
  message:
    "Primitive système (executerPourWorkspaceSysteme) réservée aux fonctions Inngest " +
    "(src/server/inngest/**) — PLAN-ingestion-webhook-omnifi.md §6.1. Toute surface " +
    "utilisateur passe par withWorkspace(session, fn).",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Build QA isolé HORS `.next/` (convention TYGR_DIST_DIR=.next-qa des
    // sessions /qa, cf. commentaire next.config.ts) : sans cette ligne, le
    // hook stop-loss linte les chunks Turbopack générés et échoue sur du
    // code qui n'est pas le nôtre — même piège que les worktrees ci-dessous.
    ".next-qa/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Dépendance tierce vendorée (dist/ buildé en amont) : on ne lint pas le code
    // d'un package, cf. SECURITY_VENDORING.md. (Non auditable ligne à ligne ici.)
    "vendor/**",
    // Worktrees d'agents concurrents : ils embarquent leur propre `.next/`
    // buildé ET une copie du `vendor/` vendoré. Les motifs `.next/**` et
    // `vendor/**` ci-dessus ne matchent QUE la racine, pas ces dossiers
    // imbriqués → sans ces lignes, ESLint lint le JS compilé d'un autre
    // worktree (require()/module/_runtime.js, dist vendoré) et fait échouer le
    // hook stop-loss (règle 5) sur du code qui n'est pas le nôtre. Les
    // worktrees vivent soit sous `.claude/worktrees/<branche>/`, soit à la
    // racine sous `.worktrees/<branche>/` — on couvre les deux emplacements.
    ".claude/**",
    ".worktrees/**",
  ]),

  // Frontière d'accès aux données (CLAUDE.md règle 2, dette P0-a).
  //
  // Principe : on restreint le CLIENT DB BRUT et le SCHÉMA Drizzle
  // (`@/db/schema`, `@/db/index` côté pool, tenancy, repositories) — jamais
  // importables hors de la couche serveur. En revanche le POINT D'ENTRÉE scopé
  // `withWorkspace` (et `identite`) reste appelable partout : c'est l'API voulue
  // pour qu'une page/Server Action serveur lise des données du tenant. La
  // distinction est donc par CONTENU (quel symbole), pas seulement par chemin.
  //
  // Toute la couche serveur vit sous src/server/** depuis le refacto
  // d'arborescence (2026-06-12) — l'allowlist legacy a été retirée à l'étape 4.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [FRONTIERE_DONNEES, FRONTIERE_SYSTEME] },
      ],
    },
  },

  // Frontière de la primitive système DANS la couche serveur (W1) : hors
  // src/server/inngest/**, aucun module serveur (repository, orchestration,
  // auth…) ne consomme executerPourWorkspaceSysteme. Bloc SÉPARÉ du précédent :
  // celui-ci ignore src/server/** en entier (les repositories DOIVENT importer
  // le schéma), ici on ne restreint QUE la primitive.
  {
    files: ["src/server/**/*.{ts,tsx}"],
    ignores: ["src/server/inngest/**", "src/server/db/systeme.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [FRONTIERE_SYSTEME] }],
    },
  },

  // Frontière de PÉRIMÈTRE des surfaces d'ADMINISTRATION (L0,
  // PLAN-refonte-entites.md §3.3).
  //
  // Une surface d'administration porte sur le TENANT ENTIER : elle ne doit JAMAIS
  // s'exécuter sous le `viewFilter` du sélecteur de périmètre (qui vit dans le JWT et
  // PERSISTE de page en page, le sélecteur étant monté dans le layout — donc présent sur
  // les écrans admin eux-mêmes). La policy `account_scope` (RESTRICTIVE FOR ALL, 0016/0017)
  // porte sa clause `view_filter` en USING *et* en WITH CHECK : sans amputation, l'écran
  // ment en LECTURE (compteurs partiels) et refuse l'ÉCRITURE (« Ressource introuvable. »
  // sur un compte pourtant visible).
  //
  // La règle rend l'oubli IMPOSSIBLE plutôt que de compter sur la relecture.
  // ⚠️ `patterns` est répété volontairement : redéclarer la règle la REMPLACE (cf.
  // FRONTIERE_DONNEES ci-dessus).
  {
    files: ["src/app/**/admin/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            FRONTIERE_DONNEES,
            FRONTIERE_SYSTEME,
            {
              // `paths` ne matche QUE le spécifieur exact : un import RELATIF
              // (`../../../../server/auth/session`) passait à travers. `group` matche le
              // chemin, quelle que soit sa forme (constat R6 de la cross-review, mesuré).
              group: ["**/server/auth/session"],
              importNames: ["exigerSessionWorkspace"],
              message:
                "Surface d'administration : utiliser `exigerSessionAdministration()` (session amputée du viewFilter). `exigerSessionWorkspace()` laisserait le filtre d'affichage du header amputer les lectures ET bloquer les écritures (PLAN-refonte-entites.md §3.3).",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
