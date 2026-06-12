/**
 * Machine d'état du lockout progressif par compte (plan E18, décision #59).
 *
 * Politique documentée :
 * - En dessous de SEUIL_VERROUILLAGE échecs consécutifs : aucun verrou.
 * - Au SEUIL_VERROUILLAGE-ième échec : verrou de VERROU_BASE_MS, puis la durée
 *   DOUBLE à chaque échec supplémentaire, plafonnée à VERROU_MAX_MS
 *   (60s → 120s → 240s … → 1h max).
 * - Une connexion réussie remet le compteur à zéro.
 * - Pendant un verrou actif, les tentatives sont rejetées SANS vérifier le mot
 *   de passe et SANS incrémenter le compteur (pas d'extension de verrou sans
 *   information nouvelle ; le rate-limit IP couvre le martèlement).
 * - Non-énumération (E18) : l'état « verrouillé » ne produit JAMAIS un message
 *   distinct des identifiants invalides côté client. Le compte à rebours
 *   visible de la matrice D2 est supersédé par la décision #59.
 *
 * Fonctions pures : aucun accès DB, aucune horloge implicite — `maintenant`
 * est toujours injecté (testabilité aux bornes, pas de Date.now() caché).
 */

export const SEUIL_VERROUILLAGE = 5;
export const VERROU_BASE_MS = 60_000; // 1 min
export const VERROU_MAX_MS = 3_600_000; // 1 h

export interface EtatLockout {
  /** Compteur APRÈS prise en compte de l'échec. */
  failedLoginCount: number;
  /** Borne d'expiration du verrou, ou null si pas de verrou. */
  lockedUntil: Date | null;
}

/**
 * Durée de verrou pour un compteur d'échecs donné (compteur déjà incrémenté).
 * Retourne 0 sous le seuil. Le doublement est calculé sans float : décalage
 * de bits borné pour éviter tout débordement (2^30 ms > VERROU_MAX_MS).
 */
export function dureeVerrouMs(failedLoginCount: number): number {
  if (failedLoginCount < SEUIL_VERROUILLAGE) {
    return 0;
  }
  const exposant = Math.min(failedLoginCount - SEUIL_VERROUILLAGE, 30);
  const duree = VERROU_BASE_MS * 2 ** exposant;
  return Math.min(duree, VERROU_MAX_MS);
}

/**
 * Transition sur ÉCHEC de connexion : incrémente le compteur et pose le
 * verrou si le seuil est atteint.
 */
export function evaluerEchec(
  failedLoginCountAvant: number,
  maintenant: Date,
): EtatLockout {
  const failedLoginCount = failedLoginCountAvant + 1;
  const duree = dureeVerrouMs(failedLoginCount);
  return {
    failedLoginCount,
    lockedUntil:
      duree === 0 ? null : new Date(maintenant.getTime() + duree),
  };
}

/** Transition sur SUCCÈS : remise à zéro complète. */
export function evaluerSucces(): EtatLockout {
  return { failedLoginCount: 0, lockedUntil: null };
}

/**
 * Le compte est-il verrouillé à l'instant donné ?
 * Borne STRICTE : à l'instant exact d'expiration, le verrou est levé.
 */
export function estVerrouille(
  lockedUntil: Date | null,
  maintenant: Date,
): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > maintenant.getTime();
}
