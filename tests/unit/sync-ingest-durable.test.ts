/**
 * Briques PURES du job durable `omnifi/sync.ingest.requested` (lot W1,
 * PLAN-ingestion-webhook-omnifi.md §6.2) — client Omni-FI factice, aucun
 * réseau, aucune DB. Le câblage Inngest (steps/sleep) est déclaratif et
 * s'éprouve au runtime ; la DÉCISION, elle, se prouve ici :
 *  - classifierStatutJob : union OUVERTE des statuts amont (leçon PR #202 —
 *    l'enum dérive : un statut inconnu se re-polle, jamais assimilé) ;
 *  - resoudreJobAmont : déclenchement gardé (cooldown, throttle-en-400,
 *    « sync already running ») — les mêmes voies que le chemin manuel, sans
 *    l'attente bornée.
 */
import { describe, expect, it, vi } from "vitest";

import { OmniFiApiError, type OmniFiClient } from "@/server/omnifi";
import {
  classifierStatutJob,
  resoudreJobAmont,
} from "@/server/inngest/fonctions/sync-ingest";

const CONNECTION_ID = "conn-w1";
const CLIENT_USER_ID = "enduser-w1";

describe("classifierStatutJob — union OUVERTE des statuts amont", () => {
  it("COMPLETED → TERMINAL_OK", () => {
    expect(classifierStatutJob({ Status: "COMPLETED" })).toEqual({
      categorie: "TERMINAL_OK",
    });
  });

  it("FAILED → TERMINAL_ECHEC avec le Type machine (jamais le Message)", () => {
    expect(
      classifierStatutJob({ Status: "FAILED", Error: { Type: "LOGIN_FAILED" } }),
    ).toEqual({ categorie: "TERMINAL_ECHEC", errorType: "LOGIN_FAILED" });
  });

  it("FAILED sans Error → errorType null (pas de crash)", () => {
    expect(classifierStatutJob({ Status: "FAILED" })).toEqual({
      categorie: "TERMINAL_ECHEC",
      errorType: null,
    });
  });

  it("OTP_REQUESTED et OTP_WAITING → MFA (réparation utilisateur, pas d'attente)", () => {
    expect(classifierStatutJob({ Status: "OTP_REQUESTED" })).toEqual({
      categorie: "MFA",
    });
    expect(classifierStatutJob({ Status: "OTP_WAITING" })).toEqual({
      categorie: "MFA",
    });
  });

  it("statut intermédiaire connu (RETRIEVING) → EN_COURS", () => {
    expect(classifierStatutJob({ Status: "RETRIEVING" })).toEqual({
      categorie: "EN_COURS",
      statut: "RETRIEVING",
    });
  });

  it("statut INCONNU de nos types (dérive amont) → EN_COURS, jamais assimilé à un terminal", () => {
    // Django dit SCRAPING là où l'API documente RETRIEVING (constat PR #202) :
    // un inconnu se re-polle jusqu'au plafond, qui le rend VISIBLE.
    expect(classifierStatutJob({ Status: "SCRAPING" })).toEqual({
      categorie: "EN_COURS",
      statut: "SCRAPING",
    });
  });
});

describe("resoudreJobAmont — déclenchement gardé (chemin sans omnifiJobId)", () => {
  it("cooldown amont FUTUR + dernier job encore en cours → ATTENDRE ce job (pas de déclenchement)", async () => {
    const futur = new Date(Date.now() + 600_000).toISOString();
    const declencherSync = vi.fn(); // ne doit PAS être appelé
    const getLatestSyncJob = vi
      .fn()
      .mockResolvedValue({ JobId: "job-en-cours", Status: "RETRIEVING" });
    const client = { declencherSync, getLatestSyncJob } as unknown as OmniFiClient;

    const r = await resoudreJobAmont(client, CONNECTION_ID, CLIENT_USER_ID, futur);

    expect(r).toEqual({ mode: "ATTENDRE", jobId: "job-en-cours" });
    expect(declencherSync).not.toHaveBeenCalled();
  });

  it("cooldown amont FUTUR + dernier job terminal → LIRE_SEULEMENT (les données du dernier sync sont fraîches)", async () => {
    const futur = new Date(Date.now() + 600_000).toISOString();
    const declencherSync = vi.fn();
    const getLatestSyncJob = vi
      .fn()
      .mockResolvedValue({ JobId: "job-fini", Status: "COMPLETED" });
    const client = { declencherSync, getLatestSyncJob } as unknown as OmniFiClient;

    const r = await resoudreJobAmont(client, CONNECTION_ID, CLIENT_USER_ID, futur);

    expect(r).toEqual({ mode: "LIRE_SEULEMENT", raison: "COOLDOWN" });
    expect(declencherSync).not.toHaveBeenCalled();
  });

  it("pas de cooldown → déclenche et ATTEND le job créé", async () => {
    const declencherSync = vi
      .fn()
      .mockResolvedValue({ JobId: "job-neuf", Status: "PENDING" });
    const client = { declencherSync } as unknown as OmniFiClient;

    const r = await resoudreJobAmont(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(r).toEqual({ mode: "ATTENDRE", jobId: "job-neuf" });
  });

  it("déclenchement OK mais sans JobId → LIRE_SEULEMENT (rien à attendre)", async () => {
    const declencherSync = vi.fn().mockResolvedValue({ Status: "PENDING" });
    const client = { declencherSync } as unknown as OmniFiClient;

    const r = await resoudreJobAmont(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(r).toEqual({ mode: "LIRE_SEULEMENT", raison: "SANS_JOB_ID" });
  });

  it("throttle amont (400 générique portant RATE_LIMIT_EXCEEDED) + job en cours → ATTENDRE ce job", async () => {
    // Le cas prod 2026-07-02 : status 400, obieCode inutile, code machine en details.
    const erreur = new OmniFiApiError(400, "400 BadRequest", [
      { errorCode: "RATE_LIMIT_EXCEEDED" },
    ]);
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    const getLatestSyncJob = vi
      .fn()
      .mockResolvedValue({ JobId: "job-course", Status: "IN_PROGRESS" });
    const client = { declencherSync, getLatestSyncJob } as unknown as OmniFiClient;

    const r = await resoudreJobAmont(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(r).toEqual({ mode: "ATTENDRE", jobId: "job-course" });
  });

  it("400 « sync already running » + dernier job DÉJÀ terminal → LIRE_SEULEMENT (jamais un faux DECLENCHE)", async () => {
    const erreur = new OmniFiApiError(
      400,
      "400 BadRequest",
      [{ errorCode: "BAD_REQUEST" }],
      null,
      true, // conflitSyncEnCours
    );
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    const getLatestSyncJob = vi
      .fn()
      .mockResolvedValue({ JobId: "vieux-job", Status: "COMPLETED" });
    const client = { declencherSync, getLatestSyncJob } as unknown as OmniFiClient;

    const r = await resoudreJobAmont(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(r).toEqual({ mode: "LIRE_SEULEMENT", raison: "JOB_DEJA_TERMINE" });
  });

  it("400 d'une AUTRE cause → remonte (le retry de step Inngest gère, jamais avalé)", async () => {
    const erreur = new OmniFiApiError(400, "400 BadRequest", [
      { errorCode: "INVALID_PARAMETER" },
    ]);
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    const client = { declencherSync } as unknown as OmniFiClient;

    await expect(
      resoudreJobAmont(client, CONNECTION_ID, CLIENT_USER_ID, null),
    ).rejects.toBe(erreur);
  });
});
