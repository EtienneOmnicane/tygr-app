"use client";

/**
 * Launcher du widget natif Omni-FI — isole l'usage du hook `useOmniFILink` du
 * package officiel `@omni-fi/react-link` (vendoré dans `vendor/`, cf.
 * SECURITY_VENDORING.md). Chargé via `next/dynamic` (`ssr:false`) par
 * `bank-connect-widget.tsx` car le hook touche `window.OmniFI` / charge un script
 * CDN : il ne peut pas s'exécuter côté serveur.
 *
 * Contrat (types réels du package + README) :
 *   - `useOmniFILink(config)` : hook ; `config.token` = LinkToken serveur.
 *   - `onSuccess(payload)` : appelé UNE FOIS, quand l'utilisateur termine le
 *     parcours (clic « Finish » de l'écran Account-Select). `payload.connections[]`
 *     porte chaque connexion `{ publicToken, connectionId, … }`. C'est LE signal de
 *     finalisation (≠ `omni-fi:connection-linked`, event INTERMÉDIAIRE par banque,
 *     émis AVANT « Finish » — ne PAS l'utiliser pour finaliser/fermer, sinon on
 *     détruit le widget pendant que l'utilisateur est encore dessus).
 *   - `config.env` pilote le CDN ; dérivé de NEXT_PUBLIC_OMNIFI_ENV.
 *   - Attendre `isReady` avant `open()`.
 *
 * Sécurité : le publicToken n'est jamais loggé ici ; il part vers la Server Action
 * de finalisation (règle 8).
 */
import { useEffect } from "react";

import {
  useOmniFILink,
  type OmniFIEnv,
  type OmniFISuccessPayload,
} from "@omni-fi/react-link";

/**
 * Environnement CDN du widget (NEXT_PUBLIC_OMNIFI_ENV : "staging" pour le sandbox
 * de démo, "production" par défaut). Validé ici pour ne passer au hook qu'une des
 * valeurs attendues (sinon on omet → défaut "production" du package).
 */
function envWidget(): OmniFIEnv | undefined {
  const v = process.env.NEXT_PUBLIC_OMNIFI_ENV;
  return v === "staging" || v === "development" || v === "production"
    ? v
    : undefined;
}

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
    env: envWidget(),
    onSuccess: (payload: OmniFISuccessPayload) => {
      // Signal de fin (clic « Finish ») : on remonte les publicToken (jamais loggés)
      // à la finalisation serveur. Le payload peut porter PLUSIEURS banques.
      // NB : en sandbox, un bug du widget CDN empêchait ce callback (canal postMessage
      // « parentOrigin not established ») — correctif attendu côté API Omni-FI
      // (cf. OMNIFI_API_FEEDBACK.md §5). En attendant, une re-synchro manuelle via
      // GET /connections reste disponible (synchroniserConnexionsAction).
      const tokens = payload.connections
        .map((c) => c.publicToken)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      if (tokens.length > 0) onConnexions(tokens);
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
