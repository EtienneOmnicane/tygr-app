/**
 * Intégration connexion — le chaînon entre les tests unitaires (deps mockées)
 * et la validation live : cœur de vérification + repository RÉEL (PGlite,
 * migrations réelles, rôle non-owner) + VRAI argon2.
 *
 * Couvre notamment la régression E2E du 2026-06-12 : Auth.js passe le corps
 * complet du POST à authorize() — extraireIdentifiants doit en faire une
 * entrée acceptée par le schéma .strict() du cœur.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import argon2 from "argon2";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { SEUIL_VERROUILLAGE, VERROU_BASE_MS } from "@/server/auth/lockout";
import {
  extraireIdentifiants,
  verifierIdentifiants,
  type DepsVerification,
} from "@/lib/auth/verifier-identifiants";
import { creerRepositoryIdentite } from "@/repositories/identite";

const client = new PGlite();
const db = drizzle(client, { schema });
const identite = creerRepositoryIdentite(db);

const EMAIL = "alice@groupe.mu";
const MOT_DE_PASSE = "S3cret-valide-pour-test";
const IP = "203.0.113.99";

// Horloge contrôlée, mutable — permet de "voyager" après l'expiration du verrou.
let horloge = new Date("2026-06-12T10:00:00.000Z");

const deps: DepsVerification = {
  identite,
  verifierMotDePasse: (hash, mdp) => argon2.verify(hash, mdp).catch(() => false),
  maintenant: () => horloge,
};

beforeAll(async () => {
  const migrationsDir = path.join(process.cwd(), "drizzle", "migrations");
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const raw = readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of raw.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await client.exec(statement);
      }
    }
  }
  const hash = await argon2.hash(MOT_DE_PASSE);
  await client.query(
    `insert into users (email, full_name, password_hash) values ($1, 'Alice Manager', $2)`,
    [EMAIL, hash],
  );
  // Conditions de production : rôle applicatif non-propriétaire.
  await client.exec(`
    create role tygr_app nologin;
    grant usage on schema public to tygr_app;
    grant select, insert, update, delete on all tables in schema public to tygr_app;
    set role tygr_app;
  `);
});

afterAll(async () => {
  await client.close();
});

describe("régression E2E 2026-06-12 — corps complet Auth.js", () => {
  it("extraireIdentifiants(corps complet) → connexion acceptée malgré csrfToken/callbackUrl", async () => {
    const corpsAuthJs = {
      email: EMAIL,
      motDePasse: MOT_DE_PASSE,
      csrfToken: "jeton-csrf-quelconque",
      callbackUrl: "http://localhost:3000/login",
    };
    const r = await verifierIdentifiants(
      deps,
      extraireIdentifiants(corpsAuthJs),
      IP,
    );
    expect(r.ok).toBe(true);
  });

  it("contre-épreuve : le même corps SANS extraction est rejeté par le schéma strict", async () => {
    const r = await verifierIdentifiants(
      deps,
      { email: EMAIL, motDePasse: MOT_DE_PASSE, csrfToken: "x" },
      IP,
    );
    expect(r).toEqual({ ok: false, code: "ENTREE_INVALIDE" });
  });
});

describe("cycle de verrouillage complet (vrai argon2, vraie base)", () => {
  it("5 échecs → verrou ; bon mot de passe rejeté sous verrou ; compteur figé", async () => {
    for (let i = 0; i < SEUIL_VERROUILLAGE; i++) {
      const r = await verifierIdentifiants(
        deps,
        { email: EMAIL, motDePasse: "faux-mdp" },
        IP,
      );
      expect(r.ok).toBe(false);
    }
    let u = await identite.trouverParEmail(EMAIL);
    expect(u?.failedLoginCount).toBe(SEUIL_VERROUILLAGE);
    expect(u?.lockedUntil).toEqual(
      new Date(horloge.getTime() + VERROU_BASE_MS),
    );

    const sousVerrou = await verifierIdentifiants(
      deps,
      { email: EMAIL, motDePasse: MOT_DE_PASSE },
      IP,
    );
    expect(sousVerrou).toEqual({ ok: false, code: "COMPTE_VERROUILLE" });
    u = await identite.trouverParEmail(EMAIL);
    expect(u?.failedLoginCount).toBe(SEUIL_VERROUILLAGE); // figé
  });

  it("verrou expiré → le bon mot de passe passe et remet tout à zéro", async () => {
    horloge = new Date(horloge.getTime() + VERROU_BASE_MS); // borne stricte : levé à l'instant exact
    const r = await verifierIdentifiants(
      deps,
      { email: EMAIL, motDePasse: MOT_DE_PASSE },
      IP,
    );
    expect(r.ok).toBe(true);
    const u = await identite.trouverParEmail(EMAIL);
    expect(u?.failedLoginCount).toBe(0);
    expect(u?.lockedUntil).toBeNull();
  });

  it("la limite IP se déclenche sur la fenêtre réelle de login_attempts", async () => {
    // enregistrerTentativeIp horodate en defaultNow() (heure réelle) alors que
    // l'horloge du test est fictive : on insère les tentatives avec un
    // attempted_at EXPLICITE aligné sur l'horloge contrôlée (en owner, comme
    // un seed), puis on vérifie le rejet pré-lookup via le cœur.
    await client.exec(`reset role;`);
    const t = horloge.toISOString();
    for (let i = 0; i < 20; i++) {
      await client.query(
        `insert into login_attempts (ip, succeeded, attempted_at) values ($1, false, $2)`,
        [IP, t],
      );
    }
    await client.exec(`set role tygr_app;`);
    const r = await verifierIdentifiants(
      deps,
      { email: EMAIL, motDePasse: MOT_DE_PASSE },
      IP,
    );
    expect(r).toEqual({ ok: false, code: "LIMITE_IP_ATTEINTE" });
    // Et une IP propre passe toujours.
    const ok = await verifierIdentifiants(
      deps,
      { email: EMAIL, motDePasse: MOT_DE_PASSE },
      "203.0.113.100",
    );
    expect(ok.ok).toBe(true);
  });
});
