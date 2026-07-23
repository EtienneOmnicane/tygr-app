/**
 * Rate-limit étage 1 (§4.1) — seau glissant EN MÉMOIRE du process, par IP, AVANT le
 * HMAC. POURQUOI pas en base : compter en table (patron `login_attempts`) écrirait une
 * ligne par requête NON signée = AMPLIFICATION de DoS. L'invariant « aucun écrit DB
 * avant signature valide » est aussi une propriété anti-DoS.
 *
 * LIMITE ASSUMÉE : sur multi-instances, ce compteur est PAR INSTANCE (approximatif). Ce
 * n'est PAS le contrôle d'accès (c'est l'HMAC) — il ne borne QUE le coût. Ne jamais le
 * présenter comme une garantie.
 */
import { extraireIp } from "@/server/auth/rate-limit-ip";

import { WebhookTropDeRequetesError } from "./erreurs";

/** Fenêtre glissante et plafond (§4.1) : 60 requêtes / IP / minute. */
export const FENETRE_RL_MS = 60_000;
export const MAX_PAR_IP = 60;

/** État du limiteur : timestamps (ms) des requêtes récentes par IP. */
export type SeauxRateLimit = Map<string, number[]>;

/** Fabrique un état neuf (les tests en créent un isolé ; la route en tient un singleton). */
export function creerSeaux(): SeauxRateLimit {
  return new Map();
}

/**
 * Enregistre la requête de cette IP et lève `WebhookTropDeRequetesError` (429) si le
 * plafond est dépassé sur la fenêtre glissante. Élague les timestamps hors fenêtre à
 * chaque appel (pas de croissance non bornée pour une IP donnée). IP absente → bucket
 * commun `"ip-inconnue"` (jamais une EXEMPTION). La 61ᵉ requête d'une même IP dans la
 * minute est refusée (60 passent).
 */
export function verifierRateLimit(
  seaux: SeauxRateLimit,
  xForwardedFor: string | null,
  maintenantMs: number,
): void {
  const ip = extraireIp(xForwardedFor);
  const debut = maintenantMs - FENETRE_RL_MS;
  const recents = (seaux.get(ip) ?? []).filter((t) => t > debut);
  recents.push(maintenantMs);
  seaux.set(ip, recents);
  if (recents.length > MAX_PAR_IP) {
    // Retry-After = délai jusqu'à ce que la plus ancienne requête sorte de la fenêtre.
    const plusAncien = recents[0];
    const retrySec = Math.max(
      1,
      Math.ceil((plusAncien + FENETRE_RL_MS - maintenantMs) / 1000),
    );
    throw new WebhookTropDeRequetesError(retrySec);
  }
}
