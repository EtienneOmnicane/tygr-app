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
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ DELETE = LISTE BLANCHE (deny-by-default) — garantie tombstone #3bis        │
-- ├──────────────────────────────────────────────────────────────────────────┤
-- │ Les tables APPEND-ONLY `transactions_cache` (+ partitions) et             │
-- │ `balance_history` ne doivent JAMAIS recevoir DELETE : l'effacement y est   │
-- │ logique (is_removed=true via UPDATE), jamais physique (CLAUDE.md règle 8). │
-- │                                                                            │
-- │ L'ancienne stratégie « GRANT DELETE ON ALL TABLES + REVOKE en migration »  │
-- │ était fragile : (a) dépendante de l'ordre provision/migrate (un           │
-- │ db:provision rejoué ré-accordait DELETE) ; (b) un REVOKE sur la table mère │
-- │ partitionnée NE se propage PAS aux partitions (vérifié PGlite : la         │
-- │ partition garde DELETE) — toute partition future rouvrait le trou.         │
-- │                                                                            │
-- │ On n'accorde donc JAMAIS DELETE en bloc. DELETE est octroyé table par      │
-- │ table, UNIQUEMENT sur les tables qui en ont un besoin légitime (cascades   │
-- │ FK / offboarding RGPD / purge login_attempts). Toute table append-only —   │
-- │ présente OU FUTURE (roulement de partitions) — est protégée par défaut,    │
-- │ sans rien avoir à révoquer. Le REVOKE de la migration 0003 demeure comme   │
-- │ ceinture + intention documentée, mais n'est plus le seul rempart.          │
-- └──────────────────────────────────────────────────────────────────────────┘

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

-- 3. Privilèges de BASE sur les tables DÉJÀ existantes (C3, piège R2 de la revue
--    Eng) : ALTER DEFAULT PRIVILEGES ci-dessous ne couvre QUE les tables créées
--    APRÈS lui. Les tables des migrations existantes existent déjà sur une base
--    migrée — sans ce GRANT explicite, tygr_app perdrait l'accès.
--    DELETE est VOLONTAIREMENT EXCLU de ce GRANT global (deny-by-default, cf.
--    encart ci-dessus) ; il est accordé sélectivement à l'étape 5.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO tygr_app;

-- 4. DEFAULT PRIVILEGES pour les tables FUTURES. « FOR ROLE » fige le
--    propriétaire qui créera ces tables : les migrations Drizzle tournent sous
--    l'owner DATABASE_URL_ADMIN, donc on cible CURRENT_USER (= l'owner qui
--    exécute ce script). DELETE EXCLU des defaults : une table append-only
--    future (ou une partition de roulement) est protégée sans intervention.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO tygr_app;

-- 5. DELETE — liste blanche EXPLICITE. Uniquement les tables avec un besoin
--    légitime de suppression physique :
--      - workspaces / users         : offboarding (cascade vers workspace_members)
--      - workspace_members          : retrait d'un membre d'un workspace
--      - login_attempts             : purge périodique de la fenêtre (cron, dette TODOS)
--      - bank_connections           : déconnexion d'une banque (cascade vers bank_accounts)
--      - bank_accounts              : cascade depuis bank_connections / dé-rattachement
--      - categories                 : référentiel éditable (Pilier 1)
--      - categorization_rules        : règles de catégorisation éditables (config
--                                     workspace, NON append-only — l'app archive
--                                     via is_active, mais le DELETE physique d'une
--                                     règle obsolète est légitime ; FK composite
--                                     vers categories en ON DELETE no action)
--      - transaction_categorizations: splits éditables (correction de catégorie, Pilier 1)
--      - entities                   : référentiel d'entités (BU) éditable (archivage
--                                     logique is_active ; un DELETE physique reste
--                                     possible pour une entité JAMAIS référencée —
--                                     les FK composites en ON DELETE RESTRICT
--                                     protègent celles qui le sont)
--      - member_entity_scopes       : table de DROITS (Vision Entité, N:N) éditable —
--                                     révoquer/réattribuer un périmètre = DELETE
--                                     légitime ; NON append-only
--    ABSENTES par dessein (append-only, jamais de DELETE) :
--      - transactions_cache (+ partitions transactions_cache_YYYY, _default)
--      - balance_history
--      - categorization_audit       (append-only : ni UPDATE ni DELETE — étape 6)
--    Le code applicatif n'émet à ce jour AUCUN DELETE (vérifié) ; ces GRANTs
--    couvrent les cascades FK et l'offboarding RGPD à venir sans rouvrir
--    l'append-only.
--
--    CONDITIONNEL (to_regclass IS NOT NULL), pour les DEUX ordres de pipeline :
--      - prod base neuve (provision→migrate) : les tables n'existent pas encore
--        au 1er provision → ces GRANT sont sautés sans erreur ; ils prennent
--        effet au re-provision post-migrate (le provisioning est idempotent et
--        re-jouable, cf. spec §C2). Entre-temps les tables naissent SANS DELETE
--        (étape 4 sans DELETE) — fail-closed, jamais d'octroi non voulu.
--      - base déjà migrée (migrate→provision, cas Neon/local et tests) : les
--        tables existent → DELETE est accordé immédiatement.
--    On n'utilise délibérément PAS `GRANT … ON ALL TABLES` ici : il engloberait
--    transactions_cache, ses partitions et balance_history. Un REVOKE de
--    rattrapage ne se propage PAS aux partitions (vérifié PGlite) — d'où
--    l'énumération stricte des seules tables autorisées.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspaces',
    'users',
    'login_attempts',
    'workspace_members',
    'bank_connections',
    'bank_accounts',
    'categories',
    'categorization_rules',
    'transaction_categorizations',
    'entities',
    'member_entity_scopes'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT DELETE ON public.%I TO tygr_app', t);
    END IF;
  END LOOP;
END
$$;

-- 6. APPEND-ONLY au niveau PRIVILÈGE (deny-by-default, comme #3bis pour DELETE) :
--    `categorization_audit` est immuable → tygr_app ne doit avoir NI UPDATE NI
--    DELETE dessus, seulement INSERT/SELECT. L'étape 3 a accordé UPDATE en bloc
--    (`ON ALL TABLES`) ; on le RETIRE ici. Le trigger 0005 est la défense de
--    fond ; ce REVOKE est la ceinture de privilège (double garde). Conditionnel
--    à l'existence (mêmes deux ordres de pipeline que l'étape 5).
DO $$
BEGIN
  IF to_regclass('public.categorization_audit') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON public.categorization_audit FROM tygr_app;
  END IF;
END
$$;

-- NB déploiement : ce script est ADDITIF (CREATE IF NOT EXISTS, GRANT) — aucun
-- DROP. Ordre de pipeline non négociable : db:provision -> migrate -> deploy.
-- Rappel tombstone : ne JAMAIS ajouter transactions_cache / balance_history (ni
-- une partition) à la liste blanche de l'étape 5.
