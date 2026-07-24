/**
 * Fonctions durables du REJEU de quarantaine webhook (lot W5, plan §12).
 *
 * Deux déclencheurs, une même mécanique (`rejouerLot`) :
 *  - `omnifi-webhook-replay` — événement `omnifi/webhook.replay.requested`, émis
 *    (fail-soft) au `link-exchange` : rejeu CIBLÉ sur la connexion qui vient
 *    d'être créée (ses webhooks arrivés trop tôt attendent en CONNEXION_INCONNUE).
 *  - `omnifi-webhook-replay-cron` — FILET quotidien (05:30 heure de Maurice,
 *    fuseau EXPLICITE dans l'expression cron — les timestamps restent UTC en
 *    base) : balaye TOUTE la quarantaine puis applique la purge TTL 30 j avec
 *    log d'abandon. ⚠️ Ce cron n'est PAS le lot W2 (cron de sync 06:00 MUT +
 *    sync_runs) : il ne rattrape que la QUARANTAINE, pas les événements jamais
 *    reçus — W2 reste dû.
 *
 * Durabilité : le listing est un step, chaque événement est rejoué dans SON step
 * (retry unitaire ; un échec d'infra ne fait pas retomber tout le lot). Toute la
 * logique (pipeline complet, plafond, logs) vit dans
 * `src/server/webhooks/omnifi/rejeu.ts` — seule surface autorisée à consommer le
 * client de service (FRONTIERE_SERVICE) ; ce module n'importe que ses wrappers.
 */
import { StepError, type GetStepTools } from "inngest";

import {
  donneesWebhookReplaySchema,
  evenementWebhookReplay,
  inngest,
} from "@/server/inngest/client";
import {
  listerQuarantainePourRejeu,
  purgerQuarantaine,
  rejouerEvenementQuarantaine,
} from "@/server/webhooks/omnifi/rejeu";

/** Récapitulatif d'un lot de rejeu (retour de run, observabilité). */
export interface ResumeLot {
  examines: number;
  rejoues: number;
  dejaVus: number;
  enQuarantaine: number;
  /** Steps en échec d'INFRA (retries épuisés) — absorbés pour ne pas affamer le
   *  reste du lot ; l'événement reste en attente (replay_count intact). */
  echecsInfra: number;
}

/** `step` du SDK (le retour d'un `step.run` est `Jsonify<T>` — nos types de
 *  rejeu sont des scalaires JSON, la projection est neutre pour eux). */
export type StepRejeu = GetStepTools<typeof inngest>;

/**
 * Exporté pour le test unitaire (module `rejeu` mocké + step factice) — les
 * fonctions Inngest ci-dessous restent les seuls appelants de production.
 */
export async function rejouerLot(
  step: StepRejeu,
  omnifiConnectionId: string | undefined,
  requestId: string,
): Promise<ResumeLot> {
  const lignes = await step.run("lister-quarantaine", () =>
    listerQuarantainePourRejeu(omnifiConnectionId),
  );
  const resume: ResumeLot = {
    examines: lignes.length,
    rejoues: 0,
    dejaVus: 0,
    enQuarantaine: 0,
    echecsInfra: 0,
  };
  for (const ligne of lignes) {
    // Un step PAR événement : retry unitaire, id stable par EventId amont.
    // ⚠️ Constat C1 de la cross-review : un step qui ÉPUISE ses retries lève
    // `StepError` — sans ce catch, le run entier échoue et AFFAME les
    // événements FIFO suivants (et, côté cron, sautait la purge TTL avant
    // qu'elle ne soit déplacée en tête). On absorbe DONC l'échec d'infra par
    // événement : journalisé (error), l'événement reste en attente
    // (replay_count non incrémenté — ce n'est pas un constat « non
    // résolvable »), le balayage suivant retentera. Toute autre erreur
    // (défaut de code) remonte et fait échouer le run, visible au dashboard.
    try {
      const r = await step.run(`rejouer-${ligne.omnifiEventId}`, () =>
        rejouerEvenementQuarantaine(ligne, requestId),
      );
      if (r.issue === "REJOUE") resume.rejoues += 1;
      else if (r.issue === "DEJA_VU") resume.dejaVus += 1;
      else resume.enQuarantaine += 1;
    } catch (erreur) {
      if (!(erreur instanceof StepError)) throw erreur;
      resume.echecsInfra += 1;
      console.error(
        JSON.stringify({
          evt: "webhook_rejeu_step_echec",
          requestId,
          eventId: ligne.omnifiEventId,
          omnifiConnectionId: ligne.omnifiConnectionId,
          code: erreur.name,
        }),
      );
    }
  }
  return resume;
}

/** Rejeu CIBLÉ (link-exchange) — une connexion vient d'être créée. */
export const webhookReplay = inngest.createFunction(
  {
    id: "omnifi-webhook-replay",
    // Deux link-exchange rapprochés sur la même connexion se sérialisent (le
    // second lot sera vide : replayed_at posé par le premier).
    concurrency: [{ key: "event.data.omnifiConnectionId", limit: 1 }],
    retries: 3,
    triggers: [{ event: evenementWebhookReplay }],
  },
  async ({ event, step, runId }) => {
    // RE-validation à la réception (défense en profondeur, même règle que le
    // worker de sync : un événement peut être forgé depuis le dashboard).
    const donnees = donneesWebhookReplaySchema.parse(event.data);
    const resume = await rejouerLot(step, donnees.omnifiConnectionId, runId);
    console.info(
      JSON.stringify({
        evt: "webhook_rejeu_termine",
        declencheur: "LINK_EXCHANGE",
        omnifiConnectionId: donnees.omnifiConnectionId,
        ...resume,
      }),
    );
    return resume;
  },
);

/** FILET quotidien : balayage complet + purge TTL (log d'abandon). */
export const webhookReplayCron = inngest.createFunction(
  {
    id: "omnifi-webhook-replay-cron",
    retries: 3,
    triggers: [{ cron: "TZ=Indian/Mauritius 30 5 * * *" }],
  },
  async ({ step, runId }) => {
    // Purge AVANT le balayage (C1) : la rétention TTL ne doit jamais dépendre
    // du succès des rejeux du jour. Un événement expiré n'a de toute façon plus
    // droit à une tentative (30 j d'échecs derrière lui).
    const purge = await step.run("purger-ttl", () => purgerQuarantaine(Date.now()));
    const resume = await rejouerLot(step, undefined, runId);
    console.info(
      JSON.stringify({
        evt: "webhook_rejeu_termine",
        declencheur: "CRON",
        ...resume,
        ...purge,
      }),
    );
    return { ...resume, ...purge };
  },
);
