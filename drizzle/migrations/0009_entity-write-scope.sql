-- ════════════════════════════════════════════════════════════════════════════
-- ENTITY-WRITE-SCOPE1 (P1) — borne l'ÉCRITURE sur bank_accounts par scope entité.
-- Plan PLAN-entity-write-scope1.md. Lève la 2ᵉ et dernière P1 du GATE d'activation
-- Vision Entité (la 1re, ENTITY-READ-JOIN1, est levée par #83 côté repos de lecture).
--
-- AVANT (migration 0008) : policy entity_scope AS RESTRICTIVE FOR SELECT → la LECTURE
-- est bornée, mais l'écriture (INSERT/UPDATE/DELETE) sur bank_accounts ne l'est PAS.
-- Prouvé runtime (test 14) : un VIEWER scopé Sucrière mutait AUSSI Énergie.
--
-- APRÈS : on remplace la policy par AS RESTRICTIVE FOR ALL, avec le MÊME USING qu'avant
-- + un WITH CHECK portant la MÊME expression. RESTRICTIVE → se combine en AND avec
-- tenant_isolation (PERMISSIVE FOR ALL) ; FOR ALL couvre SELECT/INSERT/UPDATE/DELETE.
--   • USING (SELECT/UPDATE/DELETE) : on ne peut LIRE/CIBLER qu'une ligne in-scope →
--     un membre scopé ne peut ni UPDATE ni DELETE un compte hors périmètre.
--   • WITH CHECK (INSERT/UPDATE) : l'état RÉSULTANT doit être in-scope → impossible de
--     DÉPLACER un compte vers une entité hors scope, ni d'INSÉRER hors scope.
--
-- Backward-compatible code N-1 (expand, règle 9) : en Vision Globale (GUC
-- app.current_entity_scope vide/non posé) l'expression vaut TRUE → tout passe, exactement
-- comme aujourd'hui. Aucun chemin Vision Entité n'existe en prod (pas de definirScopesMembre)
-- → la policy est neutre pour le code actuel. L'ingestion (upsertCompte, INSERT entity_id
-- NULL) tourne en Vision Globale (gardée peutModifier, MANAGER/ADMIN ; un ADMIN n'a aucune
-- ligne member_entity_scopes) → l'INSERT NULL passe. L'UPDATE de re-sync (onConflictDoUpdate)
-- n'inclut pas entity_id → WITH CHECK satisfait. Le sas d'assignation ADMIN (futur, L4) reste
-- gardé applicativement par ctx.role === ADMIN (la RLS ignore le rôle, par design).
--
-- Fail-closed assumé : un membre SCOPÉ qui déclencherait un sync verrait son INSERT
-- entity_id=NULL REFUSÉ (un membre borné ne crée pas de comptes non-assignés, visibles du
-- seul ADMIN) — comportement voulu, non régressif (le sync est une opération d'admin de
-- connexions, faite en Vision Globale).
--
-- DROP sans IF EXISTS : la policy entity_scope existe sur toute base ayant appliqué 0008.
-- Migration FORWARD-only (cohérent avec le reste de drizzle/migrations).
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY "entity_scope" ON "bank_accounts";--> statement-breakpoint
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
