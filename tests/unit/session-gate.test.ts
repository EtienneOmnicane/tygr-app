/**
 * Gate par-requête AUTH-MDP-TEMPO1 (session.ts) — ordre STRICT §5.3 et
 * invalidation D4, avec `auth()` et le repository identité MOCKÉS (le cœur
 * testé est la logique de garde, pas Auth.js ni la base — celles-ci sont
 * couvertes par tests/integration/mot-de-passe.integration.test.ts).
 *
 * Matrice §5.5 côté garde :
 * - claim pwdAt ≠ base → NonAuthentifieError (session périmée ≡ non connecté),
 *   MÊME si le flag est vrai (ordre 2-avant-3 : jamais re-gaté) ;
 * - claim absent + colonne NULL → égaux → la migration n'éjecte personne ;
 * - flag vrai + pwdAt égal → MotDePasseAChangerError (exigerSessionWorkspace
 *   seulement — exigerSessionUtilisateur RETOURNE le flag, ne le jette pas).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/config", () => ({ auth: vi.fn() }));
vi.mock("@/server/db", () => ({ identite: { etatCompte: vi.fn() } }));

import { auth } from "@/server/auth/config";
import { identite } from "@/server/db";
import {
  AucunWorkspaceActifError,
  exigerSessionUtilisateur,
  exigerSessionWorkspace,
  MotDePasseAChangerError,
  NonAuthentifieError,
  normaliserPwdAt,
  ServiceIndisponibleError,
} from "@/server/auth/session";

const authMock = vi.mocked(auth);
const etatCompteMock = vi.mocked(identite.etatCompte);

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POSAGE = new Date("2026-07-01T08:00:00.000Z");

function sessionDe(surcharge: Record<string, unknown> = {}) {
  return {
    userId: USER_ID,
    activeWorkspaceId: WS_ID,
    viewFilter: null,
    pwdAt: POSAGE.getTime(),
    ...surcharge,
  };
}

function etatDe(surcharge: Record<string, unknown> = {}) {
  return {
    isActive: true,
    mustChangePassword: false,
    passwordChangedAt: POSAGE,
    ...surcharge,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("normaliserPwdAt (D4)", () => {
  it("null / undefined ≡ null ; Date → epoch ms ; nombre inchangé", () => {
    expect(normaliserPwdAt(null)).toBeNull();
    expect(normaliserPwdAt(undefined)).toBeNull();
    expect(normaliserPwdAt(POSAGE)).toBe(POSAGE.getTime());
    expect(normaliserPwdAt(1_750_000_000_000)).toBe(1_750_000_000_000);
  });
});

describe("exigerSessionWorkspace — ordre strict §5.3", () => {
  it("chemin heureux : claims alignés, flag levé → WorkspaceSession", async () => {
    authMock.mockResolvedValue(sessionDe() as never);
    etatCompteMock.mockResolvedValue(etatDe() as never);
    await expect(exigerSessionWorkspace()).resolves.toEqual({
      userId: USER_ID,
      activeWorkspaceId: WS_ID,
    });
  });

  it("1. compte inexistant → NonAuthentifieError (E6, fail-closed)", async () => {
    authMock.mockResolvedValue(sessionDe() as never);
    etatCompteMock.mockResolvedValue(null);
    await expect(exigerSessionWorkspace()).rejects.toBeInstanceOf(
      NonAuthentifieError,
    );
  });

  it("1. compte inactif → NonAuthentifieError (E6)", async () => {
    authMock.mockResolvedValue(sessionDe() as never);
    etatCompteMock.mockResolvedValue(etatDe({ isActive: false }) as never);
    await expect(exigerSessionWorkspace()).rejects.toBeInstanceOf(
      NonAuthentifieError,
    );
  });

  it("2. claim pwdAt ≠ base → NonAuthentifieError (session pré-changement)", async () => {
    authMock.mockResolvedValue(
      sessionDe({ pwdAt: POSAGE.getTime() - 60_000 }) as never,
    );
    etatCompteMock.mockResolvedValue(etatDe() as never);
    await expect(exigerSessionWorkspace()).rejects.toBeInstanceOf(
      NonAuthentifieError,
    );
  });

  it("2. claim présent mais colonne NULL → NonAuthentifieError (divergence)", async () => {
    authMock.mockResolvedValue(sessionDe() as never);
    etatCompteMock.mockResolvedValue(
      etatDe({ passwordChangedAt: null }) as never,
    );
    await expect(exigerSessionWorkspace()).rejects.toBeInstanceOf(
      NonAuthentifieError,
    );
  });

  it("2-avant-3 : pwdAt ≠ ET flag vrai → NonAuthentifieError, JAMAIS le gate", async () => {
    // Session pré-changement d'un compte re-gaté : déconnectée, pas re-gatée.
    authMock.mockResolvedValue(sessionDe({ pwdAt: null }) as never);
    etatCompteMock.mockResolvedValue(
      etatDe({ mustChangePassword: true }) as never,
    );
    await expect(exigerSessionWorkspace()).rejects.toBeInstanceOf(
      NonAuthentifieError,
    );
  });

  it("3. flag vrai + pwdAt égal → MotDePasseAChangerError (gate D3)", async () => {
    authMock.mockResolvedValue(sessionDe() as never);
    etatCompteMock.mockResolvedValue(
      etatDe({ mustChangePassword: true }) as never,
    );
    await expect(exigerSessionWorkspace()).rejects.toBeInstanceOf(
      MotDePasseAChangerError,
    );
  });

  it("pré-migration : claim ABSENT + colonne NULL → égaux → la suite s'applique", async () => {
    // La migration 0022 n'éjecte personne : le check suivant (workspace) parle.
    authMock.mockResolvedValue(
      sessionDe({ pwdAt: undefined, activeWorkspaceId: null }) as never,
    );
    etatCompteMock.mockResolvedValue(
      etatDe({ passwordChangedAt: null }) as never,
    );
    await expect(exigerSessionWorkspace()).rejects.toBeInstanceOf(
      AucunWorkspaceActifError,
    );
  });

  it("base injoignable → ServiceIndisponibleError (fail-closed, jamais « on suppose actif »)", async () => {
    authMock.mockResolvedValue(sessionDe() as never);
    etatCompteMock.mockRejectedValue(new Error("driver down"));
    await expect(exigerSessionWorkspace()).rejects.toBeInstanceOf(
      ServiceIndisponibleError,
    );
  });
});

describe("exigerSessionUtilisateur — checks 1-2, flag RETOURNÉ (pas jeté)", () => {
  it("flag vrai + pwdAt égal → retourne { userId, mustChangePassword: true }", async () => {
    authMock.mockResolvedValue(
      sessionDe({ activeWorkspaceId: null }) as never,
    );
    etatCompteMock.mockResolvedValue(
      etatDe({ mustChangePassword: true }) as never,
    );
    await expect(exigerSessionUtilisateur()).resolves.toEqual({
      userId: USER_ID,
      mustChangePassword: true,
    });
  });

  it("aucun workspace exigé : session sans activeWorkspaceId passe", async () => {
    authMock.mockResolvedValue(
      sessionDe({ activeWorkspaceId: null }) as never,
    );
    etatCompteMock.mockResolvedValue(etatDe() as never);
    await expect(exigerSessionUtilisateur()).resolves.toEqual({
      userId: USER_ID,
      mustChangePassword: false,
    });
  });

  it("invalidation D4 appliquée : claim pwdAt ≠ base → NonAuthentifieError", async () => {
    authMock.mockResolvedValue(
      sessionDe({ pwdAt: POSAGE.getTime() + 1 }) as never,
    );
    etatCompteMock.mockResolvedValue(etatDe() as never);
    await expect(exigerSessionUtilisateur()).rejects.toBeInstanceOf(
      NonAuthentifieError,
    );
  });

  it("non connecté → NonAuthentifieError sans lecture DB", async () => {
    authMock.mockResolvedValue(null as never);
    await expect(exigerSessionUtilisateur()).rejects.toBeInstanceOf(
      NonAuthentifieError,
    );
    expect(etatCompteMock).not.toHaveBeenCalled();
  });
});
