"use server";

/**
 * Provisioning ADMIN (Epic 2 L3) — créer un utilisateur et le rattacher au
 * workspace courant. Garde S3 portée par le repository (ctx.role === ADMIN) ET
 * par withWorkspace (membership re-validée). L'action hash le mot de passe
 * initial (argon2) et délègue ; elle ne touche jamais la DB directement.
 */
import argon2 from "argon2";
import { z } from "zod";

import { exigerSessionWorkspace } from "@/server/auth/session";
import {
  creerUtilisateurEtRattacher,
  ProvisioningNonAutoriseError,
  RoleInvalideError,
  withWorkspace,
} from "@/server/db";

export interface EtatProvisioning {
  erreur: string | null;
  succes: string | null;
}

// Validation stricte (règle 3). Le mot de passe initial : 12 char min (aligné
// sur seed-admin). L'utilisateur le changera (flux à venir).
const provisioningSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    fullName: z.string().trim().min(1).max(120),
    motDePasse: z.string().min(12).max(200),
    role: z.enum(["ADMIN", "MANAGER", "VIEWER"]),
  })
  .strict();

const MESSAGE_REFUS = "Action non autorisée.";

export async function provisionnerMembre(
  _etat: EtatProvisioning,
  formData: FormData,
): Promise<EtatProvisioning> {
  const session = await exigerSessionWorkspace();

  const parsed = provisioningSchema.safeParse({
    email: formData.get("email"),
    fullName: formData.get("fullName"),
    motDePasse: formData.get("motDePasse"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { erreur: "Champs invalides.", succes: null };
  }

  const passwordHash = await argon2.hash(parsed.data.motDePasse);

  try {
    await withWorkspace(session, (tx, ctx) =>
      creerUtilisateurEtRattacher(tx, ctx, {
        email: parsed.data.email,
        fullName: parsed.data.fullName,
        passwordHash,
        role: parsed.data.role,
      }),
    );
  } catch (erreur) {
    if (
      erreur instanceof ProvisioningNonAutoriseError ||
      erreur instanceof RoleInvalideError
    ) {
      return { erreur: MESSAGE_REFUS, succes: null };
    }
    throw erreur;
  }

  return {
    erreur: null,
    succes: `${parsed.data.email} rattaché comme ${parsed.data.role}.`,
  };
}
