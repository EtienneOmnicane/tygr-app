/**
 * Route webhook Omni-FI — `POST /api/webhooks/omnifi`. COQUILLE DE TRANSPORT (§8) :
 * aucun accès DB ici. Toute la logique (garde de taille, HMAC, fraîcheur, résolution
 * tenant, enqueue, audit, quarantaine) vit dans `src/server/webhooks/omnifi/`. Route
 * HORS session (exclue du matcher de src/proxy.ts) : son AUTH est l'HMAC.
 */
import { traiterRequeteWebhook } from "@/server/webhooks/omnifi/route-handler";

// node:crypto (HMAC) + driver DB WebSocket (résolution/quarantaine) ⇒ runtime Node,
// JAMAIS Edge (§8.3). Route dynamique : jamais mise en cache ni pré-rendue.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Seul POST est exporté ⇒ toute autre méthode → 405 (Next). */
export function POST(request: Request): Promise<Response> {
  return traiterRequeteWebhook(request);
}
