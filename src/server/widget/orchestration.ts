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
  OmniFiSyncStatusConnu,
} from "@/server/omnifi";
import { OmniFiApiError } from "@/server/omnifi";
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { masquerCompte } from "@/lib/masquage";
import { peutModifier } from "@/lib/permissions";
import type {
  ExecuterWorkspace,
  WorkspaceContext,
  WorkspaceTx,
} from "@/server/db/tenancy";
// Prédicat PARTAGÉ « le périmètre du membre est-il borné ? » — importé, JAMAIS recopié
// (sa docstring l'exige : une copie ici et une autre dans le test rendrait le test
// tautologique). Même prédicat pour la lecture et pour cette écriture : les deux axes
// qu'il couvre refusent l'INSERT d'un compte neuf (cf. ConnexionHorsPerimetreError).
import { estLecteurBorne } from "@/server/db/tenancy";
import { codePg, PG_PRIVILEGE_INSUFFISANT } from "@/server/db/erreurs-pg";
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
import { enregistrerConsentement } from "@/server/repositories/audit";
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
 * L'acteur porte un PÉRIMÈTRE en base (Vision Entité via `member_entity_scopes`, et/ou
 * maille compte via `user_scopes`) — il ne peut donc PAS rattacher de banque au workspace.
 *
 * POURQUOI c'est un refus et non une panne. Connecter une banque CRÉE des comptes neufs,
 * et un compte neuf naît `entity_id = NULL` (l'ingestion n'assigne jamais d'entité —
 * CLAUDE.md « Entités multi-tenant »). Les deux policies RESTRICTIVE de `bank_accounts`
 * refusent cet INSERT dès qu'un périmètre est posé, chacune par sa propre clause :
 *   • `entity_scope` (0014, WITH CHECK) exige `entity_id IS NOT NULL AND entity_id = ANY(scope)`
 *     → un INSERT `entity_id = NULL` la viole frontalement ;
 *   • `account_scope` (0016, WITH CHECK) exige `id = ANY(scope)` → l'id d'un compte NEUF
 *     (gen_random_uuid()) n'est jamais dans le droit, résolu AVANT l'insert.
 * Le fail-closed est VOULU : « un membre borné ne crée pas de comptes non-assignés ».
 *
 * Ce que cette erreur ajoute : un NOM. Sans elle, le refus remontait en erreur de base
 * brute (SQLSTATE 42501) noyée dans le message générique « La connexion bancaire a
 * échoué. Réessayez. » — un membre borné réessayait indéfiniment un geste qui ne lui
 * appartient pas, sans jamais être orienté vers un administrateur (exit-criterion
 * règle 3 : « chaque erreur a un nom » ; ENTITY-CONNEXION-REFUS-NOMME1).
 *
 * ⚠️ La sécurité NE REPOSE PAS sur cette garde : l'autorité reste la RLS (fail-closed,
 * indépendante du chemin d'appel). La garde applicative ne fait qu'échouer PLUS TÔT —
 * avant de solliciter Omni-FI pour un LinkToken qui ne servira jamais — et NOMMER le
 * refus. La supprimer dégraderait le message, jamais l'isolation.
 *
 * Message UI non-énumérant (registre S2) : il ne nomme aucune entité, aucun compte,
 * aucune banque — il n'est donc pas un oracle d'existence.
 */
