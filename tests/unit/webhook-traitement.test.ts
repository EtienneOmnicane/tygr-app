/**
 * Orchestrateur webhook in-process (§10.3) — deps INJECTÉES + espions. Couvre le
 * pipeline complet : 202 (accepté / dédupliqué / quarantaine), enqueue AVANT audit
 * (§6.3), enqueue gaté par EventType (§7.3), et les rejets (401/400/429/503/500) avec
 * la propriété « aucun écrit DB avant signature valide ».
 */
import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { LigneConnexionResolue } from "@/server/db/service";
import {
  WebhookAuditEchecError,
  WebhookEnqueueEchecError,
  WebhookHorsFenetreError,
  WebhookNonConfigureError,
  WebhookPayloadInvalideError,
  WebhookSignatureInvalideError,
} from "@/server/webhooks/omnifi/erreurs";
import {
  traiterWebhook,
  type DepsTraitementWebhook,
} from "@/server/webhooks/omnifi/traitement";

const SECRET = randomBytes(32).toString("hex");
const NOW = Date.parse("2026-07-23T12:00:00Z");
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_INTERNE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function corpsValide(surcharge: Record<string, unknown> = {}) {
  return {
    EventId: "11111111-1111-4111-8111-111111111111",
    EventType: "sync.completed",
    ConnectionId: "omni-conn-42",
    Timestamp: new Date(NOW - 60_000).toISOString(),
    ...surcharge,
  };
}

/** Forge une requête signée (octets bruts + signature HMAC). */
function requeteSignee(corps: object, secret = SECRET) {
  const octets = Buffer.from(JSON.stringify(corps), "utf8");
  const signature = createHmac("sha256", secret).update(octets).digest("hex");
  return { octets, signature };
}

const connexion = (workspaceId = WS): LigneConnexionResolue => ({
  id: CONN_INTERNE,
  omnifiConnectionId: "omni-conn-42",
  workspaceId,
});

/** Fabrique des deps avec espions ; `resolues`/`envWs`/`auditInsere` paramétrables. */
function faireDeps(
  o: Partial<{
    secret: string | null;
    resolues: LigneConnexionResolue[];
    envWs: "sandbox" | "production" | null;
    auditInsere: boolean;
    enqueueLeve: boolean;
    auditLeve: boolean;
  }> = {},
): DepsTraitementWebhook {
  return {
    envDeploiement: "sandbox",
    secret: o.secret === undefined ? SECRET : o.secret,
    maintenant: () => NOW,
    resoudreConnexion: vi.fn(async () => o.resolues ?? [connexion()]),
    insererQuarantaine: vi.fn(async () => ({ insere: true })),
    lireEnvWorkspace: vi.fn(async () => o.envWs ?? "sandbox"),
    enqueue: vi.fn(async () => {
      if (o.enqueueLeve) throw new Error("inngest down");
    }),
    consignerAudit: vi.fn(async () => {
      if (o.auditLeve) throw new Error("db down");
      return { insere: o.auditInsere ?? true };
    }),
  };
}

describe("chemin heureux + gating d'enqueue", () => {
  it("sync.completed résolu, env OK → ACCEPTE ; enqueue 1× (wh:EventId) ; audit 1×", async () => {
    const deps = faireDeps();
    const corps = corpsValide();
    const r = await traiterWebhook(deps, requeteSignee(corps), "req-1");
    expect(r).toEqual({ issue: "ACCEPTE" });
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.enqueue).mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      declencheur: "WEBHOOK",
      omnifiEventId: corps.EventId,
      cleIdempotence: `wh:${corps.EventId}`,
    });
    expect(deps.consignerAudit).toHaveBeenCalledTimes(1);
    expect(deps.insererQuarantaine).not.toHaveBeenCalled();
  });

  it("EventType NON déclencheur (sync.pending) → ACCEPTE, tracé SANS enqueue (§7.3)", async () => {
    const deps = faireDeps();
    const r = await traiterWebhook(
      deps,
      requeteSignee(corpsValide({ EventType: "sync.pending" })),
      "req-2",
    );
    expect(r).toEqual({ issue: "ACCEPTE" });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.consignerAudit).toHaveBeenCalledTimes(1);
  });

  it("rejeu ×5 du même EventId → cleIdempotence STABLE (Inngest collapse) + 1 seule ligne d'audit", async () => {
    // La dédup DB est simulée par le stub : 1er insere=true, suivants insere=false.
    const vus = new Set<string>();
    const deps = faireDeps();
    vi.mocked(deps.consignerAudit).mockImplementation(async (_ws, evt) => {
      const nouveau = !vus.has(evt.omnifiEventId);
      vus.add(evt.omnifiEventId);
      return { insere: nouveau };
    });
    const corps = corpsValide();
    const issues: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await traiterWebhook(deps, requeteSignee(corps), `req-r${i}`);
      issues.push(r.issue);
    }
    // 1 ACCEPTE puis 4 DEDUPLIQUE (une seule ligne d'audit réellement insérée).
    expect(issues).toEqual([
      "ACCEPTE",
      "DEDUPLIQUE",
      "DEDUPLIQUE",
      "DEDUPLIQUE",
      "DEDUPLIQUE",
    ]);
    // Les 5 enqueues portent la MÊME clé → Inngest les collapse en 1 seul run (fenêtre 24 h).
    const cles = vi
      .mocked(deps.enqueue)
      .mock.calls.map((c) => c[0].cleIdempotence);
    expect(new Set(cles)).toEqual(new Set([`wh:${corps.EventId}`]));
  });
});

