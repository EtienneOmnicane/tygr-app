/**
 * Orchestrateur du webhook Omni-FI (§2). Séquence les étages du pipeline avec des
 * DÉPENDANCES INJECTABLES (résolution, quarantaine, cross-check, enqueue, audit,
 * horloge, secret) — la route ne fait que lire les octets, câbler les vraies deps et
 * mapper le résultat → HTTP. Testable in-process (§10.3) sans réseau ni DB réelle.
 *
 * Ordre (§2 / §6.3) : le RATE-LIMIT (étage 1) est fait par la coquille de transport
 * AVANT la lecture du corps (route-handler, anti-DoS — constat cross-review W4 C2) ;
 * ici : (0) secret → (2) HMAC → (3) zod → (4) fraîcheur → (5) résolution →
 * (6) cross-check env → (7) ENQUEUE (avant audit) → (8) audit → 202. Toute étape d'échec
 * LÈVE une `ErreurWebhook` (la route mappe `.statutHttp`, corps vide) ; la quarantaine et
 * le succès RETOURNENT (202).
 */
import type { EvenementQuarantaine, LigneConnexionResolue } from "@/server/db/service";
import type { WebhookMotif } from "@/server/db/schema";
import type { DonneesSyncIngest } from "@/server/inngest/client";
import type { EvenementWebhookAConsigner } from "@/server/repositories/audit";

import {
  WebhookAuditEchecError,
  WebhookEnqueueEchecError,
  WebhookNonConfigureError,
  WebhookPayloadInvalideError,
} from "./erreurs";
import { verifierFraicheur } from "./fraicheur";
import { tronquerSignature, verifierHmac, type EnvOmniFi } from "./hmac";
import { deciderResolution } from "./resolution";
import { parserPayloadWebhook, type PayloadWebhook } from "./schema";

/**
 * EventType amont qui DÉCLENCHENT une ingestion (enqueue). Les autres sont TRACÉS
 * (audit) mais N'enqueuent PAS (§7.3). Valeurs EXACTES de docs/documentation_api.md
 * (§ Webhooks). Comparaison insensible à la casse par prudence (leçon UNCLASSIFIED :
 * l'amont peut dériver la graphie sans le dire).
 */
const EVENTS_DECLENCHANT_SYNC = new Set([
  "sync.completed",
  "sync.failed",
  "sync.mfa_required",
]);

export interface DepsTraitementWebhook {
  /** Env du déploiement (OMNIFI_ENV). */
  envDeploiement: EnvOmniFi;
  /** Secret webhook déjà sélectionné pour l'env (null → 503, route inerte). */
  secret: string | null;
  /** Horloge injectable (prod : `Date.now`). */
  maintenant: () => number;
  /** Résolution tygr_service `omnifi_connection_id → connexion(s)` (LIMIT 2). */
  resoudreConnexion: (
    omnifiConnectionId: string,
  ) => Promise<LigneConnexionResolue[]>;
  /** Écriture en quarantaine (tygr_service). */
  insererQuarantaine: (evt: EvenementQuarantaine) => Promise<{ insere: boolean }>;
  /** Cross-check : env du workspace résolu (sous tygr_app + GUC). null = introuvable. */
  lireEnvWorkspace: (workspaceId: string) => Promise<EnvOmniFi | null>;
  /** Enqueue Inngest FAIL-LOUD (une levée → WEBHOOK_ENQUEUE_ECHEC). */
  enqueue: (donnees: DonneesSyncIngest) => Promise<void>;
  /** Écriture d'audit (sous tygr_app + GUC, ON CONFLICT DO NOTHING). */
  consignerAudit: (
    workspaceId: string,
    evt: EvenementWebhookAConsigner,
  ) => Promise<{ insere: boolean }>;
}

export interface RequeteWebhook {
  /** Octets BRUTS du corps (jamais un JSON re-sérialisé — §3.1). */
  octets: Buffer;
  /** En-tête `x-omnifi-signature`. */
  signature: string | null;
}

export type ResultatWebhook =
  | { issue: "ACCEPTE" }
  | { issue: "DEDUPLIQUE" }
  | { issue: "QUARANTAINE"; motif: WebhookMotif };

/** Mappe le payload validé → ligne de quarantaine (le `Payload{}` amont y va tel quel). */
function construireQuarantaine(
  payload: PayloadWebhook,
  motif: WebhookMotif,
  env: EnvOmniFi,
): EvenementQuarantaine {
  return {
    omnifiEventId: payload.EventId,
    omnifiConnectionId: payload.ConnectionId,
    eventType: payload.EventType,
    omnifiJobId: payload.JobId ?? null,
    omnifiEnvironment: env,
    motif,
    payload: payload.Payload,
  };
}

/** Log de quarantaine — AMBIGUE / ENV_MISMATCH = ALERTE (error), sinon info. Zéro PII. */
function journaliserQuarantaine(
  requestId: string,
  payload: PayloadWebhook,
  motif: WebhookMotif,
  workspaceId?: string,
): void {
  const ligne = JSON.stringify({
    evt: "webhook_quarantaine",
    requestId,
    motif,
    eventId: payload.EventId,
    omnifiConnectionId: payload.ConnectionId,
    eventType: payload.EventType,
    ...(workspaceId ? { workspaceId } : {}),
  });
  // AMBIGUE et ENV_MISMATCH sont des signaux d'ISOLATION → error (§9.2).
  if (motif === "AMBIGUE" || motif === "ENV_MISMATCH") {
    console.error(ligne);
  } else {
    console.info(ligne);
  }
}

