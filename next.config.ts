import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build standalone : Next trace les dépendances réellement utilisées et produit
  // un serveur minimal dans .next/standalone (image Docker légère, sans node_modules
  // complet). Requis par le Dockerfile multi-stage.
  output: "standalone",
  // argon2 est un module natif (prébuilds napi résolus au require par
  // node-gyp-build) : il doit rester externe au bundler pour que le tracing
  // standalone embarque ses fichiers .node tels quels.
  serverExternalPackages: ["argon2"],
};

export default nextConfig;
