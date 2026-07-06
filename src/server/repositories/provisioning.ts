/**
 * Provisioning d'utilisateurs par un ADMIN (Epic 2 L3). Opère DANS le contexte
 * workspace (withWorkspace) — la transaction porte déjà app.current_workspace_id,
 * donc l'INSERT du membership est soumis à la policy WITH CHECK : impossible de
 * rattacher à un autre tenant que le courant (arbitrage S3).
 *
 * Garde de rôle (S3) : le rôle vient du CONTEXTE withWorkspace (re-résolu à
 * chaque requête), jamais du client. Un non-ADMIN qui appelle → rejet.
 */
import { sql } from "drizzle-orm";

import { definirScopesMembre } from "@/server/repositories/entites";
import { users, workspaceMembers } from "@/server/db/schema";
import type { WorkspaceRole } from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** L'acteur n'est pas ADMIN du workspace courant (S3). Non-énumérant. */
export class ProvisioningNonAutoriseError extends Error {
  readonly code = "PROVISIONING_NOT_AUTHORIZED";
  constructor() {
    super("Action non autorisée");
    this.name = "ProvisioningNonAutoriseError";
  }
}

/** Le rôle visé pour le nouvel utilisateur sort de la convention. */
export class RoleInvalideError extends Error {
  readonly code = "ROLE_INVALIDE";
  constructor() {
    super("Rôle invalide");
    this.name = "RoleInvalideError";
  }
}

export interface NouvelUtilisateur {
  email: string; // déjà normalisé en minuscules par la couche action
  fullName: string;
  passwordHash: string; // argon2, calculé par l'action (jamais ici)
  role: WorkspaceRole;
}

/**
 * Issue d'un rattachement — décrit ce qui a RÉELLEMENT changé, sans révéler de
 * détail exploitable. `utilisateurCree=false` ⇔ un utilisateur portait déjà cet
 * email (réutilisé SANS réécrire son mot de passe, anti-écrasement) ;
 * `membershipCreee=false` ⇔ il était déjà membre du workspace courant (aucune
 * nouvelle ligne). La couche action s'en sert pour un message VÉRIDIQUE (ne jamais
 * annoncer « créé » un utilisateur réutilisé).
 */
export interface ResultatRattachement {
  userId: string;
  utilisateurCree: boolean;
  membershipCreee: boolean;
}

/** Résultat du chaînage création → périmètre (creerMembreAvecScopes). */
export interface ResultatProvisioningMembre extends ResultatRattachement {
  /** true ⇔ definirScopesMembre a effectivement posé un périmètre (membership neuve + ≥1 entité). */
  scopesDefinis: boolean;
}

const ROLES_ASSIGNABLES: readonly WorkspaceRole[] = [
  "ADMIN",
  "MANAGER",
  "VIEWER",
];

/**
 * Crée (ou réutilise) un utilisateur par email et le rattache au workspace
 * COURANT avec le rôle donné. À exécuter DANS withWorkspace(session, fn) :
 * `tx` et `ctx` viennent du contexte scopé.
 *
 * - Garde S3 : ctx.role doit être ADMIN, sinon rejet (le rôle vient du
 *   contexte, pas d'un paramètre client).
 * - Le workspace cible n'est JAMAIS un paramètre : c'est ctx.workspaceId. Un
 *   ADMIN ne peut donc provisionner que dans SON workspace (pas de cross-tenant).
 * - L'INSERT membership passe par la policy WITH CHECK (workspace_id = contexte).
 */
export async function creerUtilisateurEtRattacher<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  nouvel: NouvelUtilisateur,
): Promise<ResultatRattachement> {
  if (ctx.role !== "ADMIN") {
    throw new ProvisioningNonAutoriseError();
  }
  if (!ROLES_ASSIGNABLES.includes(nouvel.role)) {
    throw new RoleInvalideError();
  }

  // users est hors RLS : lookup/insert direct. Email normalisé en amont.
  const existant = await tx
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${nouvel.email})`)
    .limit(1);

  let userId: string;
  let utilisateurCree: boolean;
  if (existant.length > 0) {
    // Utilisateur déjà connu : on RÉUTILISE sans jamais réécrire son mot de passe
    // (anti-écrasement — le passwordHash reçu est volontairement ignoré ici).
    userId = existant[0].id;
    utilisateurCree = false;
  } else {
    const inseres = await tx
      .insert(users)
      .values({
        email: nouvel.email,
        fullName: nouvel.fullName,
        passwordHash: nouvel.passwordHash,
      })
      .returning({ id: users.id });
    userId = inseres[0].id;
    utilisateurCree = true;
  }

  // Rattachement au workspace COURANT (ctx.workspaceId) — WITH CHECK garantit
  // qu'on ne vise pas un autre tenant. Idempotent (ON CONFLICT do nothing) :
  // `returning` non vide ⇔ une nouvelle membership a été posée (n'était pas déjà membre).
  const membership = await tx
    .insert(workspaceMembers)
    .values({
      userId,
      workspaceId: ctx.workspaceId,
      role: nouvel.role,
    })
    .onConflictDoNothing()
    .returning({ userId: workspaceMembers.userId });

  return { userId, utilisateurCree, membershipCreee: membership.length > 0 };
}

/**
 * Chaînage ATOMIQUE « créer un membre + définir son périmètre entité », dans la
 * transaction withWorkspace de l'appelant. C'est la couture testable du provisioning
 * avec scopes (les Server Actions dépendent d'Auth.js ; les suites d'isolation exercent
 * CETTE fonction directement).
 *
 * Séquence (une seule tx → tout rollback sur échec) :
 *  1. `creerUtilisateurEtRattacher` (garde ADMIN + WITH CHECK tenant).
 *  2. `definirScopesMembre` UNIQUEMENT si une membership NEUVE a été créée ET qu'au
 *     moins une entité est demandée. Justification (anti-écrasement, cohérent avec la
 *     réutilisation d'utilisateur ci-dessus) : re-« provisionner » un email DÉJÀ membre
 *     ne doit pas écraser silencieusement le périmètre réglé ailleurs (`/admin/entites`).
 *     Un membre neuf sans entité demandée → Vision Globale (défaut naturel, aucune ligne).
 *
 * ⚠️ ISOLATION (règle 3) : `definirScopesMembre` porte la FK composite
 * `(entity_id, workspace_id) → entities` — une entité d'un AUTRE tenant lève
 * `EntiteIntrouvableError`, ce qui rollback l'INSERT user + membership de l'étape 1
 * (atomicité). Un membre du workspace A ne peut donc JAMAIS naître avec un scope de B,
 * et rien ne persiste sur échec. La garde ADMIN vit dans les DEUX repos appelés, jamais
 * ici en double ni côté client.
 */
export async function creerMembreAvecScopes<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  nouvel: NouvelUtilisateur & { entityIds: string[] },
): Promise<ResultatProvisioningMembre> {
  const rattachement = await creerUtilisateurEtRattacher(tx, ctx, {
    email: nouvel.email,
    fullName: nouvel.fullName,
    passwordHash: nouvel.passwordHash,
    role: nouvel.role,
  });

  let scopesDefinis = false;
  if (rattachement.membershipCreee && nouvel.entityIds.length > 0) {
    await definirScopesMembre(tx, ctx, {
      userId: rattachement.userId,
      entityIds: nouvel.entityIds,
    });
    scopesDefinis = true;
  }

  return { ...rattachement, scopesDefinis };
}
