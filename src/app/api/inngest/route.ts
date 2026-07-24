/**
 * Route d'exécution Inngest (lot W1, PLAN-ingestion-webhook-omnifi.md §6/§9).
 * C'est ICI que les fonctions durables s'exécutent : le serveur Inngest (cloud
 * ou dev server local) appelle cette route pour dérouler chaque step — le job
 * tourne donc dans le runtime Next standard (Node, jamais Edge : la DB
 * WebSocket et le client Omni-FI l'exigent).
 *
 * SÉCURITÉ — route volontairement HORS session (exclue du matcher de
 * src/proxy.ts) : son authentification est la SIGNATURE Inngest. En mode cloud,
 * `serve` vérifie chaque requête contre INNGEST_SIGNING_KEY et refuse de servir
 * sans elle (fail-closed) ; le mode dev non signé n'existe qu'avec le dev
 * server local. Aucun corps de requête n'est interprété hors du SDK, aucune
 * donnée détaillée n'est exposée au GET (introspection minimale non
 * authentifiée). Clés : env vars uniquement (règle 8), jamais loggées.
 */
import { serve } from "inngest/next";

import { inngest } from "@/server/inngest/client";
import { healthcheck } from "@/server/inngest/fonctions/healthcheck";
import { syncCron } from "@/server/inngest/fonctions/sync-cron";
import { syncIngest } from "@/server/inngest/fonctions/sync-ingest";
import {
  webhookReplay,
  webhookReplayCron,
} from "@/server/inngest/fonctions/webhook-replay";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [healthcheck, syncIngest, syncCron, webhookReplay, webhookReplayCron],
});
