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
import type { WorkspaceRole } from "@/server/db/schema";
import { peutModifier } from "@/lib/permissions";
import { useSynchro } from "@/components/sync/sync-contexte";
import { NudgePremiereSynchro } from "@/components/sync/nudge-premiere-synchro";
import { ConsommerDrapeauConnexion } from "@/components/sync/consommer-drapeau-connexion";
import { nudgeEstVisible } from "@/components/sync/drapeau-connexion";

export function NudgePremiereSynchroConnecte({ role }: { role: WorkspaceRole }) {
  const { retour, enCours, synchroniser } = useSynchro();

  // Ce composant n'est monté QUE si la page a lu le drapeau (`arme` est donc vrai ici) ;
  // les deux autres gardes couvrent la synchro faite SANS quitter la page, où le rendu
  // courant porte encore l'invite alors que le compte rendu vient de la démentir.
  const visible = nudgeEstVisible({
    arme: true,
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
