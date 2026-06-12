/**
 * Cœur de la vérification d'identifiants (plan E6/E7/E18) — logique pure vis-à-vis
 * de l'infrastructure : repository, vérification de hash et horloge sont INJECTÉS
 * (testable sans Auth.js ni DB réelle). Le provider Credentials (src/auth.ts)
 * n'est qu'un adaptateur autour de cette fonction.
 *
 * Invariants de sécurité (testés dans tests/unit/verifier-identifiants.test.ts) :
 * - Non-énumération (E18) : tous les échecs retournent un résultat de même forme ;
 *   les codes internes servent UNIQUEMENT aux logs structurés — l'UI affiche le
 *   même message générique pour chacun (registre S2).
 * - Égalisation de timing : un hash argon2 est vérifié à CHAQUE tentative, même
 *   quand l'email est inconnu ou que le compte n'a pas de mot de passe (SSO),
 *   via HASH_FACTICE — pas d'oracle temporel d'existence.
 * - Rate-limit IP (E7) AVANT toute lecture de la table users.
 * - Lockout (E18) : pendant un verrou actif, le résultat de la vérification du
 *   mot de passe est ignoré et le compteur n'est pas incrémenté.
 */
import { z } from "zod";

import type { RepositoryIdentite } from "@/repositories/identite";

import { estVerrouille } from "@/server/auth/lockout";
import { depasseLimiteIp } from "@/server/auth/rate-limit-ip";

/** Validation stricte : types, bornes, longueurs max (CLAUDE.md règle 3). */
export const identifiantsSchema = z
  .object({
    email: z.string().trim().toLowerCase().min(3).max(254),
    motDePasse: z.string().min(1).max(200),
  })
  .strict();

/**
 * Hash argon2id d'une valeur aléatoire jetée à la génération (2026-06-12) —
 * AUCUN mot de passe ne lui correspond. Sert exclusivement à payer le coût
 * d'une vérification argon2 quand l'utilisateur n'existe pas.
 */
export const HASH_FACTICE =
  "$argon2id$v=19$m=65536,t=3,p=4$64G/vYP0PxTkkHb3s4W5wQ$3cVR1qfFedpAyftSsKp8hvvjxo6rrDSjn5dbXiwSAC8";

/** Codes machine (registre S2) — tous mappés sur LE MÊME message UI générique. */
export type CodeEchecConnexion =
  | "ENTREE_INVALIDE"
  | "LIMITE_IP_ATTEINTE"
  | "IDENTIFIANTS_INVALIDES"
  | "COMPTE_VERROUILLE"
  | "COMPTE_INACTIF";

export type ResultatVerification =
  | { ok: true; utilisateur: { id: string; email: string; fullName: string } }
  | { ok: false; code: CodeEchecConnexion };

/**
 * Adaptation Auth.js → contrat du cœur : Auth.js passe à authorize() le corps
 * COMPLET du POST (csrfToken, callbackUrl…) ; le schéma .strict() rejetterait
 * ces champs en trop. On extrait les deux champs du contrat, rien d'autre.
 * Régression attrapée en validation E2E le 2026-06-12 (toute connexion
 * légitime tombait en ENTREE_INVALIDE).
 */
export function extraireIdentifiants(
  credentials: Record<string, unknown> | undefined,
): { email: unknown; motDePasse: unknown } {
  return {
    email: credentials?.email,
    motDePasse: credentials?.motDePasse,
  };
}

export interface DepsVerification {
  identite: Pick<
    RepositoryIdentite,
    | "trouverParEmail"
    | "enregistrerEchec"
    | "reinitialiserEchecs"
    | "compterTentativesIp"
    | "enregistrerTentativeIp"
  >;
  /** argon2.verify en production ; ne doit jamais lever (catch → false). */
  verifierMotDePasse(hash: string, motDePasse: string): Promise<boolean>;
  maintenant(): Date;
}

export async function verifierIdentifiants(
  deps: DepsVerification,
  entree: unknown,
  ip: string,
): Promise<ResultatVerification> {
  const parsed = identifiantsSchema.safeParse(entree);
  if (!parsed.success) {
    // L'entrée n'a pas la forme d'une tentative : rejet bruyant, sans écriture.
    return { ok: false, code: "ENTREE_INVALIDE" };
  }
  const { email, motDePasse } = parsed.data;
  const maintenant = deps.maintenant();

  // E7 — la limite IP se vérifie AVANT toute lecture de users.
  const tentatives = await deps.identite.compterTentativesIp(ip, maintenant);
  if (depasseLimiteIp(tentatives)) {
    await deps.identite.enregistrerTentativeIp(ip, false);
    return { ok: false, code: "LIMITE_IP_ATTEINTE" };
  }

  const utilisateur = await deps.identite.trouverParEmail(email);

  // Égalisation de timing : toujours une vérification argon2 complète.
  const hash = utilisateur?.passwordHash ?? HASH_FACTICE;
  const motDePasseValide = await deps.verifierMotDePasse(hash, motDePasse);

  if (!utilisateur || utilisateur.passwordHash === null) {
    await deps.identite.enregistrerTentativeIp(ip, false);
    return { ok: false, code: "IDENTIFIANTS_INVALIDES" };
  }

  if (estVerrouille(utilisateur.lockedUntil, maintenant)) {
    // Verrou actif : résultat du mot de passe ignoré, compteur non incrémenté
    // (politique lockout.ts) — réponse indistinguable des identifiants faux.
    await deps.identite.enregistrerTentativeIp(ip, false);
    return { ok: false, code: "COMPTE_VERROUILLE" };
  }

  if (!motDePasseValide) {
    await deps.identite.enregistrerEchec(utilisateur.id, maintenant);
    await deps.identite.enregistrerTentativeIp(ip, false);
    return { ok: false, code: "IDENTIFIANTS_INVALIDES" };
  }

  if (!utilisateur.isActive) {
    // Mot de passe correct mais compte désactivé : aucun signal distinctif ne
    // sort (le code sert au log) ; pas d'incrément lockout.
    await deps.identite.enregistrerTentativeIp(ip, false);
    return { ok: false, code: "COMPTE_INACTIF" };
  }

  await deps.identite.reinitialiserEchecs(utilisateur.id);
  await deps.identite.enregistrerTentativeIp(ip, true);
  return {
    ok: true,
    utilisateur: {
      id: utilisateur.id,
      email: utilisateur.email,
      fullName: utilisateur.fullName,
    },
  };
}
