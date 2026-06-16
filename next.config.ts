import path from "node:path";
import { createRequire } from "node:module";

import type { NextConfig } from "next";

/**
 * Détection du package privé `@omnifi/react` (module fantôme).
 *
 * `@omnifi/react` vit sur un registre npm PRIVÉ : présent sur le poste de démo,
 * absent de `node_modules` en local/CI. `require.resolve` est la source de vérité
 * de Node (gère les layouts hoistés/exports maps, contrairement à un simple
 * `fs.existsSync("node_modules/@omnifi")`) : il retourne le chemin si résolvable,
 * sinon throw `MODULE_NOT_FOUND`.
 *
 * Quand le vrai package est ABSENT, on alias `@omnifi/react` vers un stub JS local
 * (`src/stubs/omnifi-react.stub.ts`) UNIQUEMENT pour satisfaire la résolution
 * statique du bundler au build (`next build` trace tout le graphe d'imports, y
 * compris la ligne `import { useOmniFILink } from "@omnifi/react"` du launcher
 * lazy-loadé). Sans alias → `Module not found`, crash 500. Avec le vrai package
 * présent (démo), l'alias est désactivé → comportement natif intact.
 */
const requireFromConfig = createRequire(import.meta.url);
const omnifiPackagePresent = (() => {
  try {
    requireFromConfig.resolve("@omnifi/react");
    return true;
  } catch {
    return false;
  }
})();

// Les deux bundlers attendent des formes de chemin DIFFÉRENTES (validation
// croisée Backend 2026-06-16) :
//  - Turbopack (Next 16) résout `resolveAlias` RELATIVEMENT à la racine projet.
//    Un chemin absolu y est interprété comme « server relative » (préfixé d'un
//    `.` → `./Users/...`) et n'est PAS résolu. Il faut donc une forme relative
//    `./src/stubs/...`.
//  - Webpack `resolve.alias` exige au contraire un chemin ABSOLU.
const omnifiStubRelative = "./src/stubs/omnifi-react.stub.ts";
const omnifiStubAbsolute = path.resolve(
  import.meta.dirname,
  "src/stubs/omnifi-react.stub.ts",
);

const nextConfig: NextConfig = {
  // Build standalone : Next trace les dépendances réellement utilisées et produit
  // un serveur minimal dans .next/standalone (image Docker légère, sans node_modules
  // complet). Requis par le Dockerfile multi-stage.
  output: "standalone",
  // argon2 est un module natif (prébuilds napi résolus au require par
  // node-gyp-build) : il doit rester externe au bundler pour que le tracing
  // standalone embarque ses fichiers .node tels quels.
  serverExternalPackages: ["argon2"],

  // ── Alias conditionnel @omnifi/react → stub local (build sans le package privé)
  // Symétrique Turbopack (défaut `next build`/`next dev` en Next 16) + Webpack
  // (filet si un build legacy `--webpack` est lancé). Injecté SEULEMENT si le
  // vrai package est absent : sur le poste de démo, aucun alias → module natif.
  ...(omnifiPackagePresent
    ? {}
    : {
        turbopack: {
          resolveAlias: {
            "@omnifi/react": omnifiStubRelative,
          },
        },
        webpack: (config) => {
          config.resolve = config.resolve ?? {};
          config.resolve.alias = {
            ...config.resolve.alias,
            "@omnifi/react": omnifiStubAbsolute,
          };
          return config;
        },
      }),
};

export default nextConfig;
