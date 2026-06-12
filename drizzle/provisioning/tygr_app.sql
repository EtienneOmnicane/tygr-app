-- Provisioning du rôle applicatif `tygr_app` (dette P0-b — spec
-- docs/specs/provisioning-tygr-app.md). Appliqué avec DATABASE_URL_ADMIN (owner)
-- AVANT `migrate`, via `npm run db:provision`. PAS une migration Drizzle
-- numérotée : un rôle est un objet d'instance, pas du schéma applicatif — les
-- mêler casserait le rejeu expand-contract (CLAUDE.md règle 9).
--
-- Source UNIQUE de vérité du rôle : ce script est aussi consommé par la suite
-- d'isolation (beforeAll) pour qu'aucune définition divergente ne subsiste.
--
-- Idempotent : ré-exécutable sans erreur ni dérive d'état.
-- Secret (C4) : AUCUN mot de passe en dur. Le rôle est créé LOGIN ; le mot de
-- passe est posé hors de ce script (Neon UI / `ALTER ROLE tygr_app PASSWORD ...`
-- alimenté par un secret d'environnement), jamais commité.

-- 1. Le rôle, créé une seule fois. NOLOGIN par défaut ici : l'octroi de LOGIN +
--    mot de passe est une étape d'exploitation séparée (C4) pour ne jamais
--    matérialiser un compte connectable sans secret. En test (PGlite, pas de
--    connexion réseau), NOLOGIN suffit.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tygr_app') THEN
    CREATE ROLE tygr_app NOLOGIN;
  END IF;
END
$$;

-- 2. Accès au schéma.
GRANT USAGE ON SCHEMA public TO tygr_app;

-- 3. GRANT explicite sur les tables DÉJÀ existantes (C3, piège R2 de la revue
--    Eng) : ALTER DEFAULT PRIVILEGES ci-dessous ne couvre QUE les tables créées
--    APRÈS lui. Les tables des migrations 0000/0002 existent déjà sur une base
--    migrée — sans ce GRANT explicite, tygr_app perdrait l'accès en lecture.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tygr_app;

-- 4. DEFAULT PRIVILEGES pour les tables FUTURES (transactions_cache, soldes EOD…
--    des semaines 3-5). « FOR ROLE » fige le propriétaire qui créera ces tables :
--    les migrations Drizzle tournent sous l'owner DATABASE_URL_ADMIN, donc on
--    cible CURRENT_USER (= l'owner qui exécute ce script).
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tygr_app;

-- NB déploiement : ce script est ADDITIF (CREATE IF NOT EXISTS, GRANT) — aucun
-- DROP. Ordre de pipeline non négociable : db:provision -> migrate -> deploy.
