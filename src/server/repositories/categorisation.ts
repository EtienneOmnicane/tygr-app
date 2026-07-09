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
// Référentiel STANDARD + clé de verrou partagés avec le seed CLI
// (scripts/seed-categories-lib.mjs) et le test d'isolation — source de vérité
// UNIQUE (QA-ONBOARD-CATEG1, règle 9 : pas de dérive script/app/test).
import {
  PREFIXE_VERROU_SEED_CATEGORIES,
  REFERENTIEL_CATEGORIES,
} from "@/lib/categories-referentiel.mjs";

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

/**
 * Levée quand l'état cible de ventilation contient DEUX parts sur la MÊME
 * catégorie (TX-QA-SPLIT-DOUBLON1). Décision produit 2026-07-01 : on INTERDIT à
 * la validation (pas de fusion des montants) — deux parts sur la même catégorie
 * n'ont aucun sens métier (elles faussent tout regroupement par catégorie). La
 * garde vit dans `remplacerSplits` (état cible complet) et non `ajouterSplit` :
 * la règle porte sur l'ensemble cible, pas sur une part isolée. Contrainte
 * d'INTÉGRITÉ de ventilation, distincte de l'invariant de somme.
 */
export class CategorieDupliqueeError extends Error {
  readonly code = "CATEGORY_DUPLICATE_IN_SPLIT";
  constructor() {
    super("Une même catégorie est utilisée sur plusieurs parts de la ventilation.");
    this.name = "CategorieDupliqueeError";
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

export interface EvenementAudit {
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
 *
 * Exporté pour que le moteur de règles (regles-categorisation.ts) écrive l'audit
 * par la MÊME source unique (un split RULE produit un événement CREATE/source=RULE).
 */
export async function ecrireAudit<TDb extends AnyPgDatabase>(
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

/* ------------------------------------------------------------------ */
/* remplacerSplits — opération ATOMIQUE « tout-ou-rien » (état cible)  */
/* ------------------------------------------------------------------ */

/** Un split cible (l'UI envoie l'état complet souhaité ; toujours MANUEL ici). */
export interface SplitCible {
  categoryId: string;
  amount: string; // chaîne décimale > 0
}

/**
 * Remplace ATOMIQUEMENT TOUS les splits d'une transaction par l'état cible.
 * Tout-ou-rien : on s'exécute DANS la transaction SQL de `withWorkspace`, donc
 * toute exception (dépassement, FK invalide) provoque un ROLLBACK complet —
 * jamais d'état partiel. Étapes :
 *   1. Verrou FOR UPDATE sur la ligne transactions_cache (sérialise les éditions
 *      concurrentes ; conflit-avec-soi, cf. ajouterSplit — PAS FOR SHARE).
 *   2. Re-valider côté serveur : Σ |amount cible| ≤ |montant txn| (le client
 *      pré-valide mais le serveur juge).
 *   3. DELETE des splits existants + INSERT des cibles (mêmes transaction).
 *   4. Audit : un DELETE par ancien split, un CREATE par nouveau.
 * Les splits posés sont toujours MANUAL (l'UI ne crée pas de RULE).
 */
export async function remplacerSplits<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  ref: RefTransaction,
  cibles: SplitCible[],
): Promise<{ remplaces: number }> {
  // 1. Montant absolu de la transaction + VERROU de sérialisation (FOR UPDATE).
  const txn = await tx
    .select({ amountAbs: sql<string>`abs(${transactionsCache.amount})` })
    .from(transactionsCache)
    .where(
      and(
        eq(transactionsCache.id, ref.transactionId),
        eq(transactionsCache.transactionDate, ref.transactionDate),
      ),
    )
    .limit(1)
    .for("update");
  if (txn.length === 0) {
    throw new TransactionIntrouvableError();
  }

  // 1bis. INTÉGRITÉ de ventilation : aucune catégorie en double dans l'état cible
  //   (TX-QA-SPLIT-DOUBLON1). VÉRIFIÉE AVANT l'invariant de somme (décision
  //   verrouillée « doublon d'abord ») : un payload violant les DEUX règles (somme
  //   dépassée ET doublon) lève CategorieDupliqueeError, jamais VentilationDepasseError
  //   — l'ordre est verrouillé par un test dédié. Détection PURE sur categoryId (aucune
  //   requête, ne touche pas aux montants — règle 8) : un Set dédoublonne, si sa taille
  //   diffère du nombre de cibles, une catégorie apparaît ≥ 2 fois. Liste vide/une part
  //   ne peuvent pas produire de doublon (garde inactive). Les catégories sont ici
  //   toujours définies (SplitCible.categoryId est non-null ; le null n'atteint pas
  //   cette couche).
  const idsCibles = cibles.map((c) => c.categoryId);
  if (new Set(idsCibles).size !== idsCibles.length) {
    throw new CategorieDupliqueeError();
  }

  // 2. Invariant sur l'ÉTAT CIBLE complet : Σ |amount| ≤ |montant txn|. Somme
  //    calculée en numeric côté SQL (pas de float). Montants PARAMÉTRÉS (jamais
  //    interpolés — anti-injection, bien que Zod les ait déjà bornés en amont).
  //    Liste vide = tout dé-catégoriser (somme 0 ≤ montant, autorisé).
  if (cibles.length > 0) {
    const sommeCible = cibles
      .map((c) => sql`${c.amount}::numeric`)
      .reduce((acc, cur) => sql`${acc} + ${cur}`);
    const ok = await tx
      .select({
        valide: sql<boolean>`(${sommeCible}) <= ${txn[0].amountAbs}::numeric`,
      })
      .from(sql`(select 1) as _`);
    if (!ok[0]?.valide) {
      throw new VentilationDepasseError();
    }
  }

  // 3. DELETE des splits existants (on récupère leur snapshot pour l'audit),
  //    puis INSERT des cibles — dans la MÊME transaction (atomique).
  const anciens = await tx
    .delete(transactionCategorizations)
    .where(
      and(
        eq(transactionCategorizations.transactionId, ref.transactionId),
        eq(transactionCategorizations.transactionDate, ref.transactionDate),
      ),
    )
    .returning({
      categoryId: transactionCategorizations.categoryId,
      amount: transactionCategorizations.amount,
      source: transactionCategorizations.source,
    });

  for (const a of anciens) {
    await ecrireAudit(tx, ctx, {
      transactionId: ref.transactionId,
      transactionDate: ref.transactionDate,
      action: "DELETE",
      categoryId: a.categoryId,
      amount: a.amount,
      source: a.source as CategorizationSource,
    });
  }

  for (const c of cibles) {
    await tx.insert(transactionCategorizations).values({
      workspaceId: ctx.workspaceId,
      transactionId: ref.transactionId,
      transactionDate: ref.transactionDate,
      categoryId: c.categoryId,
      amount: c.amount,
      source: "MANUAL",
      ruleId: null,
      createdBy: ctx.userId,
    });
    await ecrireAudit(tx, ctx, {
      transactionId: ref.transactionId,
      transactionDate: ref.transactionDate,
      action: "CREATE",
      categoryId: c.categoryId,
      amount: c.amount,
      source: "MANUAL",
    });
  }

  return { remplaces: cibles.length };
}

/* ------------------------------------------------------------------ */
/* Référentiel de catégories (CRUD) — scopé workspace, jamais de DELETE */
/* ------------------------------------------------------------------ */

export interface CategorieLue {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
}

/** Levée quand la catégorie visée n'existe pas dans le workspace courant. */
export class CategorieIntrouvableError extends Error {
  readonly code = "CATEGORY_NOT_FOUND";
  constructor() {
    super("Catégorie introuvable.");
    this.name = "CategorieIntrouvableError";
  }
}

/**
 * Levée quand une MUTATION du référentiel (créer/renommer/archiver une catégorie)
 * est tentée par un non-ADMIN. Décision PO 2026-06-22 (révision de 2026-06-17) :
 * administrer la taxonomie est réservé à l'ADMIN. La garde est portée par le
 * REPOSITORY (calque sur entites.ts) : le rôle vient du CONTEXTE (re-résolu à
 * chaque requête par withWorkspace), jamais d'un paramètre — et TOUT chemin
 * d'écriture (Server Action présente ou future) hérite de la garde, pas seulement
 * l'action d'aujourd'hui. Non-énumérant.
 */
export class CategorieNonAutoriseeError extends Error {
  readonly code = "CATEGORY_NOT_AUTHORIZED";
  constructor() {
    super("Action non autorisée.");
    this.name = "CategorieNonAutoriseeError";
  }
}

/**
 * Levée quand une catégorie de MÊME nom (insensible à la casse) existe déjà au
 * MÊME niveau (même parent effectif) dans le workspace (FB0709-CAT-DOUBLONS1).
 *
 * DEUX gardes complémentaires, à ne pas confondre :
 *  (1) applicative — CETTE erreur, levée AVANT l'INSERT/UPDATE : elle permet un
 *      message UI clair (« Cette catégorie existe déjà ») plutôt qu'une violation
 *      de contrainte brute, et couvre le cas casse (« VAT » vs « vat ») que
 *      l'ancien UNIQUE (sensible à la casse) laissait passer ;
 *  (2) structurelle — l'index unique fonctionnel `(workspace_id, LOWER(name),
 *      COALESCE(parent_id, 0-uuid))` (migration 0020) : dernier rempart contre une
 *      COURSE (deux créations concurrentes passent le check applicatif puis
 *      insèrent) — la 2ᵉ échoue sur l'index. La garde applicative NE remplace PAS
 *      l'index ; elle le double pour l'ergonomie. Non-énumérant.
 */
export class CategorieDejaExisteError extends Error {
  readonly code = "CATEGORIE_DEJA_EXISTANTE";
  constructor() {
    super("Une catégorie de même nom existe déjà à ce niveau.");
    this.name = "CategorieDejaExisteError";
  }
}

/** UUID « zéro » : parent effectif d'une Nature racine (parent_id NULL). Doit être
 * IDENTIQUE à la sentinelle COALESCE de l'index unique fonctionnel (migration 0020),
 * sinon la garde applicative et l'index divergeraient sur le cas parent NULL. */
const PARENT_RACINE_SENTINELLE = "00000000-0000-0000-0000-000000000000";

/**
 * Extrait le SQLSTATE Postgres d'une erreur (5 caractères, ex. « 23505 »), en
 * remontant la chaîne de `cause`. Calque exact de `entites.ts` (pattern projet) :
 * on ignore les `code` applicatifs de nos propres erreurs (chaînes nommées comme
 * CATEGORIE_DEJA_EXISTANTE). Sert à traduire une violation d'unicité de COURSE
 * (deux créations concurrentes passent le pré-check applicatif puis insèrent → la
 * 2ᵉ heurte l'index 0020) en erreur NOMMÉE plutôt qu'un 23505 brut non mappé.
 */
function codePg(e: unknown): string | undefined {
  let cur: unknown = e;
  while (cur instanceof Error) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Vrai s'il existe DÉJÀ une catégorie de même nom (insensible à la casse ET aux
 * accents — cohérent avec la recherche du picker, `toLocaleLowerCase("fr")`… mais
 * ici en SQL via `lower()`) au MÊME niveau (même parent effectif) dans le
 * workspace courant. `exclureId` retire une catégorie du test (renommage : ne pas
 * se heurter à soi-même). Scopé RLS + filtre explicite workspace_id.
 *
 * NB casse/accents : `lower()` de PostgreSQL est sensible à la locale du serveur
 * pour les accents ; l'unicité VISÉE porte sur la casse (le doublon « VAT »/« vat »
 * d'Etienne), pas sur les accents — un « Frais » vs « Frais » accentué reste
 * distinct, ce qui est le comportement attendu (deux libellés réellement
 * différents). L'index fonctionnel 0020 emploie le MÊME `lower()` → cohérence
 * garantie entre la garde applicative et la contrainte.
 */
async function existeCategorieMemeNom<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  name: string,
  parentId: string | null,
  exclureId?: string,
): Promise<boolean> {
  const parentEffectif = sql`coalesce(${categories.parentId}, ${PARENT_RACINE_SENTINELLE})`;
  const conditions = [
    eq(categories.workspaceId, ctx.workspaceId),
    sql`lower(${categories.name}) = lower(${name})`,
    sql`${parentEffectif} = coalesce(${parentId}::uuid, ${PARENT_RACINE_SENTINELLE})`,
  ];
  if (exclureId !== undefined) {
    conditions.push(sql`${categories.id} <> ${exclureId}::uuid`);
  }
  const rows = await tx
    .select({ un: sql<number>`1` })
    .from(categories)
    .where(and(...conditions))
    .limit(1);
  return rows.length > 0;
}

/**
 * Exige le rôle ADMIN pour muter le référentiel. La LECTURE (listerCategories)
 * reste ouverte à tous les membres : les pickers de ventilation en ont besoin
 * (la saisie de splits demeure ouverte, seule l'administration est restreinte).
 */
function exigerAdminReferentiel(ctx: WorkspaceContext): void {
  if (ctx.role !== "ADMIN") {
    throw new CategorieNonAutoriseeError();
  }
}

/**
 * Liste les catégories ACTIVES du workspace (les archivées sont masquées des
 * pickers). Scopé par la RLS au workspace courant. Triées par nom.
 */
export async function listerCategories<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
): Promise<CategorieLue[]> {
  const lignes = await tx
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      isActive: categories.isActive,
    })
    .from(categories)
    // RLS scope déjà au workspace ; on filtre AUSSI explicitement sur
    // workspace_id (défense en profondeur) + actives uniquement.
    .where(
      and(
        eq(categories.workspaceId, ctx.workspaceId),
        eq(categories.isActive, true),
      ),
    )
    .orderBy(categories.name);
  return lignes as CategorieLue[];
}

