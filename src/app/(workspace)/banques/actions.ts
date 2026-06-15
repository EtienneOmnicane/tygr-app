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
  finaliserConnexion,
} from "@/server/widget/orchestration";

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

/** RedirectOrigin : https, scheme+host SANS path (contrat link-token). */
const demarrageSchema = z
  .object({
    redirectOrigin: z
      .string()
      .url()
      .max(255)
      .refine((u) => {
        try {
          const url = new URL(u);
          return (
            url.protocol === "https:" &&
            url.pathname === "/" &&
            url.search === "" &&
            url.hash === ""
          );
        } catch {
          return false;
        }
      }, "RedirectOrigin doit être une origine https sans path"),
    institutionId: z.string().trim().max(64).optional(),
  })
  .strict();

const finalisationSchema = z
  .object({
    publicToken: z.string().min(1).max(512),
    sessionToken: z.string().min(1).max(512),
    jobId: z.string().uuid(),
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
    return { erreur: "Paramètres invalides.", linkToken: null };
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
 * Finalise une connexion : échange le PublicToken, découvre + persiste les
 * comptes. Idempotent.
 */
export async function finaliserConnexionAction(
  _etat: EtatFinalisation,
  formData: FormData,
): Promise<EtatFinalisation> {
  const session = await exigerSessionWorkspace();

  const parsed = finalisationSchema.safeParse({
    publicToken: formData.get("publicToken"),
    sessionToken: formData.get("sessionToken"),
    jobId: formData.get("jobId"),
  });
  if (!parsed.success) {
    return { erreur: "Paramètres invalides.", succes: null };
  }

  const client = creerClientOmniFi();
  const executer = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
    withWorkspace(session, fn);

  try {
    const r = await finaliserConnexion(client, executer, {
      publicToken: parsed.data.publicToken,
      sessionToken: parsed.data.sessionToken,
      jobId: parsed.data.jobId,
    });
    return {
      erreur: null,
      succes: `Connexion établie — ${r.comptesRattaches} compte(s) rattaché(s).`,
    };
  } catch (erreur) {
    return {
      erreur: messageDepuis(erreur, session.activeWorkspaceId, "finaliser"),
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
