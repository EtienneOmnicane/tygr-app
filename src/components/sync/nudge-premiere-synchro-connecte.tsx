"use client";

/**
 * Branchement du nudge post-connexion sur le contexte de synchro. Coquille MINIMALE,
 * même partition que `SyncSummaryConnecte` : elle lit `useSynchro()` et laisse
 * `NudgePremiereSynchro` pur — donc montable avec des états FIGÉS par la route de démo
 * (Visual QA, Gate 4).
 *
 * ⚠️ POURQUOI LE NUDGE S'EFFACE DÈS LE PREMIER CLIC (le défaut qu'on évite) : le nudge
 * est armé par `?connexion=etablie`, et ce paramètre SURVIT au `router.refresh()` que
 * `sync-contexte.tsx` déclenche en fin de synchro. Sans la garde ci-dessous, l'invite
 * « lancez une première synchronisation » resterait donc affichée APRÈS la
 * synchronisation — juste à côté du compte rendu qui annonce, lui, que les transactions
 * sont importées. Deux messages contradictoires sur le même écran, et c'est le nudge qui
 * aurait tort.
 *
 * On ne purge PAS l'URL pour autant (`router.replace`) : sur cet écran, réécrire l'URL
 * pendant que la synchro est en vol ferait re-rendre la page pour une raison purement
 * cosmétique. L'état de vérité — « une synchro a-t-elle été lancée depuis cet
 * atterrissage ? » — vit déjà dans le contexte ; on le lit, on n'en fabrique pas un
 * second. Un rechargement manuel ré-arme le nudge : c'est acceptable (la question
 * « ai-je importé mes transactions ? » redevient légitime) et sans persistance.
 */
import type { WorkspaceRole } from "@/server/db/schema";
import { peutModifier } from "@/lib/permissions";
import { useSynchro } from "@/components/sync/sync-contexte";
import { NudgePremiereSynchro } from "@/components/sync/nudge-premiere-synchro";

export function NudgePremiereSynchroConnecte({ role }: { role: WorkspaceRole }) {
  const { retour, enCours, synchroniser } = useSynchro();

  // Une synchro est en vol (`enCours`) ou a déjà rendu un compte rendu (`retour`) :
  // l'invite n'a plus lieu d'être, le compte rendu prend le relais et dit la vérité du
  // moment. Cf. docstring — c'est la garde qui empêche le nudge de se contredire.
  if (enCours || retour !== null) return null;

  return (
    <NudgePremiereSynchro
      // Confort UX seulement — la garde réelle est SERVEUR.
      peutSynchroniser={peutModifier(role)}
      onSynchroniser={synchroniser}
    />
  );
}
