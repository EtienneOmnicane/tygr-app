/**
 * Vérification HMAC-SHA256 du webhook Omni-FI (§3). Sur les OCTETS BRUTS, jamais un
 * JSON re-sérialisé (un `JSON.parse`→`stringify` change les octets et casse la
 * signature). Comparaison constant-time. Le secret n'apparaît JAMAIS dans un log ni un
 * message d'erreur (règle 8).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { WebhookSignatureInvalideError } from "./erreurs";

/** En-tête portant la signature hex (contrat amont). */
export const ENTETE_SIGNATURE = "x-omnifi-signature";

/** HMAC-SHA256 hex = 64 caractères hexadécimaux. */
const HEX_64 = /^[0-9a-fA-F]{64}$/;

export type EnvOmniFi = "sandbox" | "production";

/**
 * Sélectionne le secret webhook correspondant à l'ENV du déploiement — UN SEUL secret
 * par déploiement (§3.3). Un événement signé avec le secret de l'AUTRE environnement
 * échouera naturellement au 401 (fail-closed par construction, aucune logique
 * d'aiguillage). `null`/chaîne vide → l'appelant lève `WebhookNonConfigureError` (503).
 */
export function selectionnerSecretWebhook(
  env: EnvOmniFi,
  secrets: { sandbox?: string | null; production?: string | null },
): string | null {
  const s = env === "production" ? secrets.production : secrets.sandbox;
  return s && s.trim() !== "" ? s : null;
}

/**
 * Normalise l'en-tête de signature : retire un préfixe `sha256=` TOLÉRÉ (défense — le
 * contrat dit « hex nu » mais c'est la variante la plus courante), puis valide hex 64.
 * Rend la signature en minuscules, ou `null` si absente/mal formée (l'appelant lève 401
 * SANS toucher à la crypto — la longueur d'un HMAC est publique, aucune fuite).
 */
export function normaliserSignature(entete: string | null | undefined): string | null {
  if (!entete) return null;
  const sansPrefixe = entete.startsWith("sha256=") ? entete.slice(7) : entete;
  return HEX_64.test(sansPrefixe) ? sansPrefixe.toLowerCase() : null;
}

/**
 * Vérifie l'HMAC sur les octets bruts et rend la signature NORMALISÉE (pour l'audit
 * tronqué). Lève `WebhookSignatureInvalideError` (401) si l'en-tête est absent, mal
 * formé, ou ne matche pas. `timingSafeEqual` n'est appelé que sur des buffers de MÊME
 * longueur (garantie par la validation hex 64 des DEUX côtés).
 */
export function verifierHmac(
  octets: Buffer,
  enteteSignature: string | null | undefined,
  secret: string,
): string {
  const recu = normaliserSignature(enteteSignature);
  if (recu === null) {
    // Absent ou mal formé : 401 immédiat, PAS de timingSafeEqual (lève sur longueurs
    // inégales) et pas même de calcul HMAC nécessaire.
    throw new WebhookSignatureInvalideError();
  }
  const attendu = createHmac("sha256", secret).update(octets).digest("hex");
  const a = Buffer.from(attendu, "hex");
  const b = Buffer.from(recu, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookSignatureInvalideError();
  }
  return recu;
}

/** 8 premiers hexa d'une signature normalisée — trace NON rejouable pour l'audit (§7.3). */
export function tronquerSignature(signatureNormalisee: string): string {
  return signatureNormalisee.slice(0, 8);
}
