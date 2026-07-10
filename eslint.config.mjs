import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
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
        {
          patterns: [
            {
              // Schéma brut + client DB + tenancy/repositories : confinés.
              // `@/db` (l'index, qui exporte withWorkspace ET le pool) n'est PAS
              // listé : importer withWorkspace depuis une page serveur est
              // légitime. Ce qui fuit (le pool `db`) est couvert par la cloison
              // server/ une fois le refacto terminé ; le schéma, lui, est
              // bloqué partout hors serveur dès maintenant.
              // `@/lib/tenancy` (et sa cible `@/server/db/tenancy`) n'est PAS
              // listé : il exporte withWorkspace ET les types d'erreur publics
              // (WorkspaceAccessDeniedError) qu'une page serveur doit attraper
              // pour mapper 404. Le pool `db` qu'il pourrait fuir sera confiné
              // par la cloison server/ après le refacto. Le schéma brut, lui,
              // reste bloqué partout hors serveur dès maintenant.
              group: [
                "@/db/schema",
                "@/server/db/schema",
                "@/repositories/*",
                "@/server/repositories/*",
              ],
              // allowTypeImports : un `import type` est effacé à la compilation
              // (zéro accès DB au runtime) — autorisé. Les imports de VALEUR
              // (le client db, une fonction de repository) restent bloqués. La
              // frontière vise l'accès runtime à la donnée, pas la connaissance
              // des types partagés (WorkspaceRole, MembershipAvecNom).
              allowTypeImports: true,
              message:
                "Accès runtime au schéma/repositories interdit hors src/server/** (CLAUDE.md règle 2). Lis les données via withWorkspace(session, fn). (Les `import type` sont autorisés.)",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
