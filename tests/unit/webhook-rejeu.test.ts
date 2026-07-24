/**
 * Rejeu de la quarantaine (W5, plan §12) — deps INJECTÉES + espions. Prouve que le
 * rejeu repasse par le pipeline complet (résolution → cross-check → enqueue → audit,
 * AUCUN raccourci), le gating par EventType, la sortie de quarantaine, le compteur
 * d'échec (et son plafond), et que les pannes d'infra REMONTENT sans incrémenter.
 */
import { describe, expect, it, vi } from "vitest";

import type {
  LigneConnexionResolue,
  LigneQuarantaineEnAttente,
} from "@/server/db/service";
import {
  PLAFOND_REJEUX,
  rejouerEvenement,
  type DepsRejeuWebhook,
} from "@/server/webhooks/omnifi/rejeu";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_INTERNE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const connexion = (workspaceId = WS): LigneConnexionResolue => ({
  id: CONN_INTERNE,
  omnifiConnectionId: "omni-conn-42",
  workspaceId,
});

function ligne(
  surcharge: Partial<LigneQuarantaineEnAttente> = {},
): LigneQuarantaineEnAttente {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    omnifiEventId: "11111111-1111-4111-8111-111111111111",
    omnifiConnectionId: "omni-conn-42",
    eventType: "sync.completed",
    omnifiJobId: "job-7",
    motif: "CONNEXION_INCONNUE",
    replayCount: 0,
    ...surcharge,
  };
}

function faireDeps(
  o: Partial<{
    resolues: LigneConnexionResolue[];
    envWs: "sandbox" | "production" | null;
    auditInsere: boolean;
    enqueueLeve: boolean;
    auditLeve: boolean;
    tentatives: number;
  }> = {},
): DepsRejeuWebhook {
  return {
    envDeploiement: "sandbox",
    resoudreConnexion: vi.fn(async () => o.resolues ?? [connexion()]),
    lireEnvWorkspace: vi.fn(async () => o.envWs ?? "sandbox"),
    enqueue: vi.fn(async () => {
      if (o.enqueueLeve) throw new Error("inngest down");
    }),
    consignerAudit: vi.fn(async () => {
      if (o.auditLeve) throw new Error("db down");
      return { insere: o.auditInsere ?? true };
    }),
    marquerRejouee: vi.fn(async () => {}),
    enregistrerEchec: vi.fn(async () => ({ tentatives: o.tentatives ?? 1 })),
  };
}

describe("rejeu résolu — pipeline complet, sortie de quarantaine", () => {
  it("connexion résolue + env OK → enqueue (wh:EventId, WEBHOOK) + audit WEBHOOK_REJEU + marquage", async () => {
    const deps = faireDeps();
    const l = ligne();
    const r = await rejouerEvenement(deps, l, "run-1");
    expect(r).toEqual({ issue: "REJOUE" });
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.enqueue).mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      omnifiConnectionId: l.omnifiConnectionId,
      declencheur: "WEBHOOK",
      omnifiJobId: "job-7",
      omnifiEventId: l.omnifiEventId,
      cleIdempotence: `wh:${l.omnifiEventId}`,
    });
    expect(deps.consignerAudit).toHaveBeenCalledTimes(1);
    const [wsAudit, evtAudit] = vi.mocked(deps.consignerAudit).mock.calls[0];
    expect(wsAudit).toBe(WS);
    expect(evtAudit).toMatchObject({
      omnifiEventId: l.omnifiEventId,
      connectionId: CONN_INTERNE,
      hmacSignatureTruncated: null,
      declencheur: "WEBHOOK_REJEU",
    });
    expect(deps.marquerRejouee).toHaveBeenCalledWith(l.id);
    expect(deps.enregistrerEchec).not.toHaveBeenCalled();
  });

  it("EventType NON déclencheur (sync.pending) → audité + marqué, SANS enqueue (même gating qu'à la réception)", async () => {
    const deps = faireDeps();
    const r = await rejouerEvenement(deps, ligne({ eventType: "sync.pending" }), "run-2");
    expect(r).toEqual({ issue: "REJOUE" });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.consignerAudit).toHaveBeenCalledTimes(1);
    expect(deps.marquerRejouee).toHaveBeenCalledTimes(1);
  });

  it("audit en conflit (insere=false, événement déjà tracé à la réception) → DEJA_VU, marqué quand même", async () => {
    const deps = faireDeps({ auditInsere: false });
    const r = await rejouerEvenement(deps, ligne(), "run-3");
    expect(r).toEqual({ issue: "DEJA_VU" });
    expect(deps.marquerRejouee).toHaveBeenCalledTimes(1);
    expect(deps.enregistrerEchec).not.toHaveBeenCalled();
  });

  it("omnifiJobId null → enqueue SANS omnifiJobId (schéma strict : jamais null explicite)", async () => {
    const deps = faireDeps();
    await rejouerEvenement(deps, ligne({ omnifiJobId: null }), "run-4");
    const donnees = vi.mocked(deps.enqueue).mock.calls[0][0];
    expect(donnees.omnifiJobId).toBeUndefined();
  });
});

