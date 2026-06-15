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
/* Étape 2bis — finaliser pour le widget DROP-IN (@omnifi/react)       */
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
