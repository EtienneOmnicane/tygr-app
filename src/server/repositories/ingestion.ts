/**
 * Repository d'ingestion Omni-FI (PR 2) — persistance scopée des données bancaires.
 * TOUTES les fonctions s'exécutent DANS withWorkspace(session, fn) : `tx` porte
 * déjà app.current_workspace_id, donc chaque INSERT/UPDATE passe la policy
 * tenant_isolation WITH CHECK (impossible d'écrire dans un autre tenant). Le
 * workspace_id n'est jamais un paramètre client : il vient de ctx (CLAUDE.md
 * règle 2).
 *
 * Montants : chaînes `numeric` déjà normalisées par src/server/ingestion/conversion
 * (règle 8, jamais de float). Idempotence : voir upsertTransactions (#2).
 */
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  accountPartyRole,
  bankAccounts,
  bankConnections,
  balanceHistory,
  parties,
  transactionsCache,
} from "@/server/db/schema";
import type { CategorySource } from "@/server/db/schema";
import type { OmniFiAccount } from "@/server/omnifi";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface ConnexionAUpserter {
  omnifiConnectionId: string;
  institutionId: string;
  /** Nom lisible de l'institution (ex. « Absa Internet Banking ») ; null si absent. */
  institutionName: string | null;
  status: string;
  nextSyncAvailableAt: Date | null;
}

export interface CompteAUpserter {
  omnifiAccountId: string;
  accountName: string;
  currency: string;
  currentBalance: string | null; // numeric en chaîne (règle 8)
  isSelected: boolean;
}

export interface TransactionAUpserter {
  omnifiTxnId: string;
  transactionDate: string; // YYYY-MM-DD Maurice (E20)
  bookingDateTime: Date;
  amount: string; // numeric en chaîne (règle 8)
  currency: string;
  creditDebit: "Credit" | "Debit";
  bankLabelRaw: string | null;
  cleanLabel: string | null;
  primaryCategory: string | null;
  subCategory: string | null;
  /** Métadonnées de classification amont (TECH-API-TRACE) — descriptives, normalisées
   *  via chaineOuNull, jamais bornées par un CHECK (cf. schema.ts). */
  confidenceLevel: string | null;
  classificationSource: string | null;
  ruleIdMatch: string | null;
  /** Provenance auto de la catégorie OBIE (cf. orchestrateur.versLignePersistee). */
  isAutoCategorized: boolean;
  /** Source auto (NULL si non auto). Toujours cohérent avec isAutoCategorized. */
  categorySource: CategorySource | null;
  isRemoved: boolean;
}

export interface SoldeAUpserter {
  balanceDate: string; // YYYY-MM-DD
  balance: string; // numeric en chaîne
  currency: string;
}

/**
 * Upsert d'une connexion bancaire dans le workspace courant. Retourne l'id local.
 * Idempotent sur omnifi_connection_id (UNIQUE).
 */
export async function upsertConnexion<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  c: ConnexionAUpserter,
): Promise<{ connectionId: string }> {
  const lignes = await tx
    .insert(bankConnections)
    .values({
      workspaceId: ctx.workspaceId,
      omnifiConnectionId: c.omnifiConnectionId,
      institutionId: c.institutionId,
      institutionName: c.institutionName,
      status: c.status,
      nextSyncAvailableAt: c.nextSyncAvailableAt,
      createdBy: ctx.userId,
    })
    .onConflictDoUpdate({
      // Inférence sur la contrainte COMPOSITE scopée tenant (0018). En lock-step avec
      // le schéma : ON CONFLICT (cols) exige une UNIQUE portant EXACTEMENT ces colonnes
      // → ne tourne que si bank_connections_workspace_omnifi_connection_unique existe.
      target: [bankConnections.workspaceId, bankConnections.omnifiConnectionId],
      set: {
        // On rafraîchit le nom à chaque ingestion (l'institution peut être
        // renommée amont, ou la 1re ingestion l'avait laissé NULL).
        institutionName: c.institutionName,
        status: c.status,
        nextSyncAvailableAt: c.nextSyncAvailableAt,
      },
    })
    .returning({ id: bankConnections.id });
  return { connectionId: lignes[0].id };
}

