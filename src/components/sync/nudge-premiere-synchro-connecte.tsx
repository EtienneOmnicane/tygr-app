"use client";

/**
 * Branchement du nudge post-connexion sur le contexte de synchro. Coquille MINIMALE,
 * même partition que `SyncSummaryConnecte` : elle lit `useSynchro()`, consomme le jeton
 * d'arrivée, et laisse `NudgePremiereSynchro` pur — donc montable avec des états FIGÉS
 * par la route de démo (Visual QA, Gate 4).
 *
 * ⚠️ LE JETON EST CONSOMMÉ DÈS LE PREMIER RENDU, et c'est LA correction du défaut relevé
 * en cross-review (8/10). La version précédente n'armait/désarmait l'invite qu'avec
 * l'état du contexte (`retour !== null`). Or cet état meurt avec le sous-arbre, tandis
 * que l'URL est restaurée verbatim par le navigateur : connexion → synchro réussie →
 * « Transactions » → bouton Précédent, et « lancez une première synchronisation »
 * réapparaissait au-dessus d'un dashboard déjà plein. Aucune garde d'ÉTAT ne pouvait
 * corriger ça — le problème vit dans l'HISTORIQUE, il fallait donc agir sur l'historique.
 *
 * `window.history.replaceState` (supporté par le routeur App Router, cf. « Native History
 * API » dans la doc Next) remplace l'entrée courante : le drapeau n'est plus atteignable
 * par le bouton Précédent, et — contrairement à `router.replace` — l'opération ne
 * déclenche AUCUN aller-retour RSC. L'invite déjà rendue reste donc affichée, sans
 * scintillement ni refetch, jusqu'à ce que l'utilisateur agisse.
 *
 * Effet volontairement SANS dépendance réactive : il consomme un jeton d'ARRIVÉE, une
 * fois. Il ne pose aucun état (donc jamais de `react-hooks/set-state-in-effect`), et il
 * est idempotent — `urlSansDrapeauConnexion` rend `null` au second passage, ce qui neutralise
 * le double-montage des effets en développement.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";

import type { WorkspaceRole } from "@/server/db/schema";
import { peutModifier } from "@/lib/permissions";
import { useSynchro } from "@/components/sync/sync-contexte";
import { NudgePremiereSynchro } from "@/components/sync/nudge-premiere-synchro";
import { ConsommerDrapeauConnexion } from "@/components/sync/consommer-drapeau-connexion";
import {
  CLE_DRAPEAU_CONNEXION,
  drapeauConnexionArme,
  nudgeEstVisible,
} from "@/components/sync/drapeau-connexion";

export function NudgePremiereSynchroConnecte({ role }: { role: WorkspaceRole }) {
  const { retour, enCours, synchroniser } = useSynchro();
  const params = useSearchParams();

  // ⚠️ LA DÉCISION EST GELÉE ICI, CÔTÉ CLIENT, ET C'EST LE CŒUR DE LA CORRECTION.
  //
  // Nettoyer l'URL ne suffit PAS — mesuré, pas supposé (sonde `/demo/nudge-jeton`) : au
  // retour arrière, le Router Cache restitue le PAYLOAD RSC tel qu'il avait été rendu,
  // c'est-à-dire avec le drapeau armé. L'adresse est propre, le rendu serveur restauré
  // dit encore « armé », et l'invite revenait — au-dessus d'un dashboard déjà
  // synchronisé. `replaceState` corrige la barre d'adresse, pas le nœud de cache.
  //
  // L'initialiseur PARESSEUX s'exécute au MONTAGE, pendant le rendu :
  //   - première arrivée : le composant monte alors que l'URL porte encore le drapeau
  //     (les effets, dont la consommation, ne se sont pas encore exécutés) → gelé à vrai,
  //     l'invite s'affiche et RESTE affichée même après nettoyage de l'URL ;
  //   - retour arrière : le sous-arbre a été démonté en partant, il remonte donc à neuf,
  //     et lit cette fois l'URL déjà nettoyée → gelé à faux, aucune invite.
  //
  // Le gel est indispensable : sans lui, la lecture réactive de `useSearchParams`
  // masquerait l'invite dans la seconde suivant son affichage, dès la consommation.
  const [armeALArrivee] = useState(() =>
    drapeauConnexionArme(params.get(CLE_DRAPEAU_CONNEXION) ?? undefined),
  );

  // Les deux autres gardes couvrent la synchro faite SANS quitter la page, où le rendu
  // courant porte encore l'invite alors que le compte rendu vient de la démentir.
  const visible = nudgeEstVisible({
    arme: armeALArrivee,
    enCours,
    aUnRetour: retour !== null,
  });

  return (
    <>
      {/* Rendu INCONDITIONNELLEMENT, y compris quand l'invite est masquée : le jeton
          doit être consommé du seul fait d'être arrivé ici. Le placer sous la condition
          le laisserait dans l'URL pendant une synchro en vol — et le bouton Précédent
          le ressusciterait, ce que cette correction supprime. */}
      <ConsommerDrapeauConnexion />
      {visible && (
        <NudgePremiereSynchro
          // Confort UX seulement — la garde réelle est SERVEUR.
          peutSynchroniser={peutModifier(role)}
          onSynchroniser={synchroniser}
        />
      )}
    </>
  );
}
