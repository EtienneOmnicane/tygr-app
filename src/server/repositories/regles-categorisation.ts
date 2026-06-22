/**
 * Repository du moteur de règles de catégorisation (FYGR-style). Comme tous les
 * repositories, chaque fonction s'exécute DANS withWorkspace(session, fn) : `tx`
 * porte app.current_workspace_id → la policy tenant_isolation borne lecture ET
 * écriture au workspace courant (impossible d'agir sur un autre tenant).
 * workspace_id n'est JAMAIS un paramètre client : il vient de ctx (règle 2).
 *
 * Deux responsabilités :
 *  1. CRUD du référentiel de règles (créer / modifier / archiver / lister).
 *  2. `appliquerRegles` : le SERVICE qui catégorise automatiquement les
 *     transactions NON encore ventilées dont le libellé matche une règle, en
 *     créant un split à 100 % du montant (source='RULE'). MANUAL prime : une
 *     transaction déjà ventilée à la main n'est JAMAIS touchée.
 *
 * Montants (règle 8) : le split reprend abs(montant de la transaction), calculé
 * en numeric côté SQL (jamais de float TS). L'audit est écrit par la source
 * unique `ecrireAudit` (categorisation.ts).
 *
 * PII (règle 8) : le matching LIT le libellé (clean_label, repli bank_label_raw)
 * mais ne le LOGGE JAMAIS, ni dans un message d'erreur. Le pattern lui-même n'est
 * pas journalisé.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  bankAccounts,
  categorizationRules,
  transactionCategorizations,
  transactionsCache,
} from "@/server/db/schema";
import type { RuleMatchType } from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";
import { ecrireAudit } from "@/server/repositories/categorisation";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface RegleLue {
  id: string;
  pattern: string;
  matchType: RuleMatchType;
  categoryId: string;
  isActive: boolean;
  priority: number;
}

export interface RegleACreer {
  pattern: string;
  matchType: RuleMatchType;
  categoryId: string;
  priority?: number;
}

export interface RegleAModifier {
  ruleId: string;
  pattern?: string;
  matchType?: RuleMatchType;
  categoryId?: string;
  priority?: number;
  isActive?: boolean;
}

/** Levée quand la règle visée n'existe pas dans le workspace courant. */
export class RegleIntrouvableError extends Error {
  readonly code = "RULE_NOT_FOUND";
  constructor() {
    super("Règle introuvable.");
    this.name = "RegleIntrouvableError";
  }
}

/* ------------------------------------------------------------------ */
/* CRUD du référentiel de règles                                       */
/* ------------------------------------------------------------------ */

/**
 * Liste les règles du workspace courant (RLS + filtre explicite workspace_id en
 * défense en profondeur). Par défaut TOUTES (actives + archivées) pour l'écran
 * d'admin ; `actives:true` ne renvoie que les actives. Triées par priorité
 * croissante (la plus petite gagne à l'application), puis date.
 */
export async function listerRegles<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  opts: { actives?: boolean } = {},
): Promise<RegleLue[]> {
  const conditions = [eq(categorizationRules.workspaceId, ctx.workspaceId)];
  if (opts.actives) {
    conditions.push(eq(categorizationRules.isActive, true));
  }
  const lignes = await tx
    .select({
      id: categorizationRules.id,
      pattern: categorizationRules.pattern,
      matchType: categorizationRules.matchType,
      categoryId: categorizationRules.categoryId,
      isActive: categorizationRules.isActive,
      priority: categorizationRules.priority,
    })
    .from(categorizationRules)
    .where(and(...conditions))
    .orderBy(asc(categorizationRules.priority), asc(categorizationRules.createdAt));
  return lignes as RegleLue[];
}

/**
 * Crée une règle. Le WITH CHECK RLS garantit le bon workspace ; la FK category
 * COMPOSITE garantit que category_id appartient au MÊME workspace (impossible de
 * cibler la catégorie d'un autre tenant). Retourne l'id créé.
 */
