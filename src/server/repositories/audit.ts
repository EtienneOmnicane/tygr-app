/**
 * Repository d'audit (Epic 1 / L3.2, PLAN-epic1-auth-consent.md §5.2).
 *
 * SEUL ÉCRIVAIN AUTORISÉ de `consent_records` et `audit_events`. Aucun autre module
 * n'insère dans ces tables : c'est ce qui rend les trois invariants ci-dessous
 * vérifiables en un seul endroit.
 *
 * ┌─ Invariant 1 — APPEND-ONLY STRICT (CLAUDE.md règle 8)
 * │  Ce fichier ne contient QUE des INSERT. Pas d'UPDATE, pas de DELETE, même en
 * │  réparation : une ligne fausse se corrige en écrivant un événement correctif.
 * │  Trois gardes en base l'imposent de toute façon (privilège hors liste blanche,
 * │  trigger BEFORE UPDATE OR DELETE, RLS tenant) — le code s'y conforme, il ne s'y
 * │  substitue pas.
 * │
 * ├─ Invariant 2 — SNAPSHOT AUTO-SUFFISANT (décision Q2, plan §2.4)
 * │  `consent_records` n'a PAS de FK vers `users` ni `bank_connections` (la
 * │  révocation supprime la connexion ; l'offboarding RGPD réécrit `users`). La
 * │  ligne doit donc rester lisible SEULE, pour toujours. Le repository est le SEUL
 * │  endroit qui construit ce snapshot : il LIT l'identité de l'acteur et le nom de
 * │  l'institution dans la MÊME transaction, sous RLS, et les COPIE. Aucun appelant
 * │  ne fournit ces champs — sinon un appelant pourrait falsifier l'identité
 * │  consignée, ce qui viderait l'audit trail de sa valeur probante (BOM Innov8).
 * │  Si l'identité ne se résout pas → `AuditSnapshotIncompletError`, FAIL-CLOSED :
 * │  on n'écrit PAS un consentement anonyme.
 * │
 * └─ Invariant 3 — ZÉRO PII (règle 8)
 *    `scope` et `payload` sont des JSONB libres : c'est le vecteur d'exfiltration le
 *    plus probable du chantier. Chaque `eventType` déclare une LISTE BLANCHE de clés
 *    (schéma zod `.strict()`) ; toute clé inconnue lève `AuditPayloadInvalideError`.
 *    Interdits absolus quel que soit l'événement : libellé bancaire brut, IBAN,
 *    SessionToken, SECRET, mot de passe, montant nominatif. Un `accountId` (UUID
 *    opaque) est autorisé ; un numéro de compte ne l'est pas — d'où `masquerCompte`.
 */
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  auditEvents,
  bankConnections,
  consentRecords,
  users,
} from "@/server/db/schema";
import type { WorkspaceContext, WorkspaceTx } from "@/server/db/tenancy";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/* ══════════════════════════════════════════════════════════════════════════
 * Erreurs nommées (règle 3 : chaque erreur a un nom ; catch-all interdit).
 * Les deux sont des DÉFAUTS SERVEUR (500), jamais déclenchables par une entrée
 * client bien formée, et jamais affichées telles quelles à l'utilisateur : leur
 * message nomme des clés de payload, ce qui renseignerait un attaquant.
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Le payload/scope proposé ne respecte pas la liste blanche de son `eventType`
 * (clé inconnue, type invalide, borne dépassée). Bruyant par conception : c'est un
 * bug d'appelant, pas une donnée utilisateur. Ne JAMAIS l'attraper silencieusement.
 */
export class AuditPayloadInvalideError extends Error {
  readonly code = "AUDIT_PAYLOAD_INVALID";
  constructor(eventType: string, detail: string) {
    super(`Payload d'audit refusé pour « ${eventType} » : ${detail}`);
    this.name = "AuditPayloadInvalideError";
  }
}

