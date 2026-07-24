/**
 * Cron quotidien du FILET PULL (lot W2, PLAN-ingestion-webhook-omnifi.md §6.2/§9,
 * décision D1=C) — 06:00 heure de Maurice, fuseau EXPLICITE dans l'expression
 * cron (`TZ=Indian/Mauritius` — les timestamps restent UTC en base, E20).
 *
 * Rôle : SANS lui, le webhook n'a aucun filet — un événement jamais reçu
 * (enqueue amont raté, secret en rotation, déploiement) ne se rattrape que par
 * un clic manuel. Le cron émet, pour CHAQUE connexion active de CHAQUE
 * workspace de l'environnement courant, le MÊME événement
 * `omnifi/sync.ingest.requested` que le clic manuel et le webhook (convergence
 * D1=C : un seul worker, aucune logique dupliquée). Le worker respecte le
 * cooldown amont (`NextSyncAvailableAt`) et le rate-limit 1/15 min : un scrape
 * déjà frais dégrade en lecture idempotente, jamais en martèlement.
 *
 * Idempotence : `cleIdempotence = cron:${workspaceId}:${omnifiConnectionId}:${dateDuRun}`
 * (convention client.ts) — la DATE COMPTABLE MAURICE du run (aujourdhuiMaurice,
 * source unique src/lib/periode.ts), calculée dans un STEP (mémoïsée : un retry
 * qui franchirait minuit garde la clé du run initial). Deux fires du même jour
 * collapsent ; le fire du lendemain repart. ⚠️ La clé porte le WORKSPACE
 * (constat M1 de la cross-review W2) : l'unicité GLOBALE d'omnifi_connection_id
 * est une hypothèse ABANDONNÉE (schema.ts, EXPAND 0018 → CONTRACT à venir) —
 * sans le scope tenant, deux workspaces partageant un ConnectionId amont
 * verraient leurs filets quotidiens collapser en UN run (perte silencieuse).
 *
 * Tenancy : énumération des workspaces par `listerWorkspacesParEnvironnement`
 * (systeme.ts — id seul, filtré par env, sans RLS car `workspaces` n'en a pas),
 * puis les connexions de CHAQUE workspace sous SA RLS via la primitive système.
 * JAMAIS `tygr_service` (usage gelé à la résolution webhook, règle 2).
 */
import { StepError } from "inngest";
import { eq } from "drizzle-orm";

import { bankConnections } from "@/server/db/schema";
import {
  executerPourWorkspaceSysteme,
  listerWorkspacesParEnvironnement,
} from "@/server/db/systeme";
import {
  evenementSyncIngest,
  inngest,
  type DonneesSyncIngest,
} from "@/server/inngest/client";
// Source UNIQUE de l'env du déploiement (« production » SSI OMNIFI_ENV vaut
// exactement cela) — helper extrait par W5, partagé avec la route webhook.
// deps-communes n'importe PAS le client de service : FRONTIERE_SERVICE respectée.
import { envDeploiement } from "@/server/webhooks/omnifi/deps-communes";
import { aujourdhuiMaurice } from "@/lib/periode";

/** Paire (workspace, connexion amont) à synchroniser. */
export interface ConnexionASynchroniser {
  workspaceId: string;
  omnifiConnectionId: string;
}

/**
 * Construit les événements du run — fonction PURE (testée unitairement).
 * `omnifiJobId` ABSENT : le worker déclenche lui-même le scrape (chemin cron,
 * gardé par le cooldown amont — sync-ingest.ts `resoudreJobAmont`).
 */
export function construireEvenementsCron(
  connexions: readonly ConnexionASynchroniser[],
  dateDuRun: string,
): DonneesSyncIngest[] {
  // Clé SCOPÉE TENANT (M1) : omnifi_connection_id n'est pas garanti unique
  // entre workspaces (hypothèse abandonnée — EXPAND 0018) ; le workspaceId
  // dans la clé garantit qu'aucun tenant ne perd son filet par collapse.
  return connexions.map((c) => ({
    workspaceId: c.workspaceId,
    omnifiConnectionId: c.omnifiConnectionId,
    declencheur: "CRON" as const,
    cleIdempotence: `cron:${c.workspaceId}:${c.omnifiConnectionId}:${dateDuRun}`,
  }));
}

/** Connexions ACTIVES d'un workspace, sous SA RLS (id amont seul). */
async function listerConnexionsActives(
  workspaceId: string,
): Promise<ConnexionASynchroniser[]> {
  const lignes = await executerPourWorkspaceSysteme(workspaceId)((tx) =>
    tx
      .select({ omnifiConnectionId: bankConnections.omnifiConnectionId })
      .from(bankConnections)
      .where(eq(bankConnections.status, "active")),
  );
  return lignes.map((l) => ({
    workspaceId,
    omnifiConnectionId: l.omnifiConnectionId,
  }));
}

export const syncCron = inngest.createFunction(
  {
    id: "omnifi-sync-cron",
    retries: 3,
    triggers: [{ cron: "TZ=Indian/Mauritius 0 6 * * *" }],
  },
  async ({ step }) => {
    const env = envDeploiement();

    // Date comptable Maurice du run — dans un STEP : mémoïsée, un retry qui
    // franchirait minuit garde la clé d'idempotence du run initial.
    const dateDuRun = await step.run("date-du-run", async () =>
      aujourdhuiMaurice(),
    );

    const workspaces = await step.run("lister-workspaces", () =>
      listerWorkspacesParEnvironnement(env),
    );

    // Un step de LISTING + un step d'ÉMISSION par workspace, au fil de l'eau :
    // chaque tenant est servi dès son listing — un workspace qui épuise ses
    // retries (`StepError`) est ABSORBÉ (journalisé error, compté) et ne prive
    // pas les SUIVANTS de leur filet (constat m2 de la cross-review W2, même
    // patron que le rejeu W5). Toute autre erreur (défaut de code) remonte.
    let connexionsServies = 0;
    let workspacesEnEchec = 0;
    for (const ws of workspaces) {
      try {
        const duWorkspace = await step.run(`lister-connexions-${ws.id}`, () =>
          listerConnexionsActives(ws.id),
        );
        const evenements = construireEvenementsCron(duWorkspace, dateDuRun);
        if (evenements.length > 0) {
          // step.sendEvent : émission DURABLE (mémoïsée) — un retry du run ne
          // double pas les envois, et la cleIdempotence collapse tout résidu.
          // `create()` sans `validate()` : le schéma est prouvé par le test
          // unitaire de construireEvenementsCron ET re-parsé par le worker.
          await step.sendEvent(
            `emettre-syncs-${ws.id}`,
            evenements.map((d) => evenementSyncIngest.create(d)),
          );
        }
        connexionsServies += evenements.length;
      } catch (erreur) {
        if (!(erreur instanceof StepError)) throw erreur;
        workspacesEnEchec += 1;
        console.error(
          JSON.stringify({
            evt: "sync_cron_workspace_echec",
            workspaceId: ws.id,
            code: erreur.name,
          }),
        );
      }
    }

    console.info(
      JSON.stringify({
        evt: "sync_cron_termine",
        environnement: env,
        dateDuRun,
        workspaces: workspaces.length,
        workspacesEnEchec,
        connexions: connexionsServies,
      }),
    );
    return {
      dateDuRun,
      workspaces: workspaces.length,
      workspacesEnEchec,
      connexions: connexionsServies,
    };
  },
);
