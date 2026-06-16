/**
 * Stub de types pour le widget natif `@omnifi/react` (drop-in officiel Omni-FI).
 *
 * ⚠️ MODULE FANTÔME : le vrai package vit sur un registre npm PRIVÉ d'entreprise,
 * installé uniquement sur le poste de démo. Absent du registre public ET de
 * node_modules ici → ce `.d.ts` permet à `tsc` de compiler sans le package.
 * `next build`/runtime exigent le VRAI package (un .d.ts ne fournit aucune
 * implémentation JS). Retirer ce stub dès l'installation réelle.
 *
 * CONTRAT (RÉ-ALIGNÉ 2026-06-16 sur le code source :
 *   https://github.com/omni-fi-app/omni-fi-react-link)
 *
 * La doc Fund "onSuccess = publicToken seul" était FAUSSE. La vérité du code :
 *  - L'API exposée est un HOOK `useOmniFILink(config)`, PAS un composant
 *    `<OmniFiWidget/>`. Il charge un script depuis un CDN Omni-FI (`isReady`
 *    passe à true une fois le script chargé) → le poste de démo doit joindre ce
 *    CDN, pas seulement l'API REST.
 *  - Le champ d'entrée est `token` (le LinkToken serveur), pas `linkToken`.
 *  - `onSuccess` reçoit un OBJET `{ connections: [...] }` — potentiellement
 *    PLUSIEURS connexions. Chaque connexion porte `{ publicToken, connectionId,
 *    institutionId, customerType?, permittedAccountIds? }`.
 *
 * La finalisation serveur échange CHAQUE `publicToken` (link-exchange) puis
 * découvre les comptes via GET /accounts (chemin déjà testé : finaliserConnexionDropin).
 */
declare module "@omnifi/react" {
  /** Une connexion aboutie dans le payload onSuccess (cf. code source). */
  export interface OmniFiConnection {
    /** Token opaque à échanger côté serveur (link-exchange). */
    publicToken: string;
    /** UUID de la Connection persistée côté Omni-FI (endpoints connection-scoped). */
    connectionId: string;
    /** Identifiant de l'établissement bancaire. */
    institutionId: string;
    /** Classification client optionnelle. */
    customerType?: string;
    /** Comptes autorisés (si l'EndUser a restreint la sélection). */
    permittedAccountIds?: string[];
  }

  /** Payload de succès : une ou plusieurs connexions établies en un flux. */
  export interface OmniFiSuccessPayload {
    connections: OmniFiConnection[];
  }

  export type OmniFiSuccessHandler = (payload: OmniFiSuccessPayload) => void;

  export interface OmniFiError {
    code?: string;
    message?: string;
  }

  /** Config du hook (cf. OmniFIConfig du code source). */
  export interface UseOmniFILinkConfig {
    /** LinkToken court-vécu émis par notre serveur (creerLinkToken). */
    token: string;
    onSuccess: OmniFiSuccessHandler;
    onError?: (error: OmniFiError) => void;
    onExit?: () => void;
    onEvent?: (eventName: string, metadata?: Record<string, unknown>) => void;
    displayMode?: "iframe" | "popup";
    env?: "development" | "staging" | "production";
    /** Surcharge l'URL du script CDN (utile en environnement isolé). */
    scriptUrl?: string;
  }

  export interface UseOmniFiLinkResult {
    /** Ouvre le widget (modal/popup). À n'appeler qu'une fois `isReady`. */
    open: () => void;
    /** true une fois le script CDN chargé. */
    isReady: boolean;
    /** Ferme le widget et nettoie les handlers. */
    destroy: () => void;
    /** Renseigné si le script CDN échoue à charger. */
    error: Error | null;
  }

  export function useOmniFILink(config: UseOmniFILinkConfig): UseOmniFiLinkResult;
}
