-- ════════════════════════════════════════════════════════════════════════════
-- L4 — Policy RLS `account_scope` sur bank_accounts (périmètre party/compte
-- EFFECTIF). Plan PLAN-architecture-multi-tenant-omnicane.md §3.2 / §5 (lot L4).
-- POINT NÉVRALGIQUE anti-IDOR — cross-review contradictoire requise avant merge.
--
-- Pilotée par le GUC `app.current_account_scope`, posé par le RÉSOLVEUR de
-- withWorkspace (src/server/db/tenancy.ts) DEPUIS user_scopes + member_entity_scopes
-- (résolus en COMPTES) — JAMAIS un paramètre client. La maille de filtrage est le
-- COMPTE (généralise entity_scope : couvre party, compte ET entité d'un coup).
--
-- drizzle-kit n'émet PAS les policies au GUC custom (constant depuis 0001/0003/
-- 0008/0014) → migration ÉCRITE À LA MAIN. Idempotente (DROP IF EXISTS + CREATE).
-- AUCUN changement de schéma (toutes les tables existent depuis L0–L2) ; bank_accounts
-- a déjà ENABLE+FORCE RLS (0001) → pas de FORCE ici.
--
-- ┌─ AS RESTRICTIVE FOR ALL (DÉCISION 3) ────────────────────────────────────────┐
-- │ RESTRICTIVE ⇒ se combine en AND avec tenant_isolation (PERMISSIVE) ET         │
-- │ entity_scope (RESTRICTIVE) : accès ⟺ tenant ET entity_scope ET account_scope. │
-- │ Une PERMISSIVE par erreur s'OR'erait avec tenant_isolation (qui accorde toute  │
-- │ ligne du tenant) → la restriction ne filtrerait RIEN = fuite intra-groupe.    │
-- │ FOR ALL ⇒ borne LECTURE (USING : SELECT/UPDATE/DELETE) ET ÉCRITURE (WITH CHECK│
-- │ : INSERT/UPDATE) : un membre scopé ne peut ni lire ni cibler ni déplacer un    │
-- │ compte hors de son droit. USING == WITH CHECK (même prédicat).                │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ SÉMANTIQUE DU GUC — 3 cas (DÉCISION 1, corrige une fuite du plan §3.2) ───────┐
-- │ Le plan §3.2 utilisait nullif(...) IS NULL pour court-circuiter en Vision      │
-- │ Globale. Tel quel, un membre AYANT des scopes mais dont le DROIT résout à ∅    │
-- │ (party archivée / comptes purgés) verrait TOUT le tenant = FUITE « vide→tout ».│
-- │ La distinction est portée par le RÉSOLVEUR (tenancy.ts), pas par la policy :   │
-- │   (a) GUC NON POSÉ (résolveur : 0 ligne de scope)  → nullif(...) IS NULL = TRUE│
-- │       → Vision Globale (tout le tenant). C'est AUSSI le chemin d'INGESTION     │
-- │       (Vision Globale) → INSERT/UPDATE passent (non-régression couche sacrée). │
-- │   (b) GUC = '00000000-0000-0000-0000-000000000000' (sentinelle UUID-nul, posée │
-- │       par le résolveur quand ≥1 scope mais DROIT = ∅) → ne matche AUCUN        │
-- │       bank_accounts.id réel → 0 ligne (fail-closed). PAS « voir tout ».        │
-- │   (c) GUC = CSV d'UUID de comptes → périmètre exact (id = ANY(...)).           │
-- │ nullif(..., '') est CONSERVÉ comme GARDE-FOU (ceinture+bretelles) : si ''      │
-- │ était posé par accident, éviter que ''::uuid lève et casse TOUTES les requêtes.│
-- │ Le résolveur, lui, ne pose JAMAIS '' (il pose la sentinelle pour le cas vide). │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ CLAUSE view_filter — présente mais INERTE en L4 (DÉCISION 2) ─────────────────┐
-- │ La 2e clause AND (current_view_filter) est posée DÈS MAINTENANT pour ne pas    │
-- │ re-migrer la policy en L5. MAIS withWorkspace ne pose JAMAIS                    │
-- │ app.current_view_filter en L4 → le GUC reste absent → nullif(...) IS NULL =    │
-- │ TRUE → la clause court-circuite (neutre). Câblage du sélecteur UI = L5, APRÈS  │
-- │ intersection serveur avec le DROIT (jamais depuis un paramètre client = IDOR). │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- COEXISTENCE : entity_scope (0014) reste EN PLACE (non touchée). account_scope la
-- subsume (le résolveur traduit déjà les entités en comptes) ; les deux RESTRICTIVE
-- se combinent en AND (plus restrictif = sûr). Retrait d'entity_scope = L9 (différé),
-- une fois account_scope prouvé en prod.
--
-- ROLLBACK : DROP POLICY IF EXISTS "account_scope" ON "bank_accounts"; → retour à
-- l'état L3 (entity_scope intacte, comportement inchangé).
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "account_scope" ON "bank_accounts";--> statement-breakpoint
CREATE POLICY "account_scope" ON "bank_accounts" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );
