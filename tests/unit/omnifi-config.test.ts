/**
 * Configuration Omni-FI (config.ts) — invariants du VERROU SANDBOX dual prod/sandbox
 * et des gardes de cohérence env↔hôte / anti-fuite de secret.
 *
 * Surface de sécurité (CLAUDE.md règle 3) : on prouve le fail-closed PAR DÉFAUT
 * (la prod est refusée tant que OMNIFI_AUTORISER_PRODUCTION!="1"), le déverrouillage
 * EXPLICITE (le flag à "1" laisse passer une config prod COHÉRENTE), et que les gardes
 * env↔hôte restent actives dans les deux cas. On lit les vraies env vars : chaque cas
 * pose son environnement puis `_reinitialiserConfigOmniFi()` (le cache est résolu une
 * seule fois sinon). Aucun réseau.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  obtenirConfigOmniFi,
  _reinitialiserConfigOmniFi,
} from "@/server/omnifi/config";
import { OmniFiConfigError } from "@/server/omnifi/erreurs";

/** Variables Omni-FI manipulées par ces tests — restaurées après chaque cas. */
const CLES = [
  "OMNIFI_ENV",
  "OMNIFI_BASE_URL",
  "OMNIFI_CLIENT_ID",
  "OMNIFI_SECRET",
  "OMNIFI_AUTORISER_PRODUCTION",
] as const;

const HOTE_SANDBOX = "https://api-stage.omni-fi.co";
const HOTE_PROD = "https://api.omni-fi.co";

let snapshot: Record<string, string | undefined>;

/** Pose un jeu d'env vars Omni-FI (clés absentes = supprimées). */
function poserEnv(vars: Partial<Record<(typeof CLES)[number], string>>): void {
  for (const cle of CLES) {
    if (vars[cle] === undefined) delete process.env[cle];
    else process.env[cle] = vars[cle];
  }
  _reinitialiserConfigOmniFi();
}

/** Jeu de base valide pour la sandbox — surchargé par cas. */
const BASE_SANDBOX = {
  OMNIFI_ENV: "sandbox",
  OMNIFI_BASE_URL: HOTE_SANDBOX,
  OMNIFI_CLIENT_ID: "client_test",
  OMNIFI_SECRET: "sand_sk_secret",
} as const;

beforeEach(() => {
  snapshot = Object.fromEntries(CLES.map((c) => [c, process.env[c]]));
});

afterEach(() => {
  for (const cle of CLES) {
    if (snapshot[cle] === undefined) delete process.env[cle];
    else process.env[cle] = snapshot[cle];
  }
  _reinitialiserConfigOmniFi();
});

describe("config Omni-FI — sandbox (chemin heureux)", () => {
  it("accepte une config sandbox cohérente, sans drapeau de prod", () => {
    poserEnv({ ...BASE_SANDBOX });
    const config = obtenirConfigOmniFi();
    expect(config.environment).toBe("sandbox");
    expect(config.baseUrl).toBe(HOTE_SANDBOX);
    expect(config.clientId).toBe("client_test");
  });

  it("normalise le slash final de la base URL", () => {
    poserEnv({ ...BASE_SANDBOX, OMNIFI_BASE_URL: `${HOTE_SANDBOX}/` });
    expect(obtenirConfigOmniFi().baseUrl).toBe(HOTE_SANDBOX);
  });
});

