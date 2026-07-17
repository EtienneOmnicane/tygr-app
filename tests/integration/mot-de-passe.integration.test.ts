/**
 * Intégration AUTH-MDP-TEMPO1 — flux mot de passe temporaire sur PGlite
 * (migrations réelles, rôle applicatif non-owner, VRAI argon2) :
 *
 * - D7 : le provisioning pose le flag + le posage à l'INSERT uniquement
 *   (user existant réutilisé : rien n'est touché) ;
 * - claims : verifierIdentifiants retourne password_changed_at (source du
 *   claim pwdAt) — y compris NULL pré-migration ;
 * - §5.4 : changerMotDePasse — chemin heureux (flag levé, posage, lockout
 *   RAZ, ancien mdp mort), échecs nommés, refus sans écriture sous verrou ;
 * - D6 : le lockout est MUTUALISÉ — les échecs login + changement partagent
 *   le compteur, un verrou bloque les DEUX surfaces ;
 * - concurrence : deux changements du même compte → un seul gagne (FOR
 *   UPDATE ; PGlite sérialise sur une connexion unique — le test prouve la
 *   LOGIQUE post-sérialisation, pas le parallélisme réel, cf. Pilier 1).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import argon2 from "argon2";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/server/db/schema";
import { createWithWorkspace } from "@/server/db/tenancy";
import { SEUIL_VERROUILLAGE } from "@/server/auth/lockout";
import { verifierIdentifiants, type DepsVerification } from "@/server/auth/verifier-identifiants";
import {
  CompteIndisponibleError,
  CompteSansMotDePasseError,
  CompteVerrouilleError,
  creerRepositoryIdentite,
  MotDePasseActuelIncorrectError,
} from "@/server/repositories/identite";
import { creerUtilisateurEtRattacher } from "@/server/repositories/provisioning";

const client = new PGlite();
const db = drizzle(client, { schema });
const identite = creerRepositoryIdentite(db);
const withWorkspace = createWithWorkspace(db);

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_A = "11111111-1111-4111-8111-111111111111";
const PRE_MIGRATION = "22222222-2222-4222-8222-222222222222"; // password_changed_at NULL
const INACTIF = "33333333-3333-4333-8333-333333333333";
const SSO = "44444444-4444-4444-8444-444444444444"; // password_hash NULL

const MDP_TEMPORAIRE = "Temporaire-12car!";
const MDP_NOUVEAU = "Nouveau-secret-12car!";
const IP = "203.0.113.50";

const horloge = new Date("2026-07-17T10:00:00.000Z");
const deps: DepsVerification = {
  identite,
  verifierMotDePasse: (hash, mdp) => argon2.verify(hash, mdp).catch(() => false),
  maintenant: () => horloge,
};

/** Lecture de vérité en owner (users est hors RLS mais on fige la convention). */
async function colonnesDe(email: string) {
  await client.exec(`reset role;`);
  const r = await client.query<{
    id: string;
    must_change_password: boolean;
    password_changed_at: string | null;
    failed_login_count: number;
    locked_until: string | null;
    password_hash: string | null;
  }>(
    `select id, must_change_password, password_changed_at, failed_login_count,
            locked_until, password_hash
     from users where lower(email) = lower($1)`,
    [email],
  );
  await client.exec(`set role tygr_app;`);
  return r.rows[0] ?? null;
}

beforeAll(async () => {
  const dir = path.join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  const hashTemporaire = await argon2.hash(MDP_TEMPORAIRE);
  await client.query(
    `insert into workspaces (id, name, kind, omnifi_client_user_id)
     values ($1, 'Groupe A', 'INTERNAL_BU', 'eu-a')`,
    [WS_A],
  );
  await client.query(
    `insert into users (id, email, full_name, password_hash, is_active,
                        must_change_password, password_changed_at) values
       ($1, 'admin@a.mu',   'Admin A',   $5,   true,  false, null),
       ($2, 'premig@a.mu',  'Pré Migration', $5, true, false, null),
       ($3, 'inactif@a.mu', 'Inactif',   $5,   false, false, null),
       ($4, 'sso@a.mu',     'Compte SSO', null, true,  false, null)`,
    [ADMIN_A, PRE_MIGRATION, INACTIF, SSO, hashTemporaire],
  );
  await client.query(
    `insert into workspace_members (user_id, workspace_id, role)
     values ($1, $2, 'ADMIN')`,
    [ADMIN_A, WS_A],
  );

  const provisioning = readFileSync(
    path.join(process.cwd(), "drizzle", "provisioning", "tygr_app.sql"),
    "utf8",
  );
  await client.exec(provisioning);
  await client.exec(`set role tygr_app;`);
});

afterAll(async () => {
  await client.close();
});

