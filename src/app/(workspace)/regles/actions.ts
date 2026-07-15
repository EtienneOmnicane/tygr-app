"use server";

/**
 * Server Actions du moteur de règles de catégorisation. Surface d'appel UI
 * par-dessus le repository scopé `@/server/repositories/regles-categorisation`
 * (importé via le barrel @/server/db — frontière P0-a). Elles câblent session +
 * withWorkspace ; elles ne touchent jamais la DB directement.
 *
 * Retour normalisé `ResultatAction` (jamais d'exception propagée au client) : on
 * mappe les erreurs nommées en { ok:false, code, message } non-énumérant.
 *
 * Exit-criteria (CLAUDE.md règle 3) :
 * - Authz : withWorkspace (membership re-validée à chaque requête). Le CRUD est OUVERT
 *   aux membres (cohérent avec le CRUD de catégories, décision PO 2026-06-17) — la RLS
 *   WITH CHECK workspace suffit. `appliquerRegles` ÉCRIT des splits en masse → réservé
 *   MANAGER/ADMIN (garde peutModifier dans la transaction, calquée sur l'ingestion/synchro).
 * - Périmètre (TOOLBAR-PERIMETRE-AMPUTATION1) : `/regles` est une surface de GESTION
 *   tenant-wide → les ÉCRITURES (créer/modifier/archiver/réordonner/ré-analyser) tournent
 *   sur `exigerSessionSansPerimetre` (session amputée du viewFilter). Seule
 *   `appliquerRegles` est RÉELLEMENT distordue par un filtre résiduel (INNER JOIN
 *   bank_accounts → ré-analyse partielle) ; les 4 autres écritures ne touchent que
 *   `categorization_rules` (workspace-global) → amputation NO-OP, adoptée par uniformité.
 *   La LECTURE `listerReglesAction` reste sur `exigerSessionWorkspace` : elle ne lit que
 *   des règles workspace-global, immunes au viewFilter — rien à amputer (carve-out brief).
 * - Validation Zod stricte (motif, énum, uuid, bornes).
 * - workspace_id JAMAIS un paramètre client (vient de ctx).
 * - Logs corrélés (workspace_id + code), SANS PII (jamais le motif ni un libellé).
 */
import { peutModifier } from "@/lib/permissions";
import {
  exigerSessionSansPerimetre,
  exigerSessionWorkspace,
  ServiceIndisponibleError,
} from "@/server/auth/session";
import {
  CategorieIntrouvableError,
  OrdreReglesInvalideError,
  RegleIntrouvableError,
  RegleNonAutoriseeError,
  type ResultatApplication,
  appliquerRegles,
  archiverRegle,
  creerRegle,
  listerRegles,
  modifierRegle,
  reordonnerRegles,
  withWorkspace,
} from "@/server/db";
import {
  appliquerReglesSchema,
  archiverRegleSchema,
  creerRegleSchema,
  modifierRegleSchema,
  reordonnerReglesSchema,
} from "@/lib/regles-schema";

/** Résultat normalisé (miroir de `ResultatAction` du contrat UI). */
export type ResultatAction<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/** Règle renvoyée au client. */
export interface RegleDTO {
  id: string;
  pattern: string;
  matchType: "contains" | "starts_with";
  categoryId: string;
  isActive: boolean;
  priority: number;
}

const MSG_PARAMS = "Paramètres invalides.";

/** Levée applicative quand l'action exige MANAGER/ADMIN et que le rôle est VIEWER. */
class RoleInsuffisantError extends Error {
  readonly code = "FORBIDDEN_ROLE";
  constructor() {
    super("Action réservée aux gestionnaires.");
    this.name = "RoleInsuffisantError";
  }
}

/**
 * Mappe une erreur en ResultatAction non-énumérant + log corrélé sûr (sans PII).
 * Codes machine stables pour le mapping UI.
 */
function echec(
  erreur: unknown,
  workspaceId: string,
  action: string,
): { ok: false; code: string; message: string } {
  let code = "ERREUR";
  let message = "L’opération a échoué. Réessayez.";
  if (erreur instanceof RegleIntrouvableError) {
    code = erreur.code; // RULE_NOT_FOUND
    message = "Règle introuvable.";
  } else if (erreur instanceof CategorieIntrouvableError) {
    code = erreur.code; // CATEGORY_NOT_FOUND
    message = "Catégorie introuvable.";
  } else if (erreur instanceof OrdreReglesInvalideError) {
    code = erreur.code; // RULES_ORDER_MISMATCH
    message = "L’ordre des règles a changé. Rechargez la page.";
  } else if (
    erreur instanceof RoleInsuffisantError ||
    erreur instanceof RegleNonAutoriseeError
  ) {
    code = erreur.code; // FORBIDDEN_ROLE
    message = "Action réservée aux gestionnaires.";
  } else if (erreur instanceof ServiceIndisponibleError) {
    code = "SERVICE_UNAVAILABLE";
    message = "Service momentanément indisponible.";
  }
  console.warn(
    JSON.stringify({ evt: "regles_echec", action, workspaceId, code }),
  );
  return { ok: false, code, message };
}

