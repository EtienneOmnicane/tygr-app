/**
 * Cœur de vérification des identifiants (E6/E7/E18) — les invariants de
 * sécurité sont testés ici avec des dépendances factices :
 * non-énumération, égalisation de timing, préséance du rate-limit, verrou.
 */
import { describe, expect, it, vi } from "vitest";

import { VERROU_BASE_MS } from "@/lib/auth/lockout";
import { MAX_TENTATIVES_IP } from "@/lib/auth/rate-limit-ip";
import {
  HASH_FACTICE,
  verifierIdentifiants,
  type DepsVerification,
} from "@/lib/auth/verifier-identifiants";
import type { UtilisateurIdentite } from "@/repositories/identite";

const T0 = new Date("2026-06-12T10:00:00.000Z");
const IP = "203.0.113.7";

const ALICE: UtilisateurIdentite = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "alice@groupe.mu",
  fullName: "Alice Manager",
  passwordHash: "$argon2id$hash-alice",
  isActive: true,
  failedLoginCount: 0,
  lockedUntil: null,
};

function creerDeps(
  surcharge: {
    utilisateur?: UtilisateurIdentite | null;
    tentativesIp?: number;
    motDePasseValide?: boolean;
  } = {},
) {
  const verifierMotDePasse = vi
    .fn<DepsVerification["verifierMotDePasse"]>()
    .mockResolvedValue(surcharge.motDePasseValide ?? false);
  const identite = {
    trouverParEmail: vi.fn().mockResolvedValue(surcharge.utilisateur ?? null),
    enregistrerEchec: vi.fn().mockResolvedValue(undefined),
    reinitialiserEchecs: vi.fn().mockResolvedValue(undefined),
    compterTentativesIp: vi
      .fn()
      .mockResolvedValue(surcharge.tentativesIp ?? 0),
    enregistrerTentativeIp: vi.fn().mockResolvedValue(undefined),
  };
  const deps: DepsVerification = {
    identite,
    verifierMotDePasse,
    maintenant: () => T0,
  };
  return { deps, identite, verifierMotDePasse };
}

const ENTREE = { email: "alice@groupe.mu", motDePasse: "secret" };

describe("chemin heureux", () => {
  it("identifiants valides → utilisateur + remise à zéro du lockout", async () => {
    const { deps, identite } = creerDeps({
      utilisateur: ALICE,
      motDePasseValide: true,
    });
    const r = await verifierIdentifiants(deps, ENTREE, IP);
    expect(r).toEqual({
      ok: true,
      utilisateur: {
        id: ALICE.id,
        email: ALICE.email,
        fullName: ALICE.fullName,
      },
    });
    expect(identite.reinitialiserEchecs).toHaveBeenCalledWith(ALICE.id);
    expect(identite.enregistrerTentativeIp).toHaveBeenCalledWith(IP, true);
  });
});

describe("non-énumération (E18) — tous les échecs ont la même forme", () => {
  it("email inconnu, mauvais mot de passe, compte verrouillé, compte inactif, compte SSO : ok=false partout", async () => {
    const cas = [
      creerDeps({ utilisateur: null }), // inconnu
      creerDeps({ utilisateur: ALICE, motDePasseValide: false }), // mauvais mdp
      creerDeps({
        utilisateur: {
          ...ALICE,
          failedLoginCount: 5,
          lockedUntil: new Date(T0.getTime() + VERROU_BASE_MS),
        },
        motDePasseValide: true, // même avec le BON mot de passe
      }),
      creerDeps({ utilisateur: { ...ALICE, isActive: false }, motDePasseValide: true }),
      creerDeps({ utilisateur: { ...ALICE, passwordHash: null }, motDePasseValide: true }),
    ];
    for (const { deps } of cas) {
      const r = await verifierIdentifiants(deps, ENTREE, IP);
      expect(r.ok).toBe(false);
    }
  });

  it("égalisation de timing : argon2 est vérifié MÊME quand l'email est inconnu (hash factice)", async () => {
    const { deps, verifierMotDePasse } = creerDeps({ utilisateur: null });
    await verifierIdentifiants(deps, ENTREE, IP);
    expect(verifierMotDePasse).toHaveBeenCalledTimes(1);
    expect(verifierMotDePasse).toHaveBeenCalledWith(HASH_FACTICE, "secret");
  });

  it("compte sans mot de passe (SSO) : vérification factice aussi", async () => {
    const { deps, verifierMotDePasse } = creerDeps({
      utilisateur: { ...ALICE, passwordHash: null },
    });
    await verifierIdentifiants(deps, ENTREE, IP);
    expect(verifierMotDePasse).toHaveBeenCalledWith(HASH_FACTICE, "secret");
  });
});

