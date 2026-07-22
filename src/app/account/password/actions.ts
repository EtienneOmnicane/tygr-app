"use server";

/**
 * Changement de mot de passe (AUTH-MDP-TEMPO1 §5.4) — la SEULE surface
 * autorisée à un compte gaté `must_change_password`.
 *
 * Sécurité (exit-criteria règle 3, §6 du plan) :
 * - Authz : `exigerSessionUtilisateur` (E6 + invalidation D4, SANS gate D3 —
 *   cette surface est celle que le gate vise). PAS de withWorkspace : `users`
 *   est une méta-table d'identité GLOBALE hors RLS, aucune ressource tenant ici.
 * - Anti-IDOR par construction : AUCUN identifiant en entrée — le userId vient
 *   exclusivement de la session ; schéma zod `.strict()`.
 * - Rate-limit : lockout E18 mutualisé, décision finale sous FOR UPDATE (repo).
 * - Chaque erreur a un nom (registre S2) ; pas de catch-all.
 * - Logs structurés sans PII : jamais le mot de passe, jamais l'email accolé.
 */
import argon2 from "argon2";
import { redirect } from "next/navigation";

import { unstable_update } from "@/server/auth/config";
import {
  exigerSessionUtilisateur,
  NonAuthentifieError,
} from "@/server/auth/session";
import {
  CompteIndisponibleError,
  CompteSansMotDePasseError,
  CompteVerrouilleError,
  identite,
  MotDePasseActuelIncorrectError,
} from "@/server/db";

import {
  MESSAGES_CHANGEMENT,
  validerChangement,
  type EtatChangement,
} from "./validation";

export async function changerMotDePasseAction(
  _etat: EtatChangement,
  formData: FormData,
): Promise<EtatChangement> {
  // 1. E6 + D4 — une session périmée/compte inactif est renvoyée au login,
  //    indistinguable d'un non-connecté (jamais « le mot de passe a changé »).
  let compte: { userId: string };
  try {
    compte = await exigerSessionUtilisateur();
  } catch (erreur) {
    if (erreur instanceof NonAuthentifieError) {
      redirect("/login");
    }
    throw erreur;
  }

  // 2. Validation stricte à codes nommés (forme → mismatch → same-as-current,
  //    ce dernier par égalité de chaînes AVANT tout hash).
  const validation = validerChangement({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!validation.ok) {
    console.warn(
      JSON.stringify({
        evenement: "mot_de_passe_change_refuse",
        code: validation.code,
        userId: compte.userId,
      }),
    );
    return { erreur: MESSAGES_CHANGEMENT[validation.code] };
  }

  // 3. Hash du nouveau secret AVANT la transaction (~100 ms hors verrou de ligne).
  const nouveauHash = await argon2.hash(validation.data.newPassword);
  const maintenant = new Date();

  // 4. Décision atomique (verrou ? → verify → écriture) sous FOR UPDATE — D6.
  try {
    await identite.changerMotDePasse(compte.userId, {
      verifierAncien: (hash) =>
        argon2.verify(hash, validation.data.currentPassword).catch(() => false),
      nouveauHash,
      maintenant,
    });
  } catch (erreur) {
    if (erreur instanceof CompteIndisponibleError) {
      // Compte disparu/désactivé ENTRE la garde et la tx : ≡ non connecté.
      redirect("/login");
    }
    const code =
      erreur instanceof CompteVerrouilleError
        ? "ACCOUNT_LOCKED"
        : erreur instanceof CompteSansMotDePasseError
          ? "NO_PASSWORD_SET"
          : erreur instanceof MotDePasseActuelIncorrectError
            ? "CURRENT_PASSWORD_INCORRECT"
            : null;
    if (code === null) {
      throw erreur; // infra/inconnu : remonte au boundary (pas de catch-all)
    }
    console.warn(
      JSON.stringify({
        evenement: "mot_de_passe_change_refuse",
        code,
        userId: compte.userId,
      }),
    );
    return { erreur: MESSAGES_CHANGEMENT[code] };
  }

  // 5. Survie de la session COURANTE (D4) : le callback jwt RE-LIT la base et
  //    pose la valeur DB — la valeur passée ici ne sert qu'à déclencher l'update.
  await unstable_update({ pwdAt: maintenant.getTime() });

  // 6. Log structuré (règle 8) : jamais le mot de passe, jamais l'email accolé.
  console.info(
    JSON.stringify({
      evenement: "mot_de_passe_change",
      userId: compte.userId,
    }),
  );

  // 7. Toute autre session du compte (autre onglet, session admin
  //    pré-changement) meurt à sa prochaine requête gardée (pwdAt ≠).
  redirect("/");
}
