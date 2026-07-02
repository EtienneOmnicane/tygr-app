-- =============================================================================
-- DIAGNOSTIC v2 (read-only) — balayage TOUS workspaces sous rôle owner
-- =============================================================================
-- Nouveau contexte (cartographie DB du 2026-07-02) :
--   * UNE seule base (Docker locale tygr_postgres:5432/tygr) ; .env == .env.prod.
--     La "prod" = dev local + clés Omni-FI prod → écrit dans CETTE base.
--   * ClientUserId (EndUser) porté par workspaces.omnifi_client_user_id, PAS par
--     bank_connections. Deux connexions partagent l'EndUser ssi même workspace_id.
--   * workspaces N'EST PAS sous RLS → lisible sans GUC.
--   * tygr_owner (DATABASE_URL_ADMIN) = superuser BYPASSRLS en local → voit TOUS
--     les workspaces sans poser de GUC. On l'exploite pour un balayage exhaustif.
--
-- => Exécuter sous DATABASE_URL_ADMIN (owner). AUCUN set_config nécessaire.
--    100 % SELECT. Objectif : trouver où ont atterri les tx des 3 banques et si
--    fb1428 (77 muets) diffère de d23196 (OK) par workspace / EndUser / env.
-- =============================================================================


-- Q1 — Tous les workspaces (name, EndUser, environnement, date).
--   Révèle s'il existe plusieurs workspaces (ex. un 'demo' sandbox + un 'prod').
SELECT
  id                     AS workspace_id,
  name,
  kind,
  omnifi_environment     AS env,
  omnifi_client_user_id  AS client_user_id,
  created_at
FROM workspaces
ORDER BY created_at;


-- Q2 — Toutes les connexions, TOUS workspaces, triées par date de création.
--   Les connexions "de ce matin" sont en bas. Compare comptes/sélectionnés/synchro.
SELECT
  w.name                                                     AS workspace,
  w.omnifi_environment                                       AS env,
  w.omnifi_client_user_id                                    AS client_user_id,
  bc.institution_name                                        AS banque,
  bc.omnifi_connection_id                                    AS connexion,
  bc.status                                                  AS statut,
  bc.created_at                                              AS creee_le,
  count(ba.id)                                               AS comptes,
  count(ba.id) FILTER (WHERE ba.is_selected)                 AS selectionnes,
  count(ba.id) FILTER (WHERE ba.last_synced_at IS NOT NULL)  AS synchronises
FROM bank_connections bc
JOIN workspaces w ON w.id = bc.workspace_id
LEFT JOIN bank_accounts ba ON ba.connection_id = bc.id
GROUP BY w.name, w.omnifi_environment, w.omnifi_client_user_id,
         bc.institution_name, bc.omnifi_connection_id, bc.status, bc.created_at
ORDER BY bc.created_at;


-- Q3 — OÙ sont réellement les transactions (par workspace + connexion).
--   Répond à "les tx des 3 banques existent-elles, et dans quel workspace ?".
SELECT
  w.name                    AS workspace,
  w.omnifi_environment      AS env,
  bc.institution_name       AS banque,
  bc.omnifi_connection_id   AS connexion,
  count(tc.id)              AS nb_transactions,
  min(tc.transaction_date)  AS tx_plus_ancienne,
  max(tc.transaction_date)  AS tx_plus_recente
FROM transactions_cache tc
JOIN bank_accounts   ba ON ba.id = tc.bank_account_id
JOIN bank_connections bc ON bc.id = ba.connection_id
JOIN workspaces       w  ON w.id = tc.workspace_id
GROUP BY w.name, w.omnifi_environment, bc.institution_name, bc.omnifi_connection_id
ORDER BY nb_transactions DESC;


-- Q4 — LE face-à-face décisif : d23196 (OK) vs fb1428 (77 muets).
--   Même workspace ? même client_user_id ? même env ? créées quand ?
--   * client_user_id / env DIFFÉRENTS  => cause = EndUser/env non aligné (la piste).
--   * IDENTIQUES                        => l'amont rend vraiment 0 pour fb1428
--                                          (fixture, droits /transactions, antériorité).
SELECT
  bc.omnifi_connection_id   AS connexion,
  bc.institution_name       AS banque,
  bc.status                 AS statut,
  bc.created_at             AS creee_le,
  w.name                    AS workspace,
  w.omnifi_environment      AS env,
  w.omnifi_client_user_id   AS client_user_id
FROM bank_connections bc
JOIN workspaces w ON w.id = bc.workspace_id
WHERE bc.omnifi_connection_id LIKE 'd23196%'
   OR bc.omnifi_connection_id LIKE 'fb1428%'
ORDER BY bc.created_at;


-- Q5 — Connexions créées dans les dernières 36 h (la session "de ce matin").
--   Combien de banques distinctes ont RÉELLEMENT été rattachées ? (attendu : 3 ?)
SELECT
  w.name                    AS workspace,
  w.omnifi_environment      AS env,
  bc.institution_name       AS banque,
  bc.omnifi_connection_id   AS connexion,
  bc.status                 AS statut,
  bc.created_at             AS creee_le,
  count(ba.id)              AS comptes
FROM bank_connections bc
JOIN workspaces w ON w.id = bc.workspace_id
LEFT JOIN bank_accounts ba ON ba.connection_id = bc.id
WHERE bc.created_at >= now() - interval '36 hours'
GROUP BY w.name, w.omnifi_environment, bc.institution_name,
         bc.omnifi_connection_id, bc.status, bc.created_at
ORDER BY bc.created_at;
