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
--      - parties                    : référentiel des entités légales Omni-FI
--                                     (PartyId), éditable/archivable (is_active ;
--                                     un DELETE physique reste possible pour une
--                                     party JAMAIS référencée — FK composites en
--                                     ON DELETE RESTRICT protègent celles qui le
--                                     sont). NON append-only.
--      - account_party_role         : table de LIAISON détention compte↔party (N-N) —
--                                     ré-attribuer/retirer une détention = DELETE
--                                     légitime ; reçoit aussi la cascade depuis
--                                     bank_accounts (compte supprimé → rôle supprimé).
--                                     NON append-only.
--      - user_scopes                : table de DROITS (périmètre party/compte par
--                                     membre, L2) — révoquer/réattribuer un octroi =
--                                     DELETE légitime ; reçoit aussi les cascades depuis
--                                     workspace_members (membre retiré → octrois purgés)
--                                     et bank_accounts (compte supprimé → octroi purgé).
--                                     NON append-only.
--      - echeances                  : registre MANUEL d'échéances prévisionnelles
--                                     (Epic 8) — donnée UTILISATEUR de projection,
--                                     éditable/supprimable (ECH-D3). PAS l'historique
--                                     réalisé, JAMAIS append-only. Suppression physique
--                                     d'une échéance obsolète = légitime (les FK
--                                     composites entity/categorie en ON DELETE
--                                     restrict/no action protègent l'intégrité amont).
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
    'member_entity_scopes',
    'parties',
    'account_party_role',
    'user_scopes',
    'echeances'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT DELETE ON public.%I TO tygr_app', t);
    END IF;
  END LOOP;
END
$$;

