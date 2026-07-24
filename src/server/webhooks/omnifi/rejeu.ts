/**
 * REJEU de la quarantaine webhook (lot W5, PLAN-webhook-ingestion.md §12).
 *
 * Invariant central du plan : le rejeu repasse chaque événement par le pipeline
 * COMPLET — (5) résolution tygr_service → (6) cross-check env → (7) enqueue →
 * (8) audit — AUCUN raccourci, le rejeu ne contourne jamais une garde. Les
 * étages (0)-(4) (secret, HMAC, zod, fraîcheur) ne se REJOUENT pas : ils ont été
 * vérifiés à la RÉCEPTION, sur les octets bruts — la quarantaine ne stocke que
 * des événements déjà authentifiés et validés (et pas la signature, qui serait
 * rejouable).
 *
 * Issues d'un rejeu :
 *  - RÉSOLU → enqueue (si l'EventType déclenche, même gating qu'à la réception)
 *    + audit (`declencheur: WEBHOOK_REJEU`, dédup permanente inchangée) +
 *    `replayed_at` posé → l'événement sort du balayage.
 *  - TOUJOURS pas résolvable (connexion inconnue / ambiguë / env mismatch) →
 *    `replay_count` incrémenté ; au PLAFOND (10), l'événement sort du balayage
 *    (log d'alerte) et attendra la purge TTL. Le motif CONSTATÉ au rejeu est
 *    journalisé ; le motif STOCKÉ (état à la réception) n'est pas réécrit.
 *  - Échec d'INFRASTRUCTURE (enqueue/audit qui lève) → l'erreur REMONTE (le step
 *    Inngest retente) : pas d'incrément — le plafond ne compte que les constats
 *    « non résolvable », jamais les pannes. Un retry après enqueue réussi est
 *    inoffensif : la clé d'idempotence `wh:${EventId}` collapse, l'audit déduplique.
 *
 * DEUX déclencheurs (fonctions Inngest, `fonctions/webhook-replay.ts`) :
 *  - `link-exchange` (émission fail-soft) → rejeu ciblé sur LA connexion créée ;
 *  - cron filet quotidien → balayage complet + purge TTL 30 j (log d'abandon).
 * Les deux peuvent se recouvrir sans danger : chaque étape est idempotente (le
 * seul effet d'une course est un double incrément de `replay_count`, cosmétique).
 *
 * Ce module vit sous `src/server/webhooks/omnifi/**` : seule surface autorisée à
 * consommer le client de service (FRONTIERE_SERVICE) — les fonctions Inngest
 * n'importent que LES WRAPPERS câblés exportés ici, jamais service.ts.
 */
import type { DonneesSyncIngest } from "@/server/inngest/client";
import type { EvenementWebhookAConsigner } from "@/server/repositories/audit";
import type {
  LigneConnexionResolue,
  LigneQuarantaineEnAttente,
} from "@/server/db/service";
import {
  enregistrerEchecRejeu,
  listerQuarantaineEnAttente,
  marquerQuarantaineRejouee,
  purgerQuarantaineExpiree,
  resoudreConnexionParId,
} from "@/server/db/service";
import { demanderIngestionSyncOuLever } from "@/server/inngest/emission";
import type { WebhookMotif } from "@/server/db/schema";

import {
  consignerAuditWebhook,
  envDeploiement,
  lireEnvWorkspace,
} from "./deps-communes";
import type { EnvOmniFi } from "./hmac";
import { deciderResolution } from "./resolution";
import { doitDeclencherSync } from "./traitement";

/** Plafond anti-boucle de rejeux INFRUCTUEUX par événement (schéma 0026, §7.1). */
export const PLAFOND_REJEUX = 10;
/** TTL de la quarantaine — invariant §3.4 : fenêtre de fraîcheur (12 h) ≤ TTL,
 *  sinon un événement purgé pourrait RE-rentrer en quarantaine par rejeu amont. */
export const TTL_QUARANTAINE_JOURS = 30;
/** Borne d'un lot de rejeu (un run Inngest) — la troncature est JOURNALISÉE
 *  (no silent caps) et le lot suivant (cron quotidien) reprend le reste. */
export const LOT_REJEU_MAX = 100;

