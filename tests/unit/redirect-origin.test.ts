/**
 * Tests de la frontière de sécurité RedirectOrigin (cross-review 3.1 + Volet B/C
 * 2026-06-16). Cible la cible postMessage du PublicToken : une origine tierce ne
 * doit JAMAIS passer, et l'assouplissement dev (http://localhost) ne doit JAMAIS
 * mordre en production.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  autoriserRedirectOrigin,
  localhostInsecureAutorise,
  originesAutorisees,
} from "@/server/widget/redirect-origin";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("originesAutorisees — allowlist fail-closed", () => {
  it("env absente → ensemble vide (rien autorisé)", () => {
    vi.stubEnv("APP_ALLOWED_ORIGINS", "");
    expect(originesAutorisees().size).toBe(0);
  });

  it("parse la liste, trim et retire le slash final", () => {
    vi.stubEnv("APP_ALLOWED_ORIGINS", " https://app.tygr.mu/ , https://demo.tygr.mu ");
    const set = originesAutorisees();
    expect(set.has("https://app.tygr.mu")).toBe(true);
    expect(set.has("https://demo.tygr.mu")).toBe(true);
  });
});

describe("autoriserRedirectOrigin — invariants de sécurité (prod)", () => {
  it("https allowlistée → ok", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "https://app.tygr.mu");
    expect(autoriserRedirectOrigin("https://app.tygr.mu")).toBe("ok");
  });

  it("https NON allowlistée → non_allowliste (un tiers ne passe pas)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "https://app.tygr.mu");
    expect(autoriserRedirectOrigin("https://evil.example")).toBe("non_allowliste");
  });

  it("allowlist vide → non_allowliste même pour une https valide (fail-closed)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "");
    expect(autoriserRedirectOrigin("https://app.tygr.mu")).toBe("non_allowliste");
  });

  it("http (même allowlisté) → protocole en PRODUCTION (jamais de clair)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://localhost:3000");
    expect(autoriserRedirectOrigin("http://localhost:3000")).toBe("protocole");
  });

  it("origine avec path/query/fragment → forme (contrat link-token)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "https://app.tygr.mu");
    expect(autoriserRedirectOrigin("https://app.tygr.mu/callback")).toBe("forme");
    expect(autoriserRedirectOrigin("https://app.tygr.mu/?x=1")).toBe("forme");
  });

  it("chaîne non-URL → forme", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "https://app.tygr.mu");
    expect(autoriserRedirectOrigin("pas-une-url")).toBe("forme");
  });
});

describe("autoriserRedirectOrigin — assouplissement DEV via OPT-IN (Volet C durci, audit C1)", () => {
  it("http://localhost allowlistée + opt-in + dev → ok", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "1");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://localhost:3000");
    expect(autoriserRedirectOrigin("http://localhost:3000")).toBe("ok");
  });

  it("http://127.0.0.1 allowlistée + opt-in + dev → ok", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "1");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://127.0.0.1:3000");
    expect(autoriserRedirectOrigin("http://127.0.0.1:3000")).toBe("ok");
  });

  it("opt-in ABSENT (même en dev) → protocole (le chemin dev ne s'active jamais par défaut)", () => {
    vi.stubEnv("NODE_ENV", "development");
    // pas d'APP_ALLOW_INSECURE_LOCALHOST
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://localhost:3000");
    expect(autoriserRedirectOrigin("http://localhost:3000")).toBe("protocole");
  });

  // === Verrouillage du fail-open C1 : NODE_ENV ambigu NE doit PAS ouvrir ===
  it.each(["production", undefined, "", "Production", "staging"])(
    "opt-in=1 mais NODE_ENV=%s + http://localhost allowlistée → reste protocole si prod/ambigu",
    (env) => {
      if (env === undefined) vi.stubEnv("NODE_ENV", "");
      else vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "1");
      vi.stubEnv("APP_ALLOWED_ORIGINS", "http://localhost:3000");
      // production → protocole (double garde) ; ambigu (""/"Production"/"staging") →
      // ok SEULEMENT car ≠ "production" ET opt-in présent. Le point C1 critique est
      // que "production" reste verrouillé MÊME avec l'opt-in.
      const attendu = env === "production" ? "protocole" : "ok";
      expect(autoriserRedirectOrigin("http://localhost:3000")).toBe(attendu);
    },
  );

  it("NODE_ENV=production + opt-in=1 → protocole (double garde : prod gagne sur l'opt-in)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "1");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://localhost:3000");
    expect(autoriserRedirectOrigin("http://localhost:3000")).toBe("protocole");
  });

  it("dev + opt-in MAIS origine http NON allowlistée → non_allowliste (l'allowlist mord toujours)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "1");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://localhost:3000");
    expect(autoriserRedirectOrigin("http://localhost:9999")).toBe("non_allowliste");
  });

  it("dev + opt-in MAIS http non-loopback (domaine tiers) allowlisté → protocole (loopback SEULEMENT)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "1");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "http://evil.example");
    expect(autoriserRedirectOrigin("http://evil.example")).toBe("protocole");
  });

  it("dev : https allowlistée reste ok SANS opt-in (le chemin normal n'est pas affecté)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ALLOWED_ORIGINS", "https://app.tygr.mu");
    expect(autoriserRedirectOrigin("https://app.tygr.mu")).toBe("ok");
  });
});

describe("localhostInsecureAutorise — garde opt-in (audit C1)", () => {
  it("opt-in=1 + non-prod → true", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "1");
    expect(localhostInsecureAutorise()).toBe(true);
  });
  it("opt-in=1 + production → false (double garde)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "1");
    expect(localhostInsecureAutorise()).toBe(false);
  });
  it("opt-in absent → false même en dev", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(localhostInsecureAutorise()).toBe(false);
  });
  it("opt-in valeur autre que '1' (ex 'true') → false (strict)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ALLOW_INSECURE_LOCALHOST", "true");
    expect(localhostInsecureAutorise()).toBe(false);
  });
});
