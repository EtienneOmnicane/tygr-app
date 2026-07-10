"use server";

/**
 * Server Actions de la garde de session (PR 2′, plan §4.1) — reconnexion SANS
 * perte de contexte quand le JWT expire au milieu d'un parcours.
 *
 * Pourquoi ça n'est PAS du confort : la session JWT porte le pont vers Omni-FI.
 * Si elle expire pendant le widget MFA, le `SessionToken` meurt avec elle et le
 * job de sync est perdu — le consent flow d'Epic 1 casse. La modale rétablit la
 * session sans démonter l'écran, donc sans perdre l'OTP en cours de saisie.
 *
 * Différence avec `login/actions.ts` (à ne pas fusionner) :
 * - `connecter()` redirige (`redirectTo: "/"`) : c'est le point d'entrée.
 * - `reconnecter()` NE redirige PAS (`redirect: false`) : rediriger détruirait
 *   précisément le contexte que cette modale existe pour préserver.
 * Les deux partagent la non-énumération (E18) : un seul message, quel que soit le
 * code machine (identifiants faux, compte verrouillé, inactif, limite IP). Pas de
 * compte à rebours de lockout affiché — E18 supersède D2 ligne 746 sur ce point.
 */
import { AuthError } from "next-auth";
import { z } from "zod";

import { auth, signIn } from "@/server/auth/config";

/** Registre S2 — `SESSION_EXPIRED`. Message unique, non-énumérant. */
const MESSAGE_RECONNEXION_REFUSEE =
  "Identifiants invalides. Vérifiez votre email et votre mot de passe.";

export interface EtatReconnexion {
  erreur: string | null;
  /**
   * `userId` effectivement authentifié, si succès. Le client le COMPARE à celui
   * qu'il affichait : une identité différente signifie que quelqu'un d'autre s'est
   * connecté dans la modale, et l'écran sous-jacent montre encore les données du
   * PRÉCÉDENT utilisateur (fuite intra-workspace visuelle). Le client force alors
   * un `router.refresh()` et purge le périmètre d'affichage.
   */
  userId: string | null;
}

/** Validation stricte (règle 3). Bornes alignées sur le provider Credentials. */
const reconnexionSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    motDePasse: z.string().min(1).max(200),
  })
  .strict();

export async function reconnecter(
  _etatPrecedent: EtatReconnexion,
  formData: FormData,
): Promise<EtatReconnexion> {
  const parsed = reconnexionSchema.safeParse({
    email: formData.get("email"),
    motDePasse: formData.get("motDePasse"),
  });
  if (!parsed.success) {
    return { erreur: MESSAGE_RECONNEXION_REFUSEE, userId: null };
  }

  try {
    // `redirect: false` : on RESTE sur l'écran courant. Le cookie de session est
    // reposé par Auth.js ; le DOM n'est jamais démonté (c'est tout l'objet).
    await signIn("credentials", {
      email: parsed.data.email,
      motDePasse: parsed.data.motDePasse,
      redirect: false,
    });
  } catch (erreur) {
    if (erreur instanceof AuthError) {
      return { erreur: MESSAGE_RECONNEXION_REFUSEE, userId: null };
    }
    // Jamais de catch-all silencieux (règle 3) : une erreur inattendue remonte.
    // Le mot de passe ne transite ni par un log ni par une `cause` (règle 8).
    throw erreur;
  }

  // Relit la session FRAÎCHE côté serveur : c'est la seule source d'autorité sur
  // « qui est connecté maintenant ». On ne fait pas confiance à l'email soumis
  // (un utilisateur peut se connecter sous une autre identité que l'affichée).
  const session = await auth();
  return { erreur: null, userId: session?.userId ?? null };
}
