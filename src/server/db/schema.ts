/**
 * Schéma Drizzle — fondation Workspace (Semaine 1) + cœur financier (Epic 3).
 * Traduction stricte de docs/cahier_des_charges.md §4 (v2.1) : workspaces,
 * users, workspace_members, puis bank_connections / bank_accounts /
 * transactions_cache / balance_history (modèle SQL du plan approuvé).
 * Restent à venir avec leurs chantiers : consent_records, audit_events,
 * sync_runs (pipeline de sync & consent flow).
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
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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

/**
 * Tentatives de connexion par IP (plan E7, décision #49) — rate-limit en
 * fenêtre glissante SANS Redis, surface non authentifiée (CLAUDE.md règle 3).
 * Table d'infrastructure pré-auth : aucune donnée tenant ni PII au-delà de
 * l'IP → hors RLS (même statut que users/workspaces), accès exclusivement
 * via le repository identité. On ne stocke volontairement PAS l'email tenté
 * (anti-énumération E18 + minimisation PII, règle 8). Purge des lignes hors
 * fenêtre : cron à brancher avec la pipeline (entrée TODOS.md).
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** IPv4 ou IPv6 textuelle (45 = longueur max IPv6 mappée IPv4). */
    ip: varchar("ip", { length: 45 }).notNull(),
    succeeded: boolean("succeeded").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Couvre la requête unique du repository : COUNT par ip dans la fenêtre.
    index("login_attempts_ip_attempted_at_idx").on(t.ip, t.attemptedAt),
  ],
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

/* ------------------------------------------------------------------ */
/* Cœur financier (Epic 3, étape 1) — traduction du modèle SQL du plan  */
/* v2.1 approuvé. Tables tenant : workspace_id + RLS tenant_isolation   */
/* (pattern nullif fail-closed identique à workspace_members) ; FORCE   */
/* RLS posé par migration custom, GRANTs par drizzle/provisioning.      */
/* Montants : DECIMAL(15,2) — chaînes décimales côté TS (règle 8).      */
/* ------------------------------------------------------------------ */

const POLITIQUE_TENANT = {
  for: "all",
  using: sql`workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid`,
  withCheck: sql`workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid`,
} as const;

/* ------------------------------------------------------------------ */
/* Entités multi-tenant (Option B — entités SOUS le workspace).        */
/* Plan de référence : PLAN-entites-multi-tenant.md §1. Une ENTITÉ (BU  */
/* « Sucrière », « Énergie »…) est un découpage INTERNE au tenant, pas  */
/* une frontière de tenant (1 credential bancaire = comptes de N        */
/* entités). entity_id vit UNIQUEMENT sur bank_accounts (NULLABLE =     */
/* « non assigné ») ; transactions/soldes héritent du scope par         */
/* JOINTURE — jamais de dénormalisation sur l'append-only/partitionné.  */
/* Déclarée AVANT bank_accounts : sa contrainte UNIQUE(id, ws) est la   */
/* cible de la FK composite scopée de bank_accounts.entity_id.          */
/* ------------------------------------------------------------------ */

/**
 * Référentiel des entités (BU) d'un workspace. Propriété TYGR : Omni-FI ne
 * connaît pas ce découpage (les « Parties » API sont volontairement ignorées au
 * MVP — dette P2 ENTITY-PARTY1). Éditable / archivable (`is_active`), jamais de
 * DELETE physique applicatif (référencée par bank_accounts en ON DELETE
 * RESTRICT) ; la suppression logique passe par is_active=false.
 */
