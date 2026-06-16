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
 *   - `onSuccess(payload)` avec `payload.connections[]` (chemin NOMINAL).
 *   - `onEvent(eventName, metadata)` : flux d'événements bruts ; `connection-linked`
 *     porte UNE connexion `{ publicToken, connectionId, institutionId, … }`.
 *   - `config.env` pilote le CDN ; dérivé de NEXT_PUBLIC_OMNIFI_ENV.
 *   - Attendre `isReady` avant `open()` ; `destroy()` ferme le widget.
 *
 * ⚠️ CONTOURNEMENT (2026-06-16, cf. OMNIFI_API_FEEDBACK.md §5) : le widget CDN
 * sandbox PLANTE en fin de parcours (requête réseau en échec + `revoke` KO) et
 * n'émet JAMAIS `onSuccess` → la connexion réussit côté Omni-FI mais notre
 * finalisation n'est jamais déclenchée et le widget reste bloqué ouvert. Parade :
 * on écoute `omni-fi:connection-linked` (émis PAR BANQUE, AVANT le plantage), on
 * accumule les publicToken, puis — après un court silence (plus d'event) — on
 * FORCE la fermeture (`destroy`) et on finalise nous-mêmes. `onSuccess` reste
 * branché comme chemin nominal ; la double-finalisation éventuelle est neutralisée
 * côté serveur (dédoublonnage des publicToken + exchange idempotent).
 *
 * Sécurité : le publicToken n'est jamais loggé ici ; il part vers la Server Action
 * de finalisation (règle 8).
 */
import { useEffect, useRef } from "react";

import {
  useOmniFILink,
  type OmniFIEnv,
  type OmniFISuccessPayload,
} from "@omni-fi/react-link";

/** Délai de silence après le dernier `connection-linked` avant de finaliser (ms).
 *  Couvre le cas multi-banques (plusieurs events) sans attendre un onSuccess qui
 *  ne viendra pas (widget planté). */
const DEBOUNCE_FINALISATION_MS = 800;

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

/** Extrait défensivement un publicToken d'un payload d'event non typé. */
function publicTokenDe(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && "publicToken" in metadata) {
    const pt = (metadata as { publicToken?: unknown }).publicToken;
    if (typeof pt === "string" && pt.length > 0) return pt;
  }
  return null;
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
  // Tokens captés via `connection-linked`, accumulés entre rendus (pas d'état :
  // ces valeurs ne déclenchent aucun rendu, on évite les boucles d'effet).
  const tokensRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Garde anti-double-déclenchement : une fois la finalisation lancée (par event
  // OU par onSuccess), on ne la relance pas.
  const finaliseRef = useRef(false);
  // Refs vers les callbacks parent + destroy, pour les utiliser dans onEvent sans
  // recréer la config du hook (qui est figée au montage côté SDK). Synchronisées
  // dans un effet (jamais mutées pendant le rendu — react-hooks/refs).
  const onConnexionsRef = useRef(onConnexions);
  const onCloseRef = useRef(onClose);
  const destroyRef = useRef<(() => void) | null>(null);

  /** Finalise une fois (idempotent local) : ferme le widget puis remonte les tokens. */
  function declencherFinalisation(tokens: string[]) {
    if (finaliseRef.current || tokens.length === 0) return;
    finaliseRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    // Force la fermeture du widget planté (le CDN ne le fait pas de lui-même).
    destroyRef.current?.();
    onConnexionsRef.current([...new Set(tokens)]);
    onCloseRef.current();
  }

  const { open, isReady, destroy } = useOmniFILink({
    token,
    env: envWidget(),
    // Chemin NOMINAL : si le widget ne plante pas, onSuccess finalise normalement.
    onSuccess: (payload: OmniFISuccessPayload) => {
      const tokens = payload.connections
        .map((c) => c.publicToken)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      declencherFinalisation(tokens.length > 0 ? tokens : tokensRef.current);
    },
    // CONTOURNEMENT : on capte chaque banque liée AVANT le plantage de fin.
    onEvent: (eventName, metadata) => {
      if (eventName !== "omni-fi:connection-linked") return;
      const pt = publicTokenDe(metadata);
      if (pt && !tokensRef.current.includes(pt)) tokensRef.current.push(pt);
      // (Ré)arme le debounce : on finalise quand plus aucun event n'arrive
      // (multi-banques géré), sans dépendre d'un onSuccess qui ne viendra pas.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(
        () => declencherFinalisation(tokensRef.current),
        DEBOUNCE_FINALISATION_MS,
      );
    },
    onExit: () => onCloseRef.current(),
    onError: () => onCloseRef.current(),
  });

  // Synchronise les refs (callbacks + destroy) APRÈS rendu, jamais pendant
  // (react-hooks/refs). `destroy` est stable (useCallback côté SDK).
  useEffect(() => {
    onConnexionsRef.current = onConnexions;
    onCloseRef.current = onClose;
    destroyRef.current = destroy;
  });

  // Ouverture programmatique dès que le script CDN est prêt.
  useEffect(() => {
    if (isReady) open();
  }, [isReady, open]);

  // Nettoyage du timer au démontage.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!isReady) {
    return (
      <p className="text-sm text-text-muted">Ouverture de la connexion bancaire…</p>
    );
  }
  return null;
}