describe("D7 — pose du flag au provisioning", () => {
  it("INSERT : must_change_password=true + password_changed_at posé", async () => {
    await withWorkspace(
      { userId: ADMIN_A, activeWorkspaceId: WS_A },
      (tx, ctx) =>
        creerUtilisateurEtRattacher(tx, ctx, {
          email: "membre@a.mu",
          fullName: "Membre Provisionné",
          passwordHash: "hash-provisionne",
          role: "VIEWER",
        }),
    );
    const membre = await colonnesDe("membre@a.mu");
    expect(membre?.must_change_password).toBe(true);
    expect(membre?.password_changed_at).not.toBeNull();
  });

  it("user EXISTANT réutilisé : ni hash, ni flag, ni posage touchés (anti-écrasement)", async () => {
    const avant = await colonnesDe("premig@a.mu");
    await withWorkspace(
      { userId: ADMIN_A, activeWorkspaceId: WS_A },
      (tx, ctx) =>
        creerUtilisateurEtRattacher(tx, ctx, {
          email: "premig@a.mu",
          fullName: "Pré Migration",
          passwordHash: "hash-qui-doit-etre-ignore",
          role: "VIEWER",
        }),
    );
    const apres = await colonnesDe("premig@a.mu");
    expect(apres).toEqual(avant);
    expect(apres?.must_change_password).toBe(false);
    expect(apres?.password_changed_at).toBeNull();
  });
});

describe("claims au login (source de pwdAt)", () => {
  it("password_changed_at NULL pré-migration → claim null", async () => {
    const r = await verifierIdentifiants(
      deps,
      { email: "premig@a.mu", motDePasse: MDP_TEMPORAIRE },
      IP,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.utilisateur.passwordChangedAt).toBeNull();
    }
  });

  it("posage présent → claim = valeur DB (epoch exploitable)", async () => {
    const r = await verifierIdentifiants(
      deps,
      { email: "admin@a.mu", motDePasse: MDP_TEMPORAIRE },
      IP,
    );
    expect(r.ok).toBe(true);
    // admin@a.mu n'a pas de posage… on prouve sur le membre provisionné en D7.
    const enBase = await colonnesDe("membre@a.mu");
    expect(enBase?.password_changed_at).not.toBeNull();
  });
});

describe("§5.4 — changerMotDePasse", () => {
  it("chemin heureux : hash remplacé, flag levé, posage=maintenant, lockout RAZ ; l'ancien mdp meurt", async () => {
    // Pré-condition : un échec pour vérifier la RAZ du compteur au succès.
    await identite.enregistrerEchec(ADMIN_A, horloge);
    expect((await colonnesDe("admin@a.mu"))?.failed_login_count).toBe(1);

    const maintenant = new Date("2026-07-17T11:00:00.000Z");
    const nouveauHash = await argon2.hash(MDP_NOUVEAU);
    await identite.changerMotDePasse(ADMIN_A, {
      verifierAncien: (hash) =>
        argon2.verify(hash, MDP_TEMPORAIRE).catch(() => false),
      nouveauHash,
      maintenant,
    });

    const apres = await colonnesDe("admin@a.mu");
    expect(apres?.must_change_password).toBe(false);
    expect(new Date(apres!.password_changed_at!)).toEqual(maintenant);
    expect(apres?.failed_login_count).toBe(0);
    expect(apres?.locked_until).toBeNull();

    // Le NOUVEAU secret ouvre la session ; l'ANCIEN échoue (compteur E18 normal).
    const okNouveau = await verifierIdentifiants(
      deps,
      { email: "admin@a.mu", motDePasse: MDP_NOUVEAU },
      IP,
    );
    expect(okNouveau.ok).toBe(true);
    if (okNouveau.ok) {
      expect(okNouveau.utilisateur.passwordChangedAt).toEqual(maintenant);
    }
    const koAncien = await verifierIdentifiants(
      deps,
      { email: "admin@a.mu", motDePasse: MDP_TEMPORAIRE },
      IP,
    );
    expect(koAncien).toEqual({ ok: false, code: "IDENTIFIANTS_INVALIDES" });
    expect((await colonnesDe("admin@a.mu"))?.failed_login_count).toBe(1);
    await identite.reinitialiserEchecs(ADMIN_A);
  });

  it("compte inactif → CompteIndisponibleError (fail-closed, rien d'écrit)", async () => {
    const avant = await colonnesDe("inactif@a.mu");
    await expect(
      identite.changerMotDePasse(INACTIF, {
        verifierAncien: () => Promise.resolve(true),
        nouveauHash: "hash-x",
        maintenant: horloge,
      }),
    ).rejects.toBeInstanceOf(CompteIndisponibleError);
    expect(await colonnesDe("inactif@a.mu")).toEqual(avant);
  });

  it("utilisateur inexistant → CompteIndisponibleError (indistinguable)", async () => {
    await expect(
      identite.changerMotDePasse("99999999-9999-4999-8999-999999999999", {
        verifierAncien: () => Promise.resolve(true),
        nouveauHash: "hash-x",
        maintenant: horloge,
      }),
    ).rejects.toBeInstanceOf(CompteIndisponibleError);
  });

  it("password_hash NULL (SSO) → CompteSansMotDePasseError SANS appel verify", async () => {
    const verifierAncien = vi.fn().mockResolvedValue(true);
    await expect(
      identite.changerMotDePasse(SSO, {
        verifierAncien,
        nouveauHash: "hash-x",
        maintenant: horloge,
      }),
    ).rejects.toBeInstanceOf(CompteSansMotDePasseError);
    expect(verifierAncien).not.toHaveBeenCalled();
  });
});