export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: varchar("name", { length: 120 }).notNull(),
    /** Code interne Omnicane optionnel (mapping futur, jamais une clé d'isolation). */
    code: varchar("code", { length: 40 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // UNIQUE (id, workspace_id) : cible des FK COMPOSITES scopées workspace
    // (même pattern que categories_id_workspace_unique). Permet d'exiger en base
    // qu'une entité référencée (par bank_accounts ou member_entity_scopes)
    // appartienne au MÊME workspace que la ligne référençante — une entity_id
    // d'un autre tenant devient impossible.
    unique("entities_id_workspace_unique").on(t.id, t.workspaceId),
    // Pas deux entités homonymes dans un même groupe.
    unique("entities_workspace_name_unique").on(t.workspaceId, t.name),
    index("entities_workspace_id_idx").on(t.workspaceId),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/** Connexions bancaires Omni-FI (une connexion = une banque, cf. doc API). */
export const bankConnections = pgTable(
  "bank_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /**
     * `ConnectionId` Omni-FI permanent (obtenu via link-exchange).
     * HYPOTHÈSE (cross-review PR-W4, 2026-06-15) : Omni-FI garantit l'unicité
     * d'un ConnectionId par ClientUserId (= workspace). Sous cette hypothèse, la
     * contrainte UNIQUE globale est sûre. Si elle est FAUSSE (un même
     * omnifi_connection_id partageable entre 2 workspaces), une migration
     * composite UNIQUE(workspace_id, omnifi_connection_id) sera nécessaire.
     */
    omnifiConnectionId: varchar("omnifi_connection_id", { length: 64 })
      .notNull()
      .unique(),
    institutionId: varchar("institution_id", { length: 64 }).notNull(),
    /**
     * Nom lisible de l'institution (`OmniFiConnection.InstitutionName`, ex.
     * « Absa Internet Banking »). NULLABLE : expand-compatible (les connexions
     * créées avant cette colonne restent à NULL ; l'UI dégrade proprement —
     * DASH-INST1). Renseigné/rafraîchi à chaque ingestion de connexion.
     */
    institutionName: varchar("institution_name", { length: 140 }),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    /** Rate-limit amont : aucun POST /sync avant cet horodatage. */
    nextSyncAvailableAt: timestamp("next_sync_available_at", {
      withTimezone: true,
    }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("bank_connections_workspace_id_idx").on(t.workspaceId),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/** Comptes bancaires (OBIE `OBReadAccount6`, sous-ensemble du plan). */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => bankConnections.id, { onDelete: "cascade" }),
    /**
     * HYPOTHÈSE (cross-review PR-W4, 2026-06-15) : un omnifi_account_id est unique
     * par ClientUserId (= workspace) côté Omni-FI → UNIQUE globale sûre. Si faux,
     * migration composite UNIQUE(workspace_id, omnifi_account_id) requise.
     */
    omnifiAccountId: varchar("omnifi_account_id", { length: 64 })
      .notNull()
      .unique(),
    accountName: varchar("account_name", { length: 255 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    currentBalance: numeric("current_balance", { precision: 15, scale: 2 }),
    /** Account Selection (consentement) : compte autorisé par l'utilisateur. */
    isSelected: boolean("is_selected").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /**
     * ORPHELIN depuis 2026-06-19 : l'ingestion est passée au modèle par PAGE
     * (`/transactions`, `Links.Next`/`Meta.TotalPages`) ; il n'y a plus de curseur
     * à persister. Colonne laissée en place volontairement (pas de migration
     * couplée à ce changement) — retrait tracé en dette TODOS (INGEST-CURSOR1).
     * Vestige de l'ancien `/transactions/sync` (extension future non déployée).
     */
    syncCursor: text("sync_cursor"),
    /**
     * Entité (BU) propriétaire du compte. NULLABLE = « compte non assigné »
     * (état par défaut à l'ingestion — Omni-FI ne connaît pas les entités, §0.2
     * du plan). Expand-safe : les comptes ingérés avant cette colonne restent à
     * NULL, l'UI dégrade proprement (sas d'assignation ADMIN). La FK est COMPOSITE
     * et scopée workspace (ci-dessous) : une entity_id d'un autre tenant est
     * impossible. ⚠️ entity_id est VOLONTAIREMENT absent du onConflictDoUpdate.set
     * de l'ingestion (upsertCompte) : un compte assigné conserve son entité au
     * re-sync (invariant du plan §1.5).
     */
    entityId: uuid("entity_id"),
  },
  (t) => [
    index("bank_accounts_workspace_id_idx").on(t.workspaceId),
    index("bank_accounts_connection_id_idx").on(t.connectionId),
    // FK COMPOSITE scopée workspace (cœur de l'isolation intra-groupe, §1.3) :
    // l'entité référencée DOIT appartenir au même workspace que le compte. Cible
    // entities(id, workspace_id) [UNIQUE]. ON DELETE RESTRICT : effacer une
    // entité encore référencée échoue — l'app archive (is_active=false), jamais
    // de cascade vers les comptes. Même garantie que la FK composite de categories.
    foreignKey({
      columns: [t.entityId, t.workspaceId],
      foreignColumns: [entities.id, entities.workspaceId],
      name: "bank_accounts_entity_workspace_fk",
    }).onDelete("restrict"),
    // Sas d'assignation + scope entité : retrouver les comptes d'une entité (ou
    // les non-assignés, entity_id IS NULL) dans un workspace.
    index("bank_accounts_workspace_entity_idx").on(t.workspaceId, t.entityId),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/**
 * Cache des transactions Omni-FI (OBIE v4.0.1), partitionné par RANGE sur
 * transaction_date (clause posée à la main dans la migration — drizzle-kit ne
 * sait pas l'émettre ; le snapshot reste correct, colonnes identiques).
 *
 * Divergences DOCUMENTÉES vs plan v2.1 (à valider, cf. revue) :
 * - `currency` AJOUTÉE : « toute table portant un montant porte sa devise »
 *   (CLAUDE.md, multi-devise first) — le plan l'omettait, la règle gagne.
 * - `booking_date_time` AJOUTÉE : horodatage brut UTC dont dérive
 *   `transaction_date` (AT TIME ZONE 'Asia/Port_Louis', E20) — sans lui, la
 *   date comptable est invérifiable et l'export perd le tri amont.
 *
 * PII (règle 8) : `bank_label_raw` est un libellé bancaire brut — jamais dans
 * les logs ni les messages d'erreur.
 */
export const transactionsCache = pgTable(
  "transactions_cache",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    omnifiTxnId: varchar("omnifi_txn_id", { length: 255 }).notNull(),
    /** Date comptable Maurice, dérivée de booking_date_time (E20). */
    transactionDate: date("transaction_date").notNull(),
    /** `BookingDateTime` OBIE brut, UTC. */
    bookingDateTime: timestamp("booking_date_time", {
      withTimezone: true,
    }).notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    creditDebit: varchar("credit_debit", { length: 6 }).notNull(),
    // Nullable : l'API ne fournit pas toujours de Description (constaté sandbox
    // 2026-06-19 : transactions sans libellé). « Pas de libellé brut » = null est
    // sémantiquement valide ; cette colonne est PII et n'est JAMAIS lue côté UI
    // (on affiche clean_label, déjà nullable, sinon un fallback neutre).
    bankLabelRaw: text("bank_label_raw"),
    cleanLabel: varchar("clean_label", { length: 255 }),
    primaryCategory: varchar("primary_category", { length: 120 }),
    subCategory: varchar("sub_category", { length: 120 }),
    /** Tombstone pour Removed[] du sync — jamais de DELETE physique. */
    isRemoved: boolean("is_removed").notNull().default(false),
  },
  (t) => [
    // La clé de partition doit appartenir à la PK et aux contraintes uniques.
    primaryKey({ columns: [t.id, t.transactionDate] }),
    unique("transactions_cache_omnifi_txn_unique").on(
      t.omnifiTxnId,
      t.transactionDate,
    ),
    check(
      "transactions_cache_credit_debit_check",
      sql`${t.creditDebit} IN ('Credit','Debit')`,
    ),
    // Couvre la liste du dashboard (plan, décision #603).
    index("transactions_cache_workspace_date_idx").on(
      t.workspaceId,
      t.transactionDate.desc(),
    ),
    index("transactions_cache_bank_account_id_idx").on(t.bankAccountId),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/** Soldes end-of-day par compte — source de la courbe de trésorerie 90 j. */
export const balanceHistory = pgTable(
  "balance_history",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    balanceDate: date("balance_date").notNull(),
    balance: numeric("balance", { precision: 15, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bankAccountId, t.balanceDate] }),
    // Couvre l'agrégat multi-comptes du dashboard (FEAT-3.1, fenêtre 90 j).
    index("balance_history_workspace_date_idx").on(
      t.workspaceId,
      t.balanceDate,
    ),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/* ------------------------------------------------------------------ */
/* Pilier 1 — catégorisation manuelle + ventilation (spec             */
/* docs/specs/pilier1-categorisation-manuelle.md). transactions_cache */
/* reste READ-ONLY : toute la catégorisation vit dans ces 3 tables.   */
/* ------------------------------------------------------------------ */

export const CATEGORIZATION_SOURCES = ["MANUAL", "RULE"] as const;
export type CategorizationSource = (typeof CATEGORIZATION_SOURCES)[number];

/**
 * Référentiel de catégories par workspace (Nature / Sous-nature). Hiérarchie à
 * deux niveaux via `parent_id` (NULL = racine = Nature ; sinon = Sous-nature).
 * Éditable (DELETE autorisé à tygr_app, cf. liste blanche provisioning) ;
 * `is_active` permet la désactivation sans perte de l'historique de splits.
 */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: varchar("name", { length: 120 }).notNull(),
    /** NULL = catégorie racine (Nature) ; sinon parent dans le MÊME workspace. */
    parentId: uuid("parent_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // UNIQUE (id, workspace_id) : cible des FK COMPOSITES scopées workspace
    // (correctif cross-review MAJEUR). Permet d'exiger qu'une catégorie
    // référencée appartienne au MÊME workspace que la ligne référençante.
    unique("categories_id_workspace_unique").on(t.id, t.workspaceId),
    // Auto-référence hiérarchie COMPOSITE (parent dans le MÊME workspace) :
    // un parent_id d'un autre tenant est désormais IMPOSSIBLE.
    foreignKey({
      columns: [t.parentId, t.workspaceId],
      foreignColumns: [t.id, t.workspaceId],
      name: "categories_parent_id_workspace_fk",
    }),
    // Pas de doublon de nom au même niveau d'un workspace.
    unique("categories_workspace_name_parent_unique").on(
      t.workspaceId,
      t.name,
      t.parentId,
    ),
    index("categories_workspace_id_idx").on(t.workspaceId),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/**
 * Catégorisation d'une transaction, AVEC ventilation : une transaction peut être
 * répartie sur N lignes (1 ligne = cas 1:1 ; plusieurs = 1:N). La somme des
 * `amount` des lignes d'une transaction doit rester ≤ |montant de la transaction|
 * (invariant appliqué côté repository en transaction — un CHECK SQL ne peut pas
 * agréger d'autres lignes ; cf. spec §4).
 *
 * FK COMPOSITE vers transactions_cache : cette table étant partitionnée, sa PK
 * est `(id, transaction_date)` — une FK doit cibler la PK ENTIÈRE. On dénormalise
 * donc `transaction_date` ici uniquement pour porter la FK (spec §3).
 * transactions_cache reste READ-ONLY : aucune écriture n'y est faite.
 */
export const transactionCategorizations = pgTable(
  "transaction_categorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    transactionId: uuid("transaction_id").notNull(),
    /** Dénormalisée pour la FK composite vers la table partitionnée (spec §3). */
    transactionDate: date("transaction_date").notNull(),
    categoryId: uuid("category_id").notNull(),
    /** Montant de CETTE part (> 0 ; le signe vit sur la transaction). */
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    source: varchar("source", { length: 10 }).notNull(),
    /** NULL si MANUAL ; renseigné si source='RULE' (table rules à venir). */
    ruleId: uuid("rule_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // FK composite vers la PK partitionnée de transactions_cache.
    foreignKey({
      columns: [t.transactionId, t.transactionDate],
      foreignColumns: [transactionsCache.id, transactionsCache.transactionDate],
      name: "txn_categorizations_transaction_fk",
    }),
    // FK category COMPOSITE (correctif cross-review MAJEUR) : la catégorie DOIT
    // appartenir au MÊME workspace que le split → une category_id d'un autre
    // tenant est impossible (garantie en base, pas par convention).
    foreignKey({
      columns: [t.categoryId, t.workspaceId],
      foreignColumns: [categories.id, categories.workspaceId],
      name: "txn_categorizations_category_workspace_fk",
    }),
    check("txn_categorizations_amount_positive", sql`${t.amount} > 0`),
    check(
      "txn_categorizations_source_check",
      sql`${t.source} IN ('MANUAL','RULE')`,
    ),
    // Double verrou source/rule_id : MANUAL ⟺ pas de rule ; RULE ⟺ rule présent.
    check(
      "txn_categorizations_source_rule_coherence",
      sql`(${t.source} = 'MANUAL' AND ${t.ruleId} IS NULL) OR (${t.source} = 'RULE' AND ${t.ruleId} IS NOT NULL)`,
    ),
    // Récupère les splits d'une transaction (scopé workspace).
    index("txn_categorizations_workspace_txn_idx").on(
      t.workspaceId,
      t.transactionId,
      t.transactionDate,
    ),
    // Agrégats par catégorie (dashboards futurs).
    index("txn_categorizations_workspace_category_idx").on(
      t.workspaceId,
      t.categoryId,
    ),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/**
 * Journal APPEND-ONLY immuable des changements de catégorisation (FEAT-8.1 :
 * « surcharge manuelle = audit immuable »). Comme audit_events / consent_records :
 * aucun UPDATE ni DELETE (la migration 0005 pose un trigger BEFORE UPDATE OR
 * DELETE qui lève ; tygr_app n'a que INSERT/SELECT — liste blanche provisioning).
 * Pas de FK dure vers la transaction (on garde la trace quoi qu'il arrive).
 */
export const categorizationAudit = pgTable(
  "categorization_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    transactionId: uuid("transaction_id").notNull(),
    transactionDate: date("transaction_date").notNull(),
    /** Opération sur un split : CREATE / UPDATE / DELETE. */
    action: varchar("action", { length: 16 }).notNull(),
    /** Snapshots lisibles au moment de l'action (pas de jointure requise). */
    categoryName: varchar("category_name", { length: 120 }),
    amount: numeric("amount", { precision: 15, scale: 2 }),
    source: varchar("source", { length: 10 }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "categorization_audit_action_check",
      sql`${t.action} IN ('CREATE','UPDATE','DELETE')`,
    ),
    index("categorization_audit_workspace_txn_idx").on(
      t.workspaceId,
      t.transactionId,
      t.transactionDate,
    ),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/* ------------------------------------------------------------------ */
/* Périmètre entité d'un membre (N:N user ↔ entity) — « Vision Entité ».*/
/* Plan §1.4. Borne un membre à ≥1 entités. AUCUNE ligne pour un        */
/* (user, workspace) = « Vision Globale » (voit tout le tenant =        */
/* consolidation). Le scope est résolu DEPUIS LE CONTEXTE par           */
/* withWorkspace (3ᵉ GUC app.current_entity_scope) — JAMAIS un          */
/* paramètre client. Table de DROITS (non append-only) : DELETE légitime*/
/* (liste blanche provisioning) ; retirer un membre purge ses scopes.   */
/* ------------------------------------------------------------------ */
export const memberEntityScopes = pgTable(
  "member_entity_scopes",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id").notNull(),
    entityId: uuid("entity_id").notNull(),
  },
  (t) => [
    // Idempotence : un (workspace, user, entity) ne peut exister qu'une fois.
    primaryKey({ columns: [t.workspaceId, t.userId, t.entityId] }),
    // FK COMPOSITE membership : on ne scope QUE des membres RÉELS du workspace.
    // ON DELETE CASCADE LÉGITIME (table de droits, NON append-only) : retirer un
    // membre (workspace_members) purge automatiquement ses scopes. Cible la PK
    // composite workspace_members(user_id, workspace_id).
    foreignKey({
      columns: [t.userId, t.workspaceId],
      foreignColumns: [workspaceMembers.userId, workspaceMembers.workspaceId],
      name: "member_entity_scopes_member_fk",
    }).onDelete("cascade"),
    // FK COMPOSITE entité scopée workspace : même garantie cross-tenant que
    // bank_accounts.entity_id (§1.3). ON DELETE RESTRICT vers les entités (jamais
    // cascade) — on archive une entité, on ne l'efface pas tant qu'elle est
    // référencée.
    foreignKey({
      columns: [t.entityId, t.workspaceId],
      foreignColumns: [entities.id, entities.workspaceId],
      name: "member_entity_scopes_entity_fk",
    }).onDelete("restrict"),
    // Résolution du scope à l'ouverture de session (withWorkspace, par userId).
    index("member_entity_scopes_workspace_user_idx").on(
      t.workspaceId,
      t.userId,
    ),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();