export async function creerRegle<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  input: RegleACreer,
): Promise<{ ruleId: string }> {
  const inserted = await tx
    .insert(categorizationRules)
    .values({
      workspaceId: ctx.workspaceId,
      pattern: input.pattern,
      matchType: input.matchType,
      categoryId: input.categoryId,
      priority: input.priority ?? 0,
      createdBy: ctx.userId,
    })
    .returning({ id: categorizationRules.id });
  return { ruleId: inserted[0].id };
}

/**
 * Modifie une règle (champs partiels). La RLS scope la mise à jour au workspace
 * courant ; une règle d'un autre tenant → 0 ligne → RegleIntrouvableError. La FK
 * composite re-valide qu'une nouvelle category_id reste dans le workspace.
 */
export async function modifierRegle<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  input: RegleAModifier,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (input.pattern !== undefined) set.pattern = input.pattern;
  if (input.matchType !== undefined) set.matchType = input.matchType;
  if (input.categoryId !== undefined) set.categoryId = input.categoryId;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.isActive !== undefined) set.isActive = input.isActive;

  // Rien à modifier : on vérifie quand même l'existence (sinon un appel vide
  // renverrait « OK » sur une règle inexistante → faux positif).
  if (Object.keys(set).length === 0) {
    const exists = await tx
      .select({ id: categorizationRules.id })
      .from(categorizationRules)
      .where(
        and(
          eq(categorizationRules.id, input.ruleId),
          eq(categorizationRules.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);
    if (exists.length === 0) throw new RegleIntrouvableError();
    return;
  }

  const maj = await tx
    .update(categorizationRules)
    .set(set)
    .where(
      and(
        eq(categorizationRules.id, input.ruleId),
        eq(categorizationRules.workspaceId, ctx.workspaceId),
      ),
    )
    .returning({ id: categorizationRules.id });
  if (maj.length === 0) throw new RegleIntrouvableError();
}

/**
 * Archive une règle (is_active=false) — désactivation sans suppression. La règle
 * cesse d'être appliquée (appliquerRegles ne charge que les actives) mais subsiste
 * (les splits RULE qu'elle a produits gardent leur rule_id). Idempotent.
 */
export async function archiverRegle<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  ruleId: string,
): Promise<void> {
  const maj = await tx
    .update(categorizationRules)
    .set({ isActive: false })
    .where(
      and(
        eq(categorizationRules.id, ruleId),
        eq(categorizationRules.workspaceId, ctx.workspaceId),
      ),
    )
    .returning({ id: categorizationRules.id });
  if (maj.length === 0) throw new RegleIntrouvableError();
}

/* ------------------------------------------------------------------ */
/* Service d'application — appliquerRegles                              */
/* ------------------------------------------------------------------ */

export interface ResultatApplication {
  transactionsCategorisees: number;
  splitsCrees: number;
}

/** Transaction candidate à la catégorisation auto (libellé pour le match). */
interface Candidate {
  id: string;
  transactionDate: string;
  amountAbs: string;
  /** clean_label si non vide, sinon bank_label_raw (peut être null → pas de match). */
  libelle: string | null;
}

/**
 * Échappe les méta-caractères LIKE d'un motif utilisateur (`\`, `%`, `_`) pour
 * qu'ils soient traités comme des littéraux. Sans ça, un pattern « 50% »
 * deviendrait un joker « 50 + n'importe quoi ». On échappe d'abord le backslash
 * (caractère d'échappement) puis % et _. Couplé à `ESCAPE '\'` dans le ILIKE.
 */
