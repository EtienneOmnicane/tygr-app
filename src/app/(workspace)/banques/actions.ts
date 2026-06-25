"use server";

/**
 * Server Actions du flux Link Widget (PR-W2) — démarrer/finaliser une connexion
 * bancaire. Elles câblent session + withWorkspace + orchestration scopée
 * (`src/server/widget/orchestration.ts`) ; elles ne touchent jamais la DB ni le
 * client Omni-FI directement hors de l'orchestration.
 *
 * Exit-criteria (CLAUDE.md règle 3) :
 * - Authz : exigerSessionWorkspace + withWorkspace (membership re-validée) ;
 *   gating MANAGER/ADMIN porté par l'orchestration (ctx.role). VIEWER → refus.
 * - Validation zod stricte des entrées (RedirectOrigin https, tokens bornés).
 * - Erreurs nommées → messages non-énumérants (registre S2). Catch-all interdit.
 * - A1 (cross-review PR-W1) : on ne logge JAMAIS l'erreur avec ses arguments
 *   (publicToken/sessionToken sont sensibles). On mappe par type, sans payload.
 */
import { z } from "zod";

import { exigerSessionWorkspace } from "@/server/auth/session";
import { withWorkspace } from "@/server/db";
import { WorkspaceAccessDeniedError } from "@/server/db/tenancy";
import { creerClientOmniFi } from "@/server/omnifi";
import {
  ConnexionNonAutoriseeError,
  ReparationContexteInvalideError,
  WorkspaceSansClientUserIdError,
  demarrerConnexion,
  demarrerReparation,
  finaliserConnexionsDropin,
  resynchroniserConnexion,
  synchroniserConnexionsDepuisOmnifi,
} from "@/server/widget/orchestration";
import { autoriserRedirectOrigin } from "@/server/widget/redirect-origin";

export interface EtatDemarrage {
  erreur: string | null;
  linkToken: string | null;
}

export interface EtatFinalisation {
  erreur: string | null;
  succes: string | null;
  /**
   * Succès TOTAL de la finalisation : `true` ssi zéro échec lors de la
   * découverte/synchronisation des comptes (toutes les connexions du payload ont
   * été échangées et persistées), `false` en cas de succès PARTIEL (≥ 1 échec).
   * Le Front l'utilise pour déclencher la redirection auto vers le Dashboard
   * UNIQUEMENT sur un succès total (WIDGET-RD1) — ne jamais rediriger sur un
   * partiel masquerait un échec. Optionnel/absent quand la notion n'a pas de sens
   * (rejet de forme, erreur, ou synchro idempotente `GET /connections`).
   */
  complet?: boolean;
  /**
   * Connexions dont le re-sync exige une RÉPARATION MFA (le scraping a redemandé un
   * OTP). Signal pour que l'UI rouvre le widget natif `@omni-fi/react-link` en mode
   * REPAIR (link-token portant ConnectionId + JobId) — on ne pilote PAS la MFA côté
   * serveur. Absent/omis quand aucune connexion n'est concernée. Non-énumérant : ne
   * porte que des identifiants opaques Omni-FI (ni libellé bancaire ni token).
   */
  reparation?: Array<{ connectionId: string; jobId: string }>;
  /**
   * Connexions non re-synchronisées car en cooldown (« 1 sync / 15 min ») — PAS une
   * erreur. `nextSyncAt` = ISO 8601 du prochain sync possible (ou null si inconnu) ;
   * l'UI affiche le délai d'attente. Absent/omis quand aucune connexion n'est en
   * cooldown.
   */
  rateLimited?: Array<{ connectionId: string; nextSyncAt: string | null }>;
}

const MESSAGE_REFUS = "Action non autorisée.";
const MESSAGE_GENERIQUE = "La connexion bancaire a échoué. Réessayez.";
const MESSAGE_CONFIG = "Workspace non configuré pour Omni-FI.";
// Message DISTINCT du « paramètres invalides » générique (Volet B) : le rejet le
// plus courant n'est pas une malformation mais une origine non sécurisée/non
// autorisée. Reste non-énumérant (registre S2) : il ne révèle pas l'allowlist.
const MESSAGE_ORIGINE = "Origine sécurisée non autorisée pour la connexion bancaire.";

/**
 * Schéma de FORME seulement (string/url/longueur). L'AUTORISATION (https/dev/
 * allowlist) est décidée séparément par `autoriserRedirectOrigin` (module pur
 * `@/server/widget/redirect-origin`) dans l'action, pour pouvoir distinguer et
 * logger le motif de rejet (Volet B) — un fichier `"use server"` ne peut exporter
 * que des Server Actions, d'où l'extraction de la logique testable dans un module.
 */
