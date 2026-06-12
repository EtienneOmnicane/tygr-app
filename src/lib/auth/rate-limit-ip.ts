/**
 * Rate-limit IP du login (plan E7, décision #49) — fenêtre glissante en table
 * Postgres `login_attempts`, sans Redis.
 *
 * Politique documentée : au plus MAX_TENTATIVES_IP tentatives (succès ou
 * échec confondus) par IP sur les FENETRE_IP_MS dernières millisecondes.
 * Au-delà, la tentative est rejetée AVANT toute lecture de la table users
 * (réponse générique non-énumérante, identique aux identifiants invalides).
 *
 * Limite connue, assumée : l'IP provient de x-forwarded-for, fiable
 * uniquement derrière un proxy de confiance (Vercel/ALB). Le lockout par
 * compte (lockout.ts) reste la défense indépendante de l'IP.
 *
 * Fonctions pures — le comptage DB vit dans le repository identité.
 */

export const FENETRE_IP_MS = 15 * 60_000; // 15 min
export const MAX_TENTATIVES_IP = 20;

/** Borne basse de la fenêtre glissante pour un instant donné. */
export function debutFenetre(maintenant: Date): Date {
  return new Date(maintenant.getTime() - FENETRE_IP_MS);
}

/** La limite est-elle atteinte pour un nombre de tentatives déjà comptées ? */
export function depasseLimiteIp(tentativesDansFenetre: number): boolean {
  return tentativesDansFenetre >= MAX_TENTATIVES_IP;
}

/**
 * Extrait la première IP d'un header x-forwarded-for, bornée à 45 chars
 * (longueur max IPv6) — valeur par défaut explicite si absente, pour que le
 * rate-limit s'applique aussi aux requêtes sans header (bucket commun).
 */
export function extraireIp(xForwardedFor: string | null): string {
  const premiere = (xForwardedFor ?? "").split(",")[0].trim();
  return premiere === "" ? "ip-inconnue" : premiere.slice(0, 45);
}