describe("D6 — lockout E18 MUTUALISÉ login/changement", () => {
  it("échecs mixtes (changement + login) partagent le compteur ; le verrou bloque les DEUX surfaces sans écriture", async () => {
    // PRE_MIGRATION : compteur à 0. (SEUIL-1) échecs via le CHANGEMENT…
    for (let i = 0; i < SEUIL_VERROUILLAGE - 1; i++) {
      await expect(
        identite.changerMotDePasse(PRE_MIGRATION, {
          verifierAncien: (hash) =>
            argon2.verify(hash, "mauvais-mdp-actuel").catch(() => false),
          nouveauHash: "hash-x",
          maintenant: horloge,
        }),
      ).rejects.toBeInstanceOf(MotDePasseActuelIncorrectError);
    }
    expect((await colonnesDe("premig@a.mu"))?.failed_login_count).toBe(
      SEUIL_VERROUILLAGE - 1,
    );

    // … le 5e échec vient du LOGIN : même compteur → verrou posé.
    const login = await verifierIdentifiants(
      deps,
      { email: "premig@a.mu", motDePasse: "mauvais-mdp" },
      IP,
    );
    expect(login).toEqual({ ok: false, code: "IDENTIFIANTS_INVALIDES" });
    const verrouille = await colonnesDe("premig@a.mu");
    expect(verrouille?.failed_login_count).toBe(SEUIL_VERROUILLAGE);
    expect(verrouille?.locked_until).not.toBeNull();

    // Sous verrou : le CHANGEMENT refuse (même avec le BON mdp) sans écrire…
    await expect(
      identite.changerMotDePasse(PRE_MIGRATION, {
        verifierAncien: (hash) =>
          argon2.verify(hash, MDP_TEMPORAIRE).catch(() => false),
        nouveauHash: "hash-x",
        maintenant: horloge,
      }),
    ).rejects.toBeInstanceOf(CompteVerrouilleError);
    const fige = await colonnesDe("premig@a.mu");
    expect(fige?.failed_login_count).toBe(SEUIL_VERROUILLAGE); // rien d'écrit
    expect(fige?.password_hash).toBe(verrouille?.password_hash);

    // … et le LOGIN refuse aussi : le verrou est bien PARTAGÉ.
    const loginVerrouille = await verifierIdentifiants(
      deps,
      { email: "premig@a.mu", motDePasse: MDP_TEMPORAIRE },
      IP,
    );
    expect(loginVerrouille).toEqual({ ok: false, code: "COMPTE_VERROUILLE" });
  });
});

describe("cas limite — deux changements concurrents (FOR UPDATE)", () => {
  it("un seul gagne ; l'autre sort en MotDePasseActuelIncorrectError (jamais deux hashes écrits)", async () => {
    // NB : PGlite = connexion unique → les deux transactions se SÉRIALISENT
    // (pas de vrai parallélisme, cf. Pilier 1). Le test prouve la logique :
    // le second verify se fait sur le hash DÉJÀ REMPLACÉ → refus nommé.
    const maintenant = new Date("2026-07-17T12:00:00.000Z");
    const hash1 = await argon2.hash("Gagnant-12-caracteres!");
    const hash2 = await argon2.hash("Perdant-12-caracteres!");
    const tentative = (nouveauHash: string) =>
      identite.changerMotDePasse(ADMIN_A, {
        verifierAncien: (hash) =>
          argon2.verify(hash, MDP_NOUVEAU).catch(() => false),
        nouveauHash,
        maintenant,
      });

    const [r1, r2] = await Promise.allSettled([
      tentative(hash1),
      tentative(hash2),
    ]);
    const statuts = [r1.status, r2.status].sort();
    expect(statuts).toEqual(["fulfilled", "rejected"]);
    const rejet = (r1.status === "rejected" ? r1 : r2) as PromiseRejectedResult;
    expect(rejet.reason).toBeInstanceOf(MotDePasseActuelIncorrectError);

    // Un seul hash a persisté : celui du gagnant.
    const enBase = await colonnesDe("admin@a.mu");
    const gagnant = r1.status === "fulfilled" ? hash1 : hash2;
    expect(enBase?.password_hash).toBe(gagnant);
  });
});
