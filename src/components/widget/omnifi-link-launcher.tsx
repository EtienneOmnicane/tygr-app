"use client";

/**
 * Launcher du widget natif Omni-FI — isole l'usage du hook `useOmniFILink` du
 * package officiel `@omni-fi/react-link` (vendoré dans `vendor/`, cf.
 * SECURITY_VENDORING.md). Chargé via `next/dynamic` (`ssr:false`) par
 * `bank-connect-widget.tsx` car le hook touche `window.OmniFI` / charge un script
 * CDN : il ne peut pas s'exécuter côté serveur.
 *
 * Contrat (types réels du package) :
 *   - `useOmniFILink(config)` : hook ; `config.token` = LinkToken serveur.
 *   - `onSuccess(payload)` avec `payload.connections[]`, chaque connexion portant
 *     `publicToken` (+ connectionId, institutionId…). Le payload peut contenir
 *     PLUSIEURS connexions.
 *   - `config.env` pilote le CDN (staging → staging-cdn.omni-fi.co) ; on le dérive
 *     de NEXT_PUBLIC_OMNIFI_ENV pour viser le sandbox en démo.
 *   - Attendre `isReady` avant `open()` (le hook throw sinon).
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
