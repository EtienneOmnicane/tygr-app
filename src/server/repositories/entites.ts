/**
 * Gestion des Entités (BU) — Option B, plan PLAN-entites-multi-tenant.md §3.3 (L3).
 * Référentiel d'entités sous le workspace + assignation compte→entité (sas) +
 * périmètre « Vision Entité » d'un membre (member_entity_scopes, N:N).
 *
 * Toutes les fonctions s'exécutent DANS withWorkspace(session, fn) : `tx` porte
 * app.current_workspace_id (+ user + entity_scope) → chaque requête est filtrée par
 * la RLS tenant_isolation (étage 1) et, sur bank_accounts, par entity_scope (étage 2).
 *
 * Gouvernance (calque sur provisioning.ts) :
 * - Garde ADMIN portée par le REPOSITORY (ctx.role === "ADMIN"). Le rôle vient du
 *   CONTEXTE (re-résolu à chaque requête par withWorkspace), JAMAIS d'un paramètre.
 * - `workspace_id` n'est JAMAIS un paramètre : c'est ctx.workspaceId. Un ADMIN ne peut
 *   donc agir que dans SON workspace (les FK composites + WITH CHECK interdisent le
 *   cross-tenant en base — défense en profondeur).
 * - Erreurs nommées non-énumérantes (règle 3) : ressource d'un autre tenant → 404
 *   (introuvable), jamais 403 (pas d'oracle d'existence). L'autorité d'isolation reste
 *   la RLS + les FK, pas un WHERE applicatif.
 *
 * ⚠️ RBAC (décision plan §3.1, confirmée 2026-06-22) : pas de rôle GROUP_AUDITOR au
 * MVP. Vision Globale = membre SANS ligne member_entity_scopes ; Vision Entité = membre
 * AVEC. La gestion entités/scopes/assignation est ADMIN-only (cette garde).
 */
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  accountPartyRole,
  bankAccounts,
  entities,
  memberEntityScopes,
  parties,
  users,
  workspaceMembers,
} from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";
import type { WorkspaceRole } from "@/server/db/schema";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/* ------------------------------------------------------------------ */
/* Erreurs nommées (registre plan §4.3 ; 404 jamais 403)              */
/* ------------------------------------------------------------------ */

/** L'acteur n'est pas ADMIN du workspace courant. Non-énumérant. */
export class EntiteNonAutoriseError extends Error {
  readonly code = "ENTITY_NOT_AUTHORIZED";
  constructor() {
    super("Action non autorisée");
    this.name = "EntiteNonAutoriseError";
  }
}

/** Entité absente du workspace courant (introuvable = pas d'oracle d'existence). */
export class EntiteIntrouvableError extends Error {
  readonly code = "ENTITY_NOT_FOUND";
  constructor() {
    super("Entité introuvable");
    this.name = "EntiteIntrouvableError";
  }
}

/** Compte bancaire absent du workspace courant. */
export class CompteIntrouvableError extends Error {
  readonly code = "BANK_ACCOUNT_NOT_FOUND";
  constructor() {
    super("Compte introuvable");
    this.name = "CompteIntrouvableError";
  }
}

/** Party (entité légale Omni-FI) absente du workspace courant. */
export class PartieIntrouvableError extends Error {
  readonly code = "PARTY_NOT_FOUND";
  constructor() {
    super("Partie introuvable");
    this.name = "PartieIntrouvableError";
  }
}

/** UNIQUE(workspace_id, name) violée : deux entités homonymes dans le groupe. */
export class EntiteNomDupliqueError extends Error {
  readonly code = "ENTITY_NAME_DUPLICATE";
  constructor() {
    super("Une entité porte déjà ce nom");
    this.name = "EntiteNomDupliqueError";
  }
}

/** Le userId visé n'est pas membre du workspace courant (donc non scopable). */
export class MembreNonScopableError extends Error {
  readonly code = "MEMBER_NOT_IN_WORKSPACE";
  constructor() {
    super("Membre introuvable");
    this.name = "MembreNonScopableError";
  }
}

/* ------------------------------------------------------------------ */
/* Types de sortie (contrats lus par le Front, possédés par le Backend)*/
/* ------------------------------------------------------------------ */

export interface EntiteLue {
  id: string;
  name: string;
  code: string | null;
  isActive: boolean;
  /** Nb de comptes assignés à cette entité (agrégat scopé workspace). */
  nbComptes: number;
}

