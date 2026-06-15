/**
 * Stub de types pour le widget natif `@omnifi/react` (drop-in officiel Omni-FI).
 *
 * ⚠️ MODULE FANTÔME (temporaire) : le vrai package vit sur un registre npm PRIVÉ
 * d'entreprise, configuré uniquement sur le poste de l'utilisateur (comme la
 * résolution DNS de l'API). Il N'est PAS sur le registre npm public → `npm view
 * @omnifi/react` répond 404 ici. Ce `.d.ts` permet à `tsc` de compiler notre
 * câblage sans le package installé (pre-commit/stop-loss au vert côté agent).
 *
 * CONSÉQUENCE ASSUMÉE (option 3, décision utilisateur) : `tsc` passe, mais
 * `next build` / le runtime échoueront tant que le VRAI package n'est pas installé
 * (un .d.ts ne fournit aucune implémentation JS). Sur le poste de l'utilisateur,
 * avec le registre privé, le vrai `@omnifi/react` prend le relais et fournit
 * `useOmniFi`. Retirer ce stub dès que le package est installé en propre.
 *
 * Signatures tirées de la doc Fern (Quickstart) — surface minimale documentée :
 *   const { open } = useOmniFi({ token, onSuccess });
 *   onSuccess reçoit le `publicToken` (string) — le widget gère lui-même en
 *   interne session/exchange, connect et la machine MFA ; il n'expose que le
 *   résultat final. (jobId/connectionId NON exposés par onSuccess — cf. doc.)
 */
declare module "@omnifi/react" {
  export interface UseOmniFiOptions {
    /** LinkToken créé côté serveur (POST /connections/link-token). */
    token: string;
    /** Appelé quand l'utilisateur a terminé : reçoit le PublicToken à échanger. */
    onSuccess: (publicToken: string) => void;
    /** Optionnels — non garantis par la doc, typés permissifs pour ne pas casser. */
    onExit?: (raison?: string) => void;
    onEvent?: (evenement: unknown) => void;
  }

  export interface UseOmniFiResult {
    /** Ouvre le widget (à brancher sur un onClick). */
    open: () => void;
  }

  export function useOmniFi(options: UseOmniFiOptions): UseOmniFiResult;
}
