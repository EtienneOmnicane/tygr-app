/**
 * Repository des ÉCHÉANCES prévisionnelles (Epic 8 · FEAT-8.2 ; cadrage
 * PLAN-cadrage-echeances.md §6). Registre MANUEL de mouvements FUTURS planifiés
 * (encaissements clients / décaissements fournisseurs). Comme tout repository,
 * chaque fonction s'exécute DANS `withWorkspace(session, fn)` : `tx` porte
 * `app.current_workspace_id` (+ `app.current_entity_scope`) → la lecture ET
 * l'écriture sont bornées par les DEUX étages RLS :
 *   • Étage 1 (tenant, dur)   : `tenant_isolation` sur `workspace_id`.
 *   • Étage 2 (entité, scopé)  : `entity_scope` RESTRICTIVE FOR ALL sur `entity_id`.
 * `workspace_id` n'est JAMAIS un paramètre client (règle 2) : il vient de `ctx`.
 *
 * Gouvernance (règle 3) :
 *  - Écriture (créer/modifier/changer statut/supprimer) = MEMBRES (`peutModifier`,
 *    MANAGER/ADMIN), fermée au VIEWER. Garde SERVEUR portée par le repository (donc
 *    testable sous RLS réelle, bloquante en CI), rôle vérifié AVANT existence
 *    (anti-oracle : un VIEWER n'apprend pas si l'échéance existe).
 *  - Le périmètre ENTITÉ est gardé par la RLS (fail-closed), pas par du code .tsx :
 *    un membre scopé ne peut créer/déplacer une échéance HORS de son périmètre
 *    (WITH CHECK → 42501 → EcheanceHorsPerimetreError), ni INSÉRER une échéance
 *    non-rattachée (entity_id NULL) sous Vision Entité.
 *
 * Montants (règle 8) : chaînes décimales, jamais de float. Les agrégats de synthèse
 * sont calculés EN SQL (numeric), sortis en CHAÎNES (`::numeric(15,2)::text`). Le
 * SENS porte le signe (`direction`), `montant` est toujours positif.
 *
 * Fuseau Maurice (E20, CLAUDE.md Localisation) : « en retard » et les fenêtres
 * d'horizon comparent `date_echeance` (date comptable « nue ») à AUJOURD'HUI À
 * MAURICE (`dateCouranteMaurice()`), jamais à une date « nue » sans fuseau posé.
 * `aujourdhui` est injectable pour des tests déterministes.
 *
 * PII (règle 8) : ni `libelle` ni `contrepartie` ne sont journalisés (aucun log ici ;
 * l'action logge un code machine sans PII).
 */
