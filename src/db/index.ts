/**
 * Connexion Neon Serverless — E16 / CLAUDE.md règle 8 :
 * Pool WebSocket UNIQUEMENT. `SET LOCAL`/set_config(…, true) exige de vraies
 * transactions multi-statements sur une même connexion ; le mode HTTP
 * (drizzle-orm/neon-http) ne les fournit pas et ferait silencieusement
 * tomber l'étage RLS. Toute migration vers un autre driver doit re-passer
 * le test d'intégration `set_config visible dans la transaction`.
 *
 * DATABASE_URL = chaîne POOLÉE Neon (pooler en mode transaction), rôle
 * `tygr_app` soumis à RLS — jamais le rôle owner (réservé aux migrations,
 * DATABASE_URL_ADMIN).
 */
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

import { createWithWorkspace } from "@/lib/tenancy";
import { creerRepositoryIdentite } from "@/repositories/identite";

import * as schema from "./schema";

// Node ≥22 expose WebSocket nativement ; sur Vercel Edge/Node récent,
// le driver le détecte. On le câble explicitement pour lever toute ambiguïté.
if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL manquante — voir .env.example (chaîne poolée Neon, rôle tygr_app)",
    );
  }
  return url;
}

const pool = new Pool({ connectionString: requireDatabaseUrl() });

export const db = drizzle(pool, { schema });

/** Point d'entrée unique de l'accès aux données (CLAUDE.md règle 2). */
export const withWorkspace = createWithWorkspace(db);

/** Accès identité pré-contexte (login, re-validation E6) — voir le repository. */
export const identite = creerRepositoryIdentite(db);

export { schema };
