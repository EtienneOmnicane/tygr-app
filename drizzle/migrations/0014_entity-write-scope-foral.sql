-- ════════════════════════════════════════════════════════════════════════════
-- DB-MIGRATE3 (referme) — applique RÉELLEMENT ENTITY-WRITE-SCOPE1 en prod/dev.
--
-- POURQUOI cette migration NEUVE existe : 0009_entity-write-scope.sql porte le même
-- changement (entity_scope FOR SELECT → FOR ALL) mais est ORPHELIN de
-- meta/_journal.json → le runner Drizzle ne l'a JAMAIS appliqué. En prod/dev la
-- policy entity_scope de bank_accounts est restée à l'état 0008 : AS RESTRICTIVE
-- FOR SELECT (lecture bornée, ÉCRITURE non bornée). 0009 n'est exécuté QUE par les
-- suites d'isolation (qui appliquent par readdir/nom, pas par le journal) — d'où un
-- faux vert : les tests prouvaient FOR ALL pendant que la prod restait FOR SELECT.
--
-- Décision (actée) : on NE réordonne PAS le journal et on NE touche PAS au SQL
-- exécutable de 0009 (conservé pour l'historique + le schéma de test lu par nom). On
-- referme la dette par CETTE migration en bout de chaîne (idx 14), idempotente.
--
-- CE QUE FAIT 0014 : remplace la policy entity_scope par AS RESTRICTIVE FOR ALL, avec
-- le MÊME USING qu'avant + un WITH CHECK portant la MÊME expression (copiée caractère
-- pour caractère depuis 0009). RESTRICTIVE → se combine en AND avec tenant_isolation
-- (PERMISSIVE FOR ALL) ; FOR ALL couvre SELECT/INSERT/UPDATE/DELETE.
--   • USING (SELECT/UPDATE/DELETE) : on ne peut LIRE/CIBLER qu'une ligne in-scope →
--     un membre scopé ne peut ni UPDATE ni DELETE un compte hors périmètre.
--   • WITH CHECK (INSERT/UPDATE) : l'état RÉSULTANT doit être in-scope → impossible de
--     DÉPLACER un compte vers une entité hors scope, ni d'INSÉRER hors scope.
--
-- Backward-compatible code N-1 (expand, règle 9) : en Vision Globale (GUC
-- app.current_entity_scope vide/non posé) l'expression vaut TRUE → tout passe, comme
-- aujourd'hui. L'ingestion (upsertCompte, INSERT entity_id NULL) tourne en Vision
-- Globale (gardée peutModifier) → l'INSERT NULL passe ; l'UPDATE de re-sync n'inclut
-- pas entity_id → WITH CHECK satisfait. Aucun chemin Vision Entité n'existe en prod.
--
-- Idempotente (rejouable) : DROP POLICY IF EXISTS — sur une base où 0009 a été appliqué
-- (suites de test), la policy est déjà FOR ALL et 0014 la recrée à l'identique ; sur la
-- prod (état 0008, FOR SELECT) 0014 effectue la vraie transition FOR SELECT → FOR ALL.
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "entity_scope" ON "bank_accounts";--> statement-breakpoint
CREATE POLICY "entity_scope" ON "bank_accounts" AS RESTRICTIVE FOR ALL TO public
  USING (
    nullif(current_setting('app.current_entity_scope', true), '') IS NULL
    OR (
      entity_id IS NOT NULL
      AND entity_id = ANY (
        string_to_array(current_setting('app.current_entity_scope', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    nullif(current_setting('app.current_entity_scope', true), '') IS NULL
    OR (
      entity_id IS NOT NULL
      AND entity_id = ANY (
        string_to_array(current_setting('app.current_entity_scope', true), ',')::uuid[]
      )
    )
  );