/**
 * Crée une catégorie (Nature si parentId nul, sinon Sous-nature). Le WITH CHECK
 * RLS garantit le bon workspace ; la FK parent COMPOSITE garantit qu'un parentId
 * appartient au MÊME workspace (impossible de rattacher à un autre tenant).
 */
export async function creerCategorie<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  input: { name: string; parentId: string | null },
): Promise<{ categoryId: string }> {
  exigerAdminReferentiel(ctx);
  // Rejet insensible à la casse AVANT insert (FB0709-CAT-DOUBLONS1) : message UI
  // clair au lieu d'une violation de contrainte brute.
  if (await existeCategorieMemeNom(tx, ctx, input.name, input.parentId)) {
    throw new CategorieDejaExisteError();
  }
  try {
    const inserted = await tx
      .insert(categories)
      .values({
        workspaceId: ctx.workspaceId,
        name: input.name,
        parentId: input.parentId,
      })
      .returning({ id: categories.id });
    return { categoryId: inserted[0].id };
  } catch (e) {
    // COURSE : deux créations concurrentes passent le pré-check puis insèrent → la
    // 2ᵉ heurte l'index unique fonctionnel 0020 (23505). On traduit en erreur
    // NOMMÉE (message UI « Cette catégorie existe déjà ») au lieu d'un 23505 brut
    // qui retomberait dans le catch-all générique de l'action (pattern entites.ts).
    if (codePg(e) === "23505") throw new CategorieDejaExisteError();
    throw e;
  }
}

