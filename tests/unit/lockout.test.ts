/**
 * Machine d'état du lockout progressif (E18/#59) — tests aux bornes.
 * La politique testée est celle documentée dans src/lib/auth/lockout.ts ;
 * tout changement de seuil/durée doit casser un test ici (politique = contrat).
 */
import { describe, expect, it } from "vitest";

import {
  dureeVerrouMs,
  estVerrouille,
  evaluerEchec,
  evaluerSucces,
  SEUIL_VERROUILLAGE,
  VERROU_BASE_MS,
  VERROU_MAX_MS,
} from "@/server/auth/lockout";

const T0 = new Date("2026-06-12T10:00:00.000Z");

describe("dureeVerrouMs", () => {
  it("0 sous le seuil (1er au 4e échec)", () => {
    for (let n = 0; n < SEUIL_VERROUILLAGE; n++) {
      expect(dureeVerrouMs(n)).toBe(0);
    }
  });

  it("au seuil : durée de base (60s)", () => {
    expect(dureeVerrouMs(SEUIL_VERROUILLAGE)).toBe(VERROU_BASE_MS);
  });

  it("doublement à chaque échec au-delà du seuil", () => {
    expect(dureeVerrouMs(SEUIL_VERROUILLAGE + 1)).toBe(VERROU_BASE_MS * 2);
    expect(dureeVerrouMs(SEUIL_VERROUILLAGE + 2)).toBe(VERROU_BASE_MS * 4);
    expect(dureeVerrouMs(SEUIL_VERROUILLAGE + 3)).toBe(VERROU_BASE_MS * 8);
  });

  it("plafonné à 1h, y compris pour des compteurs extrêmes (pas de débordement)", () => {
    expect(dureeVerrouMs(SEUIL_VERROUILLAGE + 6)).toBe(VERROU_MAX_MS);
    expect(dureeVerrouMs(1_000)).toBe(VERROU_MAX_MS);
    expect(dureeVerrouMs(Number.MAX_SAFE_INTEGER)).toBe(VERROU_MAX_MS);
  });
});

describe("evaluerEchec (transition d'échec)", () => {
  it("incrémente sans verrou sous le seuil", () => {
    const etat = evaluerEchec(0, T0);
    expect(etat).toEqual({ failedLoginCount: 1, lockedUntil: null });
  });

  it("pose le verrou exactement au 5e échec consécutif", () => {
    const etat = evaluerEchec(SEUIL_VERROUILLAGE - 1, T0);
    expect(etat.failedLoginCount).toBe(SEUIL_VERROUILLAGE);
    expect(etat.lockedUntil).toEqual(new Date(T0.getTime() + VERROU_BASE_MS));
  });

  it("progression complète 5→6→7 échecs : 60s puis 120s puis 240s", () => {
    let compteur = SEUIL_VERROUILLAGE - 1;
    const durees = [VERROU_BASE_MS, VERROU_BASE_MS * 2, VERROU_BASE_MS * 4];
    for (const duree of durees) {
      const etat = evaluerEchec(compteur, T0);
      expect(etat.lockedUntil).toEqual(new Date(T0.getTime() + duree));
      compteur = etat.failedLoginCount;
    }
  });
});

describe("evaluerSucces (remise à zéro)", () => {
  it("réinitialise compteur et verrou", () => {
    expect(evaluerSucces()).toEqual({ failedLoginCount: 0, lockedUntil: null });
  });
});

describe("estVerrouille (bornes temporelles)", () => {
  it("null → jamais verrouillé", () => {
    expect(estVerrouille(null, T0)).toBe(false);
  });

  it("verrouillé 1ms avant l'expiration", () => {
    const expiration = new Date(T0.getTime() + 1);
    expect(estVerrouille(expiration, T0)).toBe(true);
  });

  it("levé à l'instant EXACT d'expiration (borne stricte)", () => {
    expect(estVerrouille(T0, T0)).toBe(false);
  });

  it("levé après expiration", () => {
    const expire = new Date(T0.getTime() - 1);
    expect(estVerrouille(expire, T0)).toBe(false);
  });
});
