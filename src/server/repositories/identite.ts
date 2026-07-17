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

import {
  bankAccounts,
  loginAttempts,
  users,
  workspaceMembers,
  workspaces,
} from "@/server/db/schema";
import type { WorkspaceRole } from "@/server/db/schema";
import { estVerrouille, evaluerEchec, evaluerSucces } from "@/server/auth/lockout";
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
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
}

/** État du compte relu à CHAQUE requête gardée (E6 étendu — AUTH-MDP-TEMPO1 D3/D4). */
export interface EtatCompte {
  isActive: boolean;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
}

/**
 * Erreurs nommées du changement de mot de passe (registre S2 du plan
 * AUTH-MDP-TEMPO1 §6). Messages sans PII ; les codes machine servent au
 * mapping de l'action et aux logs structurés.
 */

/** Compte inexistant ou désactivé — indistinguable d'un non-connecté (fail-closed). */
export class CompteIndisponibleError extends Error {
  readonly code = "ACCOUNT_UNAVAILABLE";
  constructor() {
    super("Compte indisponible");
    this.name = "CompteIndisponibleError";
  }
}

/** Verrou lockout E18 actif — rien n'est écrit (pas d'extension de verrou). */
export class CompteVerrouilleError extends Error {
  readonly code = "ACCOUNT_LOCKED";
  constructor() {
    super("Compte temporairement verrouillé");
    this.name = "CompteVerrouilleError";
  }
}

/** password_hash NULL (SSO futur) — jamais de verify sur NULL. */
export class CompteSansMotDePasseError extends Error {
  readonly code = "NO_PASSWORD_SET";
  constructor() {
    super("Ce compte n'utilise pas de mot de passe");
    this.name = "CompteSansMotDePasseError";
  }
}

/** Mot de passe actuel refusé — a compté comme un échec de connexion (D6). */
export class MotDePasseActuelIncorrectError extends Error {
  readonly code = "CURRENT_PASSWORD_INCORRECT";
  constructor() {
    super("Mot de passe actuel incorrect");
    this.name = "MotDePasseActuelIncorrectError";
  }
}

export interface MembershipResume {
  workspaceId: string;
  role: WorkspaceRole;
}