describe("rate-limit IP (E7) — préséance absolue", () => {
  it("limite atteinte : users n'est JAMAIS lu, la tentative est journalisée", async () => {
    const { deps, identite } = creerDeps({
      tentativesIp: MAX_TENTATIVES_IP,
      utilisateur: ALICE,
      motDePasseValide: true,
    });
    const r = await verifierIdentifiants(deps, ENTREE, IP);
    expect(r).toEqual({ ok: false, code: "LIMITE_IP_ATTEINTE" });
    expect(identite.trouverParEmail).not.toHaveBeenCalled();
    expect(identite.enregistrerTentativeIp).toHaveBeenCalledWith(IP, false);
  });
});

describe("lockout (E18)", () => {
  it("verrou actif : compteur NON incrémenté, bon mot de passe ignoré", async () => {
    const { deps, identite } = creerDeps({
      utilisateur: {
        ...ALICE,
        failedLoginCount: 5,
        lockedUntil: new Date(T0.getTime() + 1),
      },
      motDePasseValide: true,
    });
    const r = await verifierIdentifiants(deps, ENTREE, IP);
    expect(r).toEqual({ ok: false, code: "COMPTE_VERROUILLE" });
    expect(identite.enregistrerEchec).not.toHaveBeenCalled();
    expect(identite.reinitialiserEchecs).not.toHaveBeenCalled();
  });

  it("verrou expiré à l'instant exact : la tentative reprend le cours normal", async () => {
    const { deps, identite } = creerDeps({
      utilisateur: { ...ALICE, failedLoginCount: 5, lockedUntil: T0 },
      motDePasseValide: false,
    });
    const r = await verifierIdentifiants(deps, ENTREE, IP);
    expect(r).toEqual({ ok: false, code: "IDENTIFIANTS_INVALIDES" });
    expect(identite.enregistrerEchec).toHaveBeenCalledWith(ALICE.id, T0);
  });

  it("mauvais mot de passe : l'échec est enregistré (machine d'état)", async () => {
    const { deps, identite } = creerDeps({
      utilisateur: ALICE,
      motDePasseValide: false,
    });
    await verifierIdentifiants(deps, ENTREE, IP);
    expect(identite.enregistrerEchec).toHaveBeenCalledWith(ALICE.id, T0);
  });
});

describe("validation d'entrée (règle 3)", () => {
  it("entrée difforme : rejet AVANT tout accès au repository", async () => {
    const { deps, identite } = creerDeps();
    const cas = [
      undefined,
      {},
      { email: "a", motDePasse: "x" }, // email trop court
      { email: "alice@groupe.mu", motDePasse: "" }, // mdp vide
      { email: "alice@groupe.mu", motDePasse: "x".repeat(201) }, // borne max
      { email: "alice@groupe.mu", motDePasse: "x", champ: "en-trop" }, // strict
    ];
    for (const entree of cas) {
      const r = await verifierIdentifiants(deps, entree, IP);
      expect(r).toEqual({ ok: false, code: "ENTREE_INVALIDE" });
    }
    expect(identite.compterTentativesIp).not.toHaveBeenCalled();
    expect(identite.trouverParEmail).not.toHaveBeenCalled();
  });
});
