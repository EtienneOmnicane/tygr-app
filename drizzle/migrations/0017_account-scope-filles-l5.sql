-- ════════════════════════════════════════════════════════════════════════════
-- L5 — Héritage de `account_scope` par les TABLES FILLES (RLS native) + clause
-- `view_filter` active. Plan PLAN-architecture-multi-tenant-omnicane.md §5 (lot L5).
-- POINT NÉVRALGIQUE anti-IDOR — referme un trou ACTUEL : avant ce lot, les lectures
-- ET écritures de splits/soldes/transactions PAR-ID (ajouterSplit, remplacerSplits,
-- creerSplitDepuisRegle, supprimerSplit) n'étaient bornées QUE par le tenant, pas par
-- le périmètre compte → un membre scopé compte A pouvait lire/écrire les filles d'un
-- compte B de SON groupe (IDOR intra-groupe). cross-review contradictoire requise.
--
-- Pilotée par le MÊME GUC `app.current_account_scope` que 0016 (posé par le résolveur
-- de withWorkspace depuis user_scopes + member_entity_scopes — JAMAIS un paramètre
-- client) + le GUC `app.current_view_filter` (posé en L5 par withWorkspace APRÈS
-- intersection serveur DROIT ∩ filtre — JAMAIS le filtre client seul). La maille de
-- filtrage reste le COMPTE ; on l'applique aux filles via leur rattachement au compte.
--
-- drizzle-kit n'émet PAS les policies au GUC custom (constant 0001/0003/0008/0014/0016)
-- → migration ÉCRITE À LA MAIN. AUCUN changement de schéma (toutes les tables et
-- colonnes existent depuis 0003/0005). Idempotente (DROP IF EXISTS + CREATE).
--
-- ┌─ STRATÉGIE 1 — RLS NATIVE, pas la discipline de jointure (DÉCISION A) ─────────┐
-- │ On pose une policy `account_scope` RESTRICTIVE FOR ALL directement sur chaque   │
-- │ table fille. La policy mord sur TOUT accès — y compris un SELECT/INSERT/DELETE   │
-- │ PAR-ID. Conséquence structurelle : les 3 lectures par-id (ajouterSplit,         │
-- │ remplacerSplits, creerSplitDepuisRegle, via leur SELECT … transactions_cache    │
-- │ WHERE id=…) deviennent AUTOMATIQUEMENT scopées — une transaction hors périmètre  │
-- │ renvoie 0 ligne → TransactionIntrouvableError / skip, SANS écrire. C'est tout    │
-- │ l'intérêt : aucune ligne de repository à modifier, la base ferme l'IDOR.        │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ DEUX FORMES DE PRÉDICAT selon le rattachement au compte (DÉCISION B) ─────────┐
-- │ • transactions_cache (+ partitions) ET balance_history portent `bank_account_id│
-- │   NOT NULL` directement → prédicat DIRECT, réplique de 0016 mais sur            │
-- │   `bank_account_id` (au lieu de `id`).                                          │
-- │ • transaction_categorizations (splits) ET categorization_audit ne portent PAS de│
-- │   bank_account_id — seulement (transaction_id, transaction_date) → prédicat      │
-- │   EXISTS vers transactions_cache : la fille est visible ⟺ sa transaction parente │
-- │   l'est. transactions_cache porte ELLE-MÊME `account_scope` → l'EXISTS hérite du │
-- │   scope (et du view_filter) de la transaction parente, RÉCURSIVEMENT. On NE      │
-- │   dénormalise PAS bank_account_id (interdit : categorization_audit est           │
-- │   append-only — rétro-remplir violerait l'immuabilité ; même principe que        │
-- │   « jamais dénormaliser entity_id dans l'append-only », CLAUDE.md Entités).      │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ FORME OBLIGATOIRE du prédicat EXISTS (court-circuit AVANT l'EXISTS) ──────────┐
-- │ Le prédicat des 2 tables EXISTS garde la forme « court-circuit Vision Globale    │
-- │ OR EXISTS » — PAS un EXISTS nu. En Vision Globale (account_scope NON posé), la    │
-- │ fille court-circuite à TRUE et l'EXISTS n'est PAS évalué. RAISON : une ligne      │
-- │ d'audit (ou un split) dont la transaction parente a été PURGÉE (tombstone        │
-- │ is_removed / partition supprimée) doit rester visible pour un ADMIN/conformité    │
-- │ en Vision Globale — l'audit existe pour SURVIVRE à la donnée qu'il trace.         │
-- │ L'invisibilité conditionnelle ne frappe QUE les membres scopés, hors périmètre.  │
-- │                                                                                  │
-- │ Pour un membre SCOPÉ : la fille n'est PAS en court-circuit → l'EXISTS s'évalue,   │
-- │ et transactions_cache À L'INTÉRIEUR de l'EXISTS est elle-même scopée (Postgres    │
-- │ applique la RLS de la sous-table dans un SELECT imbriqué) → la transaction        │
-- │ parente n'apparaît dans l'EXISTS QUE si elle est dans le périmètre du membre →    │
-- │ la fille hérite exactement du scope. Chaîne PROUVÉE par tests #11/#12 (pas        │
-- │ supposée). La clause view_filter passe AUSSI par l'EXISTS (la transaction         │
-- │ parente est filtrée par son propre view_filter).                                 │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ AS RESTRICTIVE FOR ALL — USING == WITH CHECK (identique à 0016) ──────────────┐
-- │ RESTRICTIVE ⇒ se combine en AND avec tenant_isolation (PERMISSIVE) : accès ⟺     │
-- │ tenant ET account_scope. Une PERMISSIVE par erreur s'OR'erait avec               │
-- │ tenant_isolation (toute ligne du tenant) → la restriction ne filtrerait RIEN.    │
-- │ FOR ALL ⇒ borne LECTURE (USING) ET ÉCRITURE (WITH CHECK) : un INSERT de split    │
-- │ sur une transaction hors périmètre est refusé (l'IDOR ne se déplace pas vers     │
-- │ l'écriture). USING == WITH CHECK (même prédicat).                                │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- ┌─ PARTITIONNEMENT — la RLS n'est PAS héritée (DÉCISION C, ne PAS rater) ────────┐
-- │ transactions_cache est partitionnée par année. PostgreSQL n'hérite PAS les       │
-- │ policies de la table mère aux partitions (cf. 0003 : tenant_isolation re-CREATE  │
-- │ sur chaque partition). On pose donc account_scope sur la table MÈRE ET sur        │
-- │ CHACUNE des 5 partitions existantes (_2024, _2025, _2026, _2027, _default).      │
-- │ ⚠️ ROULEMENT ANNUEL : la création d'une partition _YYYY future DOIT désormais     │
-- │ RÉPÉTER cette policy account_scope (en plus de tenant_isolation de 0003) — sinon  │
-- │ la nouvelle partition rouvre le trou intra-groupe. Test #5 prouve la couverture   │
-- │ de toutes les partitions présentes. (Le trigger append-only, lui, EST hérité —    │
-- │ ne pas confondre : cf. CLAUDE.md « Partitions — héritage ».)                     │
-- └──────────────────────────────────────────────────────────────────────────────┘
--
-- COEXISTENCE : tenant_isolation (0003/0005) et le trigger append-only restent EN
-- PLACE (non touchés). entity_scope n'existe QUE sur bank_accounts (les filles
-- héritaient déjà du scope entité par jointure — ENTITY-READ-JOIN1) : L5 ne pose PAS
-- d'entity_scope sur les filles, account_scope unifie déjà l'axe entité en comptes.
--
-- ROLLBACK : DROP POLICY IF EXISTS "account_scope" sur les 4 tables + les 5
-- partitions → retour exact à l'état L4 (0016 sur bank_accounts intacte, tenant_isolation
-- et append-only intacts). Aucune donnée touchée (migration de policies pure).
-- ════════════════════════════════════════════════════════════════════════════