/** Lecture des règles du workspace (toutes par défaut ; actives uniquement si demandé). */
export async function listerReglesAction(opts?: {
  actives?: boolean;
}): Promise<RegleDTO[]> {
  const session = await exigerSessionWorkspace();
  const lignes = await withWorkspace(session, (tx, ctx) =>
    listerRegles(tx, ctx, { actives: opts?.actives }),
  );
  return lignes as RegleDTO[];
}

/** Crée une règle (motif + stratégie + catégorie cible). */
export async function creerRegleAction(input: {
  pattern: string;
  matchType: "contains" | "starts_with";
  categoryId: string;
  priority?: number;
}): Promise<ResultatAction<{ ruleId: string }>> {
  const session = await exigerSessionSansPerimetre();
  const parsed = creerRegleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    // Garde de rôle (VIEWER refusé) portée par le repository `creerRegle`
    // (RegleNonAutoriseeError) — testable sous RLS, cf. repo.
    const r = await withWorkspace(session, (tx, ctx) =>
      creerRegle(tx, ctx, parsed.data),
    );
    return { ok: true, data: r };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "creer-regle");
  }
}

/** Modifie une règle (champs partiels). */
export async function modifierRegleAction(input: {
  ruleId: string;
  pattern?: string;
  matchType?: "contains" | "starts_with";
  categoryId?: string;
  priority?: number;
  isActive?: boolean;
}): Promise<ResultatAction> {
  const session = await exigerSessionSansPerimetre();
  const parsed = modifierRegleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    // Garde de rôle portée par le repository `modifierRegle` (cf. créer).
    await withWorkspace(session, (tx, ctx) =>
      modifierRegle(tx, ctx, parsed.data),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "modifier-regle");
  }
}

/** Archive une règle (is_active=false) — cesse d'être appliquée, subsiste. */
export async function archiverRegleAction(
  ruleId: string,
): Promise<ResultatAction> {
  const session = await exigerSessionSansPerimetre();
  const parsed = archiverRegleSchema.safeParse({ ruleId });
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    // Garde de rôle portée par le repository `archiverRegle` (cf. créer).
    await withWorkspace(session, (tx, ctx) =>
      archiverRegle(tx, ctx, parsed.data.ruleId),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "archiver-regle");
  }
}

/**
 * Applique les règles aux transactions non catégorisées (déclenchement manuel
 * « Ré-analyser »). RÉSERVÉ MANAGER/ADMIN : la garde peutModifier est posée DANS
 * la transaction (le rôle vient de ctx, re-résolu à chaque requête) — un VIEWER
 * obtient FORBIDDEN_ROLE avant toute écriture.
 */
export async function appliquerReglesAction(opts?: {
  bankAccountId?: string;
}): Promise<ResultatAction<ResultatApplication>> {
  // ⭐ Session AMPUTÉE du viewFilter (TOOLBAR-PERIMETRE-AMPUTATION1). C'est LE chemin
  // réellement distordu par le filtre : `appliquerRegles` fait un INNER JOIN sur
  // bank_accounts (repo) → sous un viewFilter actif, la sélection des candidats est
  // rétrécie aux comptes filtrés et « Ré-analyser » ne recatégorise qu'une fraction du
  // groupe (le FM croit avoir tout ré-analysé). Amputé, il porte sur tout le tenant —
  // c'est l'intention. La RLS reste la garde (droits durs entity/account conservés).
  const session = await exigerSessionSansPerimetre();
  const parsed = appliquerReglesSchema.safeParse(opts ?? {});
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    const r = await withWorkspace(session, (tx, ctx) => {
      if (!peutModifier(ctx.role)) throw new RoleInsuffisantError();
      return appliquerRegles(tx, ctx, parsed.data);
    });
    return { ok: true, data: r };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "appliquer-regles");
  }
}

/**
 * Réordonne les règles ACTIVES (drag/flèches) : `ordre` = liste des ruleId dans le
 * nouvel ordre visuel → priority = index. Écriture de GOUVERNANCE réservée
 * MANAGER/ADMIN (garde peutModifier DANS la transaction, comme appliquerRegles). Le
 * repository exige que `ordre` soit exactement l'ensemble des règles actives du
 * workspace (égalité d'ensembles, anti-IDOR) → sinon RULES_ORDER_MISMATCH.
 */
export async function reordonnerReglesAction(input: {
  ordre: string[];
}): Promise<ResultatAction> {
  const session = await exigerSessionSansPerimetre();
  const parsed = reordonnerReglesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PARAMS", message: MSG_PARAMS };
  }
  try {
    // Garde de gouvernance (MANAGER/ADMIN) + égalité d'ensembles portées par le
    // repository `reordonnerRegles` (RegleNonAutoriseeError / OrdreReglesInvalideError).
    await withWorkspace(session, (tx, ctx) =>
      reordonnerRegles(tx, ctx, parsed.data.ordre),
    );
    return { ok: true, data: undefined };
  } catch (erreur) {
    return echec(erreur, session.activeWorkspaceId, "reordonner-regles");
  }
}
