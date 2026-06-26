/**
 * withWorkspace(session, fn) — contrat E14 du plan v2.1 (CLAUDE.md règle 2) :
 *   BEGIN
 *     → set_config('app.current_workspace_id', …, true)   — true = local à la txn
 *     → set_config('app.current_user_id', …, true)
 *     → re-validation de la membership (à CHAQUE appel : un membre retiré
 *       perd l'accès à la requête suivante, pas au prochain login)
 *     → fn(tx, { role }) — tout accès données vit DANS cette transaction
 *   COMMIT / ROLLBACK
 *
 * set_config(..., true) est scoping-transaction (équivalent SET LOCAL) et
 * paramétrable — jamais d'interpolation de chaîne dans un SET.
 *
 * La factory permet d'injecter la base (prod : Neon Pool ; tests : PGlite)
 * sans dupliquer le contrat. L'instance applicative est exportée par
 * src/db/index.ts sous la signature du plan : withWorkspace(session, fn).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  accountPartyRole,
  bankAccounts,
  memberEntityScopes,
  userScopes,
  workspaceMembers,
  type WorkspaceRole,
} from "@/server/db/schema";

export const workspaceSessionSchema = z
  .object({
    userId: z.string().uuid(),
    activeWorkspaceId: z.string().uuid(),
  })
  .strict();

export type WorkspaceSession = z.infer<typeof workspaceSessionSchema>;

/** Session invalide/forgée — la couche route répond 400, code nommé (règle 3). */
export class InvalidSessionError extends Error {
  readonly code = "INVALID_SESSION";
  constructor() {
    super("Session invalide");
    this.name = "InvalidSessionError";
  }
}

/**
 * Accès refusé au workspace — la couche route répond 404, JAMAIS 403
 * (pas d'oracle d'existence, CLAUDE.md règle 3).
 */
export class WorkspaceAccessDeniedError extends Error {
  readonly code = "WORKSPACE_ACCESS_DENIED";
  constructor() {
    super("Ressource introuvable");
    this.name = "WorkspaceAccessDeniedError";
  }
}

/**
 * Garde-fou runtime (dette P0-b / C6, risque R1 de la revue Eng) : la connexion
 * applicative DOIT tourner sous un rôle non-propriétaire des tables. Un rôle
 * propriétaire (ou superuser/BYPASSRLS) contourne la RLS — toute l'isolation
 * inter-tenant tomberait en silence. On échoue FERMÉ (aucune requête servie)
 * plutôt que d'exposer des données cross-tenant. C'est une erreur de
 * configuration serveur, jamais déclenchable par un client : code distinct,
 * volontairement bruyant, mappé en 500 par la couche route (pas un 404).
 */
export class UnsafeDatabaseRoleError extends Error {
  readonly code = "UNSAFE_DB_ROLE";
  constructor(role: string) {
    super(
      `Connexion DB sous un rôle propriétaire (${role}) : la RLS serait ` +
        `contournée. L'app doit se connecter sous tygr_app (voir ` +
        `drizzle/provisioning/tygr_app.sql). Requête refusée (fail-closed).`,
    );
    this.name = "UnsafeDatabaseRoleError";
  }
}

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Le type de transaction Drizzle, dérivé du type de base injecté. */
export type WorkspaceTx<TDb extends AnyPgDatabase> = Parameters<
  Parameters<TDb["transaction"]>[0]
>[0];

/**
 * Périmètre entité (étage 2) du membre pour la session courante. LISIBLE par les
 * repositories qui veulent le connaître — mais ce n'est JAMAIS la source de
 * l'autorité : l'autorité est la policy RLS `entity_scope` sur bank_accounts,
 * pilotée par le GUC posé ci-dessous. Ce champ ne sert qu'à informer l'UI / des
 * agrégats, jamais à décider d'un accès en aval (plan §2.4).
 *
 * - `{ mode: "GLOBALE" }`   : aucune ligne member_entity_scopes → voit tout le
 *                             tenant (Vision Globale). Le GUC n'est PAS posé.
 * - `{ mode: "ENTITES" }`   : ≥1 ligne → périmètre borné. Le GUC porte le CSV des
 *                             entityIds ; la RLS masque tout compte hors liste
 *                             (et tout compte entity_id IS NULL).
 */
export type ScopeEntite =
  | { mode: "GLOBALE" }
  | { mode: "ENTITES"; entityIds: string[] };

