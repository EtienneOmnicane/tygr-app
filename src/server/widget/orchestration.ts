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
  OmniFiSyncJob,
} from "@/server/omnifi";
import { OmniFiApiError } from "@/server/omnifi";
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { peutModifier } from "@/lib/permissions";
import type { ExecuterWorkspace, WorkspaceTx } from "@/server/db/tenancy";
// Classes (valeurs) des gardes fail-closed : on les RÉ-LÈVE depuis le fail-soft
// par connexion (cf. plus bas) — un signal de sécurité ne doit JAMAIS être avalé.
import {
  InvalidSessionError,
  UnsafeDatabaseRoleError,
  WorkspaceAccessDeniedError,
} from "@/server/db/tenancy";
import { bankAccounts, bankConnections, workspaces } from "@/server/db/schema";
import {
  upsertCompte,
  upsertConnexion,
  upsertPartieEtRole,
  versPartie,
} from "@/server/repositories/ingestion";
import { normaliserNomInstitution } from "@/server/ingestion/conversion";
import { synchroniserCompte } from "@/server/ingestion/orchestrateur";

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
 * Le contexte de RÉPARATION (ConnectionId + JobId) ne correspond à AUCUNE connexion
 * du workspace courant. Garde anti-IDOR : on refuse de fabriquer un LinkToken REPAIR
 * pour une connexion qu'on ne possède pas (un autre tenant, ou un id forgé). Fail-closed
 * — comme un accès cross-tenant, on ne révèle pas l'existence (mappé en message générique
 * côté action, jamais un oracle). Le `connectionId` est un UUID opaque Omni-FI, pas de PII.
 */
