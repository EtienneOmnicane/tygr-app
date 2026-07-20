/**
 * LOADER DE SYNCHRONISATION — barre INDÉTERMINÉE + copie honnête sur la durée.
 * Présentationnel PUR (zéro fetch, zéro état, zéro minuterie).
 *
 * ⚠️ CE QU'IL REMPLACE, ET POURQUOI CE N'EST PAS COSMÉTIQUE : le compte rendu annonçait
 * l'attente par une seule ligne grise (« Synchronisation en cours… »). Or la synchro est
 * SERVEUR-SYNCHRONE — le client attend que le serveur ait déclenché le job, l'ait pollé
 * jusqu'à son terme et ait ingéré les transactions — ce qui prend couramment plusieurs
 * dizaines de secondes. Une ligne de texte immobile pendant ce temps se lit comme un
 * écran figé : l'utilisateur reclique, ou quitte la page avant la fin.
 *
 * ⚠️ INDÉTERMINÉ, ET RIEN D'AUTRE (contrainte amont, pas un manque d'ambition) :
 *  - PAS de pourcentage — l'API amont n'expose aucun compteur incrémental pendant le
 *    scrape ; le total ne tombe qu'à `COMPLETED`. Une barre qui se remplit serait une
 *    fiction ;
 *  - PAS de paliers minutés (« Récupération… » → « Traitement… ») sur une minuterie. Le
 *    vrai statut du job ne franchit pas la frontière serveur aujourd'hui : un stepper
 *    branché sur un `setTimeout` afficherait « Traitement… » pendant qu'une banque est
 *    en réalité bloquée, et mentirait exactement au moment où l'utilisateur regarde le
 *    plus. Un vrai stepper suppose de rendre la progression du job visible côté client
 *    (changement du contrat de l'action) — c'est un chantier distinct, hors de ce lot.
 *
 * La DURÉE annoncée est un ordre de grandeur assumé (« jusqu'à une minute »), pas une
 * promesse chiffrée : elle recadre l'attente sans prétendre la mesurer.
 */
import { cn } from "@/components/ui/states/primitives";

/**
 * Copie de l'attente. Constante nommée pour que la route de démo cite LA phrase plutôt
 * qu'une variante qui divergerait ensuite.
 */
export const MESSAGE_SYNCHRO_EN_COURS =
  "Synchronisation en cours — cela peut prendre jusqu’à une minute.";

export function LoaderSynchro({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* `role="status"` porte l'annonce : c'est le TEXTE qui informe, jamais la barre. */}
      <p role="status" className="text-sm text-text-muted">
        {MESSAGE_SYNCHRO_EN_COURS}
      </p>
      {/* Barre décorative (`aria-hidden`) : strictement redondante avec la phrase
          ci-dessus, et sans valeur mesurable à exposer — un `role="progressbar"` sans
          `aria-valuenow` n'apprendrait rien à un lecteur d'écran que le texte ne dise
          déjà. `motion-safe:` : sous `prefers-reduced-motion`, la navette s'immobilise
          et il ne reste que la piste — l'information vit dans le texte, pas dans le
          mouvement. */}
      <div
        aria-hidden
        className="h-1 w-full max-w-xs overflow-hidden rounded-pill bg-surface-inset"
      >
        <div className="h-full w-1/4 rounded-pill bg-primary motion-safe:animate-navette" />
      </div>
    </div>
  );
}