/**
 * Upsert d'un compte rattaché à une connexion du workspace courant.
 * Idempotent sur omnifi_account_id (UNIQUE). Retourne l'id local + le curseur
 * de sync existant (pour reprendre l'incrémental).
 */
export async function upsertCompte<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  connectionId: string,
  c: CompteAUpserter,
): Promise<{ bankAccountId: string; syncCursor: string | null }> {
  const lignes = await tx
    .insert(bankAccounts)
    .values({
      workspaceId: ctx.workspaceId,
      connectionId,
      omnifiAccountId: c.omnifiAccountId,
      accountName: c.accountName,
      currency: c.currency,
      currentBalance: c.currentBalance,
      isSelected: c.isSelected,
    })
    .onConflictDoUpdate({
      // Inférence sur la contrainte COMPOSITE scopée tenant (0018) — cf. upsertConnexion.
      target: [bankAccounts.workspaceId, bankAccounts.omnifiAccountId],
      set: {
        // Un compte re-découvert via une AUTRE connexion suit la connexion la plus
        // récente (la sandbox renvoie les mêmes AccountId sur chaque reconnexion ;
        // sans ça le compte resterait collé à sa 1re connexion → mauvais
        // institution_name au dashboard, et les nouvelles connexions à 0 compte).
        connectionId,
        accountName: c.accountName,
        currency: c.currency,
        currentBalance: c.currentBalance,
        isSelected: c.isSelected,
      },
    })
    .returning({ id: bankAccounts.id, syncCursor: bankAccounts.syncCursor });
  return { bankAccountId: lignes[0].id, syncCursor: lignes[0].syncCursor };
}

/**
 * Upsert idempotent d'un lot de transactions (#2 — la clé DB inclut
 * transaction_date à cause du partitionnement ; un upsert ON CONFLICT keyé sur
 * (omnifi_txn_id, transaction_date) raterait un doublon si la date comptable
 * change entre deux syncs). On rend donc l'idempotence indépendante de la date :
 * pour chaque transaction, on SUPPRIME LOGIQUEMENT toute ligne existante de même
 * omnifi_txn_id dont la date diffère (réaffectation de jour comptable), puis on
 * upsert sur la clé naturelle. Tout dans la transaction withWorkspace courante.
 *
 * NB : transactions_cache n'autorise pas le DELETE (tombstone, #3) ; la
 * « suppression » d'un doublon de date obsolète passe par is_removed=true.
 */