/**
 * Un membre du workspace courant + son périmètre « Vision Entité » résolu en UNE
 * requête (l'écran d'assignation consomme ceci, plan §3.3 L4). `scopeInitial = []`
 * → Vision Globale (aucune ligne member_entity_scopes). Le Front mappe directement
 * ce contrat sur sa `MembreVue` (userId/nomComplet/email/role/scopeInitial).
 */
export interface MembreScope {
  userId: string;
  nomComplet: string;
  email: string;
  role: WorkspaceRole;
  /** entityIds du périmètre du membre ; [] = Vision Globale. */
  scopeInitial: string[];
}

/** Un compte bancaire porté par une proposition (projection scopée workspace). */
export interface CompteDeProposition {
  bankAccountId: string;
  accountName: string;
  currency: string;
  /** entity_id ACTUEL du compte (null = non assigné). Sert au bilan « déjà assigné ». */
  entityIdActuel: string | null;
}

/**
 * Proposition de rattachement dérivée d'une Party Omni-FI persistée (ENTITY-PARTY1).
 * PRÉ-REMPLISSAGE, PAS une décision : c'est l'ADMIN qui confirme dans le sas avant
 * qu'aucun entity_id ne soit posé. Une proposition = une PARTY distincte du workspace
 * courant (une party = un PartyName Omni-FI ; on ne fusionne PAS deux parties homonymes
 * — la clé métier reste la party, pas le libellé, pour rester déterministe et scopé).
 *
 * `entiteExistanteId` : si une entité ACTIVE porte déjà EXACTEMENT ce nom, on la
 * propose comme cible (pas de doublon d'entité) ; sinon null → l'ADMIN créera l'entité
 * au moment de confirmer. `entiteDejaRattachee` reflète parties.entity_id (déjà posé à
 * la main). Le Front n'a AUCUNE logique de décision : il affiche + envoie la confirmation.
 */
export interface PropositionEntite {
  partyId: string;
  /** PartyName Omni-FI (peut être null à la source → proposition « sans nom »). */
  partyName: string | null;
  /** entity_id déjà rattaché à la party (null = non rattachée). */
  entiteDejaRattacheeId: string | null;
  /** id d'une entité ACTIVE homonyme si elle existe déjà dans le workspace, sinon null. */
  entiteExistanteId: string | null;
  /** Comptes de cette party (via account_party_role), scopés workspace + entité. */
  comptes: CompteDeProposition[];
}

/* ------------------------------------------------------------------ */
/* Helpers internes                                                    */
/* ------------------------------------------------------------------ */

