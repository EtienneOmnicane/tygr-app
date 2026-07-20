"use client";

/**
 * CONSOMMATION du jeton d'arrivée `?connexion=etablie`. Ne rend RIEN — c'est un effet de
 * bord d'historique, isolé dans son propre composant pour deux raisons :
 *
 *  1. il n'a aucune dépendance au contexte de synchro, donc la route de démo peut monter
 *     le VRAI composant (Gate 4) au lieu d'en recopier la logique — la copie de markup
 *     est précisément ce qui a fini par mentir dans `demo/dashboard-states` ;
 *  2. la responsabilité est nette : `NudgePremiereSynchroConnecte` décide de l'AFFICHAGE,
 *     celui-ci décide de la DURÉE DE VIE du jeton.
 *
 * ⚠️ POURQUOI CONSOMMER PLUTÔT QUE GARDER (cross-review, 8/10) : l'invite n'était
 * désarmée que par l'état du contexte (`retour !== null`), qui meurt avec le sous-arbre,
 * alors que l'URL est restaurée verbatim par le navigateur. Connexion → synchro réussie →
 * « Transactions » → bouton Précédent, et l'invite réapparaissait au-dessus d'un
 * dashboard déjà plein. Aucune garde d'ÉTAT ne pouvait corriger ça : le problème vit dans
 * l'HISTORIQUE.
 *
 * `window.history.replaceState` est la primitive juste (« Native History API », doc Next
 * 16) : elle REMPLACE l'entrée courante — la doc précise que l'utilisateur ne peut plus y
 * revenir par le bouton Précédent — et, contrairement à `router.replace`, elle ne
 * déclenche AUCUN aller-retour RSC. L'invite déjà rendue reste donc à l'écran, sans
 * refetch ni scintillement.
 */
import { useEffect } from "react";

import { urlSansDrapeauConnexion } from "@/components/sync/drapeau-connexion";

export function ConsommerDrapeauConnexion() {
  useEffect(() => {
    const url = urlSansDrapeauConnexion(
      window.location.pathname,
      window.location.search,
    );
    // `null` = rien à consommer → on ne touche pas à l'historique. C'est ce qui rend
    // l'effet idempotent, y compris sous le double-montage du mode strict en dev.
    if (url !== null) {
      window.history.replaceState(null, "", url);
    }
    // Aucune dépendance : c'est un jeton d'ARRIVÉE, consommé une fois. L'effet ne pose
    // aucun état, donc jamais de `react-hooks/set-state-in-effect`.
  }, []);

  return null;
}
