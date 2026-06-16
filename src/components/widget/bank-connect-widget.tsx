"use client";

/**
 * Conteneur du WIDGET NATIF Omni-FI (PR-W4, RÉ-ALIGNÉ 2026-06-16). On ne pilote
 * plus la machine MFA maison : on consomme le drop-in officiel `@omnifi/react`,
 * qui gère lui-même credentials / OTP / sélection de comptes.
 *
 * ⚠️ Contrat ré-aligné sur le CODE SOURCE (github.com/omni-fi-app/omni-fi-react-link),
 * la doc Fern étant fausse. Différences clés :
 *   - L'API est un HOOK `useOmniFILink({ token, onSuccess, ... })`, PAS un composant.
 *   - Entrée = `token` (le LinkToken serveur).
 *   - `onSuccess` reçoit `{ connections: [...] }` — potentiellement PLUSIEURS
 *     connexions ; chacune porte `publicToken` (+ connectionId, institutionId…).
 *   - Le widget charge un script CDN → on attend `isReady` avant `open()`.
 *
 * Cycle :
 *   1. clic « Connecter une banque » → `demarrerConnexionAction` (serveur, ApiKey)
 *      retourne un LinkToken usage-unique.
 *   2. LinkToken présent → on l'injecte dans `useOmniFILink` ; dès que `isReady`,
 *      on `open()` le widget (UI bancaire native).
 *   3. onSuccess → on extrait les `publicToken` de chaque connexion et on appelle
 *      `finaliserConnexionDropinAction(publicTokens)` (échange + GET /accounts).
 *      onExit/onError → on réarme le bouton.
 *
 * Sécurité : ni LinkToken ni PublicToken ne sont loggés/persistés côté client
 * (règle 8) ; ils transitent vers les Server Actions. Le gating MANAGER/ADMIN est
 * porté par le serveur ; ici on n'affiche le bouton que si `peutConnecter` (UX).
 */
import { useActionState, useEffect, useState, useTransition } from "react";

import { useOmniFILink, type OmniFiSuccessPayload } from "@omnifi/react";

import {
  demarrerConnexionAction,
  finaliserConnexionDropinAction,
  type EtatDemarrage,
  type EtatFinalisation,
} from "@/app/(workspace)/banques/actions";

const ETAT_DEMARRAGE: EtatDemarrage = { erreur: null, linkToken: null };

export function BankConnectWidget({
  peutConnecter,
}: {
  /** Rôle autorisé (MANAGER/ADMIN) — UX seulement ; la barrière réelle est serveur. */
  peutConnecter: boolean;
}) {
  const [demarrage, demarrer, demarrageEnCours] = useActionState(
    demarrerConnexionAction,
    ETAT_DEMARRAGE,
  );
  const [finalisation, setFinalisation] = useState<EtatFinalisation>({
    erreur: null,
    succes: null,
  });
  const [, startFinalisation] = useTransition();
  // Le LinkToken courant pilote le hook. `ferme` réarme après sortie/succès sans
  // copier le token dans un état dérivé inutile.
  const [ferme, setFerme] = useState(false);
  const tokenActif = !ferme ? demarrage.linkToken : null;

  function onSuccess(payload: OmniFiSuccessPayload) {
    // Le payload peut porter PLUSIEURS connexions. On n'expédie au serveur que
    // les publicToken (jamais loggés ici) ; la finalisation échange chacun puis
    // découvre les comptes via GET /accounts.
    const publicTokens = payload.connections.map((c) => c.publicToken);
    setFerme(true);
    startFinalisation(async () => {
      const r = await finaliserConnexionDropinAction(publicTokens);
      setFinalisation(r);
    });
  }

  // Le hook DOIT être appelé inconditionnellement (règle des hooks). Quand il n'y
  // a pas de token actif, on lui passe une chaîne vide : on n'appellera `open()`
  // que lorsqu'un vrai token est présent ET que le script CDN est prêt.
  const { open, isReady } = useOmniFILink({
    token: tokenActif ?? "",
    onSuccess,
    onExit: () => setFerme(true),
    onError: () => setFerme(true),
  });

  // Ouverture programmatique : dès qu'un LinkToken est actif et le script chargé.
  useEffect(() => {
    if (tokenActif && isReady) open();
  }, [tokenActif, isReady, open]);

  if (!peutConnecter) {
    return (
      <p className="text-sm text-text-muted">
        Seuls les managers et administrateurs peuvent connecter une banque.
      </p>
    );
  }

  // RedirectOrigin = origine https sans path (contrat link-token), lue côté
  // navigateur. En dev (http://localhost) l'action la rejettera : le widget natif
  // exige https — c'est attendu, la démo tourne sur un domaine https.
  const redirectOrigin =
    typeof window !== "undefined" ? window.location.origin : "";

  const widgetEnCours = Boolean(tokenActif) && !isReady;

  return (
    <div className="flex flex-col gap-3">
      <form
        action={(fd) => {
          // Réarme : un nouveau démarrage doit ré-ouvrir le widget même après une
          // fermeture précédente (le LinkToken renvoyé sera de nouveau « actif »).
          setFerme(false);
          setFinalisation({ erreur: null, succes: null });
          demarrer(fd);
        }}
      >
        <input
          type="hidden"
          name="redirectOrigin"
          value={redirectOrigin}
          readOnly
        />
        <button
          type="submit"
          disabled={demarrageEnCours || widgetEnCours}
          className="inline-flex h-10 items-center gap-2 rounded-control bg-primary
            px-4 text-sm font-semibold text-text-onink transition-colors
            hover:bg-primary-600 focus:outline-none focus-visible:ring-2
            focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-48"
        >
          <span aria-hidden>+</span>
          {demarrageEnCours || widgetEnCours ? "Ouverture…" : "Connecter une banque"}
        </button>
      </form>

      {demarrage.erreur && (
        <p role="alert" className="text-sm text-danger">
          {demarrage.erreur}
        </p>
      )}
      {finalisation.erreur && (
        <p role="alert" className="text-sm text-danger">
          {finalisation.erreur}
        </p>
      )}
      {finalisation.succes && (
        <p className="text-sm text-success">{finalisation.succes}</p>
      )}
    </div>
  );
}
