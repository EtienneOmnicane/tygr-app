/** Gating par rôle (Epic 2 L4) — fonctions pures. */
import { describe, expect, it } from "vitest";

import { peutAdministrer, peutModifier } from "@/lib/permissions";

describe("peutModifier", () => {
  it("VIEWER ne peut pas modifier", () => {
    expect(peutModifier("VIEWER")).toBe(false);
  });
  it("MANAGER et ADMIN peuvent modifier", () => {
    expect(peutModifier("MANAGER")).toBe(true);
    expect(peutModifier("ADMIN")).toBe(true);
  });
});

describe("peutAdministrer", () => {
  it("seul ADMIN administre", () => {
    expect(peutAdministrer("ADMIN")).toBe(true);
    expect(peutAdministrer("MANAGER")).toBe(false);
    expect(peutAdministrer("VIEWER")).toBe(false);
  });
});