export class ConnexionHorsPerimetreError extends Error {
  readonly code = "ENTITY_CONNECTION_OUT_OF_SCOPE";
  /**
   * `options.cause` PORTE l'erreur Postgres d'origine quand le refus vient de la ceinture
   * 42501 (jamais quand il vient de la garde applicative, qui n'a rien à emballer). Elle
   * n'est JAMAIS exposée à l'UI — `messageDepuis` ne rend que `MESSAGE_PERIMETRE` — mais
   * sans elle un 42501 mal classé serait indiagnosticable depuis les logs.
   */
  constructor(options?: { cause?: unknown }) {
    super("Périmètre insuffisant pour rattacher une banque", options);
    this.name = "ConnexionHorsPerimetreError";
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
export async function clientUserIdDuWorkspace(
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
 *
 * DEUX gardes distinctes, à ne pas confondre (elles répondent à des questions
 * différentes et aucune ne subsume l'autre) :
 *  - `peutModifier(ctx.role)` — le RÔLE autorise-t-il le geste ? (VIEWER = non)
 *  - `estLecteurBorne(ctx)` — le PÉRIMÈTRE le permet-il ? (membre borné = non)
 * Un MANAGER borné passe la première et échoue la seconde ; un ADMIN non borné passe
 * les deux. La RLS ne connaît pas le rôle, et le rôle ne connaît pas le périmètre.
 */
export async function demarrerConnexion(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: DemarrerConnexionParams,
): Promise<ResultatDemarrage> {
  const clientUserId = await executer(async (tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();
    // Refus de périmètre AVANT tout appel amont : la RLS refuserait de toute façon
    // l'INSERT des comptes en fin de parcours (cf. ConnexionHorsPerimetreError), mais
    // l'utilisateur aurait alors traversé tout le widget — saisi ses identifiants
    // bancaires et son OTP — pour échouer à la dernière étape. On échoue au premier
    // geste, sans fabriquer de LinkToken ni solliciter Omni-FI.
    if (estLecteurBorne(ctx)) throw new ConnexionHorsPerimetreError();
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
 * Options de persistance. `consentement` n'est fourni QUE par les chemins issus d'un
 * `link-exchange` (octroi explicite de l'utilisateur dans le widget) — voir la garde
 * dans `persisterConnexionEtComptes`. Absent ⇒ aucun consentement n'est écrit.
 */
/**
 * CEINTURE du refus de périmètre : traduit le SQLSTATE 42501 (WITH CHECK d'une policy
 * RESTRICTIVE violé) en `ConnexionHorsPerimetreError`, sur le chemin d'ÉCRITURE réel.
 *
 * Pourquoi elle existe EN PLUS de la garde de `demarrerConnexion` : les Server Actions
 * de finalisation sont atteignables SANS être passé par le démarrage (une action est un
 * POST — rien n'oblige à enchaîner les étapes dans l'ordre). Sans cette ceinture, ces
 * chemins-là conserveraient le catch-all générique que ce lot existe pour supprimer.
 *
 * ⚠️ DEUX conditions, et la seconde n'est PAS redondante. Postgres rend `42501` aussi
 * bien pour « new row violates row-level security policy » que pour « permission denied
 * for table X » : les deux sont INDISCERNABLES au seul SQLSTATE. Or le drift de
 * provisioning est un aléa documenté de ce pipeline (CLAUDE.md : les GRANT ne mordent
 * qu'au re-provision POST-migrate) — une table ajoutée par migration sans re-provision
 * rendrait un 42501 de PRIVILÈGE. Sans le test `estLecteurBorne(ctx)`, un ADMIN en
 * Vision Globale lirait alors « Votre périmètre ne permet pas… Contactez un
 * administrateur » : il EST l'administrateur, et un incident P0 d'infrastructure se
 * déguiserait en refus utilisateur routinier — UI et télémétrie pointant toutes deux à
 * côté (constat de cross-review 2026-07-22, reproduit par `revoke insert`).
 * Un acteur SANS périmètre ne peut pas, par construction, violer un WITH CHECK de
 * périmètre : son 42501 est forcément autre chose, et doit remonter tel quel.
 *
 * La `cause` est PRÉSERVÉE : sans elle, le SQLSTATE et le message Postgres étaient
 * détruits et le diagnostic d'un défaut de privilège devenait impossible depuis les logs.
 *
 * Tout le reste est RE-LEVÉ à l'identique : une panne réseau, une violation d'unicité ou
 * un garde-fou tenant ne doivent JAMAIS être maquillés en refus de périmètre — ce serait
 * exactement le catch-all silencieux qu'interdit la règle 3.
 */
function nommerRefusDePerimetre(e: unknown, ctx: WorkspaceContext): unknown {
  if (codePg(e) === PG_PRIVILEGE_INSUFFISANT && estLecteurBorne(ctx)) {
    return new ConnexionHorsPerimetreError({ cause: e });
  }
  return e;
}

export interface PersistanceOptions {
  consentement?: {
    /** Scopes demandés au widget, si connus. Libellés d'API, jamais de la donnée. */
    requestedScopes?: string[];
  };
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
  options: PersistanceOptions = {},
): Promise<number> {
  // 1. Connexion + comptes dans UNE transaction. On collecte les paires
  //    (compte Omni-FI, bankAccountId local) des comptes RÉELLEMENT rattachés
  //    pour pouvoir lier leurs parties juste après (sans relecture).
  // La ceinture 42501 vit DANS le callback : elle a besoin de `ctx` pour distinguer un
  // refus de périmètre d'un défaut de privilège (cf. nommerRefusDePerimetre). Le `throw`
  // reste dans la transaction, donc le ROLLBACK est inchangé.
  const rattaches = await executer(async (tx, ctx) => {
    try {
    const { connectionId } = await upsertConnexion(tx, ctx, {
      omnifiConnectionId: echange.ConnectionId,
      institutionId: echange.InstitutionId,
      institutionName: normaliserNomInstitution(echange.InstitutionName),
      status: "active",
      nextSyncAvailableAt: null,
    });

    // ── Consentement GRANTED (Epic 1 / L3.2) — DANS cette transaction.
    // Atomicité exigée (plan §5.2) : le consentement et la connexion vivent ou
    // meurent ensemble. Si l'insertion des comptes échoue plus bas, le ROLLBACK
    // emporte le consentement — jamais de consentement fantôme sans connexion.
    //
    // ⚠️ Émis UNIQUEMENT quand l'appelant le demande (`options.consentement`),
    // c'est-à-dire sur les DEUX chemins issus d'un `link-exchange` (l'utilisateur
    // vient d'accorder son accord dans le widget). Les autres appelants de cette
    // fonction — re-synchronisation périodique, synchro idempotente depuis
    // `GET /connections`, réparation — ne passent RIEN : sans cette garde, chaque
    // re-sync écrirait un faux `GRANTED` et le journal réglementaire ne prouverait
    // plus rien (les tables sont append-only : on ne pourrait pas le rattraper).
    //
    // Un re-link explicite de la même banque réémet légitimement un GRANTED : c'est
    // un NOUVEL acte de consentement de l'utilisateur, même si `upsertConnexion` est
    // idempotent et rend le même `connectionId`. Deux lignes = deux consentements
    // horodatés, c'est le comportement voulu (append-only, on n'écrase pas l'histoire).
    if (options.consentement) {
      await enregistrerConsentement(tx, ctx, {
        connectionId,
        action: "GRANTED",
        scope: {
          institutionId: echange.InstitutionId,
          ...(options.consentement.requestedScopes
            ? { requestedScopes: options.consentement.requestedScopes }
            : {}),
        },
      });
    }

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
    } catch (e) {
      throw nommerRefusDePerimetre(e, ctx);
    }
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
  //   `consentement` : ce chemin sort d'un link-exchange → l'utilisateur vient
  //   d'accorder son accord. GRANTED est écrit dans la MÊME transaction (L3.2).
  verifierAlignement(comptes, echange.InstitutionId);
  const rattaches = await persisterConnexionEtComptes(executer, echange, comptes, {
    consentement: {},
  });

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
  //   `consentement` : chemin drop-in, également issu d'un link-exchange (L3.2).
  verifierAlignement(comptes, echange.InstitutionId);
  const rattaches = await persisterConnexionEtComptes(executer, echange, comptes, {
    consentement: {},
  });

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

/**
 * États terminaux d'un SyncJob. Typés `ReadonlySet<string>` en SORTIE (le statut du fil
 * est une union OUVERTE — l'amont dérive, cf. `OmniFiSyncStatus`) mais construits sur
 * `OmniFiSyncStatusConnu` : la LISTE reste vérifiée au typecheck (une coquille échoue),
 * tandis qu'un statut INCONNU peut être interrogé sans cast. Un inconnu n'est donc ni
 * terminal ni MFA → il est poll jusqu'au plafond, puis rendu INCOMPLET (jamais assimilé
 * à un succès, jamais à un échec dur).
 */
export const SYNC_STATUTS_TERMINAUX: ReadonlySet<string> = new Set<OmniFiSyncStatusConnu>([
  "COMPLETED",
  "FAILED",
]);
/** États MFA : le re-sync attend un OTP — non fournissable côté serveur (widget natif). */
export const SYNC_STATUTS_MFA: ReadonlySet<string> = new Set<OmniFiSyncStatusConnu>([
  "OTP_REQUESTED",
  "OTP_WAITING",
]);

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
  /**
   * Dernier statut AMONT observé, posé au TIMEOUT. C'est une valeur d'ÉNUMÉRATION
   * (jamais de PII) : elle explique pourquoi on n'a pas attendu la fin (« RETRIEVING » =
   * le scrape tourne encore) et rend VISIBLE un statut inconnu de nos types — le seul
   * signal qui nous préviendra d'une dérive de l'amont.
   */
  dernierStatut?: string;
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
      // INCOMPLET — PAS un échec. Le job tourne TOUJOURS côté banque : constat prod
      // 2026-07-13, un scrape est resté en `RETRIEVING` plus de 6 min, soit 3× ce
      // plafond. Or les transactions DÉJÀ scrapées sont lisibles IMMÉDIATEMENT (67
      // disponibles pendant que le job courait encore) : l'appelant doit donc ingérer ce
      // qui existe (lecture idempotente / upsert append-only), au lieu de tout jeter.
      //
      // On NE logue PAS `omnifi_sync_completed` : ce n'est pas une complétion, et le
      // confondre fausserait la preuve d'observabilité. Événement DISTINCT, sans PII —
      // `dernierStatut` est une valeur d'énumération amont, `connectionId`/`jobId` des
      // UUID opaques.
      console.warn(
        JSON.stringify({
          evt: "omnifi_sync_incomplet",
          // `cause` discrimine les DEUX situations qui portent cet événement (l'autre étant
          // le job constaté en cours sous cooldown, sans attente) : sans elle, les deux
          // payloads sont indistinguables en requête de log.
          cause: "PLAFOND_POLLING",
          connectionId,
          jobId,
          dernierStatut: status,
          attenteMs: POLL_SYNC_PLAFOND_MS,
        }),
      );
      return { status: "TIMEOUT", jobId, dernierStatut: status };
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
 *  - INCOMPLET : le job tournait ENCORE au plafond de polling (scrape long, ou statut
 *    amont inconnu) → on lit quand même les transactions déjà disponibles, et on remonte
 *    la nature PARTIELLE (l'UI invite à relancer) ;
 *  - SKIP_FAILED : job FAILED → compté en échec (fail-soft).
 */
type IssueTrigger =
  | { kind: "DECLENCHE" }
  | { kind: "RATE_LIMITED"; nextSyncAt: string | null }
  | { kind: "NEEDS_REPAIR"; jobId: string }
  | { kind: "INCOMPLET"; jobId: string; dernierStatut: string }
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
 * Cette erreur est-elle un THROTTLE amont (« 1 sync / 15 min ») ? On la reconnaît par
 * DEUX voies, car Omni-FI ne renvoie pas toujours un 429 propre :
 *   - `estRateLimit` (HTTP 429) — cas nominal documenté ;
 *   - `details[].errorCode === "RATE_LIMIT_EXCEEDED"` — cas OBSERVÉ en prod (2026-07-02) :
 *     l'amont renvoie un **400 générique** (`obieCode` = « 400 BadRequest », donc inutile),
 *     mais l'enveloppe OBIE porte bien le code machine `RATE_LIMIT_EXCEEDED` dans `Errors[]`.
 * Sans cette 2e voie, ce 400 tombait sur le `throw` final → échec DUR → connexion
 * abandonnée, `marquerSynchronise` jamais atteint (bug de remédiation, pas de la cause).
 * `obieCode` n'est PAS utilisé ici : il est générique/non fiable (constat de revue).
 */
export function estThrottleAmont(erreur: unknown): erreur is OmniFiApiError {
  return (
    erreur instanceof OmniFiApiError &&
    (erreur.estRateLimit ||
      erreur.details.some((d) => d.errorCode === "RATE_LIMIT_EXCEEDED"))
  );
}

/**
 * `nextSyncAt` (ISO 8601) déduit du `retryAfterSeconds` d'un throttle, quand l'amont le
 * fournit (uniquement sur 429, cf. erreurs.ts). Null si absent/non positif — l'appelant
 * retombe alors sur `nextSyncDepuisLatest`.
 */
function nextSyncApresRetryAfter(retryAfterSeconds: number | null): string | null {
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return null;
  }
  return new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
}

/**
 * Déclenche (ou non) un sync pour une connexion, gardé EN AMONT par le cooldown,
 * puis attend le job. Ne LIT PAS les transactions (la lecture existante suit selon
 * l'issue). Centralise toute la gestion 429/400-concurrent/OTP/FAILED.
 */
export async function declencherEtAttendre(
  client: OmniFiClient,
  connectionId: string,
  clientUserId: string,
  nextSyncAvailableAt: string | null,
): Promise<IssueTrigger> {
  // (a) GARDE rate-limit AMONT : un NextSyncAvailableAt futur (vu dans GET /connections)
  // signifie qu'un sync a tourné récemment → NE PAS déclencher (évite un 429 inutile
  // à chaque clic). On relira quand même l'état courant en aval.
  if (cooldownActif(nextSyncAvailableAt)) {
    // Mais un cooldown ne dit PAS que les données sont à jour — seulement qu'un sync est
    // parti récemment. S'il TOURNE ENCORE, ce qu'on va lire est PARTIEL.
    //
    // C'est le 2ᵉ clic, et il est provoqué par NOTRE PROPRE message (« relancez dans
    // quelques minutes ») — or « quelques minutes » tombe SOUS le cooldown de 15 min. Sans
    // cette vérification, ce clic ressortait en RATE_LIMITED, donc sans le drapeau
    // `incomplet`, donc en « Comptes à jour » : le faux message de victoire renaissait
    // exactement sur le geste qu'on venait de prescrire (revue PR #202, constat 1).
    //
    // Couvre les DEUX comportements amont, qu'il pose `NextSyncAvailableAt` dès le
    // déclenchement ou non : ici on ne déduit rien du cooldown, on VÉRIFIE l'état du job.
    const enCours = await jobEnCoursNonTerminal(client, connectionId, clientUserId);
    if (enCours) {
      // Sans PII : identifiants opaques Omni-FI + valeur d'énumération amont. Pas d'`attenteMs`
      // — contrairement au TIMEOUT de polling, on n'a rien attendu : on a CONSTATÉ.
      console.warn(
        JSON.stringify({
          evt: "omnifi_sync_incomplet",
          connectionId,
          jobId: enCours.jobId,
          dernierStatut: enCours.dernierStatut,
          cause: "JOB_EN_COURS_SOUS_COOLDOWN",
        }),
      );
      return {
        kind: "INCOMPLET",
        jobId: enCours.jobId,
        dernierStatut: enCours.dernierStatut,
      };
    }
    return { kind: "RATE_LIMITED", nextSyncAt: nextSyncAvailableAt };
  }

  // (b) Déclenchement. On distingue 429 (course avec la garde) et 400 (job déjà en cours).
  let job: OmniFiSyncJob;
  try {
    job = await client.declencherSync(connectionId, clientUserId);
  } catch (erreur) {
    if (estThrottleAmont(erreur)) {
      // Throttle amont malgré la garde (course / cooldown non remonté par GET /connections,
      // OU 400 générique portant RATE_LIMIT_EXCEEDED — cas prod 2026-07-02) : on NE re-déclenche
      // PAS. On expose le délai — de préférence via `retryAfterSeconds` (429), sinon en relisant
      // `latest-job`. Traité en RATE_LIMITED (soft, lecture du cache), jamais en échec dur.
      const next =
        nextSyncApresRetryAfter(erreur.retryAfterSeconds) ??
        (await nextSyncDepuisLatest(client, connectionId, clientUserId));
      return { kind: "RATE_LIMITED", nextSyncAt: next };
    }
    // 400 « sync already running » UNIQUEMENT : un job tourne déjà → on récupère SON
    // JobId et on poll dessus (idempotence côté user). Le signal est le booléen
    // `conflitSyncEnCours`, classé au bord CLIENT à partir du MESSAGE OBIE (« Sync
    // already running: <jobId> ») — l'obieCode/ErrorCode sont des « 400 BadRequest »/
    // « BAD_REQUEST » génériques, inexploitables (constat prod 2026-07-03 : c'est ce
    // qui faisait tomber ce 400 en échec dur → connexion abandonnée). On RESTREINT à
    // ce motif : sans lui, un 400 d'une AUTRE cause (param rejeté, connexion en mauvais
    // état) partirait poller le dernier job — souvent un vieux COMPLETED — et conclurait
    // à tort « sync effectué » (faux positif silencieux). Tout autre 400 remonte comme
    // une erreur dure (cf. throw final).
    if (
      erreur instanceof OmniFiApiError &&
      erreur.status === 400 &&
      erreur.conflitSyncEnCours
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
      // Le job n'a PAS fini dans le plafond — mais il n'a pas échoué pour autant. L'ancien
      // `SKIP_FAILED (POLL_TIMEOUT)` faisait sauter la connexion : 0 transaction importée
      // alors que 67 étaient lisibles (bug prod 2026-07-13). On rend INCOMPLET : la lecture
      // suit, et la nature partielle remonte jusqu'à l'UI.
      return {
        kind: "INCOMPLET",
        jobId: r.jobId,
        dernierStatut: r.dernierStatut ?? "INCONNU",
      };
  }
}

/**
 * Un job de scraping tourne-t-il ENCORE sur cette connexion ? (best-effort)
 *
 * On le lit sur le DERNIER job : ni terminal (COMPLETED/FAILED), ni MFA ⇒ il court toujours,
 * donc tout ce qu'on lira côté transactions est PARTIEL.
 *
 * Les statuts MFA sont EXCLUS à dessein : un job en `OTP_REQUESTED` n'est pas « en cours de
 * scraping », il ATTEND l'utilisateur. Le classer INCOMPLET masquerait une RÉPARATION requise
 * derrière un rassurant « c'est en cours » — la MFA reste le chemin d'`attendreFinSync`
 * (→ NEEDS_REPAIR), et sous cooldown on retombe sur RATE_LIMITED, comme avant.
 *
 * BEST-EFFORT : toute erreur de lecture rend `null` ⇒ on garde le comportement RATE_LIMITED
 * existant. Ce diagnostic ne doit JAMAIS faire échouer une synchro qui, sinon, aboutirait.
 */
async function jobEnCoursNonTerminal(
  client: OmniFiClient,
  connectionId: string,
  clientUserId: string,
): Promise<{ jobId: string; dernierStatut: string } | null> {
  try {
    const latest = await client.getLatestSyncJob(connectionId, clientUserId);
    if (!latest.JobId) return null;
    const status = latest.Status;
    if (SYNC_STATUTS_TERMINAUX.has(status) || SYNC_STATUTS_MFA.has(status)) return null;
    return { jobId: latest.JobId, dernierStatut: status };
  } catch {
    return null;
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
  /**
   * DÉSYNCHRONISATION (a) — connexions ACTIVES chez Omni-FI mais ABSENTES de
   * `bank_connections` : le sync ne les traite pas (décision produit — ajouter une banque
   * passe par le widget). Elles étaient ignorées EN SILENCE, ce qui rendait le résultat
   * « 0 connexion » inexplicable pour l'utilisateur. L'action à mener est de FINALISER la
   * connexion via le widget.
   */
  nonRattachees: number;
  /**
   * DÉSYNCHRONISATION (b) — connexions de CETTE base qui ne sont plus utilisables côté
   * Omni-FI : soit l'amont ne les renvoie PLUS DU TOUT (accès révoqué, EndUser recréé), soit
   * il les renvoie avec un statut NON ACTIF (expirée, en erreur). Les deux appellent la même
   * action — reconnecter — donc un seul compteur (le log garde la distinction).
   *
   * Leurs comptes restent affichés avec un `last_synced_at` ancien : sans ce signal,
   * l'utilisateur les croit à jour. Fail-safe : si le listing amont a pu être tronqué, les
   * « disparues » ne sont PAS comptées (accuser à tort une banque saine est pire que taire
   * un signal).
   */
  inutilisables: number;
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
   * SYNCHRONISATION INCOMPLÈTE — le job de scraping tournait ENCORE quand le plafond de
   * polling (120 s) a été atteint : un scrape bancaire peut durer plusieurs minutes
   * (observé en prod le 2026-07-13 : 6 min+ en `RETRIEVING`, soit 3× le plafond).
   *
   * Ce n'est NI un échec (rien n'a planté, et les transactions déjà scrapées ONT été
   * importées — la lecture ne dépend pas de la complétion du job), NI un succès plein
   * (il en manque probablement). Sans ce signal, l'UI annonçait « Comptes à jour » avec
   * 0 transaction importée : un faux message de victoire. `dernierStatut` = valeur
   * d'énumération amont (jamais de PII) ; il vaut « INCONNU » si l'amont a émis un
   * statut hors de nos types. Vide = aucun cas.
   */
  incompletes: Array<{ connectionId: string; jobId: string; dernierStatut: string }>;
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
    /** Codes machine OBIE (`Errors[].ErrorCode`, non-PII) si présents — ex. RATE_LIMIT_EXCEEDED. */
    errorCodes?: string[];
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
  // 1. Garde de rôle + ClientUserId (scopé, frontière tenant). On capture AUSSI la
  //    PORTÉE effective de la transaction (diagnostic ci-dessous) : le sync DOIT tourner
  //    en Vision Globale (CLAUDE.md, ENTITY-WRITE-SCOPE1). Si un scope entité/compte fuite
  //    ici, `upsertCompte` écrit sous une policy RESTRICTIVE (USING **et** WITH CHECK) et
  //    ne rattache plus rien — sans lever d'erreur visible.
  const { clientUserId, workspaceId, entityScopeMode, accountScopeMode, droitComptes } =
    await executer(async (tx, ctx) => {
      if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();
      return {
        clientUserId: await clientUserIdDuWorkspace(tx, ctx.workspaceId),
        workspaceId: ctx.workspaceId,
        entityScopeMode: ctx.entityScope.mode,
        accountScopeMode: ctx.accountScope.mode,
        droitComptes:
          ctx.accountScope.mode === "COMPTES" ? ctx.accountScope.accountIds.length : null,
      };
    });

  // 2. Lister les connexions actives de cet EndUser (ApiKey), pagination suivie.
  const connexions: Array<{
    ConnectionId: string;
    InstitutionId: string;
    InstitutionName: string | null;
    /** Cooldown amont (« 1 sync / 15 min ») : garde anti-429 du déclenchement (étape 3). */
    NextSyncAvailableAt: string | null;
  }> = [];
  // DIAGNOSTIC : on compte ce que l'amont renvoie AVANT notre filtre de statut, et on
  // collecte les statuts DISTINCTS (valeurs d'énumération — aucune PII). Sans ça,
  // « 0 connexion » est ambigu : l'amont n'a rien renvoyé, OU notre filtre a tout écarté
  // (un statut inattendu — « ACTIVE », « Connected »… — suffirait à tout jeter).
  let connexionsApiBrutes = 0;
  const statutsVus = new Set<string>();
  // Tous les ConnectionId vus chez l'amont, QUEL QUE SOIT leur statut : sert à détecter
  // les connexions de notre base que l'amont ne connaît plus (désynchronisation (b)). Les
  // comparer aux seules connexions ACTIVES ferait passer une connexion amont simplement
  // inactive pour une connexion disparue.
  const idsAmont = new Set<string>();
  // Total de connexions ANNONCÉ par l'amont (`Meta.TotalRecords`). C'est lui qui PROUVERA que
  // le listing a été vu en entier — cf. `listingAmontComplet` après la boucle.
  let totalRecordsAnnonce: number | undefined;
  let pageC = 1;
  for (;;) {
    const env = await client.listerConnexions(clientUserId, { page: pageC });
    for (const c of env.Data.Connections ?? []) {
      connexionsApiBrutes += 1;
      statutsVus.add(String(c.Status ?? "∅"));
      idsAmont.add(c.ConnectionId);
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
    totalRecordsAnnonce = env.Meta?.TotalRecords ?? totalRecordsAnnonce;
    // Pagination pilotée par `Meta.TotalPages`, PAS par `Links.Next`.
    // Contrat RUNTIME vérifié le 2026-07-13 (la doc ne mentionne ni `Meta` ni `Links`, elle a
    // tort) : l'amont renvoie `Meta: {TotalPages, TotalRecords}` et `Links: {Self}` — **sans
    // `Next`** en page unique. S'arrêter sur `!Links.Next` faisait donc rater TOUTES les
    // pages 2+ : au-delà d'une page, le sync ignorait des connexions en silence.
    const totalPages = env.Meta?.TotalPages;
    if (totalPages === undefined || pageC >= totalPages) break;
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
  const lignesBase = await executer(async (tx) =>
    tx
      .select({
        omnifiConnectionId: bankConnections.omnifiConnectionId,
        status: bankConnections.status,
      })
      .from(bankConnections),
  );
  const connexionsConnues = new Set(lignesBase.map((l) => l.omnifiConnectionId));
  // Base des COMPTEURS de désynchronisation (≠ du filtre de traitement ci-dessus, qui reste
  // inchangé) : on n'invite à « reconnecter » que des connexions que NOUS tenons encore pour
  // actives. Une connexion révoquée délibérément par l'utilisateur disparaîtra légitimement
  // de l'amont — la compter reviendrait à lui réclamer de reconnecter ce qu'il vient de
  // couper. (Aujourd'hui le statut local est toujours "active" : la garde est posée pour le
  // jour où la révocation `DELETE /connections/{id}` arrivera.)
  const connuesActives = lignesBase
    .filter((l) => l.status === "active")
    .map((l) => l.omnifiConnectionId);
  // On ne garde que les connexions présentes en base. Une connexion exclue ici ne génère
  // AUCUN appel Omni-FI en aval (ni listerComptesConnexion, ni declencherSync) et n'est PAS
  // comptée dans `connexions` (le compteur reflète les banques réellement traitées).
  const connexionsATraiter = connexions.filter((cx) =>
    connexionsConnues.has(cx.ConnectionId),
  );

  // ── PREUVE DE COMPLÉTUDE DU LISTING AMONT ──────────────────────────────────────────
  // On n'accuse une banque de « ne plus répondre » (→ « reconnectez-la ») que si on a vu TOUT
  // l'amont. La complétude se DÉMONTRE, elle ne se suppose pas : on compare ce qu'on a
  // réellement vu au total que l'amont ANNONCE (`Meta.TotalRecords`, présent en runtime).
  //
  // Un `?? 1` sur `TotalPages` serait un piège : `Meta` absent ⇒ « 1 page » ⇒ sortie par la
  // branche « fin normale » ⇒ listing déclaré COMPLET alors qu'on ne sait rien. On aurait
  // alors envoyé l'utilisateur ré-authentifier des banques parfaitement saines — sur-compter
  // accuse à tort, sous-compter ne fait que taire un signal. Aucune annonce = aucune preuve
  // = on se tait.
  //
  // Double garde : même si `TotalPages` mentait (fin annoncée trop tôt), `TotalRecords`
  // rattraperait — on aurait vu moins de connexions qu'annoncé ⇒ incomplet ⇒ pas d'accusation.
  const listingAmontComplet =
    totalRecordsAnnonce !== undefined && connexionsApiBrutes >= totalRecordsAnnonce;

  // ── DÉSYNCHRONISATIONS base ↔ amont ────────────────────────────────────────────────
  // Elles étaient ignorées EN SILENCE. C'est ce silence qui a produit le « spinner puis
  // rien » : les 2 connexions locales n'existaient plus chez Omni-FI, la seule connexion
  // amont n'était pas en base → intersection vide → 0 connexion traitée → aucun message.
  // On les COMPTE (jamais de nom de banque ni d'id : message non-énumérant, règle 3).
  const idsActifsAmont = new Set(connexions.map((c) => c.ConnectionId));

  // (a) Connectée chez Omni-FI, jamais rattachée ici → action : FINALISER via le widget.
  const nonRattachees = connexions.filter(
    (cx) => !connexionsConnues.has(cx.ConnectionId),
  ).length;

  // (b) De NOTRE base, mais plus utilisable côté Omni-FI. DEUX causes distinctes…
  //   • `disparues`      : l'amont ne la renvoie plus DU TOUT (accès révoqué, EndUser recréé) ;
  //   • `inexploitables` : l'amont la renvoie, mais avec un statut non actif (expirée, en erreur).
  // …et UNE SEULE action utilisateur : reconnecter. On les fusionne donc dans le message (un
  // signal = une action) tout en gardant la distinction au LOG, où elle sert au diagnostic.
  //
  // Sans le cas `inexploitables`, une banque connue des DEUX côtés mais inactive amont ne
  // tombait dans AUCUN compteur : le message devenait « Aucune banque connectée — connectez-en
  // une » alors que l'utilisateur en a une, affichée juste au-dessus. Faux, et mauvaise action.
  const disparues = connuesActives.filter((id) => !idsAmont.has(id)).length;
  const inexploitables = connuesActives.filter(
    (id) => idsAmont.has(id) && !idsActifsAmont.has(id),
  ).length;
  // FAIL-SAFE : « disparue » n'a de sens que si on a vu TOUT l'amont (cf. `listingAmontComplet`).
  // `inexploitables`, lui, se fonde sur ce qu'on a RÉELLEMENT vu → toujours fiable.
  const inutilisables = (listingAmontComplet ? disparues : 0) + inexploitables;

  // DIAGNOSTIC (« spinner puis rien ») — une seule ligne qui TRANCHE entre les causes,
  // parce que le compteur final `connexions: 0` les confond toutes. Aucune PII : on ne
  // logge que des COMPTES et des valeurs d'énumération, jamais un ConnectionId, un
  // libellé bancaire ou le ClientUserId (règle 8).
  //
  // Lecture du verdict :
  //   apiBrutes === 0                      → l'amont ne renvoie RIEN (EndUser/clés/env)
  //   apiBrutes > 0 && apiActives === 0    → notre filtre de STATUT écarte tout (cf. statutsVus)
  //   apiActives > 0 && enBase === 0       → `bank_connections` vide pour ce workspace
  //   apiActives > 0 && enBase > 0 && aTraiter === 0 → MISMATCH d'ids (EndUser recréé)
  //   aTraiter > 0 && comptesRattaches 0   → PORTÉE : l'écriture est bornée (cf. scopes)
  //
  // `entityScope`/`accountScope` DOIVENT valoir "GLOBALE" ici : l'ingestion tourne en
  // Vision Globale (CLAUDE.md ENTITY-WRITE-SCOPE1). Toute autre valeur = régression
  // d'isolation entité → dette INTERDITE, à corriger immédiatement.
  console.info(
    JSON.stringify({
      evt: "sync_diag",
      workspaceId,
      entityScope: entityScopeMode,
      accountScope: accountScopeMode,
      droitComptes,
      apiBrutes: connexionsApiBrutes,
      statutsVus: [...statutsVus],
      apiActives: connexions.length,
      enBase: connexionsConnues.size,
      aTraiter: connexionsATraiter.length,
      nonRattachees,
      disparues,
      inexploitables,
      inutilisables,
      listingAmontComplet,
    }),
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
  const incompletes: ResultatSynchronisation["incompletes"] = [];
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
        // FAILED « dur » du job : on n'ingère pas cette connexion (fail-soft) ; le code
        // machine est tracé par attendreFinSync, jamais de PII ici. ⚠️ Ce chemin ne
        // couvre PLUS le timeout de polling (désormais INCOMPLET, cf. ci-dessous) : un
        // job qui tourne encore n'est pas un job qui a échoué.
        continue;
      }
      if (issue.kind === "RATE_LIMITED") {
        // Cooldown actif : on N'a PAS déclenché, mais on relit quand même l'état COURANT
        // (le user voit au moins le dernier état connu) → on NE `continue` pas.
        rateLimited.push({ connectionId: cx.ConnectionId, nextSyncAt: issue.nextSyncAt });
      }
      if (issue.kind === "INCOMPLET") {
        // Le job de scraping tournait ENCORE au plafond de polling. On NE `continue` PAS —
        // même politique que RATE_LIMITED : les transactions DÉJÀ scrapées sont lisibles
        // tout de suite, et l'upsert est idempotent/append-only, donc les ingérer est sûr
        // ET utile. C'était le bug : le `continue` d'ici jetait 67 transactions
        // disponibles pour n'en importer aucune (prod 2026-07-13).
        //
        // La connexion est enregistrée comme PARTIELLE : elle ne sera PAS comptée « à
        // jour » côté action (sinon on afficherait un faux message de victoire), et l'UI
        // invitera à relancer.
        incompletes.push({
          connectionId: cx.ConnectionId,
          jobId: issue.jobId,
          dernierStatut: issue.dernierStatut,
        });
      }
      // issue.kind === "DECLENCHE" (sync COMPLETED), "RATE_LIMITED" (lecture du cache) OU
      // "INCOMPLET" (job encore en cours) : dans les TROIS cas on lit les transactions des
      // comptes de CETTE connexion — la lecture ne dépend pas de la complétion du job.

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
    nonRattachees,
    inutilisables,
    transactionsImportees,
    aReparer,
    rateLimited,
    incompletes,
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
  errorCodes?: string[];
} {
  const code =
    erreur instanceof Error && "code" in erreur && typeof erreur.code === "string"
      ? erreur.code
      : erreur instanceof Error
        ? erreur.name
        : "UNKNOWN";
  if (erreur instanceof OmniFiApiError) {
    // `obieCode` est souvent générique (« 400 BadRequest ») : on expose EN PLUS les codes
    // machine OBIE (`Errors[].ErrorCode`, non-PII) pour l'observabilité — c'est ce qui
    // aurait rendu le throttle-en-400 visible du premier coup (constat 2026-07-02).
    const errorCodes = erreur.details.map((d) => d.errorCode).filter(Boolean);
    return {
      code,
      status: erreur.status,
      obieCode: erreur.obieCode,
      ...(errorCodes.length > 0 ? { errorCodes } : {}),
    };
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
  /**
   * Le job de scraping tournait ENCORE au plafond de polling : les transactions déjà
   * disponibles ont été importées, mais il en manque probablement. Même sémantique que
   * `ResultatSynchronisation.incompletes` — remonté ici aussi, sinon le chemin RÉPARATION
   * afficherait un succès plein sur une ingestion partielle (le bug qu'on corrige, qui
   * vivrait alors encore sur cet écran).
   */
  incomplet?: boolean;
  /**
   * Le job de sync a ÉCHOUÉ « dur » (FAILED) après la réparation — fail-soft : les comptes
   * ont été persistés, mais aucune transaction n'a pu être lue.
   *
   * Sans ce signal, l'appelant ne pouvait pas distinguer ce cas d'une réparation réussie
   * (`comptesRattaches` est renseigné dans les DEUX cas — les comptes sont persistés AVANT
   * le job) et publiait « Connexion rétablie » en VERT sur un scrape qui venait de planter.
   * Absent quand le job n'a pas échoué.
   */
  echecSync?: boolean;
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
    // FAILED « dur » du job : fail-soft, on remonte ce qui a été persisté (comptes), 0 tx.
    // ⚠️ Ne couvre PLUS le timeout de polling : un job encore en cours devient INCOMPLET
    // (on lit quand même) — cf. `interpreterAttente`.
    //
    // `echecSync` est INDISPENSABLE : sans lui, l'appelant ne distinguait pas ce cas d'une
    // réparation réussie et publiait « Connexion rétablie » — un succès VERT sur un scrape
    // qui vient de planter (revue PR #202, C5). Le compteur de comptes ne dit rien de la
    // synchro : les comptes sont persistés AVANT le job.
    return { comptesRattaches, transactionsImportees: 0, echecSync: true };
  }
  // Le job tournait-il encore au plafond ? On lit quand même (les transactions déjà
  // scrapées sont disponibles, l'upsert est idempotent), mais on remonte le PARTIEL.
  const incomplet = issue.kind === "INCOMPLET";
  // DECLENCHE (COMPLETED), RATE_LIMITED (lecture du cache) ou INCOMPLET (job en cours) :
  // dans les trois cas on lit les transactions — la lecture ne dépend pas de la complétion.

  // 2. (c) Ingestion des transactions des comptes sélectionnés de cette connexion.
  const omnifiIds = comptes
    .filter((c) => c.Status == null || c.Status === "Enabled")
    .map((c) => c.AccountId);
  if (omnifiIds.length === 0) {
    return { comptesRattaches, transactionsImportees: 0, ...(incomplet ? { incomplet } : {}) };
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

  return { comptesRattaches, transactionsImportees, ...(incomplet ? { incomplet } : {}) };
}

/* ------------------------------------------------------------------ */
/* Account Selection — consentement ACCOUNTS_SELECTED (Epic 1 / L3.2)   */
/* ------------------------------------------------------------------ */

/**
 * Un identifiant de compte fourni par le client n'appartient pas à la connexion
 * ciblée (ou pas à ce tenant), OU Omni-FI l'a rejeté (409 `ACCOUNT_NOT_FOUND`).
 * Erreur nommée exigée par le plan §5.2. Message non-énumérant : il ne confirme
 * l'existence d'aucun compte.
 */
export class ConsentAccountUnknownError extends Error {
  readonly code = "CONSENT_ACCOUNT_UNKNOWN";
  constructor() {
    super("Sélection de comptes invalide");
    this.name = "ConsentAccountUnknownError";
  }
}

export interface ResultatSelectionComptes {
  connectionId: string;
  comptesAutorises: number;
}

/**
 * Enregistre la sélection de comptes de l'utilisateur (Account Selection).
 *
 * ORDRE NON NÉGOCIABLE (plan §2.3) : appel Omni-FI d'ABORD, écriture d'audit
 * ENSUITE. La DB et le réseau ne partagent pas de transaction ; si l'appel amont
 * échoue, RIEN n'est écrit — on ne consigne pas un consentement qui n'existe pas
 * chez le fournisseur. L'inverse (écrire puis appeler) laisserait un consentement
 * fantôme impossible à effacer (append-only strict).
 *
 * Anti-IDOR : `connectionId` et `bankAccountIds` sont des UUID LOCAUX fournis par le
 * client. On les relit sous RLS (`withWorkspace`) ; une connexion d'un autre tenant
 * est invisible → `ConnexionNonAutoriseeError` (mappée 404 par la Server Action,
 * jamais 403 : pas d'oracle d'existence). Un compte qui n'appartient pas à CETTE
 * connexion → `ConsentAccountUnknownError`, avant tout appel réseau.
 */
export async function selectionnerComptes(
  client: OmniFiClient,
  executer: ExecuterWorkspace,
  params: { connectionId: string; bankAccountIds: string[] },
): Promise<ResultatSelectionComptes> {
  // 1. Garde de rôle + résolution SOUS RLS de la connexion et des comptes visés.
  //    Tout se joue ici : ce que la RLS ne rend pas, le client ne peut pas cibler.
  const { omnifiConnectionId, comptes } = await executer(async (tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new ConnexionNonAutoriseeError();

    const connexions = await tx
      .select({ omnifiConnectionId: bankConnections.omnifiConnectionId })
      .from(bankConnections)
      .where(
        and(
          eq(bankConnections.id, params.connectionId),
          eq(bankConnections.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);
    // Invisible sous RLS (autre tenant) ou inexistante : même refus, non-énumérant.
    if (connexions.length === 0) throw new ConnexionNonAutoriseeError();

    // Les comptes DOIVENT appartenir à cette connexion. `inArray` paramétré.
    const lignes = await tx
      .select({
        id: bankAccounts.id,
        omnifiAccountId: bankAccounts.omnifiAccountId,
      })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.workspaceId, ctx.workspaceId),
          eq(bankAccounts.connectionId, params.connectionId),
          inArray(bankAccounts.id, params.bankAccountIds),
        ),
      );

    // Un seul identifiant non résolu (autre connexion, autre tenant, inexistant) et
    // on refuse TOUTE la sélection : une sélection partiellement honorée serait un
    // consentement que l'utilisateur n'a pas donné.
    if (lignes.length !== params.bankAccountIds.length) {
      throw new ConsentAccountUnknownError();
    }

    return {
      omnifiConnectionId: connexions[0].omnifiConnectionId,
      comptes: lignes,
    };
  });

  // 2. Omni-FI D'ABORD (§2.3). `PermittedAccountIds` = identifiants Omni-FI.
  //    Un 409 ACCOUNT_NOT_FOUND devient l'erreur nommée du plan.
  try {
    await client.definirComptesAutorises(
      omnifiConnectionId,
      comptes.map((c) => c.omnifiAccountId),
    );
  } catch (erreur) {
    if (erreur instanceof OmniFiApiError && erreur.obieCode === "ACCOUNT_NOT_FOUND") {
      throw new ConsentAccountUnknownError();
    }
    throw erreur;
  }

  // 3. Écriture d'audit ENSUITE, dans sa propre transaction scopée. Le scope ne
  //    porte que des identifiants opaques + des masques (`masquerCompte`) : jamais
  //    un `accountName` (libellé bancaire, PII), jamais un numéro de compte.
  await executer(async (tx, ctx) => {
    await enregistrerConsentement(tx, ctx, {
      connectionId: params.connectionId,
      action: "ACCOUNTS_SELECTED",
      scope: {
        accountIds: comptes.map((c) => c.omnifiAccountId),
        accountsLabels: comptes.map((c) => ({
          accountId: c.omnifiAccountId,
          masked: masquerCompte(c.omnifiAccountId),
        })),
      },
    });
  });

  return {
    connectionId: params.connectionId,
    comptesAutorises: comptes.length,
  };
}
