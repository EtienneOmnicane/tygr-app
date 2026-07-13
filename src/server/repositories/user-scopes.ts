/**
 * Périmètre fin (party / compte) par membre — OCTROI / RÉVOCATION (L6a, plan
 * PLAN-architecture-multi-tenant-omnicane.md §1.1 / §5). Écriture ADMIN-only de la
 * table `user_scopes` (créée vide en 0015) : QUELLE party ou QUEL compte un membre
 * est autorisé à voir. AUCUNE ligne = Vision Globale (fine) ; N lignes = Vision
 * restreinte. Le RÉSOLVEUR (qui pose le GUC account_scope) vit dans tenancy.ts (L4) ;
 * ce repo ne fait QUE gérer les droits, jamais les résoudre.
 *
 * ⚠️ FRONTIÈRE D'ISOLATION (point dur L6a) : `user_scopes` PILOTE `account_scope`
 * (le GUC qui borne ce qu'un membre voit). La RLS `tenant_isolation` ne connaît PAS
 * le rôle → un MANAGER non scopé (Vision Globale) PASSE la policy tenant. La garde
 * applicative `ctx.role === "ADMIN"` EST donc la sécurité contre l'élargissement
 * intra-groupe (un membre s'octroyant un périmètre). Ne JAMAIS exposer un chemin
 * d'écriture sans `exigerAdmin` en PREMIÈRE LIGNE.
 *
 * Gouvernance (calque entites.ts / provisioning.ts) :
 * - Garde ADMIN portée par le REPOSITORY (ctx.role === "ADMIN"). Le rôle vient du
 *   CONTEXTE (re-résolu à chaque requête par withWorkspace), JAMAIS d'un paramètre.
 * - `workspace_id` n'est JAMAIS un paramètre : c'est ctx.workspaceId. Un ADMIN ne peut
 *   agir que dans SON workspace (FK composites + RLS WITH CHECK = défense en base).
 * - Erreurs nommées non-énumérantes (règle 3) : ressource d'un autre tenant → 404
 *   (introuvable), jamais 403. L'autorité d'isolation reste la RLS + les FK.
 *
 * MODÈLE D'ÉCRITURE : remplace-set ATOMIQUE (calque definirScopesMembre,
 * entites.ts:391-429). Un octroi/une révocation = redéfinir le jeu complet des
 * scopes fins du membre. DELETE+INSERT dans la MÊME transaction : un INSERT en échec
 * rollback le DELETE (on ne laisse jamais un membre à demi-périmètre).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  bankAccounts,
  parties,
  userScopes,
  workspaceMembers,
} from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";

// Erreurs partagées avec le repo entités (sémantique IDENTIQUE — un membre absent du
// tenant / un compte d'un autre tenant donnent le MÊME 404 nommé partout). On les
// RÉUTILISE plutôt que d'en redéclarer un homonyme (évite un clash de ré-export dans
// le barrel @/server/db ET garantit qu'une action générique les mappe une seule fois).
import {
  AdminNonScopableError,
  CompteIntrouvableError,
  MembreNonScopableError,
  PartieIntrouvableError,
} from "@/server/repositories/entites";

export { CompteIntrouvableError, MembreNonScopableError, PartieIntrouvableError };

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/* ------------------------------------------------------------------ */
/* Erreurs nommées propres à L6a (404 jamais 403 ; refus non-énumérant)*/
/* ------------------------------------------------------------------ */

/** L'acteur n'est pas ADMIN du workspace courant. Non-énumérant (« Action non autorisée »). */
export class ScopeFinNonAutoriseError extends Error {
  readonly code = "USER_SCOPE_NOT_AUTHORIZED";
  constructor() {
    super("Action non autorisée");
    this.name = "ScopeFinNonAutoriseError";
  }
}

/* ------------------------------------------------------------------ */
/* Types de sortie (contrats lus par le Front, possédés par le Backend)*/
/* ------------------------------------------------------------------ */

/**
 * Le périmètre fin résolu d'un membre. Deux familles disjointes (CHECK XOR en base) :
 * `partyIds` (octrois ciblant une party) et `accountIds` (octrois ciblant un compte).
 * Les DEUX vides = Vision Globale (fine) — aucune ligne user_scopes pour ce membre.
 */
export interface ScopeFinMembre {
  partyIds: string[];
  accountIds: string[];
}

/**
 * Le jeu de scopes fins à POSER pour un membre (remplace l'existant). Chaque liste
 * peut être vide ; les deux vides = révocation totale (Vision Globale fine).
 */
export interface ScopesFinsAPoser {
  userId: string;
  partyIds: string[];
  accountIds: string[];
}

/* ------------------------------------------------------------------ */
/* Helper de garde (calque entites.ts:133)                             */
/* ------------------------------------------------------------------ */

function exigerAdmin(ctx: WorkspaceContext): void {
  if (ctx.role !== "ADMIN") {
    throw new ScopeFinNonAutoriseError();
  }
}

/** Déduplique en préservant un ordre déterministe (anti UNIQUE-partiel + bruit). */
function uniques(ids: string[]): string[] {
  return [...new Set(ids)];
}

