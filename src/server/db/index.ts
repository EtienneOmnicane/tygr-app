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
  etatCompte: (userId) => obtenirIdentite().etatCompte(userId),
  changerMotDePasse: (userId, options) =>
    obtenirIdentite().changerMotDePasse(userId, options),
  enregistrerEchec: (userId, maintenant) =>
    obtenirIdentite().enregistrerEchec(userId, maintenant),
  reinitialiserEchecs: (userId) =>
    obtenirIdentite().reinitialiserEchecs(userId),
  compterTentativesIp: (ip, maintenant) =>
    obtenirIdentite().compterTentativesIp(ip, maintenant),
  enregistrerTentativeIp: (ip, succeeded) =>
    obtenirIdentite().enregistrerTentativeIp(ip, succeeded),
  membershipsDe: (userId) => obtenirIdentite().membershipsDe(userId),
  membershipParDefaut: (userId) =>
    obtenirIdentite().membershipParDefaut(userId),
  membershipsAvecNom: (userId) =>
    obtenirIdentite().membershipsAvecNom(userId),
};

export { schema };

// Changement de mot de passe (AUTH-MDP-TEMPO1) : erreurs nommées du repository
// identité, ré-exportées pour que l'action /account/password les mappe sans
// importer @/server/repositories/* directement (frontière P0-a).
export {
  CompteIndisponibleError,
  CompteSansMotDePasseError,
  CompteVerrouilleError,
  MotDePasseActuelIncorrectError,
} from "@/server/repositories/identite";
export type { EtatCompte } from "@/server/repositories/identite";

// Provisioning (Epic 2 L3) : ré-exporté via le point d'entrée serveur pour que
// les Server Actions de app/ l'appellent sans importer @/server/repositories/*
// directement (frontière P0-a). La fonction s'exécute DANS withWorkspace (tx,
// ctx) — ce n'est pas un accès DB hors contexte.
export {
  creerUtilisateurEtRattacher,
  creerMembreAvecScopes,
  ProvisioningNonAutoriseError,
  RoleInvalideError,
} from "@/server/repositories/provisioning";
export type {
  NouvelUtilisateur,
  ResultatRattachement,
  ResultatProvisioningMembre,
} from "@/server/repositories/provisioning";

// Services de lecture du dashboard (Epic 3 — FEAT-3.1) : ré-exportés ici pour
// que la page (workspace)/page.tsx les appelle DANS withWorkspace(tx) sans
// importer @/server/repositories/* directement (même frontière que provisioning
// ci-dessus). Chaque fonction prend `tx` et s'exécute sous RLS — pas d'accès DB
// hors contexte.
export {
  listerComptes,
  listerConnexionsBancaires,
  comptesParEntite,
  listerEntitesVisibles,
  soldeConsolideCourant,
  soldesCourantsParDevise,
  courbeTresorerie,
  syntheseMois,
  synthesePeriodeParDevise,
  syntheseParMois,
  grilleMois,
  transactionsRecentes,
} from "@/server/repositories/dashboard";
export type {
  CompteConnecte,
  ConnexionBancaire,
  EntiteVisible,
  PointCourbe,
  SoldeParDevise,
  SyntheseMois,
  SynthesePeriodeDevise,
  SyntheseMensuelle,
  TransactionRecente,
} from "@/server/repositories/dashboard";

// Insights dérivés (TECH-API-INSIGHTS, Voie A) : cashflow & vendors dérivés de
// transactions_cache. Même frontière que le dashboard — ré-exportés ici pour que
// la page RSC les appelle DANS withWorkspace(tx) sans importer
// @/server/repositories/* directement (no-restricted-imports, règle 2).
export {
  cashflowParDevise,
  vendorsParConcentration,
  repartitionParCategorie,
  InsightsParamsInvalidesError,
} from "@/server/repositories/insights";
export type {
  RepartitionCategories,
  RepartitionDevise,
  PartCategorie,
  SensFlux,
} from "@/server/insights/types";

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
  importerReferentielCategories,
  VentilationDepasseError,
  CategorieDejaExisteError,
  CategorieDupliqueeError,
  TransactionIntrouvableError,
  CategorieIntrouvableError,
  CategorieNonAutoriseeError,
} from "@/server/repositories/categorisation";
export type {
  RefTransaction,
  SplitAAjouter,
  SplitLu,
  SplitCible,
  CategorieLue,
  ImportReferentiel,
} from "@/server/repositories/categorisation";

