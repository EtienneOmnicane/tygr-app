/**
 * Rate-limit étage 1 (§4.1) — seau glissant EN MÉMOIRE du process, par IP, AVANT le
 * HMAC. POURQUOI pas en base : compter en table (patron `login_attempts`) écrirait une
 * ligne par requête NON signée = AMPLIFICATION de DoS. L'invariant « aucun écrit DB
 * avant signature valide » est aussi une propriété anti-DoS.
 *
 * LIMITE ASSUMÉE : sur multi-instances, ce compteur est PAR INSTANCE (approximatif). Ce
 * n'est PAS le contrôle d'accès (c'est l'HMAC) — il ne borne QUE le coût. Ne jamais le
 * présenter comme une garantie.
 *
 * ⚠️ IP source : `extraireIp` prend la valeur la PLUS À GAUCHE de x-forwarded-for. Selon
 * la plateforme, un attaquant peut PRÉPENDRE un XFF factice et faire tourner l'« IP » à
 * chaque requête (le rate-limit par IP devient contournable). C'est toléré ICI parce que
 * ce n'est PAS le contrôle d'accès (HMAC) et parce que la mémoire est BORNÉE (ci-dessous)
 * — un XFF rotatif ne fait donc plus qu'épuiser un plafond de buckets qu'on balaie. Une
 * IP fiable derrière un proxy de confiance dépend de la config edge (dette
 * WEBHOOK-RL-XFF, TODOS).
 */
import { extraireIp } from "@/server/auth/rate-limit-ip";

import { WebhookTropDeRequetesError } from "./erreurs";

/** Fenêtre glissante et plafond (§4.1) : 60 requêtes / IP / minute. */
export const FENETRE_RL_MS = 60_000;
export const MAX_PAR_IP = 60;
/**
 * Plafond de buckets AVANT balayage — borne la mémoire (constat cross-review W4 C1 : un
 * XFF rotatif créait des buckets JAMAIS libérés = DoS mémoire). Au-delà, on retire les
 * buckets entièrement périmés (dernier timestamp hors fenêtre). La mémoire reste ainsi
 * bornée au nombre d'IP ACTIVES dans la fenêtre glissante (les IP factices d'un flood
 * deviennent périmées après 60 s et sont balayées).
 */
export const MAX_BUCKETS = 10_000;

/** État du limiteur : timestamps (ms) des requêtes récentes par IP. */
export type SeauxRateLimit = Map<string, number[]>;

/** Fabrique un état neuf (les tests en créent un isolé ; la route en tient un singleton). */
export function creerSeaux(): SeauxRateLimit {
  return new Map();
}

/** Retire les buckets entièrement PÉRIMÉS (dernier timestamp hors fenêtre). Borne mémoire. */
function balayerPerimes(seaux: SeauxRateLimit, debut: number): void {
  for (const [cle, ts] of seaux) {
    if (ts.length === 0 || ts[ts.length - 1] <= debut) {
      seaux.delete(cle);
    }
  }
}

/**
 * Enregistre la requête de cette IP et lève `WebhookTropDeRequetesError` (429) si le
 * plafond est dépassé sur la fenêtre glissante. Élague les timestamps hors fenêtre à
 * chaque appel (pas de croissance non bornée pour une IP donnée) et BALAIE les buckets
 * périmés quand la Map enfle (borne mémoire, C1). IP absente → bucket commun
 * `"ip-inconnue"` (jamais une EXEMPTION). La 61ᵉ requête d'une même IP dans la minute
 * est refusée (60 passent).
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
  // Éviction bornée : ne coûte rien tant que la Map reste petite (trafic légitime faible).
  if (seaux.size > MAX_BUCKETS) {
    balayerPerimes(seaux, debut);
  }
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