export interface DepsRejeuWebhook {
  /** Env du déploiement (OMNIFI_ENV) — le cross-check (6) compare CONTRE LUI. */
  envDeploiement: EnvOmniFi;
  /** (5) Résolution tygr_service `omnifi_connection_id → connexion(s)` (LIMIT 2). */
  resoudreConnexion: (
    omnifiConnectionId: string,
  ) => Promise<LigneConnexionResolue[]>;
  /** (6) Cross-check : env du workspace résolu (sous tygr_app + GUC). */
  lireEnvWorkspace: (workspaceId: string) => Promise<EnvOmniFi | null>;
  /** (7) Enqueue Inngest FAIL-LOUD (une levée remonte au step, qui retente). */
  enqueue: (donnees: DonneesSyncIngest) => Promise<void>;
  /** (8) Écriture d'audit (sous tygr_app + GUC, ON CONFLICT DO NOTHING). */
  consignerAudit: (
    workspaceId: string,
    evt: EvenementWebhookAConsigner,
  ) => Promise<{ insere: boolean }>;
  /** Sortie de quarantaine (replayed_at) — après livraison complète. */
  marquerRejouee: (id: string) => Promise<void>;
  /** Constat « toujours pas résolvable » — incrémente replay_count. */
  enregistrerEchec: (id: string) => Promise<{ tentatives: number }>;
}

export type ResultatRejeu =
  | { issue: "REJOUE" }
  | { issue: "DEJA_VU" }
  | { issue: "TOUJOURS_EN_QUARANTAINE"; motif: WebhookMotif; tentatives: number };

/** Constat d'échec de résolution au rejeu : compteur + logs (alerte au plafond). */
async function constaterEchec(
  deps: DepsRejeuWebhook,
  ligne: LigneQuarantaineEnAttente,
  motif: WebhookMotif,
  requestId: string,
): Promise<ResultatRejeu> {
  const { tentatives } = await deps.enregistrerEchec(ligne.id);
  const log = JSON.stringify({
    evt: "webhook_rejeu_echec",
    requestId,
    motif,
    motifInitial: ligne.motif,
    eventId: ligne.omnifiEventId,
    omnifiConnectionId: ligne.omnifiConnectionId,
    tentatives,
    plafond: PLAFOND_REJEUX,
  });
  // AMBIGUE / ENV_MISMATCH restent des signaux d'ISOLATION (§9.2) → error.
  if (motif === "AMBIGUE" || motif === "ENV_MISMATCH") {
    console.error(log);
  } else {
    console.info(log);
  }
  if (tentatives >= PLAFOND_REJEUX) {
    // Sort du balayage (filtre replay_count < plafond) : abandon DIFFÉRÉ à la
    // purge TTL — jamais silencieux.
    console.error(
      JSON.stringify({
        evt: "webhook_rejeu_plafond_atteint",
        requestId,
        eventId: ligne.omnifiEventId,
        omnifiConnectionId: ligne.omnifiConnectionId,
        tentatives,
      }),
    );
  }
  return { issue: "TOUJOURS_EN_QUARANTAINE", motif, tentatives };
}

/**
 * Rejoue UN événement quarantiné par le pipeline complet (étages 5→8). Fonction
 * à dépendances INJECTABLES — testée unitairement sans réseau ni DB ; les
 * fonctions Inngest consomment le wrapper câblé `rejouerEvenementQuarantaine`.
 */
export async function rejouerEvenement(
  deps: DepsRejeuWebhook,
  ligne: LigneQuarantaineEnAttente,
  requestId: string,
): Promise<ResultatRejeu> {
  // (5) Résolution TENANT fail-closed — mêmes gardes qu'à la réception : la
  //     multiplicité reste une quarantaine, jamais un choix arbitraire.
  const lignes = await deps.resoudreConnexion(ligne.omnifiConnectionId);
  const decision = deciderResolution(lignes);
  if (decision.type === "QUARANTAINE") {
    return constaterEchec(deps, ligne, decision.motif, requestId);
  }
  const connexion = decision.connexion;

  // (6) Cross-check d'environnement (sous tygr_app + GUC, D1).
  const envWorkspace = await deps.lireEnvWorkspace(connexion.workspaceId);
  if (envWorkspace !== deps.envDeploiement) {
    return constaterEchec(deps, ligne, "ENV_MISMATCH", requestId);
  }

  // (7) Enqueue — même gating par EventType qu'à la réception (§7.3), même clé
  //     d'idempotence `wh:${EventId}` : si la réception avait déjà enqueue (cas
  //     limite d'un rejeu concurrent), Inngest collapse en 1 run.
  if (doitDeclencherSync(ligne.eventType)) {
    await deps.enqueue({
      workspaceId: connexion.workspaceId,
      omnifiConnectionId: ligne.omnifiConnectionId,
      declencheur: "WEBHOOK",
      omnifiJobId: ligne.omnifiJobId ?? undefined,
      omnifiEventId: ligne.omnifiEventId,
      cleIdempotence: `wh:${ligne.omnifiEventId}`,
    });
  }

  // (8) Audit APRÈS enqueue (§6.3 — même ordre qu'à la réception) : un échec ici
  //     fait retenter le step, qui ré-enqueue (collapsé) puis repose la trace.
  //     `hmacSignatureTruncated: null` : la signature a été vérifiée à la
  //     réception et n'est pas conservée en quarantaine (elle serait rejouable).
  const audit = await deps.consignerAudit(connexion.workspaceId, {
    omnifiEventId: ligne.omnifiEventId,
    eventType: ligne.eventType,
    connectionId: connexion.id,
    hmacSignatureTruncated: null,
    omnifiJobId: ligne.omnifiJobId ?? null,
    declencheur: "WEBHOOK_REJEU",
  });

  // Sortie de quarantaine — APRÈS la livraison complète (si marquer échoue, le
  // retry re-livre : idempotent par construction, jamais un événement perdu).
  await deps.marquerRejouee(ligne.id);

  console.info(
    JSON.stringify({
      evt: "webhook_rejeu_livre",
      requestId,
      eventId: ligne.omnifiEventId,
      workspaceId: connexion.workspaceId,
      connectionId: connexion.id,
      eventType: ligne.eventType,
      dejaVu: !audit.insere,
    }),
  );
  return audit.insere ? { issue: "REJOUE" } : { issue: "DEJA_VU" };
}

