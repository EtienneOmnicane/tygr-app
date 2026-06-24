This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Démarrer en Sandbox vs Production (API Omni-FI)

L'application bascule entre la **sandbox** (pré-prod de recette) et la **production**
Omni-FI **par les variables d'environnement** `OMNIFI_ENV` + `OMNIFI_BASE_URL` — le
code (`src/server/omnifi/config.ts`) ne contient aucun environnement en dur.

Un **verrou de sécurité fail-closed**, **actif par défaut**, refuse de démarrer le
client en production tant que `OMNIFI_AUTORISER_PRODUCTION` ne vaut pas exactement
`"1"`. Un `.env` mal réglé ne peut donc pas taper la prod par accident.

### Mode Sandbox (par défaut)

Votre `.env` habituel cible déjà la sandbox (voir [`.env.example`](./.env.example),
section Omni-FI : `OMNIFI_ENV="sandbox"`, hôte `api-stage.omni-fi.co`). Rien de
spécial à faire :

```bash
npm run dev
```

### Mode Production

1. Renseigner les variables de prod. Le gabarit [`.env.prod.example`](./.env.prod.example)
   liste exactement les clés qui changent (hôte `api.omni-fi.co`,
   `OMNIFI_ENV="production"`, identifiants de l'ApiClient de prod, et le drapeau de
   déverrouillage `OMNIFI_AUTORISER_PRODUCTION="1"`). Copier ces lignes dans votre
   `.env` actif (ou maintenir un `.env.prod` séparé, ignoré par git).
2. Démarrer normalement :

```bash
npm run dev      # ou: npm run start  en build de prod
```

> Sans `OMNIFI_AUTORISER_PRODUCTION="1"`, le démarrage échoue volontairement
> (`OmniFiConfigError: Verrou sandbox actif`) dès le premier appel Omni-FI. C'est le
> garde-fou attendu, pas un bug. La garde de cohérence `OMNIFI_ENV`↔hôte reste active
> dans les deux modes : `production` exige l'hôte `api.omni-fi.co`, et inversement.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
