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
import { and, asc, eq, isNotNull, lte, notInArray, or } from "drizzle-orm";
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
import {
  STATUTS_TERMINAUX,
  ajouterJours,
  expanserOccurrences,
} from "@/lib/echeances-recurrence";
import {
  ZERO_CENTIMES,
  depuisCentimes,
  enCentimes,
} from "@/lib/montant-centimes";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Fenêtres d'horizon de la synthèse (jours). Constantes figées (jamais une entrée). */
const HORIZONS = [30, 60, 90] as const;
export type HorizonJours = (typeof HORIZONS)[number];

/**
 * Statuts TERMINAUX : la TÊTE ne pèse plus sur la trésorerie.
 * ⚠️ Depuis C0 (D1 « gabarit + tête »), un statut terminal n'éteint QUE la tête —
 * les occurrences FUTURES d'une récurrente restent projetées. La règle vit dans le
 * moteur pur (source unique) ; on la ré-exporte pour l'API publique du repository.
 */
export { STATUTS_TERMINAUX };

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

/**
 * Levée quand la date de référence de la synthèse n'est pas un `YYYY-MM-DD` valide
 * (l'ancien SQL `${aujourdhui}::date` échouait côté base ; on refuse désormais AVANT
 * la requête). Fail-loud : jamais de repli silencieux sur une date inventée.
 */
export class DateReferenceInvalideError extends Error {
  readonly code = "REFERENCE_DATE_INVALID";
  constructor() {
    super("Date de référence invalide.");
    this.name = "DateReferenceInvalideError";
  }
}

/**
 * Levée si le moteur d'expansion émet un montant illisible — invariant de code violé
 * (il n'émet que des chaînes décimales positives bien formées). Bruyant plutôt que
 * silencieux : avaler ce cas fausserait un total sans que rien ne le signale.
 */
