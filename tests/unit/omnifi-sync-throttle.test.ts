/**
 * `declencherEtAttendre` (orchestration.ts) — classification du THROTTLE amont
 * (« 1 sync / 15 min »), avec un client factice (aucun réseau).
 *
 * Régression du 2026-07-02 : le re-sync manuel de d23196 n'écrivait RIEN. Cause : Omni-FI
 * renvoie le throttle sous forme d'un **400 générique** (`obieCode` = « 400 BadRequest »)
 * dont l'enveloppe OBIE porte pourtant `Errors[].ErrorCode = "RATE_LIMIT_EXCEEDED"`.
 * L'ancien code ne matchait que `estRateLimit` (HTTP 429) et `estSyncDejaEnCours(obieCode)`
 * → ce 400 tombait sur le `throw` final → échec DUR → connexion abandonnée,
 * `marquerSynchronise` jamais atteint. Le fix classe ce cas en RATE_LIMITED (soft).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { declencherEtAttendre } from "@/server/widget/orchestration";
import { OmniFiApiError } from "@/server/omnifi";
import type { OmniFiClient } from "@/server/omnifi";

const CLIENT_USER_ID = "enduser-1";
const CONNECTION_ID = "conn-d23196";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("declencherEtAttendre — throttle amont", () => {
  it("400 générique portant RATE_LIMIT_EXCEEDED → RATE_LIMITED (soft), pas de throw", async () => {
    // Le cas EXACT observé en prod : status 400, obieCode inutile, code machine dans details.
    const erreur = new OmniFiApiError(400, "400 BadRequest", [
      { errorCode: "RATE_LIMIT_EXCEEDED" },
    ]);
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    // Fallback nextSyncDepuisLatest (retryAfterSeconds absent sur un 400).
    const getLatestSyncJob = vi
      .fn()
      .mockResolvedValue({ JobId: "job-1", NextSyncAvailableAt: "2026-07-02T07:00:00.000Z" });
    const client = { declencherSync, getLatestSyncJob } as unknown as OmniFiClient;

    const issue = await declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(issue).toEqual({ kind: "RATE_LIMITED", nextSyncAt: "2026-07-02T07:00:00.000Z" });
    // On n'a PAS re-déclenché ni poll de job : juste lu le délai.
    expect(declencherSync).toHaveBeenCalledTimes(1);
  });

  it("429 avec retryAfterSeconds → RATE_LIMITED, nextSyncAt déduit du retry-after (sans relire latest-job)", async () => {
    const erreur = new OmniFiApiError(429, "TOO_MANY_REQUESTS", [], 278);
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    const getLatestSyncJob = vi.fn(); // ne doit PAS être appelé
    const client = { declencherSync, getLatestSyncJob } as unknown as OmniFiClient;

    const avant = Date.now();
    const issue = await declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(issue.kind).toBe("RATE_LIMITED");
    if (issue.kind === "RATE_LIMITED") {
      expect(issue.nextSyncAt).not.toBeNull();
      const delta = Date.parse(issue.nextSyncAt as string) - avant;
      // ~278s dans le futur (tolérance large pour l'exécution du test).
      expect(delta).toBeGreaterThanOrEqual(277_000);
      expect(delta).toBeLessThanOrEqual(279_000);
    }
    expect(getLatestSyncJob).not.toHaveBeenCalled();
  });

  it("cooldown AMONT (NextSyncAvailableAt futur) → RATE_LIMITED sans même appeler declencherSync", async () => {
    const futur = new Date(Date.now() + 600_000).toISOString();
    const declencherSync = vi.fn(); // ne doit PAS être appelé
    const client = { declencherSync } as unknown as OmniFiClient;

    const issue = await declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, futur);

    expect(issue).toEqual({ kind: "RATE_LIMITED", nextSyncAt: futur });
    expect(declencherSync).not.toHaveBeenCalled();
  });

  it("400 d'une AUTRE cause (pas RATE_LIMIT_EXCEEDED) → reste un échec DUR (throw)", async () => {
    // Garde-fou : le fix ne doit PAS avaler tous les 400. Un 400 hors throttle/already-running
    // doit toujours remonter (fail-soft géré plus haut par connexion).
    const erreur = new OmniFiApiError(400, "400 BadRequest", [{ errorCode: "INVALID_PARAMETER" }]);
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    const client = { declencherSync } as unknown as OmniFiClient;

    await expect(
      declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null),
    ).rejects.toBe(erreur);
  });
});

describe("declencherEtAttendre — conflit « sync already running »", () => {
  it("400 conflitSyncEnCours → POLL le job en cours jusqu'à COMPLETED → DECLENCHE (pas de throw)", async () => {
    // Régression prod 2026-07-03 : un job de scrape tourne encore (reconnexion widget) et
    // Omni-FI répond 400 « Sync already running: <id> ». Ce 400 est classé au bord client en
    // conflitSyncEnCours=true → declencherEtAttendre doit aller POLLER le job en cours au lieu
    // d'abandonner la connexion en échec dur (ce qui jetait le scrape qui peuple les données).
    const erreur = new OmniFiApiError(400, "400 BadRequest", [{ errorCode: "BAD_REQUEST" }], null, true);
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    const getLatestSyncJob = vi.fn().mockResolvedValue({ JobId: "job-en-cours", Status: "IN_PROGRESS" });
    // attendreFinSync poll via getSyncJobServeur ; 1er tour SANS sleep → COMPLETED immédiat.
    const getSyncJobServeur = vi.fn().mockResolvedValue({
      JobId: "job-en-cours",
      Status: "COMPLETED",
      PersistenceStats: { TransactionsCreated: 3, TransactionsUpdated: 0, TransactionsDuplicated: 0 },
    });
    const client = { declencherSync, getLatestSyncJob, getSyncJobServeur } as unknown as OmniFiClient;

    const issue = await declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null);

    // On a pris la branche « already running » : lu le job en cours puis pollé jusqu'à COMPLETED.
    expect(getLatestSyncJob).toHaveBeenCalledTimes(1);
    expect(getSyncJobServeur).toHaveBeenCalledWith("job-en-cours", CLIENT_USER_ID);
    // On N'a PAS re-déclenché un nouveau sync (un seul appel, celui qui a échoué)…
    expect(declencherSync).toHaveBeenCalledTimes(1);
    // …et le job en cours est mené à terme → la lecture peut suivre (DECLENCHE, pas un throw).
    expect(issue).toEqual({ kind: "DECLENCHE" });
  });

  it("400 conflitSyncEnCours mais latest-job déjà TERMINAL → SKIP_FAILED (STALE_LATEST_JOB), pas de throw", async () => {
    // Défense en profondeur : si le « dernier job » est un vieux COMPLETED, ce n'est pas un
    // sync EN COURS → on ne conclut pas DECLENCHE à tort, on compte un échec doux.
    const erreur = new OmniFiApiError(400, "400 BadRequest", [{ errorCode: "BAD_REQUEST" }], null, true);
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    const getLatestSyncJob = vi.fn().mockResolvedValue({ JobId: "vieux-job", Status: "COMPLETED" });
    const client = { declencherSync, getLatestSyncJob } as unknown as OmniFiClient;

    const issue = await declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null);

    expect(issue).toEqual({ kind: "SKIP_FAILED", errorType: "STALE_LATEST_JOB" });
    expect(getLatestSyncJob).toHaveBeenCalledTimes(1);
  });

  it("400 SANS conflitSyncEnCours (false) → reste un échec DUR (throw), ne poll pas latest-job", async () => {
    // Contrôle : le flag pilote seul la branche. Un 400 conflitSyncEnCours=false ne doit
    // JAMAIS aller poller le dernier job (sinon faux positif « sync effectué »).
    const erreur = new OmniFiApiError(400, "400 BadRequest", [{ errorCode: "BAD_REQUEST" }], null, false);
    const declencherSync = vi.fn().mockRejectedValue(erreur);
    const getLatestSyncJob = vi.fn(); // ne doit PAS être appelé
    const client = { declencherSync, getLatestSyncJob } as unknown as OmniFiClient;

    await expect(
      declencherEtAttendre(client, CONNECTION_ID, CLIENT_USER_ID, null),
    ).rejects.toBe(erreur);
    expect(getLatestSyncJob).not.toHaveBeenCalled();
  });
});
