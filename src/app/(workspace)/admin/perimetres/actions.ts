"use server";

/**
 * Server Actions ADMIN — périmètres fins (user_scopes, L6a). OCTROYER / RÉVOQUER la
 * maille party|compte d'un membre. Surface volontairement étroite : l'octroi/la
 * révocation unitaire (une cible par appel), réservé ADMIN.
 *
 * Frontière P0-a : on importe depuis @/server/db (ré-export), jamais
 * @/server/repositories/* en direct. Les fonctions repo tournent DANS
 * withWorkspace(tx, ctx) — pas d'accès DB hors contexte.
 *
 * Gouvernance (exit-criteria règle 3) :
 * - Authz : withWorkspace re-valide la membership ; la garde ADMIN est dans le REPO
 *   (ctx.role). ⚠️ user_scopes PILOTE account_scope et la RLS tenant ne borne PAS le
 *   rôle → la garde applicative ADMIN du repo EST la sécurité (un MANAGER « Vision
 *   Globale » passe la RLS). L'action NE re-teste pas le rôle : elle MAPPE le refus.
 * - Validation : Zod .strict() en MIROIR du CHECK XOR (exactement une cible non nulle) ;
 *   rejet bruyant « Champs invalides ».
 * - Erreurs : chaque erreur nommée du repo est mappée en message UI GÉNÉRIQUE (pas
 *   d'oracle d'existence : 404 « introuvable », jamais 403) ; toute autre exception
 *   remonte (mappée 500 en amont), pas de catch-all silencieux.
 *
 * (La page.tsx + l'UI de gestion sont du rôle Front — hors de ce fichier.)
 */
import { z } from "zod";

import { exigerSessionWorkspace } from "@/server/auth/session";
import {
  CompteIntrouvableError,
  MembreNonScopableError,
  octroyerScopeFin,
  PartieIntrouvableError,
  revoquerScopeFin,
  ScopeFinNonAutoriseError,
  withWorkspace,
  type CibleScopeFin,
} from "@/server/db";

export interface EtatAction {
  erreur: string | null;
  succes: string | null;
}

const MESSAGE_REFUS = "Action non autorisée.";
const MESSAGE_INVALIDE = "Champs invalides.";
const MESSAGE_INTROUVABLE = "Ressource introuvable.";

/* ------------------------------------------------------------------ */
/* Schéma Zod strict — MIROIR du CHECK num_nonnulls(party, compte) = 1  */
/* ------------------------------------------------------------------ */

/**
 * Octroi/révocation d'une cible : userId + EXACTEMENT une cible (partyId XOR
 * bankAccountId). `.strict()` (rejette tout champ en trop). Le `superRefine` reproduit
 * le CHECK XOR de la base : 0 ou 2 cibles ⇒ « Champs invalides » AVANT toute écriture.
 */
const cibleScopeSchema = z
  .object({
    userId: z.string().uuid(),
    partyId: z.string().uuid().optional(),
    bankAccountId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const nbCibles =
      (val.partyId ? 1 : 0) + (val.bankAccountId ? 1 : 0);
    if (nbCibles !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactement une cible (party OU compte) est requise.",
      });
    }
  });

/** Construit la CibleScopeFin (union discriminée) à partir des champs validés. */
function versCible(data: {
  partyId?: string;
  bankAccountId?: string;
}): CibleScopeFin {
  return data.partyId !== undefined
    ? { partyId: data.partyId }
    : { bankAccountId: data.bankAccountId! };
}

/* ------------------------------------------------------------------ */
/* Mapping commun des erreurs nommées → message UI générique           */
/* ------------------------------------------------------------------ */

/**
 * Renvoie un EtatAction d'erreur si `e` est une erreur métier connue, sinon `null`
 * (l'appelant re-`throw` → 500). Aucun message ne révèle l'existence d'une ressource
 * d'un autre tenant (404 « introuvable » neutre).
 */
function mapErreur(e: unknown): EtatAction | null {
  if (e instanceof ScopeFinNonAutoriseError) {
    return { erreur: MESSAGE_REFUS, succes: null };
  }
  if (
    e instanceof MembreNonScopableError ||
    e instanceof PartieIntrouvableError ||
    e instanceof CompteIntrouvableError
  ) {
    return { erreur: MESSAGE_INTROUVABLE, succes: null };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

export async function octroyerScopeAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionWorkspace();
  const parsed = cibleScopeSchema.safeParse({
    userId: formData.get("userId"),
    partyId: formData.get("partyId") || undefined,
    bankAccountId: formData.get("bankAccountId") || undefined,
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  try {
    await withWorkspace(session, (tx, ctx) =>
      octroyerScopeFin(tx, ctx, parsed.data.userId, versCible(parsed.data)),
    );
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }
  return { erreur: null, succes: "Périmètre octroyé." };
}

export async function revoquerScopeAction(
  _etat: EtatAction,
  formData: FormData,
): Promise<EtatAction> {
  const session = await exigerSessionWorkspace();
  const parsed = cibleScopeSchema.safeParse({
    userId: formData.get("userId"),
    partyId: formData.get("partyId") || undefined,
    bankAccountId: formData.get("bankAccountId") || undefined,
  });
  if (!parsed.success) return { erreur: MESSAGE_INVALIDE, succes: null };

  try {
    await withWorkspace(session, (tx, ctx) =>
      revoquerScopeFin(tx, ctx, parsed.data.userId, versCible(parsed.data)),
    );
  } catch (e) {
    const m = mapErreur(e);
    if (m) return m;
    throw e;
  }
  return { erreur: null, succes: "Périmètre révoqué." };
}