/** Code SQLSTATE Postgres porté par l'erreur driver (via la chaîne des causes). */
function codePg(e: unknown): string | undefined {
  let cur: unknown = e;
  while (cur instanceof Error) {
    const c = (cur as { code?: unknown }).code;
    // Un SQLSTATE Postgres fait 5 caractères (ex. 23505) ; on ignore les `code`
    // applicatifs de nos propres erreurs (chaînes nommées comme ENTITY_NOT_FOUND).
    if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function exigerAdmin(ctx: WorkspaceContext): void {
  if (ctx.role !== "ADMIN") {
    throw new EntiteNonAutoriseError();
  }
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Liste les entités du workspace courant + le nombre de comptes assignés à chacune.
 * LEFT JOIN sur bank_accounts (un compte non assigné n'incrémente aucune entité).
 * ⚠️ Le comptage de comptes hérite de la policy entity_scope (étage 2) : en Vision
 * Entité, nbComptes ne reflète que les comptes du périmètre — acceptable car cette
 * fonction est ADMIN-only (Vision Globale par construction), donc voit tout.
 */
export async function listerEntites<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
): Promise<EntiteLue[]> {
  exigerAdmin(ctx);
  const lignes = await tx
    .select({
      id: entities.id,
      name: entities.name,
      code: entities.code,
      isActive: entities.isActive,
      nbComptes: sql<number>`count(${bankAccounts.id})::int`,
    })
    .from(entities)
    .leftJoin(bankAccounts, eq(bankAccounts.entityId, entities.id))
    .groupBy(entities.id, entities.name, entities.code, entities.isActive)
    .orderBy(entities.name);
  return lignes;
}

/**
 * Liste les entités du périmètre d'un membre (member_entity_scopes). Tableau vide =
 * Vision Globale. ADMIN-only.
 */
export async function listerScopesMembre<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  userId: string,
): Promise<string[]> {
  exigerAdmin(ctx);
  const lignes = await tx
    .select({ entityId: memberEntityScopes.entityId })
    .from(memberEntityScopes)
    .where(eq(memberEntityScopes.userId, userId));
  return lignes.map((l) => l.entityId);
}

/**
 * Liste TOUS les membres du workspace courant AVEC leur périmètre « Vision Entité »,
 * résolu en UNE seule requête (anti-N+1 : remplace la boucle Front qui appelait
 * listerScopesMembre par membre — feedback back, plan §3.3 L4). ADMIN-only.
 *
 * Jointure :
 *   workspace_members ⋈ users           (nom/email/rôle ; users hors RLS, pas tenant)
 *   ⟕ member_entity_scopes              (périmètre, 0..N lignes par membre)
 *   GROUP BY membre → array_agg des entity_id (scopeInitial).
 *
 * Isolation : workspace_members ET member_entity_scopes sont sous RLS tenant_isolation
 * → `tx` porte app.current_workspace_id, donc SEULS les membres/scopes du tenant courant
 * remontent. On AJOUTE un filtre explicite workspace_id = ctx (défense en profondeur,
 * la RLS suffirait) ET la jointure member_entity_scopes est bornée au MÊME workspace
 * (un scope ne peut de toute façon pas viser un autre tenant — FK composite). `users`
 * n'est pas tenant : la frontière vient de workspace_members, pas de la table users.
 *
 * array_remove(array_agg(...), NULL) : un LEFT JOIN sans scope produit une ligne NULL
 * que array_agg agrégerait en `{NULL}` → on la retire pour rendre `[]` (Vision Globale)
 * et non `[null]`. Tri par nom (UI ordonnée, déterministe).
 */
export async function listerMembresWorkspace<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
): Promise<MembreScope[]> {
  exigerAdmin(ctx);
  const lignes = await tx
    .select({
      userId: workspaceMembers.userId,
      nomComplet: users.fullName,
      email: users.email,
      role: workspaceMembers.role,
      // array_agg + array_remove(NULL) → string[] des entity_id (jamais [null]).
      // ::text[] : on renvoie des UUID en chaînes (cohérent avec scopeInitial Front).
      scopeInitial: sql<
        string[]
      >`coalesce(array_remove(array_agg(${memberEntityScopes.entityId}), null), '{}')::text[]`,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .leftJoin(
      memberEntityScopes,
      and(
        eq(memberEntityScopes.userId, workspaceMembers.userId),
        // Borne la jointure au MÊME workspace (défense en profondeur ; la RLS et la
        // FK composite l'imposent déjà).
        eq(memberEntityScopes.workspaceId, ctx.workspaceId),
      ),
    )
    // RLS scope déjà au workspace ; filtre explicite (défense en profondeur).
    .where(eq(workspaceMembers.workspaceId, ctx.workspaceId))
    .groupBy(
      workspaceMembers.userId,
      users.fullName,
      users.email,
      workspaceMembers.role,
    )
    .orderBy(users.fullName);

  return lignes.map((l) => ({
    userId: l.userId,
    nomComplet: l.nomComplet,
    email: l.email,
    role: l.role as WorkspaceRole,
    scopeInitial: l.scopeInitial,
  }));
}

/**
 * PONT Party → entité en PRÉ-REMPLISSAGE (ENTITY-PARTY1, décision PO 2026-07-02).
 * Surface, pour le workspace COURANT, les PROPOSITIONS de rattachement dérivées des
 * Parties Omni-FI DÉJÀ persistées à l'ingestion (`parties` + `account_party_role`).
 * C'est la donnée qui alimente le sas de validation ADMIN : chaque party y devient un
 * candidat (nom d'entité proposé = PartyName), avec la liste de SES comptes, un drapeau
 * « une entité homonyme existe déjà » et le rattachement éventuel déjà posé. AUCUNE
 * écriture ici (lecture pure) ; c'est `confirmerPropositionAction` qui, sur décision
 * ADMIN, posera entity_id via les gates existantes.
 *
 * ⚠️ ISOLATION — deux étages, jamais contournés :
 *  - Étage 1 (tenant) : `parties`, `account_party_role`, `bank_accounts` sont sous
 *    `tenant_isolation` ; `tx` porte app.current_workspace_id → seules les lignes du
 *    tenant courant remontent. On AJOUTE des filtres explicites workspace_id = ctx
 *    (défense en profondeur ; la RLS suffirait).
 *  - Étage 2 (entité, ENTITY-READ-JOIN1) : la liste des comptes passe par un
 *    INNER JOIN sur `bank_accounts`, JAMAIS par une lecture directe de la table de
 *    liaison — la policy `entity_scope` de bank_accounts mord ainsi PAR HÉRITAGE de
 *    jointure. Un compte hors périmètre ne peut donc pas fuiter dans une proposition.
 *    (En pratique cette fonction est ADMIN-only = Vision Globale, mais le join reste
 *    obligatoire : on ne relâche jamais la règle de scoping par jointure.)
 *
 * ADMIN-only (le sas d'assignation est réservé à l'ADMIN, cf. reste du repo). Parties
 * INACTIVES exclues. Tri déterministe par PartyName puis id (UI ordonnée, stable).
 */
export async function listerPropositionsPartyEntite<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
): Promise<PropositionEntite[]> {
  exigerAdmin(ctx);

  // 1. Parties actives du workspace courant (candidats). LEFT JOIN sur une entité
  //    ACTIVE HOMONYME (même workspace, même name) pour proposer une cible existante
  //    plutôt que d'en recréer une. Scopé RLS + filtre explicite (défense en profondeur).
  const partiesLignes = await tx
    .select({
      partyId: parties.id,
      partyName: parties.name,
      entiteDejaRattacheeId: parties.entityId,
      entiteExistanteId: entities.id,
    })
    .from(parties)
    .leftJoin(
      entities,
      and(
        eq(entities.workspaceId, ctx.workspaceId),
        eq(entities.name, parties.name),
        eq(entities.isActive, true),
      ),
    )
    .where(
      and(eq(parties.workspaceId, ctx.workspaceId), eq(parties.isActive, true)),
    )
    .orderBy(parties.name, parties.id);

  if (partiesLignes.length === 0) return [];

  // 2. Comptes de ces parties, via account_party_role ⋈ bank_accounts
  //    (ENTITY-READ-JOIN1 : le scope entité mord par la JOINTURE sur bank_accounts,
  //    jamais par une lecture directe de la liaison). Scopé RLS + filtre explicite.
  const comptesLignes = await tx
    .select({
      partyId: accountPartyRole.partyId,
      bankAccountId: bankAccounts.id,
      accountName: bankAccounts.accountName,
      currency: bankAccounts.currency,
      entityIdActuel: bankAccounts.entityId,
    })
    .from(accountPartyRole)
    .innerJoin(
      bankAccounts,
      and(
        eq(bankAccounts.id, accountPartyRole.bankAccountId),
        eq(bankAccounts.workspaceId, ctx.workspaceId),
      ),
    )
    .where(eq(accountPartyRole.workspaceId, ctx.workspaceId))
    .orderBy(bankAccounts.accountName, bankAccounts.id);

  // 3. Regroupe les comptes par party (en mémoire — petits volumes : ~28 parties,
  //    ~77 liens en prod). Aucune donnée hors scope ne peut atteindre ce Map (les
  //    deux requêtes sont bornées workspace + RLS + join bank_accounts).
  const comptesParParty = new Map<string, CompteDeProposition[]>();
  for (const c of comptesLignes) {
    const liste = comptesParParty.get(c.partyId) ?? [];
    liste.push({
      bankAccountId: c.bankAccountId,
      accountName: c.accountName,
      currency: c.currency,
      entityIdActuel: c.entityIdActuel,
    });
    comptesParParty.set(c.partyId, liste);
  }

  return partiesLignes.map((p) => ({
    partyId: p.partyId,
    partyName: p.partyName,
    entiteDejaRattacheeId: p.entiteDejaRattacheeId,
    entiteExistanteId: p.entiteExistanteId,
    comptes: comptesParParty.get(p.partyId) ?? [],
  }));
}

/* ------------------------------------------------------------------ */
/* Écriture — CRUD entités                                             */
/* ------------------------------------------------------------------ */

/**
 * Crée une entité dans le workspace COURANT. workspace_id = ctx (jamais paramètre) ;
 * le WITH CHECK tenant_isolation garantit qu'on n'écrit pas dans un autre tenant.
 */
export async function creerEntite<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  data: { name: string; code?: string | null },
): Promise<{ entityId: string }> {
  exigerAdmin(ctx);
  try {
    const inseres = await tx
      .insert(entities)
      .values({
        workspaceId: ctx.workspaceId,
        name: data.name,
        code: data.code ?? null,
      })
      .returning({ id: entities.id });
    return { entityId: inseres[0].id };
  } catch (e) {
    if (codePg(e) === "23505") throw new EntiteNomDupliqueError(); // unique_violation
    throw e;
  }
}

/**
 * Renomme une entité du workspace courant. 0 ligne touchée (entité d'un autre tenant
 * masquée par la RLS, ou id inexistant) → EntiteIntrouvableError (404).
 */
export async function renommerEntite<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  data: { entityId: string; name: string },
): Promise<void> {
  exigerAdmin(ctx);
  try {
    const maj = await tx
      .update(entities)
      .set({ name: data.name })
      .where(eq(entities.id, data.entityId))
      .returning({ id: entities.id });
    if (maj.length === 0) throw new EntiteIntrouvableError();
  } catch (e) {
    if (e instanceof EntiteIntrouvableError) throw e;
    if (codePg(e) === "23505") throw new EntiteNomDupliqueError();
    throw e;
  }
}