/* ------------------------------------------------------------------ */
/* Lecture — périmètre fin d'un membre (ADMIN-only)                    */
/* ------------------------------------------------------------------ */

/**
 * Liste le périmètre fin d'un membre (séparé party / compte). ADMIN-only.
 * Les deux listes vides = Vision Globale (aucune ligne). Tri déterministe (UI/tests).
 *
 * Isolation : `user_scopes` est sous tenant_isolation → `tx` porte
 * app.current_workspace_id, donc SEULS les scopes du tenant courant remontent. On
 * AJOUTE un filtre explicite workspace_id = ctx (défense en profondeur, la RLS suffit).
 */
export async function listerScopesFinsMembre<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  userId: string,
): Promise<ScopeFinMembre> {
  exigerAdmin(ctx);
  const lignes = await tx
    .select({
      partyId: userScopes.partyId,
      bankAccountId: userScopes.bankAccountId,
    })
    .from(userScopes)
    .where(
      and(
        eq(userScopes.userId, userId),
        eq(userScopes.workspaceId, ctx.workspaceId),
      ),
    );

  const partyIds = lignes
    .map((l) => l.partyId)
    .filter((p): p is string => p !== null)
    .sort();
  const accountIds = lignes
    .map((l) => l.bankAccountId)
    .filter((a): a is string => a !== null)
    .sort();
  return { partyIds, accountIds };
}

/* ------------------------------------------------------------------ */
/* Écriture — remplace-set ATOMIQUE du périmètre fin (ADMIN-only)      */
/* ------------------------------------------------------------------ */

/**
 * Définit (REMPLACE) ATOMIQUEMENT le périmètre fin d'un membre : DELETE de tous ses
 * user_scopes existants + INSERT du nouveau jeu, dans la transaction withWorkspace
 * courante. C'est le primitif d'OCTROI **et** de RÉVOCATION : octroyer = ajouter la
 * cible au jeu ; révoquer = la retirer du jeu (l'appelant compose le jeu désiré).
 * `partyIds = []` ET `accountIds = []` → vide tout = Vision Globale (fine). Idempotent.
 *
 * Gardes (ordre = défense en profondeur, toutes AVANT l'écriture) :
 * - ADMIN-only (exigerAdmin) — PREMIÈRE LIGNE (la RLS ne borne pas le rôle).
 * - Le userId DOIT être membre du workspace courant → MembreNonScopableError (404).
 *   Vérifié explicitement (message propre) ; la FK composite (user_id, workspace_id)
 *   → workspace_members en serait le dernier rempart (calque entites.ts:400-405).
 * - Chaque party/compte visé DOIT exister dans le workspace courant → 404 nommé. On
 *   le vérifie EN AMONT (plutôt que de parser le SQLSTATE 23503 qui ne distingue pas
 *   party de compte) ; les FK composites scopées workspace restent le dernier rempart
 *   en base (une cible d'un autre tenant est de toute façon invisible sous RLS).
 *
 * Atomicité : DELETE puis INSERT dans la MÊME tx — si un INSERT viole une contrainte
 * (FK/CHECK/UNIQUE), la transaction rollback et le périmètre ANTÉRIEUR survit (on ne
 * « casse » jamais un périmètre existant par une redéfinition invalide).
 *
 * Le CHECK `num_nonnulls(party_id, bank_account_id) = 1` est garanti par construction :
 * on insère une ligne {partyId} OU {bankAccountId}, jamais les deux, jamais aucun.
 */
export async function definirScopesFinsMembre<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  data: ScopesFinsAPoser,
): Promise<void> {
  exigerAdmin(ctx);

  // 1. Le user visé est-il membre du workspace COURANT ? (scopé RLS → un user d'un
  //    autre tenant est invisible ici, donc traité comme non-membre → 404.)
  //    On projette AUSSI son rôle : la garde §12 porte sur la CIBLE, pas sur l'acteur.
  const membre = await tx
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, data.userId),
        eq(workspaceMembers.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (membre.length === 0) throw new MembreNonScopableError();

  // §12 — un ADMIN n'est jamais restreint à un périmètre.
  //
  // Etienne a nommé `definirScopesMembre` (l'axe ENTITÉ). La même garde est posée ici, sur
  // l'axe COMPTE/PARTY (`user_scopes` → `account_scope`), parce que le principe est le même
  // — « on refuse la combinaison ADMIN + scopé » — et que l'omettre laisserait un ADMIN se
  // scoper FINEMENT : ses lectures resteraient partielles, et ses gardes d'écriture
  // (`PerimetreReduitError`, qui teste AUSSI `ctx.accountScope`) le bloqueraient sans qu'il
  // dispose d'aucun chemin pour se réparer. Fermer un seul axe créerait un cul-de-sac.
  //
  // Le retrait d'un périmètre (listes vides) reste permis : c'est le chemin de réparation.
  const cibleVide =
    uniques(data.partyIds).length === 0 && uniques(data.accountIds).length === 0;
  if (membre[0].role === "ADMIN" && !cibleVide) {
    throw new AdminNonScopableError();
  }

  const partyIds = uniques(data.partyIds);
  const accountIds = uniques(data.accountIds);

  // 2. Existence des cibles dans le tenant courant (404 nommé précis). Une cible d'un
  //    autre workspace est invisible sous RLS → COUNT < attendu → introuvable.
  if (partyIds.length > 0) {
    const vues = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.workspaceId, ctx.workspaceId),
          inArray(parties.id, partyIds),
        ),
      );
    if (vues.length !== partyIds.length) throw new PartieIntrouvableError();
  }
  if (accountIds.length > 0) {
    const vues = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.workspaceId, ctx.workspaceId),
          inArray(bankAccounts.id, accountIds),
        ),
      );
    if (vues.length !== accountIds.length) throw new CompteIntrouvableError();
  }

  // 3. Remplacement atomique du jeu (DELETE puis INSERT dans la même tx). workspace_id
  //    = ctx (jamais paramètre ; WITH CHECK tenant_isolation le re-garantit).
  await tx
    .delete(userScopes)
    .where(
      and(
        eq(userScopes.userId, data.userId),
        eq(userScopes.workspaceId, ctx.workspaceId),
      ),
    );

  if (partyIds.length === 0 && accountIds.length === 0) return; // Vision Globale (fine)

  const lignes = [
    ...partyIds.map((partyId) => ({
      workspaceId: ctx.workspaceId,
      userId: data.userId,
      partyId,
      bankAccountId: null,
    })),
    ...accountIds.map((bankAccountId) => ({
      workspaceId: ctx.workspaceId,
      userId: data.userId,
      partyId: null,
      bankAccountId,
    })),
  ];
  await tx.insert(userScopes).values(lignes);
}

