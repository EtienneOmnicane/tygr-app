# syntax=docker/dockerfile:1
# Dockerfile multi-stage — production Next.js (build standalone, image minimale).
# Cible : runtime non-root, sans toolchain ni node_modules de dev.

# 1) deps — installe UNIQUEMENT les dépendances, cache séparé du code source.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts : le contexte Docker exclut .git (.dockerignore), donc le script
# `prepare`/husky n'a rien à installer ; et ne pas exécuter de scripts d'install
# arbitraires est une bonne pratique de sécurité en CI/conteneur.
# NB argon2 (module natif) : compatible — ses prébuilds napi (linux x64/arm64,
# glibc+musl) sont DANS le paquet npm et résolus au require par node-gyp-build ;
# aucun toolchain de compilation requis. `serverExternalPackages` (next.config.ts)
# garantit que le tracing standalone embarque les .node tels quels.
RUN npm ci --ignore-scripts

# 2) builder — compile l'app et produit .next/standalone.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# 3) runner — image finale, ne contient que le serveur standalone + assets statiques.
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Utilisateur non-root (sécurité — règle 3/8).
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# .next/standalone embarque le serveur + le strict nécessaire de node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Healthcheck simple sur la racine (à raffiner avec une route /api/health dédiée).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