export class MontantProjeteInvalideError extends Error {
  readonly code = "PROJECTED_AMOUNT_INVALID";
  constructor() {
    super("Montant projeté invalide.");
    this.name = "MontantProjeteInvalideError";
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
 * Synthèse par HORIZON (30/60/90 j) et par DEVISE des montants RESTANT dus, **occurrences
 * récurrentes COMPRISES** (C0 — `PLAN-conception-previsionnel-C.md`).
 *
 * ## Ce que ce calcul corrige
 *
 * Le champ `recurrence` était STOCKÉ mais JAMAIS LU : chaque échéance était comptée UNE
 * fois, à sa date stockée. Une mensuelle de 10 000 affichait 10 000 à plat sur 30/60/90 j
 * au lieu de 10 000 / 20 000 / 30 000 — l'écran SOUS-ESTIMAIT tout engagement récurrent.
 * L'expansion des occurrences est désormais déléguée au moteur pur `expanserOccurrences`.
 *
 * ## Sémantique (cadrage §3.2, inchangée) + D1
 *
 * L'horizon N capte tout ce qui pèsera sur la trésorerie d'ici N jours — Y COMPRIS les
 * échéances DÉJÀ EN RETARD (**pas de borne basse** : une dette exigible hier reste due).
 * Le RESTANT (`montant − coalesce(montant_regle, 0)`) projette la part encore à
 * mouvementer d'un règlement partiel.
 * ⚠️ D1 « gabarit + tête » : `payee`/`annulee` n'excluent QUE la tête — les occurrences
 * futures d'une récurrente restent dues (fin de l'optimisme silencieux).
 *
 * ## Pourquoi l'agrégation quitte le SQL
 *
 * La règle de récurrence (clamp de quantième, tête vs dérivée) est le cœur du lot et son
 * principal risque de bug : elle doit vivre dans une fonction PURE testable unitairement,
 * pas dans du SQL. On rapatrie donc les échéances CANDIDATES (volume borné : registre
 * MANUEL, jamais `transactions_cache`) et on agrège en TS — en **centimes entiers BigInt**
 * (règle 8, aucun float ; `@/lib/montant-centimes`). Écart assumé au « agrégats en SQL »
 * historique, tracé en revue.
 *
 * Isolation INCHANGÉE : RLS tenant + `entity_scope` via `tx` (`withWorkspace`), plus le
 * filtre explicite `workspace_id` en défense en profondeur. Aucune valeur interpolée
 * (paramètres liés uniquement). JAMAIS d'addition cross-devise : agrégation PAR devise.
 *
 * `opts.aujourdhui` (YYYY-MM-DD) injectable pour des tests déterministes ; défaut = date
 * courante à Maurice (E20 — le fuseau est posé ICI, une fois, jamais dans le moteur).
 */
export async function synthetiserHorizon<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  opts: { aujourdhui?: string } = {},
): Promise<SyntheseEcheances> {
  const aujourdhui = opts.aujourdhui ?? dateCouranteMaurice();

  // Bornes hautes des horizons, calculées UNE fois (arithmétique pure, sans `Date`).
  const bornes = HORIZONS.map((jours) => {
    const fin = ajouterJours(aujourdhui, jours);
    if (fin === null) throw new DateReferenceInvalideError();
    return { jours, fin };
  });
  // La plus lointaine borne le rapatriement : une occurrence est TOUJOURS ≥ sa tête,
  // donc une échéance dont la tête dépasse l'horizon max n'a aucune occurrence utile.
  const finMax = bornes[bornes.length - 1].fin;

  const candidates = await tx
    .select({
      id: echeances.id,
      direction: echeances.direction,
      montant: echeances.montant,
      montantRegle: echeances.montantRegle,
      devise: echeances.devise,
      dateEcheance: echeances.dateEcheance,
      statut: echeances.statut,
      recurrence: echeances.recurrence,
    })
    .from(echeances)
    .where(
      and(
        eq(echeances.workspaceId, ctx.workspaceId),
        lte(echeances.dateEcheance, finMax),
        // ⚠️ Une récurrente TERMINALE reste candidate : sa tête est éteinte, mais ses
        // occurrences futures sont dues (D1). Filtrer `statut NOT IN (...)` seul —
        // l'ancien comportement — ré-introduirait exactement l'optimisme silencieux.
        or(
          notInArray(echeances.statut, [...STATUTS_TERMINAUX]),
          isNotNull(echeances.recurrence),
        ),
      ),
    );

  return bornes.map(({ jours, fin }) => {
    // Agrégation par devise, en centimes entiers. `Map` → une devise n'apparaît que si
    // elle porte au moins une occurrence dans l'horizon (identique au GROUP BY SQL).
    const parDevise = new Map<string, { enc: bigint; dec: bigint }>();

    for (const candidate of candidates) {
      // `deriveesDepuis: aujourdhui` — la TÊTE garde son retard (statut explicite), mais
      // une occurrence DÉRIVÉE passée n'a aucun statut : rien ne dit si elle a été réglée.
      // Sans cette borne, un gabarit mensuel vieux d'un an compterait 13 loyers dans
      // l'horizon 30 j, +1 chaque mois (décision Etienne 2026-07-17, cross-review).
      for (const occ of expanserOccurrences(candidate, {
        fin,
        deriveesDepuis: aujourdhui,
      })) {
        const centimes = enCentimes(occ.montant);
        // Invariant : le moteur n'émet que des montants positifs bien formés. Une
        // violation est un défaut de code, pas une donnée à avaler en silence.
        if (centimes === null) throw new MontantProjeteInvalideError();

        const acc = parDevise.get(occ.devise) ?? {
          enc: ZERO_CENTIMES,
          dec: ZERO_CENTIMES,
        };
        if (occ.direction === "encaissement") acc.enc += centimes;
        else acc.dec += centimes;
        parDevise.set(occ.devise, acc);
      }
    }

    const lignes: SyntheseHorizonDevise[] = [...parDevise.entries()]
      // Tri par devise : reprend l'`ORDER BY devise` du SQL (sortie stable).
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([devise, { enc, dec }]) => ({
        devise,
        encaissement: depuisCentimes(enc),
        decaissement: depuisCentimes(dec),
        // Net = encaissement − décaissement, EN CENTIMES (jamais sur les chaînes).
        net: depuisCentimes(enc - dec),
      }));

    return { jours, lignes };
  });
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