export function echapperLike(motif: string): string {
  return motif.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Applique les règles ACTIVES du workspace aux transactions NON encore
 * catégorisées : pour chaque transaction candidate, la PREMIÈRE règle (par
 * priorité croissante) dont le motif matche le libellé crée un split à 100 % du
 * montant (source='RULE'). Idempotent (les transactions déjà ventilées sont
 * exclues), ré-exécutable sans doublon.
 *
 * Tout s'exécute dans la transaction withWorkspace courante (atomique). Portée :
 *  - `opts.bankAccountId` : limite aux transactions d'un compte (appel post-sync
 *    ciblé). Absent → tout le workspace.
 *
 * ISOLATION (CLAUDE.md) :
 *  - Étage 1 (tenant) : transactions_cache + transaction_categorizations portent
 *    tenant_isolation → on n'agit que sur le workspace courant.
 *  - Étage 2 (entité) : on JOINT bank_accounts (héritage du scope entité,
 *    ENTITY-READ-JOIN1). Le service tourne en Vision Globale (ingestion / ADMIN),
 *    où la policy entity_scope laisse tout passer — la jointure est alors neutre,
 *    mais elle garantit qu'on ne catégoriserait jamais un compte hors scope si le
 *    service tournait un jour sous un scope d'entité (fail-closed par construction).
 *
 * CONCURRENCE (règle 3) : chaque transaction est traitée sous un verrou FOR
 * UPDATE sur sa ligne transactions_cache (objet stable), puis on RE-VÉRIFIE
 * l'absence de split sous ce verrou avant d'insérer. Deux exécutions concurrentes
 * sont sérialisées : la 2ᵉ voit le split de la 1ʳᵉ et skip → jamais de double
 * catégorisation. (PGlite mono-backend ne prouve pas la race — invariant validé
 * par la sémantique PostgreSQL, même statut que ajouterSplit.)
 */
export async function appliquerRegles<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  opts: { bankAccountId?: string } = {},
): Promise<ResultatApplication> {
  // 1. Règles actives, par priorité (la plus petite gagne).
  const regles = await listerRegles(tx, ctx, { actives: true });
  if (regles.length === 0) {
    return { transactionsCategorisees: 0, splitsCrees: 0 };
  }

  // 2. Transactions candidates : du workspace (RLS), non supprimées, SANS aucun
  //    split (NOT EXISTS — MANUAL comme RULE déjà posé l'excluent). Jointure
  //    bank_accounts pour l'héritage du scope entité (étage 2). Libellé de match
  //    = clean_label si non vide, sinon bank_label_raw. On ne charge QUE les
  //    transactions sans split (volume borné par construction au non-catégorisé).
  const filtres = [
    eq(transactionsCache.workspaceId, ctx.workspaceId),
    eq(transactionsCache.isRemoved, false),
    sql`not exists (
      select 1 from ${transactionCategorizations} tc
      where tc.transaction_id = ${transactionsCache.id}
        and tc.transaction_date = ${transactionsCache.transactionDate}
    )`,
  ];
  if (opts.bankAccountId) {
    filtres.push(eq(transactionsCache.bankAccountId, opts.bankAccountId));
  }

  const candidates = (await tx
    .select({
      id: transactionsCache.id,
      transactionDate: transactionsCache.transactionDate,
      amountAbs: sql<string>`abs(${transactionsCache.amount})`,
      libelle: sql<
        string | null
      >`coalesce(nullif(trim(${transactionsCache.cleanLabel}), ''), ${transactionsCache.bankLabelRaw})`,
    })
    .from(transactionsCache)
    .innerJoin(
      bankAccounts,
      eq(bankAccounts.id, transactionsCache.bankAccountId),
    )
    .where(and(...filtres))) as Candidate[];

  let transactionsCategorisees = 0;
  let splitsCrees = 0;

  // 3. Pour chaque candidate : trouver la 1ʳᵉ règle qui matche (en SQL, ILIKE
  //    insensible à la casse + échappement des méta-caractères LIKE), puis créer
  //    le split sous verrou.
  for (const c of candidates) {
    if (c.libelle === null) continue; // pas de libellé exploitable → pas de match
    const libelle = c.libelle;

    const regleQuiMatche = await trouverRegleQuiMatche(tx, libelle, regles);
    if (!regleQuiMatche) continue;

    const cree = await creerSplitDepuisRegle(tx, ctx, c, regleQuiMatche);
    if (cree) {
      transactionsCategorisees += 1;
      splitsCrees += 1;
    }
  }

  return { transactionsCategorisees, splitsCrees };
}

