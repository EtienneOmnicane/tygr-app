/**
 * validerBascule (Epic 2 L2 / S1) — barrière n°1 anti-IDOR, fonction pure.
 * Prouve qu'un workspace non-membre ne franchit jamais la validation d'écriture.
 */
import { describe, expect, it } from "vitest";

import type { MembershipResume } from "@/server/repositories/identite";
import {
  validerBascule,
  WorkspaceSwitchDeniedError,
} from "@/server/auth/workspace-switch";

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS_ETRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const MEMBERSHIPS: MembershipResume[] = [
  { workspaceId: WS_A, role: "MANAGER" },
  { workspaceId: WS_B, role: "VIEWER" },
];

describe("validerBascule (S1)", () => {
  it("workspace membre → retourné", () => {
    expect(validerBascule(WS_A, MEMBERSHIPS)).toBe(WS_A);
    expect(validerBascule(WS_B, MEMBERSHIPS)).toBe(WS_B);
  });

  it("workspace NON-membre → rejet (cœur anti-IDOR)", () => {
    expect(() => validerBascule(WS_ETRANGER, MEMBERSHIPS)).toThrow(
      WorkspaceSwitchDeniedError,
    );
  });

  it("aucun membership → tout rejet", () => {
    expect(() => validerBascule(WS_A, [])).toThrow(WorkspaceSwitchDeniedError);
  });

  it("entrée non-uuid / forgée → rejet avant toute comparaison", () => {
    for (const mauvais of [undefined, null, "", "pas-un-uuid", 42, {}]) {
      expect(() => validerBascule(mauvais, MEMBERSHIPS)).toThrow(
        WorkspaceSwitchDeniedError,
      );
    }
  });
});
