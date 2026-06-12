"use server";

/**
 * Server Action de connexion — adaptateur fin : la validation profonde et
 * toute la logique de sécurité vivent dans verifier-identifiants.ts (via le
 * provider Credentials). Ici : forme minimale + mapping erreur → message UI.
 *
 * Non-énumération (E18) : QUEL QUE SOIT le code machine (identifiants faux,
 * compte verrouillé, inactif, limite IP), l'UI reçoit LE MÊME message.
 */
import { AuthError } from "next-auth";

import { signIn } from "@/auth";

export interface EtatConnexion {
  erreur: string | null;
}

/** Registre S2 — message unique de la surface login. */
const MESSAGE_CONNEXION_REFUSEE =
  "Identifiants invalides. Vérifiez votre email et votre mot de passe.";

export async function connecter(
  _etatPrecedent: EtatConnexion,
  formData: FormData,
): Promise<EtatConnexion> {
  const email = formData.get("email");
  const motDePasse = formData.get("motDePasse");
  if (typeof email !== "string" || typeof motDePasse !== "string") {
    return { erreur: MESSAGE_CONNEXION_REFUSEE };
  }

  try {
    await signIn("credentials", { email, motDePasse, redirectTo: "/" });
    return { erreur: null }; // inatteignable : la redirection lève
  } catch (erreur) {
    if (erreur instanceof AuthError) {
      return { erreur: MESSAGE_CONNEXION_REFUSEE };
    }
    // NEXT_REDIRECT (succès) et erreurs inattendues remontent — jamais de
    // catch-all silencieux (règle 3).
    throw erreur;
  }
}
