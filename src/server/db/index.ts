/**
 * Connexion Neon Serverless — E16 / CLAUDE.md règle 8 :
 * Pool WebSocket UNIQUEMENT. `SET LOCAL`/set_config(…, true) exige de vraies
 * transactions multi-statements sur une même connexion ; le mode HTTP
 * (drizzle-orm/neon-http) ne les fournit pas et ferait silencieusement
 * tomber l'étage RLS. Toute migration vers un autre driver doit re-passer
 * le test d'intégration `set_config visible dans la transaction`.
 *
 * DATABASE_URL = chaîne POOLÉE Neon (pooler en mode transaction), rôle
 * `tygr_app` soumis à RLS — jamais le rôle owner (réservé aux migrations,
 * DATABASE_URL_ADMIN).
 *
 * Initialisation PARESSEUSE (premier usage, pas à l'import) : `next build`
 * évalue les modules des routes pour la collecte de pages, sans DATABASE_URL —
 * une connexion eager casserait le build et la CI. L'erreur explicite reste :
 * elle se lève à la première requête, pas au chargement.
 */
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";

import {
  createWithWorkspace,
  type WorkspaceContext,
  type WorkspaceSession,
  type WorkspaceTx,
} from "@/server/db/tenancy";
import {
  creerRepositoryIdentite,
  type RepositoryIdentite,
} from "@/server/repositories/identite";

import * as schema from "./schema";

// Node ≥22 expose WebSocket nativement ; sur Vercel Edge/Node récent,
// le driver le détecte. On le câble explicitement pour lever toute ambiguïté.
if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

// DEV LOCAL UNIQUEMENT — jamais posée en production (revue : la variable est
// absente des envs déployés). Pointe le driver Neon vers un wsproxy local
// (ghcr.io/neondatabase/wsproxy) devant un Postgres Docker : E16 est conservé
// (WebSocket + vraies transactions), seul le transport TLS est relâché en
// local. Ex. : NEON_WSPROXY_LOCAL="localhost:5433".
if (process.env.NEON_WSPROXY_LOCAL) {
  const proxy = process.env.NEON_WSPROXY_LOCAL;
  neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL manquante — voir .env.example (chaîne poolée Neon, rôle tygr_app)",
    );
  }
  return url;
}

type DbApplicative = NeonDatabase<typeof schema>;

function paresseux<T>(creer: () => T): () => T {
  let instance: T | undefined;
  return () => (instance ??= creer());
}

/** Singleton de connexion — créé au premier usage uniquement. */
export const obtenirDb = paresseux<DbApplicative>(() => {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  return drizzle(pool, { schema });
});

const obtenirWithWorkspace = paresseux(() =>
  createWithWorkspace(obtenirDb()),
);
const obtenirIdentite = paresseux(() =>
  creerRepositoryIdentite(obtenirDb()),
);

/** Point d'entrée unique de l'accès aux données (CLAUDE.md règle 2). */
export function withWorkspace<T>(
  session: WorkspaceSession,
  fn: (tx: WorkspaceTx<DbApplicative>, ctx: WorkspaceContext) => Promise<T>,
): Promise<T> {
  return obtenirWithWorkspace()(session, fn);
}

/** Accès identité pré-contexte (login, re-validation E6) — voir le repository. */
export const identite: RepositoryIdentite = {
  trouverParEmail: (email) => obtenirIdentite().trouverParEmail(email),
  estActif: (userId) => obtenirIdentite().estActif(userId),
  enregistrerEchec: (userId, maintenant) =>
    obtenirIdentite().enregistrerEchec(userId, maintenant),
  reinitialiserEchecs: (userId) =>
    obtenirIdentite().reinitialiserEchecs(userId),
  compterTentativesIp: (ip, maintenant) =>
    obtenirIdentite().compterTentativesIp(ip, maintenant),
  enregistrerTentativeIp: (ip, succeeded) =>
    obtenirIdentite().enregistrerTentativeIp(ip, succeeded),
  membershipsDe: (userId) => obtenirIdentite().membershipsDe(userId),
  membershipsAvecNom: (userId) =>
    obtenirIdentite().membershipsAvecNom(userId),
};

export { schema };

// Provisioning (Epic 2 L3) : ré-exporté via le point d'entrée serveur pour que
// les Server Actions de app/ l'appellent sans importer @/server/repositories/*
// directement (frontière P0-a). La fonction s'exécute DANS withWorkspace (tx,
// ctx) — ce n'est pas un accès DB hors contexte.
export {
  creerUtilisateurEtRattacher,
  ProvisioningNonAutoriseError,
  RoleInvalideError,
} from "@/server/repositories/provisioning";

// Services de lecture du dashboard (Epic 3 — FEAT-3.1) : ré-exportés ici pour
// que la page (workspace)/page.tsx les appelle DANS withWorkspace(tx) sans
// importer @/server/repositories/* directement (même frontière que provisioning
// ci-dessus). Chaque fonction prend `tx` et s'exécute sous RLS — pas d'accès DB
// hors contexte.
export {
  listerComptes,
  soldeConsolideCourant,
  courbeTresorerie,
  syntheseMois,
  transactionsRecentes,
} from "@/server/repositories/dashboard";
export type {
  CompteConnecte,
  PointCourbe,
  SyntheseMois,
  TransactionRecente,
} from "@/server/repositories/dashboard";

// Catégorisation manuelle + ventilation (Pilier 1). Ré-exporté pour que les
// Server Actions (à venir) l'appellent DANS withWorkspace(tx) sans importer
// @/server/repositories/* directement.
export {
  listerSplits,
  ajouterSplit,
  supprimerSplit,
  remplacerSplits,
  listerCategories,
  creerCategorie,
  renommerCategorie,
  archiverCategorie,
  VentilationDepasseError,
  TransactionIntrouvableError,
  CategorieIntrouvableError,
} from "@/server/repositories/categorisation";
export type {
  RefTransaction,
  SplitAAjouter,
  SplitLu,
  SplitCible,
  CategorieLue,
} from "@/server/repositories/categorisation";

// Lecture paginée des transactions + résumé de ventilation (B1-B3, page
// /transactions). Même frontière : la Server Action appelle ceci DANS
// withWorkspace(tx) sans importer @/server/repositories/* directement.
export {
  listerTransactions,
  CurseurInvalideError,
} from "@/server/repositories/transactions";
export type {
  TransactionLigne,
  PageTransactions,
} from "@/server/repositories/transactions";
