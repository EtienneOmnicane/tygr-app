/**
 * Construction des événements du cron filet pull (W2) — fonction PURE.
 * La clé d'idempotence suit la convention client.ts (`cron:<conn>:<dateDuRun>`) :
 * deux fires du même jour Maurice collapsent, le lendemain repart. La date
 * comptable Maurice elle-même (E20, 22h UTC → lendemain) est prouvée par
 * tests/unit/periode.test.ts (aujourdhuiMaurice, source unique).
 */
import { describe, expect, it } from "vitest";

import { donneesSyncIngestSchema } from "@/server/inngest/client";
import {
  construireEvenementsCron,
  type ConnexionASynchroniser,
} from "@/server/inngest/fonctions/sync-cron";

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const connexions: ConnexionASynchroniser[] = [
  { workspaceId: WS_A, omnifiConnectionId: "omni-conn-1" },
  { workspaceId: WS_A, omnifiConnectionId: "omni-conn-2" },
  { workspaceId: WS_B, omnifiConnectionId: "omni-conn-3" },
];

describe("construireEvenementsCron", () => {
  it("un événement par connexion : déclencheur CRON, clé cron:<ws>:<conn>:<date>, SANS omnifiJobId", () => {
    const evts = construireEvenementsCron(connexions, "2026-07-24");
    expect(evts).toHaveLength(3);
    expect(evts[0]).toEqual({
      workspaceId: WS_A,
      omnifiConnectionId: "omni-conn-1",
      declencheur: "CRON",
      cleIdempotence: `cron:${WS_A}:omni-conn-1:2026-07-24`,
    });
    // omnifiJobId ABSENT (pas null) : le worker déclenche lui-même le scrape,
    // gardé par le cooldown amont (resoudreJobAmont).
    for (const e of evts) {
      expect("omnifiJobId" in e).toBe(false);
      expect(e.declencheur).toBe("CRON");
    }
  });

  it("chaque événement passe le schéma zod strict du contrat (donneesSyncIngestSchema)", () => {
    for (const e of construireEvenementsCron(connexions, "2026-07-24")) {
      expect(() => donneesSyncIngestSchema.parse(e)).not.toThrow();
    }
  });

  it("idempotence par JOUR : même jour → mêmes clés ; lendemain → clés distinctes", () => {
    const jour1 = construireEvenementsCron(connexions, "2026-07-24");
    const jour1bis = construireEvenementsCron(connexions, "2026-07-24");
    const jour2 = construireEvenementsCron(connexions, "2026-07-25");
    expect(jour1.map((e) => e.cleIdempotence)).toEqual(
      jour1bis.map((e) => e.cleIdempotence),
    );
    const communes = new Set(jour1.map((e) => e.cleIdempotence));
    for (const e of jour2) {
      expect(communes.has(e.cleIdempotence)).toBe(false);
    }
  });

  it("deux connexions distinctes ne partagent JAMAIS une clé (même jour)", () => {
    const evts = construireEvenementsCron(connexions, "2026-07-24");
    const cles = evts.map((e) => e.cleIdempotence);
    expect(new Set(cles).size).toBe(cles.length);
  });

  it("le MÊME ConnectionId amont dans DEUX workspaces → deux clés DISTINCTES (M1 — pas de collapse cross-tenant au CONTRACT)", () => {
    // Hypothèse d'unicité globale d'omnifi_connection_id ABANDONNÉE (EXPAND
    // 0018) : sans le workspaceId dans la clé, ces deux filets collapseraient
    // en UN run et un tenant perdrait silencieusement sa synchro du jour.
    const partage: ConnexionASynchroniser[] = [
      { workspaceId: WS_A, omnifiConnectionId: "omni-conn-partagee" },
      { workspaceId: WS_B, omnifiConnectionId: "omni-conn-partagee" },
    ];
    const cles = construireEvenementsCron(partage, "2026-07-24").map(
      (e) => e.cleIdempotence,
    );
    expect(new Set(cles).size).toBe(2);
  });

  it("liste vide → aucun événement (le cron log seul, pas d'envoi)", () => {
    expect(construireEvenementsCron([], "2026-07-24")).toEqual([]);
  });
});