/**
 * Périmètre COMPTE (étage 2, maille fine — L4, plan §1.3 / §3.2). Comme
 * `ScopeEntite`, c'est un champ LISIBLE non-autoritaire (l'autorité est la policy
 * RLS `account_scope` sur bank_accounts, pilotée par le GUC posé ci-dessous). Le
 * DROIT est l'ensemble (dédupliqué) des comptes autorisés, résolu serveur depuis
 * `user_scopes` (parties + comptes directs) ∪ `member_entity_scopes` (axe BU) —
 * JAMAIS d'un paramètre client.
 *
 * - `{ mode: "GLOBALE" }`   : AUCUNE ligne de scope (ni user_scopes ni
 *                             member_entity_scopes) → voit tout le tenant. Le GUC
 *                             account_scope n'est PAS posé.
 * - `{ mode: "COMPTES" }`   : ≥1 ligne de scope. `accountIds` = le DROIT résolu.
 *                             • non vide → GUC = CSV des UUID ; la RLS masque tout
 *                               compte hors liste.
 *                             • VIDE (≥1 scope mais 0 compte résolu : party
 *                               archivée, comptes purgés) → GUC = sentinelle
 *                               UUID-nul (DÉCISION 1) ; la RLS ne laisse passer
 *                               AUCUN compte (fail-closed). « périmètre vide »
 *                               n'est JAMAIS « voir tout ».
 */
export type ScopeCompte =
  | { mode: "GLOBALE" }
  | { mode: "COMPTES"; accountIds: string[] };

/**
 * Sentinelle « périmètre vide » (DÉCISION 1, L4). Un membre AYANT des scopes mais
 * dont le DROIT résout à ∅ NE doit PAS retomber en Vision Globale (fuite « vide →
 * tout » du plan §3.2). On pose alors ce GUC : un UUID nul qui (a) caste proprement
 * via `::uuid[]` (≠ chaîne vide, qui ferait lever `''::uuid` et casserait TOUTES les
 * requêtes), et (b) ne matche JAMAIS un `bank_accounts.id` réel (gen_random_uuid()
 * ne produit pas l'UUID nul) → la policy renvoie 0 ligne. JAMAIS poser '' ici.
 */
const SENTINELLE_PERIMETRE_VIDE = "00000000-0000-0000-0000-000000000000";

export interface WorkspaceContext {
  role: WorkspaceRole;
  workspaceId: string;
  userId: string;
  /** Étage 2 — axe BU (lisible, non-autoritaire — l'autorité est la RLS). */
  entityScope: ScopeEntite;
  /** Étage 2 — maille compte (lisible, non-autoritaire — l'autorité est la RLS). */
  accountScope: ScopeCompte;
}

/**
 * `withWorkspace(session, fn)` déjà lié à une session — passé aux orchestrateurs
 * (ingestion, widget) pour qu'ils restent purs de la DB concrète. Le `tx` est
 * typé sur AnyPgDatabase (compatible avec les repositories génériques `<TDb>`).
 */
export type ExecuterWorkspace = <T>(
  fn: (tx: WorkspaceTx<AnyPgDatabase>, ctx: WorkspaceContext) => Promise<T>,
) => Promise<T>;

