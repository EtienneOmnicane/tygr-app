/**
 * `attendreFinSync` (orchestration.ts) — attente d'un job de sync RÉEL, invariants
 * testés avec un client factice (aucun réseau) + fake timers (aucune attente réelle).
 *
 * Faits du diagnostic sandbox encodés ici :
 *  - le job peut être COMPLETED dès le 1er poll (t+0s) → on ne doit PAS attendre ;
 *  - aucune transition n'est garantie : on ne traite que les états terminaux + OTP ;
 *  - à COMPLETED, PersistenceStats est loggé (preuve différée, sans PII).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { attendreFinSync } from "@/server/widget/orchestration";
import type { OmniFiClient } from "@/server/omnifi";

const CLIENT_USER_ID = "enduser-1";
const JOB_ID = "job-xyz";
const CONNECTION_ID = "conn-xyz";

/** Client factice exposant uniquement getSyncJobServeur (seul appel d'attendreFinSync). */
function clientAvecPolls(
  reponses: Array<{ Status: string; PersistenceStats?: unknown; Error?: unknown }>,
): { client: OmniFiClient; poll: ReturnType<typeof vi.fn> } {
  const poll = vi.fn();
  for (const r of reponses) poll.mockResolvedValueOnce({ JobId: JOB_ID, ...r });
  // Au-delà des réponses fournies, on reste sur la dernière (évite un undefined).
  if (reponses.length > 0) {
    poll.mockResolvedValue({ JobId: JOB_ID, ...reponses[reponses.length - 1] });
  }
  return { client: { getSyncJobServeur: poll } as unknown as OmniFiClient, poll };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attendreFinSync — 1er poll immédiat", () => {
  it("COMPLETED dès le 1er poll (t+0s) → retourne sans attendre, logue PersistenceStats", async () => {
    const stats = {
      TransactionsCreated: 3,
      TransactionsUpdated: 1,
      TransactionsDuplicated: 0,
      AccountsUpdated: 1,
    };
    const { client, poll } = clientAvecPolls([{ Status: "COMPLETED", PersistenceStats: stats }]);
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Pas de fake timers nécessaires : si le code attendait, le test pendrait.
    const r = await attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);

    expect(r.status).toBe("COMPLETED");
    expect(r.persistenceStats).toEqual(stats);
    expect(poll).toHaveBeenCalledTimes(1); // un seul poll, immédiat
    // Log structuré d'observabilité (sans PII) — la preuve différée.
    const charge = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(charge).toMatchObject({
      evt: "omnifi_sync_completed",
      connectionId: CONNECTION_ID,
      jobId: JOB_ID,
      created: 3,
      updated: 1,
      duplicated: 0,
    });
  });

  it("OTP_REQUESTED → status OTP_REQUESTED (réparation MFA), pas de log de complétion", async () => {
    const { client } = clientAvecPolls([{ Status: "OTP_REQUESTED" }]);
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const r = await attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);

    expect(r.status).toBe("OTP_REQUESTED");
    expect(r.jobId).toBe(JOB_ID);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("FAILED → status FAILED + errorType (Type seul, jamais le Message)", async () => {
    const { client } = clientAvecPolls([
      { Status: "FAILED", Error: { Type: "LOGIN_FAILED", Message: "secret-ne-doit-pas-fuiter" } },
    ]);

    const r = await attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);

    expect(r.status).toBe("FAILED");
    expect(r.errorType).toBe("LOGIN_FAILED");
  });
});

describe("attendreFinSync — boucle d'attente", () => {
  it("PENDING puis COMPLETED → poll deux fois (1 immédiat + 1 après la pause)", async () => {
    vi.useFakeTimers();
    const { client, poll } = clientAvecPolls([
      { Status: "PENDING" },
      { Status: "COMPLETED", PersistenceStats: { TransactionsCreated: 0 } },
    ]);
    vi.spyOn(console, "info").mockImplementation(() => {});

    const promesse = attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);
    // 1er poll immédiat (PENDING) déjà parti ; on laisse filer la microtask puis la pause.
    await vi.advanceTimersByTimeAsync(3_000);
    const r = await promesse;

    expect(r.status).toBe("COMPLETED");
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("toujours non terminal → TIMEOUT au plafond (~120s), sans pendre", async () => {
    vi.useFakeTimers();
    // Toujours PENDING (le mock par défaut reste sur la dernière réponse).
    const { client } = clientAvecPolls([{ Status: "PENDING" }]);

    const promesse = attendreFinSync(client, JOB_ID, CLIENT_USER_ID, CONNECTION_ID);
    // Avance bien au-delà du plafond pour franchir la condition de timeout.
    await vi.advanceTimersByTimeAsync(130_000);
    const r = await promesse;

    expect(r.status).toBe("TIMEOUT");
    expect(r.jobId).toBe(JOB_ID);
  });
});
