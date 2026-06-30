/**
 * Seed QA DÉDIÉ au chantier L8b-2 (axe ENTITÉ du sélecteur de périmètre).
 *
 * Pourquoi : la base sandbox locale n'a ni 2e membre, ni entité, ni compte
 * désélectionné → AUCUN des 5 scénarios runtime de l8b-2 n'est testable. Ce script
 * pose le DÉCOR minimal sur les comptes sandbox DÉJÀ ingérés (aucune PII inventée :
 * on ne crée pas de compte, on assigne/désélectionne les comptes réels existants).
 *
 * Usage : node --env-file=.env scripts/seed-qa-l8b2.mjs
 *   (DATABASE_URL_ADMIN + NEON_WSPROXY_LOCAL requis — JAMAIS `npm run` nu, le .env
 *    n'est pas chargé et le script plante sur DATABASE_URL_ADMIN.)
 *
 * Décor posé (sur le 1er workspace, ses comptes triés par account_name) :
 *   - 2 entités        : « Sucre » (Eᴬ), « Holding » (Eᴮ).
 *   - compte[0] → Sucre, is_selected=TRUE   (Sucre visible)
 *   - compte[1] → Sucre, is_selected=FALSE  (⭐ compte DÉSÉLECTIONNÉ de Sucre)
 *   - compte[2] → Holding                    (entité HORS du droit du MANAGER)
 *   - compte[3] → entity_id=NULL inchangé    (NULL-B : non assigné)
 *   - 1 membre   : qa-manager@a.mu / mot de passe « tygr-qa-2026 », rôle MANAGER,
 *                  scopé member_entity_scopes → Sucre UNIQUEMENT (Vision Entité).
 *
 * Ce que chaque scénario observe (à toi de le constater dans l'UI) :
 *   1. Fail-closed : MANAGER → onglet « Par entité » → choisir « Holding » (hors droit)
 *      → comptesParEntite renvoie [] → token sans filtre → dashboard = « Groupe »
 *      (= son périmètre Sucre), JAMAIS le compte Holding.
 *   2. Sous-ensemble : MANAGER → « Sucre » → ne voit que SES comptes Sucre visibles.
 *   3. ⭐ is_selected (dette ISSELECTED1) : compte[1] est dans Sucre mais
 *      is_selected=FALSE. ATTENTION asymétrie connue du code à TRANCHER :
 *        • listerEntitesVisibles (C2) filtre is_selected=true → nbComptes(Sucre)=1.
 *        • comptesParEntite (C1) NE filtre PAS is_selected → traduit {compte0, compte1}.
 *      → choisir « Sucre » : le filtre posé inclura-t-il compte1 (désélectionné) ?
 *        et le bouton affiche-t-il « Sucre » ou « N comptes » ? NOTE le résultat,
 *        il tranche ISSELECTED1 (faut-il aligner C1 sur is_selected=true ?).
 *   4. NULL-B : compte[3] (entity_id=null) ABSENT de l'onglet entité, PRÉSENT dans
 *      « Par compte » (en tant qu'ADMIN, qui voit tout).
 *   5. Bascule onglets : « Par compte » strictement inchangé (cocher des comptes ≠
 *      choisir une entité, pas de mixage d'état).
 *
 * Garanties (calque seed-categories.mjs / seed-admin.mjs) :
 * - Rôle OWNER (DATABASE_URL_ADMIN) : administration, même statut que les migrations
 *   (exception CLAUDE.md règle 2). JAMAIS le rôle applicatif, JAMAIS BYPASSRLS.
 * - Tables sous FORCE RLS (tenant_isolation) : on pose app.current_workspace_id DANS
 *   la transaction (set_config transactionnel) → le WITH CHECK valide chaque écriture.
 * - IDEMPOTENT : entités par (workspace_id, name) ON CONFLICT DO NOTHING ; membre par
 *   email ; assignations rejouables. Re-lançable sans doublon.
 * - INTRA-TENANT only (1er workspace) : aucune fuite cross-tenant.
 * - NE TOUCHE PAS l'ingestion : entity_id/is_selected sont des champs « humains »
 *   (le re-sync ne les réécrase pas — invariant upsertCompte).
 */
import { neonConfig, Pool } from "@neondatabase/serverless";
import argon2 from "argon2";

if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

