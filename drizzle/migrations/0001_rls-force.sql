-- FORCE ROW LEVEL SECURITY : applique la RLS y compris au propriétaire de la
-- table (défense en profondeur, plan v2.1 / CLAUDE.md règle 2). drizzle-kit ne
-- sait pas émettre FORCE — migration custom maintenue à la main.
ALTER TABLE "workspace_members" FORCE ROW LEVEL SECURITY;
