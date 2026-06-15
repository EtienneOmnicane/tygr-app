/**
 * Stub de types pour le widget natif `@omnifi/react` (drop-in officiel Omni-FI).
 *
 * ⚠️ MODULE FANTÔME : le vrai package vit sur un registre npm PRIVÉ d'entreprise,
 * installé uniquement sur le poste de démo. Absent du registre public ET de
 * node_modules ici → ce `.d.ts` permet à `tsc` de compiler sans le package.
 * `next build`/runtime exigent le VRAI package (un .d.ts ne fournit aucune
 * implémentation JS). Retirer ce stub dès l'installation réelle.
 *
 * CONTRAT (tranché 2026-06-15, doc Fern) : `onSuccess` reçoit le `publicToken`
 * SEUL. Le widget gère la MFA en interne (session/exchange, connect, polling) et
 * n'expose que ce résultat final — ni sessionToken ni jobId. La finalisation côté
 * serveur découvre les comptes via GET /accounts (finaliserConnexionDropin).
 */
declare module "@omnifi/react" {
  import type { ReactNode } from "react";

  /** Connexion aboutie → seul le publicToken est exposé (doc Fern). */
  export type OmniFiSuccessHandler = (publicToken: string) => void;

  /** Composant drop-in : monte le widget natif à partir du LinkToken. */
  export interface OmniFiWidgetProps {
    linkToken: string;
    onSuccess?: OmniFiSuccessHandler;
    onExit?: (error?: { code?: string; message?: string }) => void;
    onError?: (error: { code?: string; message?: string }) => void;
    children?: ReactNode;
  }
  export function OmniFiWidget(props: OmniFiWidgetProps): JSX.Element;

  /** Hook impératif (ouverture programmatique). */
  export interface UseOmniFiOptions {
    token?: string;
    linkToken?: string;
    onSuccess?: OmniFiSuccessHandler;
    onExit?: (error?: { code?: string; message?: string } | string) => void;
    onEvent?: (evenement: unknown) => void;
  }

  export interface UseOmniFiResult {
    open: () => void;
    ready?: boolean;
  }

  export function useOmniFi(options: UseOmniFiOptions): UseOmniFiResult;
}
