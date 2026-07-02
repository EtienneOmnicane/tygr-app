-- =============================================================================
-- DIAGNOSTIC READ-ONLY — "transactions manquantes"
-- =============================================================================
-- Objet : comprendre pourquoi, après connexion PROD de 3 banques réelles, un seul
--   compte a reçu des transactions. Ce script NE MODIFIE RIEN (SELECT uniquement).
--
-- Contexte code (2026-07-02) :
--   src/server/widget/orchestration.ts (~L904-911) : la boucle par COMPTE
--     `for (const cpt of comptesAIngerer) { await synchroniserCompte(...) }`
--     est DANS le try/catch de la CONNEXION. Si un compte lève, le catch (~L912)
--     marque toute la connexion en échec et ABANDONNE les comptes restants ; le(s)
--     compte(s) déjà synchronisé(s) avant l'exception gardent leurs transactions.
--   Filtre d'ingestion : `bank_accounts.is_selected = true` (consentement) +
--     statut OBIE Enabled/null. Un compte is_selected=false n'est JAMAIS tenté.
--   synchroniserCompte : marque `last_synced_at` MÊME si l'API a renvoyé 0 tx.
--     => last_synced_at renseigné + 0 tx = "synchro OK mais l'API n'a rien rendu".
--
-- Comment lire le résultat : voir DIAGNOSTIC-transactions-manquantes.md (grille).
--
-- IMPORTANT — RLS : les tables forcent l'isolation par workspace via le GUC
--   app.current_workspace_id. On le pose ci-dessous ET on filtre en WHERE
--   (ceinture + bretelles, quel que soit le rôle de connexion).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- ÉTAPE 0 — Trouver le workspace_id à diagnostiquer.
--   (À exécuter d'abord ; repérez la ligne de VOTRE workspace prod, copiez son id.)
-- -----------------------------------------------------------------------------
SELECT
  w.id AS workspace_id,
  w.name AS workspace_name,
  count(DISTINCT bc.id)  AS connexions,
  count(DISTINCT ba.id)  AS comptes,
  count(tc.id)           AS transactions
FROM workspaces w
LEFT JOIN bank_connections bc ON bc.workspace_id = w.id
LEFT JOIN bank_accounts   ba ON ba.workspace_id = w.id
LEFT JOIN transactions_cache tc ON tc.workspace_id = w.id
GROUP BY w.id, w.name
ORDER BY transactions DESC;


-- -----------------------------------------------------------------------------
-- ÉTAPE 1 — Poser le workspace ciblé pour la RLS.
--   Remplacez le UUID ci-dessous par celui repéré à l'étape 0, puis exécutez
--   l'ÉTAPE 1 + l'ÉTAPE 2 dans la MÊME session/transaction.
-- -----------------------------------------------------------------------------
-- \set ws '00000000-0000-0000-0000-000000000000'   -- (psql : décommentez + renseignez)
SELECT set_config('app.current_workspace_id', '00000000-0000-0000-0000-000000000000', false);


-- -----------------------------------------------------------------------------
-- ÉTAPE 2 — Tableau par COMPTE (le cœur du diagnostic).
--   Une ligne par bank_account, groupée par connexion/banque.
--   Remplacez le WHERE workspace_id par le même UUID qu'à l'étape 1.
-- -----------------------------------------------------------------------------
SELECT
  bc.institution_name                         AS banque,
  bc.omnifi_connection_id                     AS connexion_omnifi,
  bc.status                                   AS statut_connexion,
  ba.account_name                             AS compte,
  ba.omnifi_account_id                        AS compte_omnifi,
  ba.currency                                 AS devise,
  ba.is_selected                              AS selectionne,          -- false => JAMAIS ingéré
  ba.last_synced_at                           AS derniere_synchro,     -- NULL => jamais atteint
  ba.entity_id                                AS entite_id,            -- NULL => non assigné
  count(tc.id)                                AS nb_transactions,
  min(tc.transaction_date)                    AS tx_plus_ancienne,
  max(tc.transaction_date)                    AS tx_plus_recente
FROM bank_accounts ba
JOIN bank_connections bc ON bc.id = ba.connection_id
LEFT JOIN transactions_cache tc ON tc.bank_account_id = ba.id
WHERE ba.workspace_id = '00000000-0000-0000-0000-000000000000'
GROUP BY
  bc.institution_name, bc.omnifi_connection_id, bc.status,
  ba.account_name, ba.omnifi_account_id, ba.currency,
  ba.is_selected, ba.last_synced_at, ba.entity_id
ORDER BY bc.institution_name, ba.account_name;


-- -----------------------------------------------------------------------------
-- ÉTAPE 3 — Synthèse par CONNEXION (compter les comptes muets par banque).
-- -----------------------------------------------------------------------------
SELECT
  bc.institution_name                                             AS banque,
  bc.status                                                       AS statut_connexion,
  count(ba.id)                                                    AS comptes_total,
  count(ba.id) FILTER (WHERE ba.is_selected)                      AS comptes_selectionnes,
  count(ba.id) FILTER (WHERE ba.last_synced_at IS NOT NULL)       AS comptes_synchro,
  count(ba.id) FILTER (WHERE t.nb > 0)                            AS comptes_avec_tx,
  coalesce(sum(t.nb), 0)                                          AS transactions_total
FROM bank_connections bc
LEFT JOIN bank_accounts ba ON ba.connection_id = bc.id
LEFT JOIN LATERAL (
  SELECT count(*) AS nb
  FROM transactions_cache tc
  WHERE tc.bank_account_id = ba.id
) t ON true
WHERE bc.workspace_id = '00000000-0000-0000-0000-000000000000'
GROUP BY bc.institution_name, bc.status
ORDER BY bc.institution_name;
