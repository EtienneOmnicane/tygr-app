"use server";

/**
 * Server Actions ADMIN — gestion des Entités (Option B, plan §3.3, L4 du socle).
 * Surface : CRUD entités + sas d'assignation compte→entité + périmètre Vision Entité
 * d'un membre (definirScopesMembre). Frontière P0-a : on importe depuis @/server/db
 * (ré-export), jamais @/server/repositories/* en direct. Les fonctions repo tournent
 * DANS withWorkspace(tx, ctx) — pas d'accès DB hors contexte.
 *
 * Gouvernance (exit-criteria règle 3) :
 * - Authz : withWorkspace re-valide la membership ; la garde ADMIN est dans le repo
 *   (ctx.role). Une ressource d'un autre tenant → 404 (erreur nommée non-énumérante),
 *   jamais 403. Le message UI renvoyé est GÉNÉRIQUE (pas d'oracle d'existence).
 * - Périmètre (L0, PLAN-refonte-entites.md §3.3) : TOUTES les actions passent par
 *   `exigerSessionAdministration()`, JAMAIS `exigerSessionWorkspace()` — la session est
 *   amputée du `viewFilter`. Sans ça, le WITH CHECK de la policy `account_scope`
 *   (RESTRICTIVE FOR ALL, 0016/0017) refuserait l'UPDATE d'un compte hors du filtre
 *   d'affichage choisi dans le header : l'ADMIN VOIT le compte et ne peut PAS le ranger.
 *   Une règle ESLint interdit l'import de `exigerSessionWorkspace` sous `admin/`.
 * - Validation : Zod .strict() (bornes alignées DB) ; rejet bruyant « Champs invalides ».
 * - Erreurs : chaque erreur nommée du repo est mappée ; toute autre exception remonte
 *   (mappée 500 en amont), pas de catch-all silencieux.
 *
 * (La page.tsx + l'UI sas/sélecteur sont du rôle Front — hors de ce fichier.)
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigerSessionAdministration } from "@/server/auth/session";
import {
  assignerCompteEntite,
  assignerPartieEntite,
  CompteIntrouvableError,
  creerEntite,
  definirScopesMembre,
  EntiteIntrouvableError,
  EntiteNomDupliqueError,
  EntiteNonAutoriseError,
  MembreNonScopableError,
  PartieIntrouvableError,
  renommerEntite,
  archiverEntite,
  withWorkspace,
} from "@/server/db";

export interface EtatAction {
  erreur: string | null;
  succes: string | null;
}

const MESSAGE_REFUS = "You are not allowed to do this.";
const MESSAGE_INVALIDE = "Invalid input.";

/* ------------------------------------------------------------------ */
/* Schémas Zod stricts (plan §4.1)                                     */
/* ------------------------------------------------------------------ */

const creerEntiteSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    code: z.string().trim().max(40).optional(),
  })
  .strict();

const renommerEntiteSchema = z
  .object({
    entityId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
  })
  .strict();

const archiverEntiteSchema = z
  .object({ entityId: z.string().uuid() })
  .strict();

const assignerCompteSchema = z
  .object({
    bankAccountId: z.string().uuid(),
    // null = « non assigné ». Une chaîne vide du formulaire est traitée comme null
    // côté action (cf. lecture de formData ci-dessous).
    entityId: z.string().uuid().nullable(),
  })
  .strict();

const assignerPartieSchema = z
  .object({
    partyId: z.string().uuid(),
    // null = « non rattachée ». Chaîne vide du formulaire → null (cf. lecture formData).
    entityId: z.string().uuid().nullable(),
  })
  .strict();

const definirScopesSchema = z
  .object({
    userId: z.string().uuid(),
    entityIds: z.array(z.string().uuid()).max(200), // [] = Vision Globale ; borne anti-abus
  })
  .strict();

/**
 * Confirmation d'une PROPOSITION Party→entité (ENTITY-PARTY1, sas ADMIN).
 * Deux cibles mutuellement exclusives :
 *  - `entityId` fourni → on rattache à une entité EXISTANTE (pas de création) ;
 *  - `entityId` absent + `nouvelleEntiteName` fourni → on CRÉE l'entité puis on rattache.
 * `bankAccountIds` = comptes de la party à assigner (0..N ; bornés anti-abus).
 * `partyId` = la party dont on pose parties.entity_id (rattachement BU).
 */
