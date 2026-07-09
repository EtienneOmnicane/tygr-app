-- FB0709-CAT-DOUBLONS1 — unicité de catégorie INSENSIBLE À LA CASSE + parent NULL.
--
-- Deux failles de l'ancien UNIQUE(workspace_id, name, parent_id) :
--   1. CASSE : `varchar` sensible à la casse → « VAT » et « vat » distincts.
--   2. NULL  : parent_id NULL ⇒ NULL ≠ NULL ⇒ deux Natures « Frais » identiques
--      passaient la contrainte (bug observé par Etienne).
--
-- Migration EXPAND-CONTRACT, backward-compatible avec le code N-1 : le nouvel
-- index est PLUS strict que l'ancien UNIQUE — tout ce que l'ancien code insérait
-- de LÉGITIME (pas de doublon) reste accepté ; seuls les doublons (que le code
-- N-1 ne créait pas volontairement) sont désormais refusés. On DÉDOUBLONNE
-- d'abord l'existant, PUIS on pose l'index (sinon sa création échouerait sur les
-- doublons déjà en base).
--
-- APPEND-ONLY : `categories`, `categorization_rules` et `transaction_categorizations`
-- sont des tables NORMALES (liste blanche DELETE de tygr_app.sql) — PAS
-- append-only. Le re-pointage des références se fait par UPDATE ; les doublons
-- vidés de `categories` sont supprimés physiquement (légitime). Aucune table
-- append-only (transactions_cache / balance_history / categorization_audit) n'est
-- touchée. `categorization_audit` porte `category_name` (snapshot texte, pas d'id)
-- → rien à re-pointer, l'historique lisible est préservé.

-- 1. DÉDOUBLONNAGE itératif. Une passe fusionne, dans chaque (workspace, niveau),
--    les catégories de même LOWER(name) et même parent EFFECTIF (COALESCE parent,
--    sentinelle 0-uuid) vers la SURVIVANTE = la plus ancienne (created_at min,
--    tie-break id min pour un ordre total déterministe). Fusionner des PARENTS
--    peut créer de nouveaux doublons d'ENFANTS (deux sous-catégories homonymes
--    passent sous le même parent) → on BOUCLE tant qu'il reste des doublons. La
--    boucle converge : chaque passe supprime ≥ 1 catégorie (ensemble fini).
DO $$
DECLARE
  restants integer;
BEGIN
  LOOP
    -- Table des correspondances doublon → survivante pour CETTE passe.
    CREATE TEMP TABLE _fusion_categories ON COMMIT DROP AS
    WITH classees AS (
      SELECT
        id,
        workspace_id,
        first_value(id) OVER (
          PARTITION BY workspace_id, lower(name),
            coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY created_at ASC, id ASC
        ) AS survivante
      FROM categories
    )
    SELECT id AS doublon, survivante, workspace_id
    FROM classees
    WHERE id <> survivante;

    SELECT count(*) INTO restants FROM _fusion_categories;
    EXIT WHEN restants = 0;

    -- 1a. Re-pointer les SOUS-CATÉGORIES dont le parent est un doublon vers la
    --     survivante (avant de supprimer les parents doublons).
    UPDATE categories c
    SET parent_id = f.survivante
    FROM _fusion_categories f
    WHERE c.parent_id = f.doublon;

    -- 1b. Re-pointer les SPLITS (transaction_categorizations) vers la survivante.
    UPDATE transaction_categorizations tc
    SET category_id = f.survivante
    FROM _fusion_categories f
    WHERE tc.category_id = f.doublon;

    -- 1c. RÈGLES : supprimer d'abord celles qui deviendraient un DOUBLON EXACT
    --     après re-pointage (même workspace, pattern, match_type, category=survivante)
    --     — la contrainte categorization_rules_workspace_unique l'exigerait. On garde
    --     la règle déjà rattachée à la survivante ; on jette la redondante du doublon.
    DELETE FROM categorization_rules r
    USING _fusion_categories f
    WHERE r.category_id = f.doublon
      AND EXISTS (
        SELECT 1 FROM categorization_rules r2
        WHERE r2.workspace_id = r.workspace_id
          AND r2.pattern = r.pattern
          AND r2.match_type = r.match_type
          AND r2.category_id = f.survivante
      );

    --     Puis re-pointer les règles restantes du doublon vers la survivante.
    UPDATE categorization_rules r
    SET category_id = f.survivante
    FROM _fusion_categories f
    WHERE r.category_id = f.doublon;

    -- 1d. Supprimer les catégories doublon désormais vidées de toute référence.
    DELETE FROM categories c
    USING _fusion_categories f
    WHERE c.id = f.doublon;

    DROP TABLE _fusion_categories;
  END LOOP;
END
$$;
--> statement-breakpoint

-- 2. Remplacer l'ancien UNIQUE (sensible à la casse, troué sur NULL) par un INDEX
--    UNIQUE FONCTIONNEL : LOWER(name) ferme la casse ; COALESCE(parent_id,
--    0-uuid) ferme le trou NULL≠NULL (deux racines homonymes = même clé). La
--    sentinelle 0-uuid DOIT être identique à PARENT_RACINE_SENTINELLE côté
--    repository (existeCategorieMemeNom) — cohérence garde applicative ⇆ index.
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_workspace_name_parent_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "categories_workspace_lower_name_parent_unique"
  ON "categories" (
    "workspace_id",
    lower("name"),
    coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)
  );
