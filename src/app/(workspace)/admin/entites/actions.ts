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
 * - Validation : Zod .strict() (bornes alignées DB) ; rejet bruyant « Champs invalides ».
 * - Erreurs : chaque erreur nommée du repo est mappée ; toute autre exception remonte
 *   (mappée 500 en amont), pas de catch-all silencieux.
 *
 * (La page.tsx + l'UI sas/sélecteur sont du rôle Front — hors de ce fichier.)
 */
import { z } from "zod";

import { exigerSessionWorkspace } from "@/server/auth/session";
import {
  assignerCompteEntite,
  CompteIntrouvableError,
  creerEntite,
  definirScopesMembre,
  EntiteIntrouvableError,
  EntiteNomDupliqueError,
  EntiteNonAutoriseError,
  MembreNonScopableError,
  renommerEntite,
  archiverEntite,
  withWorkspace,
} from "@/server/db";

export interface EtatAction {
  erreur: string | null;
  succes: string | null;
}

const MESSAGE_REFUS = "Action non autorisée.";
const MESSAGE_INVALIDE = "Champs invalides.";

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

const definirScopesSchema = z
  .object({
    userId: z.string().uuid(),
    entityIds: z.array(z.string().uuid()).max(200), // [] = Vision Globale ; borne anti-abus
  })
  .strict();

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
    e instanceof MembreNonScopableError
  ) {
    return { erreur: "Ressource introuvable.", succes: null };
  }
  if (e instanceof EntiteNomDupliqueError) {
    return { erreur: "Une entité porte déjà ce nom.", succes: null };
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
  const session = await exigerSessionWorkspace();
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
  return { erreur: null, succes: `Entité « ${parsed.data.name} » créée.` };
}

export async function renommerEntiteAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionWorkspace();
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
  return { erreur: null, succes: "Entité renommée." };
}

export async function archiverEntiteAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionWorkspace();
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
  return { erreur: null, succes: "Entité archivée." };
}

export async function assignerCompteAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionWorkspace();
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
  return {
    erreur: null,
    succes: parsed.data.entityId
      ? "Compte assigné à l'entité."
      : "Compte repassé en non assigné.",
  };
}

export async function definirScopesAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionWorkspace();
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
        ? "Périmètre défini : Vision Globale (toutes entités)."
        : `Périmètre défini : ${parsed.data.entityIds.length} entité(s).`,
  };
}
