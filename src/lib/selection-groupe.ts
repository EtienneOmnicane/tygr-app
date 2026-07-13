/**
 * Sélection multiple par GROUPE — case « tout cocher » tri-état.
 *
 * Extrait de `grouper-titulaire.ts` (L3 de `PLAN-refonte-entites.md`, constat C2 de la
 * cross-review). La logique n'a jamais rien eu à voir avec les *titulaires* : elle ne
 * dépend que d'un `bankAccountId`. La laisser dans un module « titulaire » obligeait
 * l'écran d'assignation d'ENTITÉS à importer un module de PARTIES — une dette de nommage
 * qu'on paie maintenant plutôt que de la léguer.
 *
 * `grouper-titulaire.ts` ré-exporte ces symboles : aucun appelant existant ne change.
 *
 * PURES, zéro React : la sélection est un état du composant, la RÈGLE est ici.
 */

/** Le strict nécessaire : tout ce qui porte un identifiant de compte est sélectionnable. */
export interface SelectionnableParId {
  bankAccountId: string;
}

export type EtatSelectionGroupe = "aucun" | "partiel" | "tous";

/**
 * État de la case de groupe (tri-état), dérivé de la sélection courante.
 *
 * Groupe vide → « aucun », JAMAIS « tous » : une case cochée sur un groupe sans compte
 * serait un mensonge (et cocher « tous » n'y sélectionnerait rien).
 */
export function etatSelectionGroupe(
  comptesDuGroupe: readonly SelectionnableParId[],
  coches: ReadonlySet<string>,
): EtatSelectionGroupe {
  let n = 0;
  for (const c of comptesDuGroupe) {
    if (coches.has(c.bankAccountId)) n += 1;
  }
  if (n === 0) return "aucun";
  return n === comptesDuGroupe.length ? "tous" : "partiel";
}

/**
 * Bascule la sélection d'un groupe : « tous » cochés → décoche le groupe ;
 * « aucun »/« partiel » → coche TOUT le groupe. IMMUTABLE (nouveau Set ; l'entrée n'est
 * jamais mutée).
 *
 * DISPLAY-ONLY (règle 2) : n'ajoute QUE des `bankAccountId` de `comptesDuGroupe` — donc
 * de la liste déjà scopée par la RLS. Aucun id étranger ne peut entrer dans la sélection
 * par ce chemin ; et le serveur re-vérifie de toute façon chaque id (pré-check `inArray`
 * de `assignerComptesEntite`), car une sélection côté client n'est jamais une autorité.
 */
export function basculerGroupe(
  coches: ReadonlySet<string>,
  comptesDuGroupe: readonly SelectionnableParId[],
): Set<string> {
  const next = new Set(coches);
  const tousCoches =
    comptesDuGroupe.length > 0 &&
    comptesDuGroupe.every((c) => next.has(c.bankAccountId));
  for (const c of comptesDuGroupe) {
    if (tousCoches) next.delete(c.bankAccountId);
    else next.add(c.bankAccountId);
  }
  return next;
}