import { and, asc, eq, lte, notInArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { echeances } from "@/server/db/schema";
import type {
  EcheanceDirection,
  EcheanceRecurrence,
  EcheanceStatut,
} from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";
import { peutModifier } from "@/lib/permissions";
import { dateCouranteMaurice } from "@/lib/format-date";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Fenêtres d'horizon de la synthèse (jours). Constantes figées (jamais une entrée). */
const HORIZONS = [30, 60, 90] as const;
export type HorizonJours = (typeof HORIZONS)[number];

/** Statuts TERMINAUX : exclus de la projection (ne pèsent plus sur la trésorerie). */
const STATUTS_TERMINAUX: EcheanceStatut[] = ["payee", "annulee"];

/* ------------------------------------------------------------------ */
/* Types de lecture / écriture                                         */
/* ------------------------------------------------------------------ */

export interface EcheanceLue {
  id: string;
  entityId: string | null;
  direction: EcheanceDirection;
  libelle: string;
  contrepartie: string | null;
  /** Chaîne décimale (règle 8), TOUJOURS positive. */
  montant: string;
  devise: string;
  /** Date comptable « nue » Maurice `YYYY-MM-DD`. */
  dateEcheance: string;
  /** Statut STOCKÉ (ne contient jamais « en_retard »). */
  statut: EcheanceStatut;
  /** Statut d'AFFICHAGE : « en_retard » si dérivé (date passée + non terminal), sinon `statut`. */
  statutAffiche: EcheanceStatut | "en_retard";
  /** Vrai si l'échéance est en retard (dérivé, non stocké — ECH-D5). */
  enRetard: boolean;
  categorieId: string | null;
  recurrence: EcheanceRecurrence | null;
  /** Part déjà réglée (chaîne décimale) ou null. */
  montantRegle: string | null;
}

export interface EcheanceACreer {
  entityId?: string | null;
  direction: EcheanceDirection;
  libelle: string;
  contrepartie?: string | null;
  montant: string;
  devise: string;
  dateEcheance: string;
  categorieId?: string | null;
  recurrence?: EcheanceRecurrence | null;
}

export interface EcheanceAModifier {
  echeanceId: string;
  entityId?: string | null;
  direction?: EcheanceDirection;
  libelle?: string;
  contrepartie?: string | null;
  montant?: string;
  devise?: string;
  dateEcheance?: string;
  categorieId?: string | null;
  recurrence?: EcheanceRecurrence | null;
}

export interface ChangementStatutEcheance {
  echeanceId: string;
  statut: EcheanceStatut;
  montantRegle?: string | null;
}

/** Une ligne de synthèse pour UNE devise et UN horizon (montants restant dus). */
export interface SyntheseHorizonDevise {
  devise: string;
  /** Somme des RESTANTS à encaisser (chaîne décimale). */
  encaissement: string;
  /** Somme des RESTANTS à décaisser (chaîne décimale). */
  decaissement: string;
  /** encaissement − decaissement (chaîne décimale, peut être négative). */
  net: string;
}

export interface SyntheseHorizon {
  jours: HorizonJours;
  lignes: SyntheseHorizonDevise[];
}

export type SyntheseEcheances = SyntheseHorizon[];

/* ------------------------------------------------------------------ */
/* Erreurs nommées (règle 3 — chaque erreur a un code machine)         */
/* ------------------------------------------------------------------ */

/** Levée quand l'échéance visée n'existe pas dans le workspace/périmètre courant. */
export class EcheanceIntrouvableError extends Error {
  readonly code = "ECHEANCE_NOT_FOUND";
  constructor() {
    super("Échéance introuvable.");
    this.name = "EcheanceIntrouvableError";
  }
}

/** Levée quand le rôle courant n'a pas le droit d'écrire (VIEWER). */
export class EcheanceNonAutoriseeError extends Error {
  readonly code = "FORBIDDEN_ROLE";
  constructor() {
    super("Action réservée aux gestionnaires.");
    this.name = "EcheanceNonAutoriseeError";
  }
}

/** Levée quand entity_id ou categorie_id ne référence rien de valide dans le workspace (FK, 23503). */
export class ReferenceEcheanceInvalideError extends Error {
  readonly code = "REFERENCE_NOT_FOUND";
  constructor() {
    super("Entité ou catégorie introuvable dans cet espace.");
    this.name = "ReferenceEcheanceInvalideError";
  }
}

/** Levée quand une création/déplacement cible une entité HORS du périmètre du membre (RLS WITH CHECK, 42501). */
export class EcheanceHorsPerimetreError extends Error {
  readonly code = "ENTITY_OUT_OF_SCOPE";
  constructor() {
    super("Échéance hors de votre périmètre d’entités.");
    this.name = "EcheanceHorsPerimetreError";
  }
}

/** Levée quand `montant_regle` viole [0, montant] (CHECK SQL, 23514). */
export class MontantRegleInvalideError extends Error {
  readonly code = "SETTLED_AMOUNT_INVALID";
  constructor() {
    super("Le montant réglé doit être compris entre 0 et le montant de l’échéance.");
    this.name = "MontantRegleInvalideError";
  }
}

/* ------------------------------------------------------------------ */
/* Helpers internes                                                    */
/* ------------------------------------------------------------------ */

/** Code SQLSTATE Postgres porté par l'erreur driver (via la chaîne des causes). */
function codePg(e: unknown): string | undefined {
  let cur: unknown = e;
  while (cur instanceof Error) {
    const c = (cur as { code?: unknown }).code;
    // Un SQLSTATE fait 5 caractères (ex. 23505) ; on ignore les `code` applicatifs
    // de nos propres erreurs (chaînes nommées comme ECHEANCE_NOT_FOUND).
    if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Dérive « en retard » : date d'échéance STRICTEMENT passée ET statut non terminal.
 * Comparaison lexicographique de deux `YYYY-MM-DD` (équivalente à l'ordre calendaire).
 * `aujourdhui` est la date COURANTE À MAURICE (fuseau posé explicitement en amont).
 */
function estEnRetard(
  statut: EcheanceStatut,
  dateEcheance: string,
  aujourdhui: string,
): boolean {
  return (
    dateEcheance < aujourdhui && !STATUTS_TERMINAUX.includes(statut)
  );
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Liste les échéances du workspace courant (RLS tenant + entity_scope ; filtre
 * explicite `workspace_id` en défense en profondeur). Triées par exigibilité
 * croissante (`date_echeance` asc) puis date de création — les échéances passées
 * (dont les « en retard ») remontent NATURELLEMENT en tête. Le statut d'affichage
 * « en retard » est dérivé côté application (ECH-D5), jamais stocké.
 *
 * `opts.aujourdhui` (YYYY-MM-DD) injectable pour des tests déterministes ; défaut =
 * date courante à Maurice.
 */
export async function listerEcheances<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  opts: { aujourdhui?: string } = {},
): Promise<EcheanceLue[]> {
  const aujourdhui = opts.aujourdhui ?? dateCouranteMaurice();

  const lignes = await tx
    .select({
      id: echeances.id,
      entityId: echeances.entityId,
      direction: echeances.direction,
      libelle: echeances.libelle,
      contrepartie: echeances.contrepartie,
      montant: echeances.montant,
      devise: echeances.devise,
      dateEcheance: echeances.dateEcheance,
      statut: echeances.statut,
      categorieId: echeances.categorieId,
      recurrence: echeances.recurrence,
      montantRegle: echeances.montantRegle,
    })
    .from(echeances)
    .where(eq(echeances.workspaceId, ctx.workspaceId))
    .orderBy(asc(echeances.dateEcheance), asc(echeances.createdAt));

  return lignes.map((l) => {
    const enRetard = estEnRetard(l.statut, l.dateEcheance, aujourdhui);
    return {
      ...l,
      enRetard,
      statutAffiche: enRetard ? ("en_retard" as const) : l.statut,
    };
  });
}

/**
 * Synthèse par HORIZON (30/60/90 j) et par DEVISE des montants RESTANT dus. Pour
 * chaque devise, somme du RESTANT (`montant − coalesce(montant_regle, 0)`) des
 * échéances NON terminales dont `date_echeance <= aujourd'hui + N jours`.
 *
 * Sémantique (cadrage §3.2) : l'horizon N capte tout ce qui pèsera sur la trésorerie
 * d'ici N jours — Y COMPRIS les échéances DÉJÀ EN RETARD (pas de borne basse : une
 * dette exigible hier reste due). `payee`/`annulee` exclues (ne pèsent plus). Le
 * RESTANT (et non le montant plein) projette la part encore à mouvementer d'un
 * règlement partiel.
 *
 * Montants EN SQL (règle 8), sortis en CHAÎNES ; `::numeric(15,2)::text` fige l'échelle
 * à 2 décimales même quand le coalesce tombe sur le littéral 0 (« 0.00 » vs « 0 »).
 * JAMAIS d'addition cross-devise : GROUP BY devise. Aucune valeur d'entrée interpolée
 * (les horizons sont des littéraux figés `HORIZONS` ; `aujourdhui` est un paramètre lié).
 */
export async function synthetiserHorizon<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  opts: { aujourdhui?: string } = {},
): Promise<SyntheseEcheances> {
  const aujourdhui = opts.aujourdhui ?? dateCouranteMaurice();

  // Restant dû : montant plein moins la part déjà réglée (0 si aucune).
  const restant = sql`(${echeances.montant} - coalesce(${echeances.montantRegle}, 0))`;

  const synthese: SyntheseHorizon[] = [];
  for (const jours of HORIZONS) {
    const lignes = await tx
      .select({
        devise: echeances.devise,
        encaissement: sql<string>`coalesce(sum(${restant}) filter (where ${echeances.direction} = 'encaissement'), 0)::numeric(15,2)::text`,
        decaissement: sql<string>`coalesce(sum(${restant}) filter (where ${echeances.direction} = 'decaissement'), 0)::numeric(15,2)::text`,
        net: sql<string>`(
          coalesce(sum(${restant}) filter (where ${echeances.direction} = 'encaissement'), 0)
          - coalesce(sum(${restant}) filter (where ${echeances.direction} = 'decaissement'), 0)
        )::numeric(15,2)::text`,
      })
      .from(echeances)
      .where(
        and(
          eq(echeances.workspaceId, ctx.workspaceId),
          notInArray(echeances.statut, STATUTS_TERMINAUX),
          // Borne haute INCLUSIVE : `date_echeance <= aujourd'hui + N jours`. `jours`
          // est un littéral figé (HORIZONS) → inliné via sql.raw sans risque
          // d'injection ; `aujourdhui` reste un paramètre lié.
          lte(
            echeances.dateEcheance,
            sql`(${aujourdhui}::date + ${sql.raw(String(jours))})`,
          ),
        ),
      )
      .groupBy(echeances.devise)
      .orderBy(echeances.devise);

    synthese.push({ jours, lignes: lignes as SyntheseHorizonDevise[] });
  }

  return synthese;
}

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */

/**
 * Crée une échéance. Le WITH CHECK RLS (tenant + entity_scope) garantit le bon
 * workspace ET le bon périmètre ; les FK COMPOSITES scopées workspace garantissent
 * qu'`entity_id`/`categorie_id` appartiennent au MÊME tenant. Naît « en_cours »,
 * non réglée (défauts base). Retourne l'id créé.
 *
 * Cartographie des échecs base → erreurs nommées : 42501 (WITH CHECK entity_scope,
 * ex. membre scopé créant hors périmètre ou une échéance non-rattachée sous Vision
 * Entité) → EcheanceHorsPerimetreError ; 23503 (FK entité/catégorie) →
 * ReferenceEcheanceInvalideError.
 */
export async function creerEcheance<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  input: EcheanceACreer,
): Promise<{ echeanceId: string }> {
  if (!peutModifier(ctx.role)) throw new EcheanceNonAutoriseeError();

  try {
    const inserted = await tx
      .insert(echeances)
      .values({
        workspaceId: ctx.workspaceId,
        entityId: input.entityId ?? null,
        direction: input.direction,
        libelle: input.libelle,
        contrepartie: input.contrepartie ?? null,
        montant: input.montant,
        devise: input.devise,
        dateEcheance: input.dateEcheance,
        categorieId: input.categorieId ?? null,
        recurrence: input.recurrence ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: echeances.id });
    return { echeanceId: inserted[0].id };
  } catch (e) {
    const code = codePg(e);
    if (code === "42501") throw new EcheanceHorsPerimetreError();
    if (code === "23503") throw new ReferenceEcheanceInvalideError();
    throw e;
  }
}

/**
 * Modifie les champs DESCRIPTIFS d'une échéance (champs partiels ; le cycle de vie
 * passe par `changerStatutEcheance`). La RLS USING scope la mise à jour au
 * workspace/périmètre courant : une échéance d'un autre tenant OU hors périmètre →
 * 0 ligne → EcheanceIntrouvableError. Un DÉPLACEMENT vers une entité hors périmètre
 * → WITH CHECK 42501 → EcheanceHorsPerimetreError. Réduire `montant` sous un
 * `montant_regle` posé → CHECK 23514 → MontantRegleInvalideError.
 *
 * `updatedAt` est bumpé manuellement (le schéma n'a pas de $onUpdate). `entity_id`
 * et `contrepartie` acceptent `null` (dé-rattacher / effacer) ; `undefined` = ne pas
 * toucher (le schéma zod préserve la distinction).
 */
export async function modifierEcheance<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  input: EcheanceAModifier,
): Promise<void> {
  if (!peutModifier(ctx.role)) throw new EcheanceNonAutoriseeError();

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.entityId !== undefined) set.entityId = input.entityId;
  if (input.direction !== undefined) set.direction = input.direction;
  if (input.libelle !== undefined) set.libelle = input.libelle;
  if (input.contrepartie !== undefined) set.contrepartie = input.contrepartie;
  if (input.montant !== undefined) set.montant = input.montant;
  if (input.devise !== undefined) set.devise = input.devise;
  if (input.dateEcheance !== undefined) set.dateEcheance = input.dateEcheance;
  if (input.categorieId !== undefined) set.categorieId = input.categorieId;
  if (input.recurrence !== undefined) set.recurrence = input.recurrence;

  try {
    const maj = await tx
      .update(echeances)
      .set(set)
      .where(
        and(
          eq(echeances.id, input.echeanceId),
          eq(echeances.workspaceId, ctx.workspaceId),
        ),
      )
      .returning({ id: echeances.id });
    if (maj.length === 0) throw new EcheanceIntrouvableError();
  } catch (e) {
    if (e instanceof EcheanceIntrouvableError) throw e;
    const code = codePg(e);
    if (code === "42501") throw new EcheanceHorsPerimetreError();
    if (code === "23503") throw new ReferenceEcheanceInvalideError();
    if (code === "23514") throw new MontantRegleInvalideError();
    throw e;
  }
}

