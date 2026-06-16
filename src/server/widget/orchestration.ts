/**
 * Orchestration serveur du flux Link Widget (PR-W2). Logique PURE et scopée :
 * reçoit le client Omni-FI (PR-W1) + un `executer` = withWorkspace lié à la
 * session, et délègue toute écriture aux repositories scopés (règle 2). Aucune
 * I/O DB directe, aucun accès au client DB hors withWorkspace.
 *
 * Deux étapes serveur du flux (le reste — session/exchange, connect, polling MFA
 * — est piloté par le widget côté client, PR-W3) :
 *  1. demarrerConnexion : crée le LinkToken (ApiKey) pour initialiser le widget.
 *  2. finaliserConnexion : échange le PublicToken contre un ConnectionId permanent
 *     (frontière tenant via ClientUserId), découvre les comptes (/accounts) et
 *     persiste connexion + comptes dans le workspace courant.
 *
 * Sécurité :
 * - `ClientUserId` = `workspaces.omnifi_client_user_id` du workspace COURANT,
 *   jamais un paramètre client → un tenant ne peut pas créer/échanger pour un
 *   autre (mismatch → 403 PUBLIC_TOKEN_CLIENT_MISMATCH côté Omni-FI).
 * - Gating : seul un rôle qui peut modifier (MANAGER/ADMIN) démarre/finalise une
 *   connexion bancaire (VIEWER = lecture seule).
 * - A1 (cross-review PR-W1) : on ne logge JAMAIS l'erreur d'un appel widget avec
 *   ses arguments (le flux porte des identifiants/tokens). Les erreurs remontent
 *   nommées, sans payload sensible.
 */
import type {
  OmniFiClient,
  OmniFiAccount,
  OmniFiBalance,
} from "@/server/omnifi";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { peutModifier } from "@/lib/permissions";
import type { ExecuterWorkspace, WorkspaceTx } from "@/server/db/tenancy";
import { workspaces } from "@/server/db/schema";
import {
  upsertCompte,
  upsertConnexion,
} from "@/server/repositories/ingestion";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
type Tx = WorkspaceTx<AnyPgDatabase>;

/** L'acteur n'a pas le droit de gérer les connexions bancaires (VIEWER). */
export class ConnexionNonAutoriseeError extends Error {
  readonly code = "CONNEXION_NOT_AUTHORIZED";
  constructor() {
    super("Action non autorisée");
    this.name = "ConnexionNonAutoriseeError";
  }
}

/** Le workspace courant n'a pas d'omnifi_client_user_id exploitable. */
export class WorkspaceSansClientUserIdError extends Error {
  readonly code = "WORKSPACE_SANS_CLIENT_USER_ID";
  constructor() {
    super("Workspace non configuré pour Omni-FI");
    this.name = "WorkspaceSansClientUserIdError";
  }
}

/**
 * Désalignement détecté entre l'exchange (PublicToken→ConnectionId, frontière
 * tenant via ClientUserId) et les comptes rapportés par le job (SessionToken/
 * jobId, NON liés au tenant). Constat cross-review 1.1 : on REFUSE de persister
 * des comptes dont l'institution ne correspond pas à la connexion échangée —
 * sinon un sessionToken/jobId d'un autre flux rattacherait des comptes non
 * corrélés au consentement réellement échangé. Fail-closed.
 */
export class ConnexionDesalignmentError extends Error {
  readonly code = "CONNEXION_DESALIGNEMENT";
  constructor() {
    super("Comptes du job non corrélés à la connexion échangée");
    this.name = "ConnexionDesalignmentError";
  }
}

