import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build standalone : Next trace les dépendances réellement utilisées et produit
  // un serveur minimal dans .next/standalone (image Docker légère, sans node_modules
  // complet). Requis par le Dockerfile multi-stage.
  output: "standalone",
};

export default nextConfig;