-- ── transactions_cache (table MÈRE) — prédicat DIRECT sur bank_account_id ──────
DROP POLICY IF EXISTS "account_scope" ON "transactions_cache";--> statement-breakpoint
CREATE POLICY "account_scope" ON "transactions_cache" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );--> statement-breakpoint

-- ── partition _2024 (RLS non héritée → policy répliquée) ───────────────────────
DROP POLICY IF EXISTS "account_scope" ON "transactions_cache_2024";--> statement-breakpoint
CREATE POLICY "account_scope" ON "transactions_cache_2024" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );--> statement-breakpoint

-- ── partition _2025 ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "account_scope" ON "transactions_cache_2025";--> statement-breakpoint
CREATE POLICY "account_scope" ON "transactions_cache_2025" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );--> statement-breakpoint

-- ── partition _2026 ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "account_scope" ON "transactions_cache_2026";--> statement-breakpoint
CREATE POLICY "account_scope" ON "transactions_cache_2026" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );--> statement-breakpoint

-- ── partition _2027 ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "account_scope" ON "transactions_cache_2027";--> statement-breakpoint
CREATE POLICY "account_scope" ON "transactions_cache_2027" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );--> statement-breakpoint

-- ── partition _default (filet de roulement) ────────────────────────────────────
DROP POLICY IF EXISTS "account_scope" ON "transactions_cache_default";--> statement-breakpoint
CREATE POLICY "account_scope" ON "transactions_cache_default" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );--> statement-breakpoint

