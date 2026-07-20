/**
 * RÉSOLUTION DU NOM DE BANQUE dans les signaux de désynchronisation — logique PURE,
 * séparée du visuel et testée (le projet n'a pas de renderer React de test, CLAUDE.md :
 * c'est la seule façon de PROUVER le comportement de repli).
 *
 * ⚠️ LE PROBLÈME D'IDENTITÉ QU'ELLE RÉSOUT (le piège du lot) : `EtatFinalisation`
 * transporte `reparation[].connectionId` / `aReconnecter[].connectionId` remplis avec
 * `cx.ConnectionId` — l'identifiant AMONT Omni-FI (`orchestration.ts`). La liste des
 * banques de l'écran, elle, est indexée par `ConnexionBancaire.connectionId`, qui est
 * notre UUID INTERNE (`bank_connections.id`). Les deux se ressemblent (des UUID) et ne
 * sont PAS joignables : les rapprocher naïvement ne lève aucune erreur — ça ne
 * correspond simplement JAMAIS, et l'UI retomberait en silence sur son repli anonyme.
 * D'où la jointure sur `omnifiConnectionId`, et d'où ce module isolé + testé.
 *
 * ⚠️ RÈGLE 8 — frontière stricte : le libellé bancaire produit ici est destiné à l'UI
 * AUTHENTIFIÉE ET SCOPÉE (la liste vient d'un `withWorkspace` sous RLS tenant). Il ne
 * doit JAMAIS partir dans un log, un message d'erreur ou de la télémétrie. La règle de
 * non-énumération protège le CROSS-TENANT ; nommer TES banques dans TON workspace est
 * voulu — c'est précisément l'information qui manquait.
 */

/**
 * Forme MINIMALE attendue d'une connexion. Volontairement structurelle plutôt que
 * `ConnexionBancaire` : ce module reste consommable par une route de démo (Visual QA)
 * sans traîner le type du repository serveur.
 */
export interface ConnexionNommable {
  /** Identifiant AMONT — la clé de jointure (cf. docstring). */
  omnifiConnectionId: string;
  institutionName: string | null;
}

/**
 * Noms des banques correspondant à ces identifiants amont, dans l'ORDRE des
 * identifiants reçus. Les entrées non résolues (connexion absente de la liste, ou
 * `institutionName` NULL — la colonne est nullable, dette DASH-INST1) sont OMISES :
 * un nom manquant ne doit pas produire un trou (« et  n'est plus valide ») ni un
 * pseudo-nom inventé. L'appelant compare la longueur du résultat au nombre attendu
 * pour décider s'il peut nommer ou s'il doit retomber sur le compteur.
 */
export function resoudreNomsBanques(
  connectionIds: readonly string[],
  connexions: readonly ConnexionNommable[],
): string[] {
  const parId = new Map(
    connexions.map((c) => [c.omnifiConnectionId, c.institutionName]),
  );
  const noms: string[] = [];
  for (const id of connectionIds) {
    const nom = parId.get(id);
    // `?? null` : une clé absente et une valeur NULL se traitent pareil (non résolue).
    if (nom !== undefined && nom !== null && nom.trim() !== "") {
      noms.push(nom);
    }
  }
  return noms;
}

/**
 * Énumération FR lisible : « A », « A et B », « A, B et C ». La conjonction finale est
 * « et » (jamais une virgule sèche) — on écrit une phrase, pas une liste CSV.
 */
export function enumererNoms(noms: readonly string[]): string {
  if (noms.length === 0) return "";
  if (noms.length === 1) return noms[0];
  return `${noms.slice(0, -1).join(", ")} et ${noms[noms.length - 1]}`;
}

/**
 * Énumération des banques SI ET SEULEMENT SI elles sont TOUTES nommables ; `null` sinon
 * — auquel cas l'appelant garde sa formulation anonyme au compteur.
 *
 * ⚠️ Le « tout ou rien » est délibéré. Nommer partiellement (« Absa et 1 autre banque »)
 * ferait cohabiter deux registres dans la même phrase et, surtout, laisserait croire que
 * la banque non nommée est d'une NATURE différente — alors qu'elle est simplement
 * antérieure à la colonne `institution_name`. Entre nommer tout le monde et ne nommer
 * personne, il n'y a pas de demi-mesure honnête.
 *
 * Rendre `null` plutôt qu'une phrase de repli laisse le choix des MOTS à l'appelant :
 * nommer met le sujet en tête (« Absa Internet Banking — accès à rétablir »), alors que
 * l'anonyme se lit mieux autrement (« L'accès d'une banque n'est plus valide »). Une
 * seule fonction qui produirait les deux imposerait une syntaxe unique aux deux cas.
 */
export function nommerToutes(
  connectionIds: readonly string[],
  connexions: readonly ConnexionNommable[],
): string | null {
  if (connectionIds.length === 0) return null;
  const noms = resoudreNomsBanques(connectionIds, connexions);
  if (noms.length !== connectionIds.length) return null;
  return enumererNoms(noms);
}