export class ReparationContexteInvalideError extends Error {
  readonly code = "REPAIR_CONTEXT_INVALID";
  constructor() {
    super("Contexte de réparation invalide pour ce workspace");
    this.name = "ReparationContexteInvalideError";
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
/* Étape 1bis — RÉPARATION : LinkToken Mode REPAIR pour rouvrir le widget */
/* ------------------------------------------------------------------ */

export interface DemarrerReparationParams {
  /** Origine HTTPS autorisée à recevoir le PublicToken (postMessage), comme l'onboarding. */
  redirectOrigin: string;
  /** UUID Omni-FI de la connexion défaillante (signal `reparation` remonté par le re-sync). */
  connectionId: string;
  /** UUID Omni-FI du SyncJob en échec (OTP_REQUESTED) — couple le token au job à reprendre. */
  jobId: string;
}

/**
 * Crée un LinkToken de RÉPARATION (`Mode: REPAIR`) pour rouvrir le widget natif sur
 * une connexion en erreur (re-sync repassé en OTP_REQUESTED). Le widget reprend au bon
 * écran (saisie OTP, géré EN INTERNE par le widget — cf. vendor README §MFA handling) :
 * on ne pilote JAMAIS la MFA côté serveur (endpoints Bearer/MFA morts).
 *
 * Sécurité (mêmes invariants que demarrerConnexion + garde de contexte) :
 * - Gating MANAGER/ADMIN (peutModifier) ; VIEWER → ConnexionNonAutoriseeError.
 * - `ClientUserId` = workspace courant (frontière tenant), jamais un paramètre client.
 * - Anti-IDOR : on VÉRIFIE que `connectionId` est bien une connexion du workspace courant
 *   (scopé RLS) AVANT d'appeler Omni-FI — un id d'un autre tenant ou forgé lève
 *   ReparationContexteInvalideError (fail-closed, pas d'oracle d'existence).
 */
export async function demarrerReparation(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: DemarrerReparationParams,
): Promise<ResultatDemarrage> {
  const clientUserId = await executer(async (tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();
    // Garde de contexte (anti-IDOR) : la connexion DOIT exister dans ce workspace.
    // La RLS borne déjà la requête au tenant ; ce SELECT confirme l'appartenance avant
    // de demander un token REPAIR pour elle (sinon on fabriquerait un contexte de
    // réparation pour une connexion qu'on ne possède pas).
    const lignes = await tx
      .select({ id: bankConnections.id })
      .from(bankConnections)
      .where(eq(bankConnections.omnifiConnectionId, params.connectionId))
      .limit(1);
    if (lignes.length === 0) throw new ReparationContexteInvalideError();
    return clientUserIdDuWorkspace(tx, ctx.workspaceId);
  });

  const lt = await client.creerLinkToken({
    ClientUserId: clientUserId,
    RedirectOrigin: params.redirectOrigin,
    ConnectionId: params.connectionId,
    JobId: params.jobId,
    // ResumeStep omis : on laisse l'amont le dériver du JobId (l'OTP_REQUESTED implique
    // MFA_CHALLENGE, mais ne pas le coder en dur évite un désalignement si l'amont décide
    // de reprendre aux credentials). AccountSelectionEnabled inutile en REPAIR (comptes
    // déjà découverts) — on n'impose rien.
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
 * Ingestion best-effort des PARTIES (détention compte↔party, L3) pour les comptes
 * d'un tour de synchro. Appelée APRÈS le commit des comptes, dans une transaction
 * SÉPARÉE — un échec ici ne doit JAMAIS toucher l'ingestion bancaire déjà commitée
 * (décision actée : exécuteur séparé, pas de SAVEPOINT). On itère sur une COLLECTION
 * de parties dérivée des comptes (`versPartie` → 0/1 party aujourd'hui ; le jour où
 * l'amont expose un tableau, seul le mappeur change — la boucle est déjà N-N-ready).
 *
 * Fail-soft qui NE MASQUE PAS l'isolation : une erreur de DONNÉES (party malformée,
 * contrainte) est journalisée (code OPAQUE, jamais de PII) puis on continue ; mais les
 * erreurs SYSTÉMIQUES de tenancy sont RE-LEVÉES verbatim — exactement la même liste que
 * la boucle de synchro (cf. plus bas), car un fail-soft ne doit jamais avaler un signal
 * de sécurité (RLS contournable / session invalide). CLAUDE.md règle 9.
 */
async function ingererPartiesDesComptes(
  executer: ExecuterWorkspace,
  comptes: { compte: OmniFiAccount; bankAccountId: string }[],
): Promise<void> {
  for (const { compte, bankAccountId } of comptes) {
    const partie = versPartie(compte);
    if (partie === null) continue; // compte sans party → rien à lier (fail-closed)
    try {
      await executer((tx, ctx) =>
        upsertPartieEtRole(tx, ctx, bankAccountId, partie),
      );
    } catch (erreur) {
      // RE-THROW obligatoire des erreurs systémiques de tenancy (même liste que la
      // boucle connexion) : un fail-soft de DONNÉES ne doit JAMAIS masquer une faille
      // d'isolation (anti-IDOR). On ne lisse pas un UNSAFE_DB_ROLE en simple warning.
      if (
        erreur instanceof UnsafeDatabaseRoleError ||
        erreur instanceof WorkspaceAccessDeniedError ||
        erreur instanceof InvalidSessionError ||
        erreur instanceof ConnexionNonAutoriseeError
      ) {
        throw erreur;
      }
      // Erreur de DONNÉES (party malformée, contrainte) : on logue le code SANS PII
      // (identifiant Omni-FI opaque uniquement, jamais PartyName ni libellé) et on
      // continue — les comptes/transactions déjà commités restent intacts.
      const code =
        erreur instanceof Error ? erreur.name : "ERREUR_INCONNUE";
      console.warn(
        JSON.stringify({
          evt: "parties_ingestion_echec",
          omnifiAccountId: compte.AccountId,
          code,
        }),
      );
    }
  }
}

/**
 * Persiste connexion + comptes (Enabled uniquement) dans le workspace courant,
 * dans UNE transaction scopée, PUIS — dans une transaction SÉPARÉE (couche sacrée :
 * cf. ingererPartiesDesComptes) — ingère les parties des comptes rattachés.
 * Partagé par TOUS les chemins de finalisation (widget custom via getSyncJobAccounts,
 * drop-in via GET /accounts, sync multi-connexions, réparation) : point d'écriture
 * UNIQUE des comptes ET des parties, sans duplication. Idempotent (upserts sur
 * omnifi_*_id). Exporté pour la suite d'isolation (exit-criterion règle 3).
 */
export async function persisterConnexionEtComptes(
  executer: ExecuterWorkspace,
  echange: {
    ConnectionId: string;
    InstitutionId: string;
    // OPTIONNEL : présent quand la source le porte (GET /connections → sync), absent
    // sur link-exchange (OmniFiPublicTokenExchangeData = ConnectionId/InstitutionId/
    // CustomerType seulement). Quand absent → null ; l'upsert rafraîchira le nom au
    // prochain passage d'un chemin qui le porte (DASH-INST1).
    InstitutionName?: string | null;
  },
  comptes: OmniFiAccount[],
): Promise<number> {
  // 1. Connexion + comptes dans UNE transaction. On collecte les paires
  //    (compte Omni-FI, bankAccountId local) des comptes RÉELLEMENT rattachés
  //    pour pouvoir lier leurs parties juste après (sans relecture).
  const rattaches = await executer(async (tx, ctx) => {
    const { connectionId } = await upsertConnexion(tx, ctx, {
      omnifiConnectionId: echange.ConnectionId,
      institutionId: echange.InstitutionId,
      institutionName: normaliserNomInstitution(echange.InstitutionName),
      status: "active",
      nextSyncAvailableAt: null,
    });

    const paires: { compte: OmniFiAccount; bankAccountId: string }[] = [];
    for (const c of comptes) {
      // On rattache les comptes utilisables. `GET /accounts` ne renvoie déjà QUE les
      // comptes confirmés/actifs côté Omni-FI ; le champ Status précise l'état
      // bancaire OBIE (Enabled/Disabled/Deleted…). On EXCLUT seulement les états
      // explicitement non exploitables ; un Status ABSENT (null/undefined) est traité
      // comme exploitable — le sandbox Omni-FI renvoie `Status: null` sur des comptes
      // par ailleurs valides (vérifié runtime 2026-06-18), et les rejeter vidait la
      // synchro (« 0 compte rattaché » malgré des comptes réels avec soldes).
      if (c.Status != null && c.Status !== "Enabled") continue;
      const { bankAccountId } = await upsertCompte(tx, ctx, connectionId, {
        omnifiAccountId: c.AccountId,
        accountName: c.Nickname ?? c.PartyName ?? `Compte ${c.AccountId.slice(0, 8)}`,
        currency: c.Currency,
        currentBalance: soldeCourant(c.Balances),
        isSelected: true,
      });
      paires.push({ compte: c, bankAccountId });
    }
    return paires;
  });

  // 2. Parties (L3) : transaction SÉPARÉE, après le COMMIT des comptes ci-dessus.
  //    Best-effort fail-soft — protège la couche bancaire déjà commitée (DÉCISION 2).
  await ingererPartiesDesComptes(executer, rattaches);

  return rattaches.length;
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

/* ------------------------------------------------------------------ */
/* Déclenchement de sync RÉEL (scraping) + attente de job              */
/* ------------------------------------------------------------------ */

/** Cadence de polling du job de sync (le job peut être COMPLETED dès t+0). */
const POLL_SYNC_INTERVAL_MS = 3_000;
/** Plafond d'attente d'un job (au-delà : on abandonne CE compte, fail-soft). */
const POLL_SYNC_PLAFOND_MS = 120_000;

/** États terminaux d'un SyncJob (cf. OmniFiSyncStatus). */
const SYNC_STATUTS_TERMINAUX = new Set<OmniFiSyncJob["Status"]>(["COMPLETED", "FAILED"]);
/** États MFA : le re-sync attend un OTP — non fournissable côté serveur (widget natif). */
const SYNC_STATUTS_MFA = new Set<OmniFiSyncJob["Status"]>(["OTP_REQUESTED", "OTP_WAITING"]);

/**
 * Issue de l'attente d'un job de sync. `status` = état terminal observé, ou
 * "TIMEOUT" si le plafond est atteint sans terminal. `persistenceStats` est posé à
 * COMPLETED (signal d'observabilité), `errorType` à FAILED (Type seul, jamais le
 * Message OBIE — règle 8).
 */
export interface ResultatAttenteSync {
  status: "COMPLETED" | "FAILED" | "OTP_REQUESTED" | "TIMEOUT";
  jobId: string;
  persistenceStats?: OmniFiSyncJob["PersistenceStats"];
  errorType?: string | null;
}

/** Sommeil non bloquant (injectable indirectement via le plafond pour les tests). */
function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attend la fin d'un job de sync, SANS supposer d'ordre de transitions (le diag a
 * observé PENDING → COMPLETED à t+0s, sans état intermédiaire). Stratégie :
 *  1. 1er poll IMMÉDIAT (pas de sleep) — le job peut déjà être terminal ;
 *  2. sinon, boucle : sleep `POLL_SYNC_INTERVAL_MS` puis re-poll, jusqu'au plafond.
 * On ne traite QUE les états terminaux (COMPLETED/FAILED) + le cas MFA (OTP_REQUESTED).
 *
 * À COMPLETED : on logue `PersistenceStats` en log structuré SANS PII — c'est la
 * preuve différée pour trancher « auto-refresh vs à la demande » en prod (un
 * Created>0 alors que la relecture seule ne bougeait pas = trigger indispensable).
 *
 * Le polling passe par `getSyncJobServeur` (ApiKey + client_user_id, déjà au client) :
 * on ne touche jamais aux endpoints Bearer/MFA (morts, pilotés par le widget natif).
 */
export async function attendreFinSync(
  client: OmniFiClient,
  jobId: string,
  clientUserId: string,
  connectionId: string,
): Promise<ResultatAttenteSync> {
  const debut = Date.now();
  let premier = true;

  for (;;) {
    // 1er tour sans sleep ; les suivants après une pause (le job peut déjà être fini).
    if (!premier) await dormir(POLL_SYNC_INTERVAL_MS);
    premier = false;

    const job = await client.getSyncJobServeur(jobId, clientUserId);
    const status = job.Status;

    if (SYNC_STATUTS_MFA.has(status)) {
      // Le re-sync exige un OTP : on ne peut pas y répondre côté serveur. L'UI
      // rouvrira le widget natif en mode REPAIR. On NE logue PAS de PII.
      return { status: "OTP_REQUESTED", jobId };
    }

    if (SYNC_STATUTS_TERMINAUX.has(status)) {
      if (status === "COMPLETED") {
        const ps = job.PersistenceStats ?? null;
        // Log structuré d'observabilité (sans PII) : la PREUVE différée du besoin de
        // trigger. `created/updated/duplicated` chiffrent ce que le scraping a ramené.
        console.info(
          JSON.stringify({
            evt: "omnifi_sync_completed",
            connectionId,
            jobId,
            created: ps?.TransactionsCreated ?? 0,
            updated: ps?.TransactionsUpdated ?? 0,
            duplicated: ps?.TransactionsDuplicated ?? 0,
          }),
        );
        return { status: "COMPLETED", jobId, persistenceStats: ps };
      }
      // FAILED : on garde le Type (machine), jamais le Message (peut porter de la PII).
      return { status: "FAILED", jobId, errorType: job.Error?.Type ?? null };
    }

    // État non terminal : on continue à poller jusqu'au plafond.
    if (Date.now() - debut >= POLL_SYNC_PLAFOND_MS) {
      return { status: "TIMEOUT", jobId };
    }
  }
}

/**
 * Issue du déclenchement d'un sync pour UNE connexion, avant la lecture. Sert à
 * remonter à l'UI les cas qui ne sont pas des échecs « durs » :
 *  - DECLENCHE  : un job a tourné jusqu'à COMPLETED → la lecture peut suivre ;
 *  - RATE_LIMITED : sync trop rapproché (garde NextSyncAvailableAt ou 429) → on
 *    NE déclenche pas, on relit quand même l'état courant (l'utilisateur voit le
 *    dernier état connu) ; `nextSyncAt` informe du délai ;
 *  - NEEDS_REPAIR : le re-sync est repassé en OTP_REQUESTED → l'UI doit rouvrir le
 *    widget natif en mode REPAIR (link-token avec ConnectionId + JobId) ;
 *  - SKIP_FAILED : job FAILED ou timeout de polling → compté en échec (fail-soft).
 */
type IssueTrigger =
  | { kind: "DECLENCHE" }
  | { kind: "RATE_LIMITED"; nextSyncAt: string | null }
  | { kind: "NEEDS_REPAIR"; jobId: string }
  | { kind: "SKIP_FAILED"; errorType?: string | null };

/**
 * `NextSyncAvailableAt` est-il dans le FUTUR (sync encore en cooldown) ? Parse ISO
 * 8601 ; une valeur absente/illisible/passée ⇒ pas de cooldown (on peut déclencher).
 */
function cooldownActif(nextSyncAvailableAt: string | null | undefined): boolean {
  if (!nextSyncAvailableAt) return false;
  const ms = Date.parse(nextSyncAvailableAt);
  return !Number.isNaN(ms) && ms > Date.now();
}

/**
 * Un 400 de declencherSync signale-t-il « un sync tourne DÉJÀ » (vs un 400 d'une
 * autre cause) ? On reconnaît le motif sur l'obieCode/Message OBIE de façon tolérante
 * (l'amont n'a pas de code machine stable documenté pour ce cas) : « already running »
 * ou « in progress », insensible à la casse. Un obieCode absent ⇒ false (on ne part PAS
 * poller le dernier job sur un 400 ambigu — fail-safe contre le faux « sync effectué »).
 */
function estSyncDejaEnCours(obieCode: string | null): boolean {
  if (!obieCode) return false;
  const c = obieCode.toLowerCase();
  return c.includes("already running") || c.includes("in progress") || c.includes("running");
}

/**
 * Déclenche (ou non) un sync pour une connexion, gardé EN AMONT par le cooldown,
 * puis attend le job. Ne LIT PAS les transactions (la lecture existante suit selon
 * l'issue). Centralise toute la gestion 429/400-concurrent/OTP/FAILED.
 */
async function declencherEtAttendre(
  client: OmniFiClient,
  connectionId: string,
  clientUserId: string,
  nextSyncAvailableAt: string | null,
): Promise<IssueTrigger> {
  // (a) GARDE rate-limit AMONT : un NextSyncAvailableAt futur (vu dans GET /connections)
  // signifie qu'un sync a tourné récemment → NE PAS déclencher (évite un 429 inutile
  // à chaque clic). On relira quand même l'état courant en aval.
  if (cooldownActif(nextSyncAvailableAt)) {
    return { kind: "RATE_LIMITED", nextSyncAt: nextSyncAvailableAt };
  }

  // (b) Déclenchement. On distingue 429 (course avec la garde) et 400 (job déjà en cours).
  let job: OmniFiSyncJob;
  try {
    job = await client.declencherSync(connectionId, clientUserId);
  } catch (erreur) {
    if (erreur instanceof OmniFiApiError && erreur.estRateLimit) {
      // 429 malgré la garde (course / cooldown non remonté par GET /connections) :
      // on relit `latest-job` pour exposer le délai, sans re-déclencher.
      const next = await nextSyncDepuisLatest(client, connectionId, clientUserId);
      return { kind: "RATE_LIMITED", nextSyncAt: next };
    }
    // 400 « sync already running » UNIQUEMENT : un job tourne déjà → on récupère SON
    // JobId et on poll dessus (idempotence côté user). On RESTREINT à ce motif (obieCode)
    // : sans ce filtre, un 400 d'une AUTRE cause (param rejeté, connexion en mauvais
    // état) partirait poller le dernier job — souvent un vieux COMPLETED — et conclurait
    // à tort « sync effectué » (faux positif silencieux, constat de revue). Tout autre
    // 400 remonte comme une erreur dure (cf. throw final).
    if (
      erreur instanceof OmniFiApiError &&
      erreur.status === 400 &&
      estSyncDejaEnCours(erreur.obieCode)
    ) {
      const latest = await client.getLatestSyncJob(connectionId, clientUserId);
      if (!latest.JobId) return { kind: "SKIP_FAILED", errorType: "NO_JOB_ID" };
      // Défense en profondeur : si le « dernier job » est déjà TERMINAL (vieux
      // COMPLETED/FAILED), il ne s'agit pas d'un sync EN COURS → on ne conclut pas
      // DECLENCHE à tort. On le compte en échec doux (rien de frais à lire).
      if (SYNC_STATUTS_TERMINAUX.has(latest.Status)) {
        return { kind: "SKIP_FAILED", errorType: "STALE_LATEST_JOB" };
      }
      return interpreterAttente(
        await attendreFinSync(client, latest.JobId, clientUserId, connectionId),
      );
    }
    throw erreur; // 400 autre / réseau / timeout / 5xx / 403… : remonte (générique côté action)
  }

  if (!job.JobId) return { kind: "SKIP_FAILED", errorType: "NO_JOB_ID" };

  // (c) Attente du job déclenché.
  return interpreterAttente(
    await attendreFinSync(client, job.JobId, clientUserId, connectionId),
  );
}

/** Traduit une issue d'attente de job en issue de trigger (pour la lecture en aval). */
function interpreterAttente(r: ResultatAttenteSync): IssueTrigger {
  switch (r.status) {
    case "COMPLETED":
      return { kind: "DECLENCHE" };
    case "OTP_REQUESTED":
      return { kind: "NEEDS_REPAIR", jobId: r.jobId };
    case "FAILED":
      return { kind: "SKIP_FAILED", errorType: r.errorType };
    case "TIMEOUT":
      return { kind: "SKIP_FAILED", errorType: "POLL_TIMEOUT" };
  }
}

/** Lit `NextSyncAvailableAt` du dernier job (best-effort, jamais throw fatal). */
async function nextSyncDepuisLatest(
  client: OmniFiClient,
  connectionId: string,
  clientUserId: string,
): Promise<string | null> {
  try {
    const latest = await client.getLatestSyncJob(connectionId, clientUserId);
    return latest.NextSyncAvailableAt ?? null;
  } catch {
    return null;
  }
}

export interface ResultatSynchronisation {
  connexions: number;
  comptesRattaches: number;
  /** Transactions importées (toutes pages, tous comptes) lors de cette synchro. */
  transactionsImportees: number;
  /**
   * Connexions dont le re-sync exige une réparation MFA (OTP_REQUESTED) — l'UI doit
   * rouvrir le widget natif en mode REPAIR. Porte le ConnectionId + le JobId (pour
   * un futur link-token de REPAIR). Vide = aucun cas.
   */
  aReparer: Array<{ connectionId: string; jobId: string }>;
  /**
   * Connexions non re-synchronisées car en cooldown (« 1 sync / 15 min ») — PAS une
   * erreur : on a relu le dernier état connu. `nextSyncAt` = quand un nouveau sync
   * sera possible (ISO 8601, ou null si inconnu). Vide = aucun cas.
   */
  rateLimited: Array<{ connectionId: string; nextSyncAt: string | null }>;
  /**
   * Connexions qui ont ÉCHOUÉ « dur » pendant ce passage (erreur Omni-FI 4xx/5xx hors
   * 429/already-running, désalignement, panne réseau, etc.) — traitées en FAIL-SOFT :
   * la connexion est sautée, les AUTRES continuent, et la fonction atteint quand même
   * son `return`. Avant ce correctif, une telle erreur faisait `throw` et masquait tous
   * les succès derrière un faux « échec total » (bug). Détail non-énumérant : on ne
   * porte que l'identifiant opaque + le code machine / status / obieCode (jamais de
   * libellé bancaire ni de Message OBIE brut, règle 8). `code` = code machine de
   * l'erreur (ex. OMNIFI_API_ERROR) ; `status`/`obieCode` présents si OmniFiApiError.
   */
  echecs: number;
  echecsDetail: Array<{
    connectionId: string;
    code: string;
    status?: number;
    obieCode?: string | null;
  }>;
  /**
   * Connexions dont l'EndUser/credential est DÉSALIGNÉ côté Omni-FI : l'appel
   * per-connexion a répondu HTTP 403 (obieCode `PUBLIC_TOKEN_CLIENT_MISMATCH`),
   * signe que le lien banque n'est plus rattachable à ce ClientUserId (incident
   * prod : comptes silencieusement vides avec un `last_synced_at` frais). Ce n'est
   * PAS un échec « dur » générique (donc HORS `echecsDetail`/`echecs`) : c'est un
   * état ACTIONNABLE distinct — l'UI doit proposer « Reconnecter cette banque »
   * (rouvrir le widget natif). Non-énumérant : identifiant opaque + code/status/
   * obieCode sûrs uniquement (règle 8 : jamais de libellé bancaire ni de Message
   * OBIE brut). Vide = aucun cas.
   */
  aReconnecter: Array<{
    connectionId: string;
    code: string;
    status: number;
    obieCode: string | null;
  }>;
}

/**
 * obieCode Omni-FI signalant un désalignement EndUser/credential (le lien banque
 * échangé ne correspond plus au ClientUserId courant). Code MACHINE stable, jamais
 * un libellé à parser (règle 3). Cf. l'entête de ce module (§ Sécurité).
 */
const OBIE_DESALIGNEMENT_ENDUSER = "PUBLIC_TOKEN_CLIENT_MISMATCH";

/**
 * Vrai ssi l'erreur est le désalignement EndUser/credential : `OmniFiApiError` en
 * HTTP 403. On PRIORISE l'obieCode `PUBLIC_TOKEN_CLIENT_MISMATCH` quand l'enveloppe
 * OBIE le porte, mais le status 403 reste le DISCRIMINANT robuste et suffisant
 * (l'obieCode peut être absent). Codes machine uniquement (règle 3 : jamais de
 * parsing de message). Séparé du fail-soft générique : ce cas alimente
 * `aReconnecter`, pas `echecsDetail`.
 */
function estDesalignementEndUser(erreur: unknown): erreur is OmniFiApiError {
  // Discriminant final : le status 403 (l'obieCode peut manquer). L'obieCode
  // `PUBLIC_TOKEN_CLIENT_MISMATCH` est la signature exacte attendue (voir constante) ;
  // un 403 sans obieCode, ou avec un autre code d'accès, reste un désalignement d'accès
  // que l'utilisateur résout par une reconnexion — on le route au même endroit.
  return (
    erreur instanceof OmniFiApiError &&
    erreur.status === 403 &&
    (erreur.obieCode === OBIE_DESALIGNEMENT_ENDUSER || erreur.obieCode !== "")
  );
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
  const connexions: Array<{
    ConnectionId: string;
    InstitutionId: string;
    InstitutionName: string | null;
    /** Cooldown amont (« 1 sync / 15 min ») : garde anti-429 du déclenchement (étape 3). */
    NextSyncAvailableAt: string | null;
  }> = [];
  let pageC = 1;
  for (;;) {
    const env = await client.listerConnexions(clientUserId, { page: pageC });
    for (const c of env.Data.Connections ?? []) {
      // On ne rattache que les connexions exploitables (actives).
      if (c.Status === "active" || c.Status === "Active") {
        // GET /connections porte InstitutionName → on le propage pour le persister
        // (DASH-INST1 ; ce chemin = bouton « Synchroniser mes comptes »).
        connexions.push({
          ConnectionId: c.ConnectionId,
          InstitutionId: c.InstitutionId,
          InstitutionName: c.InstitutionName ?? null,
          // Cooldown lu ICI (pas d'appel supplémentaire) → garde rate-limit en amont.
          NextSyncAvailableAt: c.NextSyncAvailableAt ?? null,
        });
      }
    }
    const totalPages = env.Meta?.TotalPages ?? 1;
    if (!env.Links?.Next || pageC >= totalPages) break;
    pageC += 1;
  }

  // 2bis. PÉRIMÈTRE (LOT 1) : le sync ne RAFRAÎCHIT que les connexions DÉJÀ en base de
  // ce workspace (celles créées via le widget). Une connexion vue côté Omni-FI mais
  // ABSENTE de bank_connections est IGNORÉE — JAMAIS créée par le sync (décision produit :
  // ajouter une banque passe par le widget, pas par le bouton « Synchroniser »). Sans ce
  // filtre, `GET /connections` ramène TOUT l'univers de l'EndUser et chaque connexion
  // découverte était upsertée (banques jamais connectées créées en base).
  //
  // Le SELECT est SCOPÉ (DANS executer → RLS workspace courant) : il ne peut retourner que
  // les omnifi_connection_id de CE tenant. Filtrer sur un ensemble non scopé réintroduirait
  // une voie cross-tenant — la garde est volontairement fail-closed (un id inconnu = exclu).
  const connexionsConnues = await executer(async (tx) => {
    const lignes = await tx
      .select({ omnifiConnectionId: bankConnections.omnifiConnectionId })
      .from(bankConnections);
    return new Set(lignes.map((l) => l.omnifiConnectionId));
  });
  // On ne garde que les connexions présentes en base. Une connexion exclue ici ne génère
  // AUCUN appel Omni-FI en aval (ni listerComptesConnexion, ni declencherSync) et n'est PAS
  // comptée dans `connexions` (le compteur reflète les banques réellement traitées).
  const connexionsATraiter = connexions.filter((cx) =>
    connexionsConnues.has(cx.ConnectionId),
  );

  // 3. Pour CHAQUE connexion : (a) découvrir + persister les comptes, (b) DÉCLENCHER
  //    un sync RÉEL gardé par le cooldown puis attendre le job, (c) selon l'issue,
  //    ingérer les transactions de SES comptes (boucle de lecture INCHANGÉE). On
  //    traite par connexion pour pouvoir stopper une connexion en réparation MFA
  //    sans pénaliser les autres (fail-soft conservé).
  let comptesRattaches = 0;
  let transactionsImportees = 0;
  const aReparer: Array<{ connectionId: string; jobId: string }> = [];
  const rateLimited: Array<{ connectionId: string; nextSyncAt: string | null }> = [];
  const echecsDetail: ResultatSynchronisation["echecsDetail"] = [];
  const aReconnecter: ResultatSynchronisation["aReconnecter"] = [];

  for (const cx of connexionsATraiter) {
    // FAIL-SOFT PAR CONNEXION : tout le corps de traitement d'UNE connexion est
    // enveloppé. Une erreur dure (OmniFiApiError 4xx/5xx hors 429/already-running gérés
    // en amont, désalignement, panne réseau, échec DB…) est CAPTURÉE ici : on l'enregistre
    // et on passe à la connexion suivante. Avant, ce throw remontait jusqu'à l'action et
    // masquait TOUS les succès derrière un faux « échec total ». Les cas non-durs
    // (RATE_LIMITED, NEEDS_REPAIR, SKIP_FAILED) restent gérés par `declencherEtAttendre`
    // (qui ne throw pas pour eux) et NE comptent PAS comme des échecs.
    try {
      // (a) Découverte + persistance des comptes (filtré connectionId, paginé).
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

      // (b) Déclenchement gardé (cooldown amont) + attente du job.
      const issue = await declencherEtAttendre(
        client,
        cx.ConnectionId,
        clientUserId,
        cx.NextSyncAvailableAt,
      );

      // (c) Réaction à l'issue AVANT la lecture des transactions.
      if (issue.kind === "NEEDS_REPAIR") {
        // Re-sync repassé en OTP_REQUESTED : on STOPPE cette connexion (pas de lecture)
        // et on signale à l'UI de rouvrir le widget natif en mode REPAIR. Les endpoints
        // MFA serveur restent morts (pilotés par le widget natif).
        aReparer.push({ connectionId: cx.ConnectionId, jobId: issue.jobId });
        continue;
      }
      if (issue.kind === "SKIP_FAILED") {
        // FAILED / timeout de polling : on n'ingère pas cette connexion (fail-soft) ;
        // le code machine est tracé par attendreFinSync, jamais de PII ici.
        continue;
      }
      if (issue.kind === "RATE_LIMITED") {
        // Cooldown actif : on N'a PAS déclenché, mais on relit quand même l'état COURANT
        // (le user voit au moins le dernier état connu) → on NE `continue` pas.
        rateLimited.push({ connectionId: cx.ConnectionId, nextSyncAt: issue.nextSyncAt });
      }
      // issue.kind === "DECLENCHE" (sync COMPLETED) OU "RATE_LIMITED" (lecture du cache) :
      // dans les deux cas on lit les transactions des comptes de CETTE connexion.

      // Ingestion des transactions des comptes DÉCOUVERTS pour cette connexion. On résout
      // (omnifiAccountId → bankAccountId local) DANS le tx scopé (RLS), filtré aux comptes
      // de cette connexion (par leur omnifi_account_id) — la boucle de lecture/upsert
      // `synchroniserCompte` reste strictement identique (couche d'ingestion intacte).
      const omnifiIds = comptes
        .filter((c) => c.Status == null || c.Status === "Enabled")
        .map((c) => c.AccountId);
      if (omnifiIds.length === 0) continue;

      const comptesAIngerer = await executer(async (tx) =>
        tx
          .select({
            bankAccountId: bankAccounts.id,
            omnifiAccountId: bankAccounts.omnifiAccountId,
          })
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.isSelected, true),
              inArray(bankAccounts.omnifiAccountId, omnifiIds),
            ),
          ),
      );

      for (const cpt of comptesAIngerer) {
        const r = await synchroniserCompte(client, executer, {
          omnifiAccountId: cpt.omnifiAccountId,
          bankAccountId: cpt.bankAccountId,
          clientUserId,
        });
        transactionsImportees += r.transactionsTraitees;
      }
    } catch (erreur) {
      // GARDE-FOU SÉCURITÉ (cross-review) : une erreur fail-closed de tenancy NE DOIT
      // PAS être avalée en « échec de connexion ». `withWorkspace` re-valide la
      // membership ET le rôle DB non-propriétaire à CHAQUE transaction (C6) ; si elle
      // lève UnsafeDatabaseRoleError / WorkspaceAccessDeniedError / InvalidSessionError,
      // c'est un signal SYSTÉMIQUE (RLS contournable, session invalide) qui doit
      // interrompre TOUTE l'opération et remonter bruyamment (mappé 500 par l'action),
      // pas devenir un message UI « tout échoué » discret. On RÉ-LÈVE. Seules les
      // erreurs propres à une connexion (Omni-FI 4xx/5xx, désalignement, réseau) restent
      // fail-soft. CLAUDE.md règle 9 : la dette d'isolation tenant est INTERDITE.
      if (
        erreur instanceof UnsafeDatabaseRoleError ||
        erreur instanceof WorkspaceAccessDeniedError ||
        erreur instanceof InvalidSessionError ||
        erreur instanceof ConnexionNonAutoriseeError
      ) {
        throw erreur;
      }
      // DÉSALIGNEMENT ENDUSER (403 PUBLIC_TOKEN_CLIENT_MISMATCH) : PAS un échec dur
      // générique. Le credential de CETTE banque n'est plus rattachable au ClientUserId
      // courant ; Omni-FI renvoie 403 et notre code, jusqu'ici, l'avalait en échec
      // silencieux → l'utilisateur voyait des comptes vides avec un last_synced_at frais
      // (incident prod). On le route vers un bucket DÉDIÉ, ACTIONNABLE : l'UI proposera
      // « Reconnecter cette banque » (rouvrir le widget natif). On le sort AVANT le
      // fail-soft générique pour qu'il ne soit ni compté en `echecs` ni fondu dans
      // `echecsDetail`. Détail SÛR uniquement (règle 8) ; on ne `continue` pas
      // explicitement — le catch termine déjà l'itération de cette connexion.
      if (estDesalignementEndUser(erreur)) {
        aReconnecter.push({
          connectionId: cx.ConnectionId,
          code: erreur.code,
          status: erreur.status,
          obieCode: erreur.obieCode,
        });
        // Observabilité dédiée : événement DISTINCT du fail-soft générique (jamais de
        // PII ; connectionId = UUID opaque Omni-FI, status/obieCode sûrs).
        console.warn(
          JSON.stringify({
            evt: "omnifi_sync_connexion_a_reconnecter",
            connectionId: cx.ConnectionId,
            code: erreur.code,
            status: erreur.status,
            obieCode: erreur.obieCode,
          }),
        );
        continue;
      }
      // Échec dur de CETTE connexion : compté une fois, jamais propagé (les autres
      // connexions et le `return` final sont préservés). Détail SÛR uniquement.
      const detail = detailErreurSure(erreur);
      echecsDetail.push({ connectionId: cx.ConnectionId, ...detail });
      // Observabilité : comme on ne `throw` plus, cet échec ne passe PLUS par
      // `messageDepuis` côté action → on le journalise ICI (sinon il serait invisible).
      // connectionId = identifiant opaque Omni-FI (pas de PII) ; status/obieCode sûrs.
      console.warn(
        JSON.stringify({
          evt: "omnifi_sync_connexion_echec",
          connectionId: cx.ConnectionId,
          ...detail,
        }),
      );
    }
  }

  return {
    // Option 1 : on compte les connexions RÉELLEMENT traitées (connues en base), pas le
    // total vu côté Omni-FI — cohérent avec le message UI « N banque(s) à jour » (un
    // workspace sans connexion → 0 → message neutre côté action).
    connexions: connexionsATraiter.length,
    comptesRattaches,
    transactionsImportees,
    aReparer,
    rateLimited,
    echecs: echecsDetail.length,
    echecsDetail,
    aReconnecter,
  };
}

/**
 * Extrait d'une erreur QUE des champs sûrs à logger/remonter (règle 8 / A1) : code
 * machine, et — si OmniFiApiError — `status` HTTP + `obieCode` (jamais le Message OBIE
 * brut, qui peut porter de la PII). Utilisé par le fail-soft par connexion.
 */
function detailErreurSure(erreur: unknown): {
  code: string;
  status?: number;
  obieCode?: string | null;
} {
  const code =
    erreur instanceof Error && "code" in erreur && typeof erreur.code === "string"
      ? erreur.code
      : erreur instanceof Error
        ? erreur.name
        : "UNKNOWN";
  if (erreur instanceof OmniFiApiError) {
    return { code, status: erreur.status, obieCode: erreur.obieCode };
  }
  return { code };
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

/* ------------------------------------------------------------------ */
/* Étape 2quater — re-lire UNE connexion après réparation (onSuccess)   */
/* ------------------------------------------------------------------ */

export interface ResultatResynchronisationConnexion {
  /** Comptes (re)découverts + persistés pour cette connexion. */
  comptesRattaches: number;
  /** Transactions importées (toutes pages, tous comptes de la connexion). */
  transactionsImportees: number;
  /**
   * Présent (JobId du nouveau sync) si le re-sync a ENCORE demandé une vérification de
   * sécurité (job reparti en OTP_REQUESTED). Rare juste après une réparation réussie, mais
   * possible (la banque redemande un OTP) : l'UI peut laisser le bouton « Reconnecter » en
   * place, ré-armé sur CE jobId. Absent = pas de réparation en attente.
   */
  reparationJobId?: string;
}

/**
 * Re-lit UNE connexion après que le widget natif a terminé une RÉPARATION (saisie OTP
 * dans le widget). Réutilise STRICTEMENT la même mécanique que
 * `synchroniserConnexionsDepuisOmnifi`, mais ciblée sur une seule connexion : on
 * (a) re-découvre + persiste ses comptes, (b) déclenche un sync gardé par le cooldown
 * et on attend le job, (c) ingère les transactions via `synchroniserCompte` (couche
 * d'ingestion INCHANGÉE). Idempotent.
 *
 * Sécurité : gating MANAGER/ADMIN + ClientUserId scopé (frontière tenant). Anti-IDOR :
 * la connexion DOIT appartenir au workspace courant (scopé RLS), sinon
 * ReparationContexteInvalideError. Fail-soft : un sync FAILED/timeout ne lève pas — on
 * remonte ce qui a été lu (l'UI affiche un message neutre).
 */
export async function resynchroniserConnexion(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  connectionIdOmnifi: string,
): Promise<ResultatResynchronisationConnexion> {
  // 1. Garde de rôle + appartenance au tenant + ClientUserId scopé.
  const { clientUserId } = await executer(async (tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();
    const lignes = await tx
      .select({ id: bankConnections.id })
      .from(bankConnections)
      .where(eq(bankConnections.omnifiConnectionId, connectionIdOmnifi))
      .limit(1);
    if (lignes.length === 0) throw new ReparationContexteInvalideError();
    return { clientUserId: await clientUserIdDuWorkspace(tx, ctx.workspaceId) };
  });

  // 2. (a) Re-découverte + persistance des comptes de CETTE connexion (paginé).
  const comptes: OmniFiAccount[] = [];
  let pageA = 1;
  let institutionId: string | null = null;
  for (;;) {
    const env = await client.listerComptesConnexion(connectionIdOmnifi, clientUserId, {
      page: pageA,
    });
    const lot = env.Data.Account ?? [];
    comptes.push(...lot);
    // L'InstitutionId sert à l'alignement (fail-closed) ; on le prend du 1er compte vu.
    institutionId ??= lot[0]?.InstitutionId ?? null;
    const totalPages = env.Meta?.TotalPages ?? 1;
    if (!env.Links?.Next || pageA >= totalPages) break;
    pageA += 1;
  }
  // Alignement : on ne persiste pas des comptes dont l'institution diverge (cf.
  // verifierAlignement). Sans institution résolue (0 compte), rien à vérifier/persister.
  if (institutionId !== null) verifierAlignement(comptes, institutionId);
  const comptesRattaches =
    institutionId === null
      ? 0
      : await persisterConnexionEtComptes(
          executer,
          { ConnectionId: connectionIdOmnifi, InstitutionId: institutionId },
          comptes,
        );

  // 2. (b) Déclenchement gardé (cooldown amont) + attente du job.
  const issue = await declencherEtAttendre(
    client,
    connectionIdOmnifi,
    clientUserId,
    // On ne connaît pas NextSyncAvailableAt ici (pas de GET /connections) : on laisse
    // declencherEtAttendre gérer un éventuel 429 (cooldown) en aval, fail-soft.
    null,
  );
  if (issue.kind === "NEEDS_REPAIR") {
    // Re-sync reparti en OTP : on n'ingère pas, on signale qu'une réparation reste due
    // (avec le NOUVEAU jobId, pour ré-armer le bouton « Reconnecter »).
    return { comptesRattaches, transactionsImportees: 0, reparationJobId: issue.jobId };
  }
  if (issue.kind === "SKIP_FAILED") {
    // FAILED / timeout : fail-soft, on remonte ce qui a été persisté (comptes), 0 tx.
    return { comptesRattaches, transactionsImportees: 0 };
  }
  // DECLENCHE (COMPLETED) ou RATE_LIMITED (lecture du cache) : on lit les transactions.

  // 2. (c) Ingestion des transactions des comptes sélectionnés de cette connexion.
  const omnifiIds = comptes
    .filter((c) => c.Status == null || c.Status === "Enabled")
    .map((c) => c.AccountId);
  if (omnifiIds.length === 0) {
    return { comptesRattaches, transactionsImportees: 0 };
  }

  const comptesAIngerer = await executer(async (tx) =>
    tx
      .select({
        bankAccountId: bankAccounts.id,
        omnifiAccountId: bankAccounts.omnifiAccountId,
      })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.isSelected, true),
          inArray(bankAccounts.omnifiAccountId, omnifiIds),
        ),
      ),
  );

  let transactionsImportees = 0;
  for (const cpt of comptesAIngerer) {
    const r = await synchroniserCompte(client, executer, {
      omnifiAccountId: cpt.omnifiAccountId,
      bankAccountId: cpt.bankAccountId,
      clientUserId,
    });
    transactionsImportees += r.transactionsTraitees;
  }

  return { comptesRattaches, transactionsImportees };
}