/**
 * Archive une entité (is_active=false) — JAMAIS de DELETE (ON DELETE RESTRICT côté FK,
 * et l'archivage est l'opération métier). Le compte garde son entity_id ; l'entité
 * disparaît des pickers (filtrage is_active côté lecture Front). 0 ligne → 404.
 */
export async function archiverEntite<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  entityId: string,
): Promise<void> {
  exigerAdmin(ctx);
  const maj = await tx
    .update(entities)
    .set({ isActive: false })
    .where(eq(entities.id, entityId))
    .returning({ id: entities.id });
  if (maj.length === 0) throw new EntiteIntrouvableError();
}

/* ------------------------------------------------------------------ */
/* Écriture — sas d'assignation compte → entité                        */
/* ------------------------------------------------------------------ */

/**
 * Assigne un compte à une entité (sas, §1.5), ou le repasse en « non assigné »
 * (entityId = null). workspace_id = ctx (jamais paramètre) + filtre explicite
 * (défense en profondeur, la RLS suffirait). 0 ligne (compte d'un autre tenant /
 * inexistant) → CompteIntrouvableError (404). Une entityId d'un autre workspace est
 * rejetée par la FK COMPOSITE (entity_id, workspace_id) → EntiteIntrouvableError.
 *
 * ⚠️ Écriture sous garde ADMIN (Vision Globale) : la policy entity_scope FOR ALL
 * (0009) ne gêne pas l'ADMIN (GUC vide → tout passe). Un membre scopé ne passerait pas
 * la garde ADMIN de toute façon.
 */