const demarrageSchema = z
  .object({
    redirectOrigin: z.string().url().max(255),
    institutionId: z.string().trim().max(64).optional(),
  })
  .strict();

/**
 * Démarre une connexion : retourne un LinkToken pour initialiser le widget.
 * Le ClientUserId vient du workspace (frontière tenant), jamais du client.
 */
export async function demarrerConnexionAction(
  _etat: EtatDemarrage,
  formData: FormData,
): Promise<EtatDemarrage> {
  const session = await exigerSessionWorkspace();

  const parsed = demarrageSchema.safeParse({
    redirectOrigin: formData.get("redirectOrigin"),
    institutionId: formData.get("institutionId") ?? undefined,
  });
  if (!parsed.success) {
    // Malformation pure (champ absent, pas une URL, trop long) : reste générique.
    logRejetDemarrage(session.activeWorkspaceId, "forme");
    return { erreur: "Paramètres invalides.", linkToken: null };
  }

  // Autorisation de l'origine (Volet B/C) : motif loggé côté serveur, message UI
  // distinct et parlant mais non-énumérant.
  const motif = autoriserRedirectOrigin(parsed.data.redirectOrigin);
  if (motif !== "ok") {
    logRejetDemarrage(session.activeWorkspaceId, motif);
    return { erreur: MESSAGE_ORIGINE, linkToken: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await demarrerConnexion(client, executer, {
      redirectOrigin: parsed.data.redirectOrigin,
      institutionId: parsed.data.institutionId,
    });
    return { erreur: null, linkToken: r.linkToken };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "demarrer"),
      linkToken: null,
    };
  }
}

/**
 * Entrée du widget DROP-IN (hook `useOmniFILink`) : `onSuccess` remonte les
 * connexions abouties → le composant (après normalisation de la forme du payload,
 * cf. `omnifi-link-launcher.tsx`) nous transmet la LISTE des PublicTokens (un par
 * connexion). On borne la liste (1..20 connexions, tokens bornés) pour ne pas
 * accepter de payload non contrôlé.
 */
const dropinSchema = z
  .object({
    publicTokens: z.array(z.string().min(1).max(512)).min(1).max(20),
  })
  .strict();

/**
 * Finalisation pour le widget natif @omni-fi/react-link (hook). Reçoit les PublicTokens
 * de `onSuccess` (le payload peut porter plusieurs connexions), échange chacun
 * (ApiKey) et découvre les comptes via GET /accounts (ApiKey, sans SessionToken).
 * Appelée directement depuis le composant client.
 */
export async function finaliserConnexionDropinAction(
  publicTokens: string[],
): Promise<EtatFinalisation> {
  const session = await exigerSessionWorkspace();

  const parsed = dropinSchema.safeParse({ publicTokens });
  if (!parsed.success) {
    // Rejet de forme de la finalisation (liste vide/hors bornes/token trop long) :
    // tracé pour ne pas être invisible (Volet B), message UI inchangé.
    console.warn(
      JSON.stringify({
        evt: "widget_finalisation_rejet",
        action: "finaliser-dropin",
        workspaceId: session.activeWorkspaceId,
      }),
    );
    return { erreur: "Paramètres invalides.", succes: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await finaliserConnexionsDropin(
      client,
      executer,
      parsed.data.publicTokens,
    );
    // Succès partiel possible : on rattache ce qui a réussi et on signale le reste
    // sans énumérer (registre S2) — le détail des échecs est tracé côté serveur.
    const base = `Connexion établie — ${r.comptesRattaches} compte(s) rattaché(s) sur ${r.reussies.length} banque(s).`;
    const succes =
      r.echecs > 0 ? `${base} ${r.echecs} connexion(s) n'ont pas pu être finalisées.` : base;
    // WIDGET-RD1 : drapeau de succès TOTAL. `echecs` est le nb de publicTokens
    // reçus n'ayant pas pu être finalisés (cf. ResultatConnexionMulti). Zéro échec
    // = succès complet → le Front peut rediriger ; sinon partiel → il reste sur place.
    return { erreur: null, succes, complet: r.echecs === 0 };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "finaliser-dropin"),
      succes: null,
    };
  }
}

/**
 * Synchronise les connexions du workspace en lisant l'état réel côté Omni-FI
 * (`GET /connections`), SANS dépendre du PublicToken/postMessage du widget — qui est
 * cassé en sandbox (cf. OMNIFI_API_FEEDBACK.md §5/§6). Appelée à la fermeture du
 * widget (le widget a déjà persisté la connexion côté Omni-FI). Idempotente.
 */
