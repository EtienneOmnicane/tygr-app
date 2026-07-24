/**
 * `rejouerLot` (fonctions Inngest W5) — preuve du correctif C1 de la cross-review :
 * un step qui épuise ses retries (`StepError`) est ABSORBÉ par événement (journalisé,
 * compté `echecsInfra`, replay_count intact) et n'affame NI les événements FIFO
 * suivants NI la purge (déplacée en tête du cron). Toute autre erreur (défaut de
 * code) remonte et fait échouer le run.
 * Module `rejeu` mocké + step factice : zéro DB, zéro réseau.
 */
import { StepError } from "inngest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/webhooks/omnifi/rejeu", () => ({
  listerQuarantainePourRejeu: vi.fn(),
  rejouerEvenementQuarantaine: vi.fn(),
  purgerQuarantaine: vi.fn(),
}));

import type { LigneQuarantaineEnAttente } from "@/server/db/service";
import {
  rejouerLot,
  type StepRejeu,
} from "@/server/inngest/fonctions/webhook-replay";
import {
  listerQuarantainePourRejeu,
  rejouerEvenementQuarantaine,
} from "@/server/webhooks/omnifi/rejeu";

/** Step factice : exécute la fonction telle quelle (les retries du SDK sont
 *  simulés en faisant lever une StepError par le mock lui-même). */
const step = {
  run: (_id: string, fn: () => Promise<unknown>) => fn(),
} as unknown as StepRejeu;

function ligne(eventId: string): LigneQuarantaineEnAttente {
  return {
    id: `id-${eventId}`,
    omnifiEventId: eventId,
    omnifiConnectionId: "omni-conn-42",
    eventType: "sync.completed",
    omnifiJobId: null,
    motif: "CONNEXION_INCONNUE",
    replayCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rejouerLot — un échec d'infra n'affame pas le lot (C1)", () => {
  it("StepError sur l'événement 2/3 → absorbée, comptée, les événements 1 et 3 traités", async () => {
    vi.mocked(listerQuarantainePourRejeu).mockResolvedValue([
      ligne("E1"),
      ligne("E2"),
      ligne("E3"),
    ]);
    vi.mocked(rejouerEvenementQuarantaine).mockImplementation(async (l) => {
      if (l.omnifiEventId === "E2") {
        throw new StepError("rejouer-E2", new Error("infra down"));
      }
      return { issue: "REJOUE" as const };
    });

    const resume = await rejouerLot(step, undefined, "run-lot-1");

    expect(resume).toEqual({
      examines: 3,
      rejoues: 2,
      dejaVus: 0,
      enQuarantaine: 0,
      echecsInfra: 1,
    });
    // Les TROIS événements ont été tentés — E3 n'a pas été affamé par E2.
    expect(rejouerEvenementQuarantaine).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(rejouerEvenementQuarantaine).mock.calls.map((c) => c[0].omnifiEventId),
    ).toEqual(["E1", "E2", "E3"]);
  });

  it("comptage nominal : rejoué / déjà vu / toujours en quarantaine", async () => {
    vi.mocked(listerQuarantainePourRejeu).mockResolvedValue([
      ligne("A"),
      ligne("B"),
      ligne("C"),
    ]);
    vi.mocked(rejouerEvenementQuarantaine)
      .mockResolvedValueOnce({ issue: "REJOUE" })
      .mockResolvedValueOnce({ issue: "DEJA_VU" })
      .mockResolvedValueOnce({
        issue: "TOUJOURS_EN_QUARANTAINE",
        motif: "AMBIGUE",
        tentatives: 3,
      });

    const resume = await rejouerLot(step, undefined, "run-lot-2");
    expect(resume).toEqual({
      examines: 3,
      rejoues: 1,
      dejaVus: 1,
      enQuarantaine: 1,
      echecsInfra: 0,
    });
  });

  it("une erreur NON-StepError (défaut de code) remonte et fait échouer le run", async () => {
    vi.mocked(listerQuarantainePourRejeu).mockResolvedValue([ligne("E1")]);
    vi.mocked(rejouerEvenementQuarantaine).mockRejectedValue(
      new TypeError("bug de code"),
    );

    await expect(rejouerLot(step, undefined, "run-lot-3")).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("le filtre de connexion (chemin link-exchange) est transmis au listing", async () => {
    vi.mocked(listerQuarantainePourRejeu).mockResolvedValue([]);
    const resume = await rejouerLot(step, "omni-conn-42", "run-lot-4");
    expect(resume.examines).toBe(0);
    expect(listerQuarantainePourRejeu).toHaveBeenCalledWith("omni-conn-42");
  });
});
