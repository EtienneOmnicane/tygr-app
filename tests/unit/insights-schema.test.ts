/**
 * Contrat Zod des lectures d'insights dérivés (flux L2 + drill L4). Valide la FORME à la
 * frontière : granularité fermée, période BORNÉE (longueur + jeu de caractères), devise du
 * drill (top-N PAR devise) et surtout le REJET BRUYANT d'une clé inconnue (`.strict`, miroir
 * de `syntheseParMoisSchema`) — jamais un strip silencieux. Cross-review PR #259, constat 2.
 */
import { describe, expect, it } from "vitest";

import {
  detailBucketParamsSchema,
  fluxParamsSchema,
} from "@/lib/insights-schema";

describe("fluxParamsSchema", () => {
  it("accepte un descripteur minimal (granularité seule)", () => {
    expect(fluxParamsSchema.safeParse({ granularite: "mois" }).success).toBe(true);
  });

  it("accepte periode/du/au valides", () => {
    const r = fluxParamsSchema.safeParse({
      granularite: "jour",
      periode: "6m",
      du: "2026-06-01",
      au: "2026-06-30",
    });
    expect(r.success).toBe(true);
  });

  it("REJETTE une clé inconnue (.strict — pas de strip silencieux)", () => {
    expect(
      fluxParamsSchema.safeParse({ granularite: "mois", inconnue: 1 }).success,
    ).toBe(false);
  });

  it("rejette une granularité hors énum", () => {
    expect(fluxParamsSchema.safeParse({ granularite: "annee" }).success).toBe(false);
  });

  it("borne periode : longueur max ET jeu de caractères (rejet bruyant)", () => {
    expect(
      fluxParamsSchema.safeParse({ granularite: "mois", periode: "x".repeat(17) })
        .success,
    ).toBe(false);
    expect(
      fluxParamsSchema.safeParse({ granularite: "mois", periode: "6m <script>" })
        .success,
    ).toBe(false);
  });

  it("borne du/au : format YYYY-MM-DD, chaîne vide tolérée (= param absent)", () => {
    expect(
      fluxParamsSchema.safeParse({ granularite: "mois", du: "hier" }).success,
    ).toBe(false);
    // Vide = param absent → repli sur le preset côté serveur (comportement historique).
    expect(
      fluxParamsSchema.safeParse({ granularite: "mois", du: "", au: "" }).success,
    ).toBe(true);
  });
});

describe("detailBucketParamsSchema", () => {
  const base = { granularite: "mois", bucket: "2026-06", currency: "MUR" };

  it("accepte un drill valide (granularité + bucket cohérent + devise)", () => {
    expect(detailBucketParamsSchema.safeParse(base).success).toBe(true);
  });

  it("REJETTE une clé inconnue (.strict)", () => {
    expect(
      detailBucketParamsSchema.safeParse({ ...base, inconnue: 1 }).success,
    ).toBe(false);
  });

  it("exige la devise (drill PAR devise) et rejette un code non ISO", () => {
    const sansDevise = { granularite: "mois", bucket: "2026-06" };
    expect(detailBucketParamsSchema.safeParse(sansDevise).success).toBe(false);
    expect(
      detailBucketParamsSchema.safeParse({ ...base, currency: "US" }).success,
    ).toBe(false);
    expect(
      detailBucketParamsSchema.safeParse({ ...base, currency: "usdd" }).success,
    ).toBe(false);
  });

  it("rejette un bucket incohérent avec la granularité (refine)", () => {
    // « mois » attend "YYYY-MM" : un "YYYY-MM-DD" est incohérent.
    expect(
      detailBucketParamsSchema.safeParse({ ...base, bucket: "2026-06-15" }).success,
    ).toBe(false);
    // « jour » attend une date RÉELLE : 2026-02-30 est rejeté (piège F1/F2).
    expect(
      detailBucketParamsSchema.safeParse({
        granularite: "jour",
        bucket: "2026-02-30",
        currency: "MUR",
      }).success,
    ).toBe(false);
  });
});
