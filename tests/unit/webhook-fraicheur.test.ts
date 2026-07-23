/**
 * Fenêtre anti-replay / fraîcheur (§10.1 cas 3). Fenêtre 12 h (≤ idempotence Inngest
 * 24 h) + dérive future 5 min. Instants UTC, aucune conversion Maurice.
 */
import { describe, expect, it } from "vitest";

import { WebhookHorsFenetreError } from "@/server/webhooks/omnifi/erreurs";
import {
  DERIVE_FUTUR_MS,
  FENETRE_FRAICHEUR_MS,
  verifierFraicheur,
} from "@/server/webhooks/omnifi/fraicheur";

const NOW = Date.parse("2026-07-23T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("verifierFraicheur", () => {
  it("accepte un Timestamp dans la fenêtre (−11 h)", () => {
    expect(() =>
      verifierFraicheur(iso(NOW - 11 * 3600_000), NOW),
    ).not.toThrow();
  });

  it("rejette un rejeu trop ancien (au-delà de 12 h)", () => {
    expect(() =>
      verifierFraicheur(iso(NOW - FENETRE_FRAICHEUR_MS - 60_000), NOW),
    ).toThrow(WebhookHorsFenetreError);
  });

  it("accepte une petite dérive future (< 5 min)", () => {
    expect(() => verifierFraicheur(iso(NOW + 2 * 60_000), NOW)).not.toThrow();
  });

  it("rejette un futur au-delà de la dérive (+6 min)", () => {
    expect(() =>
      verifierFraicheur(iso(NOW + DERIVE_FUTUR_MS + 60_000), NOW),
    ).toThrow(WebhookHorsFenetreError);
  });

  it("rejette un Timestamp absent / non ISO (fail-closed)", () => {
    expect(() => verifierFraicheur("pas-une-date", NOW)).toThrow(
      WebhookHorsFenetreError,
    );
    expect(() => verifierFraicheur("", NOW)).toThrow(WebhookHorsFenetreError);
  });

  it("borne : la limite exacte de la fenêtre est acceptée", () => {
    expect(() =>
      verifierFraicheur(iso(NOW - FENETRE_FRAICHEUR_MS), NOW),
    ).not.toThrow();
  });
});