/* ------------------------------------------------------------------ */
/* Sucre OCTROI / RÉVOCATION unitaire (compose le jeu, délègue au set) */
/* ------------------------------------------------------------------ */

/**
 * Cible d'un octroi/révocation unitaire : EXACTEMENT une famille renseignée. Le repo
 * et l'action le valident (Zod XOR côté action, garde ci-dessous côté repo).
 */
export type CibleScopeFin =
  | { partyId: string; bankAccountId?: undefined }
  | { partyId?: undefined; bankAccountId: string };

/**
 * Erreur de programmation/validation : ni party ni compte, ou les deux. Côté action,
 * c'est attrapé EN AMONT par Zod (« Champs invalides ») ; cette garde est le filet
 * du repo si un appelant interne se trompe. Non-énumérante.
 */
export class CibleScopeInvalideError extends Error {
  readonly code = "USER_SCOPE_TARGET_INVALID";
  constructor() {
    super("Cible de périmètre invalide");
    this.name = "CibleScopeInvalideError";
  }
}

function normaliserCible(cible: CibleScopeFin): {
  partyId: string | null;
  bankAccountId: string | null;
} {
  const partyId = cible.partyId ?? null;
  const bankAccountId = cible.bankAccountId ?? null;
  // Miroir du CHECK num_nonnulls = 1 : exactement une cible.
  if ((partyId === null) === (bankAccountId === null)) {
    throw new CibleScopeInvalideError();
  }
  return { partyId, bankAccountId };
}

/**
 * OCTROIE une cible (party OU compte) à un membre, EN PLUS de son périmètre existant.
 * Lit le jeu courant, ajoute la cible, redéfinit le set (atomique). Idempotent : si la
 * cible est déjà octroyée, le set est inchangé (le UNIQUE partiel le garantirait sinon).
 * ADMIN-only (via definirScopesFinsMembre).
 */
export async function octroyerScopeFin<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  userId: string,
  cible: CibleScopeFin,
): Promise<void> {
  exigerAdmin(ctx);
  const { partyId, bankAccountId } = normaliserCible(cible);

  const courant = await listerScopesFinsMembre(tx, ctx, userId);
  const partyIds =
    partyId !== null ? [...courant.partyIds, partyId] : courant.partyIds;
  const accountIds =
    bankAccountId !== null
      ? [...courant.accountIds, bankAccountId]
      : courant.accountIds;

  await definirScopesFinsMembre(tx, ctx, { userId, partyIds, accountIds });
}

/**
 * RÉVOQUE une cible (party OU compte) du périmètre d'un membre. Lit le jeu courant,
 * retire la cible, redéfinit le set (atomique). Idempotent : révoquer une cible
 * absente laisse le set inchangé (pas d'erreur — révoquer ce qui n'existe pas n'est
 * pas une faute). ADMIN-only (via definirScopesFinsMembre).
 */
export async function revoquerScopeFin<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  userId: string,
  cible: CibleScopeFin,
): Promise<void> {
  exigerAdmin(ctx);
  const { partyId, bankAccountId } = normaliserCible(cible);

  const courant = await listerScopesFinsMembre(tx, ctx, userId);
  const partyIds =
    partyId !== null
      ? courant.partyIds.filter((p) => p !== partyId)
      : courant.partyIds;
  const accountIds =
    bankAccountId !== null
      ? courant.accountIds.filter((a) => a !== bankAccountId)
      : courant.accountIds;

  await definirScopesFinsMembre(tx, ctx, { userId, partyIds, accountIds });
}
