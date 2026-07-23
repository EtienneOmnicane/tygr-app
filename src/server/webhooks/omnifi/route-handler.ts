/**
 * Câblage RÉEL de la route webhook (§8.1) : lit les octets bruts + garde de taille,
 * assemble les vraies dépendances (résolution tygr_service, quarantaine, cross-check et
 * audit sous la primitive système, enqueue fail-loud), appelle l'orchestrateur PUR
 * `traiterWebhook`, et mappe le résultat/l'erreur → `Response` (corps VIDE, §2.2).
 *
 * Ce module vit sous `src/server/` (l'accès DB y est légitime, règle 2) ; la route
 * App Router `src/app/api/webhooks/omnifi/route.ts` n'est qu'une coquille qui l'appelle.
 * Il est exempté de FRONTIERE_SYSTEME/SERVICE (eslint) : c'est la seule surface qui
 * consomme la primitive système ET le client de service.
 */
import { eq } from "drizzle-orm";

import { workspaces } from "@/server/db/schema";
import {
  insererQuarantaine,
  resoudreConnexionParId,
} from "@/server/db/service";
import { executerPourWorkspaceSysteme } from "@/server/db/systeme";
import { demanderIngestionSyncOuLever } from "@/server/inngest/emission";
import {
  consignerEvenementWebhook,
  type EvenementWebhookAConsigner,
} from "@/server/repositories/audit";

import {
  ErreurWebhook,
  WebhookTropDeRequetesError,
  WebhookTropVolumineuxError,
} from "./erreurs";
import { selectionnerSecretWebhook, type EnvOmniFi } from "./hmac";
import { creerSeaux, verifierRateLimit } from "./rate-limit";
import { traiterWebhook, type DepsTraitementWebhook } from "./traitement";

/** Borne de taille du corps : 64 Ko (§3.1). Accepté ≤ borne, rejeté au-delà. */
const TAILLE_MAX_OCTETS = 64 * 1024;

/** Seau de rate-limit — SINGLETON du process (en mémoire, par instance — §4.1). */
const seauxWebhook = creerSeaux();

/** Env du déploiement : « production » SSI OMNIFI_ENV vaut exactement cela, sinon sandbox. */
function envDeploiement(): EnvOmniFi {
  return process.env.OMNIFI_ENV === "production" ? "production" : "sandbox";
}

/** Cross-check : env du workspace résolu (sous tygr_app + GUC ; workspaces sans RLS). */
async function lireEnvWorkspace(workspaceId: string): Promise<EnvOmniFi | null> {
  return executerPourWorkspaceSysteme(workspaceId)(async (tx) => {
    const r = await tx
      .select({ env: workspaces.omnifiEnvironment })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const env = r[0]?.env;
    return env === "sandbox" || env === "production" ? env : null;
  });
}

/** Écriture d'audit webhook, sous la primitive système (tygr_app + GUC tenant). */
async function consignerAudit(
  workspaceId: string,
  evt: EvenementWebhookAConsigner,
): Promise<{ insere: boolean }> {
  return executerPourWorkspaceSysteme(workspaceId)((tx, ctx) =>
    consignerEvenementWebhook(tx, ctx, evt),
  );
}

/** code machine → nom d'événement de log grep-able (§9.2). */
const EVT_PAR_CODE: Record<string, string> = {
  WEBHOOK_NON_CONFIGURE: "webhook_non_configure",
  WEBHOOK_TROP_VOLUMINEUX: "webhook_trop_volumineux",
  WEBHOOK_TROP_DE_REQUETES: "webhook_rate_limite",
  WEBHOOK_SIGNATURE_INVALIDE: "webhook_signature_invalide",
  WEBHOOK_PAYLOAD_INVALIDE: "webhook_payload_invalide",
  WEBHOOK_HORS_FENETRE: "webhook_hors_fenetre",
  WEBHOOK_ENQUEUE_ECHEC: "webhook_enqueue_echec",
  WEBHOOK_AUDIT_ECHEC: "webhook_audit_echec",
};

/** Mappe une erreur → Response (corps vide). Les gardes de tenancy (non-ErreurWebhook)
 *  sont RE-LEVÉES en 500, jamais avalées (§11.1). */
function mapperErreur(e: unknown, requestId: string): Response {
  if (e instanceof ErreurWebhook) {
    const evt = EVT_PAR_CODE[e.code] ?? "webhook_rejet";
    const ligne = JSON.stringify({
      evt,
      requestId,
      code: e.code,
      statut: e.statutHttp,
    });
    if (e.statutHttp >= 500) console.error(ligne);
    else console.warn(ligne);
    const headers = new Headers();
    if (e instanceof WebhookTropDeRequetesError) {
      headers.set("Retry-After", String(e.retryApresSecondes));
    }
    return new Response(null, { status: e.statutHttp, headers });
  }
  // Erreur inattendue (dont les gardes RoleServiceInattenduError / UnsafeDatabaseRoleError,
  // re-levées) : 500 nommé, jamais un catch-all silencieux.
  const code =
    e instanceof Error && "code" in e && typeof e.code === "string"
      ? e.code
      : e instanceof Error
        ? e.name
        : "UNKNOWN";
  console.error(
    JSON.stringify({ evt: "webhook_erreur_interne", requestId, code }),
  );
  return new Response(null, { status: 500 });
}

/**
 * Point d'entrée HTTP (appelé par la coquille App Router). Un SEUL code de succès :
 * 202, pour accepté / dédupliqué / quarantiné (§2.1). Corps toujours vide.
 */
export async function traiterRequeteWebhook(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  console.info(JSON.stringify({ evt: "webhook_recu", requestId }));
  try {
    // (0) Transport — taille : content-length (rejet précoce, coût nul). La méthode
    //     ≠ POST → 405 (Next : seul POST est exporté par la route).
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > TAILLE_MAX_OCTETS) {
      throw new WebhookTropVolumineuxError();
    }

    // (1) Rate-limit AVANT la lecture du corps (§4.1, C2) : la clé (XFF) ne dépend pas
    //     du corps → on borne le coût de buffering d'une inondation non authentifiée.
    verifierRateLimit(seauxWebhook, request.headers.get("x-forwarded-for"), Date.now());

    // Octets réels APRÈS le rate-limit (un content-length menteur ne passe pas la borne).
    const octets = Buffer.from(await request.arrayBuffer());
    if (octets.byteLength > TAILLE_MAX_OCTETS) {
      throw new WebhookTropVolumineuxError();
    }

    const env = envDeploiement();
    const deps: DepsTraitementWebhook = {
      envDeploiement: env,
      secret: selectionnerSecretWebhook(env, {
        sandbox: process.env.OMNIFI_WEBHOOK_SECRET_SANDBOX,
        production: process.env.OMNIFI_WEBHOOK_SECRET_PRODUCTION,
      }),
      maintenant: () => Date.now(),
      resoudreConnexion: resoudreConnexionParId,
      insererQuarantaine,
      lireEnvWorkspace,
      enqueue: demanderIngestionSyncOuLever,
      consignerAudit,
    };

    const resultat = await traiterWebhook(
      deps,
      {
        octets,
        signature: request.headers.get("x-omnifi-signature"),
      },
      requestId,
    );

    console.info(
      JSON.stringify({
        evt: "webhook_traite",
        requestId,
        issue: resultat.issue,
        ...(resultat.issue === "QUARANTAINE" ? { motif: resultat.motif } : {}),
      }),
    );
    return new Response(null, { status: 202 });
  } catch (e) {
    return mapperErreur(e, requestId);
  }
}