// DEV LOCAL UNIQUEMENT — même câblage wsproxy que src/db/index.ts et seed-admin.mjs.
if (process.env.NEON_WSPROXY_LOCAL) {
  const proxy = process.env.NEON_WSPROXY_LOCAL;
  neonConfig.wsProxy = (host, port) => `${proxy}/v1?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

const EMAIL_MGR = "qa-manager@a.mu";
const NOM_MGR = "QA Manager (Sucre)";
const MDP_MGR = "tygr-qa-2026";

function exigerUrlAdmin() {
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url) {
    throw new Error(
      "DATABASE_URL_ADMIN manquante — lance via `node --env-file=.env scripts/seed-qa-l8b2.mjs`.",
    );
  }
  return url;
}

async function main() {
  const pool = new Pool({ connectionString: exigerUrlAdmin() });
  const client = await pool.connect();
  try {
    // 1er workspace + ses comptes (triés par nom = l'ordre que voit l'UI).
    const ws = (await client.query("select id from workspaces order by name limit 1"))
      .rows[0];
    if (!ws) throw new Error("Aucun workspace — synchronise d'abord des comptes sandbox.");
    const workspaceId = ws.id;

    const comptes = (
      await client.query(
        "select id, account_name from bank_accounts where workspace_id = $1 order by account_name",
        [workspaceId],
      )
    ).rows;
    if (comptes.length < 3) {
      throw new Error(
        `Il faut ≥3 comptes pour le décor (trouvé ${comptes.length}). Synchronise plus de comptes sandbox.`,
      );
    }

    await client.query("begin");
    // FORCE RLS : poser le tenant courant pour que owner satisfasse tenant_isolation.
    await client.query("select set_config('app.current_workspace_id', $1, true)", [
      workspaceId,
    ]);

    // 2 entités idempotentes.
    await client.query(
      `insert into entities (workspace_id, name, is_active) values ($1,'Sucre',true), ($1,'Holding',true)
         on conflict (workspace_id, name) do nothing`,
      [workspaceId],
    );
    const ents = (
      await client.query(
        "select id, name from entities where workspace_id = $1 and name in ('Sucre','Holding')",
        [workspaceId],
      )
    ).rows;
    const entSucre = ents.find((e) => e.name === "Sucre").id;
    const entHolding = ents.find((e) => e.name === "Holding").id;

    // Assignations + désélection. compte[3] (si présent) reste entity_id NULL (NULL-B).
    await client.query(
      "update bank_accounts set entity_id = $1, is_selected = true where id = $2",
      [entSucre, comptes[0].id],
    );
    await client.query(
      "update bank_accounts set entity_id = $1, is_selected = false where id = $2",
      [entSucre, comptes[1].id], // ⭐ compte DÉSÉLECTIONNÉ de Sucre (cas ISSELECTED1)
    );
    await client.query(
      "update bank_accounts set entity_id = $1, is_selected = true where id = $2",
      [entHolding, comptes[2].id],
    );

    // Membre MANAGER scopé Sucre (Vision Entité). Idempotent par email. L'unicité
    // est un index sur lower(email) (expression) → on ne peut pas viser un ON CONFLICT
    // simple : on fait SELECT-puis-INSERT/UPDATE conditionnel.
    const hash = await argon2.hash(MDP_MGR);
    const existant = (
      await client.query("select id from users where lower(email) = $1", [
        EMAIL_MGR.toLowerCase(),
      ])
    ).rows[0];
    let mgrId;
    if (existant) {
      mgrId = existant.id;
      await client.query("update users set password_hash = $1 where id = $2", [
        hash,
        mgrId,
      ]);
    } else {
      mgrId = (
        await client.query(
          "insert into users (email, full_name, password_hash) values ($1,$2,$3) returning id",
          [EMAIL_MGR.toLowerCase(), NOM_MGR, hash],
        )
      ).rows[0].id;
    }

    await client.query(
      `insert into workspace_members (user_id, workspace_id, role) values ($1,$2,'MANAGER')
         on conflict (user_id, workspace_id) do update set role = 'MANAGER'`,
      [mgrId, workspaceId],
    );
    await client.query(
      `insert into member_entity_scopes (workspace_id, user_id, entity_id) values ($1,$2,$3)
         on conflict do nothing`,
      [workspaceId, mgrId, entSucre],
    );

    await client.query("commit");

    console.log("✅ Décor QA L8b-2 posé sur le workspace", workspaceId);
    console.log("   Entités  : Sucre =", entSucre, "| Holding =", entHolding);
    console.log("   Comptes  :");
    console.log("     -", comptes[0].account_name, "→ Sucre (is_selected=TRUE)");
    console.log("     -", comptes[1].account_name, "→ Sucre (is_selected=FALSE ⭐)");
    console.log("     -", comptes[2].account_name, "→ Holding");
    if (comptes[3]) console.log("     -", comptes[3].account_name, "→ NON ASSIGNÉ (NULL-B)");
    console.log("   Membre   :", EMAIL_MGR, "/", MDP_MGR, "(MANAGER, scopé Sucre)");
    console.log("");
    console.log("   ⚠️  Note ISSELECTED1 : Sucre a 2 comptes mais 1 désélectionné.");
    console.log("      listerEntitesVisibles comptera 1 ; comptesParEntite traduira 2.");
    console.log("      Observe le filtre posé + le libellé du bouton, et tranche.");
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {}
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("❌ Seed QA L8b-2 échoué :", e.message);
  process.exit(1);
});
