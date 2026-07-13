"use server";

/**
 * Provisioning ADMIN (Epic 2 L3 + assignation d'entités à la création) — créer un
 * utilisateur, le rattacher au workspace courant, et OPTIONNELLEMENT lui poser un
 * périmètre « Vision Entité » dans la MÊME transaction. Garde S3 portée par les
 * repositories (ctx.role === ADMIN) ET par withWorkspace (membership re-validée).
 * L'action hash le mot de passe initial (argon2) et délègue ; elle ne touche jamais la
 * DB directement.
 */
import argon2 from "argon2";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigerSessionAdministration } from "@/server/auth/session";
import {
  creerMembreAvecScopes,
  EntiteIntrouvableError,
  MembreNonScopableError,
  ProvisioningNonAutoriseError,
  RoleInvalideError,
  withWorkspace,
} from "@/server/db";

export interface EtatProvisioning {
  erreur: string | null;
  succes: string | null;
}

// Validation stricte (règle 3). Le mot de passe initial : 12 char min (aligné
// sur seed-admin). L'utilisateur le changera (flux à venir — dette AUTH-MDP-TEMPO1).
// entityIds : [] = Vision Globale ; borne anti-abus (miroir de definirScopesSchema).
const provisioningSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    fullName: z.string().trim().min(1).max(120),
    motDePasse: z.string().min(12).max(200),
    role: z.enum(["ADMIN", "MANAGER", "VIEWER"]),
    entityIds: z.array(z.string().uuid()).max(200),
  })
  .strict();

const MESSAGE_REFUS = "Action non autorisée.";
const MESSAGE_INVALIDE = "Champs invalides.";

/** Libellé du périmètre pour le message de succès (aucune donnée sensible). */
function suffixePerimetre(scopesDefinis: boolean, nbEntites: number): string {
  if (scopesDefinis) {
    return ` Périmètre : ${nbEntites} entité${nbEntites > 1 ? "s" : ""}.`;
  }
  return " Périmètre : Vision Globale.";
}

export async function provisionnerMembre(
  _etat: EtatProvisioning,
  formData: FormData,
): Promise<EtatProvisioning> {
  const session = await exigerSessionAdministration();

  const parsed = provisioningSchema.safeParse({
    email: formData.get("email"),
    fullName: formData.get("fullName"),
    motDePasse: formData.get("motDePasse"),
    role: formData.get("role"),
    // Multi-sélection : getAll renvoie toutes les entités cochées (0..N).
    entityIds: formData.getAll("entityIds").map((v) => String(v)),
  });
  if (!parsed.success) {
    return { erreur: MESSAGE_INVALIDE, succes: null };
  }

  const passwordHash = await argon2.hash(parsed.data.motDePasse);

  let resultat;
  try {
    resultat = await withWorkspace(session, (tx, ctx) =>
      creerMembreAvecScopes(tx, ctx, {
        email: parsed.data.email,
        fullName: parsed.data.fullName,
        passwordHash,
        role: parsed.data.role,
        entityIds: parsed.data.entityIds,
      }),
    );
  } catch (erreur) {
    if (
      erreur instanceof ProvisioningNonAutoriseError ||
      erreur instanceof RoleInvalideError
    ) {
      return { erreur: MESSAGE_REFUS, succes: null };
    }
    // Une entité inconnue / d'un autre tenant (FK composite) ou un membre non scopable
    // → saisie invalide (générique, pas d'oracle d'existence). La tx a rollback → aucun
    // utilisateur ni membership n'a persisté (atomicité prouvée par la suite d'isolation).
    if (
      erreur instanceof EntiteIntrouvableError ||
      erreur instanceof MembreNonScopableError
    ) {
      return { erreur: MESSAGE_INVALIDE, succes: null };
    }
    throw erreur;
  }

  // Message VÉRIDIQUE (morceau 3) : ne jamais annoncer « créé » un utilisateur réutilisé,
  // ni « rattaché » un membre qui l'était déjà. Le mot de passe n'apparaît JAMAIS (règle 8).
  const { email } = parsed.data;
  if (!resultat.membershipCreee) {
    // Déjà membre du workspace : rien n'a changé (anti-écrasement mot de passe + périmètre).
    return {
      erreur: null,
      succes: `${email} est déjà membre — aucune modification (mot de passe et périmètre inchangés).`,
    };
  }

  revalidatePath("/admin/membres");

  const perimetre = suffixePerimetre(
    resultat.scopesDefinis,
    parsed.data.entityIds.length,
  );
  if (resultat.utilisateurCree) {
    return {
      erreur: null,
      succes: `${email} créé et rattaché comme ${parsed.data.role}.${perimetre}`,
    };
  }
  // Utilisateur préexistant rattaché au workspace : mot de passe conservé.
  return {
    erreur: null,
    succes: `Utilisateur existant rattaché comme ${parsed.data.role} — mot de passe inchangé.${perimetre}`,
  };
}
