"use server";

/**
 * Server Actions « runtime » du widget MFA (PR-W3) — pont navigateur → client
 * Omni-FI serveur. Le hook React (côté client) ne peut PAS appeler
 * `@/server/omnifi` directement (le client serveur n'est jamais expédié au
 * navigateur) ; il passe par ces actions.
 *
 * Modèle de confiance : le SessionToken (Bearer) est, PAR CONCEPTION du flux
 * Omni-FI, détenu côté navigateur (issu de l'échange widget). Ces actions le
 * RELAIENT vers Omni-FI ; elles ne le persistent ni ne le loggent (règle 8).
 * Gating MANAGER/ADMIN : un VIEWER ne pilote aucun appel widget.
 *
 * Chaque action est minimale et typée ; aucune ne renvoie de donnée sensible au
 * navigateur (on ne ressort que l'état du job nécessaire à la machine MFA).
 */
import { z } from "zod";

import { exigerSessionSansPerimetre } from "@/server/auth/session";
import { withWorkspace } from "@/server/db";
import { peutModifier } from "@/lib/permissions";
import {
  creerClientOmniFi,
  OmniFiApiError,
  type OmniFiSyncJob,
} from "@/server/omnifi";

/** Forme exposée au navigateur : sous-ensemble non sensible du SyncJob. */
export interface JobPublic {
  status: OmniFiSyncJob["Status"];
  userInputPresent: boolean;
  mfaType: OmniFiSyncJob["MfaType"];
  mfaLength: OmniFiSyncJob["MfaLength"];
  mfaCharset: OmniFiSyncJob["MfaCharset"];
  deliveryTargets: OmniFiSyncJob["DeliveryTargets"];
  mfaResendRequestedAt: string | null;
  mfaResendCooldownSeconds: number | null;
  mfaResendCount: number;
  errorType: string | null;
}

export interface ReponseRuntime<T> {
  ok: boolean;
  /** Code machine d'erreur (jamais de message brut / token) si !ok. */
  code: string | null;
  data: T | null;
}

const sessionTokenSchema = z.string().min(1).max(512);
const jobIdSchema = z.string().uuid();
const otpSchema = z.string().min(1).max(12);

/** Convertit un SyncJob serveur en forme publique (sans champ sensible). */
function versJobPublic(job: OmniFiSyncJob): JobPublic {
  return {
    status: job.Status,
    userInputPresent: job.UserInput != null,
    mfaType: job.MfaType ?? null,
    mfaLength: job.MfaLength ?? null,
    mfaCharset: job.MfaCharset ?? null,
    deliveryTargets: job.DeliveryTargets ?? null,
    mfaResendRequestedAt: job.MfaResendRequestedAt ?? null,
    mfaResendCooldownSeconds: job.MfaResendCooldownSeconds ?? null,
    mfaResendCount: job.MfaResendCount ?? 0,
    errorType: job.Error?.Type ?? null,
  };
}

/** Vérifie session + gating (MANAGER/ADMIN). Throw si refus. */
async function exigerDroitWidget(): Promise<void> {
  // Surface /banques (gestion de connexions tenant-wide) → session amputée du
  // viewFilter, comme les actions de `./actions.ts` (TOOLBAR-PERIMETRE-AMPUTATION1).
  // Ici c'est un NO-OP de correction (on ne vérifie que `ctx.role`, jamais
  // bank_accounts) : on ampute pour l'UNIFORMITÉ de l'invariant « la page ET toutes
  // ses Server Actions tournent amputées » (toolbar-config.ts).
  const session = await exigerSessionSansPerimetre();
  await withWorkspace(session, async (_tx, ctx) => {
    if (!peutModifier(ctx.role)) throw new Error("CONNEXION_NOT_AUTHORIZED");
  });
}

/** Code machine sûr d'une erreur (jamais de message brut). */
function codeErreur(e: unknown): string {
  if (e instanceof OmniFiApiError) return `OMNIFI_${e.status}`;
  if (e instanceof Error && e.message === "CONNEXION_NOT_AUTHORIZED")
    return "CONNEXION_NOT_AUTHORIZED";
  return "RUNTIME_ERROR";
}

/** Poll l'état d'un job (Bearer). */
export async function pollJobAction(
  sessionToken: string,
  jobId: string,
): Promise<ReponseRuntime<JobPublic>> {
  try {
    await exigerDroitWidget();
    const st = sessionTokenSchema.parse(sessionToken);
    const id = jobIdSchema.parse(jobId);
    const job = await creerClientOmniFi().getSyncJob(st, id);
    return { ok: true, code: null, data: versJobPublic(job) };
  } catch (e) {
    return { ok: false, code: codeErreur(e), data: null };
  }
}

/**
 * Soumet un OTP. `mfaResendRequestedAt` : passer la valeur lue (verbatim) si un
 * resend a eu lieu, sinon OMETTRE (undefined) — jamais null (A2 cross-review).
 */
export async function submitMfaAction(
  sessionToken: string,
  jobId: string,
  userInput: string,
  mfaResendRequestedAt?: string,
): Promise<ReponseRuntime<{ status: string }>> {
  try {
    await exigerDroitWidget();
    const st = sessionTokenSchema.parse(sessionToken);
    const id = jobIdSchema.parse(jobId);
    const otp = otpSchema.parse(userInput);
    const r = await creerClientOmniFi().soumettreMfa(
      st,
      id,
      otp,
      mfaResendRequestedAt, // undefined si absent — le client n'émet pas le champ
    );
    return { ok: true, code: null, data: { status: r.Status } };
  } catch (e) {
    return { ok: false, code: codeErreur(e), data: null };
  }
}

/** Demande un resend d'OTP (Bearer). Renvoie le nouveau watermark + compteur. */
export async function resendMfaAction(
  sessionToken: string,
  jobId: string,
): Promise<ReponseRuntime<{ mfaResendRequestedAt: string; mfaResendCount: number }>> {
  try {
    await exigerDroitWidget();
    const st = sessionTokenSchema.parse(sessionToken);
    const id = jobIdSchema.parse(jobId);
    const r = await creerClientOmniFi().resendMfa(st, id);
    return {
      ok: true,
      code: null,
      data: {
        mfaResendRequestedAt: r.MfaResendRequestedAt,
        mfaResendCount: r.MfaResendCount,
      },
    };
  } catch (e) {
    return { ok: false, code: codeErreur(e), data: null };
  }
}
