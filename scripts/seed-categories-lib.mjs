/**
 * Bibliothèque de seed du RÉFÉRENTIEL DE CATÉGORIES (QA-ONBOARD-CATEG1) —
 * logique d'insertion PARTAGÉE par :
 *   - scripts/seed-admin.mjs        (création du workspace « Omni-FI HQ ») ;
 *   - scripts/seed-omnifi-demo.ts   (création du workspace démo sandbox) ;
 *   - scripts/seed-categories.mjs   (rattrapage : tous les workspaces existants) ;
 *   - tests/isolation/seed-categories-isolation.test.ts (preuve sous Postgres réel).
 * Une seule source du PATTERN d'insertion (CLAUDE.md règle 9). Le pendant
 * APPLICATIF (CTA « Importer les catégories standard ») vit dans
 * src/server/repositories/categorisation.ts (importerReferentielCategories) —
 * même référentiel, même clé de verrou, même garde d'idempotence.
 *
 * Contrat d'exécution (hérité de seed-categories.mjs historique) :
 * - Rôle OWNER (DATABASE_URL_ADMIN) attendu ; `categories` est sous FORCE RLS →
 *   le GUC app.current_workspace_id est posé DANS la transaction (set_config
 *   transactionnel, jamais session-level ; aucun BYPASSRLS).
 * - IDEMPOTENT par workspace : ≥1 catégorie déjà présente (active OU archivée)
 *   ⇒ no-op (0 insérée). Re-lançable sans doublon ; n'écrase jamais un
 *   référentiel vivant.
 * - VERROU pg_advisory_xact_lock (clé dérivée du workspace_id) : sérialise deux
 *   seeds concurrents du MÊME workspace — y compris face au CTA in-app, qui
 *   prend LA MÊME clé. Nécessaire car la contrainte
 *   UNIQUE(workspace_id, name, parent_id) ne protège PAS les Natures
 *   (parent_id NULL : NULLs distincts en SQL, doublon possible sans verrou).
 * - Filtre EXPLICITE workspace_id sur le garde (défense en profondeur : reste
 *   correct même sous un rôle BYPASSRLS, cf. seed-categories.mjs historique).
 */
import {
  PREFIXE_VERROU_SEED_CATEGORIES,
  REFERENTIEL_CATEGORIES,
} from "../src/lib/categories-referentiel.mjs";

/**
 * Sème le référentiel dans UN workspace, DANS la transaction de l'appelant —
 * aucun BEGIN/COMMIT ici : seed-admin l'appelle au sein de sa transaction
 * globale (un ROLLBACK appelant annule aussi les catégories, tout-ou-rien).
 * L'appelant DOIT être en transaction ouverte : set_config(..., true) et le
 * verrou xact sont transactionnels, hors transaction ils ne porteraient pas.
 *
 * @param {{ query(texte: string, params?: unknown[]): Promise<{ rows: any[] }> }} client
 *   Client SQL « pg-compatible » (pg PoolClient, PGlite).
 * @param {string} workspaceId
 * @returns {Promise<number>} catégories insérées (0 = déjà pourvu, no-op).
 */
export async function seederCategoriesDansTransaction(client, workspaceId) {
  // FORCE RLS : poser le contexte tenant AVANT toute lecture/écriture de
  // `categories` (sinon tenant_isolation masque tout / rejette les INSERT).
  await client.query(
    "select set_config('app.current_workspace_id', $1, true)",
    [workspaceId],
  );

  // Verrou consultatif transactionnel — clé = hash(PREFIXE + workspace_id).
  // MÊME préfixe partagé et MÊME calcul que le repository applicatif
  // (importerReferentielCategories) : deux seeds concurrents du même workspace se
  // sérialisent, le second retombe sur le garde « déjà pourvu ». On pré-concatène
  // en JS et on passe UNE chaîne paramétrée (pas de `||` SQL → pas d'ambiguïté de
  // type sur des paramètres non typés).
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    [PREFIXE_VERROU_SEED_CATEGORIES + workspaceId],
  );

  // Idempotence : un workspace qui a DÉJÀ ≥1 catégorie n'est pas re-seedé.
  const deja = await client.query(
    "select 1 from categories where workspace_id = $1 limit 1",
    [workspaceId],
  );
  if (deja.rows.length > 0) {
    return 0;
  }

  let insere = 0;
  for (const groupe of REFERENTIEL_CATEGORIES) {
    // 1. Nature (parent_id NULL). RETURNING id pour rattacher les enfants.
    const nat = await client.query(
      `insert into categories (workspace_id, name, parent_id)
       values ($1, $2, null) returning id`,
      [workspaceId, groupe.nature],
    );
    insere += 1;

    // 2. Sous-natures (parent = la Nature, dans le MÊME workspace : la FK
    //    composite (parent_id, workspace_id) → (id, workspace_id) l'exige).
    for (const sous of groupe.sousNatures) {
      await client.query(
        `insert into categories (workspace_id, name, parent_id)
         values ($1, $2, $3)`,
        [workspaceId, sous, nat.rows[0].id],
      );
      insere += 1;
    }
  }
  return insere;
}

/**
 * Variante AUTONOME : ouvre sa propre transaction (BEGIN/COMMIT, ROLLBACK sur
 * échec — jamais de référentiel partiel). Pour les appelants HORS transaction :
 * boucle multi-workspace de seed-categories.mjs, bloc owner de seed-omnifi-demo.
 *
 * @param {{ query(texte: string, params?: unknown[]): Promise<{ rows: any[] }> }} client
 * @param {string} workspaceId
 * @returns {Promise<number>} catégories insérées (0 = déjà pourvu).
 */
export async function seederCategoriesWorkspace(client, workspaceId) {
  await client.query("BEGIN");
  try {
    const insere = await seederCategoriesDansTransaction(client, workspaceId);
    await client.query("COMMIT");
    return insere;
  } catch (erreur) {
    await client.query("ROLLBACK");
    throw erreur;
  }
}
