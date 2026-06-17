/**
 * Contrat Zod de la lecture paginée des transactions (B1). Valide la FORME des
 * filtres + curseur opaque à la frontière. La pagination keyset et le résumé de
 * ventilation sont testés côté isolation (transactions-isolation.test.ts).
 */
import { describe, expect, it } from "vitest";

import {
  estDateComptableValide,
  LIMITE_DEFAUT,
  LIMITE_MAX,
  listerTransactionsSchema,
} from "@/lib/transactions-schema";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("estDateComptableValide", () => {
  it.each(["2026-03-15", "2024-02-29", "2026-12-31", "2026-01-01"])(
    "accepte une date réelle : %s",
    (d) => expect(estDateComptableValide(d)).toBe(true),
  );
  it.each(["2026-13-99", "9999-99-99", "2026-02-30", "2026-00-00", "2025-02-29", "15/03/2026", "2026-3-5"])(
    "rejette une date invalide/impossible : %s",
    (d) => expect(estDateComptableValide(d)).toBe(false),
  );
});

describe("listerTransactionsSchema", () => {
  it("accepte un objet vide (filtres tous optionnels) et applique la limite par défaut", () => {
    const r = listerTransactionsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limite).toBe(LIMITE_DEFAUT);
  });

  it("accepte un jeu de filtres complet et valide", () => {
    const r = listerTransactionsSchema.safeParse({
      recherche: "loyer",
      bankAccountId: UUID,
      statut: "PARTIEL",
      dateDebut: "2026-01-01",
      dateFin: "2026-03-31",
      curseur: "MjAyNi0wMy0xNXwxMTExMTExMQ",
      limite: 25,
    });
    expect(r.success).toBe(true);
  });

  it("clampe la limite : 0 et au-delà de la borne max sont refusés", () => {
    expect(listerTransactionsSchema.safeParse({ limite: 0 }).success).toBe(false);
    expect(
      listerTransactionsSchema.safeParse({ limite: LIMITE_MAX + 1 }).success,
    ).toBe(false);
  });

  it("coerce une limite passée en chaîne (querystring)", () => {
    const r = listerTransactionsSchema.safeParse({ limite: "30" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limite).toBe(30);
  });

  it("REFUSE un statut inconnu", () => {
    expect(
      listerTransactionsSchema.safeParse({ statut: "BIDON" }).success,
    ).toBe(false);
  });

  it("REFUSE un bankAccountId non-uuid", () => {
    expect(
      listerTransactionsSchema.safeParse({ bankAccountId: "x" }).success,
    ).toBe(false);
  });

  it("REFUSE une date malformée", () => {
    expect(
      listerTransactionsSchema.safeParse({ dateDebut: "15/03/2026" }).success,
    ).toBe(false);
  });

  // Correctif cross-review F2 : forme valide mais date inexistante au calendrier.
  it.each(["2026-13-99", "9999-99-99", "2026-02-30", "2026-00-00"])(
    "REFUSE une date au bon format mais impossible : %s",
    (date) => {
      expect(listerTransactionsSchema.safeParse({ dateDebut: date }).success).toBe(
        false,
      );
    },
  );

  it("REFUSE un intervalle incohérent (début > fin)", () => {
    expect(
      listerTransactionsSchema.safeParse({
        dateDebut: "2026-03-31",
        dateFin: "2026-01-01",
      }).success,
    ).toBe(false);
  });

  it("REFUSE un curseur hors charset base64url (anti-forgerie de forme)", () => {
    expect(
      listerTransactionsSchema.safeParse({ curseur: "pas/du/base64url!" }).success,
    ).toBe(false);
  });

  it("REFUSE une clé inattendue (strict)", () => {
    expect(
      listerTransactionsSchema.safeParse({ evil: 1 } as Record<string, unknown>)
        .success,
    ).toBe(false);
  });
});
