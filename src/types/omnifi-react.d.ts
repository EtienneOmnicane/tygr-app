/**
 * Stub de types PROVISOIRE pour le widget natif `@omnifi/react` (drop-in Omni-FI).
 *
 * ⚠️ MODULE FANTÔME : le vrai package vit sur un registre npm PRIVÉ d'entreprise,
 * installé uniquement sur le poste de démo (comme le DNS de l'API). Absent du
 * registre public ET de node_modules ici → ce `.d.ts` permet à `tsc` de compiler
 * sans le package. `next build`/runtime exigent le VRAI package (un .d.ts ne
 * fournit aucune implémentation JS). Retirer ce stub dès l'installation réelle.
 *
 * ⚠️ STUB FUSIONNÉ (résolution conflit agents, 2026-06-15) : le câblage backend
 * (`useOmniFi({ token })`) et le composant UI (`<OmniFiWidget linkToken/>`)
 * supposaient des contrats DIFFÉRENTS. Le vrai contrat n'a pas pu être lu (package
 * non installé dans cet environnement). On expose donc un SUR-ENSEMBLE permissif
 * couvrant les deux usages, pour ne casser ni l'un ni l'autre à la compilation.
 * Quand le vrai package est installé, lire son .d.ts et resserrer ce stub (ou le
 * supprimer). Point à confirmer : `onSuccess` renvoie-t-il `publicToken` seul (doc
 * Fern) ou `{ publicToken, sessionToken, jobId }` (hypothèse UI) ? → dette TODOS.
 */
declare module "@omnifi/react" {
  import type { ReactNode } from "react";

  /** Forme riche de succès (hypothèse UI) — le widget POURRAIT exposer ces 3 champs. */
  export interface OmniFiSuccess {
    publicToken: string;
    sessionToken: string;
    jobId: string;
  }

  /**
   * onSuccess accepte les DEUX formes connues, le temps de confirmer le vrai
   * contrat : soit le `publicToken` seul (doc Fern), soit l'objet complet (UI).
   */
  export type OmniFiSuccessHandler =
    | ((publicToken: string) => void)
    | ((result: OmniFiSuccess) => void);

  /** Composant drop-in (usage UI). */
  export interface OmniFiWidgetProps {
    linkToken: string;
    onSuccess?: OmniFiSuccessHandler;
    onExit?: (error?: { code?: string; message?: string }) => void;
    onError?: (error: { code?: string; message?: string }) => void;
    children?: ReactNode;
  }
  export function OmniFiWidget(props: OmniFiWidgetProps): JSX.Element;

  /**
   * Hook impératif. Accepte `token` (câblage backend) OU `linkToken` (UI) — l'un
   * des deux. Champs callbacks permissifs (sur-ensemble des deux usages).
   */
  export interface UseOmniFiOptions {
    token?: string;
    linkToken?: string;
    onSuccess?: OmniFiSuccessHandler;
    onExit?: (error?: { code?: string; message?: string } | string) => void;
    onEvent?: (evenement: unknown) => void;
  }

  export interface UseOmniFiResult {
    /** Ouvre le widget (à brancher sur un onClick). */
    open: () => void;
    /** Présent côté UI ; optionnel pour ne pas casser le câblage backend. */
    ready?: boolean;
  }

  export function useOmniFi(options: UseOmniFiOptions): UseOmniFiResult;
}
