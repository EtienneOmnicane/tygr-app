-- Pré-catégorisation automatique Omni-FI : traçabilité de la provenance de la
-- catégorie OBIE (bloc Enrichment). On NE crée PAS de split : on marque la
-- transaction elle-même (cf. PLAN — option « marqueur sur la transaction »). La
-- vraie catégorisation TYGR (transaction_categorizations / moteur de règles) est
-- INCHANGÉE.
--
-- transactions_cache est PARTITIONNÉE par RANGE (transaction_date). Un
-- ALTER TABLE ... ADD COLUMN sur la table MÈRE se propage automatiquement à
-- toutes les partitions, présentes ET futures (PostgreSQL ≥ 11) — à la différence
-- de la RLS (héritée non, répétée par partition). Donc UN seul ALTER suffit ici,
-- aucune répétition par partition (ne PAS confondre avec le pattern RLS de 0003).
--
-- Expand-only / backward-compatible (CLAUDE.md règle 9) : les deux colonnes ont un
-- défaut, le code N-1 les ignore. Le backfill des lignes déjà présentes est porté
-- par scripts/backfill-auto-categorized.mjs (idempotent), hors migration.

-- Indicateur de provenance : true ⇔ la catégorie principale vient d'une source
-- automatique (aujourd'hui Omni-FI). Défaut false = aucune trace auto (état actuel
-- de toutes les lignes avant backfill).
ALTER TABLE "transactions_cache" ADD COLUMN "is_auto_categorized" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Source de la catégorie automatique. NULL = pas de provenance auto. Liste fermée
-- (extensible) — aujourd'hui seul 'OMNIFI'. Le CHECK autorise NULL OU une valeur
-- de la liste : impossible de polluer la colonne avec une source non déclarée.
ALTER TABLE "transactions_cache" ADD COLUMN "category_source" varchar(10);--> statement-breakpoint
ALTER TABLE "transactions_cache" ADD CONSTRAINT "transactions_cache_category_source_check" CHECK ("category_source" IS NULL OR "category_source" IN ('OMNIFI'));--> statement-breakpoint

-- Cohérence marqueur/source : un marqueur auto DOIT porter une source, et une
-- source ne peut exister sans marqueur. Interdit les états incohérents
-- (true/NULL ou false/'OMNIFI') quel que soit le chemin d'écriture (ingestion,
-- backfill, code futur) — même esprit que le double verrou source/rule_id de
-- transaction_categorizations.
ALTER TABLE "transactions_cache" ADD CONSTRAINT "transactions_cache_auto_source_coherence" CHECK (("is_auto_categorized" = true AND "category_source" IS NOT NULL) OR ("is_auto_categorized" = false AND "category_source" IS NULL));