/**
 * Transition de cycle de vie + part réglée. Seul `partiel` porte un `montant_regle`
 * pertinent (fourni, garanti par le schéma zod) ; tout autre statut le remet à NULL
 * (pas de règlement partiel résiduel après « payee »/« annulee »/etc.). La RLS scope
 * au workspace/périmètre (0 ligne → EcheanceIntrouvableError). `montant_regle >
 * montant` → CHECK 23514 → MontantRegleInvalideError. `updatedAt` bumpé manuellement.
 */
export async function changerStatutEcheance<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  input: ChangementStatutEcheance,
): Promise<void> {
  if (!peutModifier(ctx.role)) throw new EcheanceNonAutoriseeError();

  const set: Record<string, unknown> = {
    statut: input.statut,
    montantRegle: input.statut === "partiel" ? input.montantRegle ?? null : null,
    updatedAt: new Date(),
  };

  try {
    const maj = await tx
      .update(echeances)
      .set(set)
      .where(
        and(
          eq(echeances.id, input.echeanceId),
          eq(echeances.workspaceId, ctx.workspaceId),
        ),
      )
      .returning({ id: echeances.id });
    if (maj.length === 0) throw new EcheanceIntrouvableError();
  } catch (e) {
    if (e instanceof EcheanceIntrouvableError) throw e;
    const code = codePg(e);
    if (code === "23514") throw new MontantRegleInvalideError();
    throw e;
  }
}

/**
 * Supprime une échéance (table ÉDITABLE, PAS append-only — ECH-D3, liste blanche
 * DELETE de tygr_app.sql). La RLS scope la suppression au workspace/périmètre : une
 * échéance d'un autre tenant OU hors périmètre → 0 ligne → EcheanceIntrouvableError
 * (404, jamais 403 — pas d'oracle d'existence). Idempotence NON garantie (une
 * seconde suppression lève EcheanceIntrouvableError, ce que l'appelant traduit en 404).
 */
export async function supprimerEcheance<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  echeanceId: string,
): Promise<void> {
  if (!peutModifier(ctx.role)) throw new EcheanceNonAutoriseeError();

  const supp = await tx
    .delete(echeances)
    .where(
      and(
        eq(echeances.id, echeanceId),
        eq(echeances.workspaceId, ctx.workspaceId),
      ),
    )
    .returning({ id: echeances.id });
  if (supp.length === 0) throw new EcheanceIntrouvableError();
}