export async function upsertTransactions<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  bankAccountId: string,
  lot: TransactionAUpserter[],
): Promise<{ insérées: number }> {
  let compteur = 0;
  for (const t of lot) {
    // #2 : neutralise toute version antérieure de CETTE transaction posée sur un
    // AUTRE jour comptable (BookingDateTime ré-affiné par l'amont). RLS scope la
    // mise à jour au workspace courant ; on ne touche jamais un autre tenant.
    await tx
      .update(transactionsCache)
      .set({ isRemoved: true })
      .where(
        and(
          eq(transactionsCache.omnifiTxnId, t.omnifiTxnId),
          sql`${transactionsCache.transactionDate} <> ${t.transactionDate}`,
        ),
      );

    await tx
      .insert(transactionsCache)
      .values({
        workspaceId: ctx.workspaceId,
        bankAccountId,
        omnifiTxnId: t.omnifiTxnId,
        transactionDate: t.transactionDate,
        bookingDateTime: t.bookingDateTime,
        amount: t.amount,
        currency: t.currency,
        creditDebit: t.creditDebit,
        bankLabelRaw: t.bankLabelRaw,
        cleanLabel: t.cleanLabel,
        primaryCategory: t.primaryCategory,
        subCategory: t.subCategory,
        confidenceLevel: t.confidenceLevel,
        classificationSource: t.classificationSource,
        ruleIdMatch: t.ruleIdMatch,
        isAutoCategorized: t.isAutoCategorized,
        categorySource: t.categorySource,
        isRemoved: t.isRemoved,
      })
      .onConflictDoUpdate({
        // Inférence sur la contrainte COMPOSITE scopée tenant (0018). transaction_date
        // reste dans la clé (partition key). Cf. upsertConnexion pour la règle lock-step.
        target: [
          transactionsCache.workspaceId,
          transactionsCache.omnifiTxnId,
          transactionsCache.transactionDate,
        ],
        set: {
          amount: t.amount,
          currency: t.currency,
          creditDebit: t.creditDebit,
          bankLabelRaw: t.bankLabelRaw,
          cleanLabel: t.cleanLabel,
          primaryCategory: t.primaryCategory,
          subCategory: t.subCategory,
          // Métadonnées de classification amont : un re-sync reflète toujours l'état
          // Omni-FI courant (déterministe/idempotent, comme les autres champs).
          confidenceLevel: t.confidenceLevel,
          classificationSource: t.classificationSource,
          ruleIdMatch: t.ruleIdMatch,
          // On reflète toujours l'état Omni-FI courant : un re-sync remet le marqueur
          // en cohérence avec la catégorie reçue (déterministe, idempotent). Le
          // marqueur est orthogonal aux splits — ne touche jamais la catégorisation
          // manuelle/règles (table transaction_categorizations, intacte).
          isAutoCategorized: t.isAutoCategorized,
          categorySource: t.categorySource,
          isRemoved: t.isRemoved,
        },
      });
    compteur += 1;
  }
  return { insérées: compteur };
}

/** Upsert d'un lot de soldes EOD d'un compte. Idempotent sur (bank_account_id, balance_date). */
export async function upsertSoldes<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  bankAccountId: string,
  lot: SoldeAUpserter[],
): Promise<void> {
  for (const s of lot) {
    await tx
      .insert(balanceHistory)
      .values({
        workspaceId: ctx.workspaceId,
        bankAccountId,
        balanceDate: s.balanceDate,
        balance: s.balance,
        currency: s.currency,
      })
      .onConflictDoUpdate({
        target: [balanceHistory.bankAccountId, balanceHistory.balanceDate],
        set: { balance: s.balance, currency: s.currency },
      });
  }
}

/**
 * Marque la dernière synchronisation d'un compte (`last_synced_at`). Le modèle
 * d'ingestion est par PAGE (on relit toujours depuis la page 1) : il n'y a plus de
 * curseur à persister — la colonne `sync_cursor` reste orpheline (dette TODOS,
 * retrait différé pour ne pas coupler ce changement à une migration).
 */
export async function marquerSynchronise<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  bankAccountId: string,
  maintenant: Date,
): Promise<void> {
  await tx
    .update(bankAccounts)
    .set({ lastSyncedAt: maintenant })
    .where(eq(bankAccounts.id, bankAccountId));
}

/* ------------------------------------------------------------------ */
/* Ingestion des PARTIES (détention compte↔party) — L3               */
/*                                                                    */
/* Alimente `parties` + `account_party_role` depuis `OmniFiAccount`.  */
/* Best-effort ADDITIF (INSERT/UPDATE, jamais de DELETE) ; aucune     */
/* lecture branchée dessus à ce stade (le périmètre account_scope est */
/* L4). L'écriture est appelée par l'orchestration APRÈS le commit    */
/* des comptes, dans une transaction SÉPARÉE (la couche bancaire ne   */
/* doit jamais être empoisonnée par un échec parties) — cf.           */
/* persisterConnexionEtComptes (orchestration.ts).                    */
/* ------------------------------------------------------------------ */

/** Normalise une chaîne Omni-FI vers `string | null` (vide/espaces → null).
 *  Réplique locale du helper d'ingestion (orchestrateur.ts) — dépendance pure
 *  triviale, gardée ici pour que la couche repository reste autonome. */
