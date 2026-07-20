"use client";

/**
 * Branchement du compte rendu de synchro sur le contexte. Coquille MINIMALE : elle lit
 * `useSynchro()`, détient le seul état d'UI du bloc (la notice de succès a-t-elle été
 * fermée ?) et passe le reste à `SyncSummary`, qui demeure pur et donc montable avec des
 * états FIGÉS par la route de démo (Visual QA, Gate 4).
 *
 * Cette séparation est ce qui met fin à la duplication de markup dans
 * `demo/dashboard-states` : la démo montait une copie du rendu (qui affichait encore
 * « Comptes à jour. », littéral pourtant supprimé du vrai composant par la PR #202).
 *
 * ⚠️ MÉCANIQUE DE FERMETURE — on mémorise le RETOUR fermé, pas un booléen. Le contexte
 * produit un nouvel objet `retour` à chaque synchro, donc la comparaison d'IDENTITÉ
 * suffit à faire ré-apparaître la notice au coup suivant, sans `useEffect` de remise à
 * zéro (qui déclencherait `react-hooks/set-state-in-effect` et, surtout, courrait après
 * le rendu). Un booléen, lui, resterait à `true` et avalerait le compte rendu suivant.
 * Rien n'est PERSISTÉ : un rechargement ré-affiche le dernier état — et c'est voulu,
 * une fermeture ne doit jamais enterrer une information encore vraie.
 */
import { useState } from "react";

import type { EtatFinalisation } from "@/app/(workspace)/banques/actions";
import type { WorkspaceRole } from "@/server/db/schema";
import { peutModifier } from "@/lib/permissions";
import { useSynchro } from "@/components/sync/sync-contexte";
import { SyncSummary } from "@/components/sync/sync-summary";

export function SyncSummaryConnecte({ role }: { role: WorkspaceRole }) {
  const { retour, enCours, synchroniser } = useSynchro();
  // Le retour dont la notice de succès a été fermée (identité, cf. docstring).
  const [retourFerme, setRetourFerme] = useState<EtatFinalisation | null>(null);

  return (
    <SyncSummary
      retour={retour}
      enCours={enCours}
      // Confort UX seulement — la garde réelle est SERVEUR
      // (`synchroniserConnexionsDepuisOmnifi` refuse un VIEWER).
      peutRelancer={peutModifier(role)}
      onRelancer={synchroniser}
      succesMasque={retour !== null && retour === retourFerme}
      onFermerSucces={() => setRetourFerme(retour)}
    />
  );
}