-- ── balance_history (non partitionnée) — prédicat DIRECT sur bank_account_id ────
DROP POLICY IF EXISTS "account_scope" ON "balance_history";--> statement-breakpoint
CREATE POLICY "account_scope" ON "balance_history" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_account_scope', true), ',')::uuid[]
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR bank_account_id = ANY (
        string_to_array(current_setting('app.current_view_filter', true), ',')::uuid[]
      )
    )
  );--> statement-breakpoint

-- ── transaction_categorizations (splits) — prédicat EXISTS (pas de bank_account_id)
-- Forme « court-circuit Vision Globale OR EXISTS » sur CHAQUE clause (account_scope
-- ET view_filter). L'EXISTS joint sur (transaction_id, transaction_date) =
-- PK de transactions_cache (FK composite txn_categorizations_transaction_fk) →
-- semi-join indexé. transactions_cache porte account_scope → filtrage récursif.
DROP POLICY IF EXISTS "account_scope" ON "transaction_categorizations";--> statement-breakpoint
CREATE POLICY "account_scope" ON "transaction_categorizations" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM "transactions_cache" tc
        WHERE tc.id = "transaction_categorizations".transaction_id
          AND tc.transaction_date = "transaction_categorizations".transaction_date
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM "transactions_cache" tc
        WHERE tc.id = "transaction_categorizations".transaction_id
          AND tc.transaction_date = "transaction_categorizations".transaction_date
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM "transactions_cache" tc
        WHERE tc.id = "transaction_categorizations".transaction_id
          AND tc.transaction_date = "transaction_categorizations".transaction_date
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM "transactions_cache" tc
        WHERE tc.id = "transaction_categorizations".transaction_id
          AND tc.transaction_date = "transaction_categorizations".transaction_date
      )
    )
  );--> statement-breakpoint

-- ── categorization_audit — prédicat EXISTS (pas de bank_account_id, PAS de FK vers
-- transactions_cache, mais la jointure LOGIQUE sur (transaction_id, transaction_date)
-- fonctionne quand même : ce sont des colonnes réelles, l'absence de FK ne bloque pas
-- un EXISTS — confirmé). En Vision Globale, court-circuit AVANT l'EXISTS → une trace
-- dont la transaction parente est PURGÉE reste visible (audit de conformité immuable,
-- test #10). Pour un membre scopé, l'EXISTS échoue si la transaction est hors périmètre
-- (test #11). La table reste append-only (trigger BEFORE UPDATE OR DELETE de 0005
-- intact) — account_scope ne borne QUE la visibilité/écriture par compte.
DROP POLICY IF EXISTS "account_scope" ON "categorization_audit";--> statement-breakpoint
CREATE POLICY "account_scope" ON "categorization_audit" AS RESTRICTIVE FOR ALL TO public
  USING (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM "transactions_cache" tc
        WHERE tc.id = "categorization_audit".transaction_id
          AND tc.transaction_date = "categorization_audit".transaction_date
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM "transactions_cache" tc
        WHERE tc.id = "categorization_audit".transaction_id
          AND tc.transaction_date = "categorization_audit".transaction_date
      )
    )
  )
  WITH CHECK (
    (
      nullif(current_setting('app.current_account_scope', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM "transactions_cache" tc
        WHERE tc.id = "categorization_audit".transaction_id
          AND tc.transaction_date = "categorization_audit".transaction_date
      )
    )
    AND (
      nullif(current_setting('app.current_view_filter', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM "transactions_cache" tc
        WHERE tc.id = "categorization_audit".transaction_id
          AND tc.transaction_date = "categorization_audit".transaction_date
      )
    )
  );