/* ------------------------------------------------------------------ */
/* Wrappers CÂBLÉS — seuls points d'entrée des fonctions Inngest        */
/* ------------------------------------------------------------------ */

function depsReelles(): DepsRejeuWebhook {
  return {
    envDeploiement: envDeploiement(),
    resoudreConnexion: resoudreConnexionParId,
    lireEnvWorkspace,
    enqueue: demanderIngestionSyncOuLever,
    consignerAudit: consignerAuditWebhook,
    marquerRejouee: marquerQuarantaineRejouee,
    enregistrerEchec: enregistrerEchecRejeu,
  };
}

/**
 * Lot d'événements en attente (FIFO), borné à `LOT_REJEU_MAX` — la troncature
 * est journalisée (no silent caps) : le reste part au balayage suivant.
 */
export async function listerQuarantainePourRejeu(
  omnifiConnectionId?: string,
): Promise<LigneQuarantaineEnAttente[]> {
  const lignes = await listerQuarantaineEnAttente({
    omnifiConnectionId,
    plafondRejeux: PLAFOND_REJEUX,
    limite: LOT_REJEU_MAX,
  });
  if (lignes.length >= LOT_REJEU_MAX) {
    console.warn(
      JSON.stringify({
        evt: "webhook_rejeu_lot_tronque",
        lot: LOT_REJEU_MAX,
        ...(omnifiConnectionId ? { omnifiConnectionId } : {}),
      }),
    );
  }
  return lignes;
}

/** Rejeu d'UN événement, deps réelles (consommé par les steps Inngest). */
export async function rejouerEvenementQuarantaine(
  ligne: LigneQuarantaineEnAttente,
  requestId: string,
): Promise<ResultatRejeu> {
  return rejouerEvenement(depsReelles(), ligne, requestId);
}

/**
 * Purge TTL (30 j) : supprime les lignes expirées et journalise CHAQUE abandon
 * (jamais rejouée avec succès) — identifiants techniques amont uniquement, zéro
 * PII. Un événement purgé ne peut pas re-rentrer par rejeu amont : la fenêtre de
 * fraîcheur (12 h) est très inférieure au TTL (invariant §3.4).
 */
export async function purgerQuarantaine(
  maintenantMs: number,
): Promise<{ purgees: number; abandonnees: number }> {
  const seuil = new Date(
    maintenantMs - TTL_QUARANTAINE_JOURS * 24 * 60 * 60 * 1000,
  );
  const lignes = await purgerQuarantaineExpiree(seuil);
  let abandonnees = 0;
  for (const l of lignes) {
    if (!l.abandonnee) continue;
    abandonnees += 1;
    console.error(
      JSON.stringify({
        evt: "webhook_quarantaine_abandon",
        eventId: l.omnifiEventId,
        omnifiConnectionId: l.omnifiConnectionId,
        eventType: l.eventType,
        motif: l.motif,
        tentatives: l.replayCount,
        ttlJours: TTL_QUARANTAINE_JOURS,
      }),
    );
  }
  if (lignes.length > 0) {
    console.info(
      JSON.stringify({
        evt: "webhook_quarantaine_purge",
        purgees: lignes.length,
        abandonnees,
      }),
    );
  }
  return { purgees: lignes.length, abandonnees };
}
