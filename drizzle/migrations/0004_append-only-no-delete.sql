-- 0004 — Tombstone STRICT par TRIGGER (dette #3bis, défense réelle).
--
-- Pourquoi ce trigger EN PLUS du deny-by-default sur le privilège DELETE
-- (tygr_app.sql, liste blanche) : retirer le privilège DELETE à tygr_app sur
-- les tables append-only ne suffit PAS. Une action de CASCADE FK
-- (ON DELETE cascade) supprime les lignes enfant SANS re-vérifier leur
-- privilège DELETE — un `DELETE FROM bank_accounts` (privilège légitimement
-- accordé pour la déconnexion d'une banque) efface alors PHYSIQUEMENT les
-- `transactions_cache` / `balance_history` rattachées. Constat reproduit
-- (cross-review Sécurité, contexte frais, 2026-06-17 : 1 ligne -> 0).
--
-- Un trigger BEFORE DELETE qui lève une exception est la SEULE défense
-- indépendante à la fois du privilège ET du chemin (direct, cascade, code
-- futur). Il rend l'invariant append-only vrai par construction : aucune ligne
-- de `transactions_cache` / `balance_history` ne peut quitter physiquement la
-- table. L'effacement reste LOGIQUE (is_removed=true via UPDATE — non affecté,
-- le trigger est BEFORE DELETE uniquement).
--
-- PARTITIONS — héritage (contraste avec la RLS) : un trigger row-level posé sur
-- la table MÈRE partitionnée est CLONÉ automatiquement à toutes les partitions,
-- EXISTANTES ET FUTURES (PostgreSQL >= 11 ; `pg_trigger.tgparentid`). Un DELETE
-- visant une partition en direct (`transactions_cache_2026`) OU routé par la
-- mère est donc intercepté par le trigger hérité — vérifié empiriquement, y
-- compris sur une partition 2028 créée APRÈS cette migration. Le roulement
-- annuel des partitions n'a donc PAS à répéter ce trigger.
-- ⚠️ NE PAS confondre avec la RLS : la RLS, elle, N'est PAS héritée (cf. 0003 :
-- ENABLE+FORCE+policy posés par partition) — c'est CET invariant-là que le
-- roulement doit répéter, pas le trigger.
--
-- Idempotent : CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS avant CREATE.

CREATE OR REPLACE FUNCTION tygr_refuser_delete_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- check_violation (classe 23) : erreur d'intégrité, distincte d'un refus de
  -- privilège (42501) — le code applicatif peut la mapper sur un message dédié.
  -- Le message ne porte QUE le nom de table (TG_TABLE_NAME) : aucune PII/montant
  -- (règle 8).
  RAISE EXCEPTION
    'append_only_no_delete: la table % est append-only — aucun DELETE physique (effacement logique via is_removed uniquement)',
    TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
-- Un SEUL trigger, sur la table mère : hérité par les 5 partitions actuelles et
-- toute partition future (cf. note ci-dessus). Pas de CREATE TRIGGER par
-- partition (ce serait redondant avec le trigger hérité).
DROP TRIGGER IF EXISTS "transactions_cache_no_delete" ON "transactions_cache";--> statement-breakpoint
CREATE TRIGGER "transactions_cache_no_delete" BEFORE DELETE ON "transactions_cache"
  FOR EACH ROW EXECUTE FUNCTION tygr_refuser_delete_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS "balance_history_no_delete" ON "balance_history";--> statement-breakpoint
CREATE TRIGGER "balance_history_no_delete" BEFORE DELETE ON "balance_history"
  FOR EACH ROW EXECUTE FUNCTION tygr_refuser_delete_append_only();
