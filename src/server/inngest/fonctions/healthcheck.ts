/**
 * Healthcheck du socle Inngest (lot W1, plan §9) : prouve l'enregistrement et
 * l'exécution de bout en bout (émission → serveur Inngest → /api/inngest →
 * run) sans toucher ni à la base ni à l'amont. Déclenchable depuis le
 * dashboard Inngest (dev : http://localhost:8288) pour vérifier un
 * environnement.
 */
import { evenementHealthcheck, inngest } from "@/server/inngest/client";

export const healthcheck = inngest.createFunction(
  {
    id: "tygr-healthcheck",
    retries: 0,
    triggers: [{ event: evenementHealthcheck }],
  },
  async ({ event }) => {
    // Log structuré, cohérent avec le reste du serveur (JSON, zéro PII).
    console.info(
      JSON.stringify({
        evt: "inngest_healthcheck",
        motif: event.data.motif ?? null,
      }),
    );
    return { ok: true };
  },
);
