/**
 * Pont Auth.js → withWorkspace — l'UNIQUE chemin d'obtention d'une
 * WorkspaceSession côté serveur (Server Components, Server Actions, routes).
 *
 * Re-validation E6 à CHAQUE requête : users.is_active est relu en base — un
 * compte désactivé perd l'accès immédiatement, même avec un JWT encore valide.
 * (La membership, elle, est re-validée par withWorkspace — E14.)
 *
 * Mapping erreurs (règle 3, registre S2) :
 * - NonAuthentifieError  → redirection /login (jamais de détail : un compte
 *   désactivé est indistinguable d'un non-connecté).
 * - AucunWorkspaceActifError → écran « aucun workspace » (PR 2 : sélecteur).
 */
import { auth } from "@/server/auth/config";
import { identite } from "@/server/db";
import { workspaceSessionSchema, type WorkspaceSession } from "@/server/db/tenancy";

export class NonAuthentifieError extends Error {
  readonly code = "NOT_AUTHENTICATED";
  constructor() {
    super("Authentification requise");
    this.name = "NonAuthentifieError";
  }
}

export class AucunWorkspaceActifError extends Error {
  readonly code = "NO_ACTIVE_WORKSPACE";
  constructor() {
    super("Aucun workspace actif");
    this.name = "AucunWorkspaceActifError";
  }
}

/**
 * Erreur d'INFRASTRUCTURE pendant le chemin d'auth (base injoignable, timeout
 * Neon/wsproxy). Distincte des erreurs métier ci-dessus : elle signale un
 * incident temporaire, pas un défaut d'autorisation.
 *
 * Deux raisons d'être :
 * 1. SÉRIALISATION (le bug observé) : l'erreur brute du driver Neon porte une
 *    `cause: ErrorEvent` (classe DOM NON sérialisable). Passée telle quelle à un
 *    error boundary (Client Component), elle casse la sérialisation RSC→Client
 *    (« Only plain objects… ») et AUCUN boundary ne monte → 500 brut. On relance
 *    donc une Error PROPRE, SANS `cause` non-plain : le boundary peut la rendre.
 * 2. FAIL-CLOSED : on ne l'émet QUE sur le chemin d'échec, jamais en
 *    transformant un échec en succès. Si on ne peut pas PROUVER que le compte est
 *    actif (E6), on REFUSE — on ne suppose rien (cf. exigerSessionWorkspace).
 *
 * On ne recopie PAS le message du driver (peut contenir un détail technique) :
 * message générique stable + code machine. Le digest Next corrèle aux logs.
 */
export class ServiceIndisponibleError extends Error {
  readonly code = "SERVICE_UNAVAILABLE";
  constructor() {
    super("Service momentanément indisponible");
    this.name = "ServiceIndisponibleError";
  }
}

export async function exigerSessionWorkspace(): Promise<WorkspaceSession> {
  const session = await auth();
  if (!session?.userId) {
    throw new NonAuthentifieError();
  }

  // E6 — re-validation is_active à chaque requête. FAIL-CLOSED : si la base est
  // injoignable, on ne peut PAS prouver que le compte est actif → on REFUSE en
  // signalant un incident d'infra (jamais « on suppose actif »). On convertit
  // l'erreur brute du driver (cause ErrorEvent non sérialisable) en une erreur
  // PROPRE rendable par un error boundary.
  let actif: boolean;
  try {
    actif = await identite.estActif(session.userId);
  } catch {
    // On n'inspecte pas l'erreur driver (et on ne la chaîne pas en `cause` :
    // c'est précisément ce qui cassait la sérialisation RSC→Client).
    throw new ServiceIndisponibleError();
  }
  if (!actif) {
    throw new NonAuthentifieError();
  }

  if (!session.activeWorkspaceId) {
    throw new AucunWorkspaceActifError();
  }

  const parsed = workspaceSessionSchema.safeParse({
    userId: session.userId,
    activeWorkspaceId: session.activeWorkspaceId,
    // viewFilter (L8b-1) : INTENTION d'affichage du sélecteur de périmètre, portée
    // par le token. `?? undefined` car le schéma attend `optional()` (pas `null`) ;
    // absent/[] ⇒ « Groupe » (withWorkspace ne pose alors PAS le GUC, tenancy.ts:419).
    // NON FIABLE : le serveur l'intersecte avec le DROIT — ne confère aucun accès.
    viewFilter: session.viewFilter ?? undefined,
  });
  if (!parsed.success) {
    // JWT au contenu inattendu : on le traite comme une absence de session.
    throw new NonAuthentifieError();
  }
  return parsed.data;
}
