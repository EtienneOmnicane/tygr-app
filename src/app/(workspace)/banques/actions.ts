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
  WorkspaceSansClientUserIdError,
  demarrerConnexion,
  finaliserConnexionsDropin,
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
 * Entrée du widget DROP-IN (hook `useOmniFILink`) : `onSuccess` rend
 * `{ connections: [...] }` → le composant nous transmet la LISTE des PublicTokens
 * (un par connexion). On borne la liste (1..20 connexions, tokens bornés) pour ne
 * pas accepter de payload non contrôlé.
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
    return { erreur: null, succes };
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
    return {
      erreur: null,
      succes: `Synchronisation effectuée — ${r.comptesRattaches} compte(s) rattaché(s) sur ${r.connexions} banque(s).`,
    };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "synchroniser"),
      succes: null,
    };
  }
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
    erreur instanceof WorkspaceAccessDeniedError
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