export async function assignerCompteEntite<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  data: { bankAccountId: string; entityId: string | null },
): Promise<void> {
  exigerAdmin(ctx);
  try {
    const maj = await tx
      .update(bankAccounts)
      .set({ entityId: data.entityId })
      .where(
        and(
          eq(bankAccounts.id, data.bankAccountId),
          eq(bankAccounts.workspaceId, ctx.workspaceId),
        ),
      )
      .returning({ id: bankAccounts.id });
    if (maj.length === 0) throw new CompteIntrouvableError();
  } catch (e) {
    if (e instanceof CompteIntrouvableError) throw e;
    // FK composite (entity_id, workspace_id) → entities : entité absente du workspace.
    if (codePg(e) === "23503") throw new EntiteIntrouvableError(); // foreign_key_violation
    throw e;
  }
}

/**
 * Assigne une PARTY (entité légale Omni-FI) à une entité (BU), ou la repasse en
 * « non rattachée » (entityId = null). Pendant côté `parties` de assignerCompteEntite
 * (L6b). Même gabarit exactement : UPDATE borné workspace_id = ctx (jamais paramètre),
 * 0 ligne (party d'un autre tenant / inexistante) → PartieIntrouvableError (404, pas
 * d'oracle d'existence), SQLSTATE 23503 (FK composite parties_entity_workspace_fk) →
 * EntiteIntrouvableError (entity_id d'un autre workspace).
 *
 * ⚠️ INVARIANT CRITIQUE (L6b) : `parties.entity_id` est un rattachement BU posé à la
 * MAIN par l'ADMIN. L'ingestion (`upsertPartieEtRole`) l'OMET VOLONTAIREMENT de son
 * `set` ON CONFLICT pour qu'un re-sync ne l'écrase jamais. Cette fonction écrit
 * `entity_id` par un chemin SÉPARÉ (UPDATE direct gardé) : elle ne passe PAS par
 * `upsertPartieEtRole` et ne change RIEN à cet ON CONFLICT. Un re-sync ultérieur ne
 * réécrase donc pas l'assignation posée ici (prouvé par la suite d'isolation).
 *
 * ⚠️ Écriture sous garde ADMIN (Vision Globale) : `parties` n'a PAS de policy
 * entity_scope (le périmètre entité borne bank_accounts, pas la table d'entités
 * légales) ; seules tenant_isolation (étage 1) + la garde ADMIN gouvernent ici.
 */
