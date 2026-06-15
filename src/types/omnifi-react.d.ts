/**
 * Stub de types PROVISOIRE pour le package privé `@omnifi/react` (widget natif
 * drop-in Omni-FI). Le package n'est pas installé en local ; ce stub permet à la
 * coquille UI (PR-W4) de compiler et de monter `<OmniFiWidget/>` AVANT que l'Agent
 * Backend ne livre le câblage officiel.
 *
 * ⚠️ À REMPLACER par le stub/typings officiel de l'Agent Backend dès sa PR. Les
 * formes ci-dessous sont minimales et basées sur le contrat connu (un LinkToken
 * bootstrappe le widget ; callbacks succès/sortie/erreur). Ne pas enrichir à
 * l'aveugle : aligner sur l'API réelle du package quand elle est disponible.
 */
declare module "@omnifi/react" {
  import type { ReactNode } from "react";

  /** Résultat de connexion réussie, relayé au backend (finaliserConnexion). */
  export interface OmniFiSuccess {
    publicToken: string;
    sessionToken: string;
    jobId: string;
  }

  export interface OmniFiWidgetProps {
    /** LinkToken usage-unique obtenu côté serveur (demarrerConnexionAction). */
    linkToken: string;
    /** Connexion aboutie → tokens à échanger côté serveur. */
    onSuccess?: (result: OmniFiSuccess) => void;
    /** L'utilisateur a fermé/abandonné le widget. */
    onExit?: (error?: { code?: string; message?: string }) => void;
    /** Erreur d'initialisation/runtime du widget. */
    onError?: (error: { code?: string; message?: string }) => void;
    children?: ReactNode;
  }

  /** Composant drop-in : monte le widget natif à partir du LinkToken. */
  export function OmniFiWidget(props: OmniFiWidgetProps): JSX.Element;

  export interface UseOmniFiOptions {
    linkToken: string;
    onSuccess?: (result: OmniFiSuccess) => void;
    onExit?: (error?: { code?: string; message?: string }) => void;
  }

  export interface UseOmniFiResult {
    open: () => void;
    ready: boolean;
  }

  /** Hook alternatif (ouverture impérative) — exposé par le package. */
  export function useOmniFi(options: UseOmniFiOptions): UseOmniFiResult;
}
