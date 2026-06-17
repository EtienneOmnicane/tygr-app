/**
 * Repository de catégorisation manuelle + ventilation (Pilier 1, spec
 * docs/specs/pilier1-categorisation-manuelle.md). TOUTES les fonctions
 * s'exécutent DANS withWorkspace(session, fn) : `tx` porte déjà
 * app.current_workspace_id → chaque écriture passe la policy tenant_isolation
 * WITH CHECK (impossible d'écrire dans un autre tenant). `workspace_id` n'est
 * jamais un paramètre client : il vient de ctx (CLAUDE.md règle 2).
 *
 * transactions_cache reste READ-ONLY : on la LIT (montant de la transaction pour
 * l'invariant de ventilation) mais on n'y écrit JAMAIS.
 *
 * Montants : chaînes décimales `numeric` (règle 8, jamais de float). L'invariant
 * « somme des splits ≤ |montant de la transaction| » est appliqué EN
 * TRANSACTION avec un `SELECT … FOR UPDATE` sur la LIGNE transactions_cache de la
 * transaction (verrou qui conflit avec lui-même → sérialise les ajouts
 * concurrents, y compris sur une transaction encore sans split). Voir ajouterSplit.
 */
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  categories,
  categorizationAudit,
  transactionCategorizations,
  transactionsCache,
} from "@/server/db/schema";
import type { CategorizationSource } from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Référence d'une transaction (clé composite, table partitionnée). */
export interface RefTransaction {
  transactionId: string;
  transactionDate: string; // YYYY-MM-DD (E20)
}

export interface SplitAAjouter {
  transactionId: string;
  transactionDate: string;
  categoryId: string;
  amount: string; // numeric en chaîne (> 0)
  source: CategorizationSource;
  ruleId: string | null; // requis ssi source='RULE'
}

export interface SplitLu {
  id: string;
  categoryId: string;
  amount: string;
  source: CategorizationSource;
  ruleId: string | null;
}

/** Levée quand un split ferait dépasser le montant de la transaction (spec §4). */
export class VentilationDepasseError extends Error {
  readonly code = "VENTILATION_EXCEEDS_AMOUNT";
  constructor() {
    super("La somme des catégorisations dépasse le montant de la transaction.");
    this.name = "VentilationDepasseError";
  }
}

/** Levée quand la transaction visée n'existe pas dans le workspace courant. */
export class TransactionIntrouvableError extends Error {
  readonly code = "TRANSACTION_NOT_FOUND";
  constructor() {
    super("Transaction introuvable.");
    this.name = "TransactionIntrouvableError";
  }
}

/**
 * Liste les splits d'une transaction (scopé workspace courant par la RLS).
 */
export async function listerSplits<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  _ctx: WorkspaceContext,
  ref: RefTransaction,
): Promise<SplitLu[]> {
  const lignes = await tx
    .select({
      id: transactionCategorizations.id,
      categoryId: transactionCategorizations.categoryId,
      amount: transactionCategorizations.amount,
      source: transactionCategorizations.source,
      ruleId: transactionCategorizations.ruleId,
    })
    .from(transactionCategorizations)
    .where(
      and(
        eq(transactionCategorizations.transactionId, ref.transactionId),
        eq(transactionCategorizations.transactionDate, ref.transactionDate),
      ),
    );
  return lignes as SplitLu[];
}

/**
 * Ajoute un split à une transaction, en garantissant l'invariant de ventilation
 * (somme ≤ |montant txn|) sous verrou. Écrit l'événement d'audit (append-only).
 * Retourne l'id du split créé.
 *
 * Anti-course : on lit le montant de la transaction ET la somme des splits
 * existants AVEC `FOR UPDATE` sur les lignes de splits de cette transaction —
 * deux ajouts concurrents sont sérialisés, ils ne peuvent pas valider ensemble
 * un total qui dépasse.
 */
