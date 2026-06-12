/**
 * Repository identité — UNIQUE point d'accès aux données pré-contexte
 * workspace (CLAUDE.md règle 2 : l'accès DB vit dans src/lib + src/repositories).
 *
 * Périmètre : le parcours d'authentification (plan E6/E7/E18) AVANT qu'un
 * contexte tenant n'existe. Trois familles :
 * - `users` : méta-table d'identité hors RLS (plan v2.1) — lookup par email,
 *   machine d'état lockout persistée.
 * - `login_attempts` : infrastructure rate-limit IP, hors RLS.
 * - `workspace_members` : SOUS RLS — la lecture pré-contexte passe par la
 *   policy `own_memberships_select` (app.current_user_id posé en transaction),
 *   qui ne rend QUE les memberships de l'utilisateur lui-même. Aucun bypass.
 *
 * Factory (même contrat que createWithWorkspace) : injection de la base pour
 * tester sur PGlite sans variable d'environnement.
 */
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { loginAttempts, users, workspaceMembers } from "@/db/schema";
import type { WorkspaceRole } from "@/db/schema";
import { evaluerEchec, evaluerSucces } from "@/server/auth/lockout";
import { debutFenetre } from "@/server/auth/rate-limit-ip";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface UtilisateurIdentite {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string | null;
  isActive: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export interface MembershipResume {
  workspaceId: string;
  role: WorkspaceRole;
}

export function creerRepositoryIdentite<TDb extends AnyPgDatabase>(db: TDb) {
  return {
    /** Lookup insensible à la casse (index unique sur lower(email)). */
    async trouverParEmail(email: string): Promise<UtilisateurIdentite | null> {
      const lignes = await db
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          passwordHash: users.passwordHash,
          isActive: users.isActive,
          failedLoginCount: users.failedLoginCount,
          lockedUntil: users.lockedUntil,
        })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${email})`)
        .limit(1);
      return lignes[0] ?? null;
    },

    /** Re-validation E6 — appelée à chaque requête par le bridge session. */
    async estActif(userId: string): Promise<boolean> {
      const lignes = await db
        .select({ isActive: users.isActive })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return lignes[0]?.isActive === true;
    },

    /**
     * Échec de connexion : transition de la machine d'état lockout, sous
     * verrou de ligne (FOR UPDATE) — deux échecs concurrents ne peuvent pas
     * écraser le même compteur (cas limite « concurrence », règle 3).
     */
    async enregistrerEchec(userId: string, maintenant: Date): Promise<void> {
      await db.transaction(async (tx) => {
        const lignes = await tx
          .select({ failedLoginCount: users.failedLoginCount })
          .from(users)
          .where(eq(users.id, userId))
          .for("update");
        if (lignes.length === 0) {
          return; // utilisateur disparu entre lookup et échec : rien à faire
        }
        const etat = evaluerEchec(lignes[0].failedLoginCount, maintenant);
        await tx
          .update(users)
          .set({
            failedLoginCount: etat.failedLoginCount,
            lockedUntil: etat.lockedUntil,
          })
          .where(eq(users.id, userId));
      });
    },

    /** Succès de connexion : remise à zéro du lockout. */
    async reinitialiserEchecs(userId: string): Promise<void> {
      const etat = evaluerSucces();
      await db
        .update(users)
        .set({
          failedLoginCount: etat.failedLoginCount,
          lockedUntil: etat.lockedUntil,
        })
        .where(eq(users.id, userId));
    },

    /** Tentatives (succès + échecs) de l'IP dans la fenêtre glissante (E7). */
    async compterTentativesIp(ip: string, maintenant: Date): Promise<number> {
      const lignes = await db
        .select({ total: count() })
        .from(loginAttempts)
        .where(
          and(
            eq(loginAttempts.ip, ip),
            gte(loginAttempts.attemptedAt, debutFenetre(maintenant)),
          ),
        );
      return lignes[0]?.total ?? 0;
    },

    async enregistrerTentativeIp(
      ip: string,
      succeeded: boolean,
    ): Promise<void> {
      await db.insert(loginAttempts).values({ ip, succeeded });
    },

    /**
     * Memberships de l'utilisateur, lus SOUS RLS via own_memberships_select :
     * app.current_user_id est posé en transaction (jamais session-level), la
     * policy ne rend que ses propres lignes — prouvé par la suite isolation.
     * Tri déterministe (workspace_id) : le choix du workspace par défaut au
     * login ne dépend pas de l'ordre d'insertion.
     */
    async membershipsDe(userId: string): Promise<MembershipResume[]> {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.current_user_id', ${userId}, true)`,
        );
        const lignes = await tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            role: workspaceMembers.role,
          })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, userId))
          .orderBy(workspaceMembers.workspaceId);
        return lignes.map((l) => ({
          workspaceId: l.workspaceId,
          role: l.role as WorkspaceRole,
        }));
      });
    },
  };
}

export type RepositoryIdentite = ReturnType<typeof creerRepositoryIdentite>;
