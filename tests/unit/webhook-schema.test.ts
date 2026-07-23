/**
 * Validation zod stricte du corps webhook (§3.5). Union ouverte pour EventType,
 * ConnectionId non-uuid (calé sur la colonne varchar 64), .strict() sur la racine.
 */
import { describe, expect, it } from "vitest";

import { WebhookPayloadInvalideError } from "@/server/webhooks/omnifi/erreurs";
import { parserPayloadWebhook } from "@/server/webhooks/omnifi/schema";

const base = {
  EventId: "11111111-1111-4111-8111-111111111111",
  EventType: "sync.completed",
  ConnectionId: "omni-conn-42",
  Timestamp: "2026-07-23T10:00:00+04:00",
};

describe("parserPayloadWebhook", () => {
  it("chemin heureux : payload conforme → parsé, Payload défaut {}", () => {
    const p = parserPayloadWebhook(base);
    expect(p.EventId).toBe(base.EventId);
    expect(p.Payload).toEqual({});
  });

  it("EventType est une union OUVERTE (une valeur non anticipée passe)", () => {
    const p = parserPayloadWebhook({ ...base, EventType: "sync.something_new" });
    expect(p.EventType).toBe("sync.something_new");
  });

  it("ConnectionId n'est PAS validé en uuid (varchar 64) — une valeur non-uuid passe", () => {
    expect(() =>
      parserPayloadWebhook({ ...base, ConnectionId: "conn_ABC-123" }),
    ).not.toThrow();
  });

  it("JobId optionnel/nullable", () => {
    expect(() => parserPayloadWebhook({ ...base, JobId: "job-1" })).not.toThrow();
    expect(() => parserPayloadWebhook({ ...base, JobId: null })).not.toThrow();
  });

  it("champ requis manquant (EventId) → WebhookPayloadInvalideError", () => {
    const sansEventId = {
      EventType: base.EventType,
      ConnectionId: base.ConnectionId,
      Timestamp: base.Timestamp,
    };
    expect(() => parserPayloadWebhook(sansEventId)).toThrow(
      WebhookPayloadInvalideError,
    );
  });

  it("EventId non-uuid → rejet", () => {
    expect(() => parserPayloadWebhook({ ...base, EventId: "pas-un-uuid" })).toThrow(
      WebhookPayloadInvalideError,
    );
  });

  it("clé inconnue (.strict) → rejet", () => {
    expect(() => parserPayloadWebhook({ ...base, Injecte: "x" })).toThrow(
      WebhookPayloadInvalideError,
    );
  });

  it("Timestamp non ISO / sans offset → rejet", () => {
    expect(() =>
      parserPayloadWebhook({ ...base, Timestamp: "2026-07-23 10:00" }),
    ).toThrow(WebhookPayloadInvalideError);
    expect(() =>
      parserPayloadWebhook({ ...base, Timestamp: "2026-07-23T10:00:00" }),
    ).toThrow(WebhookPayloadInvalideError);
  });
});