export async function assignerPartieEntite<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  data: { partyId: string; entityId: string | null },
): Promise<void> {
  exigerAdmin(ctx);
  try {
    const maj = await tx
      .update(parties)
      .set({ entityId: data.entityId })
      .where(
        and(
          eq(parties.id, data.partyId),
          eq(parties.workspaceId, ctx.workspaceId),
        ),
      )
      .returning({ id: parties.id });
    if (maj.length === 0) throw new PartieIntrouvableError();
  } catch (e) {
    if (e instanceof PartieIntrouvableError) throw e;
    // FK composite (entity_id, workspace_id) → entities : entité absente du workspace.
    if (codePg(e) === "23503") throw new EntiteIntrouvableError(); // foreign_key_violation
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Écriture — périmètre « Vision Entité » d'un membre                  */
/* ------------------------------------------------------------------ */

/**
 * Définit (remplace) ATOMIQUEMENT le périmètre d'un membre : DELETE des scopes
 * existants + INSERT du nouveau jeu, dans la transaction withWorkspace courante.
 * `entityIds = []` → vide tous les scopes = Vision Globale (le membre voit tout le
 * tenant). Idempotent.
 *
 * Gardes :
 * - ADMIN-only (exigerAdmin).
 * - Le userId DOIT être membre du workspace courant → sinon MembreNonScopableError
 *   (404). Vérifié explicitement (message propre) AVANT l'écriture ; la FK composite
 *   (user_id, workspace_id) → workspace_members en serait le dernier rempart.
 * - Chaque entityId DOIT appartenir au workspace courant → la FK composite
 *   (entity_id, workspace_id) → entities rejette tout id d'un autre tenant
 *   (EntiteIntrouvableError). Le DELETE+INSERT étant dans une transaction, un échec
 *   d'INSERT rollback le DELETE (atomicité — on ne laisse pas un membre sans scope
 *   par accident).
 * - workspace_id n'est JAMAIS un paramètre : c'est ctx.workspaceId (WITH CHECK).
 */
export async function definirScopesMembre<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  data: { userId: string; entityIds: string[] },
): Promise<void> {
  exigerAdmin(ctx);

  // 1. Le user visé est-il membre du workspace COURANT ? (scopé RLS → un user d'un
  //    autre tenant est invisible ici, donc traité comme non-membre → 404.)
  const membre = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, data.userId))
    .limit(1);
  if (membre.length === 0) throw new MembreNonScopableError();

  // 2. Remplacement atomique du jeu de scopes (DELETE puis INSERT dans la même tx).
  await tx
    .delete(memberEntityScopes)
    .where(eq(memberEntityScopes.userId, data.userId));

  if (data.entityIds.length === 0) return; // [] = Vision Globale (aucune ligne)

  // Dédoublonnage défensif (la PK composite l'exigerait sinon).
  const uniques = [...new Set(data.entityIds)];
  try {
    await tx.insert(memberEntityScopes).values(
      uniques.map((entityId) => ({
        workspaceId: ctx.workspaceId,
        userId: data.userId,
        entityId,
      })),
    );
  } catch (e) {
    // FK composite (entity_id, workspace_id) → entities : un id hors workspace.
    if (codePg(e) === "23503") throw new EntiteIntrouvableError();
    throw e;
  }
}
