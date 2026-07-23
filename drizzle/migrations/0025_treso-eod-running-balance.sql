-- ═══════════════════════════════════════════════════════════════════
-- PROD-TRESO-EOD1 — colonne `running_balance` sur transactions_cache
-- Plan : docs/specs/PLAN-treso-eod.md §5.3 (D5 = numeric(15,2)).
--
-- Solde COURANT après l'opération (`RunningBalance` OBIE), source de l'élection EOD
-- de la courbe de trésorerie. Sonde prod 2026-07-23 : rempli à 100 % sur les comptes
-- avec transactions (62/62, 124/124 tx, 3 institutions) — le null sandbox était un
-- artefact d'environnement.
--
-- EXPAND-COMPATIBLE (règle 9, expand-contract) : colonne NULLABLE, le code N-1 l'ignore.
-- NÉGATIF autorisé (découvert) → pas de CHECK de signe. `ADD COLUMN` sur la table MÈRE
-- partitionnée se PROPAGE à toutes les partitions (présentes, DEFAULT, et de roulement
-- à venir). Aucun GRANT nouveau (SELECT/INSERT/UPDATE déjà couverts ; PAS de DELETE —
-- transactions_cache reste hors liste blanche, append-only au DELETE).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "transactions_cache" ADD COLUMN "running_balance" numeric(15, 2);
