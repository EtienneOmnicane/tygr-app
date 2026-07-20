/**
 * NUDGE POST-CONNEXION — « votre banque est reliée, il reste à importer vos
 * transactions ». Présentationnel PUR (zéro fetch, zéro état, handlers en props).
 *
 * ⚠️ LE TROU QU'IL COMBLE (et pourquoi il ne vit PAS sur /banques) : à la fin d'un
 * parcours de connexion réussi, `finaliserConnexionDropinAction` rattache les COMPTES
 * (et donc les soldes) mais n'importe AUCUNE transaction — la phrase serveur le dit
 * d'ailleurs : « Connexion établie — N compte(s) rattaché(s) », jamais « transactions
 * importées ». Puis, sur un succès COMPLET, `bank-connect-widget.tsx` fait
 * `router.push()` vers le dashboard. L'utilisateur atterrit donc sur un écran qui
 * affiche un solde mais un graphe et une table VIDES, sans que rien ne lui dise que le
 * geste suivant lui appartient. Un nudge rendu dans `WidgetFeedback` serait invisible :
 * la redirection l'emporte sur le chemin nominal. D'où le signal porté PAR la
 * redirection (`?connexion=etablie`), lu par la page, et rendu ici.
 *
 * ⚠️ POURQUOI PAS l'état « partiel » de `choisirEtatDashboard` (le piège évité) : cet
 * état se calcule sur `donnees.flux`, qui est filtré PAR PÉRIODE et PAR DEVISE
 * (`(dashboard)/page.tsx`). Il passe donc à « partiel » aussi quand on choisit une
 * fenêtre sans transaction, ou en multi-devise hors devise de base — le nudge y aurait
 * annoncé « lancez une première synchronisation » à quelqu'un dont les transactions
 * SONT importées. Le paramètre d'URL, lui, ne vaut que juste après une connexion : il
 * ne peut pas mentir sur cette question-là.
 *
 * Registre `info` (ni vert ni rouge) : rien n'a échoué (≠ `danger`/`warning`) et rien
 * n'est terminé (≠ `success`). C'est le registre créé pour ce cas dans `Callout` —
 * l'ambre et son triangle d'alerte auraient dramatisé un événement heureux.
 */
import { Callout } from "@/components/ui/states/callout";

/**
 * Texte du nudge. Constante nommée pour que la route de démo et un éventuel test
 * citent LA phrase, sans en recopier une variante qui divergerait ensuite.
 */
export const MESSAGE_NUDGE_PREMIERE_SYNCHRO =
  "Banque connectée — lancez une première synchronisation pour importer vos transactions.";

export function NudgePremiereSynchro({
  peutSynchroniser = false,
  onSynchroniser,
}: {
  /**
   * Le rôle courant autorise-t-il de synchroniser ? Un VIEWER lit le message (il
   * explique pourquoi son dashboard est vide) mais n'obtient pas le CTA : lui montrer
   * un bouton que le serveur refusera serait une fausse promesse. Confort UX seulement —
   * la barrière réelle est serveur (`synchroniserConnexionsDepuisOmnifi`).
   */
  peutSynchroniser?: boolean;
  /** Déclenche la synchro. Absent = CTA inerte (route de démo / Visual QA). */
  onSynchroniser?: () => void;
}) {
  return (
    <Callout
      severite="info"
      role="status"
      action={
        peutSynchroniser && onSynchroniser ? (
          <button
            type="button"
            onClick={onSynchroniser}
            className="inline-flex items-center whitespace-nowrap rounded-[2px] text-sm
              font-semibold text-primary underline-offset-2 transition-colors
              hover:text-primary-600 hover:underline focus:outline-none
              focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            Synchroniser
          </button>
        ) : undefined
      }
    >
      {MESSAGE_NUDGE_PREMIERE_SYNCHRO}
    </Callout>
  );
}
