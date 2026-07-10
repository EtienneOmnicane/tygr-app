/**
 * Schéma Drizzle — fondation Workspace (Semaine 1) + cœur financier (Epic 3).
 * Traduction stricte de docs/cahier_des_charges.md §4 (v2.1) : workspaces,
 * users, workspace_members, puis bank_connections / bank_accounts /
 * transactions_cache / balance_history (modèle SQL du plan approuvé).
 * Epic 1 (consent flow & audit) ajoute consent_records + audit_events, tous deux
 * APPEND-ONLY STRICTS (cf. section dédiée en fin de fichier).
 * Reste à venir avec son chantier : sync_runs (pipeline de sync).
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
  jsonb,
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
     * DURCISSEMENT (fix/unique-composites, PLAN-unique-composites.md) : l'HYPOTHÈSE
     * d'unicité GLOBALE (cross-review PR-W4, 2026-06-15) est ABANDONNÉE — on ne parie
     * plus qu'Omni-FI garantit un ConnectionId unique ENTRE workspaces. L'unicité est
     * désormais SCOPÉE tenant via bank_connections_workspace_omnifi_connection_unique
     * (composite, callback de table). Le `.unique()` inline (UNIQUE globale) est
     * CONSERVÉ transitoirement pendant la fenêtre EXPAND (migration 0018,
     * backward-compat N-1) ; il sera retiré au CONTRACT (migration 0019, release
     * suivante — lot L4). Même patron que parties_workspace_omnifi_party_unique.
     * ⚠️ COROLLAIRE CONTRACT (garde-fou WEBHOOK-TENANT-FIRST1, TODOS) : une fois la
     * globale retirée, omnifi_connection_id n'est PLUS unique globalement → tout futur
     * résolveur webhook (/api/webhooks/omnifi, inexistant aujourd'hui) DOIT résoudre le
     * TENANT d'abord (ClientUserId→workspace, unique global conservé) PUIS la connexion
     * DANS ce workspace — JAMAIS par omnifi_connection_id seul (sinon routage cross-tenant).
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
    // DURCISSEMENT (0018, EXPAND) : unicité de l'omnifi_connection_id SCOPÉE tenant
    // — remplace (à terme) l'UNIQUE globale (cf. commentaire de colonne + patron
    // parties_workspace_omnifi_party_unique). workspace_id EN TÊTE : colonne meneuse
    // de l'index, sert aussi les scans WHERE workspace_id = ?. L'ordre des colonnes
    // est sans effet sur l'inférence ON CONFLICT (Postgres matche l'ENSEMBLE) mais
    // décisif pour l'efficacité de l'index. La globale coexiste jusqu'au CONTRACT (0019).
    unique("bank_connections_workspace_omnifi_connection_unique").on(
      t.workspaceId,
      t.omnifiConnectionId,
    ),
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
     * DURCISSEMENT (fix/unique-composites, PLAN-unique-composites.md) : l'HYPOTHÈSE
     * d'unicité GLOBALE (cross-review PR-W4, 2026-06-15) est ABANDONNÉE. L'unicité de
     * l'omnifi_account_id est désormais SCOPÉE tenant via
     * bank_accounts_workspace_omnifi_account_unique (composite, callback de table). Le
     * `.unique()` inline (UNIQUE globale) est CONSERVÉ pendant l'EXPAND (migration 0018,
     * backward-compat N-1), retiré au CONTRACT (migration 0019 — lot L4).
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
    // DURCISSEMENT (0018, EXPAND) : unicité de l'omnifi_account_id SCOPÉE tenant —
    // remplace (à terme) l'UNIQUE globale (cf. commentaire de colonne). workspace_id
    // EN TÊTE (colonne meneuse). La globale coexiste jusqu'au CONTRACT (0019). À ne pas
    // confondre avec bank_accounts_id_workspace_unique (ci-dessous, cible des FK
    // composites sur l'id SURROGATE) : ici la clé NATURELLE Omni-FI, l'axe d'idempotence.
    unique("bank_accounts_workspace_omnifi_account_unique").on(
      t.workspaceId,
      t.omnifiAccountId,
    ),
    // UNIQUE (id, workspace_id) : cible des FK COMPOSITES scopées workspace qui
    // pointent vers un compte (account_party_role, user_scopes type ACCOUNT —
    // PLAN-architecture-multi-tenant-omnicane.md L0). Permet d'exiger en base qu'une
    // ligne référençant un bank_account appartienne au MÊME workspace (anti
    // cross-tenant), comme entities_id_workspace_unique le fait pour les entités.
    // Additive (la PK reste id seul) → expand-safe, code N-1 inchangé.
    unique("bank_accounts_id_workspace_unique").on(t.id, t.workspaceId),
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
 * Sources d'une catégorie AUTOMATIQUE de transaction (provenance, marqueur sur
 * transactions_cache — à ne pas confondre avec CATEGORIZATION_SOURCES qui qualifie
 * un SPLIT de transaction_categorizations). Liste fermée et extensible : seul
 * 'OMNIFI' aujourd'hui (pré-catégorisation OBIE du bloc Enrichment). De futures
 * sources auto (ex. un classifieur interne) s'ajoutent ici + au CHECK SQL.
 */
export const CATEGORY_SOURCES = ["OMNIFI"] as const;
export type CategorySource = (typeof CATEGORY_SOURCES)[number];