function chaineOuNull(s: string | undefined | null): string | null {
  const v = s?.trim();
  return v ? v : null;
}

/** Party à upserter, dérivée d'un `OmniFiAccount`. `name`/`ownershipType` sont
 *  des hints amont (nullable, rafraîchis au re-sync). */
export interface PartieAUpserter {
  omnifiPartyId: string;
  name: string | null;
  ownershipType: string | null;
}

/**
 * Mappe un `OmniFiAccount` vers la party à upserter, ou `null` quand le compte
 * ne porte AUCUNE party exploitable (`PartyId` absent/vide). Fonction PURE,
 * testable en isolation.
 *
 * DÉCISION 1 (L3) : le contrat HTTP ne porte qu'UN `PartyId` SCALAIRE par compte
 * (pas de `Parties[]`). Ce mappeur produit donc au plus UNE party. Le jour où
 * l'amont exposera un tableau, SEUL ce mappeur changera (renverra une liste) —
 * la boucle d'écriture en aval itère déjà sur une collection (0/1 aujourd'hui),
 * donc rien d'autre ne bouge.
 */
export function versPartie(c: OmniFiAccount): PartieAUpserter | null {
  const omnifiPartyId = chaineOuNull(c.PartyId);
  if (omnifiPartyId === null) return null;
  return {
    omnifiPartyId,
    name: chaineOuNull(c.PartyName),
    ownershipType: chaineOuNull(c.OwnershipType),
  };
}

/**
 * Upsert idempotent d'une party + de sa liaison de détention à un compte.
 * Tout dans la transaction `withWorkspace` courante (RLS : workspace_id vient de
 * `ctx`, JAMAIS de la donnée Omni-FI — CLAUDE.md règle 2).
 *
 * Invariant CRITIQUE (aligné sur `bank_accounts.entity_id`) : les champs HUMAINS
 * ou immuables — `entityId`, `isActive`, `createdAt`, `id` — sont OMIS du
 * `set` des deux upserts. Un re-sync rafraîchit les hints amont (`name`,
 * `ownershipType`) mais ne réécrase JAMAIS un rattachement BU ou un archivage
 * décidé par l'ADMIN.
 */
export async function upsertPartieEtRole<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  bankAccountId: string,
  p: PartieAUpserter,
): Promise<void> {
  // a. Party : idempotente sur (workspace_id, omnifi_party_id). On NE touche que
  //    les hints amont au conflit — entity_id / is_active / created_at restent
  //    HUMAINS (mêmes invariant et raison que bank_accounts.entity_id).
  const lignes = await tx
    .insert(parties)
    .values({
      workspaceId: ctx.workspaceId,
      omnifiPartyId: p.omnifiPartyId,
      name: p.name,
      ownershipType: p.ownershipType,
    })
    .onConflictDoUpdate({
      target: [parties.workspaceId, parties.omnifiPartyId],
      set: { name: p.name, ownershipType: p.ownershipType },
    })
    .returning({ id: parties.id });
  const partyId = lignes[0].id;

  // b. Liaison compte↔party : idempotente sur la PK composite. `ownership_type`
  //    est NOT NULL côté schéma → repli "PRIMARY" si l'amont ne fournit rien
  //    (un compte avec une party mais sans rôle est traité comme détenteur
  //    principal). `is_primary` reflète l'unique party scalaire d'aujourd'hui.
  await tx
    .insert(accountPartyRole)
    .values({
      workspaceId: ctx.workspaceId,
      bankAccountId,
      partyId,
      ownershipType: p.ownershipType ?? "PRIMARY",
      isPrimary: true,
    })
    .onConflictDoUpdate({
      target: [
        accountPartyRole.workspaceId,
        accountPartyRole.bankAccountId,
        accountPartyRole.partyId,
      ],
      set: { ownershipType: p.ownershipType ?? "PRIMARY" },
    });
}
