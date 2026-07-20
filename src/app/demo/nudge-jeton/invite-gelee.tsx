"use client";

/**
 * Reproduit le GEL CLIENT de `NudgePremiereSynchroConnecte` sans son contexte de synchro
 * (non montable hors workspace). C'est la moitié du mécanisme que la sonde doit exercer :
 * la décision serveur seule ne suffit pas, puisque le Router Cache la restitue telle
 * quelle au retour arrière.
 *
 * On ne recopie PAS la logique : `drapeauConnexionArme` et `nudgeEstVisible` sont les
 * fonctions de production, et `NudgePremiereSynchro` est le vrai composant d'affichage.
 * Seul le branchement au contexte est remplacé par des valeurs figées.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  CLE_DRAPEAU_CONNEXION,
  drapeauConnexionArme,
  nudgeEstVisible,
} from "@/components/sync/drapeau-connexion";
import { NudgePremiereSynchro } from "@/components/sync/nudge-premiere-synchro";

export function InviteGelee() {
  const params = useSearchParams();
  // Même initialiseur paresseux qu'en production : gelé au montage, pendant le rendu.
  const [armeALArrivee] = useState(() =>
    drapeauConnexionArme(params.get(CLE_DRAPEAU_CONNEXION) ?? undefined),
  );

  // `enCours`/`aUnRetour` figés : la sonde n'exerce que l'axe « arrivée ».
  if (!nudgeEstVisible({ arme: armeALArrivee, enCours: false, aUnRetour: false })) {
    return (
      <p data-test="sans-invite" className="text-sm text-text-faint">
        Aucune invite — drapeau absent à l’arrivée.
      </p>
    );
  }

  return <NudgePremiereSynchro peutSynchroniser />;
}
