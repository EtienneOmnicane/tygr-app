"use client";

/**
 * Error boundary du dashboard (segment (dashboard) du groupe (workspace)).
 * Convention Next : un `error.tsx` CLIENT capture toute exception levée par le
 * RSC `page.tsx` (échec d'un service `dashboard.ts` : DB down, timeout Neon) et
 * la rend de façon contrôlée — sans ce fichier, l'utilisateur verrait l'écran
 * d'erreur générique de Next (décision revue eng).
 *
 * Scopé au seul dashboard (pas au groupe entier) : admin/banques ont leur propre
 * gestion. `reset()` (fourni par Next) re-tente le rendu du segment → branché sur
 * le CTA « Reconnecter » de DashboardErrorState.
 *
 * Pas de PII dans le message (règle 8) : on n'expose JAMAIS `error.message` brut
 * (peut contenir un libellé bancaire / un détail technique). Message générique +
 * `digest` (id opaque de log Next) seulement.
 */
import { useEffect } from "react";

import { DashboardErrorState } from "@/components/dashboard/states";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log côté client (sans PII) — la stack complète est déjà capturée serveur.
    console.error("Dashboard render error", error.digest);
  }, [error]);

  return (
    <div className="p-6">
      <DashboardErrorState
        onRetry={reset}
        detail={
          error.digest ? `Référence incident : ${error.digest}` : undefined
        }
      />
    </div>
  );
}
