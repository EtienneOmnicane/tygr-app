/**
 * Règle UNIQUE de « compte non assigné » — L1 de `PLAN-refonte-entites.md` (constat C1).
 *
 * Pourquoi un module à part, plutôt qu'une ligne dans chacun des deux appelants :
 *
 * Le bandeau récap annonce « K comptes non assignés » — c'est le RESTE-À-FAIRE de
 * l'écran, sa raison d'être. Juste dessous, le tableau groupe ces mêmes comptes sous
 * « — Non assigné — ». Si les deux dérivent la notion CHACUN DE LEUR CÔTÉ, ils
 * divergent : le tableau (`grouperParEntite`) fait retomber dans « non assigné » un
 * compte dont l'entité a été ARCHIVÉE, alors qu'un test naïf `entityId === null` le
 * compterait comme assigné. On afficherait « 0 compte non assigné » au-dessus d'un
 * groupe « — Non assigné — (12 comptes) ». Les deux cross-reviews ont trouvé ce piège
 * indépendamment.
 *
 * La parade n'est pas « faire attention » : c'est qu'il n'existe QU'UNE seule
 * définition, et que les deux surfaces l'appellent. Même esprit que la source unique de
 * `format-montant` (CLAUDE.md) : une règle qui compte, on ne la réécrit pas.
 *
 * Module NEUTRE (aucune directive) : il est importé à la fois par un Server Component
 * (le bandeau) et par un module `"use client"` (le tableau). Un utilitaire exporté
 * depuis un fichier `"use client"` deviendrait une *client reference* et ne serait pas
 * appelable côté serveur — d'où ce fichier séparé.
 */

/** Le strict nécessaire : la règle ne dépend que de l'entité portée par le compte. */
export interface CompteAssignable {
  /** `entity_id` en base ; `null` = jamais assigné. */
  entityId: string | null;
}

/**
 * Un compte est « non assigné » s'il ne porte AUCUNE entité, **ou** si l'entité qu'il
 * porte n'est plus ACTIVE (archivée).
 *
 * Le second cas est le piège : `archiverEntite` ne fait qu'un `is_active = false`, il ne
 * touche PAS `bank_accounts.entity_id`. Le compte garde donc son `entity_id` en base,
 * mais l'entité a disparu des pickers — il est de facto orphelin à l'écran, et c'est
 * bien un reste-à-faire pour l'admin.
 *
 * @param idsEntitesActives ids des entités ACTIVES (celles rendues dans les sélecteurs).
 */
export function estNonAssigne(
  compte: CompteAssignable,
  idsEntitesActives: ReadonlySet<string>,
): boolean {
  return compte.entityId === null || !idsEntitesActives.has(compte.entityId);
}

/** Nombre de comptes non assignés — le chiffre mis en avant par le bandeau récap. */
export function compterNonAssignes(
  comptes: readonly CompteAssignable[],
  idsEntitesActives: ReadonlySet<string>,
): number {
  return comptes.reduce(
    (n, compte) => (estNonAssigne(compte, idsEntitesActives) ? n + 1 : n),
    0,
  );
}
