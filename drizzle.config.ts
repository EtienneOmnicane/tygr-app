import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  // Migrations appliquées avec le rôle owner (DATABASE_URL_ADMIN), jamais
  // tygr_app — CLAUDE.md règle 2 (liste fermée d'exceptions).
  dbCredentials: {
    url: process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL ?? "",
  },
  entities: { roles: true },
});