export async function ajouterSplit<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  split: SplitAAjouter,
): Promise<{ splitId: string }> {
  // 1. Montant absolu de la transaction (LECTURE seule de transactions_cache).
  //    La RLS scope déjà au workspace ; abs() car le signe vit sur la txn.
  const txn = await tx
    .select({ amountAbs: sql<string>`abs(${transactionsCache.amount})` })
    .from(transactionsCache)
    .where(
      and(
        eq(transactionsCache.id, split.transactionId),
        eq(transactionsCache.transactionDate, split.transactionDate),
      ),
    )
    .limit(1)
    // VERROU DE SÉRIALISATION (correctif cross-review BLOQUANT) : on verrouille la
    // LIGNE transactions_cache de la transaction — un objet STABLE qui existe
    // toujours (≠ FOR UPDATE sur les splits, qui ne verrouille RIEN si la
    // transaction n'a encore aucun split → deux 1ers ajouts concurrents
    // pouvaient dépasser ensemble |montant|).
    // `FOR UPDATE` et NON `FOR SHARE` : dans la matrice des row-level locks
    // PostgreSQL, FOR SHARE NE conflit PAS avec lui-même → deux ajouts
    // concurrents prendraient tous deux le verrou partagé sans s'attendre, et la
    // race resterait ouverte (2e cross-review). FOR UPDATE conflit avec
    // lui-même : le 2e ajout attend le commit du 1er, puis relit la somme à jour
    // et rejette correctement. FOR UPDATE n'ÉCRIT PAS la ligne (read-only de
    // transactions_cache préservé) — il ne fait qu'acquérir un verrou de ligne.
    // RLS scope déjà au workspace.
    // ⚠️ PGlite (mono-backend) ne peut pas couvrir cette race en CI — invariant
    // de verrou validé par la sémantique PostgreSQL, à éprouver en intégration
    // multi-backend (cf. spec §11, même statut que les races CSO).
    .for("update");
  if (txn.length === 0) {
    throw new TransactionIntrouvableError();
  }

  // 2. Somme des splits existants (le verrou ci-dessus a déjà sérialisé l'accès
  //    sur cette transaction → la somme lue est stable jusqu'au commit).
  const sommeRows = await tx
    .select({
      total: sql<string>`coalesce(sum(${transactionCategorizations.amount}), 0)`,
    })
    .from(transactionCategorizations)
    .where(
      and(
        eq(transactionCategorizations.transactionId, split.transactionId),
        eq(transactionCategorizations.transactionDate, split.transactionDate),
      ),
    );
  const totalExistant = sommeRows[0]?.total ?? "0";

  // 3. Invariant : total existant + nouveau ≤ |montant txn| (comparaison
  //    numérique côté SQL pour éviter toute imprécision float côté TS).
  const dansLeMontant = await tx
    .select({
      ok: sql<boolean>`(${totalExistant}::numeric + ${split.amount}::numeric) <= ${txn[0].amountAbs}::numeric`,
    })
    .from(sql`(select 1) as _`);
  if (!dansLeMontant[0]?.ok) {
    throw new VentilationDepasseError();
  }

  // 4. Insert du split (RLS WITH CHECK garantit le bon workspace).
  const inserted = await tx
    .insert(transactionCategorizations)
    .values({
      workspaceId: ctx.workspaceId,
      transactionId: split.transactionId,
      transactionDate: split.transactionDate,
      categoryId: split.categoryId,
      amount: split.amount,
      source: split.source,
      ruleId: split.ruleId,
      createdBy: ctx.userId,
    })
    .returning({ id: transactionCategorizations.id });

  // 5. Audit append-only (snapshot lisible ; nom de catégorie résolu).
  await ecrireAudit(tx, ctx, {
    transactionId: split.transactionId,
    transactionDate: split.transactionDate,
    action: "CREATE",
    categoryId: split.categoryId,
    amount: split.amount,
    source: split.source,
  });

  return { splitId: inserted[0].id };
}

/**
 * Supprime un split (correction de catégorisation). Écrit l'audit. La RLS scope
 * la suppression au workspace courant (un split d'un autre tenant → 0 ligne).
 */
export async function supprimerSplit<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  splitId: string,
): Promise<{ supprime: boolean }> {
  const supprimes = await tx
    .delete(transactionCategorizations)
    .where(eq(transactionCategorizations.id, splitId))
    .returning({
      transactionId: transactionCategorizations.transactionId,
      transactionDate: transactionCategorizations.transactionDate,
      categoryId: transactionCategorizations.categoryId,
      amount: transactionCategorizations.amount,
      source: transactionCategorizations.source,
    });
  if (supprimes.length === 0) {
    return { supprime: false };
  }
  const s = supprimes[0];
  await ecrireAudit(tx, ctx, {
    transactionId: s.transactionId,
    transactionDate: s.transactionDate,
    action: "DELETE",
    categoryId: s.categoryId,
    amount: s.amount,
    source: s.source as CategorizationSource,
  });
  return { supprime: true };
}

interface EvenementAudit {
  transactionId: string;
  transactionDate: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  categoryId: string;
  amount: string;
  source: CategorizationSource;
}

/**
 * Écrit une ligne d'audit immuable. Résout le nom de catégorie pour un snapshot
 * lisible (la catégorie peut être renommée/désactivée plus tard). INSERT
 * uniquement (la table est append-only : UPDATE/DELETE rejetés par trigger).
 */
async function ecrireAudit<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  evt: EvenementAudit,
): Promise<void> {
  const cat = await tx
    .select({ name: categories.name })
    .from(categories)
    .where(eq(categories.id, evt.categoryId))
    .limit(1);

  await tx.insert(categorizationAudit).values({
    workspaceId: ctx.workspaceId,
    transactionId: evt.transactionId,
    transactionDate: evt.transactionDate,
    action: evt.action,
    categoryName: cat[0]?.name ?? null,
    amount: evt.amount,
    source: evt.source,
    actorId: ctx.userId,
  });
}