export async function traiterWebhook(
  deps: DepsTraitementWebhook,
  requete: RequeteWebhook,
  requestId: string,
): Promise<ResultatWebhook> {
  const now = deps.maintenant();

  // (0) Secret configuré pour l'env courant ? Sinon route INERTE (503) — jamais une
  //     dégradation en « on accepte sans vérifier ». (Le rate-limit, étage 1, a déjà été
  //     appliqué par la coquille de transport AVANT la lecture du corps — C2.)
  if (deps.secret === null) {
    throw new WebhookNonConfigureError();
  }

  // (2) HMAC sur les OCTETS BRUTS. Aucun parse JSON, aucun écrit DB avant ce point.
  const signature = verifierHmac(requete.octets, requete.signature, deps.secret);
  const sigTronquee = tronquerSignature(signature);

  // (3) Décodage UTF-8 puis zod strict. Un corps non-JSON → 400 (pas un 500).
  let brut: unknown;
  try {
    brut = JSON.parse(requete.octets.toString("utf8"));
  } catch {
    throw new WebhookPayloadInvalideError();
  }
  const payload = parserPayloadWebhook(brut);

  // (4) Fraîcheur (anti-replay) — en instants UTC.
  verifierFraicheur(payload.Timestamp, now);

  // (5) Résolution TENANT fail-closed (sous tygr_service, périmètre gelé).
  const lignes = await deps.resoudreConnexion(payload.ConnectionId);
  const decision = deciderResolution(lignes);
  if (decision.type === "QUARANTAINE") {
    await deps.insererQuarantaine(
      construireQuarantaine(payload, decision.motif, deps.envDeploiement),
    );
    journaliserQuarantaine(requestId, payload, decision.motif);
    return { issue: "QUARANTAINE", motif: decision.motif };
  }
  const connexion = decision.connexion;

  // (6) Cross-check d'environnement, sous tygr_app + GUC (workspaces n'a pas de RLS —
  //     D1 : pas besoin d'élargir tygr_service). Mismatch → quarantaine ENV_MISMATCH.
  const envWorkspace = await deps.lireEnvWorkspace(connexion.workspaceId);
  if (envWorkspace !== deps.envDeploiement) {
    await deps.insererQuarantaine(
      construireQuarantaine(payload, "ENV_MISMATCH", deps.envDeploiement),
    );
    journaliserQuarantaine(requestId, payload, "ENV_MISMATCH", connexion.workspaceId);
    return { issue: "QUARANTAINE", motif: "ENV_MISMATCH" };
  }

  // (7) ENQUEUE (fail-loud) AVANT l'audit (§6.3) — SEULEMENT pour les EventType qui
  //     déclenchent une ingestion ; les autres sont tracés sans enqueue. Un rejeu du
  //     même EventId collapse en 1 run (idempotency `wh:${EventId}`, fenêtre 24 h).
  const doitEnqueue = EVENTS_DECLENCHANT_SYNC.has(
    payload.EventType.trim().toLowerCase(),
  );
  if (doitEnqueue) {
    try {
      await deps.enqueue({
        workspaceId: connexion.workspaceId,
        omnifiConnectionId: payload.ConnectionId,
        declencheur: "WEBHOOK",
        omnifiJobId: payload.JobId ?? undefined,
        omnifiEventId: payload.EventId,
        cleIdempotence: `wh:${payload.EventId}`,
      });
    } catch {
      // Aucune trace posée avant ce point (§6.3) → le retry amont fonctionne.
      throw new WebhookEnqueueEchecError();
    }
    console.info(
      JSON.stringify({
        evt: "webhook_enqueue",
        requestId,
        workspaceId: connexion.workspaceId,
        connectionId: connexion.id,
        eventType: payload.EventType,
      }),
    );
  }

  // (8) Audit APRÈS enqueue (trace + dédup permanente par tenant, étage 2). Échec ici →
  //     500 → le retry ré-enqueue (collapsé) et repose la trace : auto-réparant.
  let audit: { insere: boolean };
  try {
    audit = await deps.consignerAudit(connexion.workspaceId, {
      omnifiEventId: payload.EventId,
      eventType: payload.EventType,
      connectionId: connexion.id,
      hmacSignatureTruncated: sigTronquee,
      omnifiJobId: payload.JobId ?? null,
    });
  } catch {
    throw new WebhookAuditEchecError();
  }

  if (!audit.insere) {
    // Conflit = déjà vu (rejeu). L'enqueue ci-dessus a été collapsé par Inngest.
    console.info(
      JSON.stringify({
        evt: "webhook_deja_vu",
        requestId,
        workspaceId: connexion.workspaceId,
        eventId: payload.EventId,
      }),
    );
    return { issue: "DEDUPLIQUE" };
  }

  return { issue: "ACCEPTE" };
}