/**
 * Cache des transactions Omni-FI (OBIE v4.0.1), partitionné par RANGE sur
 * transaction_date (clause posée à la main dans la migration — drizzle-kit ne
 * sait pas l'émettre ; le snapshot reste correct, colonnes identiques).
 *
 * Divergences DOCUMENTÉES vs plan v2.1 (à valider, cf. revue) :
 * - `currency` AJOUTÉE : « toute table portant un montant porte sa devise »
 *   (CLAUDE.md, multi-devise first) — le plan l'omettait, la règle gagne.
 * - `booking_date_time` AJOUTÉE : horodatage brut UTC dont dérive
 *   `transaction_date` (AT TIME ZONE 'Indian/Mauritius', E20) — sans lui, la
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
    /**
     * Métadonnées de classification AMONT (bloc Enrichment, TECH-API-TRACE) — purement
     * DESCRIPTIVES : on TRACE fidèlement la valeur reçue d'Omni-FI, aucune décision
     * dérivée ici (l'exploitation — seuils, file de revue — relève de GAP-CATEG-NATIVE1).
     * À distinguer de `category_source` (ci-dessous) : celui-ci dit quel SYSTÈME TYGR a
     * posé la catégorie ('OMNIFI'), `classification_source` dit quelle SOUS-SOURCE amont
     * (USER_RULE/SYSTEM_RULE/ML) — granularités différentes, non redondantes.
     *
     * VOLONTAIREMENT sans CHECK de liste fermée ni cohérence avec is_auto_categorized :
     * (1) les valeurs amont ne sont pas sous notre contrôle — un CHECK strict ferait
     * échouer une ingestion sur une valeur API nouvelle (résilience > rigidité pour de
     * la donnée descriptive) ; (2) ces champs peuvent décrire une classification amont
     * ayant abouti à "Uncategorized" (info utile), donc indépendants du marqueur auto.
     * `confidence_level` "Low" est CONSERVÉ tel quel (défaut serializer amont) : neutraliser
     * un score bas est une décision de couche UI, pas de la trace. Toujours via `chaineOuNull`
     * (un "" amont → NULL, jamais "" brut).
     */
    confidenceLevel: varchar("confidence_level", { length: 120 }),
    classificationSource: varchar("classification_source", { length: 120 }),
    ruleIdMatch: varchar("rule_id_match", { length: 120 }),
    /**
     * Provenance AUTOMATIQUE de la catégorie OBIE : true ⇔ primary_category vient
     * d'une source auto (Omni-FI, bloc Enrichment) et non d'une absence. Permet de
     * distinguer « auto » de « manuelle » (la catégorisation manuelle TYGR vit dans
     * les splits transaction_categorizations, table à part). MANUAL prime à
     * l'affichage/agrégation, mais ce marqueur est CONSERVÉ comme trace d'origine.
     */
    isAutoCategorized: boolean("is_auto_categorized").notNull().default(false),
    /** Source de la catégorie auto (NULL = aucune). Cf. CATEGORY_SOURCES. */
    categorySource: varchar("category_source", { length: 10 }).$type<CategorySource>(),
    /** Tombstone pour Removed[] du sync — jamais de DELETE physique. */
    isRemoved: boolean("is_removed").notNull().default(false),
  },
  (t) => [
    // La clé de partition doit appartenir à la PK et aux contraintes uniques.
    primaryKey({ columns: [t.id, t.transactionDate] }),
    // DURCISSEMENT (0018, EXPAND) : unicité SCOPÉE tenant. workspace_id EN TÊTE ;
    // transaction_date CONSERVÉE (obligatoire : clé de partition — toute UNIQUE d'une
    // table partitionnée DOIT la contenir). Remplace (à terme) la non-scopée ci-dessous,
    // gardée jusqu'au CONTRACT (0019, lot L4). Sur table partitionnée, l'ADD CONSTRAINT
    // crée un index partitionné parent + un index enfant par partition (héritage DDL,
    // distinct de la RLS qui, elle, se répète par partition — cf. 0003).
    unique("transactions_cache_workspace_omnifi_txn_unique").on(
      t.workspaceId,
      t.omnifiTxnId,
      t.transactionDate,
    ),
    unique("transactions_cache_omnifi_txn_unique").on(
      t.omnifiTxnId,
      t.transactionDate,
    ),
    check(
      "transactions_cache_credit_debit_check",
      sql`${t.creditDebit} IN ('Credit','Debit')`,
    ),
    // Source auto bornée à la liste fermée (NULL autorisé = pas de provenance auto).
    check(
      "transactions_cache_category_source_check",
      sql`${t.categorySource} IS NULL OR ${t.categorySource} IN ('OMNIFI')`,
    ),
    // Cohérence marqueur/source : true ⟺ source présente ; false ⟺ source NULL.
    // Interdit les états incohérents quel que soit le chemin d'écriture.
    check(
      "transactions_cache_auto_source_coherence",
      sql`(${t.isAutoCategorized} = true AND ${t.categorySource} IS NOT NULL) OR (${t.isAutoCategorized} = false AND ${t.categorySource} IS NULL)`,
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
    // Pas de doublon de nom au même niveau d'un workspace — INSENSIBLE À LA CASSE
    // (FB0709-CAT-DOUBLONS1, migration 0020). `lower(name)` ferme la casse
    // (« VAT » = « vat ») ; `coalesce(parent_id, 0-uuid)` ferme le trou NULL≠NULL
    // (deux Natures racine homonymes = même clé, ce que l'ancien UNIQUE laissait
    // passer). La sentinelle 0-uuid est IDENTIQUE à PARENT_RACINE_SENTINELLE du
    // repository (categorisation.ts) → cohérence garde applicative ⇆ contrainte.
    uniqueIndex("categories_workspace_lower_name_parent_unique").on(
      t.workspaceId,
      sql`lower(${t.name})`,
      sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
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
/* Moteur de règles de catégorisation (FYGR-style).                    */
/* Une règle = un motif textuel (contains / starts_with) sur le libellé */
/* d'une transaction → une catégorie cible. Le service d'application    */
/* (appliquerRegles) crée un split à 100% du montant pour toute         */
/* transaction NON encore catégorisée dont le libellé matche (MANUAL    */
/* prime, jamais écrasé). Config de WORKSPACE (comme categories) :      */
/* éditable / archivable (is_active), NON append-only → DELETE en liste */
/* blanche provisioning. RLS tenant standard (pas de scope entité : une */
/* règle vit au niveau workspace, pas BU).                              */
/* ------------------------------------------------------------------ */

export const RULE_MATCH_TYPES = ["contains", "starts_with"] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export const categorizationRules = pgTable(
  "categorization_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** Motif recherché dans le libellé (clean_label, repli bank_label_raw). */
    pattern: varchar("pattern", { length: 255 }).notNull(),
    /** Stratégie de match : 'contains' (sous-chaîne) | 'starts_with' (préfixe). */
    matchType: varchar("match_type", { length: 16 }).notNull(),
    /** Catégorie appliquée quand le motif matche (split à 100%). */
    categoryId: uuid("category_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    /** Ordre d'évaluation : la plus PETITE priorité gagne (1 règle / transaction). */
    priority: integer("priority").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // FK category COMPOSITE scopée workspace (pattern obligatoire CLAUDE.md) : la
    // catégorie cible DOIT appartenir au MÊME workspace que la règle → une
    // category_id d'un autre tenant est impossible (garantie en base). ON DELETE
    // par défaut (no action / restrict) : on n'efface pas une catégorie
    // référencée par une règle (cohérent avec l'archivage logique des catégories).
    foreignKey({
      columns: [t.categoryId, t.workspaceId],
      foreignColumns: [categories.id, categories.workspaceId],
      name: "categorization_rules_category_workspace_fk",
    }),
    check(
      "categorization_rules_match_type_check",
      sql`${t.matchType} IN ('contains','starts_with')`,
    ),
    // Pattern non vide (un motif vide matcherait toutes les transactions).
    check(
      "categorization_rules_pattern_not_blank",
      sql`length(trim(${t.pattern})) > 0`,
    ),
    // Pas deux règles identiques (même motif + stratégie + cible) dans un workspace.
    unique("categorization_rules_workspace_unique").on(
      t.workspaceId,
      t.pattern,
      t.matchType,
      t.categoryId,
    ),
    // Couvre la lecture ordonnée des règles ACTIVES à l'application.
    index("categorization_rules_workspace_active_priority_idx").on(
      t.workspaceId,
      t.isActive,
      t.priority,
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

/* ------------------------------------------------------------------ */
/* Parties (entité légale Omni-FI PartyId) + détention compte↔party.   */
/* Plan PLAN-architecture-multi-tenant-omnicane.md §1.1 (couche A) + L1.*/
/*                                                                      */
/* Trois niveaux à NE JAMAIS confondre (cf. CLAUDE.md à venir, L4) :    */
/*   • workspace = le GROUPE (frontière de tenant, étage 1 RLS).        */
/*   • party     = l'entité LÉGALE Omni-FI (société/individu) qui       */
/*                 POSSÈDE des comptes — maille de droit la plus fine.  */
/*   • entity     = la BU Omnicane (regroupement business OPTIONNEL      */
/*                 au-dessus des parties ; parties.entity_id nullable). */
/*                                                                      */
/* La détention compte↔party est N-N (un compte joint a plusieurs       */
/* parties) → table de liaison account_party_role calquée sur           */
/* ACCOUNT_PARTY_ROLE Omni-FI, JAMAIS une colonne party_id directe sur   */
/* bank_accounts. Ces tables sont alimentées à l'INGESTION (best-effort  */
/* additif) ; le filtrage par périmètre (account_scope) viendra en L4 — */
/* PAS dans ce lot (tables neuves, zéro chemin de lecture branché).      */
/* Déclarée AVANT account_party_role : son UNIQUE(id, ws) est la cible   */
/* de la FK composite scopée party_id.                                  */
/* ------------------------------------------------------------------ */

/** Hint de détention au niveau party (le rôle FIN par compte vit dans
 * account_party_role.ownership_type). Reproduit l'énum OBIE OwnershipType de la
 * doc API (OmniFiAccount). Stocké en varchar SANS CHECK (résilience API : un
 * libellé amont inattendu n'empêche pas l'ingestion — même esprit que les
 * colonnes de classification de 0012). */
export const OWNERSHIP_TYPES = [
  "PRIMARY",
  "SECONDARY",
  "JOINT_OWNER",
  "TRUST",
  "BUSINESS",
  "POWER_OF_ATTORNEY",
] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

/**
 * Entité légale (Omni-FI `PartyId`) propriété du GROUPE. Alimentée à l'ingestion
 * par upsert sur (workspace_id, omnifi_party_id) — idempotent. `entity_id`
 * (NULLABLE) rattache OPTIONNELLEMENT la party à une BU ; ce rattachement est
 * HUMAIN (ADMIN) et ne doit JAMAIS être écrasé au re-sync (à exclure du
 * onConflictDoUpdate.set de l'ingestion, comme bank_accounts.entity_id).
 * Archivable (`is_active`), jamais de DELETE applicatif tant que référencée
 * (FK composites en ON DELETE RESTRICT). `PartyId` Omni-FI peut être null à la
 * source : un compte sans party reste « sans party » (pas de party fabriquée).
 */
export const parties = pgTable(
  "parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** BU (entity) optionnelle au-dessus de la party. NULL = non rattachée. */
    entityId: uuid("entity_id"),
    /** `PartyId` Omni-FI. Clé de dédup à l'ingestion (scopée workspace). */
    omnifiPartyId: varchar("omnifi_party_id", { length: 64 }).notNull(),
    /** `PartyName` (nullable côté API → nullable ici). Rafraîchi au re-sync. */
    name: varchar("name", { length: 255 }),
    /** Hint global de détention si fourni hors rôle (le rôle fin = role table). */
    ownershipType: varchar("ownership_type", { length: 24 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // UNIQUE (id, workspace_id) : cible des FK COMPOSITES scopées (account_party_role,
    // user_scopes type PARTY) — même pattern que entities_id_workspace_unique.
    unique("parties_id_workspace_unique").on(t.id, t.workspaceId),
    // Idempotence d'ingestion : une party Omni-FI n'est insérée qu'UNE fois par
    // groupe. ⚠️ Scopé (workspace_id, …) et NON global : on ne refait pas le pari
    // d'unicité globale d'omnifi_connection_id/omnifi_account_id (cf. schema.ts:233).
    unique("parties_workspace_omnifi_party_unique").on(
      t.workspaceId,
      t.omnifiPartyId,
    ),
    index("parties_workspace_id_idx").on(t.workspaceId),
    // Rattachement BU : retrouver les parties d'une entité (ou les non-rattachées).
    index("parties_workspace_entity_idx").on(t.workspaceId, t.entityId),
    // FK COMPOSITE scopée workspace vers la BU : une entity_id d'un autre tenant
    // est impossible. ON DELETE RESTRICT (on archive une entité référencée).
    foreignKey({
      columns: [t.entityId, t.workspaceId],
      foreignColumns: [entities.id, entities.workspaceId],
      name: "parties_entity_workspace_fk",
    }).onDelete("restrict"),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/**
 * Détention compte↔party (calque OBIE `ACCOUNT_PARTY_ROLE`). N-N : un compte
 * joint appartient à plusieurs parties (et une party détient N comptes). Alimentée
 * à l'ingestion depuis `OmniFiAccount.PartyId` + `OwnershipType` (best-effort
 * additif). Le scope de périmètre (account_scope, L4) s'hérite ICI par JOINTURE
 * sur bank_accounts — jamais une policy séparée. Table de liaison NON append-only.
 */
export const accountPartyRole = pgTable(
  "account_party_role",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    bankAccountId: uuid("bank_account_id").notNull(),
    partyId: uuid("party_id").notNull(),
    /** Rôle de détention OBIE (énum OWNERSHIP_TYPES, SANS CHECK — résilience API). */
    ownershipType: varchar("ownership_type", { length: 24 }).notNull(),
    /** Rôle principal (1 par compte côté UI) — pour le libellé de détention. */
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotence : un couple (compte, party) n'a qu'une ligne ; le rôle se met à
    // jour au re-sync (onConflictDoUpdate sur ownership_type/is_primary).
    primaryKey({
      columns: [t.workspaceId, t.bankAccountId, t.partyId],
    }),
    // FK COMPOSITE compte scopée workspace (cible bank_accounts_id_workspace_unique,
    // L0). ON DELETE CASCADE LÉGITIME : si le compte disparaît (cascade depuis une
    // connexion supprimée), son rôle de détention disparaît — table de liaison, NON
    // append-only (l'historique transactionnel reste protégé par son trigger no-delete).
    foreignKey({
      columns: [t.bankAccountId, t.workspaceId],
      foreignColumns: [bankAccounts.id, bankAccounts.workspaceId],
      name: "account_party_role_account_fk",
    }).onDelete("cascade"),
    // FK COMPOSITE party scopée workspace. ON DELETE RESTRICT (on archive une party
    // référencée, jamais d'effacement tant qu'un compte la cite).
    foreignKey({
      columns: [t.partyId, t.workspaceId],
      foreignColumns: [parties.id, parties.workspaceId],
      name: "account_party_role_party_fk",
    }).onDelete("restrict"),
    // « Comptes d'une party » (résolution périmètre party→comptes, L4).
    index("account_party_role_workspace_party_idx").on(
      t.workspaceId,
      t.partyId,
    ),
    // « Parties d'un compte » (libellé de détention sur une ligne compte).
    index("account_party_role_workspace_account_idx").on(
      t.workspaceId,
      t.bankAccountId,
    ),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/* ------------------------------------------------------------------ */
/* Périmètre party/compte par membre (L2 — PLAN-architecture-multi-     */
/* tenant-omnicane.md §1.1 / §5). Table de DROITS : QUELLE party ou     */
/* QUEL compte un membre est autorisé à voir. N lignes par membre =     */
/* « Vision restreinte » ; AUCUNE ligne = « Vision Globale » (tout le   */
/* tenant), exactement comme member_entity_scopes côté axe BU.          */
/*                                                                      */
/* PÉRIMÈTRE STRICT DE CE LOT : table NEUVE + isolation TENANT (étage 1, */
/* RLS workspace) + intégrité référentielle scopée (FK composites) +    */
/* invariants d'idempotence/exclusivité. Le RÉSOLVEUR de périmètre et   */
/* la policy `account_scope` (étage 2, GUC app.current_account_scope,   */
/* Vision restreinte effective sur bank_accounts/parties) sont le lot   */
/* L4 — VOLONTAIREMENT ABSENTS ici (aucune policy de scope, aucun       */
/* chemin de lecture). Cohabite avec member_entity_scopes (axe BU),     */
/* sans le remplacer.                                                   */
/* ------------------------------------------------------------------ */

/**
 * Octroi de périmètre fin (party OU compte) à un membre du workspace. Une ligne =
 * « ce membre peut voir cette party » OU « ce membre peut voir ce compte »,
 * EXCLUSIVEMENT l'un des deux (CHECK num_nonnulls = 1). Éditable / révocable
 * (table de droits, NON append-only) : retirer un accès = DELETE physique légitime.
 * Alimentée/purgée par l'ADMIN (gestion des droits, à venir, hors lot). N'introduit
 * AUCUN nouveau rôle : un membre « scopé » reste un membre dont le périmètre se
 * résout depuis ces lignes (L4), jamais d'un paramètre client.
 */
export const userScopes = pgTable(
  "user_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** Membre ciblé (la FK composite ci-dessous le scope au workspace). */
    userId: uuid("user_id").notNull(),
    /** Cible PARTY — exclusif avec bankAccountId (CHECK num_nonnulls = 1). */
    partyId: uuid("party_id"),
    /**
     * Cible COMPTE — exclusif avec partyId. Nom aligné sur account_party_role
     * (bank_account_id), cible la même UNIQUE bank_accounts_id_workspace_unique.
     */
    bankAccountId: uuid("bank_account_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Exclusivité : EXACTEMENT une cible (party XOR compte). Un octroi vise une
    // party OU un compte, jamais les deux, jamais aucun.
    check(
      "user_scopes_target_exclusive_check",
      sql`num_nonnulls(${t.partyId}, ${t.bankAccountId}) = 1`,
    ),
    // Idempotence : pas deux fois le même grant (party) pour un membre. Partiel
    // (WHERE party_id IS NOT NULL) car bank_account_id est NULL sur ces lignes —
    // un UNIQUE plein laisserait passer plusieurs (ws, user, NULL) côté party.
    uniqueIndex("user_scopes_user_party_unique")
      .on(t.workspaceId, t.userId, t.partyId)
      .where(sql`${t.partyId} is not null`),
    // Idempotence : pas deux fois le même grant (compte) pour un membre.
    uniqueIndex("user_scopes_user_account_unique")
      .on(t.workspaceId, t.userId, t.bankAccountId)
      .where(sql`${t.bankAccountId} is not null`),
    // « Tous les scopes d'un membre » (lookup du résolveur de périmètre, L4).
    index("user_scopes_workspace_user_idx").on(t.workspaceId, t.userId),
    // FK COMPOSITE scopée workspace vers le MEMBRE (cible la PK composite
    // workspace_members(user_id, workspace_id)). ON DELETE CASCADE : retirer un
    // membre d'un workspace purge ses octrois de périmètre (droits orphelins
    // impossibles) — table de DROITS, NON append-only.
    foreignKey({
      columns: [t.userId, t.workspaceId],
      foreignColumns: [workspaceMembers.userId, workspaceMembers.workspaceId],
      name: "user_scopes_member_fk",
    }).onDelete("cascade"),
    // FK COMPOSITE scopée workspace vers la PARTY (cible parties_id_workspace_unique).
    // ON DELETE RESTRICT : une party référencée par un octroi ne peut être effacée
    // (l'app archive is_active) — aligné sur le cycle de vie des parties (cf.
    // account_party_role_party_fk). Asymétrie RESTRICT-party / CASCADE-compte VOULUE.
    foreignKey({
      columns: [t.partyId, t.workspaceId],
      foreignColumns: [parties.id, parties.workspaceId],
      name: "user_scopes_party_fk",
    }).onDelete("restrict"),
    // FK COMPOSITE scopée workspace vers le COMPTE (cible bank_accounts_id_workspace_unique).
    // ON DELETE CASCADE : si le compte disparaît (cascade depuis une connexion
    // supprimée), l'octroi qui le visait disparaît — aligné sur le cycle de vie des
    // comptes (cf. account_party_role_account_fk). NE PAS harmoniser avec la party.
    foreignKey({
      columns: [t.bankAccountId, t.workspaceId],
      foreignColumns: [bankAccounts.id, bankAccounts.workspaceId],
      name: "user_scopes_account_fk",
    }).onDelete("cascade"),
    // Étage 1 — TENANT uniquement (réplique exacte du pattern fail-closed). AUCUNE
    // policy account_scope ici (étage 2 = L4).
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/* ------------------------------------------------------------------ */
/* Échéances prévisionnelles (Epic 8 · FEAT-8.2 « Dettes & Échéanciers  */
/* — saisie manuelle » ; cadrage PLAN-cadrage-echeances.md). Registre   */
/* MANUEL de mouvements FUTURS planifiés (encaissements clients /       */
/* décaissements fournisseurs) — PAS des factures, PAS du lettrage      */
/* (Epic 6, différé P2). Chaque échéance non terminée alimentera la     */
/* zone PRÉVISIONNELLE (grise, UI_GUIDELINES §3.5) de la courbe de solde */
/* cumulé du dashboard (câblage différé, cadrage §3.2).                 */
/*                                                                      */
/* Table ÉDITABLE / SUPPRIMABLE (donnée utilisateur de projection, PAS  */
/* de l'historique réalisé) → liste blanche DELETE de tygr_app.sql ;    */
/* JAMAIS append-only, JAMAIS mêlée à transactions_cache/balance_history */
/* (ECH-D3). DEUX étages d'isolation, comme bank_accounts :             */
/*   • Étage 1 (tenant, dur)   : RLS tenant_isolation (workspace_id).   */
/*   • Étage 2 (entité, scopé)  : policy entity_scope RESTRICTIVE FOR    */
/*     ALL posée PAR MIGRATION (même patron que 0014 sur bank_accounts).*/
/*     entity_id NULLABLE = « non rattachée » (Vision Globale seule).   */
/* Montant : DECIMAL, jamais float (règle 8) — le SENS (direction) porte */
/* le signe, `montant` est TOUJOURS positif. Multi-devise : 1 échéance  */
/* = 1 devise (ECH-D6), jamais d'addition cross-devise à l'agrégation.  */
/* ------------------------------------------------------------------ */

/** Sens d'une échéance : à encaisser (client) ou à décaisser (fournisseur). */
export const ECHEANCE_DIRECTIONS = ["encaissement", "decaissement"] as const;
export type EcheanceDirection = (typeof ECHEANCE_DIRECTIONS)[number];

/**
 * Statuts d'échéance (UI_GUIDELINES §3.6). `en_retard` est VOLONTAIREMENT ABSENT :
 * il est DÉRIVÉ à l'affichage (date d'échéance passée + non soldée), jamais stocké
 * (ECH-D5) — un statut dérivé ne se désynchronise pas de l'horloge (Indian/Mauritius).
 */
export const ECHEANCE_STATUTS = [
  "en_cours",
  "partiel",
  "paiement_en_cours",
  "payee",
  "annulee",
] as const;
export type EcheanceStatut = (typeof ECHEANCE_STATUTS)[number];

/**
 * Récurrence optionnelle. NULL = ponctuelle (« aucune »). Matérialisée à la
 * GÉNÉRATION des points de projection (cadrage §3.1), jamais en dupliquant N lignes
 * en base (ECH-D4) — zéro moteur d'occurrences au MVP (Epic 4.1, différé).
 */
export const ECHEANCE_RECURRENCES = ["mensuelle", "trimestrielle"] as const;
export type EcheanceRecurrence = (typeof ECHEANCE_RECURRENCES)[number];

export const echeances = pgTable(
  "echeances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /**
     * Entité (BU) rattachée. NULLABLE = « non rattachée » (visible en Vision
     * Globale seule). FK COMPOSITE scopée workspace (ci-dessous) : une entity_id
     * d'un autre tenant est impossible. Porte l'étage 2 (entity_scope), même rôle
     * que bank_accounts.entity_id.
     */
    entityId: uuid("entity_id"),
    direction: varchar("direction", { length: 12 })
      .notNull()
      .$type<EcheanceDirection>(),
    libelle: varchar("libelle", { length: 255 }).notNull(),
    /**
     * Nom libre du client/fournisseur (TEXTE au MVP — pas de lien vers `parties`,
     * pré-remplissage PartyId = dette P2 ENTITY-PARTY1). Peut tronquer à l'affichage
     * (libellé, jamais un chiffre — règle formatage).
     */
    contrepartie: varchar("contrepartie", { length: 255 }),
    /** Montant TOUJOURS positif (le signe est porté par `direction`). DECIMAL (règle 8). */
    montant: numeric("montant", { precision: 15, scale: 2 }).notNull(),
    devise: char("devise", { length: 3 }).notNull(),
    /**
     * Jour calendaire d'exigibilité — `DATE`, PAS un instant (ECH-D2). Une échéance
     * est due « le 15 juillet », pas « à 14h03 UTC ». La dérivation « en retard ? »
     * compare cette date à AUJOURD'HUI à Indian/Mauritius, côté application.
     */
    dateEcheance: date("date_echeance").notNull(),
    statut: varchar("statut", { length: 20 })
      .notNull()
      .default("en_cours")
      .$type<EcheanceStatut>(),
    /**
     * Catégorie analytique optionnelle. FK COMPOSITE scopée workspace (patron
     * categorization_rules) : une catégorie d'un autre tenant est impossible.
     */
    categorieId: uuid("categorie_id"),
    recurrence: varchar("recurrence", { length: 12 }).$type<EcheanceRecurrence>(),
    /** Montant déjà réglé (support du statut `partiel`). NULL = aucun règlement partiel. */
    montantRegle: numeric("montant_regle", { precision: 15, scale: 2 }),
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
    // Cible de FK COMPOSITES scopées futures (patron maison — cf. entities /
    // bank_accounts). Additive, expand-safe (la PK reste `id` seul).
    unique("echeances_id_workspace_unique").on(t.id, t.workspaceId),
    // FK COMPOSITE scopée workspace vers la BU (cœur de l'étage 2). Cible
    // entities(id, workspace_id) [UNIQUE]. ON DELETE RESTRICT : on archive une
    // entité référencée (is_active=false), jamais de cascade. Idem bank_accounts.
    foreignKey({
      columns: [t.entityId, t.workspaceId],
      foreignColumns: [entities.id, entities.workspaceId],
      name: "echeances_entity_workspace_fk",
    }).onDelete("restrict"),
    // FK COMPOSITE scopée workspace vers la catégorie (cible categories(id,
    // workspace_id)). Pas d'onDelete (no action) — aligné sur categorization_rules :
    // une catégorie référencée s'archive (is_active), l'échéance ne casse pas.
    foreignKey({
      columns: [t.categorieId, t.workspaceId],
      foreignColumns: [categories.id, categories.workspaceId],
      name: "echeances_categorie_workspace_fk",
    }),
    check(
      "echeances_direction_check",
      sql`${t.direction} IN ('encaissement','decaissement')`,
    ),
    check(
      "echeances_statut_check",
      sql`${t.statut} IN ('en_cours','partiel','paiement_en_cours','payee','annulee')`,
    ),
    check(
      "echeances_recurrence_check",
      sql`${t.recurrence} IS NULL OR ${t.recurrence} IN ('mensuelle','trimestrielle')`,
    ),
    // Montant strictement positif : le sens porte le signe (jamais de négatif stocké).
    check("echeances_montant_positif_check", sql`${t.montant} > 0`),
    // Règlement partiel cohérent : borné [0, montant] quand renseigné.
    check(
      "echeances_montant_regle_check",
      sql`${t.montantRegle} IS NULL OR (${t.montantRegle} >= 0 AND ${t.montantRegle} <= ${t.montant})`,
    ),
    index("echeances_workspace_id_idx").on(t.workspaceId),
    // Scope entité : retrouver les échéances d'une entité (ou les non-rattachées).
    index("echeances_workspace_entity_idx").on(t.workspaceId, t.entityId),
    // Tri par exigibilité + fenêtres d'horizon (30/60/90 j) ; workspace_id meneur.
    index("echeances_workspace_date_idx").on(t.workspaceId, t.dateEcheance),
    // Étage 1 — TENANT (fail-closed). L'étage 2 (entity_scope RESTRICTIVE FOR ALL)
    // est posé PAR MIGRATION (comme bank_accounts) — drizzle ne déclare que le tenant.
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/* ------------------------------------------------------------------ */
/* Epic 1 — Consent flow & audit trail (PLAN-epic1-auth-consent.md).    */
/* ------------------------------------------------------------------ */
/*                                                                      */
/* APPEND-ONLY STRICT (CLAUDE.md règle 8) : ni UPDATE ni DELETE, même   */
/* en migration de réparation — on écrit un ÉVÉNEMENT CORRECTIF. À ne   */
/* pas confondre avec transactions_cache / balance_history, qui sont    */
/* append-only au DELETE seulement (l'UPDATE tombstone y est permis).   */
/*                                                                      */
/* TROIS gardes complémentaires (aucune ne suffit seule) :              */
/*  (1) hors liste blanche DELETE de drizzle/provisioning/tygr_app.sql ;*/
/*  (2) REVOKE UPDATE, DELETE explicite (étape 6 du même script) — le   */
/*      GRANT global de l'étape 3 accorde UPDATE ON ALL TABLES ;        */
/*  (3) trigger BEFORE UPDATE OR DELETE (migration 0021) réutilisant    */
/*      tygr_refuser_mutation_append_only() créée en 0005. Seule        */
/*      défense indépendante du privilège ET du chemin (cascade FK,     */
/*      DELETE direct, même sous l'owner). ⚠️ Ne couvre PAS TRUNCATE    */
/*      (trigger STATEMENT distinct) — sans effet au runtime : tygr_app */
/*      n'a ni TRUNCATE ni DELETE ni UPDATE. Analyse dans 0021.         */
/*                                                                      */
/* AUTO-SUFFISANCE (plan §2.4, décision Q2) : aucune FK vers une table  */
/* ÉDITABLE (bank_connections, users — toutes deux dans la liste        */
/* blanche DELETE). Un audit qui exige une jointure vers une table      */
/* vivante n'est pas un audit : la ligne jointe a pu changer après      */
/* coup. On COPIE donc, à l'instant de l'événement, ce qu'il faut pour  */
/* relire l'enregistrement sans jointure et sans la ligne d'origine.    */
/* Précédent identique au repo : categorization_audit (transaction_id   */
/* sans FK + snapshots category_name/amount/source).                    */

/**
 * Cycle de vie du consentement bancaire — immuable et AUTO-SUFFISANT.
 *
 * Trois actions, trois événements (jamais un état muté) : l'état courant se
 * DÉRIVE du dernier événement par connexion. C'est ce qui rend le narratif
 * réglementaire (BOM Innov8) défendable : on ne peut pas réécrire l'histoire.
 *
 * ⚠️ Pas de FK sur `connectionId` ni `grantedByUserId` (décision Q2) :
 * - la révocation SUPPRIME la connexion (L3.3) → une FK RESTRICT bloquerait la
 *   révocation, une FK CASCADE tenterait d'effacer l'audit (le trigger lève) ;
 * - l'offboarding RGPD envisage `created_by → SET NULL` (dette #6, TODOS) →
 *   « Alice a consenti » deviendrait « ␀ a consenti ».
 * Les snapshots ci-dessous compensent : ils rendent la ligne lisible seule.
 */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Seule FK conservée : le tenant ne disparaît jamais sans que TOUT disparaisse. */
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),

    /* --- Objet du consentement : UUID nu + snapshot de désignation --- */
    /** `bank_connections.id`. PAS de FK (cf. supra) — corrélation applicative. */
    connectionId: uuid("connection_id").notNull(),
    /** Snapshot : « Absa Internet Banking ». Survit à la purge de la connexion. */
    institutionName: varchar("institution_name", { length: 140 }),

    /* --- Acteur : UUID nu + snapshot d'identité à l'instant T --- */
    /** `users.id`. PAS de FK (dette #6 : `SET NULL` à l'offboarding). */
    grantedByUserId: uuid("granted_by_user_id").notNull(),
    /** Snapshot NOT NULL : un consentement sans acteur identifiable n'a pas de valeur. */
    grantedByEmail: varchar("granted_by_email", { length: 254 }).notNull(),
    grantedByName: varchar("granted_by_name", { length: 120 }),

    action: varchar("action", { length: 30 }).notNull(),

    /**
     * `{ requestedScopes:[…] }` | `{ accountIds:[…], accountsLabels:[{accountId,masked}] }`
     * | `{ reason }`. Comptes MASQUÉS (`••••4321`) via `masquerCompte()` — JAMAIS
     * d'IBAN, de numéro complet ni de libellé bancaire brut (règle 8, PII).
     * Aucun montant, aucun solde : ce journal ne porte pas de donnée financière.
     */
    scope: jsonb("scope").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "consent_records_action_check",
      sql`${t.action} IN ('GRANTED','ACCOUNTS_SELECTED','REVOKED')`,
    ),
    // Dérivation de l'état courant : dernier événement par connexion.
    index("consent_records_ws_connection_idx").on(
      t.workspaceId,
      t.connectionId,
      t.createdAt.desc(),
    ),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();

/**
 * Journal d'audit — append-only strict, une table pour DEUX producteurs :
 * - `omnifiEventId IS NULL`  → événement APPLICATIF (consentement, révocation) ;
 * - `omnifiEventId IS NOT NULL` → événement WEBHOOK (route à venir, dette P1).
 *
 * ⚠️ `workspaceId` SANS FK, et c'est INTENTIONNEL (plan §6/P3, conforme au
 * cahier des charges §4.1) : un webhook peut arriver avant que le workspace
 * soit résolu, et l'audit doit pouvoir consigner l'anomalie. La RLS protège de
 * toute façon (elle compare au GUC, pas à une FK). NE PAS « réparer » en
 * ajoutant la FK : on rouvrirait le problème P1 sur cette table.
 *
 * Accès : ADMIN SEUL (décision Q1, `peutAdministrer`). Ces tables ne portent
 * pas `entity_id` (invariant : il vit uniquement sur bank_accounts) — un membre
 * en Vision Entité y verrait les événements de TOUTES les BU du groupe (fuite
 * intra-groupe). Fail-closed : la surface est cachée aux non-ADMIN.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    /** `consent.granted`, `consent.revoked`, `sync.completed`… VARCHAR, pas d'enum SQL. */
    eventType: varchar("event_type", { length: 60 }).notNull(),
    /** `EventId` du webhook Omni-FI (dédup). NULL = événement applicatif. */
    omnifiEventId: varchar("omnifi_event_id", { length: 64 }),
    /** PAS de FK (cf. consentRecords). */
    connectionId: uuid("connection_id"),
    /** NULL si événement système/webhook. PAS de FK. */
    actorUserId: uuid("actor_user_id"),
    /** 8 hexa = 32 bits : traçable, non rejouable. Jamais la signature complète. */
    hmacSignatureTruncated: varchar("hmac_signature_truncated", { length: 8 }),
    /** Liste blanche de clés par `eventType`, appliquée par le repository (zéro PII). */
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * Q4 — unicité COMPOSITE, jamais globale. Un `UNIQUE(omnifi_event_id)` seul
     * serait un ORACLE D'EXISTENCE cross-tenant (insérer l'EventId deviné d'un
     * autre workspace révèle son existence par la violation) + un DoS d'ingestion
     * sur collision. Même leçon que `omnifi_connection_id` (dette 1.1/1.2, 0018).
     *
     * Repose sur le garde-fou WEBHOOK-TENANT-FIRST1 (cf. bank_connections) : le
     * futur résolveur webhook DOIT résoudre le TENANT d'abord (ClientUserId →
     * workspace) PUIS la connexion dans ce workspace. Un EventId ne peut alors,
     * par construction, atterrir que dans un seul workspace.
     *
     * ⚠️ COMPORTEMENT POSTGRESQL À NE PAS « CORRIGER » : une contrainte UNIQUE
     * n'est JAMAIS violée par des NULL. N lignes applicatives
     * (`omnifi_event_id IS NULL`) coexistent donc sans conflit dans le même
     * workspace — c'est exactement le comportement voulu. Passer la colonne en
     * NOT NULL casserait l'émission applicative (consent.*).
     */
    unique("audit_events_workspace_omnifi_event_unique").on(
      t.workspaceId,
      t.omnifiEventId,
    ),
    // Pagination keyset du panneau d'audit (jamais d'OFFSET).
    index("audit_events_ws_created_idx").on(t.workspaceId, t.createdAt.desc()),
    pgPolicy("tenant_isolation", POLITIQUE_TENANT),
  ],
).enableRLS();