/**
 * L'identité de l'acteur n'a pas pu être résolue dans la transaction (utilisateur
 * introuvable, email vide). FAIL-CLOSED : un consentement sans acteur identifiable
 * n'a aucune valeur probante — on refuse d'écrire plutôt que d'écrire « ␀ a
 * consenti ». `granted_by_email` est NOT NULL en base ; cette erreur est la garde
 * applicative qui rend le motif du refus lisible plutôt qu'une violation NOT NULL.
 */
export class AuditSnapshotIncompletError extends Error {
  readonly code = "AUDIT_SNAPSHOT_INCOMPLET";
  constructor(raison: string) {
    super(`Snapshot d'audit incomplet : ${raison}. Écriture refusée (fail-closed).`);
    this.name = "AuditSnapshotIncompletError";
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Liste blanche des payloads, par type d'événement (Invariant 3).
 * ═══════════════════════════════════════════════════════════════════════ */

/** Types d'événements applicatifs émis par TYGR (`omnifi_event_id IS NULL`). */
export const TYPES_EVENEMENT_APPLICATIF = [
  "consent.granted",
  "consent.accounts_selected",
] as const;

export type TypeEvenementApplicatif =
  (typeof TYPES_EVENEMENT_APPLICATIF)[number];

/** Un compte, tel qu'il a le droit d'apparaître dans l'audit : UUID + masque. */
const compteMasqueSchema = z
  .object({
    /** Identifiant opaque Omni-FI. Autorisé : il ne dit rien du numéro de compte. */
    accountId: z.string().min(1).max(64),
    /** Produit de `masquerCompte()` — jamais un numéro, jamais un libellé. */
    masked: z.string().max(16),
  })
  .strict();

/**
 * Un schéma `.strict()` PAR type d'événement : zod rejette toute clé non déclarée.
 * C'est la liste blanche. Ajouter un type d'événement = ajouter une entrée ici,
 * jamais élargir un schéma existant à un `z.record()` ou un `.passthrough()`.
 */
const SCHEMAS_PAYLOAD: Record<TypeEvenementApplicatif, z.ZodType> = {
  /** Consentement initial : les scopes DEMANDÉS (libellés d'API, pas de la donnée). */
  "consent.granted": z
    .object({
      requestedScopes: z.array(z.string().min(1).max(64)).max(20).optional(),
      institutionId: z.string().min(1).max(64).optional(),
    })
    .strict(),

  /** Sélection de comptes : des UUID opaques + leurs masques. Rien d'autre. */
  "consent.accounts_selected": z
    .object({
      accountIds: z.array(z.string().min(1).max(64)).min(1).max(200),
      accountsLabels: z.array(compteMasqueSchema).max(200),
    })
    .strict(),
};

/**
 * Valide `payload` contre la liste blanche de son `eventType`. Lève
 * `AuditPayloadInvalideError` (jamais un rejet zod brut : on veut un code nommé).
 *
 * Le message d'erreur cite les CLÉS refusées, jamais leurs VALEURS — une valeur
 * refusée est précisément celle qu'on soupçonne d'être une PII.
 */
function validerPayload(
  eventType: TypeEvenementApplicatif,
  payload: unknown,
): Record<string, unknown> {
  const schema = SCHEMAS_PAYLOAD[eventType];
  if (!schema) {
    throw new AuditPayloadInvalideError(eventType, "type d'événement inconnu");
  }

  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    // On ne remonte que les NOMS de clés en défaut — jamais les valeurs reçues
    // (une valeur refusée est précisément celle qu'on soupçonne d'être une PII).
    //
    // ⚠️ Une clé INCONNUE (le cas d'exfiltration) est signalée par zod avec un
    // `path` VIDE et le code `unrecognized_keys` : son nom vit dans `issue.keys`.
    // Sans ce cas, le message dirait « (racine) » et un AUDIT_PAYLOAD_INVALID en
    // production serait indébogable — on ne saurait pas QUELLE clé a été refusée.
    const noms = parsed.error.issues.flatMap((i) =>
      i.code === "unrecognized_keys"
        ? i.keys
        : [i.path.length > 0 ? i.path.join(".") : "(racine)"],
    );
    const chemins = [...new Set(noms)].join(", ");
    throw new AuditPayloadInvalideError(eventType, `clé(s) refusée(s) : ${chemins}`);
  }
  return parsed.data as Record<string, unknown>;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Snapshot d'identité (Invariant 2).
 * ═══════════════════════════════════════════════════════════════════════ */

interface SnapshotActeur {
  email: string;
  /** `full_name` est NOT NULL en base, mais la colonne cible est nullable. */
  nom: string | null;
}

/**
 * Résout l'identité de l'acteur DANS la transaction courante. `ctx.userId` vient de
 * `withWorkspace` (membership re-validée), jamais d'un paramètre client.
 *
 * ⚠️ `users` ne porte pas de `workspace_id` et n'a pas de RLS : c'est une table
 * globale (un utilisateur peut être membre de plusieurs workspaces). L'autorité qui
 * lie CET utilisateur à CE workspace est la re-validation de membership faite par
 * `withWorkspace` en amont — on ne la refait pas ici, on en hérite.
 */
async function resoudreActeur<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
): Promise<SnapshotActeur> {
  const lignes = await tx
    .select({ email: users.email, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1);

  const ligne = lignes[0];
  if (!ligne) {
    throw new AuditSnapshotIncompletError("acteur introuvable");
  }
  // Un email vide passerait le NOT NULL mais ne désigne personne : fail-closed.
  const email = ligne.email?.trim();
  if (!email) {
    throw new AuditSnapshotIncompletError("email de l'acteur absent");
  }

  const nom = ligne.fullName?.trim();
  return { email, nom: nom && nom.length > 0 ? nom : null };
}

/**
 * Résout le nom de l'institution de la connexion, DANS la transaction, sous RLS.
 *
 * Contrairement à l'acteur, l'absence n'est PAS fatale : `institution_name` est
 * nullable en base (l'amont ne le porte pas sur tous les chemins — cf. DASH-INST1)
 * et le consentement reste probant sans lui (l'UUID de connexion l'identifie).
 * Retourne `null` si la connexion n'est pas visible : la RLS tenant a déjà fait son
 * office, ce n'est pas au repository de décider d'un refus d'accès ici.
 */
async function resoudreInstitution<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  connectionId: string,
): Promise<string | null> {
  const lignes = await tx
    .select({ institutionName: bankConnections.institutionName })
    .from(bankConnections)
    .where(
      and(
        eq(bankConnections.id, connectionId),
        // Défense en profondeur : la RLS borne déjà, on l'écrit quand même.
        eq(bankConnections.workspaceId, ctx.workspaceId),
      ),
    )
    .limit(1);

  const nom = lignes[0]?.institutionName?.trim();
  return nom && nom.length > 0 ? nom : null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Écriture — les deux seules fonctions publiques.
 * ═══════════════════════════════════════════════════════════════════════ */

export interface EvenementAConsigner {
  eventType: TypeEvenementApplicatif;
  /** `bank_connections.id` local. Optionnel : un événement peut ne viser aucune connexion. */
  connectionId?: string | null;
  /** Validé contre la liste blanche du `eventType`. */
  payload?: unknown;
}

/**
 * Écrit UNE ligne dans `audit_events` (INSERT seul). Événement APPLICATIF :
 * `omnifi_event_id` est NULL par construction — la colonne est réservée aux webhooks
 * (la contrainte UNIQUE composite ne s'applique pas aux NULL, N lignes applicatives
 * coexistent donc sans conflit ; voir le commentaire du schéma, ne pas « corriger »).
 *
 * `workspace_id` et `actor_user_id` viennent de `ctx`, JAMAIS d'un paramètre.
 */
export async function consigner<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  evenement: EvenementAConsigner,
): Promise<{ auditEventId: string }> {
  const payload = validerPayload(evenement.eventType, evenement.payload);

  const lignes = await tx
    .insert(auditEvents)
    .values({
      workspaceId: ctx.workspaceId,
      eventType: evenement.eventType,
      omnifiEventId: null, // applicatif, jamais un EventId de webhook
      connectionId: evenement.connectionId ?? null,
      actorUserId: ctx.userId,
      hmacSignatureTruncated: null, // réservé aux webhooks signés
      payload,
    })
    .returning({ id: auditEvents.id });

  return { auditEventId: lignes[0].id };
}

/** Les actions de consentement, telles que contraintes par le CHECK en base. */
export type ActionConsentement = "GRANTED" | "ACCOUNTS_SELECTED" | "REVOKED";

/** Correspondance action → type d'événement d'audit. Une action, un événement. */
const EVENEMENT_PAR_ACTION: Record<
  Extract<ActionConsentement, "GRANTED" | "ACCOUNTS_SELECTED">,
  TypeEvenementApplicatif
> = {
  GRANTED: "consent.granted",
  ACCOUNTS_SELECTED: "consent.accounts_selected",
};

export interface ConsentementAEnregistrer {
  /** `bank_connections.id` local (UUID nu, pas de FK — cf. Invariant 2). */
  connectionId: string;
  action: Extract<ActionConsentement, "GRANTED" | "ACCOUNTS_SELECTED">;
  /**
   * Contenu du consentement. Validé contre la MÊME liste blanche que le payload de
   * l'événement d'audit correspondant : un scope et un payload ne peuvent pas
   * diverger dans leur discipline PII.
   */
  scope?: unknown;
}

/**
 * Enregistre un consentement : écrit `consent_records` ET `audit_events`, dans la
 * transaction de l'appelant (jamais de connexion propre).
 *
 * Ordre volontaire : snapshot → validation → INSERT consent → INSERT audit. Si le
 * snapshot est incomplet ou le scope hors liste blanche, RIEN n'est écrit — la
 * transaction de l'appelant remonte l'exception et roule en arrière. On ne consigne
 * jamais un consentement à moitié.
 *
 * ⚠️ L'appelant DOIT avoir déjà obtenu l'accord d'Omni-FI (plan §2.3) : on ne
 * consigne pas un consentement qui n'existe pas chez le fournisseur.
 */
export async function enregistrerConsentement<TDb extends AnyPgDatabase>(
  tx: WorkspaceTx<TDb>,
  ctx: WorkspaceContext,
  consentement: ConsentementAEnregistrer,
): Promise<{ consentRecordId: string; auditEventId: string }> {
  const eventType = EVENEMENT_PAR_ACTION[consentement.action];

  // 1. Liste blanche AVANT toute écriture (Invariant 3).
  const scope = validerPayload(eventType, consentement.scope);

  // 2. Snapshots dans la transaction, sous RLS (Invariant 2). Fail-closed sur l'acteur.
  const acteur = await resoudreActeur(tx, ctx);
  const institutionName = await resoudreInstitution(
    tx,
    ctx,
    consentement.connectionId,
  );

  // 3. INSERT du consentement — snapshot COPIÉ, jamais une FK (cf. en-tête).
  const lignes = await tx
    .insert(consentRecords)
    .values({
      workspaceId: ctx.workspaceId,
      connectionId: consentement.connectionId,
      institutionName,
      grantedByUserId: ctx.userId,
      grantedByEmail: acteur.email,
      grantedByName: acteur.nom,
      action: consentement.action,
      scope,
    })
    .returning({ id: consentRecords.id });

  // 4. Trace d'audit corrélée, même transaction (vivent ou meurent ensemble).
  const { auditEventId } = await consigner(tx, ctx, {
    eventType,
    connectionId: consentement.connectionId,
    payload: scope,
  });

  return { consentRecordId: lignes[0].id, auditEventId };
}