describe("quarantaine (202) — jamais de routage arbitraire", () => {
  it("connexion inconnue (0 ligne) → QUARANTAINE CONNEXION_INCONNUE, aucun enqueue/audit", async () => {
    const deps = faireDeps({ resolues: [] });
    const r = await traiterWebhook(deps, requeteSignee(corpsValide()), "req-3");
    expect(r).toEqual({ issue: "QUARANTAINE", motif: "CONNEXION_INCONNUE" });
    expect(deps.insererQuarantaine).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.insererQuarantaine).mock.calls[0][0]).toMatchObject({
      motif: "CONNEXION_INCONNUE",
      omnifiEnvironment: "sandbox",
    });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.consignerAudit).not.toHaveBeenCalled();
  });

  it("connexion ambiguë (≥2 lignes) → QUARANTAINE AMBIGUE", async () => {
    const deps = faireDeps({ resolues: [connexion("ws-A"), connexion("ws-B")] });
    const r = await traiterWebhook(deps, requeteSignee(corpsValide()), "req-4");
    expect(r).toEqual({ issue: "QUARANTAINE", motif: "AMBIGUE" });
    expect(vi.mocked(deps.insererQuarantaine).mock.calls[0][0].motif).toBe("AMBIGUE");
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("env mismatch (workspace production, déploiement sandbox) → QUARANTAINE ENV_MISMATCH, aucun enqueue", async () => {
    const deps = faireDeps({ envWs: "production" });
    const r = await traiterWebhook(deps, requeteSignee(corpsValide()), "req-5");
    expect(r).toEqual({ issue: "QUARANTAINE", motif: "ENV_MISMATCH" });
    expect(vi.mocked(deps.insererQuarantaine).mock.calls[0][0].motif).toBe(
      "ENV_MISMATCH",
    );
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.consignerAudit).not.toHaveBeenCalled();
  });
});

describe("rejets — aucun écrit DB avant signature valide", () => {
  it("secret absent → WebhookNonConfigureError (503), aucun accès", async () => {
    const deps = faireDeps({ secret: null });
    await expect(
      traiterWebhook(deps, requeteSignee(corpsValide()), "req-6"),
    ).rejects.toBeInstanceOf(WebhookNonConfigureError);
    expect(deps.resoudreConnexion).not.toHaveBeenCalled();
  });

  it("signature invalide → 401 et ZÉRO appel (résolution/quarantaine/enqueue/audit)", async () => {
    const deps = faireDeps();
    const req = requeteSignee(corpsValide());
    req.signature = "0".repeat(64); // fausse
    await expect(
      traiterWebhook(deps, req, "req-7"),
    ).rejects.toBeInstanceOf(WebhookSignatureInvalideError);
    expect(deps.resoudreConnexion).not.toHaveBeenCalled();
    expect(deps.insererQuarantaine).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.consignerAudit).not.toHaveBeenCalled();
  });

  it("corps signé mais non-JSON → WebhookPayloadInvalideError (400)", async () => {
    const deps = faireDeps();
    const octets = Buffer.from("pas du json", "utf8");
    const signature = createHmac("sha256", SECRET).update(octets).digest("hex");
    await expect(
      traiterWebhook(deps, { octets, signature }, "req-8"),
    ).rejects.toBeInstanceOf(WebhookPayloadInvalideError);
  });

  it("Timestamp hors fenêtre → WebhookHorsFenetreError (400), avant toute résolution", async () => {
    const deps = faireDeps();
    const vieux = corpsValide({
      Timestamp: new Date(NOW - 13 * 3600_000).toISOString(),
    });
    await expect(
      traiterWebhook(deps, requeteSignee(vieux), "req-9"),
    ).rejects.toBeInstanceOf(WebhookHorsFenetreError);
    expect(deps.resoudreConnexion).not.toHaveBeenCalled();
  });
  // NB : le rate-limit (429) est désormais appliqué par la coquille de transport AVANT
  // la lecture du corps (C2) — couvert par tests/unit/webhook-rate-limit.test.ts et
  // tests/unit/webhook-route.test.ts.
});

describe("ordre enqueue → audit (§6.3)", () => {
  it("échec d'enqueue → WebhookEnqueueEchecError (500) et AUCUN audit (pas de trace avant enqueue)", async () => {
    const deps = faireDeps({ enqueueLeve: true });
    await expect(
      traiterWebhook(deps, requeteSignee(corpsValide()), "req-10"),
    ).rejects.toBeInstanceOf(WebhookEnqueueEchecError);
    expect(deps.consignerAudit).not.toHaveBeenCalled();
  });

  it("échec d'audit APRÈS enqueue → WebhookAuditEchecError (500) — enqueue bien tenté", async () => {
    const deps = faireDeps({ auditLeve: true });
    await expect(
      traiterWebhook(deps, requeteSignee(corpsValide()), "req-11"),
    ).rejects.toBeInstanceOf(WebhookAuditEchecError);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });
});