describe("verrou sandbox — fail-closed PAR DÉFAUT", () => {
  it("refuse OMNIFI_ENV=production sans drapeau (cas limite : drapeau absent)", () => {
    poserEnv({
      ...BASE_SANDBOX,
      OMNIFI_ENV: "production",
      OMNIFI_BASE_URL: HOTE_PROD,
    });
    expect(() => obtenirConfigOmniFi()).toThrow(OmniFiConfigError);
    expect(() => obtenirConfigOmniFi()).toThrow(/Verrou sandbox actif/);
  });

  it("refuse un hôte de prod même si OMNIFI_ENV=sandbox (deuxième voie du verrou)", () => {
    // L'incohérence env↔hôte serait aussi un motif, mais le verrou doit mordre
    // EN PREMIER sur l'hôte de prod tant que le drapeau n'est pas posé.
    poserEnv({ ...BASE_SANDBOX, OMNIFI_BASE_URL: HOTE_PROD });
    expect(() => obtenirConfigOmniFi()).toThrow(/Verrou sandbox actif/);
  });

  it("traite toute valeur ≠ \"1\" comme verrouillée (ex. \"true\", \"0\", vide)", () => {
    for (const valeur of ["true", "0", "", "oui", "PRODUCTION"]) {
      poserEnv({
        ...BASE_SANDBOX,
        OMNIFI_ENV: "production",
        OMNIFI_BASE_URL: HOTE_PROD,
        OMNIFI_AUTORISER_PRODUCTION: valeur,
      });
      expect(() => obtenirConfigOmniFi()).toThrow(/Verrou sandbox actif/);
    }
  });
});

describe("verrou sandbox — déverrouillage EXPLICITE", () => {
  it("accepte une config PROD cohérente quand OMNIFI_AUTORISER_PRODUCTION=\"1\"", () => {
    poserEnv({
      ...BASE_SANDBOX,
      OMNIFI_ENV: "production",
      OMNIFI_BASE_URL: HOTE_PROD,
      OMNIFI_AUTORISER_PRODUCTION: "1",
    });
    const config = obtenirConfigOmniFi();
    expect(config.environment).toBe("production");
    expect(config.baseUrl).toBe(HOTE_PROD);
  });

  it("laisse la sandbox fonctionner même drapeau posé (le flag n'impose pas la prod)", () => {
    poserEnv({ ...BASE_SANDBOX, OMNIFI_AUTORISER_PRODUCTION: "1" });
    expect(obtenirConfigOmniFi().environment).toBe("sandbox");
  });
});

describe("garde de cohérence env↔hôte (active DRAPEAU POSÉ)", () => {
  it("refuse OMNIFI_ENV=production sur un hôte sandbox, même déverrouillé", () => {
    poserEnv({
      ...BASE_SANDBOX,
      OMNIFI_ENV: "production",
      OMNIFI_BASE_URL: HOTE_SANDBOX,
      OMNIFI_AUTORISER_PRODUCTION: "1",
    });
    expect(() => obtenirConfigOmniFi()).toThrow(/Incohérence/);
  });

  it("refuse OMNIFI_ENV=sandbox sur un hôte de prod, drapeau posé", () => {
    // Drapeau posé → le verrou ne mord plus ; c'est la garde de cohérence qui
    // attrape l'incohérence sandbox↔hôte-de-prod.
    poserEnv({
      ...BASE_SANDBOX,
      OMNIFI_BASE_URL: HOTE_PROD,
      OMNIFI_AUTORISER_PRODUCTION: "1",
    });
    expect(() => obtenirConfigOmniFi()).toThrow(/Incohérence/);
  });
});

describe("validation anti-fuite de secret (reste active dans les deux modes)", () => {
  it("refuse un hôte hors allow-list", () => {
    poserEnv({ ...BASE_SANDBOX, OMNIFI_BASE_URL: "https://evil.example.com" });
    expect(() => obtenirConfigOmniFi()).toThrow(/non autorisé/);
  });

  it("refuse un userinfo dans la base URL (détournement d'hôte)", () => {
    poserEnv({
      ...BASE_SANDBOX,
      OMNIFI_BASE_URL: "https://user:pass@api-stage.omni-fi.co",
    });
    expect(() => obtenirConfigOmniFi()).toThrow(/identifiants/);
  });

  it("refuse http:// (la clé ApiKey transite en clair)", () => {
    poserEnv({ ...BASE_SANDBOX, OMNIFI_BASE_URL: "http://api-stage.omni-fi.co" });
    expect(() => obtenirConfigOmniFi()).toThrow(/https/);
  });

  it("refuse un OMNIFI_ENV inconnu", () => {
    poserEnv({ ...BASE_SANDBOX, OMNIFI_ENV: "staging" });
    expect(() => obtenirConfigOmniFi()).toThrow(/OMNIFI_ENV invalide/);
  });
});
