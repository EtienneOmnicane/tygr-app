"use client";

/**
 * Branchement du nudge post-connexion sur le contexte de synchro. Coquille MINIMALE,
 * même partition que `SyncSummaryConnecte` : elle lit `useSynchro()`, consomme le jeton
 * d'arrivée, et laisse `NudgePremiereSynchro` pur — donc montable avec des états FIGÉS
 * par la route de démo (Visual QA, Gate 4).
 *
 * ⚠️ LE DÉFAUT CORRIGÉ (cross-review, 8/10) : l'invite n'était désarmée que par l'état du
 * contexte (`retour !== null`), qui meurt avec le sous-arbre, tandis que l'URL est
 * restaurée verbatim par le navigateur. Connexion → synchro réussie → « Transactions » →
 * bouton Précédent, et « lancez une première synchronisation » réapparaissait au-dessus
 * d'un dashboard déjà plein.
 *
 * ⚠️ ET SURTOUT — CE QUI N'A PAS SUFFI, parce que deux tentatives s'y sont cassé les
 * dents : nettoyer l'URL ne corrige PAS le retour arrière. C'est contre-intuitif, donc
 * c'est écrit ici en toutes lettres. `window.history.replaceState` remplace bien l'entrée
 * d'historique, mais le Router Cache de Next restitue le PAYLOAD RSC tel qu'il avait été
 * rendu — c'est-à-dire avec le drapeau armé. Mesuré sur la sonde `/demo/nudge-jeton`, et
 * reproduit indépendamment en revue : au retour, l'URL est propre ET le serveur dit
 * encore « armé ». `replaceState` corrige la barre d'adresse, pas le nœud de cache.
 *
 * D'où un mécanisme à DEUX ÉTAGES, dont AUCUN n'est redondant :
 *   1. `ConsommerDrapeauConnexion` retire le drapeau de l'URL — sans quoi un rechargement
 *      ou un partage de lien réarmerait l'invite. Son effet dépend des PARAMÈTRES (pas du
 *      montage) : une arrivée par navigation souple sur une route déjà montée ne remonte
 *      rien, et un effet en `[]` n'y rejouerait jamais ;
 *   2. le GEL ci-dessous tranche l'affichage à partir de l'URL lue AU MONTAGE — c'est lui,
 *      et lui seul, qui neutralise le payload périmé restitué par le cache.
 *
 * Ne pas « simplifier » en supprimant l'un des deux : chacun couvre un chemin que l'autre
 * laisse passer.
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
