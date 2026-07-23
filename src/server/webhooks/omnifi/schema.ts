/**
 * Validation zod STRICTE du corps webhook Omni-FI (règle 3). Spec : §3.5.
 *
 * Contrat amont (docs/documentation_api.md, § Webhooks) :
 *   { EventId, EventType, ConnectionId, JobId?, Timestamp, Payload{} }
 *
 * Deux choix EXPLICITES :
 *  - `ConnectionId` n'est PAS `.uuid()` : la doc le dit uuid, mais la colonne est
 *    varchar(64) — se caler sur le TYPE de colonne évite un rejet de MASSE si l'amont
 *    dérive (même leçon que l'union ouverte d'EventType) ;
 *  - `Payload` n'est consommé par AUCUNE logique au MVP : stocké tel quel en quarantaine,
 *    filtré par liste blanche avant d'entrer dans `audit_events` (§7.3). Borné par la
 *    limite de 64 Ko du corps (§3.1), pas par le schéma.
 *
 * `.strict()` sur l'objet racine : une clé inconnue fait ÉCHOUER (400), jamais un
 * `.passthrough()` silencieux.
 */
import { z } from "zod";

import { WebhookPayloadInvalideError } from "./erreurs";

export const payloadWebhookSchema = z
  .object({
    EventId: z.string().uuid(),
    // Union OUVERTE (« tous les scrapers n'émettent pas chaque événement »), jamais un
    // enum fermé qui rejetterait un EventType légitime non anticipé.
    EventType: z.string().trim().min(1).max(60),
    // Ancrage sur le TYPE de colonne (varchar 64), pas sur .uuid() (résilience > rigidité).
    ConnectionId: z.string().trim().min(1).max(64),
    JobId: z.string().trim().min(1).max(64).nullable().optional(),
    // Instant ISO 8601 AVEC offset (ou `Z`) — refuse un datetime « nu » ambigu. La
    // fenêtre de fraîcheur (§3.4) le re-parse en instant UTC.
    Timestamp: z.string().datetime({ offset: true }),
    Payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type PayloadWebhook = z.infer<typeof payloadWebhookSchema>;

/**
 * Parse le corps déjà décodé en UTF-8 (objet JSON). Lève `WebhookPayloadInvalideError`
 * (400) si non conforme — jamais d'écho du contenu (§2.2), le détail vit dans le log.
 */
export function parserPayloadWebhook(brut: unknown): PayloadWebhook {
  const r = payloadWebhookSchema.safeParse(brut);
  if (!r.success) {
    throw new WebhookPayloadInvalideError();
  }
  return r.data;
}
