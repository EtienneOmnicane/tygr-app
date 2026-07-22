/**
 * DRAPEAU D'ARRIVÉE « une banque vient d'être connectée » — logique PURE, testée (le
 * projet n'a pas de renderer React : c'est la seule façon de PROUVER la non-réapparition
 * de l'invite).
 *
 * ⚠️ POURQUOI CE MODULE EXISTE — le défaut qu'il corrige (cross-review, 8/10) : le
 * drapeau vivait dans l'URL et n'était gardé que par l'état du contexte de synchro
 * (`retour !== null`). Or cet état meurt à chaque démontage de `SynchroProvider`, tandis
 * que l'URL, elle, est restaurée VERBATIM par le navigateur. Séquence réelle : connexion
 * → synchro réussie → « Transactions » → bouton Précédent → `?connexion=etablie` revient,
 * le provider remonte avec `retour = null`, et « lancez une première synchronisation »
 * se réaffiche au-dessus d'un dashboard déjà plein. Le retour arrière ne demande aucun
 * geste délibéré : c'est le chemin naturel de retour au dashboard.
 *
 * La correction est un changement de NATURE du drapeau : il devient un JETON À USAGE
 * UNIQUE. Il arme l'invite au premier rendu, puis il est immédiatement CONSOMMÉ de
 * l'historique (`window.history.replaceState`, supporté par le routeur App Router — la
 * doc Next précise que l'entrée remplacée n'est plus atteignable par le bouton Précédent).
 * Une garde d'état ne pouvait pas y arriver : elle protège une session de composant,
 * alors que le problème vit dans l'historique du navigateur.
 *
 * ⚠️ INVARIANT DE SÛRETÉ (inchangé) : ce drapeau ne pilote QU'UN AFFICHAGE. Il n'atteint
 * ni SQL, ni Server Action, ni décision d'autorisation. Toute valeur inattendue retombe
 * sur `false`. Un lien forgé ne fait donc voir qu'une invite et un bouton déclenchant une
 * action par ailleurs gatée par le rôle, autorisée serveur et throttlée en amont.
 */

/** Clé du drapeau dans l'URL. Une seule définition — l'écrire en dur ailleurs le désynchroniserait. */
export const CLE_DRAPEAU_CONNEXION = "connexion";

/** Unique valeur reconnue. Toute autre valeur = drapeau absent (fail-safe). */
export const VALEUR_DRAPEAU_CONNEXION = "etablie";

/**
 * Le drapeau est-il armé ? Égalité STRICTE, et elle suffit comme validation : un
 * paramètre répété arrive en `string[]` et ne peut pas être égal à une chaîne, donc il
 * retombe sur `false` sans traitement particulier.
 */
export function drapeauConnexionArme(
  valeur: string | string[] | undefined,
): boolean {
  return valeur === VALEUR_DRAPEAU_CONNEXION;
}

/**
 * URL à substituer dans l'historique pour CONSOMMER le drapeau, ou `null` s'il n'y a
 * rien à consommer (l'appelant ne touche alors pas à l'historique — ce qui rend
 * l'opération idempotente, y compris sous le double-montage des effets en développement).
 *
 * Contrat exact : opère sur `pathname` + `search`. Le FRAGMENT (`#ancre`) ne fait pas
 * partie de l'entrée et n'est donc pas restitué — sans conséquence ici (aucune surface du
 * dashboard n'utilise d'ancre), mais à savoir avant de réutiliser cette fonction ailleurs.
 *
 * ⚠️ PRÉSERVE TOUS LES AUTRES PARAMÈTRES DE REQUÊTE. C'est le vrai piège de cette fonction : la
 * version naïve (« remplacer par le pathname nu ») effacerait `periode`/`du`/`au` et
 * ferait SAUTER la fenêtre choisie par l'utilisateur au moment précis où il arrive sur
 * son dashboard — on aurait corrigé un mensonge en introduisant une régression visible.
 * Le test verrouille ce point.
 */
export function urlSansDrapeauConnexion(
  pathname: string,
  recherche: string,
): string | null {
  const params = new URLSearchParams(recherche);
  if (!params.has(CLE_DRAPEAU_CONNEXION)) return null;
  // `delete` retire TOUTES les occurrences de la clé (cas du paramètre répété).
  params.delete(CLE_DRAPEAU_CONNEXION);
  const reste = params.toString();
  return reste === "" ? pathname : `${pathname}?${reste}`;
}

/**
 * L'invite doit-elle être visible ? Réunit les trois conditions en une décision testable
 * plutôt que de les éparpiller dans le JSX.
 *
 * `aUnRetour` (une synchro a déjà rendu un compte rendu) et `enCours` restent des gardes
 * utiles APRÈS la correction : elles couvrent le cas où l'utilisateur synchronise sans
 * quitter la page — le drapeau est déjà consommé côté historique, mais le rendu courant
 * l'a encore. Sans elles, l'invite cohabiterait avec le compte rendu qui annonce, lui,
 * les transactions importées.
 */
export function nudgeEstVisible({
  arme,
  enCours,
  aUnRetour,
}: {
  /** Le drapeau était armé au rendu de la page. */
  arme: boolean;
  /** Une synchro est en vol. */
  enCours: boolean;
  /** Une synchro a déjà rendu un compte rendu dans cette session de composant. */
  aUnRetour: boolean;
}): boolean {
  return arme && !enCours && !aUnRetour;
}