/** Lit l'omnifi_client_user_id du workspace courant (scopé RLS). */
async function clientUserIdDuWorkspace(
  tx: Tx,
  workspaceId: string,
): Promise<string> {
  const lignes = await tx
    .select({ cuid: workspaces.omnifiClientUserId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const cuid = lignes[0]?.cuid;
  if (!cuid) throw new WorkspaceSansClientUserIdError();
  return cuid;
}

/* ------------------------------------------------------------------ */
/* Étape 1 — démarrer la connexion (créer le LinkToken)               */
/* ------------------------------------------------------------------ */

export interface DemarrerConnexionParams {
  /** Origine HTTPS autorisée à recevoir le PublicToken (postMessage). */
  redirectOrigin: string;
  institutionId?: string;
}

export interface ResultatDemarrage {
  linkToken: string;
  expiration: string;
}

/**
 * Crée le LinkToken pour le workspace courant. Le ClientUserId vient du workspace
 * (frontière tenant), jamais du paramètre. Gating MANAGER/ADMIN.
 */
export async function demarrerConnexion(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: DemarrerConnexionParams,
): Promise<ResultatDemarrage> {
  const clientUserId = await executer(async (tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();
    return clientUserIdDuWorkspace(tx, ctx.workspaceId);
  });

  const lt = await client.creerLinkToken({
    ClientUserId: clientUserId,
    RedirectOrigin: params.redirectOrigin,
    InstitutionId: params.institutionId,
    // Scopes par défaut (ne PAS passer [] — 400). On omet pour les défauts.
    AccountSelectionEnabled: true,
  });
  return { linkToken: lt.LinkToken, expiration: lt.Expiration };
}

/* ------------------------------------------------------------------ */
/* Étape 2 — finaliser : exchange + découverte comptes + persistance   */
/* ------------------------------------------------------------------ */

export interface FinaliserConnexionParams {
  publicToken: string;
  /** SessionToken du widget — pour découvrir les comptes du job (/accounts). */
  sessionToken: string;
  jobId: string;
}

export interface ResultatFinalisation {
  connectionId: string;
  institutionId: string;
  comptesRattaches: number;
}

/** Choisit le solde courant d'un compte (balance "ITAV" si présente, sinon 1re). */
function soldeCourant(balances: OmniFiBalance[] | undefined): string | null {
  if (!balances || balances.length === 0) return null;
  const itav = balances.find((b) => b.Type === "ITAV") ?? balances[0];
  return itav.Amount?.Amount ?? null;
}

/**
 * Persiste connexion + comptes (Enabled uniquement) dans le workspace courant,
 * dans UNE transaction scopée. Partagé par les deux chemins de finalisation
 * (widget custom PR-W2 via getSyncJobAccounts, et drop-in via GET /accounts).
 * Idempotent (upserts sur omnifi_*_id).
 */
async function persisterConnexionEtComptes(
  executer: ExecuterWorkspace,
  echange: { ConnectionId: string; InstitutionId: string },
  comptes: OmniFiAccount[],
): Promise<number> {
  return executer(async (tx, ctx) => {
    const { connectionId } = await upsertConnexion(tx, ctx, {
      omnifiConnectionId: echange.ConnectionId,
      institutionId: echange.InstitutionId,
      status: "active",
      nextSyncAvailableAt: null,
    });

    let n = 0;
    for (const c of comptes) {
      if (c.Status !== "Enabled") continue; // comptes utilisables uniquement
      await upsertCompte(tx, ctx, connectionId, {
        omnifiAccountId: c.AccountId,
        accountName: c.Nickname ?? c.PartyName ?? `Compte ${c.AccountId.slice(0, 8)}`,
        currency: c.Currency,
        currentBalance: soldeCourant(c.Balances),
        isSelected: true,
      });
      n += 1;
    }
    return n;
  });
}

/**
 * Recoupe l'institution des comptes découverts avec celle de la connexion
 * échangée (constat cross-review 1.1) : un compte d'une AUTRE institution signale
 * une découverte non corrélée au consentement → fail-closed.
 */
function verifierAlignement(
  comptes: OmniFiAccount[],
  institutionEchange: string,
): void {
  const desaligne = comptes.some(
    (c) => c.InstitutionId != null && c.InstitutionId !== institutionEchange,
  );
  if (desaligne) throw new ConnexionDesalignmentError();
}

/**
 * Échange le PublicToken (ApiKey, ClientUserId = frontière tenant), découvre les
 * comptes du job (Bearer /accounts), puis persiste connexion + comptes dans le
 * workspace courant. Idempotent (upserts sur omnifi_*_id).
 */
export async function finaliserConnexion(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: FinaliserConnexionParams,
): Promise<ResultatFinalisation> {
  // 1. Garde de rôle + résolution du ClientUserId (scopé).
  const clientUserId = await executer(async (tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();
    return clientUserIdDuWorkspace(tx, ctx.workspaceId);
  });

  // 2. Exchange (ApiKey) — le ClientUserId protège la frontière tenant.
  const echange = await client.echangerPublicToken(
    params.publicToken,
    clientUserId,
  );

  // 3. Découverte des comptes du job (Bearer SessionToken).
  const accountsData = await client.getSyncJobAccounts(
    params.sessionToken,
    params.jobId,
  );
  const comptes: OmniFiAccount[] = accountsData.Account ?? [];

  // 3bis + 4 : recoupement anti-désalignement (1.1) puis persistance scopée.
  verifierAlignement(comptes, echange.InstitutionId);
  const rattaches = await persisterConnexionEtComptes(executer, echange, comptes);

  return {
    connectionId: echange.ConnectionId,
    institutionId: echange.InstitutionId,
    comptesRattaches: rattaches,
  };
}

/* ------------------------------------------------------------------ */
/* Étape 2bis — finaliser pour le widget DROP-IN (@omni-fi/react-link)  */
/* ------------------------------------------------------------------ */

export interface FinaliserDropinParams {
  /** PublicToken renvoyé par onSuccess du widget natif (seule donnée exposée). */
  publicToken: string;
}

/**
 * Finalisation pour le flux DROP-IN : le widget natif gère la MFA en interne et
 * ne nous rend que le PublicToken (ni sessionToken ni jobId). On échange (ApiKey)
 * puis on découvre les comptes par GET /accounts?connectionId= (ApiKey, SANS
 * SessionToken) — chemin serveur, frontière tenant via ClientUserId. Recoupement
 * 1.1 conservé : ici les comptes proviennent du listing filtré PAR connexion,
 * donc l'alignement est structurel, mais on revérifie l'InstitutionId par défense.
 */
export async function finaliserConnexionDropin(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: FinaliserDropinParams,
): Promise<ResultatFinalisation> {
  // 1. Garde de rôle + ClientUserId (scopé).
  const clientUserId = await executer(async (tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();
    return clientUserIdDuWorkspace(tx, ctx.workspaceId);
  });

  // 2. Exchange (ApiKey) → ConnectionId permanent (frontière tenant).
  const echange = await client.echangerPublicToken(params.publicToken, clientUserId);

  // 3. Découverte des comptes de CETTE connexion (ApiKey, filtré connectionId).
  //    On suit la pagination (Links.Next) pour ne rien tronquer.
  const comptes: OmniFiAccount[] = [];
  let page = 1;
  for (;;) {
    const env = await client.listerComptesConnexion(
      echange.ConnectionId,
      clientUserId,
      { page },
    );
    comptes.push(...(env.Data.Account ?? []));
    const totalPages = env.Meta?.TotalPages ?? 1;
    if (!env.Links?.Next || page >= totalPages) break;
    page += 1;
  }

  // 4. Défense : recoupement institution + persistance scopée.
  verifierAlignement(comptes, echange.InstitutionId);
  const rattaches = await persisterConnexionEtComptes(executer, echange, comptes);

  return {
    connectionId: echange.ConnectionId,
    institutionId: echange.InstitutionId,
    comptesRattaches: rattaches,
  };
}

/* ------------------------------------------------------------------ */
/* Synchronisation depuis l'état Omni-FI (contournement postMessage)    */
/* ------------------------------------------------------------------ */

export interface ResultatSynchronisation {
  connexions: number;
  comptesRattaches: number;
}

/**
 * Synchronise les connexions du workspace courant en LISANT l'état réel côté
 * Omni-FI (`GET /connections` filtré par ClientUserId), sans dépendre du
 * PublicToken ni du `postMessage` du widget.
 *
 * Pourquoi ce chemin (cf. OMNIFI_API_FEEDBACK.md §5/§6) : le widget CDN sandbox
 * échoue à établir le canal `postMessage` avec la page (« parentOrigin is not
 * established ») → `onSuccess`/`publicToken` ne reviennent JAMAIS côté client, alors
 * que la connexion EST bien persistée côté Omni-FI. On la récupère donc côté serveur.
 *
 * Sécurité (frontière tenant) : le ClientUserId vient du workspace courant, jamais
 * d'un paramètre client → on ne peut lister que SES connexions. Gating MANAGER/ADMIN.
 * Idempotent (upserts sur omnifi_*_id) : ré-exécutable sans créer de doublon.
 */
export async function synchroniserConnexionsDepuisOmnifi(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
): Promise<ResultatSynchronisation> {
  // 1. Garde de rôle + ClientUserId (scopé, frontière tenant).
  const clientUserId = await executer(async (tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();
    return clientUserIdDuWorkspace(tx, ctx.workspaceId);
  });

  // 2. Lister les connexions actives de cet EndUser (ApiKey), pagination suivie.
  const connexions: Array<{ ConnectionId: string; InstitutionId: string }> = [];
  let pageC = 1;
  for (;;) {
    const env = await client.listerConnexions(clientUserId, { page: pageC });
    for (const c of env.Data.Connections ?? []) {
      // On ne rattache que les connexions exploitables (actives).
      if (c.Status === "active" || c.Status === "Active") {
        connexions.push({ ConnectionId: c.ConnectionId, InstitutionId: c.InstitutionId });
      }
    }
    const totalPages = env.Meta?.TotalPages ?? 1;
    if (!env.Links?.Next || pageC >= totalPages) break;
    pageC += 1;
  }

  // 3. Pour chaque connexion : découvrir les comptes (filtré connectionId) et
  //    persister. Même helper idempotent que le chemin dropin.
  let comptesRattaches = 0;
  for (const cx of connexions) {
    const comptes: OmniFiAccount[] = [];
    let pageA = 1;
    for (;;) {
      const env = await client.listerComptesConnexion(cx.ConnectionId, clientUserId, {
        page: pageA,
      });
      comptes.push(...(env.Data.Account ?? []));
      const totalPages = env.Meta?.TotalPages ?? 1;
      if (!env.Links?.Next || pageA >= totalPages) break;
      pageA += 1;
    }
    verifierAlignement(comptes, cx.InstitutionId);
    comptesRattaches += await persisterConnexionEtComptes(executer, cx, comptes);
  }

  return { connexions: connexions.length, comptesRattaches };
}

/* ------------------------------------------------------------------ */
/* Étape 2ter — finaliser PLUSIEURS connexions (payload du hook)       */
/* ------------------------------------------------------------------ */

export interface ResultatConnexionMulti {
  /** Connexions effectivement échangées + persistées. */
  reussies: ResultatFinalisation[];
  /** Nombre de publicTokens reçus qui ont échoué (sans payload sensible). */
  echecs: number;
  /** Total des comptes rattachés sur l'ensemble des connexions réussies. */
  comptesRattaches: number;
}

/**
 * Finalisation du flux DROP-IN réel (hook `useOmniFILink`) : `onSuccess` rend un
 * payload `{ connections: [...] }` pouvant porter PLUSIEURS connexions. On
 * échange chaque PublicToken via le chemin déjà testé (finaliserConnexionDropin) :
 * chaque connexion est sa propre transaction scopée et idempotente.
 *
 * Fail-SOFT par connexion (décision : ne pas perdre les connexions déjà
 * persistées si une autre échoue) — un échec est COMPTÉ (échecs++) mais sans
 * détail sensible (règle 8/A1 : pas de publicToken ni de message OBIE remonté).
 * Si AUCUNE ne réussit, on relève la 1re erreur pour que l'action mappe un
 * message (sinon l'UI annoncerait un faux succès « 0 compte »).
 */
export async function finaliserConnexionsDropin(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  publicTokens: string[],
): Promise<ResultatConnexionMulti> {
  const reussies: ResultatFinalisation[] = [];
  let echecs = 0;
  let premiereErreur: unknown = null;

  // Dédoublonnage (constat QA) : si le widget renvoie deux fois la MÊME connexion,
  // l'idempotence des upserts ne persiste qu'une banque — mais sans ce dédoublonnage
  // on échangerait/compterait le token deux fois, gonflant `reussies` et le message
  // UI (« 2 banque(s) » pour une seule). On échange chaque PublicToken AU PLUS une fois.
  const tokensUniques = [...new Set(publicTokens)];

  for (const publicToken of tokensUniques) {
    try {
      reussies.push(await finaliserConnexionDropin(client, executer, { publicToken }));
    } catch (erreur) {
      echecs += 1;
      premiereErreur ??= erreur;
    }
  }

  if (reussies.length === 0) {
    // Aucune connexion persistée : remonter l'erreur (jamais un faux succès).
    throw premiereErreur ?? new Error("Aucune connexion à finaliser");
  }

  return {
    reussies,
    echecs,
    comptesRattaches: reussies.reduce((n, r) => n + r.comptesRattaches, 0),
  };
}
