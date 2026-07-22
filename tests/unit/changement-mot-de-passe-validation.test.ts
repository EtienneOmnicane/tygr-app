/**
 * Validation du changement de mot de passe (AUTH-MDP-TEMPO1 §5.4 étape 2) —
 * bornes 12/200, `.strict()` (anti-IDOR structurel : tout champ excédentaire
 * est rejeté), préséance des codes (forme → mismatch → same-as-current).
 */
import { describe, expect, it } from "vitest";

import {
  MESSAGES_CHANGEMENT,
  validerChangement,
} from "@/app/account/password/validation";

const VALIDE = {
  currentPassword: "ancien-secret-1",
  newPassword: "nouveau-secret-12car",
  confirmPassword: "nouveau-secret-12car",
};

describe("chemin heureux", () => {
  it("saisie conforme → data sans confirmPassword", () => {
    const r = validerChangement(VALIDE);
    expect(r).toEqual({
      ok: true,
      data: {
        currentPassword: VALIDE.currentPassword,
        newPassword: VALIDE.newPassword,
      },
    });
  });

  it("bornes exactes : nouveau de 12 puis 200 caractères acceptés", () => {
    const douze = "a".repeat(12);
    expect(
      validerChangement({
        currentPassword: "x",
        newPassword: douze,
        confirmPassword: douze,
      }).ok,
    ).toBe(true);
    const deuxCents = "b".repeat(200);
    expect(
      validerChangement({
        currentPassword: "x",
        newPassword: deuxCents,
        confirmPassword: deuxCents,
      }).ok,
    ).toBe(true);
  });
});

describe("INVALID_INPUT — forme stricte", () => {
  it.each([
    ["nouveau trop court (11)", { ...VALIDE, newPassword: "a".repeat(11), confirmPassword: "a".repeat(11) }],
    ["nouveau trop long (201)", { ...VALIDE, newPassword: "a".repeat(201), confirmPassword: "a".repeat(201) }],
    ["actuel vide", { ...VALIDE, currentPassword: "" }],
    ["confirmation vide", { ...VALIDE, confirmPassword: "" }],
    ["champ manquant", { currentPassword: "x", newPassword: VALIDE.newPassword }],
    ["type non-chaîne", { ...VALIDE, newPassword: 42 }],
    ["entrée nulle", null],
  ])("%s → INVALID_INPUT", (_libelle, entree) => {
    expect(validerChangement(entree)).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("champ EXCÉDENTAIRE rejeté (.strict — anti-IDOR : pas d'userId injectable)", () => {
    expect(
      validerChangement({
        ...VALIDE,
        userId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toEqual({ ok: false, code: "INVALID_INPUT" });
  });
});

describe("codes métier", () => {
  it("les deux saisies divergent → PASSWORDS_DO_NOT_MATCH", () => {
    expect(
      validerChangement({ ...VALIDE, confirmPassword: "autre-secret-12car" }),
    ).toEqual({ ok: false, code: "PASSWORDS_DO_NOT_MATCH" });
  });

  it("nouveau == actuel → SAME_AS_CURRENT (égalité de chaînes, avant tout hash)", () => {
    const meme = "identique-12-caracteres";
    expect(
      validerChangement({
        currentPassword: meme,
        newPassword: meme,
        confirmPassword: meme,
      }),
    ).toEqual({ ok: false, code: "SAME_AS_CURRENT" });
  });

  it("préséance : mismatch prime sur same-as-current", () => {
    expect(
      validerChangement({
        currentPassword: "identique-12-caracteres",
        newPassword: "identique-12-caracteres",
        confirmPassword: "differente-12-caracteres",
      }),
    ).toEqual({ ok: false, code: "PASSWORDS_DO_NOT_MATCH" });
  });
});

describe("registre S2", () => {
  it("chaque code de refus a un message UI (EN) mappé", () => {
    for (const code of [
      "INVALID_INPUT",
      "PASSWORDS_DO_NOT_MATCH",
      "SAME_AS_CURRENT",
      "CURRENT_PASSWORD_INCORRECT",
      "ACCOUNT_LOCKED",
      "NO_PASSWORD_SET",
    ] as const) {
      expect(MESSAGES_CHANGEMENT[code]).toBeTruthy();
    }
  });
});