describe("rejeu toujours pas résolvable — compteur, jamais de choix arbitraire", () => {
  it("connexion toujours inconnue (0 ligne) → TOUJOURS_EN_QUARANTAINE + échec compté, ni enqueue ni audit ni marquage", async () => {
    const deps = faireDeps({ resolues: [] });
    const l = ligne();
    const r = await rejouerEvenement(deps, l, "run-5");
    expect(r).toEqual({
      issue: "TOUJOURS_EN_QUARANTAINE",
      motif: "CONNEXION_INCONNUE",
      tentatives: 1,
    });
    expect(deps.enregistrerEchec).toHaveBeenCalledWith(l.id);
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.consignerAudit).not.toHaveBeenCalled();
    expect(deps.marquerRejouee).not.toHaveBeenCalled();
  });

  it("connexion ambiguë (≥2 lignes) → AMBIGUE compté, jamais lignes[0]", async () => {
    const deps = faireDeps({ resolues: [connexion("ws-A"), connexion("ws-B")] });
    const r = await rejouerEvenement(deps, ligne(), "run-6");
    expect(r).toMatchObject({ issue: "TOUJOURS_EN_QUARANTAINE", motif: "AMBIGUE" });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.marquerRejouee).not.toHaveBeenCalled();
  });

  it("env mismatch (workspace production, déploiement sandbox) → ENV_MISMATCH compté", async () => {
    const deps = faireDeps({ envWs: "production" });
    const r = await rejouerEvenement(deps, ligne(), "run-7");
    expect(r).toMatchObject({ issue: "TOUJOURS_EN_QUARANTAINE", motif: "ENV_MISMATCH" });
    expect(deps.consignerAudit).not.toHaveBeenCalled();
    expect(deps.marquerRejouee).not.toHaveBeenCalled();
  });

  it("plafond atteint (tentatives = PLAFOND_REJEUX) → rendu tel quel (le listing l'exclura)", async () => {
    const deps = faireDeps({ resolues: [], tentatives: PLAFOND_REJEUX });
    const r = await rejouerEvenement(deps, ligne(), "run-8");
    expect(r).toMatchObject({ tentatives: PLAFOND_REJEUX });
  });
});

describe("pannes d'infra — remontent SANS compter (le step Inngest retente)", () => {
  it("échec d'enqueue → l'erreur remonte, ni échec compté ni marquage", async () => {
    const deps = faireDeps({ enqueueLeve: true });
    await expect(rejouerEvenement(deps, ligne(), "run-9")).rejects.toThrow(
      "inngest down",
    );
    expect(deps.enregistrerEchec).not.toHaveBeenCalled();
    expect(deps.marquerRejouee).not.toHaveBeenCalled();
    expect(deps.consignerAudit).not.toHaveBeenCalled();
  });

  it("échec d'audit APRÈS enqueue → l'erreur remonte, enqueue bien tenté, pas de marquage (retry re-livre, collapsé)", async () => {
    const deps = faireDeps({ auditLeve: true });
    await expect(rejouerEvenement(deps, ligne(), "run-10")).rejects.toThrow(
      "db down",
    );
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.marquerRejouee).not.toHaveBeenCalled();
    expect(deps.enregistrerEchec).not.toHaveBeenCalled();
  });
});