export async function synchroniserConnexionsAction(): Promise<EtatFinalisation> {
  const session = await exigerSessionWorkspace();

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await synchroniserConnexionsDepuisOmnifi(client, executer);
    if (r.connexions === 0) {
      // Aucune connexion trouvée : ni erreur ni faux succès (l'utilisateur a pu
      // fermer sans connecter). Message neutre.
      return { erreur: null, succes: null };
    }
    // Phrase de base + suppléments (transactions, cooldown, réparation). Tous
    // non-énumérants : on COMPTE les cas, on ne nomme ni banque ni token.
    let base = `Synchronisation effectuée — ${r.comptesRattaches} compte(s) rattaché(s) sur ${r.connexions} banque(s).`;
    if (r.transactionsImportees > 0) {
      base += ` ${r.transactionsImportees} transaction(s) importée(s).`;
    }
    // Cooldown : information, pas erreur. On indique le délai si on connaît la date la
    // plus proche (sinon mention générique). L'UI peut afficher un compte à rebours.
    if (r.rateLimited.length > 0) {
      const delai = messageDelaiCooldown(r.rateLimited);
      base += ` ${r.rateLimited.length} banque(s) déjà synchronisée(s) récemment${delai ? ` (nouveau rafraîchissement possible ${delai})` : ""} — dernier état affiché.`;
    }
    // Réparation MFA : on le DIT clairement et on remonte le signal structuré pour que
    // l'UI rouvre le widget natif en mode REPAIR (jamais une MFA serveur).
    if (r.aReparer.length > 0) {
      base += ` ${r.aReparer.length} banque(s) demandent une nouvelle vérification de sécurité — reconnectez-les pour terminer.`;
    }
    return {
      erreur: null,
      succes: base,
      ...(r.aReparer.length > 0 ? { reparation: r.aReparer } : {}),
      ...(r.rateLimited.length > 0 ? { rateLimited: r.rateLimited } : {}),
    };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "synchroniser"),
      succes: null,
    };
  }
}

/**
 * Schéma de la demande de RÉPARATION. `connectionId`/`jobId` = identifiants opaques
 * Omni-FI (UUID) issus du signal `reparation` remonté par `synchroniserConnexionsAction`
 * (jamais saisis par l'utilisateur). `redirectOrigin` validé comme à l'onboarding (le
 * widget exige https). Bornes larges mais finies pour ne pas accepter de payload non
 * contrôlé. La FORME seulement ici ; l'autorisation d'origine est décidée à part.
 */
const reparationSchema = z
  .object({
    redirectOrigin: z.string().url().max(255),
    connectionId: z.string().trim().min(1).max(64),
    jobId: z.string().trim().min(1).max(64),
  })
  .strict();

/**
 * Crée un LinkToken de RÉPARATION (`Mode: REPAIR`) pour rouvrir le widget natif sur une
 * connexion en erreur (signal `reparation`). Le widget gère l'OTP EN INTERNE (cf. vendor
 * README §MFA handling) — on ne pilote pas la MFA côté serveur. Mêmes gardes que
 * `demarrerConnexionAction` : origine autorisée + gating MANAGER/ADMIN + ClientUserId
 * scopé + anti-IDOR (la connexion doit appartenir au workspace). Retourne `EtatDemarrage`
 * (la même forme que l'onboarding) pour que le front monte le MÊME launcher.
 */
export async function creerLinkTokenRepairAction(
  connectionId: string,
  jobId: string,
  redirectOrigin: string,
): Promise<EtatDemarrage> {
  const session = await exigerSessionWorkspace();

  const parsed = reparationSchema.safeParse({ redirectOrigin, connectionId, jobId });
  if (!parsed.success) {
    logRejetDemarrage(session.activeWorkspaceId, "forme");
    return { erreur: "Paramètres invalides.", linkToken: null };
  }

  const motif = autoriserRedirectOrigin(parsed.data.redirectOrigin);
  if (motif !== "ok") {
    logRejetDemarrage(session.activeWorkspaceId, motif);
    return { erreur: MESSAGE_ORIGINE, linkToken: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await demarrerReparation(client, executer, {
      redirectOrigin: parsed.data.redirectOrigin,
      connectionId: parsed.data.connectionId,
      jobId: parsed.data.jobId,
    });
    return { erreur: null, linkToken: r.linkToken };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "reparation"),
      linkToken: null,
    };
  }
}

/** Schéma de la re-lecture post-réparation : un seul identifiant opaque de connexion. */
const resyncConnexionSchema = z
  .object({ connectionId: z.string().trim().min(1).max(64) })
  .strict();

/**
 * Re-lit UNE connexion après que le widget natif a terminé la réparation (onSuccess).
 * Réutilise la boucle d'ingestion existante (`synchroniserCompte`) via
 * `resynchroniserConnexion`. Fail-soft : un sync FAILED/timeout ne lève pas — on remonte
 * ce qui a été lu. Gating + anti-IDOR portés par l'orchestration.
 */
