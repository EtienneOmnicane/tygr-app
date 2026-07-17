/**
 * Validation du changement de mot de passe (AUTH-MDP-TEMPO1 §5.4 étape 2) —
 * module SÉPARÉ de l'action : un fichier `"use server"` ne peut exporter que
 * des fonctions async ; le schéma et le registre de messages vivent ici pour
 * être unit-testés et consommés par le formulaire client.
 *
 * Bornes 12/200 alignées sur le provisioning (`membres/actions.ts`) : min 12 =
 * politique existante, pas de règles de composition (NIST 800-63B privilégie
 * la longueur ; blocklist = dette P2 optionnelle, plan §10).
 */
import { z } from "zod";

/** État du formulaire (useActionState). */
export interface EtatChangement {
  erreur: string | null;
}

/** Codes machine de la validation (registre S2 du plan §6). */
export type CodeValidationChangement =
  | "INVALID_INPUT"
  | "PASSWORDS_DO_NOT_MATCH"
  | "SAME_AS_CURRENT";

/**
 * Messages UI (EN — Q-LANG). Le mapping code → message vit ici, l'action ne
 * fabrique jamais de texte ad hoc (pas de catch-all silencieux, règle 3).
 */
export const MESSAGES_CHANGEMENT = {
  INVALID_INPUT: "Invalid input.",
  PASSWORDS_DO_NOT_MATCH: "The new passwords do not match.",
  SAME_AS_CURRENT: "Your new password must be different from the current one.",
  CURRENT_PASSWORD_INCORRECT: "Your current password is incorrect.",
  ACCOUNT_LOCKED: "Too many attempts. Try again later.",
  NO_PASSWORD_SET: "This account does not use password sign-in.",
} as const;

/**
 * `.strict()` : tout champ excédentaire est rejeté — combiné à « aucun
 * identifiant en entrée » (le userId vient de la session), l'anti-IDOR est
 * STRUCTUREL : impossible de viser le mot de passe d'un tiers (§6 du plan).
 */
export const changementMotDePasseSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(12).max(200),
    confirmPassword: z.string().min(1).max(200),
  })
  .strict();

export type ChangementValide = {
  currentPassword: string;
  newPassword: string;
};

/**
 * Validation séquencée à codes nommés (l'équivalent des `.refine` du plan,
 * exprimé en checks ordonnés pour une préséance déterministe des codes) :
 * forme stricte → correspondance des deux saisies → différence avec l'actuel
 * (égalité de CHAÎNES, avant tout hash — §5.4).
 */
export function validerChangement(
  entree: unknown,
):
  | { ok: true; data: ChangementValide }
  | { ok: false; code: CodeValidationChangement } {
  const parsed = changementMotDePasseSchema.safeParse(entree);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT" };
  }
  const { currentPassword, newPassword, confirmPassword } = parsed.data;
  if (newPassword !== confirmPassword) {
    return { ok: false, code: "PASSWORDS_DO_NOT_MATCH" };
  }
  if (newPassword === currentPassword) {
    return { ok: false, code: "SAME_AS_CURRENT" };
  }
  return { ok: true, data: { currentPassword, newPassword } };
}
