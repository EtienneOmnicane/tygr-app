/**
 * Messages du bouton « Synchroniser mes comptes » — fonctions PURES (testées).
 *
 * Vit HORS de `actions.ts` : ce fichier est `"use server"` et ne peut exporter que des
 * fonctions async (une fonction pure exportée depuis un module Server Action plante au
 * rendu — piège déjà payé au projet).
 *
 * Défaut corrigé (2026-07-13) : quand le sync n'avait aucune connexion à traiter, l'action
 * renvoyait `{ erreur: null, succes: null }` — soit RIEN à l'écran. L'utilisateur cliquait,
 * voyait un spinner, puis plus rien, sans savoir pourquoi. Or « 0 connexion traitée » a des
 * causes très différentes, et deux d'entre elles sont ACTIONNABLES :
 *
 *   • `nonRattachees` — une banque est connectée chez Omni-FI mais absente de notre base :
 *     le sync ne la crée JAMAIS (décision produit — on ajoute une banque par le widget).
 *     Cas réel observé : la finalisation du widget avait échoué en silence.
 *   • `inutilisables` — une banque de notre base n'a plus d'accès exploitable côté Omni-FI
 *     (disparue du listing, ou renvoyée avec un statut non actif). Ses comptes restent
 *     affichés avec un `last_synced_at` ancien : sans ce signal, l'utilisateur les croit à
 *     jour. C'est l'anti-pattern « comptes vides avec une date fraîche » déjà vu en prod.
 *
 * Messages NON-ÉNUMÉRANTS (règle 3) : on COMPTE les banques, on ne les nomme jamais, et on
 * n'expose aucun identifiant de connexion.
 */

/** Les deux désynchronisations base ↔ amont détectées par le sync. */
export interface CompteursDesync {
  /** Connexions actives chez Omni-FI, absentes de `bank_connections`. */
  nonRattachees: number;
  /**
   * Connexions de `bank_connections` plus utilisables côté Omni-FI : l'amont ne les renvoie
   * plus du tout, OU il les renvoie avec un statut non actif (expirée, en erreur). Deux
   * causes, une seule action — reconnecter — d'où un seul compteur.
   */
  inutilisables: number;
}

/**
 * Phrases actionnables décrivant les désynchronisations. Chaîne VIDE si tout est aligné —
 * l'appelant concatène sans condition. Toujours suffixées d'une action à mener : un signal
 * sans action est du bruit.
 */
export function supplementsDesync(d: CompteursDesync): string {
  const phrases: string[] = [];
  if (d.nonRattachees > 0) {
    phrases.push(
      `${d.nonRattachees} banque(s) connectée(s) chez votre fournisseur ne sont pas rattachées à cet espace — finalisez la connexion via « Connecter une banque ».`,
    );
  }
  if (d.inutilisables > 0) {
    phrases.push(
      `${d.inutilisables} banque(s) de cet espace ne répondent plus — reconnectez-les via « Connecter une banque ».`,
    );
  }
  return phrases.join(" ");
}

/**
 * Message quand AUCUNE connexion n'a été traitée. Ne renvoie JAMAIS une chaîne vide : le
 * silence est précisément le défaut corrigé. Quand rien n'est désynchronisé, le message dit
 * l'état banal (aucune banque connectée) plutôt que de laisser l'utilisateur deviner.
 */
export function messageAucuneConnexion(d: CompteursDesync): string {
  const supplements = supplementsDesync(d);
  const base =
    d.nonRattachees === 0 && d.inutilisables === 0
      ? "Aucune banque connectée à synchroniser — connectez-en une pour commencer."
      : "Aucune banque à synchroniser.";
  return supplements ? `${base} ${supplements}` : base;
}