// Lecture paginée des transactions + résumé de ventilation (B1-B3, page
// /transactions). Même frontière : la Server Action appelle ceci DANS
// withWorkspace(tx) sans importer @/server/repositories/* directement.
export {
  listerTransactions,
  sommeNetteParDevise,
  CurseurInvalideError,
} from "@/server/repositories/transactions";
export type {
  TransactionLigne,
  PageTransactions,
  SommeNetteDevise,
} from "@/server/repositories/transactions";

// Gestion des Entités (Option B, L3) : référentiel d'entités + sas d'assignation +
// périmètre Vision Entité (member_entity_scopes). Même frontière P0-a : les Server
// Actions de admin/entites/ appellent ceci DANS withWorkspace(tx, ctx) sans importer
// @/server/repositories/* directement. Garde ADMIN portée par le repository.
export {
  listerEntites,
  listerComptesAvecEntite,
  listerScopesMembre,
  listerMembresWorkspace,
  listerPropositionsPartyEntite,
  creerEntite,
  renommerEntite,
  archiverEntite,
  assignerCompteEntite,
  assignerComptesEntite,
  assignerPartieEntite,
  definirScopesMembre,
  EntiteNonAutoriseError,
  EntiteIntrouvableError,
  CompteIntrouvableError,
  PartieIntrouvableError,
  EntiteNomDupliqueError,
  EntiteNonVideError,
  AssignationHorsPerimetreError,
  PerimetreReduitError,
  AdminNonScopableError,
  MembreNonScopableError,
} from "@/server/repositories/entites";
export type {
  EntiteLue,
  CompteAvecEntite,
  MembreScope,
  PropositionEntite,
  CompteDeProposition,
} from "@/server/repositories/entites";

// Périmètre fin par membre (user_scopes, L6a) : octroi / révocation ADMIN-only de la
// maille party/compte qui pilote account_scope. Même frontière P0-a : les Server
// Actions de admin/perimetres/ appellent ceci DANS withWorkspace(tx, ctx) sans importer
// @/server/repositories/* directement. Garde ADMIN portée par le repository (la RLS
// tenant ne borne PAS le rôle → la garde applicative EST la sécurité). On n'ajoute ici
// que les NOUVEAUX symboles : CompteIntrouvableError / MembreNonScopableError /
// PartieIntrouvableError sont déjà exportés ci-dessus (mêmes erreurs, définies dans le
// repo entités et réutilisées par user-scopes — pas de classe homonyme dupliquée).
export {
  listerScopesFinsMembre,
  definirScopesFinsMembre,
  octroyerScopeFin,
  revoquerScopeFin,
  ScopeFinNonAutoriseError,
  CibleScopeInvalideError,
} from "@/server/repositories/user-scopes";
export type {
  ScopeFinMembre,
  ScopesFinsAPoser,
  CibleScopeFin,
} from "@/server/repositories/user-scopes";

// Moteur de règles de catégorisation : référentiel de règles + service
// d'application (appliquerRegles crée des splits source='RULE' pour les
// transactions non catégorisées qui matchent). Même frontière P0-a : les Server
// Actions de regles/ appellent ceci DANS withWorkspace(tx, ctx) sans importer
// @/server/repositories/* directement.
export {
  listerRegles,
  creerRegle,
  modifierRegle,
  archiverRegle,
  reordonnerRegles,
  appliquerRegles,
  RegleIntrouvableError,
  RegleNonAutoriseeError,
  OrdreReglesInvalideError,
} from "@/server/repositories/regles-categorisation";
export type {
  RegleLue,
  RegleACreer,
  RegleAModifier,
  ResultatApplication,
} from "@/server/repositories/regles-categorisation";

// Échéances prévisionnelles (Epic 8 · FEAT-8.2) : CRUD + synthèse par horizon
// (30/60/90 j). Deux étages RLS (tenant + entity_scope) portés par withWorkspace ;
// écriture réservée aux membres (peutModifier). Même frontière P0-a : les Server
// Actions de echeances/ appellent ceci DANS withWorkspace(tx, ctx) sans importer
// @/server/repositories/* directement.
export {
  listerEcheances,
  synthetiserHorizon,
  creerEcheance,
  modifierEcheance,
  changerStatutEcheance,
  supprimerEcheance,
  EcheanceIntrouvableError,
  EcheanceNonAutoriseeError,
  ReferenceEcheanceInvalideError,
  EcheanceHorsPerimetreError,
  MontantRegleInvalideError,
} from "@/server/repositories/echeances";
export type {
  EcheanceLue,
  EcheanceACreer,
  EcheanceAModifier,
  ChangementStatutEcheance,
  SyntheseHorizonDevise,
  SyntheseHorizon,
  SyntheseEcheances,
  HorizonJours,
} from "@/server/repositories/echeances";