/**
 * Renomme une catégorie du workspace courant. La RLS scope la mise à jour ;
 * une catégorie d'un autre tenant → 0 ligne → CategorieIntrouvableError.
 */
export async function renommerCategorie<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  input: { categoryId: string; name: string },
): Promise<void> {
  // Rôle AVANT existence : un non-ADMIN obtient « non autorisé » même sur une
  // catégorie inexistante → pas d'oracle d'existence (règle 3).
  exigerAdminReferentiel(ctx);

  // Le parent effectif de la catégorie renommée détermine le NIVEAU où l'unicité
  // s'apprécie (le renommage ne déplace pas la catégorie). On le lit sous RLS ;
  // absence de ligne = catégorie introuvable (autre tenant ou inexistante).
  const cible = await tx
    .select({ parentId: categories.parentId })
    .from(categories)
    .where(
      and(
        eq(categories.id, input.categoryId),
        eq(categories.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);
  if (cible.length === 0) {
    throw new CategorieIntrouvableError();
  }

  // Rejet insensible à la casse AVANT update (FB0709-CAT-DOUBLONS1), en s'excluant
  // soi-même (renommer « VAT » en « vat » — même catégorie — ne doit pas être bloqué).
  if (
    await existeCategorieMemeNom(
      tx,
      ctx,
      input.name,
      cible[0].parentId,
      input.categoryId,
    )
  ) {
    throw new CategorieDejaExisteError();
  }

  let maj;
  try {
    maj = await tx
      .update(categories)
      .set({ name: input.name })
      // RLS + filtre explicite workspace_id (défense en profondeur).
      .where(
        and(
          eq(categories.id, input.categoryId),
          eq(categories.workspaceId, ctx.workspaceId),
        ),
      )
      .returning({ id: categories.id });
  } catch (e) {
    // COURSE (cf. creerCategorie) : un renommage concurrent vers le même nom heurte
    // l'index 0020 → 23505 traduit en erreur nommée plutôt qu'un brut non mappé.
    if (codePg(e) === "23505") throw new CategorieDejaExisteError();
    throw e;
  }
  if (maj.length === 0) {
    throw new CategorieIntrouvableError();
  }
}

/**
 * ARCHIVE une catégorie (is_active=false) — JAMAIS de suppression physique : les
 * splits existants qui la référencent doivent rester valides (préservation de
 * l'historique). La catégorie disparaît des pickers (listerCategories filtre
 * is_active=true) mais la ligne subsiste. Idempotent.
 */
export async function archiverCategorie<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  categoryId: string,
): Promise<void> {
  // Rôle AVANT existence (cf. renommerCategorie) — pas d'oracle d'existence.
  exigerAdminReferentiel(ctx);
  const maj = await tx
    .update(categories)
    .set({ isActive: false })
    // RLS + filtre explicite workspace_id (défense en profondeur).
    .where(
      and(
        eq(categories.id, categoryId),
        eq(categories.workspaceId, ctx.workspaceId),
      ),
    )
    .returning({ id: categories.id });
  if (maj.length === 0) {
    throw new CategorieIntrouvableError();
  }
}

/** Résultat de l'import du référentiel standard (CTA d'onboarding). */
export interface ImportReferentiel {
  /** Catégories effectivement INSÉRÉES (0 = workspace déjà pourvu, no-op). */
  imported: number;
  /** État FRAIS des catégories actives du workspace (pour rafraîchir les pickers). */
  categories: CategorieLue[];
}

/**
 * Importe le RÉFÉRENTIEL STANDARD de catégories dans le workspace courant
 * (QA-ONBOARD-CATEG1, CTA « Importer les catégories standard » du picker vide).
 * ADMIN-only, comme tout le CRUD du référentiel (exigerAdminReferentiel) : seul
 * un ADMIN seede la taxonomie. La RLS borne le TENANT ; cette garde borne le
 * RÔLE (défense en profondeur — la RLS ne connaît pas le rôle).
 *
 * IDEMPOTENT : ne fait rien si le workspace a DÉJÀ ≥1 catégorie (active OU
 * archivée) — jamais de doublon, même en re-clic. Renvoie TOUJOURS l'état frais
 * des catégories actives (que l'import ait inséré ou trouvé un référentiel déjà
 * présent) pour que l'UI se rafraîchisse dans les deux cas.
 *
 * MÊME référentiel, MÊME clé de verrou consultatif et MÊME garde d'idempotence
 * que le seed CLI (scripts/seed-categories-lib.mjs) : un CTA et un
 * `npm run seed:categories` concurrents sur le même workspace se SÉRIALISENT sur
 * le verrou, le second retombant sur « déjà pourvu ». Le verrou est
 * indispensable car UNIQUE(workspace_id, name, parent_id) ne protège PAS les
 * Natures (parent_id NULL → NULLs distincts en SQL) : sans lui, deux imports
 * concurrents créeraient des Natures en double.
 */
export async function importerReferentielCategories<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
): Promise<ImportReferentiel> {
  // Rôle AVANT tout accès : un non-ADMIN est refusé sans effet de bord (le
  // verrou et l'INSERT ne sont jamais atteints). Non-énumérant.
  exigerAdminReferentiel(ctx);

  // Verrou consultatif TRANSACTIONNEL — clé = hash(PREFIXE + workspace_id),
  // MÊME préfixe partagé et MÊME calcul que seed-categories-lib.mjs : sérialise
  // CTA×CTA et CTA×seed CLI sur ce workspace. Le workspace_id vient du CONTEXTE
  // serveur (jamais du client) ; on pré-concatène en JS et on passe UNE chaîne
  // PARAMÉTRÉE (drizzle la lie en $1 — zéro interpolation, règle 2).
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${PREFIXE_VERROU_SEED_CATEGORIES + ctx.workspaceId}, 0))`,
  );

  // Idempotence : ≥1 catégorie (active OU archivée) ⇒ no-op. Filtre EXPLICITE
  // workspace_id (défense en profondeur, en plus de la RLS tenant).
  const existantes = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.workspaceId, ctx.workspaceId))
    .limit(1);

  let imported = 0;
  if (existantes.length === 0) {
    for (const groupe of REFERENTIEL_CATEGORIES) {
      // 1. Nature (parent_id NULL). Le WITH CHECK RLS garantit le bon workspace.
      const nature = await tx
        .insert(categories)
        .values({
          workspaceId: ctx.workspaceId,
          name: groupe.nature,
          parentId: null,
        })
        .returning({ id: categories.id });
      imported += 1;

      // 2. Sous-natures rattachées à la Nature DU MÊME workspace : la FK
      //    composite (parent_id, workspace_id) → (id, workspace_id) l'exige.
      for (const sous of groupe.sousNatures) {
        await tx.insert(categories).values({
          workspaceId: ctx.workspaceId,
          name: sous,
          parentId: nature[0].id,
        });
        imported += 1;
      }
    }
  }

  // État FRAIS (actives, triées) — que l'import ait inséré ou trouvé un
  // référentiel déjà présent (course sérialisée par le verrou), l'UI reçoit la
  // liste réelle et peut peupler ses pickers immédiatement.
  const liste = await listerCategories(tx, ctx);
  return { imported, categories: liste };
}
