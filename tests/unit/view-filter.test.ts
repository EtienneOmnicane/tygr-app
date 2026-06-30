/**
 * Contrat du sélecteur de périmètre (L8b-1) — logique PURE, sans React/Auth/DB.
 * Couvre les deux pièces décisives partagées par la Server Action definirViewFilter
 * et le callback jwt :
 *   • normaliserViewFilter : dédup + INTERSECTION avec les comptes visibles + []→undefined
 *     (hygiène de token — un id forgé/fantôme n'entre jamais dans le JWT).
 *   • perimetreSchema       : validation Zod stricte ([] accepté = « Groupe » ;
 *                             champ en trop rejeté ; borne max ; non-UUID rejeté).
 *
 * On NE teste PAS ici l'intersection RLS (déjà couverte par
 * tests/isolation/account-scope-isolation.test.ts) ni la coquille Server Action
 * (unstable_update/redirect) — cf. le pattern workspace-switch.test.ts qui teste la
 * fonction pure validerBascule, pas basculerWorkspace.
 */
import { describe, expect, it } from "vitest";

import {
  normaliserViewFilter,
  perimetreSchema,
  PERIMETRE_MAX_COMPTES,
} from "@/server/auth/view-filter";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ETRANGER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("normaliserViewFilter (hygiène de token, PAS la sécurité)", () => {
  it("intersecte avec les comptes autorisés (id hors droit éliminé)", () => {
    // ETRANGER n'est pas dans les comptes visibles → retiré.
    expect(normaliserViewFilter([A, ETRANGER, B], [A, B, C])).toEqual([A, B]);
  });

  it("dédublonne en préservant l'ordre de la demande", () => {
    expect(normaliserViewFilter([B, A, B, A], [A, B, C])).toEqual([B, A]);
  });

  it("liste vide → undefined (« Groupe »)", () => {
    expect(normaliserViewFilter([], [A, B])).toBeUndefined();
  });

  it("aucun id demandé n'est visible → undefined (convergence vers « Groupe », pas []) ", () => {
    expect(normaliserViewFilter([ETRANGER], [A, B])).toBeUndefined();
  });

  it("aucun compte autorisé (membre sans compte) → undefined quoi qu'on demande", () => {
    expect(normaliserViewFilter([A, B], [])).toBeUndefined();
  });

  it("demande = exactement les comptes autorisés → liste inchangée", () => {
    expect(normaliserViewFilter([A, B], [A, B])).toEqual([A, B]);
  });
});

describe("perimetreSchema (validation Zod stricte)", () => {
  it("liste d'UUID valides → OK", () => {
    const r = perimetreSchema.safeParse({ bankAccountIds: [A, B] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.bankAccountIds).toEqual([A, B]);
  });

  it("liste VIDE → OK (= « Groupe »)", () => {
    const r = perimetreSchema.safeParse({ bankAccountIds: [] });
    expect(r.success).toBe(true);
  });

  it("id non-UUID → rejet", () => {
    expect(
      perimetreSchema.safeParse({ bankAccountIds: ["pas-un-uuid"] }).success,
    ).toBe(false);
  });

  it("champ EN TROP → rejet (.strict())", () => {
    expect(
      perimetreSchema.safeParse({ bankAccountIds: [A], malicieux: 1 }).success,
    ).toBe(false);
  });

  it("dépassement de la borne max → rejet", () => {
    const trop = Array.from(
      { length: PERIMETRE_MAX_COMPTES + 1 },
      // UUID v4 valides distincts (index zéro-paddé sur 12 hexa).
      (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    );
    expect(perimetreSchema.safeParse({ bankAccountIds: trop }).success).toBe(false);
  });

  it("exactement la borne max → OK (limite incluse)", () => {
    const pile = Array.from(
      { length: PERIMETRE_MAX_COMPTES },
      (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    );
    expect(perimetreSchema.safeParse({ bankAccountIds: pile }).success).toBe(true);
  });

  it("bankAccountIds absent → rejet (champ requis)", () => {
    expect(perimetreSchema.safeParse({}).success).toBe(false);
  });
});