export async function resynchroniserConnexionApresReparationAction(
  connectionId: string,
): Promise<EtatFinalisation> {
  const session = await exigerSessionWorkspace();

  const parsed = resyncConnexionSchema.safeParse({ connectionId });
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        evt: "widget_resync_connexion_rejet",
        action: "resync-connexion",
        workspaceId: session.activeWorkspaceId,
      }),
    );
    return { erreur: "Paramètres invalides.", succes: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await resynchroniserConnexion(client, executer, parsed.data.connectionId);
    let succes = `Connexion rétablie — ${r.comptesRattaches} compte(s) mis à jour.`;
    if (r.transactionsImportees > 0) {
      succes += ` ${r.transactionsImportees} transaction(s) importée(s).`;
    }
    if (r.reparationJobId) {
      // Rare : la banque a redemandé une vérification → on re-signale la réparation
      // (avec le NOUVEAU jobId) pour que l'UI laisse le bouton « Reconnecter » ré-armé.
      // Non-énumérant : que des identifiants opaques.
      succes += " Une nouvelle vérification de sécurité est encore demandée.";
      return {
        erreur: null,
        succes,
        reparation: [
          { connectionId: parsed.data.connectionId, jobId: r.reparationJobId },
        ],
      };
    }
    return { erreur: null, succes };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "resync-connexion"),
      succes: null,
    };
  }
}

/**
 * Formate le délai de cooldown le PLUS PROCHE en texte relatif court (« dans ~12
 * min »). On prend le `nextSyncAt` minimal parmi les connexions rate-limitées.
 * Renvoie "" si aucune date exploitable (l'amont ne l'a pas fournie). Non-énumérant :
 * un délai n'identifie pas une banque.
 */
function messageDelaiCooldown(
  rateLimited: Array<{ nextSyncAt: string | null }>,
): string {
  const instants = rateLimited
    .map((r) => (r.nextSyncAt ? Date.parse(r.nextSyncAt) : NaN))
    .filter((ms) => !Number.isNaN(ms) && ms > Date.now());
  if (instants.length === 0) return "";
  const minutes = Math.max(1, Math.round((Math.min(...instants) - Date.now()) / 60_000));
  return `dans ~${minutes} min`;
}

/**
 * Mappe une erreur en message UI non-énumérant (registre S2) ET émet un log
 * structuré corrélé (exit-criteria règle 3, constat cross-review 5.1). Le log ne
 * contient QUE des identifiants sûrs (workspace_id + code machine) — JAMAIS de
 * token, mot de passe bancaire, ni Message OBIE brut (règle 8 / A1).
 *
 * Sans ce log, un échec de garde-fou (UnsafeDatabaseRoleError) ou un timeout
 * serait invisible en exploitation (transformé en message générique côté UI).
 */
function messageDepuis(erreur: unknown, workspaceId: string, action: string): string {
  const code =
    erreur instanceof Error && "code" in erreur && typeof erreur.code === "string"
      ? erreur.code
      : erreur instanceof Error
        ? erreur.name
        : "UNKNOWN";
  // Log corrélé sûr (pas de PII/secret). Niveau warn : échec fonctionnel.
  console.warn(
    JSON.stringify({ evt: "widget_connexion_echec", action, workspaceId, code }),
  );

  if (
    erreur instanceof ConnexionNonAutoriseeError ||
    erreur instanceof WorkspaceAccessDeniedError ||
    // Contexte de réparation hors tenant (anti-IDOR) : refus non-énumérant, comme un
    // accès cross-workspace — on ne confirme pas l'existence de la connexion.
    erreur instanceof ReparationContexteInvalideError
  ) {
    return MESSAGE_REFUS;
  }
  if (erreur instanceof WorkspaceSansClientUserIdError) {
    return MESSAGE_CONFIG;
  }
  // Tout le reste (OmniFiApiError, ConnexionDesalignmentError, timeout, réseau,
  // UnsafeDatabaseRoleError…) → message générique côté UI (non-énumérant), mais
  // tracé ci-dessus par son code machine.
  return MESSAGE_GENERIQUE;
}

/**
 * Log structuré d'un rejet de validation AVANT tout appel amont (Volet B). Sans
 * lui, un rejet du schéma/de l'allowlist est invisible en exploitation (l'UI ne
 * voit qu'un message). On ne logge QUE le workspace_id + le motif machine — JAMAIS
 * l'URL d'origine (peut porter des identifiants) ni de token (règle 8).
 */
function logRejetDemarrage(workspaceId: string, motif: string): void {
  console.warn(
    JSON.stringify({
      evt: "widget_demarrage_rejet",
      action: "demarrer",
      workspaceId,
      motif,
    }),
  );
}
