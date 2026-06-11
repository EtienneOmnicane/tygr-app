/**
 * Schéma Drizzle — fondation Workspace (Semaine 1).
 * Traduction stricte de docs/cahier_des_charges.md §4 (v2.1), périmètre :
 * workspaces, users, workspace_members. Les tables métier (bank_connections,
 * transactions_cache…) arrivent avec la pipeline de sync (semaines 3-5).
 *
 * Conventions de sécurité (CLAUDE.md règles 2 et 8) :
 * - workspace_members est sous RLS : politique tenant_isolation keyée sur
 *   current_setting('app.current_workspace_id', true) — la variante à deux
 *   arguments retourne NULL quand le contexte n'est pas posé, donc 0 ligne
 *   (fail-closed), jamais d'erreur exploitable.
 * - workspaces et users sont des méta-tables d'identité, hors RLS au MVP
 *   (conformément à la liste RLS du plan v2.1) — l'accès passe par les
 *   repositories scopés.
 * - Montants : aucun dans ces 3 tables ; règle DECIMAL/centimes (CLAUDE.md
 *   règle 8) applicable dès transactions_cache.
 *
 * Divergence déclarée vs cahier : email en `text` + index unique sur
 * lower(email) au lieu de CITEXT — même invariant d'unicité insensible à la
 * casse, sans dépendance d'extension (portabilité PGlite/Neon). Les emails
 * sont normalisés en minuscules à l'écriture par la couche repository.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 120 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull().default("INTERNAL_BU"),
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("MUR"),
    omnifiClientUserId: varchar("omnifi_client_user_id", { length: 64 })
      .notNull()
      .unique(),
    omnifiEnvironment: varchar("omnifi_environment", { length: 10 })
      .notNull()
      .default("sandbox"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "workspaces_kind_check",
      sql`${t.kind} IN ('INTERNAL_BU','EXTERNAL_CLIENT','DEMO','CONSOLIDATION')`,
    ),
    check(
      "workspaces_environment_check",
      sql`${t.omnifiEnvironment} IN ('sandbox','production')`,
    ),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    fullName: varchar("full_name", { length: 120 }).notNull(),
    /** NULL si l'utilisateur arrive par SSO/provider externe (plan v2.1). */
    passwordHash: varchar("password_hash", { length: 255 }),
    isActive: boolean("is_active").notNull().default(true),
    /** Lockout anti brute-force (plan E7/E18). */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_email_lower_unique").on(sql`lower(${t.email})`)],
);

export const WORKSPACE_ROLES = ["ADMIN", "MANAGER", "VIEWER"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.workspaceId] }),
    check(
      "workspace_members_role_check",
      sql`${t.role} IN ('ADMIN','MANAGER','VIEWER')`,
    ),
    // Étage 2 d'isolation : la ligne n'existe que dans le tenant courant.
    // USING filtre les lectures ; WITH CHECK bloque toute écriture qui
    // tenterait de viser un autre workspace que celui du contexte.
    // nullif(…, '') : un GUC custom déjà touché puis hors transaction vaut
    // chaîne vide (pas NULL) — sans nullif, ''::uuid jette une erreur SQL sur
    // toute requête hors contexte (bug attrapé par le test 5 de la suite IDOR).
    pgPolicy("tenant_isolation", {
      for: "all",
      using: sql`workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid`,
      withCheck: sql`workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid`,
    }),
    // Pré-contexte (sélecteur de workspace, à venir) : un utilisateur peut
    // toujours LIRE ses propres lignes de membership — jamais celles des autres.
    pgPolicy("own_memberships_select", {
      for: "select",
      using: sql`user_id = nullif(current_setting('app.current_user_id', true), '')::uuid`,
    }),
  ],
).enableRLS();