export function createWithWorkspace<TDb extends AnyPgDatabase>(db: TDb) {
  return async function withWorkspace<T>(
    session: WorkspaceSession,
    fn: (tx: WorkspaceTx<TDb>, ctx: WorkspaceContext) => Promise<T>,
  ): Promise<T> {
    const parsed = workspaceSessionSchema.safeParse(session);
    if (!parsed.success) {
      throw new InvalidSessionError();
    }
    const { userId, activeWorkspaceId } = parsed.data;

    return db.transaction(async (tx) => {
      // Garde-fou R1/C6 : refuser de servir si la connexion tourne sous le
      // propriétaire des tables (RLS contournable). Comparé au propriétaire
      // réel de workspace_members — pas à une liste de noms en dur, pour rester
      // correct quel que soit le nom d'owner (tygr_owner en local, autre sur
      // Neon). `tableowner = current_user` ⇒ rôle propriétaire ⇒ fail-closed.
      const roleCheck = await tx.execute(
        sql`select current_user as who,
                   current_user = tableowner as is_owner
            from pg_tables where tablename = 'workspace_members'`,
      );
      const ligneRole = (
        roleCheck as unknown as {
          rows: { who: string; is_owner: boolean }[];
        }
      ).rows[0];
      if (ligneRole?.is_owner === true) {
        throw new UnsafeDatabaseRoleError(ligneRole.who ?? "owner");
      }

      await tx.execute(
        sql`select set_config('app.current_workspace_id', ${activeWorkspaceId}, true)`,
      );
      await tx.execute(
        sql`select set_config('app.current_user_id', ${userId}, true)`,
      );

      const membership = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, activeWorkspaceId),
          ),
        )
        .limit(1);

      if (membership.length === 0) {
        // Rollback implicite : on sort de la transaction par une exception.
        throw new WorkspaceAccessDeniedError();
      }

      // ══ ÉTAGE 2 — périmètre intra-groupe (deux GUC : entity_scope + account_scope)
      // Posé ICI, APRÈS la re-validation de la membership : on ne calcule un scope
      // que pour un (userId, activeWorkspaceId) confirmé membre. TOUTES les valeurs
      // dérivent EXCLUSIVEMENT des tables de droits (member_entity_scopes,
      // user_scopes) — JAMAIS d'un paramètre client (anti-élargissement, plan §3.4).
      // Les lectures passent par `tx` qui porte déjà app.current_workspace_id (RLS
      // tenant active) ; on AJOUTE partout un filtre explicite workspace_id = ctx
      // (défense en profondeur).
      //
      // ⚠️ ORDRE (point dur L4 « auto-référence », plan §1.e) : on RÉSOUT d'abord le
      // DROIT (comptes autorisés) en lisant account_party_role + bank_accounts, PUIS
      // on pose entity_scope ET account_scope. On lit donc bank_accounts AVANT que
      // le moindre GUC d'étage 2 ne soit posé : la résolution voit l'état tenant
      // BRUT (non filtré par entity_scope), sans interaction parasite — la voie la
      // plus sûre (le DROIT ne doit pas dépendre de l'ordre de pose des policies).
      //
      // ⚠️ COEXISTENCE entity_scope × account_scope (corrige une formulation
      // trompeuse, cross-review L4) : les DEUX policies RESTRICTIVE restent posées
      // (voie i du plan) et se combinent en AND — account_scope ne « subsume » PAS
      // entity_scope. Le résolveur UNIFIE bien les axes EN UNE LISTE côté
      // account_scope (4b traduit l'entité en comptes), mais entity_scope demeure
      // actif en parallèle. Pour un membre à DOUBLE AXE (≥1 member_entity_scopes ET
      // ≥1 user_scopes), l'AND ⟹ l'INTERSECTION, pas l'union attendue : un compte
      // légitimement octroyé par party mais dont l'entité est HORS du scope BU du
      // membre devient INVISIBLE pour lui. C'est un déni d'accès FAIL-CLOSED
      // (sous-ensemble du droit → AUCUNE fuite, jamais d'IDOR), mais une dette
      // FONCTIONNELLE (TODOS ENTITY×ACCOUNT-DOUBLE-AXIS, P2). Elle se DISSOUT au
      // retrait d'entity_scope en L9 (ou en interdisant le double octroi côté UI).

      // (1) Axe BU — member_entity_scopes (lu une seule fois ; réutilisé pour les
      //     deux GUC). Sémantique entity_scope (0008/0014) : 0 ligne = Vision
      //     Globale (GUC non posé) ; ≥1 ligne = CSV d'entity_id.
      const scopesBu = await tx
        .select({ entityId: memberEntityScopes.entityId })
        .from(memberEntityScopes)
        .where(
          and(
            eq(memberEntityScopes.userId, userId),
            eq(memberEntityScopes.workspaceId, activeWorkspaceId),
          ),
        );
      const entityIds = scopesBu.map((s) => s.entityId);

      // (2) Maille fine — user_scopes du membre (cible PARTY xor COMPTE, CHECK en
      //     base). On sépare les deux familles ; chaque ligne porte exactement l'une.
      const scopesFins = await tx
        .select({
          partyId: userScopes.partyId,
          bankAccountId: userScopes.bankAccountId,
        })
        .from(userScopes)
        .where(
          and(
            eq(userScopes.userId, userId),
            eq(userScopes.workspaceId, activeWorkspaceId),
          ),
        );
      const partyIds = scopesFins
        .map((s) => s.partyId)
        .filter((p): p is string => p !== null);
      const comptesDirects = scopesFins
        .map((s) => s.bankAccountId)
        .filter((c): c is string => c !== null);

      // (3) DÉCISION 1 cas (a) — AUCUNE ligne de scope (ni BU ni fine) → Vision
      //     Globale : on ne pose NI entity_scope NI account_scope (les policies
      //     RESTRICTIVE court-circuitent sur nullif(...) IS NULL → tout le tenant).
      //     C'est aussi le chemin de l'INGESTION (Vision Globale) — DÉCISION 3 :
      //     account_scope FOR ALL n'est pas posé → INSERT/UPDATE passent inchangés.
      let entityScope: ScopeEntite = { mode: "GLOBALE" };
      let accountScope: ScopeCompte = { mode: "GLOBALE" };

      if (entityIds.length > 0 || scopesFins.length > 0) {
        // (4) RÉSOLUTION DU DROIT (comptes autorisés) = comptes des parties ∪
        //     comptes directs ∪ comptes de l'axe BU. Lectures sous tenant_isolation
        //     SEUL (aucun GUC d'étage 2 encore posé — cf. note ORDRE ci-dessus).
        const accountsAutorises = new Set<string>(comptesDirects);

        // 4a. Comptes des parties autorisées (jointure party→comptes via
        //     account_party_role). Filtre workspace_id explicite (défense en
        //     profondeur) + inArray PARAMÉTRÉ (zéro interpolation, règle 2).
        if (partyIds.length > 0) {
          const lignes = await tx
            .select({ bankAccountId: accountPartyRole.bankAccountId })
            .from(accountPartyRole)
            .where(
              and(
                eq(accountPartyRole.workspaceId, activeWorkspaceId),
                inArray(accountPartyRole.partyId, partyIds),
              ),
            );
          for (const l of lignes) accountsAutorises.add(l.bankAccountId);
        }

        // 4b. Comptes de l'axe BU (member_entity_scopes → bank_accounts.entity_id).
        //     Traduit l'axe entité en comptes pour UNIFIER le DROIT en une seule
        //     maille (compte), conformément à la décision §1.3 du plan.
        if (entityIds.length > 0) {
          const lignes = await tx
            .select({ id: bankAccounts.id })
            .from(bankAccounts)
            .where(
              and(
                eq(bankAccounts.workspaceId, activeWorkspaceId),
                inArray(bankAccounts.entityId, entityIds),
              ),
            );
          for (const l of lignes) accountsAutorises.add(l.id);
        }

        // (5) Pose entity_scope (inchangé fonctionnellement vs L3, seul l'ORDRE de
        //     pose a bougé — après la résolution). GUC = CSV des entity_id.
        if (entityIds.length > 0) {
          const csvEntites = entityIds.join(",");
          await tx.execute(
            sql`select set_config('app.current_entity_scope', ${csvEntites}, true)`,
          );
          entityScope = { mode: "ENTITES", entityIds };
        }

        // (6) Pose account_scope (DÉCISION 1, cas (b)/(c)). set_config PARAMÉTRÉ ;
        //     les UUID sont LUS EN BASE (typés uuid) — pas d'entrée client.
        const accountIds = [...accountsAutorises];
        if (accountIds.length > 0) {
          // cas (c) : DROIT non vide → CSV des comptes autorisés.
          const csvComptes = accountIds.join(",");
          await tx.execute(
            sql`select set_config('app.current_account_scope', ${csvComptes}, true)`,
          );
        } else {
          // cas (b) : ≥1 ligne de scope mais DROIT = ∅ (party archivée / comptes
          //   purgés) → SENTINELLE UUID-nul (JAMAIS ''). La policy renvoie 0 ligne
          //   (fail-closed) : « périmètre vide » n'est PAS « voir tout ».
          await tx.execute(
            sql`select set_config('app.current_account_scope', ${SENTINELLE_PERIMETRE_VIDE}, true)`,
          );
        }
        accountScope = { mode: "COMPTES", accountIds };
      }

      // NOTE (DÉCISION 2) : app.current_view_filter n'est JAMAIS posé en L4. La
      // clause view_filter de la policy account_scope (0016) reste donc inerte
      // (GUC absent → court-circuit TRUE). Câblage = L5, après intersection serveur
      // avec le DROIT — JAMAIS depuis un paramètre client (vecteur IDOR).

      return fn(tx as WorkspaceTx<TDb>, {
        role: membership[0].role as WorkspaceRole,
        workspaceId: activeWorkspaceId,
        userId,
        entityScope,
        accountScope,
      });
    });
  };
}
