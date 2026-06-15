/**
 * Stub de types pour le package privé `@omnifi/react` (widget natif drop-in
 * Omni-FI). Le vrai package vit sur un registre npm PRIVÉ (installé seulement sur
 * le poste de démo) : ce `.d.ts` permet à `tsc` de compiler sans lui. `next build`
 * et le runtime exigent le VRAI package — un `.d.ts` ne fournit aucune
 * implémentation JS. Retirer ce stub à l'installation réelle.
 *
 * CONTRAT ARRÊTÉ (décision 2026-06-15, doc Fern `link-connect → PublicToken`) :
 * `onSuccess` reçoit le **publicToken seul** (string). Le serveur l'échange
 * ensuite contre un ConnectionId permanent (`link-exchange`, ApiKey + ClientUserId)
 * — le sessionToken et le jobId ne transitent PAS par ce callback.
 */
declare module "@omnifi/react" {
  import type { ReactNode } from "react";

  export interface OmniFiWidgetProps {
    /** LinkToken usage-unique obtenu côté serveur (demarrerConnexionAction). */
    linkToken: string;
    /** Connexion aboutie → publicToken seul (doc Fern) à échanger côté serveur. */
    onSuccess?: (publicToken: string) => void;
    /** L'utilisateur a fermé/abandonné le widget. */
    onExit?: (error?: { code?: string; message?: string }) => void;
    /** Erreur d'initialisation/runtime du widget. */
    onError?: (error: { code?: string; message?: string }) => void;
    children?: ReactNode;
  }

  /** Composant drop-in : monte le widget natif à partir du LinkToken. */
  export function OmniFiWidget(props: OmniFiWidgetProps): JSX.Element;
}
