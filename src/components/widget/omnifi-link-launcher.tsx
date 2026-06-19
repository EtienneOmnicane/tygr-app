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
  type OmniFIConnection,
  type OmniFIEnv,
  type OmniFISuccessPayload,
} from "@omni-fi/react-link";

/** Normalise le payload de `onSuccess` en LISTE de connexions (interne). */
function connexionsDepuisPayload(
  payload: OmniFISuccessPayload | OmniFIConnection[],
): OmniFIConnection[] {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.connections) ? payload.connections : [];
}

/**
 * Extrait les PublicTokens valides du payload `onSuccess`, quelle que soit la forme
 * que le CDN nous envoie. Fonction PURE (testée) — toute la robustesse du contrat
 * externe instable est ici, pas dans le composant React.
 *
 * ⚠️ DIVERGENCE CONTRAT SDK (vérifiée runtime 2026-06-19, cf. OMNIFI_API_FEEDBACK.md) :
 * les TYPES et le README vendorés (`@omni-fi/react-link`) déclarent
 * `OmniFISuccessPayload = { connections: OmniFIConnection[] }` (un OBJET), MAIS le
 * loader CDN déployé (`omni-fi-connect.js`, `e.onSuccess(n.connections)`) passe le
 * TABLEAU NU. Notre code suivait les types → `payload.connections` était `undefined`
 * → `TypeError: Cannot read properties of undefined (reading 'map')`, le widget
 * restait bloqué sur « Finishing… ».
 *
 * Trois niveaux de tolérance, parce que le contrat amont n'est pas stable :
 *  1. forme du conteneur : tableau nu OU `{ connections }` ;
 *  2. élément dégénéré : `c?.publicToken` — un élément null/undefined ne fait pas crasher ;
 *  3. token invalide : on ne garde que les strings non vides.
 * Aucun de ces cas ne doit jeter (sinon retour du blocage « Finishing… »).
 */
export function publicTokensDepuisPayload(
  payload: OmniFISuccessPayload | OmniFIConnection[],
): string[] {
  return connexionsDepuisPayload(payload)
    .map((c) => c?.publicToken)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

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
    onSuccess: (payload: OmniFISuccessPayload | OmniFIConnection[]) => {
      // Signal de fin (clic « Finish ») : on remonte les publicToken (jamais loggés)
      // à la finalisation serveur. Le payload peut porter PLUSIEURS banques.
      // Le handshake `parentOrigin` (qui empêchait ce callback en sandbox) est
      // RÉSOLU côté CDN (ready/ack, vérifié runtime 2026-06-19). Toute la tolérance
      // de forme/robustesse est dans la fonction pure testée `publicTokensDepuisPayload`.
      const tokens = publicTokensDepuisPayload(payload);
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