/**
 * Renvoie la PREMIÈRE règle (les `regles` sont déjà triées par priorité) dont le
 * motif matche le libellé. Le match est délégué à PostgreSQL (ILIKE, insensible
 * à la casse, cohérent avec un futur match SQL en masse) avec ESCAPE pour traiter
 * les méta-caractères du motif comme des littéraux. Le libellé et le motif sont
 * PARAMÉTRÉS (anti-injection) — jamais interpolés.
 */
async function trouverRegleQuiMatche<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  libelle: string,
  regles: RegleLue[],
): Promise<RegleLue | null> {
  for (const r of regles) {
    const motif = echapperLike(r.pattern);
    // 'contains' → %motif% ; 'starts_with' → motif% . Concaténation des jokers
    // EN SQL autour du motif déjà échappé (les % ajoutés ici sont les vrais
    // jokers ; ceux du motif utilisateur ont été neutralisés par echapperLike).
    const expr =
      r.matchType === "starts_with"
        ? sql<boolean>`${libelle} ilike (${motif} || '%') escape '\\'`
        : sql<boolean>`${libelle} ilike ('%' || ${motif} || '%') escape '\\'`;
    const res = await tx
      .select({ ok: expr })
      .from(sql`(select 1) as _`);
    if (res[0]?.ok) return r;
  }
  return null;
}

/**
 * Crée le split à 100 % pour une transaction candidate, sous verrou de
 * sérialisation, en re-vérifiant l'absence de split (anti-course : MANUAL prime).
 * Retourne false si la transaction a été catégorisée entre-temps (skip).
 */
async function creerSplitDepuisRegle<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  c: Candidate,
  regle: RegleLue,
): Promise<boolean> {
  // Verrou de sérialisation sur la LIGNE transactions_cache (objet stable, comme
  // ajouterSplit). FOR UPDATE conflit avec lui-même → deux applications
  // concurrentes s'attendent. Read-only de transactions_cache préservé (le verrou
  // n'écrit pas la ligne). RLS scope déjà au workspace.
  const verrou = await tx
    .select({ id: transactionsCache.id })
    .from(transactionsCache)
    .where(
      and(
        eq(transactionsCache.id, c.id),
        eq(transactionsCache.transactionDate, c.transactionDate),
      ),
    )
    .limit(1)
    .for("update");
  if (verrou.length === 0) return false; // disparue entre-temps

  // Re-vérification SOUS VERROU : un split (MANUAL ou RULE) est-il apparu depuis
  // la sélection ? Si oui, on respecte l'existant (MANUAL prime) et on skip.
  const dejaSplit = await tx
    .select({ un: sql<number>`1` })
    .from(transactionCategorizations)
    .where(
      and(
        eq(transactionCategorizations.transactionId, c.id),
        eq(transactionCategorizations.transactionDate, c.transactionDate),
      ),
    )
    .limit(1);
  if (dejaSplit.length > 0) return false;

  // Split à 100 % du montant (abs ; le signe vit sur la transaction). source=RULE
  // + rule_id renseigné → respecte le CHECK de cohérence du schéma.
  await tx.insert(transactionCategorizations).values({
    workspaceId: ctx.workspaceId,
    transactionId: c.id,
    transactionDate: c.transactionDate,
    categoryId: regle.categoryId,
    amount: c.amountAbs,
    source: "RULE",
    ruleId: regle.id,
    createdBy: ctx.userId,
  });

  // Audit append-only (source unique). CREATE / source=RULE.
  await ecrireAudit(tx, ctx, {
    transactionId: c.id,
    transactionDate: c.transactionDate,
    action: "CREATE",
    categoryId: regle.categoryId,
    amount: c.amountAbs,
    source: "RULE",
  });

  return true;
}
