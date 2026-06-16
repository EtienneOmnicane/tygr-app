"use client";

/**
 * Launcher du widget natif Omni-FI — ISOLE l'usage du hook `useOmniFILink` et
 * l'import de `@omnifi/react` (correctif QA 2026-06-16, module fantôme).
 *
 * Ce composant n'est JAMAIS importé statiquement : `bank-connect-widget.tsx` le
 * charge via `next/dynamic` (ssr:false) et seulement quand un LinkToken est actif.
 * Ainsi le package privé `@omnifi/react` (absent de node_modules en local) n'est
 * résolu qu'au RUNTIME, à l'ouverture du widget — l'appli et la démo démarrent sans
 * lui. Si le module manque au runtime, l'erreur remonte au WidgetErrorBoundary du
 * parent (UI propre, pas de crash de page).
 *
 * Pas de rendu visible propre : le hook charge un script CDN et `open()` ouvre la
 * surface native. On rend uniquement un statut discret tant que le script charge.
 */
import { useEffect } from "react";

import { useOmniFILink, type OmniFiSuccessPayload } from "@omnifi/react";

export function OmniFiLinkLauncher({
  token,
  onConnexions,
  onClose,
}: {
  /** LinkToken serveur (usage unique) injecté dans le hook. */
  token: string;
  /** Connexions abouties → liste des publicToken à finaliser côté serveur. */
  onConnexions: (publicTokens: string[]) => void;
  /** Fermeture / sortie / erreur du widget → réarmer le bouton parent. */
  onClose: () => void;
}) {
  const { open, isReady } = useOmniFILink({
    token,
    onSuccess: (payload: OmniFiSuccessPayload) => {
      // Le payload peut porter PLUSIEURS connexions ; on n'expédie que les
      // publicToken (jamais loggés ici).
      onConnexions(payload.connections.map((c) => c.publicToken));
    },
    onExit: onClose,
    onError: onClose,
  });

  // Ouverture programmatique dès que le script CDN est prêt.
  useEffect(() => {
    if (isReady) open();
  }, [isReady, open]);

  if (!isReady) {
    return (
      <p className="text-sm text-text-muted">Ouverture de la connexion bancaire…</p>
    );
  }
  return null;
}
