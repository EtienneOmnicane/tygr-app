"use client";

/**
 * Branchement du compte rendu de synchro sur le contexte. Coquille MINIMALE : elle ne
 * fait que lire `useSynchro()` et passer les valeurs à `SyncSummary`, qui reste pur et
 * donc montable avec des états FIGÉS par la route de démo (Visual QA, Gate 4).
 *
 * Cette séparation est ce qui met fin à la duplication de markup dans
 * `demo/dashboard-states` : la démo montait une copie du rendu (qui affichait encore
 * « Comptes à jour. », littéral pourtant supprimé du vrai composant par la PR #202).
 */
import type { Fraicheur } from "@/lib/format-date";
import type { WorkspaceRole } from "@/server/db/schema";
import { peutModifier } from "@/lib/permissions";
import { useSynchro } from "@/components/sync/sync-contexte";
import { SyncSummary } from "@/components/sync/sync-summary";

export function SyncSummaryConnecte({
  fraicheur,
  compteLabel,
  role,
}: {
  fraicheur: Fraicheur | null;
  compteLabel?: string | null;
  role: WorkspaceRole;
}) {
  const { retour, enCours, synchroniser } = useSynchro();

  return (
    <SyncSummary
      fraicheur={fraicheur}
      compteLabel={compteLabel}
      retour={retour}
      enCours={enCours}
      // Confort UX seulement — la garde réelle est SERVEUR
      // (`synchroniserConnexionsDepuisOmnifi` refuse un VIEWER).
      peutRelancer={peutModifier(role)}
      onRelancer={synchroniser}
    />
  );
}
