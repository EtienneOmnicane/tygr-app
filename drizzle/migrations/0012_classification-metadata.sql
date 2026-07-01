-- Capture des métadonnées de classification AMONT (Omni-FI, bloc Enrichment) —
-- ticket TECH-API-TRACE. On TRACE fidèlement 3 champs reçus du payload et jusqu'ici
-- JETÉS (ConfidenceLevel, ClassificationSource, RuleIdMatch). Aucune décision dérivée
-- ici : l'exploitation (seuils, file de revue, chaîne de priorité) relève de
-- GAP-CATEG-NATIVE1 (P2). Même esprit que 0011 (is_auto_categorized), même table.
--
-- ⚠️ MIGRATION ÉCRITE À LA MAIN (PAS drizzle-kit generate) — dette DB-MIGRATE3 :
-- la migration 0009 (entity-write-scope) est ABSENTE de _journal.json (idx saute de
-- 8 à 10), donc le générateur peut re-collisionner la numérotation. On numérote donc
-- 0012 explicitement et on ajoute l'entrée correspondante au journal à la main.
--
-- transactions_cache est PARTITIONNÉE par RANGE (transaction_date). Un
-- ALTER TABLE ... ADD COLUMN sur la table MÈRE se propage automatiquement à toutes
-- les partitions, présentes ET futures (PostgreSQL ≥ 11) — à la différence de la RLS
-- (répétée par partition). Donc UN seul ALTER par colonne, aucune répétition de
-- partition, aucune RLS à reposer (ne PAS confondre avec le pattern RLS de 0003).
--
-- Expand-only / backward-compatible (CLAUDE.md règle 9) : 3 colonnes NULLABLE, le code
-- N-1 les ignore. PAS de CHECK (données descriptives amont, hors de notre contrôle —
-- un CHECK strict ferait échouer une ingestion sur une valeur API nouvelle ; cf. PLAN
-- §3.1/§3.3). PAS de DROP (append-only : colonnes additives uniquement).
--
-- PAS de backfill : ces métadonnées n'existent que dans le payload, qu'on ne conserve
-- pas. Les lignes déjà en base restent NULL ; une re-synchronisation naturelle les
-- peuplera pour les transactions encore renvoyées par l'API (décision validée).

-- Fiabilité de la classification amont (ex. "High"/"Medium"/"Low"). NULLABLE. "Low"
-- (défaut serializer Omni-FI) est CONSERVÉ tel quel à l'ingestion : la trace est fidèle
-- à la source, c'est la couche UI qui décidera quoi faire d'un score bas.
ALTER TABLE "transactions_cache" ADD COLUMN "confidence_level" varchar(120);--> statement-breakpoint

-- Sous-source amont de la classification (USER_RULE / SYSTEM_RULE / ML, cf. doc API
-- §Priorité de classification). À DISTINGUER de category_source ('OMNIFI', système TYGR) :
-- granularité différente. NON bornée par CHECK (résilience aux nouveautés API).
ALTER TABLE "transactions_cache" ADD COLUMN "classification_source" varchar(120);--> statement-breakpoint

-- Identifiant de la règle amont ayant matché (le cas échéant). Pas de FK : la règle
-- vit chez Omni-FI, pas chez nous. NULLABLE.
ALTER TABLE "transactions_cache" ADD COLUMN "rule_id_match" varchar(120);