export interface MembershipAvecNom extends MembershipResume {
  nom: string;
  kind: string;
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
          mustChangePassword: users.mustChangePassword,
          passwordChangedAt: users.passwordChangedAt,
        })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${email})`)
        .limit(1);
      return lignes[0] ?? null;
    },

    /**
     * Re-validation E6 étendue (AUTH-MDP-TEMPO1 D3/D4) — appelée à chaque
     * requête par le bridge session, MÊME requête unique qu'estActif avant
     * elle : le flag de forçage et le dernier posage de mot de passe (claim
     * `pwdAt`) sortent du même SELECT, zéro coût ajouté.
     * `null` = utilisateur inexistant → traité comme inactif (fail-closed).
     */
    async etatCompte(userId: string): Promise<EtatCompte | null> {
      const lignes = await db
        .select({
          isActive: users.isActive,
          mustChangePassword: users.mustChangePassword,
          passwordChangedAt: users.passwordChangedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return lignes[0] ?? null;
    },

    /**
     * Changement de mot de passe par le membre (AUTH-MDP-TEMPO1 §5.4).
     *
     * TOUTE la décision (verrou ? → verify → écriture) est re-prise dans UNE
     * transaction sous `FOR UPDATE` : deux soumissions concurrentes ne peuvent
     * ni bypasser le verrou ni perdre un incrément — la surface naît sans la
     * course read-decide-write du login (dette CSO, lot séparé).
     *
     * Le verify argon2 (~100 ms) tourne SOUS le verrou de ligne : assumé — la
     * contention est bornée à CE compte (self-DoS au pire) et c'est le seul
     * moyen d'exclure une course entre verify et écriture.
     *
     * Un échec du mot de passe actuel COMPTE comme un échec de connexion
     * (D6 — même secret, même machine lockout E18, mêmes colonnes).
     */
    async changerMotDePasse(
      userId: string,
      options: {
        /** argon2.verify appliqué au hash lu sous verrou ; ne doit jamais lever. */
        verifierAncien: (hash: string) => Promise<boolean>;
        nouveauHash: string;
        maintenant: Date;
      },
    ): Promise<void> {
      const { verifierAncien, nouveauHash, maintenant } = options;
      // ⚠️ La transaction RETOURNE l'issue au lieu de la jeter : un throw dans
      // le callback drizzle ROLLBACK — l'incrément lockout d'un échec de mot
      // de passe (D6) doit COMMITTER, sinon l'échec ne compte jamais (attrapé
      // par le test d'intégration). L'erreur nommée est levée APRÈS le commit.
      const issue = await db.transaction(
        async (
          tx,
        ): Promise<
          "indisponible" | "verrouille" | "sans_mdp" | "actuel_incorrect" | "ok"
        > => {
          const lignes = await tx
            .select({
              id: users.id,
              passwordHash: users.passwordHash,
              failedLoginCount: users.failedLoginCount,
              lockedUntil: users.lockedUntil,
              isActive: users.isActive,
            })
            .from(users)
            .where(eq(users.id, userId))
            .for("update");

          // Fail-closed : inexistant ou désactivé ≡ non connecté (non-énumérant).
          if (lignes.length === 0 || !lignes[0].isActive) {
            return "indisponible";
          }
          const compte = lignes[0];

          // Verrou actif : refus SANS écriture (politique lockout.ts — pas
          // d'extension de verrou sans information nouvelle).
          if (estVerrouille(compte.lockedUntil, maintenant)) {
            return "verrouille";
          }

          // SSO futur : jamais de verify sur un hash NULL.
          if (compte.passwordHash === null) {
            return "sans_mdp";
          }

          const ancienValide = await verifierAncien(compte.passwordHash);
          if (!ancienValide) {
            // Échec = échec de connexion (D6) : transition lockout, COMMITTÉE.
            const etat = evaluerEchec(compte.failedLoginCount, maintenant);
            await tx
              .update(users)
              .set({
                failedLoginCount: etat.failedLoginCount,
                lockedUntil: etat.lockedUntil,
              })
              .where(eq(users.id, userId));
            return "actuel_incorrect";
          }

          // Succès : nouveau posage (invalide les autres sessions via pwdAt,
          // D4), flag levé, lockout remis à zéro (comme un login réussi).
          await tx
            .update(users)
            .set({
              passwordHash: nouveauHash,
              mustChangePassword: false,
              passwordChangedAt: maintenant,
              failedLoginCount: 0,
              lockedUntil: null,
            })
            .where(eq(users.id, userId));
          return "ok";
        },
      );

      switch (issue) {
        case "ok":
          return;
        case "indisponible":
          throw new CompteIndisponibleError();
        case "verrouille":
          throw new CompteVerrouilleError();
        case "sans_mdp":
          throw new CompteSansMotDePasseError();
        case "actuel_incorrect":
          throw new MotDePasseActuelIncorrectError();
      }
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

    /**
     * Workspace à activer PAR DÉFAUT au login (DASH-WSACTIF1). Choisit le
     * workspace de l'utilisateur qui contient LE PLUS de comptes bancaires, afin
     * que le dashboard affiche des chiffres dès la connexion (le « 0,00 Rs »
     * venait du choix arbitraire du 1er membership trié par UUID — un workspace
     * « groupe » vide pouvait gagner sur une BU pleine de comptes). Repli
     * déterministe par NOM en cas d'égalité (jamais l'ordre d'insertion).
     * Renvoie null si l'utilisateur n'est membre d'aucun workspace.
     *
     * SÉCURITÉ (CLAUDE.md règle 2) — deux étages de RLS, jamais contournés :
     * - `workspace_members` est lu via `own_memberships_select` (GUC
     *   app.current_user_id posé en transaction) → SEULEMENT les memberships de
     *   l'utilisateur. Le choix du défaut ne peut donc porter que sur SES
     *   workspaces (pas d'énumération d'autrui).
     * - `bank_accounts` est sous `tenant_isolation` keyée sur
     *   app.current_workspace_id (PAS current_user_id). On NE PEUT donc PAS
     *   compter les comptes par une jointure sous le seul GUC user (la policy
     *   bank_accounts rendrait 0 ligne, GUC workspace absent → fail-closed). On
     *   pose donc, workspace par workspace de l'utilisateur (membre PROUVÉ par
     *   l'étage précédent — exactement ce que withWorkspace fera ensuite), le GUC
     *   app.current_workspace_id, puis on COMPTE sous la RLS normale. Chaque
     *   comptage est ainsi scopé à un tenant légitime ; jamais de fuite d'un
     *   autre tenant (un workspace dont l'utilisateur n'est pas membre n'apparaît
     *   pas dans la liste, donc n'est jamais compté).
     *
     * Le nombre de workspaces par utilisateur est petit (quelques unités) ; le
     * surcoût au login est négligeable. workspace_id n'est JAMAIS un paramètre
     * client : il est dérivé des memberships de l'utilisateur.
     */
    async membershipParDefaut(userId: string): Promise<string | null> {
      return db.transaction(async (tx) => {
        // Étage 1 — memberships de l'utilisateur (own_memberships_select).
        await tx.execute(
          sql`select set_config('app.current_user_id', ${userId}, true)`,
        );
        const mesWorkspaces = await tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            nom: workspaces.name,
          })
          .from(workspaceMembers)
          .innerJoin(
            workspaces,
            eq(workspaces.id, workspaceMembers.workspaceId),
          )
          .where(eq(workspaceMembers.userId, userId))
          .orderBy(workspaces.name);

        if (mesWorkspaces.length === 0) {
          return null;
        }
        // Cas trivial : un seul workspace → pas besoin de compter.
        if (mesWorkspaces.length === 1) {
          return mesWorkspaces[0].workspaceId;
        }

        // Étage 2 — comptage des comptes par workspace (chacun sous son propre
        // contexte workspace, membre prouvé). On garde le 1er de la liste déjà
        // triée par nom comme repli déterministe en cas d'égalité de comptes.
        let meilleurId = mesWorkspaces[0].workspaceId;
        let meilleurCompte = -1;
        for (const ws of mesWorkspaces) {
          await tx.execute(
            sql`select set_config('app.current_workspace_id', ${ws.workspaceId}, true)`,
          );
          const r = await tx
            .select({ n: count() })
            .from(bankAccounts)
            .where(eq(bankAccounts.workspaceId, ws.workspaceId));
          const n = r[0]?.n ?? 0;
          // Strictement supérieur : à égalité, on garde le précédent → comme la
          // liste est triée par nom ASC et qu'on l'itère dans cet ordre, le
          // gagnant à égalité est le 1er par nom (déterministe).
          if (n > meilleurCompte) {
            meilleurCompte = n;
            meilleurId = ws.workspaceId;
          }
        }
        return meilleurId;
      });
    },

    /**
     * Memberships enrichis du nom + kind du workspace, pour le SÉLECTEUR (Epic 2
     * L1). Même garde que membershipsDe : `own_memberships_select` filtre
     * workspace_members par current_user_id ; le JOIN vers `workspaces` (hors
     * RLS) n'expose donc QUE les workspaces de l'utilisateur — pas
     * d'énumération d'autrui (arbitrage S2 du spec Epic 2).
     */
    async membershipsAvecNom(
      userId: string,
    ): Promise<MembershipAvecNom[]> {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.current_user_id', ${userId}, true)`,
        );
        const lignes = await tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            role: workspaceMembers.role,
            nom: workspaces.name,
            kind: workspaces.kind,
          })
          .from(workspaceMembers)
          .innerJoin(
            workspaces,
            eq(workspaces.id, workspaceMembers.workspaceId),
          )
          .where(eq(workspaceMembers.userId, userId))
          .orderBy(workspaces.name);
        return lignes.map((l) => ({
          workspaceId: l.workspaceId,
          role: l.role as WorkspaceRole,
          nom: l.nom,
          kind: l.kind,
        }));
      });
    },
  };
}

export type RepositoryIdentite = ReturnType<typeof creerRepositoryIdentite>;