const confirmerPropositionSchema = z
  .object({
    partyId: z.string().uuid(),
    entityId: z.string().uuid().nullable(),
    nouvelleEntiteName: z.string().trim().min(1).max(120).nullable(),
    bankAccountIds: z.array(z.string().uuid()).max(500),
  })
  .strict()
  .refine((d) => d.entityId !== null || d.nouvelleEntiteName !== null, {
    message: "Cible d'entité manquante",
  });

/* ------------------------------------------------------------------ */
/* Mapping commun des erreurs nommées → message UI générique           */
/* ------------------------------------------------------------------ */

/**
 * Renvoie un EtatAction d'erreur si `e` est une erreur métier connue, sinon `null`
 * (l'appelant re-`throw` → 500). Aucun message ne révèle l'existence d'une ressource
 * d'un autre tenant (404 traité comme « introuvable » neutre).
 */
function mapErreur(e: unknown): EtatAction | null {
  if (e instanceof EntiteNonAutoriseError) {
    return { erreur: MESSAGE_REFUS, succes: null };
  }
  if (
    e instanceof EntiteIntrouvableError ||
    e instanceof CompteIntrouvableError ||
    e instanceof PartieIntrouvableError ||
    e instanceof MembreNonScopableError
  ) {
    return { erreur: "Not found.", succes: null };
  }
  if (e instanceof EntiteNomDupliqueError) {
    return { erreur: "An entity already has this name.", succes: null };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export async function creerEntiteAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionAdministration();
  const parsed = creerEntiteSchema.safeParse({
    name: formData.get("name"),
    code: formData.get("code") || undefined,
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  try {
    await withWorkspace(session, (tx, ctx) =>
      creerEntite(tx, ctx, { name: parsed.data.name, code: parsed.data.code }),
    );
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }
  return { erreur: null, succes: `Entity “${parsed.data.name}” created.` };
}

export async function renommerEntiteAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionAdministration();
  const parsed = renommerEntiteSchema.safeParse({
    entityId: formData.get("entityId"),
    name: formData.get("name"),
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  try {
    await withWorkspace(session, (tx, ctx) =>
      renommerEntite(tx, ctx, {
        entityId: parsed.data.entityId,
        name: parsed.data.name,
      }),
    );
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }
  return { erreur: null, succes: "Entity renamed." };
}

export async function archiverEntiteAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionAdministration();
  const parsed = archiverEntiteSchema.safeParse({
    entityId: formData.get("entityId"),
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  try {
    await withWorkspace(session, (tx, ctx) =>
      archiverEntite(tx, ctx, parsed.data.entityId),
    );
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }
  return { erreur: null, succes: "Entity archived." };
}

export async function assignerCompteAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionAdministration();
  // Une valeur vide/absente du select = « non assigné » (null).
  const rawEntity = formData.get("entityId");
  const parsed = assignerCompteSchema.safeParse({
    bankAccountId: formData.get("bankAccountId"),
    entityId: rawEntity ? String(rawEntity) : null,
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  try {
    await withWorkspace(session, (tx, ctx) =>
      assignerCompteEntite(tx, ctx, {
        bankAccountId: parsed.data.bankAccountId,
        entityId: parsed.data.entityId,
      }),
    );
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }

  // Succès UNIQUEMENT (jamais dans un chemin d'erreur, cf. plan L7 §R1). La page
  // /admin/entites re-rend ses trois sections : sans cela, le sas de propositions
  // resterait pré-coché d'après un `entityIdActuel` périmé, et un clic « Confirmer »
  // réassignerait un compte que l'ADMIN vient de ranger ailleurs (piège d'écriture).
  // Le sas n'est PAS impacté par ailleurs : confirmerPropositionAction appelle
  // assignerCompteEntite (le repo) en direct, pas cette action.
  revalidatePath("/admin/entites");

  return {
    erreur: null,
    succes: parsed.data.entityId
      ? "Account attached to the entity."
      : "Account set back to unassigned.",
  };
}

export async function assignerPartieAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionAdministration();
  // Une valeur vide/absente du select = « non rattachée » (null).
  const rawEntity = formData.get("entityId");
  const parsed = assignerPartieSchema.safeParse({
    partyId: formData.get("partyId"),
    entityId: rawEntity ? String(rawEntity) : null,
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  try {
    await withWorkspace(session, (tx, ctx) =>
      assignerPartieEntite(tx, ctx, {
        partyId: parsed.data.partyId,
        entityId: parsed.data.entityId,
      }),
    );
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }
  return {
    erreur: null,
    succes: parsed.data.entityId
      ? "Party attached to the entity."
      : "Party set back to unattached.",
  };
}

export async function definirScopesAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionAdministration();
  // Multi-sélection : getAll renvoie toutes les entités cochées (0..N).
  const parsed = definirScopesSchema.safeParse({
    userId: formData.get("userId"),
    entityIds: formData.getAll("entityIds").map((v) => String(v)),
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  try {
    await withWorkspace(session, (tx, ctx) =>
      definirScopesMembre(tx, ctx, {
        userId: parsed.data.userId,
        entityIds: parsed.data.entityIds,
      }),
    );
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }
  return {
    erreur: null,
    succes:
      parsed.data.entityIds.length === 0
        ? "Access set: the whole group."
        : `Access set: ${parsed.data.entityIds.length} entity(ies).`,
  };
}

/**
 * Confirme une proposition Party→entité (ENTITY-PARTY1, décision PO 2026-07-02 :
 * PRÉ-REMPLISSAGE + VALIDATION ADMIN). C'est le SEUL chemin qui pose enfin les
 * entity_id dérivés d'une party — et il est explicite, ADMIN-only, et jamais
 * automatique (l'ingestion n'a rien posé). Séquence, TOUTE dans une seule
 * transaction withWorkspace (atomicité : si une assignation échoue, rien n'est posé) :
 *   1. cible d'entité : soit une entité existante (`entityId`), soit on la CRÉE via
 *      `creerEntite` (gate ADMIN + FK composite) à partir du PartyName proposé ;
 *   2. `assignerPartieEntite` : pose parties.entity_id (rattachement BU) ;
 *   3. `assignerCompteEntite` pour CHAQUE compte de la party : pose bank_accounts.entity_id.
 *
 * Toutes les écritures passent par les GATES existantes (garde ADMIN dans le repo,
 * RLS tenant + entity_scope, FK composites) — on ne réimplémente aucun contrôle ici.
 * Un re-sync ultérieur ne réécrasera PAS ces entity_id (invariant du schéma :
 * upsertCompte/upsertPartieEtRole omettent entity_id de leur ON CONFLICT).
 */
export async function confirmerPropositionAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionAdministration();
  const rawEntity = formData.get("entityId");
  const rawName = formData.get("nouvelleEntiteName");
  const parsed = confirmerPropositionSchema.safeParse({
    partyId: formData.get("partyId"),
    entityId: rawEntity ? String(rawEntity) : null,
    nouvelleEntiteName: rawName ? String(rawName) : null,
    bankAccountIds: formData.getAll("bankAccountIds").map((v) => String(v)),
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  let nomEntite = "";
  try {
    await withWorkspace(session, async (tx, ctx) => {
      // 1. Résoudre la cible : entité existante ou création.
      let entityId = parsed.data.entityId;
      if (entityId === null) {
        // nouvelleEntiteName est garanti non-null par le refine du schéma.
        const cree = await creerEntite(tx, ctx, {
          name: parsed.data.nouvelleEntiteName as string,
        });
        entityId = cree.entityId;
        nomEntite = parsed.data.nouvelleEntiteName as string;
      }

      // 2. Rattacher la party (parties.entity_id) via la gate dédiée.
      await assignerPartieEntite(tx, ctx, {
        partyId: parsed.data.partyId,
        entityId,
      });

      // 3. Assigner chaque compte de la party (bank_accounts.entity_id) via la gate.
      for (const bankAccountId of parsed.data.bankAccountIds) {
        await assignerCompteEntite(tx, ctx, { bankAccountId, entityId });
      }
    });
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }

  const nbComptes = parsed.data.bankAccountIds.length;
  return {
    erreur: null,
    succes: nomEntite
      ? `Entity “${nomEntite}” created, ${nbComptes} account(s) attached.`
      : `Confirmed: ${nbComptes} account(s) attached.`,
  };
}