-- 6. APPEND-ONLY STRICT au niveau PRIVILÈGE (deny-by-default, comme #3bis pour
--    DELETE). Ces tables sont IMMUABLES : tygr_app ne doit avoir NI UPDATE NI
--    DELETE dessus, seulement INSERT/SELECT. L'étape 3 a accordé UPDATE en bloc
--    (`ON ALL TABLES`) ; on le RETIRE ici. Les triggers (0005 pour
--    categorization_audit, 0021 pour consent_records/audit_events) sont la
--    défense de fond ; ce REVOKE est la ceinture de privilège (double garde).
--    Conditionnel à l'existence (mêmes deux ordres de pipeline que l'étape 5).
--
--    ⚠️ Ne PAS confondre avec transactions_cache / balance_history, append-only
--    au DELETE SEULEMENT (l'UPDATE tombstone `is_removed` y est légitime) : ces
--    deux-là gardent UPDATE et n'apparaissent donc pas ici. Elles sont protégées
--    par leur absence de la liste blanche (étape 5) + le trigger BEFORE DELETE
--    de la migration 0004.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'categorization_audit',
    'consent_records',
    'audit_events'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM tygr_app', t);
    END IF;
  END LOOP;
END
$$;

-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ 7. Rôle `tygr_service` (lot W3) — résolution webhook + quarantaine         │
-- └──────────────────────────────────────────────────────────────────────────┘
-- Spec : docs/specs/PLAN-webhook-ingestion.md §5.2 / §7.2 / §7.4.
--
-- MOINDRE PRIVILÈGE EXTRÊME : ce rôle n'existe QUE pour (a) résoudre le TENANT d'un
-- webhook — SELECT de 3 colonnes non métier sur bank_connections — et (b) gérer la
-- table de quarantaine. JAMAIS `BYPASSRLS`. NOLOGIN ici (patron C4) : LOGIN + mot de
-- passe posés HORS script (`ALTER ROLE tygr_service LOGIN PASSWORD …` depuis un secret
-- d'env, jamais commité), rotation au runbook. La résolution webhook est CROSS-TENANT
-- par nature (on cherche À QUI est l'événement) : on la confine par le PRIVILÈGE
-- (column-level + FOR SELECT), pas par la RLS.
--
-- ⚠️ PÉRIMÈTRE GELÉ (CLAUDE.md règle 2, exception documentée) : ces 3 colonnes, cette
-- table, FOR SELECT — rien d'autre, JAMAIS. Toute extension exige un arbitrage humain.
-- Le cross-check d'environnement se lit sous `tygr_app` APRÈS résolution (workspaces
-- n'a pas de RLS) : tygr_service N'A PAS besoin de `workspaces` (décision D1 — annule
-- la décision D2 du plan parent, gain net de moindre privilège).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tygr_service') THEN
    CREATE ROLE tygr_service NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO tygr_service;

-- 7a. Résolution connection→workspace. GRANT COLUMN-LEVEL (3 colonnes) + policy
--     PERMISSIVE FOR SELECT. Conditionnel à l'existence (deux ordres de pipeline).
--     La policy est NÉCESSAIRE : bank_connections est en FORCE ROW LEVEL SECURITY
--     (0003) → sans policy applicable à tygr_service, il verrait 0 ligne. PERMISSIVE
--     + TO tygr_service : s'OR-e avec tenant_isolation, INVISIBLE à tygr_app (contre-
--     preuve d'isolation). `USING (true)` : la sélectivité vient du GRANT column-level
--     et de FOR SELECT (la résolution DOIT voir tous les tenants), jamais de la policy.
--     Idempotent : DROP puis CREATE (CREATE POLICY n'a pas de IF NOT EXISTS).
DO $$
BEGIN
  IF to_regclass('public.bank_connections') IS NOT NULL THEN
    GRANT SELECT (id, omnifi_connection_id, workspace_id)
      ON public.bank_connections TO tygr_service;
    DROP POLICY IF EXISTS webhook_resolution ON public.bank_connections;
    CREATE POLICY webhook_resolution ON public.bank_connections
      AS PERMISSIVE FOR SELECT TO tygr_service USING (true);
  END IF;
END
$$;

-- 7b. Quarantaine `webhook_events_pending` — DEUX gardes complémentaires contre
--     tygr_app (le GRANT global de l'étape 3 + les DEFAULT PRIVILEGES de l'étape 4
--     rendent TOUTE table future accessible à tygr_app : il faut un REVOKE explicite).
--     Aucune ne suffit seule (leçon append-only : la 1re garde a été contournée par
--     une 2nde voie) :
--       (1) PRIVILÈGE : REVOKE ALL … FROM tygr_app ;
--       (2) RLS : FORCE (migration 0026) + une seule policy FOR ALL TO tygr_service —
--           AUCUNE policy ne s'applique à tygr_app ⇒ 0 ligne même si un GRANT
--           réapparaissait par accident.
--     tygr_service reçoit SELECT/INSERT/UPDATE/DELETE (DELETE = purge TTL du rejeu W5 ;
--     table système NON append-only). Conditionnel à l'existence, idempotent.
DO $$
BEGIN
  IF to_regclass('public.webhook_events_pending') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.webhook_events_pending TO tygr_service;
    REVOKE ALL ON public.webhook_events_pending FROM tygr_app;
    DROP POLICY IF EXISTS webhook_pending_service ON public.webhook_events_pending;
    CREATE POLICY webhook_pending_service ON public.webhook_events_pending
      AS PERMISSIVE FOR ALL TO tygr_service USING (true) WITH CHECK (true);
  END IF;
END
$$;

-- NB déploiement : ce script est ADDITIF (CREATE IF NOT EXISTS, GRANT) — aucun
-- DROP. Ordre de pipeline non négociable : db:provision -> migrate -> db:provision
-- (RE-provision) -> deploy. Le RE-provision post-migrate n'est PAS optionnel : les
-- blocs conditionnels à l'existence d'une table (étapes 5, 7a, 7b) sont SAUTÉS au 1er
-- provision d'une base neuve (les tables n'existent pas encore) et ne prennent effet
-- qu'au re-provision — sinon `tygr_service` n'a aucun GRANT (INSERT quarantaine =
-- permission denied) et la liste blanche DELETE reste vide. Fail-closed entre les
-- deux (jamais d'octroi non voulu), mais le pipeline DOIT rejouer ce script après
-- migrate. Séquence détaillée : CLAUDE.md § « Séquence d'initialisation ».
-- Rappel tombstone : ne JAMAIS ajouter transactions_cache / balance_history (ni
-- une partition) à la liste blanche de l'étape 5.
-- Rappel append-only STRICT : ne JAMAIS ajouter consent_records / audit_events /
-- categorization_audit à la liste blanche de l'étape 5 (ils doivent rester sans
-- DELETE), et toute nouvelle table append-only stricte s'ajoute à l'étape 6.
